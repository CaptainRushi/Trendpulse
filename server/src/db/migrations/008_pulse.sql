-- 008_pulse.sql — live top-topic graph (Doc 16): topic index, samples, cycles.
CREATE TABLE IF NOT EXISTS topic_index (
  topic_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  run_date TEXT NOT NULL,
  rank INTEGER NOT NULL,
  title TEXT NOT NULL,
  score INTEGER NOT NULL,
  evidence_item_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_latest INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_topic_index_date ON topic_index (run_date, is_latest);

CREATE TABLE IF NOT EXISTS topic_samples (
  topic_id TEXT NOT NULL,
  sampled_at TEXT NOT NULL,
  index_value REAL NOT NULL,
  total REAL NOT NULL,
  items_sampled INTEGER NOT NULL,
  items_failed INTEGER NOT NULL,
  detail_json TEXT NOT NULL,
  PRIMARY KEY (topic_id, sampled_at)
);

CREATE TABLE IF NOT EXISTS pulse_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  topics INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  sampled INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok'
);
