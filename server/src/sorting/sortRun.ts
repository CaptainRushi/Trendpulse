/**
 * Day-1 sort run (docs/11 §1.3): classify (Jev, cached) → filter → cluster →
 * aggregate → momentum → write (OmniRoute) → score → digest → persist.
 * Pure stages live in their own modules; this wires them with the run's
 * credentials, budget and settings. items_run status flips are best-effort
 * (Step 7 owns the working set; without it they update zero rows, harming
 * nothing). Never throws for content — failures surface as partial stats.
 */
import type { StateDb } from "../db/sqlite.js";
import type { Classifier } from "../llm/classifier.js";
import type { LlmClient } from "../llm/client.js";
import type { JevClient } from "../llm/jev.js";
import { JevBudgetExceeded } from "../llm/jev.js";
import type { SheetsRepo } from "../sheets/repo.js";
import type { RawTrendRecord, SortedTrendRecord } from "../sheets/schema.js";
import type { JevTopic } from "./map.js";
import { aggregateClusters } from "./aggregate.js";
import type { AggregateItem } from "./aggregate.js";
import { classifyItems } from "./classifyLabels.js";
import type { ClassifiableItem } from "./classifyLabels.js";
import { clusterItems } from "./clusterTopics.js";
import type { SameStoryCheck } from "./clusterTopics.js";
import { generateDigest } from "./digest.js";
import { DEFAULT_SCORE_WEIGHTS, scoreTopics } from "./score.js";
import type { ScoreWeights } from "./score.js";
import { writeTopics } from "./writeTopics.js";
import type { WrittenTopic } from "./writeTopics.js";
import { fallbackTopic } from "./writeTopics.js";

export const SORT_PROMPT_VERSION = "w1";

export interface SortRunOptions {
  db: StateDb;
  repo?: SheetsRepo | undefined;
  classifier: Classifier;
  fallback?: Classifier | undefined;
  fallbackEnabled: boolean;
  classifierModel: string;
  niches: string[];
  qualityMin: number;
  sameStory?: SameStoryCheck | undefined;
  jevClientForPairs?: JevClient | undefined;
  writer: LlmClient;
  writerModel: string;
  batchSize: number;
  weights?: ScoreWeights | undefined;
  topN?: number;
  runId: string;
  runDate: string;
  /** itemId → first_seen_date; absent = unknown (no `new` coercion for it). */
  firstSeen: Map<string, string>;
  /** Digest text (writer model); disable only when cut for time. */
  digest?: boolean | undefined;
  runCounts?: { itemsCount: number; sourcesOk: number; sourcesTotal: number } | undefined;
}

export interface SortRunStats {
  input: number;
  classified: number;
  cached: number;
  fallbackWrites: number;
  discarded: number;
  clusters: number;
  topics: number;
  writeFailed: number;
  digestWritten: boolean;
  partial: boolean;
  reasons: string[];
}

export interface SortRunResult {
  topics: SortedTrendRecord[];
  digest: string | null;
  stats: SortRunStats;
}

