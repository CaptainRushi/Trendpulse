/**
 * rss — user-configured feed URLs (config_json.feeds), TRD §4.2.
 * ETag / If-Modified-Since cache; robots.txt gate for non-API pages (TRD §4.3).
 * No engagement signal → rank position in the feed is the fallback (Phase 4).
 */
import Parser from "rss-parser";
import type { Collector, CollectResult, PingResult, RawItemDraft, RawItemDraftInput } from "./types.js";
import { RawItemDraft as DraftSchema } from "./types.js";
import { toIsoOrNull } from "../utils/time.js";
import { httpPing, needsConfig } from "./ping.js";

const parser = new Parser({ timeout: 15_000 });

/** Feed URLs from config (strings only, http/https only). */
export function configuredFeeds(config: Record<string, unknown>): string[] {
  const raw = config.feeds;
  if (!Array.isArray(raw)) return [];
  const urls: string[] = [];
  for (const f of raw) {
    if (typeof f !== "string") continue;
    try {
      const u = new URL(f.trim());
      if (u.protocol === "http:" || u.protocol === "https:") urls.push(u.toString());
    } catch {
      // skip malformed entry rather than failing the whole source
    }
  }
  return urls;
}

export const rssCollector: Collector = {
  key: "rss",
  label: "RSS feeds",
  requires: [],
  async ping(ctx): Promise<PingResult> {
    const [first] = configuredFeeds(ctx.config);
    if (!first) return needsConfig("no feed URLs configured (sources.config_json.feeds)");
    return httpPing(ctx.http, first);
  },
  async collect(ctx): Promise<CollectResult> {
    const started = Date.now();
    const finish = (items: RawItemDraft[], status: "ok" | "error" | "skipped", error: string | null = null): CollectResult => ({
      items,
      stats: { source: "rss", status, items: items.length, duration_ms: Date.now() - started, error },
    });

    const feeds = configuredFeeds(ctx.config);
    if (feeds.length === 0) {
      return finish([], "skipped", "no feed URLs configured (sources.config_json.feeds)");
    }

    const items: RawItemDraft[] = [];
    const errors: string[] = [];

    for (const feedUrl of feeds) {
      if (items.length >= ctx.limit) break;
      try {
        const res = await ctx.http.get(feedUrl, { etag: true, robots: true });
        if (res.robotsBlocked) {
          ctx.log.warn({ feedUrl }, "rss: robots.txt disallows this URL, skipped");
          errors.push(`${feedUrl}: robots.txt disallowed`);
          continue;
        }
        if (res.notModified) {
          ctx.log.debug({ feedUrl }, "rss: not modified (304)");
          continue;
        }
        if (res.status !== 200) {
          errors.push(`${feedUrl}: HTTP ${String(res.status)}`);
          continue;
        }

        const feed = await parser.parseString(res.text);
        let rank = 0;
        for (const entry of feed.items) {
          if (items.length >= ctx.limit) break;
          const title = entry.title?.trim();
          const link = entry.link?.trim();
          if (!title || !link) continue;
          items.push(
            DraftSchema.parse({
              source: "rss",
              source_item_id: entry.guid ?? null,
              url: link,
              title,
              snippet: (entry.contentSnippet ?? entry.content ?? "").slice(0, 500),
              author:
                entry.creator ??
                (typeof entry.author === "string" ? entry.author : null),
              published_at: toIsoOrNull(entry.pubDate ?? entry.isoDate),
              engagement_score: null,
              engagement: { rank: rank },
            } satisfies RawItemDraftInput),
          );
          rank += 1;
        }
      } catch (error) {
        errors.push(`${feedUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (items.length === 0 && errors.length > 0) return finish([], "error", errors.join("; "));
    if (errors.length > 0) ctx.log.warn({ errors }, "rss partial failure");
    return finish(items, "ok");
  },
};
