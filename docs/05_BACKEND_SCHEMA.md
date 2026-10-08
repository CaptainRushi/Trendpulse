# 05 — Backend Schema

Three layers: **Google Sheets** (content), **SQLite** (operational state), **REST API** (dashboard contract).

---

## 1. Google Sheets tabs

Row 1 is a frozen header. All timestamps ISO-8601 UTC (`2026-09-30T06:02:11Z`). Arrays are stored as JSON strings. Text cells capped at 2,000 chars unless noted.

### 1.1 `raw_trends` (append-only)

| Col | Header | Type | Notes |
|-----|--------|------|-------|
| A | `id` | string | ULID |
| B | `run_id` | string | ULID |
| C | `collected_at` | datetime | |
| D | `source` | enum | `hackernews, reddit, google_trends, github, wikipedia, rss, webpage, youtube, producthunt, devto` |
| E | `source_item_id` | string | id in the source, if any |
| F | `url` | string | canonical |
| G | `title` | string | ≤ 300 |
| H | `snippet` | string | ≤ 500 |
| I | `author` | string | |
| J | `published_at` | datetime | nullable |
| K | `engagement_score` | number | primary raw number (points, upvotes, views) |
| L | `engagement_json` | string | e.g. `{"comments":210,"forks":12}` |
| M | `engagement_norm` | number | 0–1 |
| N | `language` | string | ISO 639-1 |
| O | `region` | string | |
| P | `content_hash` | string | sha1 |
| Q | `merged_sources` | string | JSON array of other sources merged in dedupe |
| R | `extraction_model` | string | filled only when LLM extraction used |
| S | `source_label` | string | human label for the source (feed name, subreddit) |
| T | `target_category` | string | category whose source found the item (Doc 19); null = general |

### 1.2 `sorted_trends` (append-only, latest set flagged)

| Col | Header | Type | Notes |
|-----|--------|------|-------|
| A | `topic_id` | string | ULID |
| B | `run_id` | string | |
| C | `run_date` | date | `YYYY-MM-DD` in app timezone |
| D | `rank` | integer | rank within the category set (1 = best, 1..n) |
| E | `title` | string | ≤ 140 |
| F | `summary` | string | ≤ 280 |
| G | `category` | enum | Tech, AI, Business, Finance, Science, Health, Politics, World, Sports, Entertainment, Culture, Gaming, Lifestyle, Other |
| H | `tags` | string | JSON array ≤ 6 |
| I | `trend_score` | integer | 0–100 |
| J | `score_engagement` | number | E, 0–1 |
| K | `score_diversity` | number | S, 0–1 |
| L | `score_relevance` | number | R, 0–1 |
| M | `score_novelty` | number | N, 0–1 |
| N | `momentum` | enum | `new, rising, peak, steady, fading` |
| O | `sentiment` | enum | `positive, neutral, negative, mixed` |
| P | `why_trending` | string | ≤ 200 |
| Q | `content_angles` | string | JSON array of 3 |
| R | `evidence_item_ids` | string | JSON array of `raw_trends.id`, ≤ 50,000 chars |
| S | `source_count` | integer | distinct sources |
| T | `top_urls` | string | JSON array ≤ 5 |
| U | `jev_model` | string | |
| V | `prompt_version` | string | e.g. `v1` |
| W | `sorted_at` | datetime | |
| X | `is_latest` | boolean | `TRUE` for the newest set of that (`run_date`, category) |
| Y | `hidden` | boolean | user can set TRUE in the sheet to hide on dashboard |
| Z | `scope` | string | legacy Doc-17 column, unused (old scoped rows read as `legacy` and never join a category set) |

When a set is (re-)sorted, the app appends the new rows, then flips `is_latest` of older rows with the same date **and category** to `FALSE` with one `batchUpdate` (the only update the app performs, done by scanning `run_date` + `category` + `is_latest` columns, not by remembered row numbers). Refreshing one category replaces only that category's set.

### 1.3 `daily_digest`

| Col | Header | Notes |
|-----|--------|-------|
| A | `run_date` | |
| B | `run_id` | |
| C | `digest` | 3–5 sentences from Jev |
| D | `top_topic_id` | |
| E | `topics_count` | |
| F | `items_count` | |
| G | `sources_ok` | integer |
| H | `sources_total` | integer |
| I | `top_categories` | JSON array of `{category,count}` |
| J | `created_at` | |
| K | `is_latest` | boolean |

