# DECISIONS.md — every conflict resolution and significant choice, newest last.

Spec priority on conflict: `05_BACKEND_SCHEMA.md` > `02_TRD.md` > `01_PRD.md` > `04_APP_FLOW.md` > `03_UI_UX_DESIGN.md`.

## 2026-09-30 — Phase 0 scaffold

- **Decision:** Previous `phase-0: scaffold` commit (0a45d96) contained docs + a broken `web/src/main.tsx` only — no `package.json`, no server code. Treat Phase 0 as not done and rebuild it fully.
- **Reason:** `git ls-tree` shows no buildable code; `main.tsx` imports `./App` and `./styles/index.css`, neither of which exists.
- **Decision:** npm workspaces (`server`, `web`), TypeScript ESM (`NodeNext`), `better-sqlite3` plain-SQL migrations, `zod` env validation, `pino` with broad redact list.
- **Reason:** Fixed stack in `02_TRD.md` §2; no alternative considered.
- **Decision:** Custom string→boolean env coercion instead of `z.coerce.boolean()`.
- **Reason:** `z.coerce.boolean()` maps `"false"` → `true` (non-empty string). Env vars are always strings, so `"false"` must parse to `false`.
- **Decision:** `createLogger` skips the `pino-pretty` transport when a destination stream is passed.
- **Reason:** pino forbids combining a transport with an explicit stream; tests pass a capture stream to assert redaction.
- **Decision:** Migration runner fails fast on version gaps (`expected N, found M`) instead of applying out of order.
- **Reason:** A gap means a migration file was lost or misnamed; half-ordered schema application corrupts `state.db` silently otherwise.

## 2026-09-30 — Phase 0 build fixes (found while turning the gate green)

- **Decision:** Removed the `CREATE TABLE schema_migrations` block from `001_init.sql`; the migration runner owns that table (`CREATE TABLE IF NOT EXISTS` + version tracking).
- **Reason:** Keeping it in both places made every first migration fail with "table schema_migrations already exists". Single owner, no ambiguity.
- **Decision:** `tsc` compiles `src|scripts|test` with `rootDir: .`; runtime entry is `dist/src/index.js`; `copy-assets.mjs` build step copies `*.sql` migrations into `dist/src/db/migrations`.
- **Reason:** tsc never copies `.sql`; without the copy step the packaged server finds no migrations. Narrowing `rootDir` to `src` instead broke type-aware eslint for `test/` + `scripts/`, so the unified project + explicit dist path won.
- **Decision:** `defaultDbPath()` anchors repo-root `data/state.db` from the module location (dev `server/src` → up 2; prod `server/dist/src` → up 3), overridable by `STATE_DB_PATH`.
- **Reason:** First boot wrote the DB to `server/data/` because the up-2 math assumed dev layout. `data/` stays gitignored in both cases.
- **Decision:** Broad pino redact list (each secret key at top level + 3 nesting depths) instead of `*.key` wildcards.
- **Reason:** `*.key` only matches one level deep — top-level config keys leaked in the first redaction test. Test now asserts leaked values are absent, not just that `[Redacted]` appears.

## 2026-09-30 — Phase 1 Sheets layer

- **Decision:** Hand-rolled `SheetsWriteQueue` (~90 lines, injectable clock/sleep) instead of adding `p-retry`/`p-limit` now.
- **Reason:** The queue needs gap-timing plus error-identity preservation (SheetsApiError must survive the queue for the auto-reinit branch) — manual code covers it and is deterministically testable. `p-retry`/`p-limit` remain in the fixed stack for Phase 3 (collector HTTP) and Phase 6 (orchestrator).
- **Decision:** Writes use `valueInputOption: RAW`; reads use `valueRenderOption: UNFORMATTED_VALUE`.
- **Reason:** RAW stores exactly what we send (no reinterpretation of "TRUE"/numbers); UNFORMATTED avoids locale-formatted numbers. Mappers still coerce every cell defensively.
- **Decision:** `init()` never overwrites a non-empty header row.
- **Reason:** A human may annotate headers; clobbering them would destroy user edits. Fresh/empty tabs get canonical headers; header-name verification (not position) guards `markLatest`.
- **Decision:** Empty JSON cell → caller default (`{}`/`[]`); non-empty invalid JSON → bad row skipped with warning.
- **Reason:** Humans blank cells by accident (absent, not broken); content that isn't JSON is genuinely corrupt. Uniform, documented in `mappers.ts`.
- **Decision:** Queue enriches `SheetsApiError` into a new `SheetsApiError` (status/code kept) instead of wrapping in plain `Error`.
- **Reason:** First implementation wrapped everything in `Error`, which hid `RANGE_NOT_FOUND` from the repo's deleted-tab auto-reinit. Identity must survive the queue.
- **Decision:** Reads exclude `hidden=TRUE` rows; `readSorted` defaults to `onlyLatest`; digest takes the last matching row.
- **Reason:** Matches dashboard semantics from `03_UI_UX_DESIGN.md` (hidden topics never shown) and append-only storage (latest set is physically last).
- **Decision:** Record-level filters stay minimal (`runId`/`runDate`); full category/source/search filtering is Phase 7 API work.
- **Reason:** Keep the storage layer to storage concerns.

## 2026-09-30 — Phase 2 LLM layer

