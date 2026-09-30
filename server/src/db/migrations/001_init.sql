-- 001_init.sql — operational state only. Content lives in Google Sheets.
-- Sheets = user-visible source of truth; SQLite holds runs, checkpoints,
-- dedupe hashes, LLM call logs, settings, source config.
-- NOTE: schema_migrations is owned by the migration runner (sqlite.ts),
-- not by this file, so it is deliberately not created here.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sources (
  key TEXT PRIMARY KEY,                       -- hackernews, reddit, ...
  enabled INTEGER NOT NULL DEFAULT 1,
  item_limit INTEGER NOT NULL DEFAULT 50,
  config_json TEXT NOT NULL DEFAULT '{}',     -- subreddits, feed urls, page urls
  last_status TEXT,                           -- ok | error | skipped
  last_error TEXT,
  last_run_at TEXT,
  last_items INTEGER
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,                        -- ULID
  run_date TEXT NOT NULL,                     -- YYYY-MM-DD app tz
  trigger TEXT NOT NULL CHECK (trigger IN ('cron','manual','catchup')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','success','partial','failed','interrupted')),
  stages_requested TEXT NOT NULL,             -- JSON array
  started_at TEXT NOT NULL,
  finished_at TEXT,
  items_collected INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  topics_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_runs_date ON runs(run_date, started_at DESC);

CREATE TABLE run_stages (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,                        -- collect, normalize, dedupe, persist_raw, sort_map, sort_reduce, score, persist_sorted, finalize
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','skipped')),
  started_at TEXT, finished_at TEXT,
  detail_json TEXT,
  PRIMARY KEY (run_id, stage)
);

CREATE TABLE run_source_stats (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  status TEXT NOT NULL,                       -- ok | error | skipped
  items INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  PRIMARY KEY (run_id, source)
);

-- working set of normalized items for the run (enables resume and re-sort)
CREATE TABLE items_run (
  id TEXT PRIMARY KEY,                        -- same ULID as raw_trends.id
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_date TEXT NOT NULL,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,                 -- full normalized item
  persisted INTEGER NOT NULL DEFAULT 0,       -- written to raw_trends
  sort_status TEXT NOT NULL DEFAULT 'pending' CHECK (sort_status IN ('pending','sorted','discarded','sort_failed'))
);
CREATE INDEX idx_items_run_date ON items_run(run_date, sort_status);

CREATE TABLE seen_items (
  content_hash TEXT PRIMARY KEY,
  first_seen_date TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX idx_seen_last ON seen_items(last_seen_date);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  tag TEXT NOT NULL,                          -- extract | jev_map | jev_reduce | jev_digest | test
  client TEXT NOT NULL,                       -- extractor | jev
  model TEXT NOT NULL,
  status TEXT NOT NULL,                       -- ok | invalid | http_error | timeout
  http_status INTEGER,
  tokens_in INTEGER, tokens_out INTEGER,
  latency_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_llm_run ON llm_calls(run_id);

CREATE TABLE locks (
  name TEXT PRIMARY KEY,
  run_id TEXT,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE http_cache (                     -- ETag / Last-Modified for RSS and pages
  url TEXT PRIMARY KEY,
  etag TEXT, last_modified TEXT, fetched_at TEXT NOT NULL
);
