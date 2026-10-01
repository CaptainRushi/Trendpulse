/**
 * Jev sort map step (TRD §6 stage 6): split items into batches of
 * SORT_BATCH_SIZE, ask Jev for topics per batch, sanitize every reply.
 *
 * Sanitizing is the trust boundary (prompt injection can't change the
 * output shape): item ids must exist in the batch (unknown ids dropped,
 * emptied topics dropped), every kept item belongs to at most one topic
 * (first claim wins), discarded entries must reference real items.
 *
 * Failure ladder per batch: invalid output → split in half once → halves
 * that still fail become `sort_failed` item ids. The run continues
 * (partial), it never crashes on bad Jev JSON.
 */
import pLimit from "p-limit";
import type { Logger } from "pino";
import { z } from "zod";
import { LlmValidationError } from "../llm/client.js";
import type { JsonRequest, JsonResult } from "../llm/client.js";
import { JEV_MAP_SYSTEM } from "../llm/prompts/jev.js";
import { Category, Momentum, Sentiment } from "../sheets/schema.js";
import type { RawTrendRecord } from "../sheets/schema.js";

/** Minimal surface the sorter needs — LlmClient satisfies this structurally. */
export interface JevJsonClient {
  readonly modelId: string;
  json<T>(request: JsonRequest<T>): Promise<JsonResult<T>>;
}

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

export const JevMapOutputSchema = z.object({
  topics: z.array(JevTopicSchema),
  discarded: z.array(z.object({ item_id: z.string(), reason: z.string() })).default([]),
});
export type JevMapOutput = z.infer<typeof JevMapOutputSchema>;
export type JevDiscarded = JevMapOutput["discarded"][number];

export interface SanitizeResult {
  topics: JevTopic[];
  discarded: JevDiscarded[];
  droppedUnknownIds: number;
  duplicateClaims: number;
}

/**
 * Enforce the output contract: known ids only, non-empty topics, one topic
 * per item (first claim in array order wins). Deterministic.
 */
export function sanitizeMapTopics(raw: JevTopic[], knownItemIds: Set<string>): SanitizeResult {
  const topics: JevTopic[] = [];
  const discarded: JevDiscarded[] = [];
  const claimed = new Set<string>();
  let droppedUnknownIds = 0;
  let duplicateClaims = 0;
  for (const topic of raw) {
    const kept: string[] = [];
    for (const id of topic.item_ids) {
      if (!knownItemIds.has(id)) {
        droppedUnknownIds += 1;
        continue;
      }
      if (claimed.has(id)) {
        duplicateClaims += 1;
        continue;
      }
      claimed.add(id);
      kept.push(id);
    }
    if (kept.length === 0) continue;
    topics.push({ ...topic, item_ids: kept });
  }
  return { topics, discarded, droppedUnknownIds, duplicateClaims };
}

/** Discarded entries must reference real items too (else they lie in runs). */
export function sanitizeDiscarded(
  raw: JevDiscarded[],
  knownItemIds: Set<string>,
): { discarded: JevDiscarded[]; droppedUnknownIds: number } {
  const discarded = raw.filter((entry) => knownItemIds.has(entry.item_id));
  return { discarded, droppedUnknownIds: raw.length - discarded.length };
}

export interface MappedBatch extends SanitizeResult {
  failedItemIds: string[];
}

export interface MapBatchOptions {
  client: JevJsonClient;
  items: RawTrendRecord[];
  niches: string[];
  runDate: string;
  log?: Logger;
}

/** TRD §8.2 user message: NICHES, DATE, then one line per item. */
export function formatMapInput(items: RawTrendRecord[], niches: string[], runDate: string): string {
  const lines = items.map(
    (item) =>
      `[${item.id}] ${item.source} | ${item.title} | ${item.snippet} | ${String(item.engagement_score ?? "unknown")}`,
  );
  return `NICHES: ${niches.join(", ")}\nDATE: ${runDate}\nITEMS:\n${lines.join("\n")}`;
}

