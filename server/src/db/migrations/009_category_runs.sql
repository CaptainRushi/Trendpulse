-- 009_category_runs.sql — Doc 17 S1: scope model + sort-event replay store.
ALTER TABLE runs ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'all';
ALTER TABLE runs ADD COLUMN focus_mode TEXT NOT NULL DEFAULT 'strict';
ALTER TABLE runs ADD COLUMN categories_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE items_run ADD COLUMN target_category TEXT;
ALTER TABLE topic_index ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'all';
CREATE TABLE IF NOT EXISTS sort_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
