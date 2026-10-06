/**
 * Sorting events (Doc 17 S4): real pipeline events for the animation, batched
 * (≤100 items per event, naturally ≤20/s), titles cut to 60 chars. Every
 * emission is also persisted to sort_events so a mid-sort page load can
 * rebuild state by replay — snapshot == replay by construction (SORTANIM-02).
 */
import type { StateDb } from "../db/sqlite.js";
import type { EventBus, PipelineEventType } from "./events.js";

/** Keep replay stores small: last 3 runs, 5 MB per run. */
export const SORT_EVENTS_RUNS_KEPT = 3;
export const SORT_EVENTS_MAX_BYTES = 5 * 1024 * 1024;
const TITLE_MAX = 60;
const BATCH_MAX_ITEMS = 100;

export type SortPhase = "classify" | "filter" | "cluster" | "write" | "rank" | "done";

export interface SortBatchItem {
  id: string;
  t: string;
  c: string;
  q: number;
  f: boolean;
  d: boolean;
  o: boolean;
}

/** Titles are plain text, cut to 60 chars (SORTANIM-01). */
export function cutTitle(title: string): string {
  return title.length > TITLE_MAX ? title.slice(0, TITLE_MAX) : title;
}

/** Chunk labeled items into bounded batch payloads. */
export function chunkBatch<T>(items: T[], size: number = BATCH_MAX_ITEMS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function nextSeq(db: StateDb, runId: string): number {
  const row = db.prepare("SELECT MAX(seq) AS m FROM sort_events WHERE run_id = ?").get(runId) as { m: number | null };
  return (row.m ?? 0) + 1;
}

function runBytes(db: StateDb, runId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS n FROM sort_events WHERE run_id = ?").get(runId) as {
    n: number;
  };
  return row.n;
}

/** Persist one event; prunes to the last 3 runs and enforces the 5 MB cap. */
export function recordSortEvent(db: StateDb, runId: string, payload: Record<string, unknown>): void {
  if (runBytes(db, runId) >= SORT_EVENTS_MAX_BYTES) return;
  const seq = nextSeq(db, runId);
  db.prepare("INSERT INTO sort_events (run_id, seq, payload_json) VALUES (?, ?, ?)").run(runId, seq, JSON.stringify(payload));
  db.prepare(
    `DELETE FROM sort_events WHERE run_id NOT IN (SELECT id FROM runs ORDER BY started_at DESC, id DESC LIMIT ${String(SORT_EVENTS_RUNS_KEPT)})`,
  ).run();
}

/** Emit on the bus AND persist for replay. Never throws into the pipeline. */
export function emitSortEvent(
  db: StateDb,
  bus: Pick<EventBus, "emit">,
  runId: string,
  type: PipelineEventType,
  payload: Record<string, unknown>,
): void {
  try {
    recordSortEvent(db, runId, { type, ...payload });
  } catch {
    // Telemetry must never break a run.
  }
  bus.emit(runId, type, payload);
}

/** Full replay for a run, oldest first. */
export function replaySortEvents(db: StateDb, runId: string): Record<string, unknown>[] {
  const rows = db.prepare("SELECT payload_json FROM sort_events WHERE run_id = ? ORDER BY seq").all(runId) as {
    payload_json: string;
  }[];
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      if (parsed !== null && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      // Skip corrupt rows; never fail the snapshot.
    }
  }
  return out;
}
