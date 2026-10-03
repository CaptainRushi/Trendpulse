# TrendPulse

Localhost daily trends collector + Jev sorter + Google Sheets store + dashboard.
Runs on your machine, reads the public web politely, and shows ranked topics
every morning. No accounts, no cloud, no tracking.

## 10-minute quick start

Prerequisites: **Node.js 20+** and **npm** (`node --version` should print v20 or newer),
plus a Google account (for the Sheet) and an OpenAI-compatible LLM endpoint
(OmniRoute, or anything that speaks `/chat/completions`).

```bash
git clone <repo> && cd trendpulse
npm install            # ~2-3 min, one-time
npm run setup          # interactive: writes .env, tests every connection
npm run dev            # API on :4317 + dashboard on :5173
```

Open **http://localhost:4317** (production single-port) or
**http://localhost:5173** (dev, hot reload). The setup wizard walks Google
Sheets → OmniRoute → Jev → sources, then fires the first collection.
`npm run doctor` re-checks every connection at any time.

Production instead of dev: `npm run build && npm start` (dashboard served
from the same :4317), or `docker compose up --build` (needs
`DASHBOARD_PASSWORD` in `.env` — the container binds 0.0.0.0 and refuses
to boot without it).

## Google service account walkthrough

The app writes to Google Sheets as itself — a service account — so your
Google login never touches the server.

1. Go to **console.cloud.google.com** → select (or create) a project.
2. **APIs & Services → Library** → search **Google Sheets API** → Enable.
3. **IAM & Admin → Service Accounts** → **Create service account** → any name → Create.
4. Open the account → **Keys** → **Add key → Create new key → JSON** → downloads a file.
5. Save it as `./secrets/service-account.json` (or paste it into `npm run setup`).
6. Copy the `client_email` from the file (looks like `bot@project.iam.gserviceaccount.com`).
7. Create a blank Google Sheet, click **Share**, paste that email, role **Editor**.
8. Paste the Sheet ID (the long string in the sheet URL) into setup when asked.
9. The wizard's **Test & create tabs** verifies access and creates
   `raw_trends`, `sorted_trends`, `daily_digest`, `runs_log`.

(No screenshots ship with this repo — the steps above name every console
surface exactly; the wizard's test button confirms each one live.)

## OmniRoute install

OmniRoute is a self-hosted LLM gateway (one OpenAI-compatible endpoint,
many providers, fallback). TrendPulse uses it for messy-page extraction
and optionally for Jev.

```bash
# Option A: separate service (see docker-compose.yml for the paired setup)
docker run -p 20128:20128 diegosouzapw/omniroute
```

> ⚠️ **Change OmniRoute's default admin password first.** A gateway with a
> default password on your network hands out your LLM keys to anyone who
> finds the port. Do this before adding provider keys.

Point setup at it: base URL `http://localhost:20128/v1`, your API key,
and the extract model id from its model list (the setup probe shows them —
pick one and paste it as the extract model).

No OmniRoute? Any OpenAI-compatible base URL works in the same field.

## Jev configuration examples

Jev is "a model id that clusters and scores" — configure where it runs:

- **Through OmniRoute (simplest):** leave `JEV_BASE_URL` empty, set
  `JEV_MODEL` to a model/combo id that exists inside OmniRoute (e.g. `jev`
  if you defined that combo, or any chat model id).
- **Direct endpoint:** `JEV_BASE_URL=https://api.example.com/v1`,
  `JEV_API_KEY=…`, `JEV_MODEL=<their model id>`.
- Verify with the wizard's **Test with sample** (or
  `POST /api/setup/test-jev`) — it runs a tiny JSON round-trip and reports
  latency.

## Cost notes

Jev charges per million input tokens read (answers are free):
`JEV_PRICE_PER_M_INPUT` (default `0.04`). Input is estimated as
characters ÷ 4 and logged per call in `llm_calls.cost_usd`. A full day
(~350 items) typically costs a few cents — live runs measured $0.000027
for 14 items.

