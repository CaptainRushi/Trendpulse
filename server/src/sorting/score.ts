/**
 * Scoring (TRD §6 stage 8 + §7): deterministic math in code, no LLM.
 *
 *   E = engagement signal = max(engagement_norm) * 0.7 + mean(engagement_norm) * 0.3
 *   S = source diversity  = min(1, distinct_sources / 4)
 *   R = relevance / 100, N = novelty / 100 (Jev ratings)
 *   trend_score = round(100 * (wE*E + wS*S + wR*R + wN*N))
 *
 * Momentum cross-check (§7): a topic whose evidence was ALL first seen
 * today can only be `new` or `rising` — anything else is coerced to `new`
 * (the data-supported claim; Jev never sees first-seen dates). Items with
 * unknown first-seen dates opt out of the check (can't verify → don't touch).
 *
 * Ranking is total and deterministic: score desc, then title, summary, and
 * full JSON as tiebreaks (never ULIDs or timestamps). topic_id/sorted_at
 * are assigned after ordering so they can't perturb the rank.
 */
import { PROMPT_VERSION } from "../llm/prompts/jev.js";
import { z } from "zod";
import { Category, Momentum, Sentiment } from "../sheets/schema.js";
import { SortedTrendRecord } from "../sheets/schema.js";
import type { RawTrendRecord, SortedTrendRecord as SortedRecord } from "../sheets/schema.js";
import { ulid } from "../utils/ulid.js";

/** Scored-topic input (was JevTopic from the retired map step): writer text + code aggregation. */
export const JevTopicSchema = z.object({
  title: z.string().max(140),
  summary: z.string().max(280),
  category: Category,
  tags: z.array(z.string()).max(6),
  relevance: z.number().int().min(0).max(100),
  novelty: z.number().int().min(0).max(100),
  momentum: Momentum,
  sentiment: Sentiment,
  why_trending: z.string().max(200),
  content_angles: z.array(z.string()).length(3),
  item_ids: z.array(z.string()).min(1),
});
export type JevTopic = z.infer<typeof JevTopicSchema>;

export interface ScoreWeights {
  engagement: number;
  diversity: number;
  relevance: number;
  novelty: number;
}

/** TRD §7 defaults; settings.score_weights overrides when present. */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  engagement: 0.35,
  diversity: 0.25,
  relevance: 0.25,
  novelty: 0.15,
};

export interface ScoreOptions {
  topics: JevTopic[];
  itemsById: Map<string, RawTrendRecord>;
  runId: string;
  runDate: string;
  jevModel: string;
  weights?: ScoreWeights;
  topN?: number;
  /** itemId → first_seen_date (YYYY-MM-DD); absent = unknown, skips the check. */
  firstSeenDates?: Map<string, string>;
  /** Provenance marker; Day-1 sorter passes "w1" (legacy map/reduce: "v1"). */
  promptVersion?: string;
  now?: string;
}

export interface ScoreResult {
  topics: SortedRecord[];
  droppedNoEvidence: number;
  momentumCoerced: number;
}

function engagementSignal(norms: number[]): number {
  if (norms.length === 0) return 0;
  const max = Math.max(...norms);
  const mean = norms.reduce((sum, n) => sum + n, 0) / norms.length;
  return max * 0.7 + mean * 0.3;
}

function compareRank(
  a: { trend_score: number; title: string; summary: string; evidence: string[] },
  b: { trend_score: number; title: string; summary: string; evidence: string[] },
): number {
  if (a.trend_score !== b.trend_score) return b.trend_score - a.trend_score;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  if (a.summary !== b.summary) return a.summary < b.summary ? -1 : 1;
  const left = JSON.stringify(a.evidence);
  const right = JSON.stringify(b.evidence);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function scoreTopics(options: ScoreOptions): ScoreResult {
  const weights = options.weights ?? DEFAULT_SCORE_WEIGHTS;
  const topN = options.topN ?? 50;
  const now = options.now ?? new Date().toISOString();
  let droppedNoEvidence = 0;
  let momentumCoerced = 0;

  const ranked = [];
  for (const topic of options.topics) {
    const evidence = topic.item_ids
      .map((id) => options.itemsById.get(id))
      .filter((item): item is RawTrendRecord => item !== undefined);
    if (evidence.length === 0) {
      droppedNoEvidence += 1;
      continue;
    }
    const norms = evidence.map((item) => item.engagement_norm);
    const engagement = engagementSignal(norms);
    const sources = new Set(evidence.map((item) => item.source));
    const diversity = Math.min(1, sources.size / 4);
    const relevance = topic.relevance / 100;
    const novelty = topic.novelty / 100;
    const trendScore = Math.round(
      100 *
        (weights.engagement * engagement +
          weights.diversity * diversity +
          weights.relevance * relevance +
          weights.novelty * novelty),
    );

    let momentum = topic.momentum;
    if (options.firstSeenDates && momentum !== "new" && momentum !== "rising") {
      const dates = evidence.map((item) => options.firstSeenDates?.get(item.id));
      if (dates.length > 0 && dates.every((date) => date === options.runDate)) {
        momentum = "new";
        momentumCoerced += 1;
      }
    }

    const byNorm = [...evidence].sort((x, y) => y.engagement_norm - x.engagement_norm);
    ranked.push({
      topic,
      trend_score: Math.max(0, Math.min(100, trendScore)),
      score_engagement: engagement,
      score_diversity: diversity,
      score_relevance: relevance,
      score_novelty: novelty,
      momentum,
      source_count: sources.size,
      top_urls: byNorm.slice(0, 5).map((item) => item.url),
    });
  }

  ranked.sort((a, b) =>
    compareRank(
      { trend_score: a.trend_score, title: a.topic.title, summary: a.topic.summary, evidence: a.topic.item_ids },
      { trend_score: b.trend_score, title: b.topic.title, summary: b.topic.summary, evidence: b.topic.item_ids },
    ),
  );

  const topics = ranked.slice(0, topN).map((entry, index) =>
    SortedTrendRecord.parse({
      topic_id: ulid(),
      run_id: options.runId,
      run_date: options.runDate,
      rank: index + 1,
      title: entry.topic.title,
      summary: entry.topic.summary,
      category: entry.topic.category,
      tags: entry.topic.tags,
      trend_score: entry.trend_score,
      score_engagement: entry.score_engagement,
      score_diversity: entry.score_diversity,
      score_relevance: entry.score_relevance,
      score_novelty: entry.score_novelty,
      momentum: entry.momentum,
      sentiment: entry.topic.sentiment,
      why_trending: entry.topic.why_trending,
      content_angles: entry.topic.content_angles,
      evidence_item_ids: entry.topic.item_ids,
      source_count: entry.source_count,
      top_urls: entry.top_urls,
      jev_model: options.jevModel,
      prompt_version: options.promptVersion ?? PROMPT_VERSION,
      sorted_at: now,
      is_latest: true,
      hidden: false,
    }),
  );
  return { topics, droppedNoEvidence, momentumCoerced };
}
