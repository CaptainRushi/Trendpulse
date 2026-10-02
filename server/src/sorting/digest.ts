/**
 * Digest generation (`jev_digest` call): 3–5 factual sentences from the top
 * topics only. The client's generic repair fixes JSON shape; sentence-count
 * violations get ONE targeted repair ("rewrite as exactly 4 sentences") —
 * a count the generic repair prompt can't convey — then a typed
 * LlmValidationError. Persistent violation fails the stage loudly instead
 * of persisting a spec-breaking digest row.
 */
import { z } from "zod";
import { LlmValidationError } from "../llm/client.js";
import type { JsonRequest, JsonResult } from "../llm/client.js";
import { JEV_DIGEST_SYSTEM } from "../llm/prompts/jev.js";

/** Minimal surface digest needs — any JSON chat client satisfies this. */
export interface DigestClient {
  readonly modelId: string;
  json<T>(request: JsonRequest<T>): Promise<JsonResult<T>>;
}

/** Digest covers at most this many top-ranked topics (Step-6 task 8). */
export const DIGEST_TOPIC_LIMIT = 10;
export const DIGEST_MIN_SENTENCES = 3;
export const DIGEST_MAX_SENTENCES = 5;
/** Targeted-repair aim: middle of the allowed range. */
const REPAIR_SENTENCE_TARGET = 4;

export const DigestOutputSchema = z.object({
  digest: z.string().min(1),
});
export type DigestOutput = z.infer<typeof DigestOutputSchema>;

/** Tolerant sentence split (terminal punctuation runs; abbreviations may overcount → repair absorbs it). */
export function countSentences(text: string): number {
  return text
    .split(/[.!?…]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

export function formatDigestInput(topics: { title: string; summary: string }[]): string {
  const top = topics.slice(0, DIGEST_TOPIC_LIMIT);
  return `TOPICS:\n${top.map((topic) => `- ${topic.title}: ${topic.summary}`).join("\n")}`;
}

export interface DigestResult {
  digest: string;
  model: string;
  repaired: boolean;
}

export async function generateDigest(
  client: DigestClient,
  topics: { title: string; summary: string }[],
): Promise<DigestResult> {
  const first = await client.json({
    system: JEV_DIGEST_SYSTEM,
    user: formatDigestInput(topics),
    schema: DigestOutputSchema,
    tag: "jev_digest",
  });
  if (isDigestLengthOk(first.data.digest)) {
    return { digest: first.data.digest, model: first.model, repaired: first.repaired };
  }
  const retry = await client.json({
    system: JEV_DIGEST_SYSTEM,
    user:
      `Rewrite the following digest as exactly ${String(REPAIR_SENTENCE_TARGET)} sentences, keeping the facts. ` +
      `JSON: {"digest": string}\n\nDIGEST:\n${first.data.digest}`,
    schema: DigestOutputSchema,
    tag: "jev_digest",
  });
  if (!isDigestLengthOk(retry.data.digest)) {
    throw new LlmValidationError(
      `jev_digest produced ${String(countSentences(retry.data.digest))} sentences, need ${String(DIGEST_MIN_SENTENCES)}–${String(DIGEST_MAX_SENTENCES)}`,
    );
  }
  return { digest: retry.data.digest, model: retry.model, repaired: true };
}

function isDigestLengthOk(digest: string): boolean {
  const count = countSentences(digest);
  return count >= DIGEST_MIN_SENTENCES && count <= DIGEST_MAX_SENTENCES;
}
