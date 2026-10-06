/**
 * Category-routed collection (Doc 17 S2): run registry collectors with
 * category-derived configs. General sources are never called here; S3
 * decides the full source plan. Items come back tagged with target_category.
 */
import { runCollectors } from "../collectors/registry.js";
import type { CollectContext, RawItemDraft, SourceConfig, SourceStats } from "../collectors/types.js";
import type { SourceKey } from "../sheets/schema.js";
import type { CategorySource } from "./registry.js";

/** Per-source item cap for category fetches (spec default). */
export const CATEGORY_MAX_ITEMS = 40;

export interface CategoryItem extends RawItemDraft {
  target_category: string | null;
}

/** Registry source → collector SourceConfig. */
export function categorySourceConfig(source: CategorySource): SourceConfig {
  switch (source.collector) {
    case "hackernews":
      return { keywords: source.params.keywords ?? [] };
    case "github":
      return { query: source.params.query ?? "" };
    case "rss":
      return { feeds: source.params.feeds ?? [] };
    case "reddit":
      return { subreddits: source.params.subreddits ?? [] };
  }
}

export interface CategoryCollectResult {
  items: CategoryItem[];
  stats: SourceStats[];
}

/**
 * Collect one category's sources. Reddit without OAuth creds reports
 * skipped (CATRUN-06) instead of burning blocked requests.
 */
export async function collectCategory(
  ctx: CollectContext,
  slug: string,
  sources: CategorySource[],
  limit: number = CATEGORY_MAX_ITEMS,
): Promise<CategoryCollectResult> {
  const keys: SourceKey[] = [];
  const configs: Partial<Record<SourceKey, SourceConfig>> = {};
  const skipped: SourceStats[] = [];
  for (const source of sources) {
    if (source.collector === "reddit" && !hasRedditCreds(ctx.config)) {
      skipped.push({
        source: "reddit",
        status: "skipped",
        items: 0,
        duration_ms: 0,
        error: "needs Reddit OAuth (REDDIT_CLIENT_ID/SECRET in sources config or env)",
      });
      continue;
    }
    if (!keys.includes(source.collector)) keys.push(source.collector);
    configs[source.collector] = mergeCategoryConfig(configs[source.collector], source);
  }
  if (keys.length === 0) return { items: [], stats: skipped };
  const out = await runCollectors(ctx, {
    keys,
    limits: Object.fromEntries(keys.map((key) => [key, limit])),
    configs,
  });
  const items: CategoryItem[] = out.items.map((item) => ({ ...item, target_category: slug }));
  return { items, stats: [...skipped, ...out.stats] };
}

function hasRedditCreds(config: SourceConfig): boolean {
  const fromConfig =
    typeof config.reddit_client_id === "string" &&
    config.reddit_client_id !== "" &&
    typeof config.reddit_client_secret === "string" &&
    config.reddit_client_secret !== "";
  if (fromConfig) return true;
  const envId = process.env["REDDIT_CLIENT_ID"] ?? "";
  const envSecret = process.env["REDDIT_CLIENT_SECRET"] ?? "";
  return envId !== "" && envSecret !== "";
}

function mergeCategoryConfig(
  existing: SourceConfig | undefined,
  source: CategorySource,
): SourceConfig {
  const base = existing ?? {};
  const params = source.params;
  const merged: SourceConfig = { ...base };
  if (params.keywords) merged["keywords"] = [...((base["keywords"] as string[] | undefined) ?? []), ...params.keywords];
  if (params.query && merged["query"] === undefined) merged["query"] = params.query;
  if (params.feeds) merged["feeds"] = [...((base["feeds"] as string[] | undefined) ?? []), ...params.feeds];
  if (params.subreddits) merged["subreddits"] = [...((base["subreddits"] as string[] | undefined) ?? []), ...params.subreddits];
  return merged;
}