### 1.4 `runs_log`

`run_id, started_at, finished_at, trigger (cron|manual|catchup), status, stages_json, source_stats_json, items_collected, items_new, topics_count, llm_calls, tokens_in, tokens_out, errors_json, app_version, categories` (categories = the run's selected slugs; Doc 19).

### 1.5 `archive_YYYY_MM`
Same columns as `raw_trends`. Created on demand by retention.

---

## 2. SQLite (`data/state.db`)

WAL mode, foreign keys on. Migrations in `server/src/db/migrations/NNN_name.sql`, applied at boot, tracked in `schema_migrations`.

```sql
-- 001_init.sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
```

Default `settings` keys: `setup_complete`, `setup_step`, `timezone`, `schedule_cron`, `run_missed_on_start`, `niches` (array), `trends_geo`, `sheet_id`, `omniroute_base_url`, `omniroute_api_key*`, `omniroute_extract_model`, `jev_base_url`, `jev_api_key*`, `jev_model`, `score_weights`, `sort_batch_size`, `top_n`, `retention_days`, `retention_mode`, `dedupe_days`, `theme`, `dashboard_password_hash*` (`*` = secret). Env vars override settings; settings override defaults.

---

## 3. TypeScript / zod types

```ts
export const SourceKey = z.enum(['hackernews','reddit','google_trends','github','wikipedia','rss','webpage','youtube','producthunt','devto']);
export const Category = z.enum(['Tech','AI','Business','Finance','Science','Health','Politics','World','Sports','Entertainment','Culture','Gaming','Lifestyle','Other']);
export const Momentum = z.enum(['new','rising','peak','steady','fading']);
export const Sentiment = z.enum(['positive','neutral','negative','mixed']);

export const RawItem = z.object({
  id: z.string(), run_id: z.string(), collected_at: z.string().datetime(),
  source: SourceKey, source_item_id: z.string().nullable(),
  url: z.string().url(), title: z.string().min(1).max(300), snippet: z.string().max(500).default(''),
  author: z.string().nullable(), published_at: z.string().datetime().nullable(),
  engagement_score: z.number().nonnegative().nullable(),
  engagement: z.record(z.number()).default({}),
  engagement_norm: z.number().min(0).max(1),
  language: z.string().nullable(), region: z.string().nullable(),
  content_hash: z.string(), merged_sources: z.array(SourceKey).default([]),
  extraction_model: z.string().nullable(),
});

export const JevTopic = z.object({
  title: z.string().max(140), summary: z.string().max(280),
  category: Category, tags: z.array(z.string()).max(6),
  relevance: z.number().int().min(0).max(100), novelty: z.number().int().min(0).max(100),
  momentum: Momentum, sentiment: Sentiment,
  why_trending: z.string().max(200),
  content_angles: z.array(z.string()).length(3),
  item_ids: z.array(z.string()).min(1),
});
export const JevMapOutput = z.object({
  topics: z.array(JevTopic),
  discarded: z.array(z.object({ item_id: z.string(), reason: z.string() })).default([]),
});

export const SortedTopic = JevTopic.extend({
  topic_id: z.string(), run_id: z.string(), run_date: z.string(), rank: z.number().int(),
  trend_score: z.number().int().min(0).max(100),
  score_parts: z.object({ engagement: z.number(), diversity: z.number(), relevance: z.number(), novelty: z.number() }),
  source_count: z.number().int(), top_urls: z.array(z.string().url()).max(5),
  jev_model: z.string(), prompt_version: z.string(), sorted_at: z.string().datetime(),
  is_latest: z.boolean(), hidden: z.boolean(),
});
```

---

## 4. REST API

Base `http://localhost:4317/api`. JSON in/out. Errors:

```json
{ "error": { "code": "SHEETS_FORBIDDEN", "message": "Google Sheets denied access.", "hint": "Share the sheet with bot@… as Editor." } }
```
Codes: `VALIDATION`, `NOT_FOUND`, `RUN_LOCKED` (409), `SHEETS_FORBIDDEN`, `SHEETS_NOT_FOUND`, `SHEETS_QUOTA`, `LLM_UNREACHABLE`, `LLM_INVALID_OUTPUT`, `SETUP_INCOMPLETE`, `UNAUTHORIZED`, `INTERNAL`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | `{ok, version, setup_complete, sheets:ok\|error, omniroute:ok\|error, jev:ok\|error, next_run_at, last_run}` |
| GET | `/trends` | Query: `date` (default today), `category[]`, `source[]`, `momentum[]`, `min_score`, `q`, `sort` (`score\|rank\|title`), `limit` (≤100), `offset`. Returns `{date, items:[SortedTopic], total, warnings, cache:{age_s}}` (excludes `hidden`, only `is_latest`) |
| GET | `/trends/:topic_id` | Topic + hydrated evidence items |
| GET | `/digest` | `?date=` → digest row |
| GET | `/raw` | Query: `date`, `source[]`, `status[]`, `q`, `limit`, `offset` |
| GET | `/dates` | Dates that have data (for date picker) |
| GET | `/sources` | Sources with config, health, requirements |
| PUT | `/sources/:key` | `{enabled?, item_limit?, config?}` |
| GET | `/runs` | List with pagination |
| GET | `/runs/:id` | Detail: stages, source stats, LLM usage totals |
| POST | `/runs` | Body `{stages?: ["collect","sort"], date?, sources?[]}` → `202 {run_id}` or `409 RUN_LOCKED` |
| POST | `/runs/:id/retry` | Resume from failed stage |
| GET | `/runs/:id/stream` | SSE events: `stage`, `source`, `progress`, `log`, `done`, `error` |
| GET | `/settings` | Masked secrets `{value:"••••", is_set:true}` |
| PUT | `/settings` | Partial update, hot reload |
| POST | `/setup/test-sheets` | `{sheet_id, service_account_json?}` → tabs found/created, service account email |
| POST | `/setup/test-omniroute` | `{base_url, api_key}` → model list |
| POST | `/setup/test-jev` | `{base_url?, api_key?, model}` → sample JSON reply + latency |
| POST | `/sheets/init` | Create missing tabs and headers |
| POST | `/sheets/sync` | Clear cache |
| GET | `/sheets/link` | `{spreadsheet_url, tabs:{raw_trends:url, sorted_trends:url}}` |
| GET | `/export/topics.csv` | Same filters as `/trends` |
| GET | `/export/topics.md` | Markdown for the day |

**SSE event example**
```
event: source
data: {"run_id":"01J…","source":"reddit","status":"ok","items":50,"duration_ms":1840}

event: progress
data: {"stage":"sort_map","done":2,"total":5}
```

---

## 5. Environment variables (`.env.example`)

```ini
# Server
PORT=4317
HOST=127.0.0.1
TZ=UTC
DASHBOARD_PASSWORD=
LOG_LEVEL=info
LOG_LLM_BODIES=false

# Schedule
SCHEDULE_CRON=0 6 * * *
RUN_MISSED_ON_START=true
AUTO_RESUME=false

# Google Sheets
GOOGLE_SERVICE_ACCOUNT_JSON_PATH=./secrets/service-account.json
GOOGLE_SHEET_ID=
SHEET_CACHE_TTL_S=60

# OmniRoute (extraction + optional Jev route)
OMNIROUTE_BASE_URL=http://localhost:20128/v1
OMNIROUTE_API_KEY=
OMNIROUTE_EXTRACT_MODEL=

# Jev (leave base URL empty to route through OmniRoute)
JEV_BASE_URL=
JEV_API_KEY=
JEV_MODEL=jev
LLM_CONCURRENCY=2
LLM_TIMEOUT_MS=90000

# Collection
TRENDS_GEO=US
NICHES=
MAX_ITEMS_PER_SOURCE=50
DEDUPE_DAYS=3
USER_AGENT=TrendPulse/1.0 (+local)
ENABLE_PLAYWRIGHT=false

# Source keys (optional)
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
GITHUB_TOKEN=
YOUTUBE_API_KEY=
PRODUCTHUNT_TOKEN=

# Sorting and data
SORT_BATCH_SIZE=30
TOP_N=50
RETENTION_DAYS=30
RETENTION_MODE=archive
```
