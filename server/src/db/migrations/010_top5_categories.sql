-- 010_top5_categories.sql — Doc 19 Q1: per-category sets. Existing scoped
-- rows retire as legacy (their scope_key is never read again).
ALTER TABLE topic_index ADD COLUMN category TEXT NOT NULL DEFAULT 'legacy';
UPDATE topic_index SET category = 'legacy';
CREATE TABLE IF NOT EXISTS category_runs (
  run_id TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  items_collected INTEGER NOT NULL DEFAULT 0,
  items_kept INTEGER NOT NULL DEFAULT 0,
  topics INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  PRIMARY KEY (run_id, category)
);
-- One latest set per (run_date, category) is a code-maintained invariant, not
-- a UNIQUE index: a set holds up to TOP_PER_CATEGORY rows sharing
-- (run_date, category, is_latest = 1), which no row constraint can express.
-- The pipeline flips stale rows per category (sheets markLatest + SQLite
-- writeLatestSet); legacy scoped rows are excluded from category reads.
