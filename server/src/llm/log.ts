/** Persist llm_calls rows (token use, latency, status per call). Wired as the
 *  LlmClient onCall hook by the orchestrator (Phase 6); wizard probes pass
 *  runId null. */
import type { StateDb } from "../db/sqlite.js";
import type { LlmCallRecord } from "./client.js";

export function recordLlmCall(db: StateDb, runId: string | null, record: LlmCallRecord): void {
  db.prepare(
    `INSERT INTO llm_calls
       (run_id, tag, client, model, status, http_status, tokens_in, tokens_out, latency_ms, attempt, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    record.tag,
    record.client,
    record.model,
    record.status,
    record.httpStatus ?? null,
    record.tokensIn,
    record.tokensOut,
    record.latencyMs,
    record.attempt,
    record.error ?? null,
  );
}
