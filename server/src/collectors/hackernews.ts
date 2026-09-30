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
