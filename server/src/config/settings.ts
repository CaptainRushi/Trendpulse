/**
 * SQLite settings access (schema §2 `settings` table).
 * Precedence: env vars > settings rows > compiled defaults. This module
 * reads the middle layer; callers apply env/fallbacks via resolveEffective.
 */
import type { StateDb } from "../db/sqlite.js";
import type { ScoreWeights } from "../sorting/score.js";
import { DEFAULT_SCORE_WEIGHTS } from "../sorting/score.js";
import type { TrendPulseConfig } from "./env.js";

export type RetentionMode = "archive" | "delete";

export interface EffectiveSettings {
  scoreWeights: ScoreWeights;
  sortBatchSize: number;
  topN: number;
  dedupeDays: number;
  retentionDays: number;
  retentionMode: RetentionMode;
}

/** key → parsed value_json. Corrupt rows throw naming the key. */
/** Upsert one settings row (ids and status live here, never secrets). */
export function writeSetting(db: StateDb, key: string, value: unknown, isSecret = false): void {
  db.prepare(
    "INSERT INTO settings (key, value_json, is_secret) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, is_secret = excluded.is_secret, " +
      "updated_at = datetime('now')",
  ).run(key, JSON.stringify(value), isSecret ? 1 : 0);
}

export function readSettingsMap(db: StateDb): Map<string, unknown> {
  const rows = db.prepare("SELECT key, value_json FROM settings").all() as {
    key: string;
    value_json: string;
  }[];
  const map = new Map<string, unknown>();
  for (const row of rows) {
    try {
      map.set(row.key, JSON.parse(row.value_json) as unknown);
    } catch {
      throw new Error(`settings row '${row.key}' holds corrupt JSON`);
    }
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function intOr(value: unknown, fallback: number, min: number): number {
  const n = numberOr(value, fallback);
  if (!Number.isInteger(n) || n < min) return fallback;
  return n;
}

export function scoreWeightsOr(value: unknown, fallback: ScoreWeights): ScoreWeights {
  if (!isRecord(value)) return fallback;
  const parts = {
    engagement: numberOr(value["engagement"], Number.NaN),
    diversity: numberOr(value["diversity"], Number.NaN),
    relevance: numberOr(value["relevance"], Number.NaN),
    novelty: numberOr(value["novelty"], Number.NaN),
  };
  if (Object.values(parts).some((n) => !Number.isFinite(n) || n < 0)) return fallback;
  return parts;
}

/**
 * Effective run settings. Env wins over settings rows (schema §2); a
 * malformed score_weights row falls back to TRD §7 defaults (logged by the
 * caller via the `warnings` list).
 */
export function resolveEffectiveSettings(db: StateDb, config: TrendPulseConfig): {
  settings: EffectiveSettings;
  warnings: string[];
} {
  const warnings: string[] = [];
  let map: Map<string, unknown>;
  try {
    map = readSettingsMap(db);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    map = new Map();
  }
  const rawWeights = map.get("score_weights");
  if (rawWeights !== undefined) {
    const parsed = scoreWeightsOr(rawWeights, DEFAULT_SCORE_WEIGHTS);
    if (parsed === DEFAULT_SCORE_WEIGHTS) {
      warnings.push("settings.score_weights is malformed — using TRD §7 defaults");
    }
  }
  const mode = map.get("retention_mode");
  const retentionMode: RetentionMode = mode === "delete" ? "delete" : "archive";
  if (mode !== undefined && mode !== "archive" && mode !== "delete") {
    warnings.push("settings.retention_mode is malformed — using archive");
  }
  return {
    settings: {
      scoreWeights: scoreWeightsOr(rawWeights, DEFAULT_SCORE_WEIGHTS),
      sortBatchSize: intOr(map.get("sort_batch_size"), config.sortBatchSize, 1),
      topN: intOr(map.get("top_n"), config.topN, 1),
      dedupeDays: intOr(map.get("dedupe_days"), config.dedupeDays, 0),
      retentionDays: intOr(map.get("retention_days"), config.retentionDays, 1),
      retentionMode,
    },
    warnings,
  };
}
