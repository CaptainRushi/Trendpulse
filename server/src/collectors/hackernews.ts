/**
 * hackernews — Firebase API (TRD §4.2): topstories.json + item/{id}.json.
 * Item fetches run with concurrency 8 (TRD §4.2), so the default 1 req/sec
 * per-domain gap is overridden with gapMs: 0 — HN's API is designed for
 * concurrent reads and p-limit(8) already caps fan-out.
 */
import pLimit from "p-limit";
import { z } from "zod";
import type { Collector, CollectResult, PingResult, RawItemDraft, RawItemDraftInput } from "./types.js";
import { RawItemDraft as DraftSchema } from "./types.js";
import { httpPing } from "./ping.js";

const API = "https://hacker-news.firebaseio.com/v0";
const ALGOLIA_API = "https://hn.algolia.com/api/v1";

/** Keyword search (config_json.keywords) for category runs. */
export function configuredKeywords(config: Record<string, unknown>): string[] {
  const raw = config.keywords;
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim());
}

const AlgoliaHit = z.object({
  objectID: z.union([z.string(), z.number()]),
  title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  points: z.number().nullable().optional(),
  num_comments: z.number().nullable().optional(),
  created_at_i: z.number().nullable().optional(),
});
const AlgoliaSearch = z.object({ hits: z.array(AlgoliaHit) });

/** One keyword → drafts. Exported for tests; collect() loops keywords. */
export async function searchHackernews(
  get: (url: string) => Promise<{ status: number; text: string }>,
  keyword: string,
  limit: number,
): Promise<RawItemDraft[]> {
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const url =
    `${ALGOLIA_API}/search?query=${encodeURIComponent(keyword)}&tags=story` +
    `&numericFilters=created_at_i>${String(since)}&hitsPerPage=${String(limit)}`;
  const res = await get(url);
  if (res.status !== 200) throw new Error(`algolia HTTP ${String(res.status)}`);
  const drafts: RawItemDraft[] = [];
  for (const hit of AlgoliaSearch.parse(JSON.parse(res.text)).hits.slice(0, limit)) {
    const title = hit.title?.trim();
    if (!title) continue;
    const id = String(hit.objectID);
    drafts.push(
      DraftSchema.parse({
        source: "hackernews",
        source_item_id: id,
        url: hit.url ?? `https://news.ycombinator.com/item?id=${id}`,
        title,
        snippet: "",
        author: hit.author ?? null,
        published_at: hit.created_at_i ? new Date(hit.created_at_i * 1000).toISOString() : null,
        engagement_score: hit.points ?? 0,
        engagement: { comments: hit.num_comments ?? 0 },
      } satisfies RawItemDraftInput),
    );
  }
  return drafts;
}

const HnItem = z.object({
  id: z.number(),
  type: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  by: z.string().optional(),
  score: z.number().optional(),
  descendants: z.number().optional(),
  time: z.number().optional(),
  text: z.string().optional(),
  dead: z.boolean().optional(),
  deleted: z.boolean().optional(),
});
export type HnItem = z.infer<typeof HnItem>;

/** Strip HN's HTML-ish text (paragraph/tag markers) for a plain snippet. */
export function hnSnippet(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/<p>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Map one HN item to a draft; null when it's not a collectable story. */
export function hnItemToDraft(item: HnItem): RawItemDraft | null {
  if (item.type !== "story" || item.dead === true || item.deleted === true) return null;
  const title = item.title?.trim();
  if (!title) return null;
  return DraftSchema.parse({
    source: "hackernews",
    source_item_id: String(item.id),
    url: item.url ?? `https://news.ycombinator.com/item?id=${String(item.id)}`,
    title,
    snippet: hnSnippet(item.text),
    author: item.by ?? null,
    published_at: item.time ? new Date(item.time * 1000).toISOString() : null,
    engagement_score: item.score ?? 0,
    engagement: { comments: item.descendants ?? 0 },
  } satisfies RawItemDraftInput);
}

export const hackernewsCollector: Collector = {
  key: "hackernews",
  label: "Hacker News",
  requires: [],
  async ping(ctx): Promise<PingResult> {
    return httpPing(ctx.http, `${API}/topstories.json`);
  },
  async collect(ctx): Promise<CollectResult> {
    const started = Date.now();
    const finish = (items: RawItemDraft[], error: string | null = null): CollectResult => ({
      items,
      stats: {
        source: "hackernews",
        status: error === null ? "ok" : "error",
        items: items.length,
        duration_ms: Date.now() - started,
        error,
      },
    });

    try {
      // Category runs pass keywords: Algolia search instead of the front page.
      const keywords = configuredKeywords(ctx.config);
      if (keywords.length > 0) {
        const perKeyword = Math.max(1, Math.ceil(ctx.limit / keywords.length));
        const items: RawItemDraft[] = [];
        for (const keyword of keywords) {
          if (items.length >= ctx.limit) break;
          try {
            const found = await searchHackernews(
              (url) => ctx.http.get(url),
              keyword,
              Math.min(perKeyword, ctx.limit - items.length),
            );
            items.push(...found);
          } catch (error) {
            ctx.log.debug({ err: error, keyword }, "hn keyword search failed");
          }
        }
        return finish(items.slice(0, ctx.limit));
      }
      const listRes = await ctx.http.get(`${API}/topstories.json`);
      if (listRes.status !== 200) {
        return finish([], `topstories HTTP ${String(listRes.status)}`);
      }
      const ids = z.array(z.number()).parse(JSON.parse(listRes.text));
      const wanted = ids.slice(0, ctx.limit);

      // HN contract (TRD §4.2): fetch top N with concurrency 8.
      const limit = pLimit(8);
      const settled = await Promise.all(
        wanted.map((id) =>
          limit(async () => {
            try {
              const res = await ctx.http.get(`${API}/item/${String(id)}.json`, { gapMs: 0 });
              if (res.status !== 200 || res.text === "null" || res.text === "") return null;
              return HnItem.parse(JSON.parse(res.text));
            } catch (error) {
              ctx.log.debug({ err: error, id }, "hn item fetch failed");
              return null;
            }
          }),
        ),
      );

      const items: RawItemDraft[] = [];
      for (const item of settled) {
        if (item === null) continue;
        const draft = hnItemToDraft(item);
        if (draft) items.push(draft);
      }
      return finish(items);
    } catch (error) {
      return finish([], error instanceof Error ? error.message : String(error));
    }
  },
};
