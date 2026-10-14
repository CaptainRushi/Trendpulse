# Setup — TrendPulse local install

Me caveman. You want run TrendPulse. Follow steps. Done.

## Need first

- Node 20+ (`node --version` show v20+)
- npm (come with Node)
- git
- Google account (for Sheet store)
- LLM endpoint: OmniRoute `http://localhost:20128/v1` or any OpenAI-compatible `/chat/completions`

Ports: API `:4317`, dashboard dev `:5173`.

## Fast path (10 min)

```bash
git clone <repo> && cd trendpulse
npm install            # ~2-3 min, once
npm run setup          # interactive, writes .env, tests connections
npm run dev            # API :4317 + web :5173
```

Open `http://localhost:4317` (prod single-port) or `http://localhost:5173` (dev hot reload).
Wizard walk: Sheets → OmniRoute → Jev → sources → fire first collect.
Recheck anytime: `npm run doctor`.

## Prod path

```bash
npm run build && npm start
# dashboard served from same :4317
```

Docker:

```bash
# set DASHBOARD_PASSWORD in .env first — container bind 0.0.0.0, boot refuse without it
docker compose up --build
```

## .env — copy then fill

```bash
cp .env.example .env
```

Must set:

- `PORT=4317`, `HOST=127.0.0.1`
- `DASHBOARD_PASSWORD=` — required for docker / non-loopback bind
- `GOOGLE_SERVICE_ACCOUNT_JSON_PATH=./secrets/service-account.json`
- `GOOGLE_SHEET_ID=` — long string from Sheet URL
- `OMNIROUTE_BASE_URL=http://localhost:20128/v1`, `OMNIROUTE_API_KEY=`, `OMNIROUTE_EXTRACT_MODEL=`
- Jev: leave `JEV_BASE_URL` empty = route thru OmniRoute; or set direct URL + `JEV_API_KEY` + `JEV_MODEL=jev-latest`
- Optional source keys: `GITHUB_TOKEN`, `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID/SECRET`, `PRODUCTHUNT_TOKEN`

Full template with notes: see root `.env.example`.

## Google Sheet bot (5 min)

1. console.cloud.google.com → pick/create project
2. APIs & Services → Library → **Google Sheets API** → Enable
3. IAM & Admin → Service Accounts → Create (any name)
4. Open account → Keys → Add key → JSON → download
5. Save as `./secrets/service-account.json` (or paste into `npm run setup`)
6. Copy `client_email` from file (`bot@project.iam.gserviceaccount.com`)
7. New blank Sheet → Share → paste email → role **Editor**
8. Paste Sheet ID (URL middle string) into setup
9. Wizard **Test & create tabs** → makes `raw_trends`, `sorted_trends`, `daily_digest`, `runs_log`

Fail 403 = not shared. No id = `GOOGLE_SHEET_ID` empty.

## OmniRoute hookup

```bash
docker run -p 20128:20128 diegosouzapw/omniroute
```

Then: change default admin password first (gateway with default password = leak keys).
Point setup at base URL + key + extract model id (probe lists models — pick one).
No OmniRoute? Any OpenAI-compatible base URL work same field.

## Jev hookup

- Thru OmniRoute (easy): `JEV_BASE_URL` empty, `JEV_MODEL` = model/combo id inside OmniRoute
- Direct: `JEV_BASE_URL=https://api.example.com/v1`, `JEV_API_KEY=…`, `JEV_MODEL=<id>`
- Verify: wizard **Test with sample** or `POST /api/setup/test-jev`

Cost: input tokens only, chars ÷ 4 estimate. Cap per run: `JEV_RUN_BUDGET_USD=1.00`. Over budget = run `partial`, rest `pending`.

## Check health

```bash
npm run doctor     # every connection
npm run lint       # eslint server+web+shared
npm run typecheck  # tsc all workspaces
npm test           # server vitest
npm run test:web   # web vitest
```

Daily run: cron `SCHEDULE_CRON=0 6 * * *` in `TZ`. Missed catch-up: `RUN_MISSED_ON_START=true`.
Stuck `running` (killed mid-run): `npm run pipeline -- retry <runId>`.
Busy trigger `409 RUN_LOCKED` = wait, or watch `/runs/:id/stream`.

## Layout (where things live)

```
server/src/{collectors,pipeline,sorting,llm,sheets,api,scheduler,config,db,utils}
server/scripts/{setup,doctor,collect,run,rebuild-state}.ts
web/src/{pages,components,hooks,lib,wizard,styles}
shared/  # zod schemas shared server+web
data/ secrets/  # never commit
```

Root `README.md` = full API table + troubleshooting. `CONTRIBUTING.md` = commit/test rules.
