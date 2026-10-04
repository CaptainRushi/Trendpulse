/**
 * Monthly call budget (docs/15 §5, CMP-10). One table, one sum, one compare.
 * The recordCall hook is passed into the gateway so nothing else has to know
 * about SQLite.
 */
import type { StateDb } from "../../db/sqlite.js";
import type { CallRecord } from "./gateway.js";

export interface BudgetUsage {
  used: number;
  limit: number;
  /** 0..1+; 0 when no limit is configured. */
  ratio: number;
  exhausted: boolean;
  /** Warn at 80% (docs/15 §6). */
  warning: boolean;
}

export function monthUsage(db: StateDb): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM integration_calls WHERE created_at >= datetime('now','start of month')")
    .get() as { n: number };
  return row.n;
}

export function budgetUsage(db: StateDb, limit: number): BudgetUsage {
  const used = monthUsage(db);
  const ratio = limit > 0 ? used / limit : 0;
  return { used, limit, ratio, exhausted: limit > 0 && used >= limit, warning: limit > 0 && used >= limit * 0.8 };
}

/** Usage grouped by slug+status for the /usage route. */
export function usageBySlug(db: StateDb): { slug: string; status: string; calls: number }[] {
  return db
    .prepare(
      "SELECT slug, status, COUNT(*) AS calls FROM integration_calls " +
        "WHERE created_at >= datetime('now','start of month') GROUP BY slug, status ORDER BY calls DESC",
    )
    .all() as { slug: string; status: string; calls: number }[];
}

/** Gateway onCall hook: INSERT and nothing else. Fails soft — accounting
 *  must never break a run. */
export function recordCall(db: StateDb, runId: string | undefined, record: CallRecord): void {
  try {
    db.prepare(
      "INSERT INTO integration_calls (provider, slug, status, latency_ms, run_id) VALUES (?, ?, ?, ?, ?)",
    ).run("composio", record.slug, record.ok ? "ok" : "error", record.latencyMs, runId ?? null);
  } catch {
    // Budget telemetry is best effort.
  }
}
