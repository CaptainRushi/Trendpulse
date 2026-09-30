# 06 — Implementation Plan

Solo builder, AI coding agent assisted. Estimates are focused working days. Each phase ends with a **gate**: tests green, acceptance checks pass, commit tagged `phase-N`. Do not start the next phase before the gate passes.

**Total: ~16–20 days to MVP.**

---

## Phase 0 — Scaffold (1 day)

Tasks
- [ ] Init repo, `package.json` workspaces (`server`, `web`), TypeScript ESM, eslint, prettier, vitest.
- [ ] `.env.example`, `.gitignore` (`.env`, `secrets/`, `data/`, `node_modules/`, `dist/`).
- [ ] Config loader with zod (`server/src/config`), fail fast with readable errors.
- [ ] Fastify boot with `/api/health`, pino logger with redaction.
- [ ] SQLite bootstrap + migration runner + `001_init.sql` from `05_BACKEND_SCHEMA.md`.
- [ ] Scripts: `dev`, `build`, `start`, `test`, `lint`, `doctor` (stub), `setup` (stub).

Gate: `npm run dev` serves health JSON; migrations apply on empty DB; CI runs lint + test.

## Phase 1 — Google Sheets layer (2 days)

Tasks
- [ ] `sheets/auth.ts` service-account auth.
- [ ] `sheets/schema.ts` tab definitions and headers (single source of truth for columns).
- [ ] `sheets/repo.ts`: `init()`, `appendRaw()`, `appendSorted()`, `appendDigest()`, `appendRunLog()`, `readSorted(filters)`, `readRaw(filters)`, `markLatest(date, runId)`.
- [ ] `sheets/queue.ts` single writer, min gap, retry/backoff, 429 handling.
- [ ] Row ⇄ object mappers with zod validation; bad rows skipped with warnings.
- [ ] Read cache with TTL and invalidate.
- [ ] Interface `SheetsClient` so tests use a fake.

Acceptance
- Init is idempotent (run twice → no duplicate tabs/headers).
- Append 1,200 rows → 3 batched calls, order preserved.
- Simulated 429 → retried, succeeds.
- Deleted tab → auto re-init on next write.

## Phase 2 — LLM layer (1.5 days)

Tasks
- [ ] `llm/client.ts` OpenAI-compatible chat client (`fetch`), timeout, retry, `Retry-After`.
- [ ] `json()` helper: fence stripping, zod validation, repair call, error types.
- [ ] Two configured instances: `extractor`, `jev`. Fallback of Jev base URL to OmniRoute.
- [ ] `llm_calls` logging (tokens, latency, status).
- [ ] `/api/setup/test-omniroute` (GET models) and `/api/setup/test-jev` (tiny JSON sample).
- [ ] Fake LLM server for tests.

Acceptance: valid JSON, fenced JSON, trailing text, invalid JSON (→ repair), timeout, 429 with Retry-After all covered by tests.

## Phase 3 — Collectors (3 days)

Order: hackernews → google_trends → reddit → github → wikipedia → rss → webpage.

Per collector
- [ ] Implements `Collector`, returns normalized drafts + stats.
- [ ] Fixture-based contract test (recorded response in `test/fixtures/`).
- [ ] Timeout, retry, per-domain limiter, User-Agent.
- [ ] Clear `requires` list and doctor ping.

Shared
- [ ] `http.ts` client with limiter, ETag cache, robots.txt check (`utils/robots.ts`).
- [ ] `utils/url.ts` canonicalization; `utils/hash.ts`.
- [ ] `webpage`: Readability extract → OmniRoute extractor → `is_article` gate. Playwright fallback behind flag.

Acceptance: `npm run collect -- --source hackernews` prints normalized items; each collector isolated (throwing one does not stop others); robots-disallowed URL skipped with log.

## Phase 4 — Normalize and dedupe (1.5 days)

Tasks
- [ ] Snippet trimming, language detection, published date parse.
- [ ] Trigram Jaccard near-duplicate merge (threshold 0.85), keep max-engagement item, record `merged_sources`.
- [ ] `seen_items` cross-day dedupe (`DEDUPE_DAYS`), written only after sheet success.
- [ ] Per-source percentile `engagement_norm`, position fallback.
- [ ] `items_run` working set.

Acceptance: property tests (same URL with utm params → one item; reordered feeds → same hashes); re-running the same day adds 0 raw rows.

## Phase 5 — Jev sorter (3 days)

Tasks
- [ ] Prompt files under `llm/prompts/` with `PROMPT_VERSION`.
- [ ] `sorting/map.ts`: batch items, call Jev, validate, verify item ids exist, drop unknown ids, enforce one topic per item.
- [ ] Batch failure ladder: repair → split in half → `sort_failed`.
- [ ] `sorting/reduce.ts`: merge cross-batch duplicate topics (skip if only one batch).
- [ ] `sorting/score.ts`: formula from TRD §7, weights from settings, rank, top N.
- [ ] Digest generation (`jev_digest` call, 3–5 sentences from top topics only).
- [ ] Prompt-injection test set (items containing "ignore previous instructions") must not change output shape.
- [ ] Golden test with a fixed fake-Jev response producing an expected ranking.

