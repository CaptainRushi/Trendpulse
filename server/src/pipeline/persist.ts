/**
 * items_run working set + persist_raw stage (TRD §6 stages 4–5).
 *
 * prepareRunItems runs the deterministic chain — normalize → seen-filter →
 * near-merge → engagement_norm — assigns one ULID per keeper, validates the
 * full RawTrendRecord, and writes the `items_run` working set (persisted=0).
 * One prepare per runId (fail fast on a second call — silent doubling is
 * worse than a loud error).
 *
 * persistRawItems appends pending rows to `raw_trends` via SheetsRepo, then —
 * ONLY on sheet success — marks them persisted and records keeper + absorbed
 * hashes in `seen_items` (single SQLite transaction). A sheets failure
 * leaves pending rows untouched and `seen_items` empty, so a retry or a
 * same-day re-run appends nothing twice: re-running the same day adds 0 raw
 * rows because every hash is already seen.
 *
 * Absorbed hashes ride along in payload_json under `_absorbed` (stripped on
 * read, never written to the sheet) so they survive a crash between prepare
 * and persist without a schema migration for transient data.
 */
import type { RawItemDraft } from "../collectors/types.js";
import type { StateDb } from "../db/sqlite.js";
import { isMissingRangeError } from "../sheets/client.js";
import type { SheetsRepo } from "../sheets/repo.js";
import { RawTrendRecord } from "../sheets/schema.js";
import type { RawTrendRecord as RawRecord } from "../sheets/schema.js";
import type { SourceKey } from "../sheets/schema.js";
import { ulid } from "../utils/ulid.js";
import { applyEngagementNorm, normalizeDrafts } from "./normalize.js";
import type { ScoredItem } from "./normalize.js";
import {
  filterSeenItems,
  mergeNearDuplicates,
  SEEN_UPSERT_SQL,
  uniqueSeenEntries,
} from "./dedupe.js";
import type { AbsorbedItem } from "./dedupe.js";

/** Sidecar key in payload_json: absorbed hashes+sources, never sheet-bound. */
export const ABSORBED_KEY = "_absorbed";

export interface PrepareStats {
  input: number;
  normalized: number;
  droppedBadUrl: number;
  droppedEmptyTitle: number;
  seenDropped: number;
  merged: number;
  output: number;
}

export interface PrepareResult {
  items: RawRecord[];
  stats: PrepareStats;
}

export interface PrepareOptions {
  runId: string;
  runDate: string;
  drafts: RawItemDraft[];
  dedupeDays: number;
  collectedAt?: string;
}

interface StoredPayload extends Record<string, unknown> {
  _absorbed?: AbsorbedItem[];
}

function toRecord(
  item: ScoredItem & { merged_sources: SourceKey[] },
  runId: string,
  collectedAt: string,
): RawRecord {
  return RawTrendRecord.parse({
    id: ulid(),
    run_id: runId,
    collected_at: collectedAt,
    source: item.source,
    source_item_id: item.source_item_id,
    url: item.url,
    title: item.title,
    snippet: item.snippet,
    author: item.author,
    published_at: item.published_at,
    engagement_score: item.engagement_score,
    engagement_extra: item.engagement,
    engagement_norm: item.engagement_norm,
    language: item.language,
    region: item.region,
    content_hash: item.content_hash,
    merged_sources: item.merged_sources,
    extraction_model: item.extraction_model,
  });
}

export function prepareRunItems(db: StateDb, options: PrepareOptions): PrepareResult {
  const existing = db
    .prepare("SELECT COUNT(*) AS n FROM items_run WHERE run_id = ?")
    .get(options.runId) as { n: number };
  if (existing.n > 0) {
    throw new Error(`prepareRunItems: run ${options.runId} already has an items_run working set`);
  }

  const collectedAt = options.collectedAt ?? new Date().toISOString();
  const normalized = normalizeDrafts(options.drafts);
  const seen = filterSeenItems(db, normalized.items, {
    runDate: options.runDate,
    dedupeDays: options.dedupeDays,
  });
  const merged = mergeNearDuplicates(seen.fresh);
  const scored = applyEngagementNorm(merged.items);
  const items = scored.map((item) => toRecord(item, options.runId, collectedAt));

  const insert = db.prepare(
    `INSERT INTO items_run (id, run_id, run_date, source, content_hash, payload_json, persisted, sort_status)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'pending')`,
  );
  const write = db.transaction(() => {
    for (const item of items) {
      const payload: StoredPayload = { ...item };
      const group = merged.absorbedByKeeper.get(item.content_hash) ?? [];
      if (group.length > 0) payload[ABSORBED_KEY] = group;
      insert.run(
        item.id,
        item.run_id,
        options.runDate,
        item.source,
        item.content_hash,
        JSON.stringify(payload),
      );
    }
  });
  write();

  return {
    items,
    stats: {
      input: normalized.stats.input,
      normalized: normalized.stats.output,
      droppedBadUrl: normalized.stats.droppedBadUrl,
      droppedEmptyTitle: normalized.stats.droppedEmptyTitle,
      seenDropped: seen.seenCount,
      merged: merged.merged,
      output: items.length,
    },
  };
}

