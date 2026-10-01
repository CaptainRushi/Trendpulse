/**
 * Pipeline lock (TRD §10): one run at a time. Row in `locks`
 * (name='pipeline', run_id, heartbeat_at); a heartbeat older than 5 minutes
 * is stale and may be taken over. The second concurrent trigger gets
 * LockBusyError (the API maps it to 409 RUN_LOCKED in Phase 7).
 */
import type { StateDb } from "../db/sqlite.js";

export const PIPELINE_LOCK_NAME = "pipeline";
/** Stale after 5 minutes without a heartbeat (TRD §10). */
export const LOCK_STALE_AFTER_MS = 5 * 60 * 1000;
/** Heartbeat cadence while a run holds the lock (5× margin to the stale line). */
export const LOCK_HEARTBEAT_MS = 60 * 1000;

export class LockBusyError extends Error {
  readonly holderRunId: string;
  constructor(holderRunId: string) {
    super(`pipeline is already running (run ${holderRunId})`);
    this.name = "LockBusyError";
    this.holderRunId = holderRunId;
  }
}

interface LockRow {
  run_id: string | null;
  heartbeat_at: string;
}

/**
 * Take the lock for runId. Throws LockBusyError naming the holder when a
 * fresh lock exists; steals stale locks. `now`/`staleAfterMs` are test seams.
 */
export function acquirePipelineLock(
  db: StateDb,
  runId: string,
  now: number = Date.now(),
  staleAfterMs: number = LOCK_STALE_AFTER_MS,
): void {
  const row = db
    .prepare("SELECT run_id, heartbeat_at FROM locks WHERE name = ?")
    .get(PIPELINE_LOCK_NAME) as LockRow | undefined;
  if (row) {
    const ageMs = now - Date.parse(row.heartbeat_at);
    if (row.run_id !== runId && Number.isFinite(ageMs) && ageMs <= staleAfterMs) {
      throw new LockBusyError(row.run_id ?? "unknown");
    }
  }
  db.prepare(
    `INSERT INTO locks (name, run_id, heartbeat_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET run_id = excluded.run_id, heartbeat_at = excluded.heartbeat_at`,
  ).run(PIPELINE_LOCK_NAME, runId, new Date(now).toISOString());
}

/** Release only our own lock (never another run's). Returns true when released. */
export function releasePipelineLock(db: StateDb, runId: string): boolean {
  const result = db
    .prepare("DELETE FROM locks WHERE name = ? AND run_id = ?")
    .run(PIPELINE_LOCK_NAME, runId);
  return result.changes > 0;
}

/** Refresh our heartbeat; returns false when we no longer hold the lock. */
export function heartbeatPipelineLock(db: StateDb, runId: string, now: number = Date.now()): boolean {
  const result = db
    .prepare("UPDATE locks SET heartbeat_at = ? WHERE name = ? AND run_id = ?")
    .run(new Date(now).toISOString(), PIPELINE_LOCK_NAME, runId);
  return result.changes > 0;
}

export interface BootRecovery {
  releasedStaleLocks: number;
  interruptedRuns: string[];
}

/**
 * Boot recovery: mark runs left `running` by a dead process as
 * `interrupted`, then release locks that can no longer have a live holder:
 * stale heartbeats, locks of interrupted runs (so a retry minutes after a
 * kill doesn't meet a bogus 409), and locks with no runs row at all.
 * A lock whose run is still `running` with a fresh heartbeat is left alone
 * (a concurrent live server may hold it). Callers decide whether to
 * auto-resume (AUTO_RESUME) or leave interrupted runs for manual retry.
 */
export function recoverOnBoot(db: StateDb, now: number = Date.now()): BootRecovery {
  const finishedAt = new Date(now).toISOString();
  const running = db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as {
    id: string;
  }[];
  const interrupted: string[] = [];
  const mark = db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE id = ?");
  const sweep = db.transaction(() => {
    for (const row of running) {
      mark.run(finishedAt, row.id);
      interrupted.push(row.id);
    }
  });
  sweep();
  const staleCutoff = new Date(now - LOCK_STALE_AFTER_MS).toISOString();
  const released = db.prepare(
    `DELETE FROM locks WHERE heartbeat_at < ?
       OR run_id IN (SELECT id FROM runs WHERE status = 'interrupted')
       OR run_id NOT IN (SELECT id FROM runs)`,
  ).run(staleCutoff);
  return { releasedStaleLocks: released.changes, interruptedRuns: interrupted };
}
