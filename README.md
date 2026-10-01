# TrendPulse

Localhost daily trends collector + Jev sorter + Google Sheets store + dashboard.
Full quick start lands in Phase 9 — this file currently holds the API
contract (Phase 7 acceptance: this table stays in sync with `server/src/app.ts`).

Base `http://localhost:4317/api`. Errors: `{ error: { code, message, hint? } }`.
When `DASHBOARD_PASSWORD` is set, every route needs HTTP Basic with a matching
password (401 `UNAUTHORIZED` otherwise); unset = open localhost.

## Routes

| Method | Path | Purpose | Key params |
|--------|------|---------|-----------|
| GET | `/health` | Liveness + dependency states | — |
| GET | `/trends` | Ranked topics (latest set, hidden excluded) | `date`, `category[]`, `source[]`, `momentum[]`, `min_score`, `q`, `sort` (score\|rank\|title), `limit` ≤100, `offset` |
| GET | `/trends/:topic_id` | Topic + hydrated evidence items | — |
| GET | `/digest` | Daily digest row | `date` |
| GET | `/raw` | Raw items (`collected_at` UTC day for `date`, `sort_status` per row) | `date`, `source[]`, `status[]` (pending\|sorted\|discarded\|sort_failed), `q`, `limit` ≤500, `offset` |
| GET | `/dates` | Dates with data, newest first | — |
| GET | `/sources` | Sources with config, health, requirements | — |
| PUT | `/sources/:key` | Update a source | `{enabled?, item_limit?, config?}` (strict) |
| GET | `/runs` | Run list, newest first | `limit` ≤100, `offset` |
| GET | `/runs/:id` | Run + stages + source stats + LLM totals | — |
| POST | `/runs` | Start a run in background → `202 {run_id}` | `{stages?, date?, sources?[], limit?}`; busy → 409 `RUN_LOCKED` |
| POST | `/runs/:id/retry` | Resume a failed/interrupted run → `202` | `{from_stage?}` |
| GET | `/runs/:id/stream` | SSE: replay last 50 run events, then live + 15s heartbeat | — |
| GET | `/settings` | Effective settings (secrets masked) | — |
| PUT | `/settings` | Partial update (secrets rejected), hot-reloads schedule | flat `{key: value}` |
| POST | `/setup/test-sheets` | Check sheet access, no mutation | `{sheet_id?, service_account_json?}` |
| POST | `/setup/test-omniroute` | List gateway models | `{base_url, api_key?}` |
| POST | `/setup/test-jev` | Sample Jev completion | `{base_url?, api_key?, model}` |
| POST | `/sheets/init` | Create missing tabs + headers (idempotent) | — |
| POST | `/sheets/sync` | Clear the read cache | — |
| GET | `/sheets/link` | Spreadsheet + tab URLs | — |
| GET | `/export/topics.csv` | Same filters as `/trends`, CSV download | same as `/trends` |
| GET | `/export/topics.md` | Same filters as `/trends`, Markdown download | same as `/trends` |

Error codes: `VALIDATION` (400), `UNAUTHORIZED` (401), `NOT_FOUND` (404),
`SHEETS_NOT_FOUND` (404), `SHEETS_FORBIDDEN` (403), `RUN_LOCKED` (409),
`SHEETS_QUOTA` (429), `LLM_UNREACHABLE` / `LLM_INVALID_OUTPUT` (502),
`SETUP_INCOMPLETE` (400), `INTERNAL` (500).