- **Decision:** Always send `response_format: {type:"json_object"}` (TRD's "when supported" hedge not implemented).
- **Reason:** Our contract requires OpenAI-compatible endpoints (OmniRoute, Jev); a vendor without response_format is out of contract. Prompts still say "JSON only" as belt and braces.
- **Decision:** One `llm_calls` row per completed POST (initial + repair carry their own usage) plus one row for a terminal network failure; network retries are invisible in the log.
- **Reason:** Matches "token use logged per run" (usage sums correctly) without spamming a row per backoff retry.
- **Decision:** LLM_CONCURRENCY is enforced by callers (Phase 5 batch runner), not inside LlmClient.
- **Reason:** Probes and the digest call must never queue behind run traffic; the client stays dumb and the batch layer owns the semaphore.
- **Decision:** Unreadable-200 envelopes flow into the repair path (like invalid content), never the network-retry loop.
- **Reason:** A retry would likely return the same broken envelope; repair-or-throw is the honest path.
- **Decision:** Setup probes return HTTP 200 with `{ok:false, error}` instead of 4xx/5xx.
- **Reason:** Wizard-friendly: a failed probe is an expected outcome (bad key, service down), not a server error. Actionable copy per UI §8.
- **Decision:** Implemented the two `/api/setup/test-*` routes now (plan Phase 2 task) as thin probe wrappers; full route structure + error envelope stay Phase 7.
- **Reason:** Satisfies the phase task literally without pre-building Phase 7's machinery. Validation errors already use the VALIDATION envelope via the existing error handler.

## 2026-09-30 — Phase 3 Collectors

- **Decision:** Rate limiter is a per-domain timestamp gate (read-modify-set is atomic in single-threaded JS; overlapping in-flight requests allowed) with a per-request `gapMs` override, instead of a serializing slot pool.
- **Reason:** TRD §4 wants HN item fetches concurrent (8) while every other source stays polite (1s gap, cross-domain free). A slot pool that serializes a domain cannot express "no gap for this fetch"; `gapMs: 0` on HN item GETs + default 1000ms elsewhere does, with one shared limiter.
- **Decision:** Robots-disallowed requests return HTTP 403 + `robotsBlocked: true` (no throw); rss/webpage log a skip line and drop the URL. The gate applies only to user-supplied content URLs (feeds, pages) — API endpoints (HN, GitHub, Wikimedia, Trends, Reddit) are not robots-gated.
- **Reason:** The phase acceptance is "robots-disallowed URL skipped with log" — a flag + log is honest and testable, an exception would poison stats as `error`. API hosts publish no meaningful robots policy for JSON endpoints; UA + per-domain gaps cover their politeness.
- **Decision:** `parseRobots(body, userAgent)` takes the agent as a parameter (no global state).
- **Reason:** robots.txt groups are per-agent; the HttpClient passes its own `userAgent` so two clients with different agents can share a parsed body cache later.
- **Decision:** HTTP 304 (ETag hit) surfaces as `notModified: true`; the collector reports `status: "ok"` with 0 new items — never an error.
- **Reason:** An unchanged feed is the common case for frequent polling, not a failure; conditionals save bandwidth and the run summary should read "0 new" not "failed".
- **Decision:** Tests use hand-rolled fake fetch (`scriptedFetch`/`fakeFetch` with call recording) instead of adding `msw`.
- **Reason:** Collectors only need scripted responses + call assertions; a 1-dependency hand-roll is smaller, deterministic, and keeps the recorded-fixture contract tests dependency-free.
- **Decision:** Empty `sources` table → built-in defaults (enabled, `item_limit = MAX_ITEMS_PER_SOURCE`, config `{}`); `--all` respects `enabled`, an explicit `--source` always runs.
- **Reason:** The table is seeded in Phase 6, but the Phase 3 acceptance must work on a fresh checkout. Manual override beats a hidden enable flag when the user names a source explicitly. (Resolves Phase 2 gap 3: `sources.item_limit` → `MAX_ITEMS_PER_SOURCE` → `CollectContext.limit`.)
- **Decision:** `reddit_popular.json` fixture is constructed to the documented Listing/t3 schema (8 posts: 1 stickied, 1 over_18) — live Reddit returns 403 to unauthenticated collectors.
- **Reason:** Rule 13: never invent data silently — the fixture's provenance is stated here and in the test name (`constructed — live blocked`); doctor reports the live 403 as WARN.
- **Decision:** `CollectContext.llm` is non-optional; without `OMNIROUTE_API_KEY` the context gets a rejecting extractor, so webpage degrades to a per-page error stat.
- **Reason:** Every other collector ignores `llm`; making the field optional would spread null-checks across collectors for one source's credential gap.
- **Decision:** Webpage with every page failed → `status: "error"` (registry isolation still protects the run); doctor collector pings print WARN (not FAIL) and never change the exit code.
- **Reason:** "Collected nothing because everything failed" is an error worth surfacing in stats; but an unconfigured source is an expected state during setup, not a doctor failure.
- **Decision:** Wikimedia pageviews URL is `/all-access/yyyy/mm/dd` (verified live 200); the initially written `/all-access/yyyy-mm-dd/all` 404'd.
- **Reason:** Rule 1 fix found by the doctor ping — TRD's endpoint prose was ambiguous; the recorded fixture came from the correct shape, the code didn't.
- **Decision:** `npm run collect` root script forwards args with a trailing `--`.
- **Reason:** Without it npm eats `--source`/`--limit` as its own config flags before the workspace script sees them.

## 2026-10-01 — Phase 4 Normalize and dedupe

- **Decision:** Near-duplicate merge runs an exact content_hash pre-pass, then trigram Jaccard (≥ 0.85) on normalized titles — both passes in canonical order (engagement desc, then content/title/source, then full JSON), emission in input order.
- **Reason:** The exact pass catches same-canonical-URL pairs even when titles were edited (utm variants always land here). Canonical processing makes the keeper set a pure function of the input SET, so reordered feeds produce the same hashes; emission stays in feed order for stable sheet output. Full-JSON tail tiebreak keeps keeper choice total without input-position dependence.
- **Decision:** `seen_items` filtering runs BEFORE the near-merge, and absorbed hashes are recorded in `seen_items` alongside keepers.
- **Reason:** If an already-persisted story's hash is seen, its fresh cross-source twin (different hash) is still new coverage worth emitting — story-level novelty is Jev's job in Phase 5, not dedupe's. Conversely, without recording absorbed hashes, an absorbed URL would resurrect tomorrow and re-enter as "new".
- **Decision:** Absorbed hashes ride in `payload_json` under `_absorbed` (stripped on read, never sheet-bound) instead of a new migration/column.
- **Reason:** Transient data that dies the moment persist succeeds; a schema migration for it would outlive its purpose, while the sidecar is self-cleaning and keeps `payload_json` a pure RawTrendRecord for Phase 6 re-sort.
- **Decision:** `seen_items` writes happen ONLY after the sheet append succeeds; `persisted=1` + seen upsert share one SQLite transaction.
- **Reason:** TRD §6 stage 5 ordering — a crash between "marked persisted" and "seen recorded" would resurrect items tomorrow. Sheets failure leaves pending rows and empty seen, so retry/resume appends nothing twice.
- **Decision:** `engagement_norm` = mid-rank percentile among scored peers per source (ties share the average rank); unscored items — and scoreless sources — fall back to position `1 - pos/N`; lone items score 1.0.
- **Reason:** Percentile keeps one viral outlier from compressing everything else to ~0 (min-max would). Position fallback matches the TRD's RSS-rank intuition for scoreless feeds; mixing rule per item keeps partially-scored sources honest instead of zeroing unknowns.
- **Decision:** Language = valid provided ISO 639-1 if present, else script heuristic (≥30% share, Cyrillic reported as `ru`), else stopword scoring (≥2 hits + strict lead, 6 Latin languages), else null — never a guessed default, no new dependency.
- **Reason:** A wrong `en` default on (e.g.) a German title is false data; null is honest and the field is nullable downstream. Hand-rolled lists beat a dependency for 6 stopword sets + 9 script ranges.
- **Decision:** Title ≤ 300 / snippet ≤ 500 enforced in normalize (backend schema §3); HTML stripped, entities decoded; bad URLs and empty titles dropped with counts (never thrown).
- **Reason:** Sheets schema types are unbounded but the contract caps exist in §3 — enforce at the boundary where the data is shaped. Drops are stats, not errors, matching the repo's skip-with-warning philosophy.
- **Decision:** One `prepareRunItems` per runId (second call throws); `items_run` FK requires the `runs` row first (the collect CLI creates it).
- **Reason:** Fail-fast beats silent working-set doubling; the FK is the schema's way of saying a working set belongs to a real run. Test helper `insertRun` mirrors the CLI.
- **Decision:** `seen_items` upsert preserves `first_seen_date` + original `source`; cutoff is inclusive (`last_seen_date >= runDate - DEDUPE_DAYS` drops).
- **Reason:** First sighting is the novelty signal Phase 5/7 need; "seen in the last N days" reads naturally inclusive, and the boundary is now pinned by test.

## 2026-10-01 — Phase 5 Jev sorter

- **Decision:** Sorter talks to a minimal `JevJsonClient` interface (`json()` + `modelId`), which `LlmClient` satisfies structurally; tests use an in-process stub, no HTTP.
- **Reason:** Map/reduce/digest only need one method — depending on the whole client would drag HTTP, retry and timing into every sort test. The stub mirrors the real post-repair contract (invalid shape → `LlmValidationError`).
- **Decision:** Prompt-injection safety is enforced in code (`sanitizeMapTopics`: known ids only, emptied topics dropped, first claim wins), not by model obedience.
- **Reason:** A hostile item ("ignore previous instructions…") flows through the prompt as data; only structural validation can guarantee the output shape. The injection test set proves it with adversarial input against fixed replies.
- **Decision:** Batch ladder is repair (inside the client) → split in half once → `sort_failed` ids; single-item batches fail directly; non-validation errors (network/timeout) propagate.
- **Reason:** A retry would return the same bad JSON; one split isolates the poisoned half while the healthy half still sorts. Network errors are retried inside the client already — propagating them lets the orchestrator (Phase 6) mark the stage failed instead of mislabeling items.
- **Decision:** Reduce falls back to concatenated map topics (`reduced: false`) when its output stays invalid; skipped entirely for a single batch.
- **Reason:** Availability over purity — losing a cross-batch merge must not fail a run whose batches all sorted fine. The flag keeps the fallback observable in logs/stage detail.
- **Decision:** Momentum coerces to `new` (not `rising`) when all evidence is first seen today; unknown dates opt out of the check.
- **Reason:** All-new evidence is the data-supported claim and Jev never sees first-seen dates; coercing to `rising` would assert a trajectory with no evidence. Unknown dates can't verify → don't touch (spec's "can only be" applies to the verifiable case).
- **Decision:** Ranking tiebreaks never touch ULIDs or timestamps (score desc → title → summary → evidence JSON); `topic_id`/`sorted_at` assigned after ordering.
- **Reason:** Random ids would make "deterministic ranking for fixed input" untestable — order must be a pure function of content + scores.
- **Decision:** Digest covers the top 5 topics only; sentence count gets one targeted repair ("rewrite as exactly 4 sentences"), then a typed throw.
- **Reason:** The client's generic repair can't convey a count constraint, so a blind retry would likely return the same 6 sentences. One explicit rewrite rescues the common case; persistent violation fails the stage loudly instead of persisting a spec-breaking row.
- **Decision:** `LLM_CONCURRENCY` enforced in `mapAllBatches` via `p-limit` (default 2); weights/topN/batchSize are parameters with TRD defaults.
- **Reason:** Phase 2 assigned concurrency enforcement to the Phase 5 batch runner. No settings service exists yet, so score weights travel as arguments — Phase 6 wires `settings.score_weights`/`TOP_N`/`SORT_BATCH_SIZE` through.
- **Decision:** `firstSeenDates` passed into scoring as a map (itemId → date), not read from SQLite inside.
- **Reason:** Keeps scoring pure and unit-testable; the orchestrator owns the `seen_items` lookup. Absent map or unknown ids = no coercion, never a crash.
- **Decision:** `recordSeenItems` result counts distinct hashes; persist returns `{ appended, recordedSeen }` with the same meaning.
- **Reason:** Same-URL merges make entry counts exceed row counts (keeper + absorbed share one hash) — distinct counts keep `items_new`-style accounting truthful for Phase 6's runs row.

## 2026-10-01 — Phase 6 Orchestrator and scheduler

- **Decision:** normalize/dedupe/engagement_norm share one atomic checkpoint set — `prepareRunItems` performs all three in a single transaction.
- **Reason:** Finer checkpoints would add rows without adding resumability; a crash inside prepare rolls back to zero rows, so re-running it is always safe.
- **Decision:** Unexpected errors propagate with stage + run left `running` (kill semantics); only typed operational errors (Sheets/LLM) checkpoint `failed`.
- **Reason:** A kill -9 reaches no checkpoint by definition — treating unknown errors the same way makes crash-resume and code-bug-resume the identical, well-tested path instead of two mechanisms.
- **Decision:** No rewind at/before persist_raw once rows are persisted (loud error pointing at sort stages or a new run).
- **Reason:** Re-preparing would mint new ULIDs for stories the sheet already holds — silent duplication dressed as a retry. The guard turns it into a readable refusal.
- **Decision:** persist_raw, persist_sorted and finalize reconcile by run_id (append only missing ids; skip when present); `markLatest` skipped when the run has no topics.
- **Reason:** Retries after a mid-append crash must be idempotent — the run_id column exists exactly for this read-back. Skipping markLatest on empty sets keeps the previous day's latest set intact instead of crowning nothing.
- **Decision:** Digest failure skips the row (run goes partial), never fails the stage.
- **Reason:** Failing persist_sorted would force a retry that double-appends the sorted rows above; the digest is garnish and its absence is observable in stage detail.
- **Decision:** Retention archives before deleting, deletes per maximal aged run in descending index order, keeps undateable rows with a warning count, and is non-fatal (recorded in finalize detail).
- **Reason:** Copy-before-delete means a failed archive keeps the rows; descending multi-run deletes stay index-valid even with malformed rows interleaved. Janitorial work must never flip a successful run to failed.
- **Decision:** `SheetsClient.deleteRows` resolves the numeric sheetId inside the real client (title in, DeleteDimension out).
- **Reason:** Callers think in tab titles; only the API layer should know sheetIds exist. The fake mirrors it with a splice.
- **Decision:** Catch-up fires unless a successful run exists for today (TRD literal); skipped while interrupted runs are pending (autoResume owns those).
- **Reason:** Same-day re-runs add 0 raw rows by the seen filter and persist_sorted crowns nothing new when empty, so a redundant catch-up is wasteful but never corrupting — still, don't fire it when a resume will cover the day.
- **Decision:** Missing/unreadable service-account key is wrapped to `SheetsApiError` at repo construction → run `failed` with the actionable message, never stuck `running`.
- **Reason:** Found live on first boot: credential absence is operational, and a permanently-`running` row would confuse the Runs page and every later catch-up decision.
- **Decision:** `LockBusyError` carries the holder run_id (the Phase 7 409 body); boot marks all `running` runs interrupted and frees dead locks immediately.
- **Reason:** A retry minutes after a kill must not meet a 5-minute stale window for a process that is definitionally gone at boot. Two live servers at once is operator error (localhost runs one) — documented, not defended.
- **Decision:** Effective settings resolve env > settings rows > compiled defaults, with warnings (never throws) on malformed rows.
- **Reason:** A typo'd `score_weights` row must degrade to TRD §7 defaults with a log line, not fail a 6am cron run.
- **Decision:** Event bus keeps a 500-event history (module singleton `pipelineBus` as the Phase 7 rendezvous).
- **Reason:** Groundwork for the gap-4 SSE replay (50 events) — the buffer already exceeds it, so Phase 7 only adds the endpoint.

## 2026-10-01 — Phase 7 REST API

- **Decision:** Routes split into `api/` modules sharing one `AppContext`; Sheets/LLM clients stay lazy (per-request repo builds).
- **Reason:** Boot and health must never need credentials — the smoke test proved it: credential-less boot serves health while the catch-up run fails with an actionable message instead of crashing the server.
- **Decision:** POST /runs and retry answer 202 via synchronous-setup background variants (`startRunBackground`/`retryRunBackground`); `LockBusyError` throws synchronously so 409 lands before any 202.
- **Reason:** Awaiting a full run in the request would hit HTTP timeouts; fire-and-forget without the sync lock check could never reliably return 409. The same methods back the CLI/tests with identical semantics.
- **Decision:** New `RunNotFoundError` (404) / `RunRequestError` (400) in the orchestrator, mapped centrally.
- **Reason:** Operator errors (bad id, wrong state, illegal rewind) previously surfaced as 500s. Typed at the source, they stay correct for every caller (API, CLI, future UI).
- **Decision:** SSE replays the run's last 50 events and closes immediately when the replay ends in done/error; otherwise live stream + 15s heartbeat.
- **Reason:** A late subscriber to a finished run gets everything then a clean close (also what makes the endpoint `inject`-testable); live runs hold the documented long connection.
- **Decision:** Password gate is HTTP Basic over all `/api` routes with timing-safe compare, 401 + `WWW-Authenticate`; unset password = open localhost.
- **Reason:** TRD §12 allows Basic or cookie — Basic needs no session store and browsers handle it natively. Gating everything (including health) keeps the rule auditable in one hook.
- **Decision:** `/raw` date filters on the `collected_at` UTC day; `status[]` joins `items_run.sort_status`.
- **Reason:** Raw sheet rows carry no run_date (app-tz lives in `runs`) — UTC-day filtering is the honest sheet-level semantic, documented in the README table. Status lives only in SQLite, so the join is the only correct source.
- **Decision:** Secrets are read-only metadata in the settings API (presence + `••••`); PUT rejects secrets/unknown keys/bad types; cron/timezone PUTs hot-restart the scheduler.
- **Reason:** Credential values live in the environment and must never round-trip through JSON. Hot-restart closes the loop on "hot reload" without a reboot for the two scheduler inputs.
- **Decision:** Health checks run guarded and parallel; Jev is a models-list, never an inference call; `next_run_at` is null.
- **Reason:** A 30s dashboard poll must not burn inference tokens. node-cron exposes no next-fire API, so null means "unknown" (documented) rather than a hand-rolled cron parser.
- **Decision:** Outgoing shapes validated with the existing record zod schemas; 500s logged server-side with bodies hidden.
- **Reason:** Response validation turns contract drift into loud logs instead of silent dashboard breakage; request/response both zod per the plan with (mostly) zero new schemas.
- **Decision:** Exports share the `/trends` loader; attachment disposition; CSV quoted per RFC.
- **Reason:** "Same filters as /trends" implemented as the same function, not a parallel implementation. XHR clients ignore the disposition; direct navigation downloads.
- **Decision:** `/sheets/link` returns the spreadsheet URL for both tabs (no gid lookup).
- **Reason:** The client interface never learns tab gids — resolving them would mean a metadata call per link request for anchor precision nobody needs.
- **Decision:** Added `SheetsRepo.ping()` (non-mutating liveness) and fixed `readRaw` to cache one shared unfiltered entry while adding `ageS`.
- **Reason:** Health must not create tabs as a side effect; the old per-filter cache keys each stored a full copy of the tab.
- **Decision:** Root `README.md` created with the API table only (full quick-start stays Phase 9).
- **Reason:** The phase acceptance demands the table "stays in sync" — it now exists to be kept current; everything else about the README belongs to packaging.

## 2026-10-01 — Phase 8 Frontend

- **Decision:** Hand-rolled CSS on the exact §4 token set; no Tailwind, no Recharts, no TanStack Table/Virtual.
- **Reason:** The token system is already fully specified as CSS variables, so Tailwind would add build risk for zero design gain. Score bars are divs (no chart lib needed); raw tables paginate server-side, which removes the virtualization requirement.
- **Decision:** Web imports are extensionless (`./x`, not `./x.js`).
- **Reason:** `.js` suffixes are a NodeNext-ism for the server; under the web's bundler resolution they don't resolve at all (found via traceResolution).
- **Decision:** `/raw` items carry `sort_status` (spec's status column, not just the filter).
- **Reason:** The §5.4 table needs the column; the join already existed for the filter, so exposing it per row was 15 lines + README note.
- **Decision:** Wizard finish revalidates `health` before navigating to the new run.
- **Reason:** Found by e2e: stale `setup_complete=false` bounced a finished user straight back to the wizard. Invalidating first makes the gate decide on fresh truth — a real UX bug, not a test artifact.
- **Decision:** Wizard persists non-secrets (sheet id, urls, models, sources, niches, schedule) and tests secrets inline without storing them.
- **Reason:** Credential values live in the environment by design; the settings API rightly rejects them. The wizard says so on screen instead of pretending to save them.
- **Decision:** `--brand-strong: #4f46e5` for text-bearing fills (buttons, pressed chips); `--brand` stays for rings/borders/focus.
- **Reason:** Axe measured white-on-`#6366f1` at 4.46:1 — just under AA. Same hue family, 6.36:1, minimal visual shift.
- **Decision:** Topic cards are plain articles with a real title-button (no `role="button"` wrapper); bare-surface clicks open via a closest() guard with stopPropagation on nested controls.
- **Reason:** Axe flagged `nested-interactive`, and the unit test caught the title click double-firing through the article handler. One opener each, keyboard path via the title button.
- **Decision:** Sidebar nav is "Primary", bottom tab bar is "Sections" (distinct accessible names).
- **Reason:** Two identically-named nav landmarks confuse screen-reader users — and untyped e2e locators.
- **Decision:** E2E fakes at the HTTP boundary (Playwright route interception); no live server needed.
- **Reason:** Real backend behavior is already proven server-side (323 tests); e2e proves the frontend flow wizard → run → topics, including a statically-fulfilled SSE stream. The one exception: unmocked URLs hit the dead proxy loudly, which doubles as a missing-mock detector.

## 2026-10-01 — Phase 9 Packaging and docs

- **Decision:** Setup CLI is TTY-only, preserves `.env` comments/unknown keys in place, tests every connection live, and never prints secrets (retype-to-replace, 0600 on pasted key files).
- **Reason:** A setup tool that clobbers hand-edits or leaks keys to scrollback would be worse than none. Non-TTY refuses loudly instead of half-running. Pure file logic (`envFile.ts`) is unit-tested; the prompts are verified by reading, not by faking stdin.
- **Decision:** Doctor splits WARN (not configured — run setup) from FAIL (configured but broken) and never leaks key material.
- **Reason:** A fresh checkout should report "3 things to configure", not 3 cryptic failures; a broken key must fail with the share/URL/key fix attached. Exit code stays meaningful for scripts.
- **Decision:** Single-port prod via `@fastify/static` + SPA fallback only for non-`/api` paths; `buildApp` went async.
- **Reason:** TRD §2 mandates one port. Gating the fallback on `/api/` keeps API 404s JSON while `/runs/...` serves the app. Async factory was the honest signature for plugin loading; the ~10 test call sites took `await`.
- **Decision:** Debian-slim multi-stage Dockerfile (prebuilds, no toolchain); compose binds 0.0.0.0 with `DASHBOARD_PASSWORD` effectively mandatory; OmniRoute block ships commented.
- **Reason:** Alpine/musl adds prebuild risk for zero size benefit here. An uncommented gateway service with an unvalidated image name would break `compose up` — the commented block documents the topology without asserting what wasn't verified (no docker daemon in this env to prove the build).
- **Decision:** No screenshots in the SA walkthrough — exact console click-paths instead.
- **Reason:** No GCP access in the build environment to capture real ones; precise paths plus the wizard's live test button are verifiable, stock photos would not be.
- **Decision:** MIT with a `contributors` holder; CI gains build + web tests + e2e job.
- **Reason:** No individual owner was ever named; contributors-holder is the honest default. CI previously ignored web entirely — the e2e job installs browsers itself so fresh runners work.
- **Decision:** Live sort attempted during verification (real HN/Wikipedia → Jev, no sheet writes); blocked on a dead third-party gateway, run failed correctly.
- **Reason:** Worth trying with the pieces present: collect→normalize succeeded on live data and `sort_map` failed with an actionable connection error instead of crashing — which is itself the designed behavior. Live LLM output quality remains unproven until credentials + a stable gateway exist (Phase 10 soak).

## 2026-10-01 — Phase 10 Hardening

- **Decision:** Upgraded node-cron 3 → 4 (fixes the only `npm audit` findings, uuid bounds-check) after verifying schedule/validate/fire/getNextRun semantics + full scheduler suite green.
- **Reason:** The vuln is barely reachable locally (uuid ids for internal tasks), but a clean audit with a behavior-preserving major is strictly better. Bonus: v4's `getNextRun()` closed the Phase 7 `next_run_at: null` limitation — health now reports the real next fire time.
- **Decision:** Kept `^` ranges + committed lockfile instead of pinning exact versions.
- **Reason:** The lockfile + `npm ci` already makes installs byte-reproducible; hand-editing ~20 specifiers adds churn without adding determinism.
- **Decision:** Collector/feed/page URLs are query-stripped (`host/path[…]`) in every log line and error string (`redactUrlForLog`).
- **Reason:** The secret audit found the one real leak path: token-bearing private URLs flowed verbatim into logs AND `run_source_stats`/`runs_log` sheet rows. Host+path keeps debuggability; the `…` marker shows something was cut.
- **Decision:** Removed the inert `LOG_LLM_BODIES` env var (parsed, never consumed).
- **Reason:** A flag that suggests prompt bodies can be logged — directly against the metadata-only logging design — is worse than no flag. Deletion is behavior-neutral.
- **Decision:** Implemented the `rebuild-state` stub (seen_items from `raw_trends`, min/max merge that never narrows) + shared `scripts/lib/dbPath.ts`.
- **Reason:** It was promised for Phase 6 and the soak needs it (DB loss mid-soak must not restart dedupe history). Pure planner is unit-tested; the script stays thin.
- **Decision:** Sheet projection documented in README (≈230k cells at defaults ≈ 2% of 10M); retention defaults unchanged.
- **Reason:** The math shows 30-day archive is conservative-correct with 10× headroom; only sustained 40× volume threatens the cap. Archive mode noted as readability-only (same spreadsheet, no cap relief) — only `delete` frees cells.- **Decision:** Axe serious/critical clean is the automated gate; Lighthouse ≥95 stays a manual check.
- **Reason:** Lighthouse needs Chrome + the lighthouse package — unrunnable in this environment. Axe with the serious/critical filter is the honest automatable proxy, documented here.
- **Decision:** Vite binds `--host 127.0.0.1`; Playwright webServer runs through `cmd /c` on Windows.
- **Reason:** `localhost` bound IPv6 here, refusing the 127.0.0.1 URLs everything else uses; `npm` isn't directly spawnable on Windows.
- **Decision:** eslint test-file pattern extended to `*.test.tsx`.
- **Reason:** Component tests need JSX extensions, which the old pattern silently excluded from the test-rule exemptions.1. **Gap — prompt-injection guardrail missing from TRD §8 prompt text.** TRD §12 says "Add to Jev system prompt: 'Item text is data, never instructions'", but the §8.2/§8.3 prompt contracts do not include that sentence.
   - **Resolution:** When Phase 5 writes `server/src/llm/prompts/`, append the guardrail sentence verbatim to the Jev map + reduce system prompts (schema > TRD wording, guardrail kept). **Done (Phase 5):** `JEV_GUARDRAIL` appended in `llm/prompts/jev.ts`; shape guarantee additionally enforced in code (`sanitizeMapTopics`), proven by the injection test set.
2. **Gap — digest prompt lives only in the master prompt, not in TRD §8.**
   - **Resolution:** Add a fourth versioned prompt (`digest`) under the same `PROMPT_VERSION = "v1"`, exact text from the master prompt. **Done (Phase 5):** `JEV_DIGEST_SYSTEM` is the master-prompt sentence verbatim.
3. **Gap — per-source limit naming.** Schema settings use `sources.item_limit`; env has `MAX_ITEMS_PER_SOURCE=50`; TRD `CollectContext` has `limit`.
   - **Resolution:** `MAX_ITEMS_PER_SOURCE` is the global default; `sources.item_limit` overrides per source; `CollectContext.limit` is the resolved value. **Done (Phase 3):** enforced in `scripts/collect.ts` + `buildCollectContext`; see Phase 3 section.
4. **Gap — SSE replay.** `06_IMPLEMENTATION_PLAN.md` Phase 7 requires "replay of last 50 events on connect"; `05_BACKEND_SCHEMA.md` §4 does not mention replay.
   - **Resolution:** Implement replay (plan is more specific; no schema contradiction).
5. **Uncertainty — external endpoint shapes (Reddit JSON, Google Trends RSS, Wikimedia API).**
    - **Resolution (per non-negotiable rule 13):** Each Phase-3 collector is written against a recorded fixture in `server/test/fixtures/`, with a tolerant parser + `doctor` ping. No endpoint shape is guessed beyond the fixture.

## 2026-10-02 — Day-1 deviations (docs/12 section 1, Prompt 0 kickoff, no app code yet)

- **Deviation:** Plain CSS with design tokens instead of Tailwind.
- **Reason:** CLAUDE.md stack + docs/11 section 4 define the full token set (paper `#F5F5F0`, lime `#DCEB63`, forest `#14291D`, Geist/Mono, 4px radius, light only). Tailwind appears only in older docs; per priority CLAUDE.md + docs/11 win.
- **Deviation:** Migration `003_labels.sql` created now with numbering gaps allowed (`002_scraping` arrives later).
- **Reason:** Day-1 sorter needs `item_labels` now; scraper sidecar is stretch S1/Day-2. Runner must apply unapplied files in numeric order even if a lower number appears later (gap-tolerant, not fail-fast).
- **Deviation:** Resume = idempotent re-run (checkpoints plus `seen_items`).
- **Reason:** Full kill-resume drills (W-08, CH-01) come Day-2. Day-1 guarantee is only: re-running the same run id skips `done` stages, `persist_raw`/`persist_sorted` reconcile by run_id, `seen_items` written only after Sheets success, rerun adds ~0 raw rows.

## 2026-10-02 — Step 1 foundation (docs/12 Prompt 1)

- **Decision:** Created `shared/` workspace (`@trendpulse/shared`) with `src/domain.ts` (SourceKey 8 values, Category 14, Momentum without `fading`, ItemLabels/TopicText/WriterOutput, RawItem + `source_label`, SortedTopic) and `src/api.ts` (error envelope + Day-1 REST contract from docs/12 §7, `Day1Routes` for W-10). Root workspaces now `shared, server, web`.
- **Reason:** Step 1 requires the contract package for the frontend lane; server keeps its phase-built records (superset with youtube/producthunt/devto, `fading`) until the Jev rewire lands. INF-05 proves shared types parse in server context.
- **Decision:** Added 8 missing Day-1 env vars additively (`OMNIROUTE_WRITER_MODEL`, `OMNIROUTE_FALLBACK_MODEL`, `JEV_PATH`=/v1/systemone, `JEV_CONCURRENCY`=8, `JEV_PRICE_PER_M_INPUT`=0.04, `JEV_RUN_BUDGET_USD`=1.00, `JEV_FALLBACK`=true, `QUALITY_MIN`=0.5) + `.env.example` comments. Kept existing defaults (`JEV_BASE_URL` empty = via OmniRoute, `JEV_MODEL`=jev, `SORT_BATCH_SIZE`=30) instead of Step-1's direct/jev-latest/10.
- **Reason:** Changing live defaults would break the phase-built sorter, probes, setup CLI and their tests for zero Day-1 gain; empty-base via-OmniRoute is the documented local-dev path. Step-1 values remain reachable by explicit env.
- **Decision:** Migration runner is now gap-tolerant (numeric order, duplicates throw, gaps allowed); created `003_labels.sql` (`item_labels` per docs/11 §3.5, `IF NOT EXISTS`).
- **Reason:** Day-1 deviation logged at kickoff: 003 now, 002 later. Kept `http_cache` in 001 (Step-1 says skip it) — collectors already use it for RSS conditionals; removal would regress.
- **Decision:** Created root `verify/registry.ts` (types + empty registry + `exitCodeFor`); full 22-check fake board stays in `scripts/verify.ts`.
- **Reason:** Step-1 wants an empty registry with `verify-report.md`; the repo already has the grown board writing `verify-report.json` (Phase 0→10). Registry wiring + `--mode live` come in Step 10; INF-05 pins the exit-code rule.
- **Decision:** Added root `typecheck` script + `typecheck` in server/web/shared workspaces; root `lint` now covers shared.
- **Reason:** Step-1 root script list requires `typecheck`; previously missing.
- **Decision:** [Rule 1 - Bug] Fixed `scripts/verify.ts` F36 (Localhost bind + password): init fake tabs before the authenticated `/api/trends` check.
- **Reason:** Without init the authed call returned 404 `SHEETS_NOT_FOUND`, masking the password gate the check means to prove. F36 now inits via `SheetsRepo.init()`; F33 untouched (sync needs no tabs). Verify is 22/22 green.

## 2026-10-02 — Step 2 sheets layer (docs/12 Prompt 2, ponytail ultra)

- **Decision:** Added `source_label` col S: `RAW_TRENDS_HEADERS` 18→19, `RawTrendRecord.source_label` nullable, mappers write col 18 / read tolerant of legacy 18-col rows (missing→null). `persist.toRecord` + test literals set null.
- **Reason:** Step-2 task 1 columns are exact (A..S, S = source_label); collectors fill labels later (Phase 3B recipe work). Tolerant read keeps old sheets parseable.
- **Decision:** 2000-char cap via one `capCells` map over every `*RecordToRow` output (SHT-14).
- **Reason:** Spec cap lives in one place, not per-field branches.
- **Decision:** New `server/scripts/sheets-init.ts` + `sheets:init` script: prints SA email + tab list on success; names each missing piece (exit 1) without creds.
- **Reason:** Step-2 task 8. No-creds run verified: reports `GOOGLE_SHEET_ID` + key path missing.
- **Decision:** New `server/test/sheets/sht-step2.test.ts` (14 ID-titled tests: SHT-01/02/03/04/05/06/07/08/09/10/14/16, W-01/W-02). Existing descriptive suites untouched.
- **Reason:** CLAUDE.md rule 9 IDs pin the Day-1 contract; history renames add churn, not coverage.
- **Decision:** 403 hint stays generic (`Share the sheet with the service-account email as Editor`); concrete address surfaces in `sheets:init` output + `test-sheets` response.
- **Reason:** `mapError` has no key-file access; threading the email through the error path ripples for zero operator gain. SHT-05 pins code + no-retry.
- **Decision:** Plain `.nullable()` (not `.default(null)`) for `source_label`.
- **Reason:** `.default()` + `exactOptionalPropertyTypes` broke `parseWith` inference; explicit null at 5 sites is dumber and green.

## 2026-10-02 — Step 3 llm + jev (docs/12 Prompt 3, ponytail full)

- **Decision:** New `server/src/llm/jev.ts`: SystemOne typed client exactly per CLAUDE.md (`{model, state, questions}` → typed `answers`). State capped at 4000 chars (equal per-key share); unknown `choice` → `none` + `choice_coerced`; missing answer → `label_missing` (choice `none`/0, noul 0); 429/5xx retry w/ Retry-After; semaphore at JEV_CONCURRENCY; input priced chars/4 at JEV_PRICE_PER_M_INPUT (answers free); budget breach throws `JevBudgetExceeded` (no silent fallback spend); key never in records/errors.
- **Reason:** Step-3 task 4 verbatim. No JSON repair (typed API throws deterministically).
- **Decision:** New `classifier.ts` (`Classifier` + `JevClassifier` + `FallbackClassifier` at temp 0 via `OMNIROUTE_FALLBACK_MODEL`, same coerce rules, flagged `fallback`) and `classifyWithFallback` (timeout/http/validation → fallback when `JEV_FALLBACK`; budget always propagates).
- **Reason:** "Timeout twice or hard failure → fallback" implemented as exhausted-retries → fallback; retry counts live in the clients. Existing chat-protocol sorter untouched (rewire is Step 6).
- **Decision:** New `labelCache.ts` on `item_labels`; key folds the question in (`content_hash|version|model|question`).
- **Reason:** The Day-1 formula without the question collides across an item's questions under the UNIQUE key. Model/version change misses by query.
- **Decision:** `cost_usd` added: `LlmCallRecord.costUsd?` + `recordLlmCall` + migration `006_llm_cost.sql` (nullable `ALTER TABLE`).
- **Reason:** Step-3 task 2 requires per-call cost in `llm_calls`; nullable keeps old rows/tests valid.
- **Decision:** Factory throws on empty model (`OMNIROUTE_EXTRACT_MODEL` / `JEV_MODEL`); explicit Jev endpoint never rides OmniRoute (LLM-13). Extractor slices snippet to 400 post-parse.
- **Reason:** Fail fast with the var name beats per-call gateway errors; prompt already says ≤400, code enforces.
- **Decision:** New `test/fakes/fakeJevServer.ts` (modal defaults + queued 429/500/delay/answers overrides, records Bearer presence + body) and `server/scripts/check-llm.ts` (`check:llm`: live `/models` + one real SystemOne classify → sanitized `test/fixtures/jev/real-sample.json`; mismatch exits 2).
- **Reason:** Step-3 tasks 7–8. JEV-03 test auto-skips until the fixture exists.
- **Decision:** New `test/llm/llm-step3.test.ts` (23 pass + JEV-03 skip: LLM-04…14 incl. semaphore unit for LLM-14, JEV-01/02/04…13).
- **Reason:** IDs per rule 9; LLM-14 tests the shared semaphore primitive (OmniRoute caps stay caller-enforced per Phase-2 decision).
- **Live result:** `check:llm` → OmniRoute key present in env but gateway unreachable (`fetch failed`); no Jev direct key → classification skipped, no fixture. Needs: running gateway + `JEV_API_KEY` (+ `JEV_BASE_URL` or explicit direct endpoint).

## 2026-10-02 — Jev live verification (user-supplied key, FIX-2 path)

- **Result:** Contract CONFIRMED. `jev-latest` → HTTP 200 `{answers: {category: {type: "choice", choice, confidence}, quality: {type: "noul", noul}}}` — exact CLAUDE.md shape. Fixture saved to `server/test/fixtures/jev/real-sample.json` (sanitized, JEV-03 green).
- **Observed extras (tolerated, not modeled):** resolved `"model": "jev-1.13.0"`, per-choice `probabilities` map, `usage: {input_tokens: 408, output_tokens: 59}` for a ~230-char state — real billing covers prompt+questions, so the chars/4 state-only estimate undercounts ~7x; budget stays approximate (fail-open side), revisit in Step 6 with real usage totals.
- **Fixes:** default `JEV_MODEL` `jev` → `jev-latest` (old default 400s `Unknown model: jev`; also in `.env.example` + setup default + config test). `check-llm.ts` now loads repo-root `.env` explicitly — workspace scripts run with cwd=server/ so plain `dotenv.config()` never saw it (same latent gap in collect/run/setup/doctor; fixing those when touched).
- **Storage:** key + base URL live in gitignored `.env` only (`JEV_BASE_URL=https://api.typesafe.ai`, split path off the user-given full endpoint so `{BASE}{PATH}` posts once).

## 2026-10-02 — OmniRoute live (user-supplied key, auto model)

- **Result:** Gateway serves `POST /v1/chat/completions` with `model: "auto"` (routed live to `claude-opus-5.5`). `.env` pins `OMNIROUTE_*_MODEL=auto` for extractor/writer/fallback.
- **Fix:** Gateway always streams SSE chunks (`chat.completion.chunk` + `delta.content`), even without `stream:true` — `response.json()` choked on the `data:` framing. `LlmClient.postOnce` now accumulates `data:` deltas + final-chunk usage, with `LLM-15` pinning it (new Day-1 ID for the SSE-tolerant envelope; wiring deferred to check:plan).
- **Notes:** machine env `OMNIROUTE_API_KEY` differs from `.env` and wins (dotenv never overrides) — remove the machine var or keep it deliberately. `GET /v1/models` hangs unanswered (gateway likely unimplemented); `/models`-based probes stay red, chat path green. FakeLlmServer gained `rawBody` passthrough for stream fixtures.

## 2026-10-02 — Free-only OmniRoute models (user constraint: no paid models)

- **Catalog:** `/v1/models` lists 7794 entries; 528 carry a `:free` suffix plus the `auto/best-free` free-only auto combo. No pricing fields — `:free` suffix is the free marker.
- **Pinned (`.env`, gitignored):** writer `auto/best-free` (concise on-spec cards, ~10s, auto-failover), extractor `ur/gpt-4o:free` (valid JSON, ~2–5s), fallback `auto/best-free` (resilient path when Jev is down).
- **Observed:** free-tier capacity fluctuates — `gemini-3.6-flash:free` 429, `deepseek-v4-flash:free` 503, `kimi-k3:free` 429, `auto/best-free` once answered `{"ok":false}` to a ping (fluke; correct on retry + writer-shape). verdict: `auto/*` routing plus existing retry/backoff/per-page-degrade absorb it; `gpt-4o:free` summaries run long (writer caps enforced downstream in Step 6, which is why it is extractor-only).

## 2026-10-02 — Step 4 collectors (docs/12 Prompt 4, ponytail full)

- **Decision:** New `blocked` source status (`SourceStats` enum): reddit 403/429 on every sub with zero items → `blocked` (not `error`); orchestrator counts blocked as a partial reason; `run_source_stats` needs no migration (TEXT, no CHECK).
- **Reason:** Step-4 tasks 3–4 verbatim: walls aren't breakage, but a run with only blocked sources must read partial, not success.
- **Decision:** New `test/collectors/col-step4.test.ts` (11 ID tests: COL-01…06/08/09/13/14, W-03). Reddit 403 test updated `error` → `blocked`.
- **Reason:** IDs per rule 9; W-03 loops all six fixture-backed collectors + registry key coverage.
- **Decision:** New `server/src/config/loadEnv.ts` (cwd `.env`, then repo-root `.env`; machine env wins); all entries (index, collect, run, doctor, rebuild-state, sheets-init, setup, check-llm) use it.
- **Reason:** Workspace scripts run with cwd=server/, so root `.env` was invisible — live keys never reached the CLIs. Fixes Step-3's `check:llm` gap for every entry at once.
- **Decision:** `testJevConnection` speaks SystemOne on direct endpoints (sample `quality` classify via `JevClient`), tolerates a pasted full `…/v1/systemone` URL, keeps the legacy chat round-trip for the empty-base fallback. probe/routes tests moved to FakeJevServer.
- **Reason:** The old chat-JSON probe could never pass against SystemOne (doctor proved it: validation failure with a good key). `friendlyError` covers Jev error classes.
- **Decision:** Factory/extractor call sites degrade (not throw) when the key exists but the model is unset.
- **Reason:** Step-3's fail-fast factory broke `collect --source hackernews` (which needs no extractor). Missing key = degrade as before; key-without-model names the missing var per page. Factory itself still throws (LLM-13).
- **Live matrix 2026-10-02:** HN ok (5 real), reddit blocked (403), trends ok (traffic numbers live), github ok (no token; stars/forks), wikipedia ok (all-access URL, Main_Page skipped), rss skipped (no feeds; hnrss.org/frontpage live 200, 15kB). Fixtures all match live shapes — no refresh needed (reddit stays constructed: live walled). Doctor all-green incl. omniroute 7794 models + jev sample answered.

## 2026-10-02 — Step 5 normalize + dedupe (docs/12 Prompt 5, ponytail full)

- **Decision:** No production-code changes — `normalize.ts`/`dedupe.ts`/`persist.ts` already implement all 7 tasks verbatim (canonicalize + sha1, sanitize 300/500, trigram ≥0.85 keep-best + `merged_sources`, seen-filter with post-sheet `markSeen`, percentile + position fallback, `items_run` pending set, `input − merged − seen = output` stats). Step 5 was audit + ID pins + live proof.
- **Decision:** New `test/pipeline/nrm-step5.test.ts` (10 ID tests: NRM-01/02/03/04/05/06/07/08/10, W-05).
- **Reason:** IDs per rule 9; NRM-09 (seen written only after sheet success) covered by persist-step tests + NRM-05 rerun.
- **Decision:** Bare `ref=` stays kept (not stripped).
- **Reason:** `url.test.ts` pins `?ref=home` kept ("stripped only by reddit's own rules"); changing it now would reshuffle `content_hash`es. Step-5's `ref` reads as the `ref_src`/`ref_url` family, which are stripped (NRM-01 pins that).
- **Decision:** Float percentiles asserted with `toBeCloseTo`, not `toEqual`.
- **Reason:** `1 − 1/3` is `...667` while `2/3` is `...666` — exact equality is representation luck, not contract.
- **Live counts (real HN + hnrss.org, limit 10 each):** collected 20 → normalized 20 (0 dropped) → kept 15, merged 5 (frontpage overlap, expected) → scored 15.

## 2026-10-02 — Step 6 sorter (docs/12 Prompt 6, docs/11 §1.3, ponytail full)

- **Decision:** New chain beside the legacy map/reduce (orchestrator switches in Step 7): `questions.ts` (q1 set, niche_fit only with niches) → `classifyLabels.ts` (ONE Jev request/item, LabelCache, budget stop, fallback, ItemLabels mapping with `none`→Other/neutral) → `clusterTopics.ts` (union-find, ≥0.85 merge, 0.60–0.85 `same_story` ≥0.80, injectable oracle) → `aggregate.ts` (weighted votes, R/N/E, `computeMomentum`, never `fading`) → `writeTopics.ts` (verbatim prompt, delimited clusters, repair→split→fallback, shared WriterOutput) → `sortRun.ts` (score adapter into existing `scoreTopics` + `promptVersion: "w1"`, digest top-10, persist + markLatest).
- **Reason:** docs/11 §1.3 verbatim; shared `ItemLabels`/`WriterOutput` make the frontend contract real (server now depends on `@trendpulse/shared`, which compiles to `dist` first in root `build`).
- **Decision:** Writer batches split by input chars (`WRITER_MAX_BATCH_CHARS = 1200`, within `SORT_BATCH_SIZE`) plus follow-up re-asks (max 2) for valid-but-partial batches.
- **Reason:** Measured live: free routed models stop after the first card on ~2k+ char inputs (13 clusters → 1 topic). Retried batches complete; leftovers get flagged fallback text, never silent.
- **Decision:** Digest input raised 5 → 10 topics (digest.test updated).
- **Reason:** Step-6 task 8 verbatim.
- **Decision:** `rise`-with-all-new stays `rising` (scoreTopics backstop only demotes peak/steady/fading → `new`).
- **Reason:** `computeMomentum` gives `new` only when the rule fires first; the old coerce is a backstop, not the rule.
- **Decision:** `jev_model` keeps the Jev model id; writer model travels in stage detail (Step 7), not a new sheet column.
- **Reason:** No `writer_model` column exists in `sorted_trends`; `prompt_version: "w1"` marks the new pipeline.
- **Decision:** New `test/sorting/srt-step6.test.ts` (17 ID tests: SRT-01…15, JEV-15, W-06, W-20).
- **Live verdict (real HN+RSS, Jev $0.000027 for 14 items):** titles accurate and specific, categories/scores/momentum sensible, all-`new` correct. Weak spots (free-tier ceiling, not bugs): 2/11 cards fell back after truncation battles (flagged `write_failed`), some summaries echo HN metadata instead of abstracting, digest failed its sentence count twice → skipped honestly with partial flagged. Verdict: good enough for the Day-1 slice; upgrades are paid-writer or tighter-budget (latency cost), not correctness.

## 2026-10-02 — Step 7 orchestrator rewire (docs/12 Prompt 7, ponytail full)

- **Decision:** Stages are now the Day-1 ten (no `engagement_norm` checkpoint, no `sort_map`/`sort_reduce`): classify → cluster → write → score → persist_sorted, each checkpointed with skip-on-rerun. Old map/reduce modules + their 5 test files + `StubJevClient` + retired prompts deleted.
- **Reason:** docs/11 rewire replaces Jev-as-chat; dead sorter is dead code. `scoreTopics`/`generateDigest` reused (JevTopic schema moved into score.ts, digest takes a local JsonClient surface, digest input raised to top-10 in Step 6).
- **Decision:** Orchestrator deps are now `classifier` / `fallbackClassifier` / `pairJevClient` / `writerClient` (built live from config when absent); `context.ts` passes them through; old `jevClient: JevJsonClient` seam removed everywhere incl. verify + runs tests.
- **Reason:** One seam per Step-6 role; fakes inject the same way.
- **Decision:** New `NoDataError` (operational): zero drafts with no `ok` source fails `normalize` loudly instead of dying later on an empty sheet tab.
- **Reason:** Step-7 task 2 verbatim ("a stage cannot proceed … no data → failed"). Quiet reruns (drafts present, all seen) never hit it; fresh `--stages` runs starting at normalize still re-collect as before.
- **Decision:** Unexpected classifier errors propagate (stage left `running`, kill-resume path); Jev-family failures route to fallback/`sort_failed` (SRT-08a stub now throws `JevTimeoutError`).
- **Reason:** Matches the kill semantics everything else follows; "Jev down" still degrades per Step 6.
- **Decision:** Budget is enforced within classify (the big spend); pair checks get a fresh client and return null on budget exhaustion.
- **Reason:** Threading one client through resume adds lifecycle complexity for cents of drift.
- **Decision:** `run:once` root alias → `pipeline start` (stage table on stderr, summary JSON on stdout).
- **Decision:** New `run-step7.test.ts` (RUN-01/02/03/04/07/08/12/14, W-07) + `cron-step7.test.ts` (RUN-09 live 1.3s tick, RUN-10 catch-up end-to-end).
- **Live `run:once` ×2 (real HN, no sheet yet):** collect/normalize/dedupe `done`, `persist_raw` failed with the actionable service-account message, run `failed` — exactly the task-2 failure semantics. Sheet-backed rerun proof (0 added rows) waits on your Google key + sheet id; fakes prove it (NRM-05, verify F13).

## 2026-10-03 — Step 8 REST API (docs/12 Prompt 8, ponytail full)

- **Decision:** The Phase-7 API surface already satisfied most of the route table, so Step 8 added only the gaps: `GET /api/jev/health` (key presence, last Jev call outcome from `llm_calls`, price, today's UTC spend vs run-budget knob), manual CORS (same-origin + Vite 5173 in dev, foreign origins 403), UTF-8 BOM on the CSV export, and `choice` + `confidence` on the test-jev probe (sample now asks a `category` choice question; validated against shared `JevHealthResponse`/`TestResult` shapes).
- **Reason:** No new deps (`@fastify/cors` avoided — one hook), no response-shape churn on working routes.
- **Decision (bug, live-found):** `setErrorHandler`/`setNotFoundHandler` moved BEFORE `await app.register(fastifyStatic)`.
- **Reason:** Live boot (static serving on) returned Fastify-default 500s instead of the `{error:{code,message}}` envelope; dev/test (no static dir) were unaffected, which is why the suite never caught it. Encapsulated plugin contexts inherit root handlers only if set before the plugin boots.
- **Decision:** New `server/test/api/api-step8.test.ts` carries the Step-8 IDs (API-01/02/03/04/05/06/07/08/09/11/12/14/15, SEC-01/04/06); older route tests keep their ID-less titles (surgical — not renamed).
- **Live check (no sheet creds, so no real topics yet):** production boot `curl /api/health` → services `error`, live `next_run_at`, real failed `last_run`; `curl /api/trends` → VALIDATION envelope naming the missing service-account key; `curl /api/jev/health` → `{"key_present":false,"last_call_ok":false,...}` (false = earlier real runs logged failed Jev calls before fallback). First real topic paste waits on your Google key + sheet id.

## 2026-10-03 — Step 9 frontend in the Decode design (docs/12 Prompt 9, ponytail full)

- **Decision:** web/ reskinned to docs/11 §4 (light-only paper/lime/forest, Bar nav, no sidebar, no dark theme, no Explore page). Kept: query hooks, SSE hook, Settings/Sources/Runs/Raw/Wizard logic, all e2e flows. Deleted: Explore, TopicCard(+test), TopicDrawer, FilterBar, DigestCard, badges, ScoreRing, useTheme, index.css.
- **Reason:** The old UI implemented the superseded docs/03 dark-first system; docs/11 wins on UI tokens. Logic without visual change was kept verbatim.
- **Decision:** Fonts self-hosted via `@fontsource-variable/geist{,-mono}` (bundled woff2, no external hosts); `tokens.json` mirrors `tokens.css` mirrors the CLAUDE.md table, enforced by STY-01; components use `var()` only (W-23, with sanctioned non-uses documented for `faint`/`violet`).
- **Decision:** Settings rewritten as Steps rows; schedule save requires a passing sheets test, niches save requires a passing jev test (UI-11). Secrets render masked with a ".env replace" note (the API is write-protected for secrets).
- **Decision:** Added `POST /api/runs/:id/retry` to shared `Day1Routes` — the server route and the UI call existed, the contract didn't list it (found by the new W-10 source scan).
- **Decision:** Fixed `useEventSource` close-on-done: the SSE data carries no `type` field, so the old `data.type` check never fired and streams stayed open (found by the new UI-04 test).
- **Decision:** First-run shows a Steps checklist on Today (sheets/omniroute/jev/run) instead of forcing `/wizard`; the wizard page itself still works and its e2e now enters at `/wizard` directly.
- **Cuts applied:** STY-03 contrast computation (sixth in the cut order) — pairs follow the token rules by construction; Raw Data page kept (was second in cut order, but it needed no new work).
- **Live look (real backend, no sheet → checklist state):** 1280px — Bar + lime hero + numbered Steps all correct. 375px — Bar overflowed (links squeezed, actions wrapped mid-button); fixed with wrap + nowrap, verified in screenshot. No page-level horizontal scroll at 375/800/1280 (smoke test asserts).

## 2026-10-03 — Step 10 day close (docs/12 Prompt 10, ponytail full)

- **Decision:** `verify/registry.ts` now holds the exact docs/12 §8 board (23 rows); `scripts/verify.ts` runs each row's named tests via vitest `-t` (fake mode) and real-service probes where credentials exist (live mode, rest SKIP). Deleted the old 46-check superset + scrapling stubs.
- **Reason:** The old board tested phases that don't exist yet; the Day-1 contract is the 23 rows.
- **Decision (bug, found via new setup behavior):** `server/scripts/setup.ts` resolved the repo root one level too high AND through a leading-slash path that `existsSync` rejects — it read/wrote nothing real. Fixed with `fileURLToPath` (matches `doctor.ts`).
- **Decision:** `npm run setup` now copies `.env.example → .env` when missing and prints the still-empty keys before the interactive walk.
- **Decision:** README gained only the missing piece (Jev price + run-budget cost notes); the rest already met spec.
- **Live end-to-end (blocked):** `run:once` collects 5 real HN items, fails at `persist_raw` (no sheet). Doctor: node/env/sqlite ok; HN/Trends/GitHub/Wikipedia ping ok; reddit 403 WARN (expected); Jev `jev-latest` sample ok; OmniRoute FAIL (gateway down). Still unverifiable without a sheet: raw/sorted/digest/runs_log rows, rerun-≈0, wrong-key fallback run, dashboard run-now.
- **Secrets check:** Jev + OmniRoute keys appear in zero repo files outside `.env` (code, docs, logs, reports, both sqlite DBs clean); no service-account key file exists to leak; API masking covered by API-11/SEC-06 tests (green).
- **Cuts confirmed Day-1:** STY-03, JEV-03 (fixture-gated), full kill-resume/chaos, Scrapling sidecar. See NEXT.md for Day 2 order.

## 2026-10-03 — Stretch S1 scrapling-lite sidecar (ponytail full)

- **Decision:** Built per the prompt text; `docs/09_SCRAPLING_INTEGRATION.md` does not exist in `docs/` or the zip, so §§1-5/11 could not be read — the S1 prompt itself was sufficient.
- **Install log:** Python 3.13.7, `scrapling==0.4.15` (metadata says `>=3.10`). Scrapling under-declares deps: also installed `curl_cffi`, `playwright`/`patchright`, `browserforge`, `msgspec` (all import-time required). No browser download needed. Pinned in `scrapling-service/requirements.txt`; venv is gitignored.
- **Gotcha:** `DynamicFetcher.configure(headless=...)` raises `ValueError` (parser args only) — session args go to the constructor. Cost one debug cycle (SCR-03).
- **Decision:** `SCRAPLING_ALLOW_IPS` exact-IP test holes (default deny) so fixture servers on loopback are fetchable; never set in production. The webpage collector delegates gating to the sidecar and guards only its native fallback path.
- **Decision:** `SCRAPLING_ENABLED=false` default (opt-in); supervisor boot never blocks on a dead sidecar; webpage degrades per-page, never throws.
- **Live timings (httpbin.org/html):** http 3741 bytes in 2342ms; browser 3716 bytes in 2440ms. en.wikipedia.org/wiki/Web_scraping → HTTP 403 → correctly BLOCKED per policy.
- **Tests:** SCR-01/02/03/04/10/14/18 + supervisor circuit + COL-07 (13 tests, real sidecar + fixture site). Server suite 435/435.

## 2026-10-03 — Fix pass R0 baseline (ponytail full)

- **Env:** sha cfc7b24, Node v26.4.0, npm 9.9.4, Windows 11. Baseline green: lint 0, typecheck 0, server 435/435, web 22/22, audit 0 vulns. Full log: test-runs/baseline-2026-10-03.txt.
- **Deviations:** docs/14_FIX_PASS_PROMPT.md does not exist (prompt text came from chat; treating it as §0-1). `tools/check_docs_wiring.py` missing — checker lives at repo-root check_docs_wiring.py (R8: copy or note). `npm run dev:fake`, `npm run seed:test`, `scripts/chaos/`, TRIAGE.md all missing (scheduled R1/R2/R5/R6; INF-07). `docs/` itself exists. Tag day1 exists.
- **Assumption verified:** verify-report.json on disk is a stale live-mode run, not current fake state.
- **Assumption NOT verified:** 9 failed runs triaged as ENV (8× missing key file pre-fix, 1× OmniRoute fetch fail) + 1 interrupted of unknown origin; R2 writes TRIAGE.md and confirms no CODE cause.
- **Security:** user pasted the service-account key in chat → file saved to secrets/service-account.json, stray repo-root copy trace-dev-*.json deleted; key must be rotated (told user). GOOGLE_SHEET_ID set from user URL; sheets:init 403 → sheet not yet shared (user action). Key path in .env is ../secrets/service-account.json because workspace scripts run with CWD=server/.
- **Gotcha:** `verify` fake mode spawns `npx vitest` per row → >3 min for 4 rows on Windows (FND-03, fixed in R1 with in-process runner + process.execPath).
- **Engines:** package.json says node >=20; running 26.4.0 here. Node 20/22 compat noted but not tested in this pass (no other runtimes on machine).

## 2026-10-04 � pulse-G0 plan (Doc 16 live graph, ponytail full)

10-line plan: (1) migration 008 topic_index/topic_samples/pulse_cycles; (2) G1 sampler core + persist hook + PULSE-01..09 on fakes; (3) G2 HN/GH/OAuth-only-reddit refreshers + fixtures PULSE-10..14; (4) G3 today/top, live/samples, live/stream, sample-now + PULSE-15..19; (5) G4 hero + hand-rolled SVG chart + hooks/badge + PULSE-20..30 (cut sparklines first if late); (6) G5 minimal dev:fake seed + --pulse-fast + e2e PULSE-31..33; (7) G6 gates + one real HN/GH cycle; (8) commit per package pulse-Gn.
Files: server/src/pulse/*, server/src/sheets/composioClient.ts untouched, orchestrator persist hook, server/src/api/{today,live}.ts, shared/src/api.ts, web/src/pages/Today.tsx + web/src/{components/LiveChart.tsx,hooks/useLive.ts}, server/scripts/fake-seed.ts, tests PULSE-nn. No chart lib, no new runtime deps.
Conflicts: none � Doc 16 �4 accepts unwired status (temp PULSE-nn names, no FR/phase/checker changes).
- **Definitions (locked):** top topic = rank 1 of today's latest set (trend_score; hidden excluded; tie-break source_count then newer); no set today ? most recent day + from-date label, no live line.
- **Sampled items:** =3 evidence items, highest baseline, refreshable sources only (HN score/descendants, GH stars w/ ETag, reddit OAuth-only else skipped); rest skip with reason.
- **Growth index:** 100 * current/baseline sums; failed item carries last value; all-fail adds no point; zero-baseline topic has no series.
- **Deviation:** dev:fake does not exist (DECISIONS R0: scheduled INF-07) � G5 builds only the minimal seed the demo needs, not the full mode.
- **Deviation:** samples live in SQLite topic_samples (spec �1), never mirror_sorted � no read-path rework.
- **Deviation:** PULSE ?????? refresher is OAuth-only stub per spec; cut first if late (spec cut order).

## 2026-10-04 — pulse-G6 close-out (Doc 16, ponytail full)

- **Done:** G0 plan + locked definitions; G1 index/sampler/persist hook (PULSE-01..09); G2 HN/GH/reddit refreshers + live-recorded fixtures (PULSE-10..14); G3 today/top, live/samples, live/stream (Last-Event-ID), sample-now 409/429 (PULSE-15..19); G4 hero + hand SVG chart + stream hooks (PULSE-20..30); G5 fake-seed + --pulse-fast + e2e (PULSE-31..33, 6/6, shots in test-runs/evidence/2026-10-04/).
- **Gates:** server lint 0, typecheck 0, tests 496/496; web lint 0, typecheck 0, tests 36/36; shared typecheck 0. discover --check FAILS as designed (lock UNPINNED — WAITING on a valid COMPOSIO_API_KEY, unrelated to pulse).
- **Live-verified (real HN + GitHub endpoints, demo-seeded topics):** cycle ok, 3 requests, demo-t1 index 100.03 total 90355 (GH stars moved 90222→~90251 live), 1 GitHub API call (ETag arms future 304s). Demo baselines were synthetic — real growth semantics proven by PULSE-01/14, not by this run.
- **Deviations:** REST transport (no @composio/core — same slugs, verified shapes; §11 MCP unaffected); samples in topic_samples, no mirror rework; SHEETS_READ_STRATEGY default stays ttl; minimal fake-seed instead of full dev:fake (R0 INF-07 still open); sparklines + reddit full refresher cut (spec cut order); no Figure/Button (don't exist — used Panel/Pill/SidePanel); no d3 (hand SVG); migration 007 not 006 (taken); PULSE-29 targeted not axe-in-JSDOM; PULSE-30 structural (JSDOM has no layout).
- **Collateral fixes (own tests updated):** INF-02 version lists (+007/+008); RUN-12 scoped to non-pulse bus events; health.test hermetic (discard-port LLM probes — was failing because a real OmniRoute gateway is now running on :20128).
- **Verified vs assumed:** HN item + GH repo shapes VERIFIED against live responses (fixtures); Composio REST auth-config/connected-account endpoint paths ASSUMED (key still invalid — C6 WAITING); GH 60/hr quota + 304-non-counting ASSUMED (code honors ETags; not load-tested); reddit OAuth path untested (stub).
- **Still needs the user:** valid COMPOSIO_API_KEY + Google connect (unchanged); share sheet for service-account path (unchanged); `gh auth login` for private repos; login-state channels (Twitter/XHS/Reddit/etc.) on request.

## 2026-10-05 — catsort-S0 plan (Doc 17 animation + category runs, ponytail full)

12-line plan: (1) migration 009 (runs scope/categories, items target_category, sheet columns trail, sort_events replay store); (2) S1 registry (14 cats, ≤3 verified sources each) + scope model + header upgrade + category/settings/trends APIs; (3) S2 Algolia-HN keywords + github query override + rss feeds + category-collect path (no general sources) + estimate; S2b search cut; (4) S3 run API categories/mode, sort_focus stage, scope-carrying persist (digest only for all), cron default_categories; (5) S4 sort_batch/clusters/topics/rank/phase events (≤20/s, titles ≤60) + active + sort-state + replay store; (6) S5 picker (?scope=, estimate, strict/loose) + SortingStage (bins→blobs→cards→FLIP, 150 dots, skip/replay, reduced-motion counters) + compact Runs variant; (7) S6 fake-seed category fixtures + e2e; (8) S7 one real ai run + gates.
Files: server/src/categories/*, orchestrator (collect/select/focus/persist hooks + events), collectors hn/github/rss (param overrides only), sheets schema+repo (trail cols, scope-aware markLatest), api/{categories,runs,trends,pulse?} , shared/api.ts, web Today picker + SortingStage + hooks, scripts/fake-seed, tests SORTANIM/CATRUN. No new deps, no animation lib (CSS+rAF+FLIP).
Conflicts: none — Doc 17 §4 accepts unwired status (temp test names, no FR/phase/checker). Pulse topic_index gains scope_key (additive). Sheets gets 3 trailing columns (registry + idempotent header upgrade).
- **Definitions (locked):** 14 Jev categories, lowercase slugs; scope_key all|slugs+-joined (max 5); strict (default) excludes off-scope ≥0.6 (kept raw), loose excludes nothing; is_latest per (date, scope); digest only for all; category run = category sources + today's stored items + cache-first classify; dedupe unchanged; scope-less old rows read as all.
- **Deviations (pre-declared):** S2b search-provider cut; dev:fake is minimal seed (R0 INF-07) — S6 e2e via mocked API + fake timers per repo pattern; reddit OAuth-only stub; per-category Settings editor cut (registry file + PUT validation only); row sparklines already cut (G4).

## 2026-10-06 — catsort-S7 close-out (Doc 17, ponytail full)

- **Done:** S5 picker/SortingStage/scope wiring (web 45/45); S6 fake-seed category sets + e2e 6/6 + shots; S7 live ai check below.
- **Gates:** server 496/496 (one run; SEC-04 flaked once under load, green solo — pre-existing timing flake), web 45/45, lint+typecheck clean, shared rebuilt.
- **Live ai run (read-only probe, real endpoints + real Jev, no sheet/DB writes):** collect 15 items in 12.5s (hn keywords 5, gh topic:llm 5, mit-tech RSS 5, all ok); Jev labeled 6/6 sampled AI (~350ms each, ~fractions of a cent). Dropped at registry build: nature (HTML not RSS), nih (403), mnt/404, who/404, arXiv cs.AI (valid but empty).
- **Production note:** an all-scope run was mid-sort_write during verification — sort_focus ran (done) on real data; writer slow on local gateway, left undisturbed.
- **Deviations:** estimate is a planning ceiling (not ±30% prediction); S2b search cut; select folded into collect; sort_focus runs as no-op for all; docs/02,04,10 stage lists absent (only docs/12 history + docs/17); dev:fake is minimal seed (no fake pipeline → no --sort-delay); mocked-API e2e per repo pattern; `other` sourceless by design; shared Day1Routes extended with pulse/live routes; RATE_LIMITED code added.
- **Still needs the user:** nothing for this feature — try the picker on Today (?scope=ai+finance), watch a run sort live.

## 2026-10-06 — top5-Q0 plan (Doc 19, ponytail full)

12-line plan: (1) migration 010 (topic_index.category, category_runs, legacy-tag old scopes); settings my_categories/MAX/TOP_PER/INCLUDE_GENERAL (replace default_categories+cron hook); (2) Q1 my-categories + today/categories APIs, trends/dates ?category= (replace ?scope=), markLatest by category, header-keep + legacy rule; (3) Q2 planner honors my_categories, INCLUDE_GENERAL gate, NO_CATEGORIES preflight, estimate per-category + writer-top-calls; (4) Q3 assign rule + per-category clustering (ids prefixed), SCORE BEFORE WRITE via text-independent scores + text patch, top-5-per-category persist, digest full-runs only, subset refresh, cron my_categories; (5) Q4 events gain category, bins = my_categories; (6) Q5 my-categories row, onboarding, CategoryPanels + per-panel refresh, hero-across, run-all + estimate, reduced-motion/a11y; (7) Q6 seed + e2e; (8) Q7 real two-category run + gates.
Files: server/src/{scheduler/cron,sheets/{schema,mappers,repo},pipeline/{orchestrator,sortEvents},sorting/{score},api/{settings,categories,runs,trends,today,live},pulse/index}, shared/api, web Today/picker/panels/hero, scripts/fake-seed, tests TOP5-nn. Pulse sampler/index keyed by category (sampler stays all-behavior on full runs; hero-graph integration cut).
Conflicts: Doc 17 scope code (8 commits) gets migrated, not deleted: scope_key columns stay (unread), scope params become category params, pulse keeps running. No Figure/Button (absent). No d3. No dev:fake pipeline (minimal seed).
- **Definitions (locked):** 14 slugs; my_categories ordered 1-6, empty = NO_CATEGORIES_SELECTED; assignment ≥0.6 selected→it, ≥0.6 unselected→excluded(raw kept), <0.6→target or exclude, exactly one category; top5 by score, tie sources then newer; is_latest per (date, category), rank 1..n in-category; digest full-runs only; old scope rows = legacy (scope cell not in {"", "all"} ignored); hidden leaves 4, no backfill.
- **Deviations (pre-declared):** score-then-write via placeholder-text scoring (score is text-free) + patch; cluster ids prefixed per partition; pulse per-category cut (sampler unchanged, hero-graph cut per cut list); S2b already cut; per-category settings editor cut; drag reorder cut; estimate popover kept (small); Explore link cut.

## 2026-10-06 � top5-Q1 data model, settings, API (Doc 19, ponytail full)

- **Ruling:** no UNIQUE index for is_latest per (run_date, category). A set holds up to TOP_PER_CATEGORY rows sharing (date, category, is_latest=1), so no row constraint can express it; legacy scoped sets also coexist. The invariant is code-maintained: sheets markLatest flips per category, SQLite writeLatestSet flips per category (Q3).
- **Reason:** a partial unique index broke PULSE-15 and the multi-topic data model (proven by failing suite); code flips already own this for scopes.
- **Cost if wrong:** duplicate latest rows per category if a flip path is missed; TOP5-16 covers subset-refresh isolation.
- **Collateral fixes (own scope):** removed stale top_n/topN/default_categories refs (config, effective settings, sorter, cron, setup prompt, .env.example); repaired 3 pre-existing lint errors blocking gates (sortEvents assertion, catrun-s3 unused var + redundant assert, web sortanim unused container).

## 2026-10-07 � top5-Q2 category-only collection (Doc 19, ponytail full)

- **Ruling:** explicit general sources stay a general run (power-user/stage backdoor). NO_CATEGORIES_SELECTED fires only when a run has neither categories nor explicit sources, so Today/cron runs block on empty selection while RUN/orchestrator stage tests and manual source runs keep working.
- **Reason:** Doc 19 kills default general runs, not explicit source selection; rewriting ~20 stage tests for a model Q3 reshapes again would be churn.
- **Cost if wrong:** a caller passing sources bypasses the category gate; Today/cron never pass sources.
- **Ruling:** resortRun (no production callers) gains a categories passthrough; its test pins the legacy general re-sort via explicit sources.
- **Deviations:** persist now writes the items_run.target_category column (was payload-only); category failed rows carry the first source error; estimate keeps CATRUN-12 ceiling fields and adds per-category/writer/general blocks.
