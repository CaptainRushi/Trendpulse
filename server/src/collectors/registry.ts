/**
 * Collector registry (TRD §6 stage 1): run enabled collectors in parallel
 * (concurrency 4). Isolation contract — one collector throwing must not stop
 * the others; failures become `error` stats.
 */
import pLimit from "p-limit";
import type { SourceKey } from "../sheets/schema.js";
import type { Collector, CollectContext, CollectResult, PingResult, SourceStats } from "./types.js";
import type { SourceConfig } from "./types.js";
import type { TrendPulseConfig } from "../config/env.js";
export { httpPing } from "./ping.js";
import { hackernewsCollector } from "./hackernews.js";
import { googleTrendsCollector } from "./google-trends.js";
import { redditCollector } from "./reddit.js";
import { githubCollector } from "./github.js";
import { wikipediaCollector } from "./wikipedia.js";
import { rssCollector } from "./rss.js";
import { webpageCollector } from "./webpage.js";
import { devtoCollector } from "./devto.js";
import { youtubeCollector } from "./youtube.js";
import { producthuntCollector } from "./producthunt.js";

export const COLLECTORS: Record<SourceKey, Collector> = {
  hackernews: hackernewsCollector,
  google_trends: googleTrendsCollector,
  reddit: redditCollector,
  github: githubCollector,
  wikipedia: wikipediaCollector,
  rss: rssCollector,
  webpage: webpageCollector,
  devto: devtoCollector,
  // Key-gated: without keys they report skipped (COL-14); shapes for
  // youtube/producthunt are unverified live (no key to record against).
  youtube: youtubeCollector,
  producthunt: producthuntCollector,
};

/**
 * Env-provided source keys, merged UNDER explicit per-source config
 * (a key pasted into a source's config_json wins over the env default).
 * Without this, env keys like GITHUB_TOKEN never reach collectors — they
 * only see their source's config_json.
 */
export function envSourceConfig(config: TrendPulseConfig): SourceConfig {
  const out: SourceConfig = {};
  if (config.githubToken !== "") out["github_token"] = config.githubToken;
  if (config.redditClientId !== "" && config.redditClientSecret !== "") {
    out["reddit_client_id"] = config.redditClientId;
    out["reddit_client_secret"] = config.redditClientSecret;
  }
  if (config.youtubeApiKey !== "") out["youtube_api_key"] = config.youtubeApiKey;
  if (config.producthuntToken !== "") out["producthunt_token"] = config.producthuntToken;
  return out;
}

export interface RunCollectorsOptions {  /** Restrict to these keys (CLI --source); default all with a collect(). */
  keys?: SourceKey[];
  /** Per-source limit override (sources.item_limit). */
  limits?: Partial<Record<SourceKey, number>>;
  /** Per-source config (sources.config_json). */
  configs?: Partial<Record<SourceKey, Record<string, unknown>>>;
  /** Parallel collectors. TRD §6: 4. */
  concurrency?: number;
}

export interface RunCollectorsOutput {
  results: CollectResult[];
  stats: SourceStats[];
  /** All drafts across sources, in completion order. */
  items: CollectResult["items"];
}

export async function runCollectors(
  base: Omit<CollectContext, "config">,
  options: RunCollectorsOptions = {},
): Promise<RunCollectorsOutput> {
  const wanted = options.keys ?? (Object.keys(COLLECTORS) as SourceKey[]);
  const limit = pLimit(options.concurrency ?? 4);
  const results: CollectResult[] = [];

  await Promise.all(
    wanted.map((key) =>
      limit(async () => {
        const collector = COLLECTORS[key];
        const started = Date.now();
        try {
          const result = await collector.collect({
            ...base,
            limit: options.limits?.[key] ?? base.limit,
            config: options.configs?.[key] ?? {},
          });
          results.push(result);
        } catch (error) {
          // Isolation: a throwing collector becomes an error stat.
          results.push({
            items: [],
            stats: {
              source: key,
              status: "error",
              items: 0,
              duration_ms: Date.now() - started,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }),
    ),
  );

  return {
    results,
    stats: results.map((r) => r.stats),
    items: results.flatMap((r) => r.items),
  };
}

/** Run a doctor ping for one source (never throws). */
export async function pingSource(
  key: SourceKey,
  ctx: Omit<CollectContext, "config">,
  config: Record<string, unknown> = {},
): Promise<PingResult> {
  try {
    const collector = COLLECTORS[key];
    if (!collector.ping) return { ok: false, detail: `no ping for '${key}'` };
    return await collector.ping({ ...ctx, config });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