`JEV_RUN_BUDGET_USD` (default `1.00`) caps classification spend per run:
exceeding it stops classification, marks the run `partial`, and leaves
the rest `pending`. The Today hero block shows today's spend from
`GET /api/jev/health`.

## Daily operation

- The scheduler runs `SCHEDULE_CRON` (default `0 6 * * *`) in `TZ`.
  Missed runs catch up on boot (`RUN_MISSED_ON_START`).
- **Today** shows the latest set + digest; **Runs** shows history, per-source
  stats and the live log; **Explore** compares dates; **Raw Data** is the
  full collection table; **Sources/Settings** tune everything without
  touching `.env` (except secrets, which stay env-side by design).
- Exports: per-day CSV/Markdown from Today, Raw Data, or
  `/api/export/topics.(csv|md)`.
- Retention (`RETENTION_DAYS`, `archive`/`delete`) prunes `raw_trends`
  after each run into `archive_YYYY_MM` tabs or away.

## Capacity (10M-cell Sheets cap)

Worst case per day: 7 sources × 50 items = 350 drafts → after dedupe,
~350 `raw_trends` rows × 18 cols ≈ 6,300 cells, plus ~1,250 (`sorted`),
11 (`digest`) and ~30 (`runs_log`). At the 30-day default retention the
live tabs hold ≈ 230k cells — about **2% of the 10M cap**, with 10× volume
still under a quarter. Note `archive` mode moves rows between tabs of the
*same* spreadsheet (keeps `raw_trends` readable, does not free cap space);
only `delete` frees cells. Per-cell content is capped at normalize time
(title 300, snippet 500 — far below the 50k cell limit).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `sheets tabs` FAIL 403 | Sheet not shared with the bot | Share with the service-account email as Editor, `npm run doctor` again |
| `sheets tabs` WARN no id | `GOOGLE_SHEET_ID` empty | `npm run setup`, paste the ID from the sheet URL |
| `omniroute /models` FAIL | Gateway down or wrong URL | Start OmniRoute / fix `OMNIROUTE_BASE_URL` |
| `jev sample` FAIL | Bad model id or key | Check `JEV_MODEL`, key, and the fallback gateway |
| Run stuck `running` | Process was killed mid-run | It resumes: `npm run pipeline -- retry <runId>` (boot marks it `interrupted`) |
| Wizard bounces back after Finish | Cached `setup_complete=false` | Fixed in app (health revalidates); hard-refresh if you see it |
| Dashboard empty after run | No items collected | Check Runs → per-source errors; sources may need keys/limits |
| Port in use | Another instance running | One pipeline lock per machine; stop the other process |
| `409 RUN_LOCKED` on trigger | A run is already going | Wait for it, or watch `/runs/:id/stream` |

## Scraping etiquette

Collectors identify with `USER_AGENT`, wait ≥1s per domain (Hacker News
item fetches excepted by its API norms), honor `robots.txt` for feeds and
pages (disallowed URLs are skipped with a log line, never fetched), retry
with backoff, and never send cookies, bypass paywalls/logins/captchas, or
touch non-public endpoints. If you add a source, keep it to official APIs
or RSS, add the fixture + contract test, and confirm the politeness path
before enabling it by default.

## Project layout

```
server/src/{collectors,pipeline,sorting,llm,sheets,api,scheduler,config,db,utils}
server/scripts/{setup,doctor,collect,run,rebuild-state}.ts
server/test/**                    # vitest, mirrors src
web/src/{pages,components,hooks,lib,wizard,styles}
web/e2e/**                        # Playwright (fake HTTP backends)
docs/                             # PRD → TRD → schema → plan pack
```

Key scripts: `dev` (both), `build`/`start` (prod single-port),
`test`/`test:web`/`test:e2e`, `lint`, `doctor`, `setup`, `collect`,
`pipeline`, `rebuild-state`.

## API

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
