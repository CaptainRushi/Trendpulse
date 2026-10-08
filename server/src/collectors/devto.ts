/**
 * dev.to — public Articles API, no key needed (COL-15). Top articles by
 * week (`?top=7`); fixture recorded live 2026-10-07 (HTTP 200, 5 items).
 * Engagement = reactions primary, comments in the extra map.
 */
import { z } from "zod";
import type { Collector, CollectResult, PingResult, RawItemDraft, RawItemDraftInput } from "./types.js";
import { RawItemDraft as DraftSchema } from "./types.js";
import { httpPing } from "./ping.js";

const DevtoArticle = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullable().optional(),
  url: z.string().url(),
  published_at: z.string().nullable().optional(),
  public_reactions_count: z.number().optional(),
  comments_count: z.number().optional(),
  reading_time_minutes: z.number().optional(),
  tag_list: z.array(z.string()).optional(),
  user: z.object({ name: z.string().nullable().optional() }).optional(),
});
export type DevtoArticle = z.infer<typeof DevtoArticle>;

/** Top-week listing; per_page follows the run limit (API caps at 1000). */
export function devtoUrl(limit: number): string {
  return `https://dev.to/api/articles?top=7&per_page=${String(Math.max(1, Math.min(limit, 100)))}`;
}

export function devtoDraft(article: DevtoArticle): RawItemDraft {
  const reactions = article.public_reactions_count ?? 0;
  return DraftSchema.parse({
    source: "devto",
    source_item_id: String(article.id),
    url: article.url,
    title: article.title,
    snippet: (article.description ?? "").slice(0, 500),
    author: article.user?.name ?? null,
    published_at: article.published_at ?? null,
    engagement_score: Math.max(reactions, 0),
    engagement: { comments: article.comments_count ?? 0 },
  } satisfies RawItemDraftInput);
}

export const devtoCollector: Collector = {
  key: "devto",
  label: "dev.to",
  requires: [],
  async ping(ctx): Promise<PingResult> {
    return httpPing(ctx.http, "https://dev.to/api/articles?top=7&per_page=1", {
      accept: "application/json",
    });
  },
  async collect(ctx): Promise<CollectResult> {
    const started = Date.now();
    const finish = (
      items: RawItemDraft[],
      status: "ok" | "error" | "blocked" | "skipped",
      error: string | null = null,
    ): CollectResult => ({
      items,
      stats: { source: "devto", status, items: items.length, duration_ms: Date.now() - started, error },
    });

    try {
      const res = await ctx.http.get(devtoUrl(ctx.limit), { headers: { accept: "application/json" } });
      if (res.status !== 200) return finish([], "error", `dev.to HTTP ${String(res.status)}`);
      const articles = z.array(DevtoArticle).parse(JSON.parse(res.text));
      const items: RawItemDraft[] = [];
      for (const article of articles) {
        if (items.length >= ctx.limit) break;
        items.push(devtoDraft(article));
      }
      return finish(items, "ok");
    } catch (error) {
      return finish([], "error", error instanceof Error ? error.message : String(error));
    }
  },
};
