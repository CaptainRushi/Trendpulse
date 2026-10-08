/**
 * YouTube — Data API v3 trending (mostPopular), region-aware. Requires
 * YOUTUBE_API_KEY (env or the source's config_json); without it the source
 * reports skipped (COL-14), never an error.
 *
 * NOTE (unverified live): written against the stable v3 shapes, but no key
 * was available to record a real response — verify against live before
 * trusting engagement mapping.
 */
import { z } from "zod";
import type { Collector, CollectResult, PingResult, RawItemDraft, RawItemDraftInput } from "./types.js";
import { RawItemDraft as DraftSchema } from "./types.js";
import { httpPing } from "./ping.js";

const YoutubeVideo = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string(),
    description: z.string().optional(),
    publishedAt: z.string().optional(),
    channelTitle: z.string().optional(),
  }),
  statistics: z
    .object({
      viewCount: z.string().optional(),
      likeCount: z.string().optional(),
      commentCount: z.string().optional(),
    })
    .optional(),
});
export type YoutubeVideo = z.infer<typeof YoutubeVideo>;

const YoutubeList = z.object({ items: z.array(YoutubeVideo).optional() });

function apiKey(config: Record<string, unknown>): string | undefined {
  const key = config["youtube_api_key"];
  return typeof key === "string" && key !== "" ? key : undefined;
}

export function trendingUrl(region: string, limit: number, key: string): string {
  return (
    "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics" +
    `&chart=mostPopular&regionCode=${encodeURIComponent(region)}&maxResults=${String(Math.max(1, Math.min(limit, 50)))}` +
    `&key=${encodeURIComponent(key)}`
  );
}

export function youtubeDraft(video: YoutubeVideo): RawItemDraft {
  const views = Number(video.statistics?.viewCount ?? 0);
  return DraftSchema.parse({
    source: "youtube",
    source_item_id: video.id,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
    title: video.snippet.title,
    snippet: (video.snippet.description ?? "").slice(0, 500),
    author: video.snippet.channelTitle ?? null,
    published_at: video.snippet.publishedAt ?? null,
    engagement_score: Number.isFinite(views) ? Math.max(views, 0) : 0,
    engagement: {
      likes: Number(video.statistics?.likeCount ?? 0),
      comments: Number(video.statistics?.commentCount ?? 0),
    },
  } satisfies RawItemDraftInput);
}

export const youtubeCollector: Collector = {
  key: "youtube",
  label: "YouTube",
  requires: ["YOUTUBE_API_KEY"],
  async ping(ctx): Promise<PingResult> {
    const key = apiKey(ctx.config);
    if (!key) return { ok: false, detail: "Needs YOUTUBE_API_KEY" };
    return httpPing(ctx.http, trendingUrl(ctx.geo, 1, key), { accept: "application/json" });
  },
  async collect(ctx): Promise<CollectResult> {
    const started = Date.now();
    const finish = (
      items: RawItemDraft[],
      status: "ok" | "error" | "blocked" | "skipped",
      error: string | null = null,
    ): CollectResult => ({
      items,
      stats: { source: "youtube", status, items: items.length, duration_ms: Date.now() - started, error },
    });

    const key = apiKey(ctx.config);
    if (!key) return finish([], "skipped", "Needs YOUTUBE_API_KEY");
    try {
      const res = await ctx.http.get(trendingUrl(ctx.geo, ctx.limit, key), { headers: { accept: "application/json" } });
      if (res.status !== 200) {
        return finish([], res.status === 403 || res.status === 429 ? "blocked" : "error", `YouTube HTTP ${String(res.status)}`);
      }
      const videos = YoutubeList.parse(JSON.parse(res.text)).items ?? [];
      const items: RawItemDraft[] = [];
      for (const video of videos) {
        if (items.length >= ctx.limit) break;
        items.push(youtubeDraft(video));
      }
      return finish(items, "ok");
    } catch (error) {
      return finish([], "error", error instanceof Error ? error.message : String(error));
    }
  },
};
