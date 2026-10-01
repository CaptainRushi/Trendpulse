/**
 * Jev sort reduce step (TRD §6 stage 7): merge topics across batches.
 * Skipped when there is only one batch (nothing to merge). The reply goes
 * through the same sanitize boundary as map output (ids must exist in the
 * union of batch items, one topic per item).
 *
 * Availability over purity: if the reduce call fails validation even after
 * the client's repair, fall back to the concatenated map topics (still
 * sanitized) with `reduced: false` — a missing merge must not fail the run
 * when every batch already produced good topics. The flag keeps it observable.
 */
import type { Logger } from "pino";
import { LlmValidationError } from "../llm/client.js";
import { JEV_REDUCE_SYSTEM } from "../llm/prompts/jev.js";
import { JevMapOutputSchema, sanitizeDiscarded, sanitizeMapTopics } from "./map.js";
import type { JevDiscarded, JevJsonClient, JevTopic } from "./map.js";

export interface ReduceOptions {
  client: JevJsonClient;
  topics: JevTopic[];
  /** Union of item ids across all successfully mapped batches. */
  knownItemIds: Set<string>;
  /** Original map batch count — reduce is skipped when ≤ 1. */
  batchCount: number;
  log?: Logger;
}

export interface ReduceResult {
  topics: JevTopic[];
  discarded: JevDiscarded[];
  reduced: boolean;
  droppedUnknownIds: number;
  duplicateClaims: number;
}

/** TRD §8.3 input: titles + summaries + item ids, one topic per line. */
export function formatReduceInput(topics: JevTopic[]): string {
  const lines = topics.map(
    (topic, index) =>
      `[${String(index)}] ${topic.title} || ${topic.summary} || items: ${topic.item_ids.join(",")}`,
  );
  return `TOPICS:\n${lines.join("\n")}`;
}

export async function reduceTopics(options: ReduceOptions): Promise<ReduceResult> {
  const passthrough = (): ReduceResult => {
    const sanitized = sanitizeMapTopics(options.topics, options.knownItemIds);
    // Reduce carries no discarded list of its own; map's stands.
    return {
      topics: sanitized.topics,
      discarded: [],
      reduced: false,
      droppedUnknownIds: sanitized.droppedUnknownIds,
      duplicateClaims: sanitized.duplicateClaims,
    };
  };
  if (options.batchCount <= 1 || options.topics.length === 0) return passthrough();
  try {
    const result = await options.client.json({
      system: JEV_REDUCE_SYSTEM,
      user: formatReduceInput(options.topics),
      schema: JevMapOutputSchema,
      tag: "jev_reduce",
    });
    const sanitized = sanitizeMapTopics(result.data.topics, options.knownItemIds);
    const discarded = sanitizeDiscarded(result.data.discarded ?? [], options.knownItemIds);
    return {
      topics: sanitized.topics,
      discarded: discarded.discarded,
      reduced: true,
      droppedUnknownIds: sanitized.droppedUnknownIds + discarded.droppedUnknownIds,
      duplicateClaims: sanitized.duplicateClaims,
    };
  } catch (error) {
    if (!(error instanceof LlmValidationError)) throw error;
    options.log?.warn(
      { error: error.message },
      "jev_reduce failed validation — falling back to concatenated map topics",
    );
    return passthrough();
  }
}
