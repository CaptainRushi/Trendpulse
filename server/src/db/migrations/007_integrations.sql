-- 007_integrations.sql — Composio call accounting for the monthly budget guard
-- (docs/15 §5). Additive: nothing here is read by the pipeline, only by the
-- budget check and the usage route.
CREATE TABLE IF NOT EXISTS integration_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_calls_created ON integration_calls (created_at);
CREATE INDEX IF NOT EXISTS idx_integration_calls_slug ON integration_calls (slug, status);
