/**
 * Product Hunt — GraphQL API v2 ranked posts. Requires PRODUCTHUNT_TOKEN
 * (env or the source's config_json); without it the source reports skipped
 * (COL-14), never an error.
 *
 * NOTE (unverified live): written against the documented v2 shapes, but no
 * token was available to record a real response — verify against live
 * before trusting field mapping.
 */
import { z } from "zod";
import type { Collector, CollectResult, PingResult, RawItemDraft, RawItemDraftInput } from "./types.js";
import { RawItemDraft as DraftSchema } from "./types.js";

const ProducthuntPost = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string().nullable().optional(),
  url: z.string().url().nullable().optional(),
  slug: z.string().optional(),
  votesCount: z.number().optional(),
  commentsCount: z.number().optional(),
  createdAt: z.string().nullable().optional(),
  user: z.object({ name: z.string().nullable().optional() }).optional(),
});
export type ProducthuntPost = z.infer<typeof ProducthuntPost>;

const ProducthuntResponse = z.object({
  data: z.object({
    posts: z.object({
      edges: z.array(z.object({ node: ProducthuntPost })),
    }),
  }),
});

const RANKING_QUERY =
  "query($first:Int!){posts(first:$first order:RANKING){edges{node{id name tagline url slug votesCount commentsCount createdAt user{name}}}}}";

function apiToken(config: Record<string, unknown>): string | undefined {
  const token = config["producthunt_token"];
  return typeof token === "string" && token !== "" ? token : undefined;
}

export function producthuntDraft(post: ProducthuntPost): RawItemDraft {
  const page = post.slug ? `https://www.producthunt.com/posts/${post.slug}` : "https://www.producthunt.com/";
  return DraftSchema.parse({
    source: "producthunt",
    source_item_id: post.id,
    url: post.url ?? page,
    title: post.name,
    snippet: (post.tagline ?? "").slice(0, 500),
    author: post.user?.name ?? null,
    published_at: post.createdAt ?? null,
    engagement_score: Math.max(post.votesCount ?? 0, 0),
    engagement: { comments: post.commentsCount ?? 0 },
  } satisfies RawItemDraftInput);
}

export const producthuntCollector: Collector = {
  key: "producthunt",
  label: "Product Hunt",
  requires: ["PRODUCTHUNT_TOKEN"],
  ping(ctx): Promise<PingResult> {
    if (!apiToken(ctx.config)) return Promise.resolve({ ok: false, detail: "Needs PRODUCTHUNT_TOKEN" });
    return Promise.resolve({ ok: true, detail: "token present (live check on collect)" });
  },  async collect(ctx): Promise<CollectResult> {
    const started = Date.now();
    const finish = (
      items: RawItemDraft[],
      status: "ok" | "error" | "blocked" | "skipped",
      error: string | null = null,
    ): CollectResult => ({
      items,
      stats: { source: "producthunt", status, items: items.length, duration_ms: Date.now() - started, error },
    });

    const token = apiToken(ctx.config);
    if (!token) return finish([], "skipped", "Needs PRODUCTHUNT_TOKEN");
    try {
      const res = await ctx.http.postJson(
        "https://api.producthunt.com/v2/api/graphql",
        { query: RANKING_QUERY, variables: { first: Math.max(1, Math.min(ctx.limit, 50)) } },
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (res.status !== 200) {
        return finish([], res.status === 401 || res.status === 429 ? "blocked" : "error", `Product Hunt HTTP ${String(res.status)}`);
      }
      const edges = ProducthuntResponse.parse(JSON.parse(res.text)).data.posts.edges;
      const items: RawItemDraft[] = [];
      for (const edge of edges) {
        if (items.length >= ctx.limit) break;
        items.push(producthuntDraft(edge.node));
      }
      return finish(items, "ok");
    } catch (error) {
      return finish([], "error", error instanceof Error ? error.message : String(error));
    }
  },
};