function markSortStatus(db: StateDb, runId: string, ids: string[], status: string): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE items_run SET sort_status = ? WHERE run_id = ? AND id IN (${placeholders})`).run(
    status,
    runId,
    ...ids,
  );
}

/** Normalize callers' weights; fall back to TRD §7 defaults when unusable. */
export function normalizeWeights(weights: ScoreWeights | undefined): ScoreWeights {
  const fallback = { ...DEFAULT_SCORE_WEIGHTS };
  if (weights === undefined) return fallback;
  const parts = [weights.engagement, weights.diversity, weights.relevance, weights.novelty];
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return fallback;
  const total = parts.reduce((sum, p) => sum + p, 0);
  if (total <= 0) return fallback;
  return {
    engagement: weights.engagement / total,
    diversity: weights.diversity / total,
    relevance: weights.relevance / total,
    novelty: weights.novelty / total,
  };
}

export async function runSorter(options: SortRunOptions, items: RawTrendRecord[]): Promise<SortRunResult> {
  const stats: SortRunStats = {
    input: items.length,
    classified: 0,
    cached: 0,
    fallbackWrites: 0,
    discarded: 0,
    clusters: 0,
    topics: 0,
    writeFailed: 0,
    digestWritten: false,
    partial: false,
    reasons: [],
  };
  const partial = (reason: string): void => {
    stats.partial = true;
    stats.reasons.push(reason);
  };
  const byId = new Map(items.map((item) => [item.id, item]));

  // 1. classify (ONE Jev request per item, cache first, budget honored).
  const classifiable: ClassifiableItem[] = items.map((item) => ({
    id: item.id,
    contentHash: item.content_hash,
    title: item.title,
    snippet: item.snippet,
    source: item.source,
    publishedAt: item.published_at,
  }));
  const { labeled, stats: classifyStats } = await classifyItems(
    {
      db: options.db,
      classifier: options.classifier,
      fallback: options.fallback,
      fallbackEnabled: options.fallbackEnabled,
      model: options.classifierModel,
      niches: options.niches,
    },
    classifiable,
  );
  stats.classified = classifyStats.classified;
  stats.cached = classifyStats.cached;
  stats.fallbackWrites = classifyStats.fallbackUsed;
  if (classifyStats.failed.length > 0) {
    markSortStatus(options.db, options.runId, classifyStats.failed, "sort_failed");
    partial(`${String(classifyStats.failed.length)} items unclassifiable (sort_failed)`);
  }
  if (classifyStats.budgetStopped) partial("jev budget exhausted; unclassified items stay pending");

  // 2. filter low quality.
  const kept = labeled.filter((l) => l.labels.quality >= options.qualityMin);
  const discardedIds = labeled.filter((l) => l.labels.quality < options.qualityMin).map((l) => l.itemId);
  stats.discarded = discardedIds.length;
  markSortStatus(options.db, options.runId, discardedIds, "discarded");

  // 3. cluster (borderline pairs ask same_story unless cut or budget spent).
  let sameStory = options.sameStory;
  if (sameStory === undefined && options.jevClientForPairs !== undefined) {
    const pairClient = options.jevClientForPairs;
    sameStory = async (a, b) => {
      try {
        const result = await pairClient.classify(
          { a: `${a.title} ${a.snippet}`.slice(0, 2000), b: `${b.title} ${b.snippet}`.slice(0, 2000) },
          { same_story: { type: "noul", instructions: "Are these two items about the same real-world story?" } },
          "jev_same_story",
        );
        const answer = result.answers["same_story"];
        return answer?.kind === "noul" ? answer.noul : null;
      } catch (error) {
        if (error instanceof JevBudgetExceeded) return null;
        throw error;
      }
    };
  }
  const clusterInputs = kept.map((l) => {
    const item = byId.get(l.itemId);
    return { id: l.itemId, title: item?.title ?? "", snippet: item?.snippet ?? "" };
  });
  const clusters = await clusterItems(clusterInputs, sameStory === undefined ? {} : { sameStory });
  stats.clusters = clusters.length;

  // 4–5. aggregate + momentum (code).
  const aggregateById = new Map<string, AggregateItem>();
  for (const l of kept) {
    const item = byId.get(l.itemId);
    if (!item) continue;
    aggregateById.set(l.itemId, {
      id: l.itemId,
      source: item.source,
      engagementNorm: item.engagement_norm,
      firstSeenToday: options.firstSeen.get(l.itemId) === options.runDate,
      labels: l.labels,
    });
  }
  const aggregated = aggregateClusters(clusters, aggregateById);

  // 6. write (OmniRoute batches).
  const writerInputs = aggregated.map((cluster) => {
    const members = cluster.itemIds
      .map((id) => byId.get(id))
      .filter((item): item is RawTrendRecord => item !== undefined)
      .sort((a, b) => b.engagement_norm - a.engagement_norm);
    const top = members[0];
    return {
      clusterId: cluster.clusterId,
      items: members.map((m) => ({ source: m.source, title: m.title, snippet: m.snippet })),
      topTitle: top?.title ?? "Untitled topic",
      topSnippet: top?.snippet ?? "",
      sourceCount: cluster.sourceCount,
    };
  });
  let written: WrittenTopic[];
  try {
    const result = await writeTopics(options.writer, writerInputs, { batchSize: options.batchSize });
    written = result.topics;
  } catch (error) {
    // Writer transport failure (not content): every cluster falls back, run partial.
    partial(`writer unreachable: ${error instanceof Error ? error.message : String(error)}`);
    written = writerInputs.map((input) => ({ text: fallbackTopic(input), writeFailed: true }));
  }
  stats.writeFailed = written.filter((w) => w.writeFailed).length;
  if (stats.writeFailed > 0) partial(`${String(stats.writeFailed)} topics use fallback text (write_failed)`);

  // 7. score (code) + rank + TOP_N.
  const aggregatedById = new Map(aggregated.map((a) => [a.clusterId, a]));
  const jevTopics: JevTopic[] = written.map((w) => {
    const agg = aggregatedById.get(w.text.cluster_id);
    // Aggregate votes only produce valid Category/Sentiment members
    // ("none" folds to Other/neutral at classification time).
    const category = (agg?.category ?? "Other") as JevTopic["category"];
    const sentiment = (agg?.sentiment ?? "neutral") as JevTopic["sentiment"];
    return {
      title: w.text.title,
      summary: w.text.summary,
      category,
      tags: w.text.tags,
      relevance: Math.round((agg?.relevance ?? 0) * 100),
      novelty: Math.round((agg?.novelty ?? 0) * 100),
      momentum: agg?.momentum ?? "steady",
      sentiment,
      why_trending: w.text.why_trending,
      content_angles: w.text.content_angles,
      item_ids: agg?.itemIds ?? [],
    };
  });
  const scored = scoreTopics({
    topics: jevTopics,
    itemsById: byId,
    runId: options.runId,
    runDate: options.runDate,
    jevModel: options.classifierModel,
    weights: normalizeWeights(options.weights),
    topN: options.topN ?? 50,
    firstSeenDates: options.firstSeen,
    promptVersion: SORT_PROMPT_VERSION,
  });
  stats.topics = scored.topics.length;

  // 8. digest (writer model, top 10).
  let digest: string | null = null;
  if (options.digest !== false && scored.topics.length > 0) {
    try {
      const digestResult = await generateDigest(
        options.writer,
        scored.topics.slice(0, 10).map((t) => ({ title: t.title, summary: t.summary })),
      );
      digest = digestResult.digest;
    } catch (error) {
      partial(`digest failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 9. persist sorted rows, digest row, flip latest.
  if (options.repo !== undefined) {
    if (scored.topics.length > 0) await options.repo.appendSorted(scored.topics);
    if (digest !== null) {
      const top = scored.topics[0];
      const counts = options.runCounts ?? { itemsCount: items.length, sourcesOk: 0, sourcesTotal: 0 };
      await options.repo.appendDigest({
        run_date: options.runDate,
        run_id: options.runId,
        digest,
        top_topic_id: top?.topic_id ?? "",
        topics_count: scored.topics.length,
        items_count: counts.itemsCount,
        sources_ok: counts.sourcesOk,
        sources_total: counts.sourcesTotal,
        top_categories: topCategories(scored.topics),
        created_at: new Date().toISOString(),
        is_latest: true,
      });
      stats.digestWritten = true;
    }
    await options.repo.markLatest(options.runDate, options.runId);
  }
  markSortStatus(
    options.db,
    options.runId,
    scored.topics.flatMap((t) => t.evidence_item_ids),
    "sorted",
  );
  return { topics: scored.topics, digest, stats };
}

function topCategories(topics: { category: string }[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const topic of topics) counts.set(topic.category, (counts.get(topic.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1));
}
