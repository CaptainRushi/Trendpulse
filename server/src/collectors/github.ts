/**
 * github — REST search: repos created in the last 7 days sorted by stars
 * (TRD §4.2). Optional GITHUB_TOKEN for higher rate limits (headers set by
 * the caller via config → passed through here).
 */
import { z } from "zod";
import type { Collector, CollectResult, PingResult, RawItemDraft, RawItemDraftInput } from "./types.js";
import { RawItemDraft as DraftSchema } from "./types.js";
import { toIsoOrNull } from "../utils/time.js";
import { httpPing } from "./ping.js";

const GitHubItem = z.object({
  id: z.number(),
  full_name: z.string(),
  html_url: z.string(),
  description: z.string().nullable().optional(),
  stargazers_count: z.number().optional(),
  forks_count: z.number().optional(),
  created_at: z.string().optional(),
  language: z.string().nullable().optional(),
  owner: z.object({ login: z.string() }).optional(),
});
export type GitHubItem = z.infer<typeof GitHubItem>;

const GitHubSearch = z.object({ items: z.array(GitHubItem) });

/** Query TRD §4.2 mandates: created in last 7 days, sorted by stars. */
export function buildSearchQuery(now: Date = new Date()): string {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return `created:>${since} sort:stars-desc`;
}

export function githubItemToDraft(item: GitHubItem): RawItemDraft {
  return DraftSchema.parse({
    source: "github",
    source_item_id: String(item.id),
    url: item.html_url,
    title: item.full_name,
    snippet: item.description?.trim() ?? "",
    author: item.owner?.login ?? null,
    published_at: toIsoOrNull(item.created_at),
    engagement_score: item.stargazers_count ?? 0,
    engagement: { forks: item.forks_count ?? 0 },
    language: item.language ?? null,
  } satisfies RawItemDraftInput);
}

export const githubCollector: Collector = {
  key: "github",
  label: "GitHub",
  requires: [],
  async ping(ctx): Promise<PingResult> {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(buildSearchQuery())}&per_page=1`;
    return httpPing(ctx.http, url, {
      accept: "application/vnd.github+json",
      ...(typeof ctx.config.github_token === "string"
        ? { authorization: `Bearer ${ctx.config.github_token}` }
        : {}),
    });
  },
  async collect(ctx): Promise<CollectResult> {
    const started = Date.now();
    const finish = (items: RawItemDraft[], error: string | null = null): CollectResult => ({
      items,
      stats: { source: "github", status: error === null ? "ok" : "error", items: items.length, duration_ms: Date.now() - started, error },
    });

    try {
      const query = buildSearchQuery();
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${String(Math.min(ctx.limit, 100))}`;
      const headers: Record<string, string> = { accept: "application/vnd.github+json" };
      const token =
        typeof ctx.config.github_token === "string" ? ctx.config.github_token : undefined;
      if (token) headers.authorization = `Bearer ${token}`;

      const res = await ctx.http.get(url, { headers });
      if (res.status !== 200) return finish([], `search HTTP ${String(res.status)}`);

      const items = GitHubSearch.parse(JSON.parse(res.text)).items
        .slice(0, ctx.limit)
        .map(githubItemToDraft);
      return finish(items);
    } catch (error) {
      return finish([], error instanceof Error ? error.message : String(error));
    }
  },
};
