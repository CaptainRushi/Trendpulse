/**
 * Collector registry (TRD §6 stage 1): run enabled collectors in parallel
 * (concurrency 4). Isolation contract — one collector throwing must not stop
 * the others; failures become `error` stats.
 */
import pLimit from "p-limit";
import type { SourceKey } from "../sheets/schema.js";
import type { Collector, CollectContext, CollectResult, PingResult, SourceStats } from "./types.js";
export { httpPing } from "./ping.js";
import { hackernewsCollector } from "./hackernews.js";
import { googleTrendsCollector } from "./google-trends.js";
import { redditCollector } from "./reddit.js";
import { githubCollector } from "./github.js";
import { wikipediaCollector } from "./wikipedia.js";
import { rssCollector } from "./rss.js";
import { webpageCollector } from "./webpage.js";

export const COLLECTORS: Record<SourceKey, Collector> = {
  hackernews: hackernewsCollector,
  google_trends: googleTrendsCollector,
  reddit: redditCollector,
  github: githubCollector,
  wikipedia: wikipediaCollector,
  rss: rssCollector,
  webpage: webpageCollector,
  // Not in Phase 3 scope — declared so the registry type is exhaustive.
  youtube: notImplemented("youtube"),
  producthunt: notImplemented("producthunt"),
  devto: notImplemented("devto"),
};

function notImplemented(key: SourceKey): Collector {
  return {
    key,
    label: key,
    requires: [],
    collect(_ctx): Promise<CollectResult> {
      return Promise.resolve({
        items: [],
        stats: {
          source: key,
          status: "skipped",
          items: 0,
          duration_ms: 0,
          error: `collector '${key}' not implemented yet`,
        },
      });
    },
    ping(): Promise<PingResult> {
      return Promise.resolve({ ok: false, detail: "not implemented" });
    },
  };
}

export interface RunCollectorsOptions {
  /** Restrict to these keys (CLI --source); default all with a collect(). */
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
