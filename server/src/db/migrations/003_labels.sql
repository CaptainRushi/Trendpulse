-- 003_labels.sql — Jev classification cache (docs/11 §3.5, Day-1).
-- Numbering gap allowed: 002_scraping arrives later (stretch S1/Day-2).
-- Runner applies unapplied files in numeric order even if 002 appears later.
CREATE TABLE IF NOT EXISTS item_labels (
  item_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  confidence REAL,
  model TEXT NOT NULL,
  question_set_version TEXT NOT NULL DEFAULT 'q1',
  classifier TEXT NOT NULL DEFAULT 'jev' CHECK (classifier IN ('jev', 'fallback')),
  cache_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_item_labels_item ON item_labels(item_id);
