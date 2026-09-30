/**
 * google_trends — Daily trending RSS for TRENDS_GEO (TRD §4.2).
 * "2000+"/"200K+" approx_traffic → number; news items → snippet source URL.
 */
import { z } from "zod";
import type { Collector, CollectResult, PingResult, RawItemDraft, RawItemDraftInput } from "./types.js";
import { RawItemDraft as DraftSchema } from "./types.js";
import { toIsoOrNull } from "../utils/time.js";
import { httpPing } from "./ping.js";

/** "2000+" → 2000, "200K+" → 200000, "2M+" → 2000000, "" → null. */
export function parseApproxTraffic(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = /^([\d.]+)\s*([KMB])?\+?$/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2]?.toUpperCase();
  const scale: Record<string, number> = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };
  const multiplier = suffix !== undefined ? (scale[suffix] ?? 1) : 1;
  return value * multiplier;
}

const TrendItem = z.object({
  title: z.string().min(1),
  link: z.string().min(1),
  pubDate: z.string().optional(),
  approxTraffic: z.string().optional(),
  newsUrl: z.string().optional(),
  newsSource: z.string().optional(),
});
type TrendItem = z.infer<typeof TrendItem>;

/**
 * Parse Google's namespaced RSS with plain regex/substring extraction —
 * the `ht:` namespace prefixes make a generic parser awkward and the
 * recorded fixture is the contract (rule 13).
 */
export function parseTrendsRss(xml: string): TrendItem[] {
  const out: TrendItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1] ?? "";
    const tag = (name: string): string | undefined => {
      const t = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(body);
      const captured = t?.[1];
      if (captured !== undefined) return captured.trim();
      const selfClosing = new RegExp(`<${name}(?:\\s[^>]*)?/>`).exec(body);
      return selfClosing ? "" : undefined;
    };
    const title = tag("title");
    const link = tag("link");
    if (!title || !link) continue;
    out.push({
      title,
      link,
      pubDate: tag("pubDate"),
      approxTraffic: tag("ht:approx_traffic"),
      newsUrl: tag("ht:news_item_url"),
      newsSource: tag("ht:news_item_source"),
    });
  }
  return out;
}

export const googleTrendsCollector: Collector = {
  key: "google_trends",
  label: "Google Trends",
  requires: [],
  async ping(ctx): Promise<PingResult> {
    return httpPing(ctx.http, `https://trends.google.com/trending/rss?geo=${encodeURIComponent(ctx.geo)}`);
  },
  async collect(ctx): Promise<CollectResult> {
    const started = Date.now();
    const finish = (items: RawItemDraft[], status: "ok" | "error" | "skipped", error: string | null = null): CollectResult => ({
      items,
      stats: { source: "google_trends", status, items: items.length, duration_ms: Date.now() - started, error },
    });

    try {
      const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(ctx.geo)}`;
      const res = await ctx.http.get(url);
      if (res.status !== 200) return finish([], "error", `trends RSS HTTP ${String(res.status)}`);

      const trends = parseTrendsRss(res.text).slice(0, ctx.limit);
      const items = trends.map((t) =>
        DraftSchema.parse({
          source: "google_trends",
          source_item_id: null,
          // Prefer the news article URL when present; the trends link is a
          // generic landing page shared by every item (useless as identity).
          url: t.newsUrl || t.link,
          title: t.title,
          snippet: t.newsSource ? `Source: ${t.newsSource}` : "",
          author: null,
          published_at: toIsoOrNull(t.pubDate),
          engagement_score: parseApproxTraffic(t.approxTraffic),
          engagement: {},
        } satisfies RawItemDraftInput),
      );
      return finish(items, "ok");
    } catch (error) {
      return finish([], "error", error instanceof Error ? error.message : String(error));
    }
  },
};