async function mapSingleBatch(options: MapBatchOptions): Promise<MappedBatch> {
  const knownItemIds = new Set(options.items.map((item) => item.id));
  const result = await options.client.json({
    system: JEV_MAP_SYSTEM,
    user: formatMapInput(options.items, options.niches, options.runDate),
    schema: JevMapOutputSchema,
    tag: "jev_map",
  });
  const sanitized = sanitizeMapTopics(result.data.topics, knownItemIds);
  const discarded = sanitizeDiscarded(result.data.discarded ?? [], knownItemIds);
  return {
    topics: sanitized.topics,
    discarded: discarded.discarded,
    droppedUnknownIds: sanitized.droppedUnknownIds + discarded.droppedUnknownIds,
    duplicateClaims: sanitized.duplicateClaims,
    failedItemIds: [],
  };
}

async function mapWithLadder(options: MapBatchOptions): Promise<MappedBatch> {
  try {
    return await mapSingleBatch(options);
  } catch (error) {
    if (!(error instanceof LlmValidationError)) throw error;
  }
  // Ladder: split in half once. Halves that still fail → sort_failed ids.
  // Single-item batches cannot split — their id fails directly.
  const empty: MappedBatch = {
    topics: [],
    discarded: [],
    droppedUnknownIds: 0,
    duplicateClaims: 0,
    failedItemIds: [],
  };
  if (options.items.length < 2) {
    return {
      ...empty,
      failedItemIds: options.items.map((item) => item.id),
    };
  }
  const mid = Math.ceil(options.items.length / 2);
  const halves = [options.items.slice(0, mid), options.items.slice(mid)];
  const merged: MappedBatch = { ...empty };
  for (const half of halves) {
    try {
      const result = await mapSingleBatch({ ...options, items: half });
      merged.topics.push(...result.topics);
      merged.discarded.push(...result.discarded);
      merged.droppedUnknownIds += result.droppedUnknownIds;
      merged.duplicateClaims += result.duplicateClaims;
    } catch (error) {
      if (!(error instanceof LlmValidationError)) throw error;
      merged.failedItemIds.push(...half.map((item) => item.id));
      options.log?.warn(
        { batchSize: half.length, error: error.message },
        "jev_map half-batch failed validation — items marked sort_failed",
      );
    }
  }
  return merged;
}

export interface MapAllOptions {
  client: JevJsonClient;
  items: RawTrendRecord[];
  niches: string[];
  runDate: string;
  batchSize?: number;
  /** TRD §5: LLM_CONCURRENCY enforced by the caller (this batch runner). */
  concurrency?: number;
  log?: Logger;
}

export interface MapAllResult {
  batches: MappedBatch[];
  topics: JevTopic[];
  discarded: JevDiscarded[];
  failedItemIds: string[];
  droppedUnknownIds: number;
  duplicateClaims: number;
  /** Original batch count — reduce skips when this is 1. */
  batchCount: number;
}

export const DEFAULT_SORT_BATCH_SIZE = 30;

/** Chunk items and map every batch (concurrency-limited, order-preserving). */
export async function mapAllBatches(options: MapAllOptions): Promise<MapAllResult> {
  const batchSize = options.batchSize ?? DEFAULT_SORT_BATCH_SIZE;
  const batches: RawTrendRecord[][] = [];
  for (let i = 0; i < options.items.length; i += batchSize) {
    batches.push(options.items.slice(i, i + batchSize));
  }
  const limit = pLimit(options.concurrency ?? 2);
  const mapped = await Promise.all(
    batches.map((items) =>
      limit(() =>
        mapWithLadder({
          client: options.client,
          items,
          niches: options.niches,
          runDate: options.runDate,
          ...(options.log ? { log: options.log } : {}),
        }),
      ),
    ),
  );
  return {
    batches: mapped,
    topics: mapped.flatMap((batch) => batch.topics),
    discarded: mapped.flatMap((batch) => batch.discarded),
    failedItemIds: mapped.flatMap((batch) => batch.failedItemIds),
    droppedUnknownIds: mapped.reduce((n, batch) => n + batch.droppedUnknownIds, 0),
    duplicateClaims: mapped.reduce((n, batch) => n + batch.duplicateClaims, 0),
    batchCount: batches.length,
  };
}
