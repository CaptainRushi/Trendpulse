# Setup — TrendPulse local install

Me caveman. You want run TrendPulse. Follow steps. Done.

## Need first

- Node 22+ (`node --version` show v22+)
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
Wizard walk: Sheets → OmniRoute → Jev → sources → pick categories → fire first collect.
Recheck anytime: `npm run doctor`.

> Fresh DB has no categories — wizard Finish posts empty `/api/runs` and run
> dies `NO_CATEGORIES_SELECTED` (`server/src/pipeline/orchestrator.ts:310`).
> Before Finish: save at least one category via dashboard Settings or
> `PUT /api/settings {"my_categories": ["<slug>"]}`.

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

> Container `localhost` = itself. For paired OmniRoute: uncomment `omniroute`
> service in `docker-compose.yml`, set `OMNIROUTE_BASE_URL=http://omniroute:20128/v1`
> (service name, not localhost), then `docker compose up --build`.

## .env — copy then fill

```bash
cp .env.example .env
```

Must set:

- `PORT=4317`, `HOST=127.0.0.1`
- `DASHBOARD_PASSWORD=` — required for docker / non-loopback bind
- `GOOGLE_SERVICE_ACCOUNT_JSON_PATH=./secrets/service-account.json`
- `GOOGLE_SHEET_ID=` — long string from Sheet URL
- `OMNIROUTE_BASE_URL=http://localhost:20128/v1`, `OMNIROUTE_API_KEY=`, `OMNIROUTE_EXTRACT_MODEL=`, `OMNIROUTE_WRITER_MODEL=` (writer model required — empty = topic/digest gen fails, run marked partial; `OMNIROUTE_FALLBACK_MODEL=` optional)
- Jev direct only: `JEV_BASE_URL=https://api.typesafe.ai` (origin, no `/v1` — runtime appends `JEV_PATH=/v1/systemone`), `JEV_API_KEY=`, `JEV_MODEL=jev-latest`. Empty `JEV_BASE_URL` untested in pipeline (`sorterJev` posts relative `/v1/systemone`) — do not use.
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
9. Wizard **Test** checks access (lists tabs only — creates nothing), then run
   `POST /api/sheets/init` to make `raw_trends`, `sorted_trends`, `daily_digest`, `runs_log`

Fail 403 = not shared. No id = `GOOGLE_SHEET_ID` empty.

## OmniRoute hookup

```bash
docker run -p 20128:20128 diegosouzapw/omniroute
```

Then: change default admin password first (gateway with default password = leak keys).
Point setup at base URL + key + extract AND writer model ids (probe lists models — pick one each).
No OmniRoute? Any OpenAI-compatible base URL work same field.

## Jev hookup (direct only)

- `JEV_BASE_URL=https://api.typesafe.ai`, `JEV_API_KEY=…`, `JEV_MODEL=jev-latest`
- Keep `JEV_PATH=/v1/systemone` (runtime appends it — no `/v1` in base URL)
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
Killed run stuck `running`: retry refuses it (only `failed`/`interrupted` resume) —
restart server first (boot marks stale `running` → `interrupted`), then
`npm run pipeline -- retry <runId>`.
Busy trigger `409 RUN_LOCKED` = wait, or watch `/api/runs/:id/stream`.

## Layout (where things live)

```
server/src/{collectors,pipeline,sorting,llm,sheets,api,scheduler,config,db,utils}
server/scripts/{setup,doctor,collect,run,rebuild-state}.ts
web/src/{pages,components,hooks,lib,wizard,styles}
shared/  # zod schemas shared server+web
data/ secrets/  # never commit
```

Root `README.md` = full API table + troubleshooting. `CONTRIBUTING.md` = commit/test rules.
