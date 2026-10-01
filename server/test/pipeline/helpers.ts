/** Shared builders for pipeline tests. */
import { RawItemDraft } from "../../src/collectors/types.js";
import type { RawItemDraft as Draft } from "../../src/collectors/types.js";
import { applyMigrations, openDatabase } from "../../src/db/sqlite.js";
import type { StateDb } from "../../src/db/sqlite.js";
import type { SourceKey } from "../../src/sheets/schema.js";

export interface DraftOverrides {
  source?: SourceKey;
  source_item_id?: string | null;
  url?: string;
  title?: string;
  snippet?: string;
  author?: string | null;
  published_at?: string | null;
  engagement_score?: number | null;
  engagement?: Record<string, number>;
  language?: string | null;
  region?: string | null;
  extraction_model?: string | null;
}

let counter = 0;

export function makeDraft(overrides: DraftOverrides = {}): Draft {
  counter += 1;
  return RawItemDraft.parse({
    source: "hackernews",
    url: `https://example.com/story-${String(counter)}`,
    title: `Example story ${String(counter)}`,
    ...overrides,
  });
}

export function openTestDb(): StateDb {
  const db = openDatabase(":memory:");
  applyMigrations(db);
  return db;
}

/** items_run.run_id REFERENCES runs(id) — mirror what the collect CLI does. */
export function insertRun(db: StateDb, runId: string, runDate: string): void {
  db.prepare(
    `INSERT INTO runs (id, run_date, trigger, status, stages_requested, started_at)
     VALUES (?, ?, 'manual', 'running', '["collect"]', ?)`,
  ).run(runId, runDate, new Date().toISOString());
}
