/**
 * Rebuild seen_items from the sheet (TRD §9: recovery when SQLite is lost
 * but the sheet survives). Pure planner + merge-upsert; the script wires
 * the real Sheets client. Merge keeps the earliest first_seen and latest
 * last_seen per hash, so rebuilding over a live DB never narrows history.
 */
import type { StateDb } from "../db/sqlite.js";
import type { RawTrendRecord } from "../sheets/schema.js";
import type { SourceKey } from "../sheets/schema.js";

export interface SeenRebuildEntry {
  content_hash: string;
  first_seen_date: string;
  last_seen_date: string;
  source: SourceKey;
}

export function planSeenRebuild(records: RawTrendRecord[]): SeenRebuildEntry[] {
  const byHash = new Map<string, { first: string; last: string; source: SourceKey }>();
  for (const record of records) {
    const day = record.collected_at.slice(0, 10);
    const existing = byHash.get(record.content_hash);
    if (!existing) {
      byHash.set(record.content_hash, { first: day, last: day, source: record.source });
      continue;
    }
    if (day < existing.first) {
      existing.first = day;
      existing.source = record.source;
    }
    if (day > existing.last) existing.last = day;
  }
  return [...byHash.entries()].map(([content_hash, span]) => ({
    content_hash,
    first_seen_date: span.first,
    last_seen_date: span.last,
    source: span.source,
  }));
}

export function applySeenRebuild(
  db: StateDb,
  entries: SeenRebuildEntry[],
): { inserted: number; updated: number } {
  const known = new Set(
    (db.prepare("SELECT content_hash FROM seen_items").all() as { content_hash: string }[]).map(
      (row) => row.content_hash,
    ),
  );
  const upsert = db.prepare(
    `INSERT INTO seen_items (content_hash, first_seen_date, last_seen_date, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(content_hash) DO UPDATE SET
       first_seen_date = min(first_seen_date, excluded.first_seen_date),
       last_seen_date = max(last_seen_date, excluded.last_seen_date)`,
  );
  let inserted = 0;
  let updated = 0;
  const write = db.transaction(() => {
    for (const entry of entries) {
      if (known.has(entry.content_hash)) updated += 1;
      else {
        inserted += 1;
        known.add(entry.content_hash);
      }
      upsert.run(entry.content_hash, entry.first_seen_date, entry.last_seen_date, entry.source);
    }
  });
  write();
  return { inserted, updated };
}