Acceptance: 100 mixed items → ≤ N topics, every evidence id valid, no item in two topics, all scores 0–100, deterministic ranking for fixed input.

## Phase 6 — Orchestrator and scheduler (2 days)

Tasks
- [ ] `pipeline/orchestrator.ts` stage runner with checkpoints in `run_stages`.
- [ ] Resume, retry-stage, re-sort-only, single-source runs.
- [ ] Lock table with heartbeat; stale-lock recovery on boot.
- [ ] `scheduler/cron.ts` with `SCHEDULE_CRON` + `TZ`; missed-run catch-up.
- [ ] Event bus feeding SSE.
- [ ] Retention job (archive/delete) after finalize.
- [ ] `runs_log` row written to sheet.

Acceptance: kill process mid-`sort_map`, restart → run resumes, no duplicate raw rows, final topics match a clean run; two simultaneous triggers → one runs, one gets 409.

## Phase 7 — REST API (1.5 days)

Tasks
- [ ] All routes in `05_BACKEND_SCHEMA.md` §4 with zod request/response schemas.
- [ ] Error mapper to the error envelope.
- [ ] SSE with heartbeat and replay of last 50 events on connect.
- [ ] CSV and Markdown exports.
- [ ] Optional password protection.
- [ ] Route tests with `fastify.inject`.

Acceptance: OpenAPI-ish table in README stays in sync; every route has a happy-path and an error-path test.

## Phase 8 — Frontend (4 days)

Order: shell + theme → Today → Topic drawer → Runs (live SSE) → Sources → Settings → Raw Data → Explore → Wizard.

Tasks
- [ ] Tailwind config with tokens from `03_UI_UX_DESIGN.md`.
- [ ] API client + TanStack Query hooks, URL-synced filters.
- [ ] All states: loading, empty, error, partial, disconnected.
- [ ] Keyboard shortcuts and a11y pass (axe).
- [ ] Wizard with tests per step and resume.
- [ ] Responsive check at 375, 768, 1280 px.

Acceptance: Lighthouse a11y ≥ 95 on Today; all pages usable with keyboard only; Playwright e2e: fresh DB → wizard → run (fake backends) → topics visible.

## Phase 9 — Packaging and docs (1 day)

Tasks
- [ ] `npm run setup` interactive CLI (writes `.env`, tests connections).
- [ ] `npm run doctor` full diagnostics.
- [ ] `Dockerfile`, `docker-compose.yml`.
- [ ] README: 10-minute quick start, Google service account walkthrough with screenshots, OmniRoute install and its default-password warning, Jev configuration examples, troubleshooting table, scraping etiquette.
- [ ] `LICENSE`, `CONTRIBUTING.md`, `DECISIONS.md`.

Acceptance: a fresh machine (or clean container) reaches a working Today page in ≤ 10 minutes following only the README.

## Phase 10 — Hardening (1 day)

- [ ] 3-day soak with real cron on real sources.
- [ ] Review logs for secret leakage.
- [ ] `npm audit`, dependency pin.
- [ ] Sheet size projection: items/day × days vs 10M-cell cap documented.
- [ ] Fix top 5 papercuts found in the soak.

---

## Testing matrix

| Layer | Must-have tests |
|-------|-----------------|
| Unit | url canonicalize, hash, trigram dedupe, engagement_norm, score math, cron parse, zod schemas, json-repair |
| Contract | every collector against fixture |
| LLM | 8 output shapes (see Phase 2) + injection set |
| Sheets | batching, queue, retry, init idempotency, bad-row skip |
| Integration | full run with fakes; resume; re-sort; retention |
| API | every route happy + error; lock 409; masking of secrets |
| E2E | wizard → run → view → export |

## Definition of Done (MVP)

1. Clean machine, README only → working dashboard in ≤ 10 min.
2. Scheduled run at the configured time produces `raw_trends`, `sorted_trends`, `daily_digest`, `runs_log` rows without user action, 3 days in a row.
3. Killing the app mid-run and restarting completes the run with no duplicate rows.
4. One source made to fail → run `partial`, others complete, UI shows why.
5. Jev returning bad JSON → repaired or isolated, run never crashes.
6. Re-running the same day adds no duplicate raw items; re-sort produces a new latest set.
7. No secret appears in logs, API responses or browser storage.
8. `npm test` green, lint clean, e2e green.
9. Every requirement FR-1…FR-22 in the PRD maps to a passing test or a documented manual check.

## Risk register (build-time)

| Risk | Trigger | Response |
|------|---------|----------|
| Endpoint changes (Reddit, Trends RSS) | Contract test fails | Update fixture + parser, keep collector isolated |
| Jev output quality low | Many `sort_failed` or bad topics | Lower batch size to 15, add few-shot example to prompt, bump `PROMPT_VERSION` |
| Sheets quota pain | Many 429 | Increase min write gap, larger batches |
| Scope creep | New source ideas | Push to v1.1 list in PRD §10 |