export interface PendingItem {
  record: RawRecord;
  absorbed: AbsorbedItem[];
}

/** All working-set records for a run (persisted or not), oldest first. */
export function readRunItems(db: StateDb, runId: string): RawRecord[] {
  const rows = db
    .prepare("SELECT payload_json FROM items_run WHERE run_id = ? ORDER BY rowid")
    .all(runId) as { payload_json: string }[];
  // Zod strips the _absorbed sidecar (unknown keys); absorbed hashes are
  // already in seen_items by the time rows are persisted.
  return rows.map((row) => RawTrendRecord.parse(JSON.parse(row.payload_json) as unknown));
}

/** Persisted working-set records for a whole date (re-sort input), oldest first. */
export function readRunItemsByDate(db: StateDb, runDate: string): RawRecord[] {
  const rows = db
    .prepare("SELECT payload_json FROM items_run WHERE run_date = ? AND persisted = 1 ORDER BY rowid")
    .all(runDate) as { payload_json: string }[];
  return rows.map((row) => RawTrendRecord.parse(JSON.parse(row.payload_json) as unknown));
}

/** Pending rows for a run (persisted=0), oldest first; sidecar stripped. */
export function readPendingRunItems(db: StateDb, runId: string): PendingItem[] {
  const rows = db
    .prepare("SELECT payload_json FROM items_run WHERE run_id = ? AND persisted = 0 ORDER BY rowid")
    .all(runId) as { payload_json: string }[];
  return rows.map((row) => {
    const stored = JSON.parse(row.payload_json) as StoredPayload;
    const { [ABSORBED_KEY]: absorbed, ...rest } = stored;
    return {
      record: RawTrendRecord.parse(rest),
      absorbed: Array.isArray(absorbed) ? absorbed : [],
    };
  });
}

export interface PersistResult {
  appended: number;
  recordedSeen: number;
}

/**
 * Append pending rows to `raw_trends`, then mark persisted + record seen
 * (one SQLite transaction, only after the sheet write succeeds). Throws on
 * sheets failure with pending rows and seen_items untouched.
 *
 * Idempotent: rows from a previous partial append already carry this
 * run_id, so only missing ids are appended — retrying a crashed persist
 * never duplicates rows. A missing tab reads as empty (the append below
 * auto-inits, same as before).
 */
export async function persistRawItems(
  db: StateDb,
  repo: SheetsRepo,
  runId: string,
  runDate: string,
): Promise<PersistResult> {
  const pending = readPendingRunItems(db, runId);
  if (pending.length === 0) return { appended: 0, recordedSeen: 0 };
  const present = await presentRawIds(repo, runId);
  const missing = pending.filter((entry) => !present.has(entry.record.id));
  if (missing.length > 0) {
    await repo.appendRaw(missing.map((entry) => entry.record));
  }

  const seenEntries: { content_hash: string; source: SourceKey }[] = [];
  for (const entry of pending) {
    seenEntries.push({ content_hash: entry.record.content_hash, source: entry.record.source });
    for (const item of entry.absorbed) {
      seenEntries.push({ content_hash: item.content_hash, source: item.source });
    }
  }
  const mark = db.prepare("UPDATE items_run SET persisted = 1 WHERE run_id = ? AND persisted = 0");
  const upsert = db.prepare(SEEN_UPSERT_SQL);
  // Same transaction: a crash between "marked persisted" and "seen recorded"
  // would resurrect the items tomorrow, so both land atomically.
  const unique = uniqueSeenEntries(seenEntries);
  const write = db.transaction(() => {
    mark.run(runId);
    for (const [content_hash, source] of unique) {
      upsert.run(content_hash, runDate, runDate, source);
    }
  });
  write();
  return { appended: missing.length, recordedSeen: unique.size };
}

/** Ids this run already placed in raw_trends (empty when the tab is fresh). */
async function presentRawIds(repo: SheetsRepo, runId: string): Promise<Set<string>> {
  try {
    const existing = await repo.readRaw({ runId });
    return new Set(existing.rows.map((row) => row.id));
  } catch (error) {
    if (!isMissingRangeError(error)) throw error;
    return new Set();
  }
}
