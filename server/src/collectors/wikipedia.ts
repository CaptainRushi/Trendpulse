/**
 * wikipedia — Wikimedia pageviews top-articles API, previous day (TRD §4.2).
 * Skips special pages (Main_Page, Special:Search, …) per TRD.
 */
import { z } from "zod";
import type { Collector, CollectResult, PingResult, RawItemDraft, RawItemDraftInput } from "./types.js";
import { RawItemDraft as DraftSchema } from "./types.js";
import { httpPing } from "./ping.js";

const PageviewsItem = z.object({
  article: z.string(),
  views: z.number(),
  rank: z.number().optional(),
});
const PageviewsResponse = z.object({ items: z.array(z.object({ articles: z.array(PageviewsItem) })) });

/** yyyy-mm-dd of the previous UTC day (pageviews are complete then). */
export function previousUtcDay(now: Date = new Date()): string {
  const d = new Date(now.getTime() - 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Pageviews REST URL: segments are yyyy / mm / dd (verified live — 200). */
export function pageviewsUrl(day: string): string {
  const [year, month, date] = day.split("-");
  return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${year ?? ""}/${month ?? ""}/${date ?? ""}`;
}

/** Skip non-article pages (TRD: "skip special/main pages"). */
export function isSpecialArticle(article: string): boolean {
  const a = article.toLowerCase();
  return (
    a === "main_page" ||
    a === "special:search" ||
    a.startsWith("special:") ||
    a.startsWith("wikipedia:") ||
    a.startsWith("file:") ||
    a.startsWith("portal:") ||
    a === "-"
  );
}

export function articleUrl(article: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(article.replace(/ /g, "_"))}`;
}

export const wikipediaCollector: Collector = {
  key: "wikipedia",
  label: "Wikipedia",
  requires: [],
  async ping(ctx): Promise<PingResult> {
    return httpPing(ctx.http, pageviewsUrl(previousUtcDay()), { accept: "application/json" });
  },
  async collect(ctx): Promise<CollectResult> {
    const started = Date.now();
    const finish = (items: RawItemDraft[], error: string | null = null): CollectResult => ({
      items,
      stats: { source: "wikipedia", status: error === null ? "ok" : "error", items: items.length, duration_ms: Date.now() - started, error },
    });

    try {
      const day = previousUtcDay();
      // Recorded fixture is project=en.wikipedia, access=all-access, agent=all.
      const res = await ctx.http.get(pageviewsUrl(day), { headers: { accept: "application/json" } });
      if (res.status !== 200) return finish([], `pageviews HTTP ${String(res.status)}`);

      const articles = PageviewsResponse.parse(JSON.parse(res.text)).items[0]?.articles ?? [];
      const items: RawItemDraft[] = [];
      for (const a of articles) {
        if (items.length >= ctx.limit) break;
        if (isSpecialArticle(a.article)) continue;
        items.push(
          DraftSchema.parse({
            source: "wikipedia",
            source_item_id: a.article,
            url: articleUrl(a.article),
            title: a.article.replace(/_/g, " "),
            snippet: "",
            author: null,
            // Pageviews API reports day granularity; no clock time available.
            published_at: `${day}T00:00:00.000Z`,
            engagement_score: a.views,
            engagement: {},
          } satisfies RawItemDraftInput),
        );
      }
      return finish(items);
    } catch (error) {
      return finish([], error instanceof Error ? error.message : String(error));
    }
  },
};
