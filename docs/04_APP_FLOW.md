# 04 — App Flow

## 1. First-run setup flow

```mermaid
flowchart TD
  A[Open localhost:4317] --> B{setup_complete?}
  B -- no --> W1[Wizard 1: Welcome]
  B -- yes --> T[Today page]
  W1 --> W2[Wizard 2: Google Sheets<br/>upload service account JSON + sheet URL]
  W2 --> W2T{Test: read sheet + create tabs}
  W2T -- fail --> W2E[Show exact error + fix hint] --> W2
  W2T -- ok --> W3[Wizard 3: OmniRoute<br/>base URL + key + extract model]
  W3 --> W3T{GET /models ok?}
  W3T -- fail --> W3E[Error: not reachable / 401] --> W3
  W3T -- ok --> W4[Wizard 4: Jev<br/>endpoint + model id]
  W4 --> W4T{Sample completion returns valid JSON?}
  W4T -- fail --> W4E[Show raw reply + hint] --> W4
  W4T -- ok --> W5[Wizard 5: sources, niches, schedule]
  W5 --> F[Save settings, mark setup_complete]
  F --> R[Run first collection]
  R --> T
```

Rules: each step saves on success; closing the browser resumes at the last incomplete step.

## 2. Daily automatic pipeline

```mermaid
sequenceDiagram
  autonumber
  participant Cron as Scheduler
  participant Orc as Orchestrator
  participant DB as SQLite
  participant Col as Collectors
  participant LLM as OmniRoute
  participant J as Jev
  participant GS as Google Sheets
  participant UI as Dashboard (SSE)

  Cron->>Orc: trigger(cron)
  Orc->>DB: acquire lock, create run (running)
  Orc->>UI: event stage=collect
  par each enabled source (limit 4)
    Orc->>Col: collect(source)
    Col-->>Orc: items + stats (or error)
    Orc->>UI: event source=done/error
  end
  Orc->>LLM: extract messy pages (webpage source only)
  Orc->>Orc: normalize, dedupe, engagement_norm
  Orc->>GS: append raw_trends (batched)
  Orc->>DB: mark hashes seen, checkpoint stage
  loop each batch of 30 raw items
    Orc->>J: map prompt
    J-->>Orc: topics JSON (validated)
  end
  Orc->>J: reduce prompt (merge across batches)
  Orc->>Orc: score + rank + top N
  Orc->>GS: append sorted_trends + daily_digest + runs_log
  Orc->>DB: run=success/partial, release lock
  Orc->>UI: event done
```

## 3. Manual run flow

1. User clicks **Run now** → `POST /api/runs {categories:["ai","finance"]}` (default: all `my_categories`; empty selection blocks with `NO_CATEGORIES_SELECTED`).
2. Server checks lock. If locked → 409, UI toast "A run is already in progress" with link to it.
3. Server returns `run_id`; UI opens SSE `/api/runs/:id/stream` and shows the status pill and Runs detail.
4. Live events update stage stepper and per-source table.
5. On `done`, UI invalidates queries; Today refetches; toast "48 topics ready".

**Variants**
- **Re-sort only:** re-runs the select + sort stages over that day's items. Old sorted rows for that date are kept; the newest set per (`run_date`, category) is flagged `is_latest=TRUE`.
- **Retry failed stage:** `POST /api/runs/:id/retry` resumes from first non-`done` stage.
- **Single source:** `POST /api/runs {sources:["reddit"]}` for testing.

## 4. Dashboard read flow

```mermaid
flowchart LR
  P[Page loads] --> Q[TanStack Query GET /api/trends?date=...]
  Q --> C{server cache fresh?<br/>TTL 60s}
  C -- yes --> R[Return cached rows]
  C -- no --> G[Sheets values.batchGet sorted_trends] --> N[Parse + validate rows] --> S[Store in cache] --> R
  R --> UI[Render cards]
  SYNC[Sync button] --> INV[POST /api/sheets/sync] --> C
```

Rows are filtered and sorted on the server (`date`, `is_latest=TRUE`, filters), paginated (`limit` 50, `offset`). Rows that fail validation (human edited a cell badly) are skipped and counted in the response `warnings`.

## 5. Settings change flow

Edit → **Test** (calls the matching `/api/setup/test-*`) → **Save** enabled only after test passes → `PUT /api/settings` → server hot-reloads clients (no restart). Schedule change reschedules cron immediately.

## 6. Error and recovery flows

| Situation | Detection | System behavior | User sees |
|-----------|-----------|-----------------|-----------|
| One source down | HTTP error / timeout / parse error | Retry 3×, mark source `error`, continue | Amber "partial" banner, source card red dot |
| All sources down | 0 items | Run `failed` at `collect` | Red banner: "No data collected. Check internet." **Retry** |
| Sheets 429 | HTTP 429 | Queue backoff, honor Retry-After | Progress pauses, log line |
| Sheets 403 | HTTP 403 | Run `failed` at persist, no seen_items written | Fix hint with service account email |
| OmniRoute unreachable | ECONNREFUSED | Extraction skipped for `webpage`; if Jev is on same host, sort stage fails and is resumable | Banner: "OmniRoute not reachable at …" |
| Jev invalid JSON | zod fails | Repair call → split batch → mark `sort_failed` | Partial run, **Re-sort only** available |
| Free model quota out | 429/402 from router | Backoff, then fail batch; OmniRoute combo may fail over | Log lines with model name |
| App crashed mid-run | stale lock heartbeat on next boot | Mark run `interrupted`, offer resume, auto-resume if `AUTO_RESUME=true` | "Previous run was interrupted. Resume?" |
| App off at schedule time | no success for today on boot | Run catch-up once | Toast "Running missed daily collection" |
| Sheet tab deleted | 400 range not found | Auto re-init tabs, retry once | Log line |
| Duplicate schedule overlap | lock held | Skip, log | Nothing (logged) |

## 7. Retention flow

Daily after run `finalize`: rows in `raw_trends` older than `RETENTION_DAYS` → copy to `archive_YYYY_MM` (mode `archive`) or delete (mode `delete`) in batches via `batchUpdate`. `sorted_trends` kept 90 days by default. Job logs counts to `runs_log`.

## 8. State machine — run status

```
queued → running → success
              ├──→ partial      (some sources or batches failed)
              ├──→ failed       (stage cannot proceed)
              └──→ interrupted  (crash or restart) → running (resume)
```
