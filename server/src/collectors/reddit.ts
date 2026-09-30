/**
 * reddit — r/popular + configured subreddits, JSON listing (TRD §4.2).
 * Real User-Agent required; OAuth when REDDIT_CLIENT_ID/SECRET set
 * (TRD §4.2 "OAuth if client id/secret set"), unauthenticated .json
 * otherwise. Fixtures follow Reddit's documented Listing/t3 schema — live
 * recording was blocked (403/login-wall), see DECISIONS.md.
 */
import { z } from "zod";
import type { Collector, CollectResult, PingResult, RawItemDraft, RawItemDraftInput } from "./types.js";
import { RawItemDraft as DraftSchema } from "./types.js";
import { epochSecondsToIso } from "../utils/time.js";
import { httpPing } from "./ping.js";

const RedditPost = z.object({
  id: z.string(),
  title: z.string(),
  permalink: z.string(),
  url: z.string().optional(),
  author: z.string(),
  created_utc: z.number(),
  score: z.number(),
  num_comments: z.number(),
  subreddit: z.string(),
  selftext: z.string().optional(),
  over_18: z.boolean().optional(),
  stickied: z.boolean().optional(),
});
export type RedditPost = z.infer<typeof RedditPost>;

const RedditListing = z.object({
  kind: z.literal("Listing"),
  data: z.object({
    children: z.array(z.object({ kind: z.literal("t3"), data: RedditPost })),
  }),
});
export type RedditListing = z.infer<typeof RedditListing>;

export const DEFAULT_SUBREDDITS = ["popular"] as const;

/** Configured subreddits (config_json.subreddits), fallback r/popular. */
export function configuredSubreddits(config: Record<string, unknown>): string[] {
  const raw = config.subreddits;
  if (Array.isArray(raw)) {
    const names = raw.filter((s): s is string => typeof s === "string" && s.trim() !== "");
    if (names.length > 0) return names;
  }
  return [...DEFAULT_SUBREDDITS];
}

export function redditPostToDraft(post: RedditPost): RawItemDraft {
  return DraftSchema.parse({
    source: "reddit",
    source_item_id: post.id,
    // permalink is site-relative; prefer the post's own url (link posts)
    // and fall back to the comments page for self posts.
    url: post.url && !post.url.startsWith("/r/") ? post.url : `https://www.reddit.com${post.permalink}`,
    title: post.title,
    snippet: post.selftext?.slice(0, 500) ?? "",
    author: post.author,
    published_at: epochSecondsToIso(post.created_utc),
    engagement_score: Math.max(post.score, 0),
    engagement: { comments: post.num_comments },
  } satisfies RawItemDraftInput);
}

export const redditCollector: Collector = {
  key: "reddit",
  label: "Reddit",
  requires: [],
  async ping(ctx): Promise<PingResult> {
    // Unauthenticated listing: honest status (403 means we're blocked here —
    // real runs with OAuth headers go through the OAuth branch in collect()).
    return httpPing(ctx.http, "https://www.reddit.com/r/popular.json?limit=1", {
      accept: "application/json",
    });
  },
  async collect(ctx): Promise<CollectResult> {
    const started = Date.now();
    const finish = (items: RawItemDraft[], status: "ok" | "error" | "skipped", error: string | null = null): CollectResult => ({
      items,
      stats: { source: "reddit", status, items: items.length, duration_ms: Date.now() - started, error },
    });

    try {
      const headers: Record<string, string> = { accept: "application/json" };
      const clientId =
        typeof ctx.config.reddit_client_id === "string" ? ctx.config.reddit_client_id : undefined;
      const clientSecret =
        typeof ctx.config.reddit_client_secret === "string" ? ctx.config.reddit_client_secret : undefined;
      let base = "https://www.reddit.com";
      if (clientId && clientSecret) {
        base = "https://oauth.reddit.com";
        const tokenRes = await ctx.http.postForm("https://www.reddit.com/api/v1/access_token", "grant_type=client_credentials", {
          headers: {
            authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          },
        });
        if (tokenRes.status === 200) {
          const token = (JSON.parse(tokenRes.text) as { access_token?: string }).access_token;
          if (token) headers.authorization = `Bearer ${token}`;
        } else {
          ctx.log.warn("reddit oauth token fetch failed; falling back to unauthenticated .json");
          base = "https://www.reddit.com";
        }
      }

      const subreddits = configuredSubreddits(ctx.config);
      const perSub = Math.max(1, Math.ceil(ctx.limit / subreddits.length));
      const items: RawItemDraft[] = [];
      const errors: string[] = [];

      for (const sub of subreddits) {
        if (items.length >= ctx.limit) break;
        const url = `${base}/r/${sub}.json?limit=${String(perSub)}`;
        const res = await ctx.http.get(url, { headers });
        if (res.status !== 200) {
          errors.push(`r/${sub}: HTTP ${String(res.status)}`);
          continue;
        }
        try {
          const listing = RedditListing.parse(JSON.parse(res.text));
          for (const child of listing.data.children) {
            if (items.length >= ctx.limit) break;
            if (child.data.over_18 === true || child.data.stickied === true) continue;
            items.push(redditPostToDraft(child.data));
          }
        } catch (error) {
          errors.push(`r/${sub}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (items.length === 0 && errors.length > 0) return finish([], "error", errors.join("; "));
      if (errors.length > 0) ctx.log.warn({ errors }, "reddit partial failure");
      return finish(items, "ok");
    } catch (error) {
      return finish([], "error", error instanceof Error ? error.message : String(error));
    }
  },
};
