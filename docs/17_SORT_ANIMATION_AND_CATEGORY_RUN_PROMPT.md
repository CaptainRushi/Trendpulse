# 17 — Sorting Animation and Category Runs (prompt only)

Two additions to **Today**:

1. A **sorting animation** that plays while the app is sorting: items drop into category bins as Jev labels them, bins merge into topics, topics get a title and re-order by score.
2. A **category picker** so the user can choose what to find and scrape: pick `ai`, `finance` and so on, and the run collects from sources chosen for those categories, then sorts only that scope.

Prompt only. Not yet wired into `10_MASTER_PLAN.md`, the health board or `13_FEATURE_TEST_PLAN.md`; test names are temporary (`SORTANIM-nn`, `CATRUN-nn`).

## 1. Decisions and limits (read before pasting)

| Topic | Decision |
|-------|----------|
| Animation is real | Every dot is a real item and every move is a real event from the pipeline. Nothing is faked or slowed down. Fast runs (cached labels) finish in seconds, so the UI queues events and plays them back at a readable speed (at most 4 seconds behind), with a **skip** button. After the run a **replay** button plays the stored events again |
| Reduced motion | No movement at all: counters and a progress bar only |
| Dot cap | At most 150 animated dots; the rest are counted ("+37") |
| What "category" means | The 14 categories already used by Jev (Tech, AI, Business, Finance, Science, Health, Politics, World, Sports, Entertainment, Culture, Gaming, Lifestyle, Other) |
| Category sources | A registry gives each category a few **extra** sources and keyword queries. Default sources stay the general ones |
| Scope | A run has a scope: `all` or a sorted combination such as `ai+finance`. Sorted sets are kept **per date and scope**, so a category run never hides the all-categories set |
| Focus mode | `strict` (default): items Jev labels outside the chosen categories with confidence ≥ 0.6 are excluded from topics (still stored raw). `loose`: nothing excluded |
| Stored items are reused | A category run re-sorts today's stored items plus the new category items. Labels come from the cache, so only new items cost Jev calls |
| Dedupe | Same rules as before: category runs add only new raw rows; a same-scope rerun adds about 0 |
| Digest | Only the `all` scope writes a digest |
| Sheets | Three trailing columns are added: `raw_trends.target_category`, `sorted_trends.scope`, `runs_log.categories`. Old rows count as scope `all` |
| Discovery quality | Depends on the sources. Reddit is blocked without OAuth. Default feed and query lists are starting suggestions that the agent must verify (endpoint answers, robots, terms) and keep small. Strict mode may give few topics for niche categories |
| Scraping policy | Unchanged: official APIs and RSS first, Scrapling only for allowed pages, robots.txt, rate limits, no stealth or challenge bypass |
| Optional | "Discover pages" through a search provider is optional and is the first thing cut |

## 2. Layout (Decode design system)

```
today · scope: [ ai × ] [ finance × ] [+ category ▾]   mode: strict | loose     [ run for ai + finance ]
        estimate: ≈ 3 new sources · ≈ 45 new items · ≈ $0.004                    default categories ⚙

SORTING  classify 83/120 · jev 80 · fallback 3 · $0.004                      [ skip ] [ replay ]
 unsorted   →   bins:  tech ▪▪▪▪  ai ▪▪▪▪▪▪  business ▪▪  finance ▪▪▪  science ▪ … off-category ▪▪  discarded ▪
 phase 1 classify → 2 filter → 3 cluster → 4 write → 5 rank
 topics (reorder by score):  1 ▌title … 92   2 ▌title … 88   3 ▌title … 81
```
The sorting panel appears only while a run is in a sorting stage and fades a few seconds after it ends (collapsible; a compact copy lives on the Runs detail page).

## 3. The prompt

Paste at the repo root. Prerequisites: the Today page, the run event bus with SSE, the sorter (classify, cluster, write, score), collectors, `dev:fake`, and the Decode-style components already exist.

````text
You are adding two things to TrendPulse: (A) a live sorting animation on the Today tab, and (B) category-targeted find and scrape runs with a category picker. Read CLAUDE.md, docs/11 decode rewire and ui .md sections 1 and 4 (actual filename: lowercase with spaces), docs/02_TRD.md sections 4, 6, 7 and 8, docs/05_BACKEND_SCHEMA.md section 1, docs/17_SORT_ANIMATION_AND_CATEGORY_RUN_PROMPT.md sections 1 and 2. Then inspect the repo: the orchestrator and its stages, the event bus and run SSE route, the collectors and registry, the sheets schema registry, Today and its components, the run now button, and dev:fake. Reuse what exists; do not rebuild it.

DEFINITIONS (follow exactly)
- Categories: Tech, AI, Business, Finance, Science, Health, Politics, World, Sports, Entertainment, Culture, Gaming, Lifestyle, Other. Slugs are lowercase.
- scope_key: "all", or the selected category slugs sorted alphabetically and joined with "+" (max 5 categories), for example "ai+finance".
- Focus mode: strict (default) excludes from topics any item whose Jev category differs from the selected ones with confidence at least 0.6 and marks it off_category; loose excludes nothing.
- is_latest is unique per (run_date, scope_key). A run only flips rows of its own scope.
- Digest: only scope "all" writes a daily_digest row.
- A category run = collect the selected categories' category sources (new items) + reuse today's stored items (items_run) + classify (cache first) + focus filter + cluster + write + score + persist for that scope.

PACKAGE S0 - Plan (10 min)
Reply with a 12-line plan, the files you will change and conflicts with the repo; log the definitions above in DECISIONS.md. Continue without waiting.

PACKAGE S1 - Category registry and scope model (60 min)
1. server/src/categories/registry.ts: for each category a label, slug and up to 3 default category sources, each {collector, params, verified_at}. Params by collector: hackernews uses keywords through https://hn.algolia.com/api/v1/search?query=<kw>&tags=story&numericFilters=created_at_i><unix> (public API; item id is the HN objectID, points, num_comments); github uses search queries with topic:<name> and created:>date; rss uses feed URLs; reddit uses subreddit names (only with OAuth, otherwise status skipped with a hint). Starting ideas (verify every one before shipping; keep at most 3 per category; record a fixture for each and drop what does not answer or is not allowed by robots/terms): Tech (hn keywords, github topics, lobste.rs RSS), AI (hn keywords llm, ai agent, openai, anthropic; github topic:llm; arXiv cs.AI RSS), Science (arXiv, official science news RSS), and for Finance, Business, Health, Politics, World, Sports, Entertainment, Culture, Gaming, Lifestyle find 1-3 reputable official RSS feeds each and verify them. Users can add or remove sources and keywords per category in Settings (stored in settings, validated with zod; URLs go through the same SSRF and robots guards).
2. Migration 009 (next free number after 001, 003, 006, 008 — the runner applies unapplied files in numeric order and gaps are allowed): runs.categories_json, runs.scope_key, runs.focus_mode; items_run.target_category; topic_index already exists (008_pulse.sql): ALTER TABLE topic_index ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'all' (default "all"), and fix the scope-blind is_latest flip in server/src/pulse/index.ts — `UPDATE topic_index SET is_latest = 0 WHERE run_date = ? AND run_id <> ?` ignores scope, so a category run would hide the all-scope set from the live graph. items_run.sort_status has a CHECK ('pending','sorted','discarded','sort_failed'): represent off_category in payload_json or a new column, not a new sort_status value (a new value needs a SQLite table rebuild).
3. Sheets schema registry: append trailing columns raw_trends.target_category, sorted_trends.scope, runs_log.categories (and update docs/05 section 1 tables). Init must upgrade existing sheets: when the header row is shorter than the registry and the missing header cells are empty, write only the new header cells; never overwrite a changed header; old rows without a value count as scope "all". markLatest takes the scope and flips only rows with the same date and scope; flipStaleLatest in server/src/sheets/repo.ts matches by hardcoded column indexes (sorted_trends: run_date 2, run_id 1, is_latest 23; daily_digest: 0, 1, 10) — extend it to also match the new scope column and read a blank cell as "all".
4. API: GET /api/categories (registry with source status), PUT /api/categories/:slug (edit sources and keywords), settings key default_categories (used by cron runs; empty = all — the settings PUT only accepts keys registered in the SPECS map in server/src/api/settings.ts, so register it there), GET /api/trends and /api/dates accept scope (default "all"); an unknown scope returns an empty set with a hint, not an error.
Tests: CATRUN-01 registry validation (each category has at least one source, at most 3 defaults, bad params rejected), CATRUN-02 scope_key normalization, CATRUN-10 sheet header upgrade is idempotent and old rows read as "all", CATRUN-09 is_latest per (date, scope), CATRUN-11 trends API by scope.

PACKAGE S2 - Category-routed collection (90 min)
1. Collectors accept a category context {category, keywords, limit}. Implement keyword search for hackernews (Algolia — the current collector is Firebase topstories only, so this is a new path; the Algolia item id is the objectID; reuse the shared http client and per-domain limiter), github topic search (the current collector already queries api.github.com/search/repositories with a created:>date query — add topic:<name>), rss (category feeds); reddit by subreddit only with OAuth (note: the current general collector falls back to unauthenticated .json when OAuth fails — the category context must skip with a hint instead). Map items to the normal RawItem; set items_run.target_category; use the same canonical URL and hash so dedupe with general items works. Cap CATEGORY_MAX_ITEMS (default 40) per category source; polite http client (User-Agent, at most 1 request/second per domain, robots for page and feed fetches).
2. A category run collects only the selected categories' sources; general sources are not called. run_source_stats has PK (run_id, source) — a collector serving two categories (hackernews for ai and tech) must write distinct rows: use a source label like "hackernews:ai" (zero migration) or extend the PK in migration 009.
3. Estimate: POST /api/runs/estimate {categories, mode} returns {sources, expected_new_items, stored_items_reused, jev_calls_expected (cache aware), cost_usd_estimate, warnings}.
4. Optional (cut first) package S2b: a SearchProvider interface (implementations behind config: a keyed provider the user configures, or the OmniRoute search route if it exists; verify) used to find up to CATEGORY_DISCOVER_MAX pages per category, which then go through the Scrapling webpage collector with all its guards. Off by default.
Tests: CATRUN-03 only selected categories' sources are called, CATRUN-04 hackernews keyword fixture maps to RawItem and dedupes with front-page items, CATRUN-05 github topic and arXiv fixtures parse, CATRUN-06 reddit without OAuth is skipped with a hint, CATRUN-12 estimate within 30 percent of actual and the item cap holds, CATRUN-14 category run adds only new raw rows and a same-scope rerun adds about zero, CATRUN-15 politeness (spacing, caps, robots).

PACKAGE S3 - Run API and orchestrator (60 min)
1. POST /api/runs accepts {categories?: string[], mode?: "strict"|"loose"}; preflight adds a blocker CATEGORY_NO_SOURCES when a chosen category has no usable source; scope_key and focus_mode are stored on the run; cron uses default_categories.
2. Stages: collect (category sources only for category runs), normalize, dedupe, persist_raw, select (assemble stored items of today plus the new ones, only for category runs), sort_classify (cache first), sort_focus (new stage; strict marks off_category; skipped for scope all), sort_cluster, sort_write, score, persist_sorted (rows carry scope; only scope all writes the digest), finalize. The STAGES const, SORT_STAGES and PRE_PERSIST arrays in server/src/pipeline/orchestrator.ts and the strict z.enum(STAGES) in PostRunsBody (server/src/api/runs.ts) all enumerate stages — extend them together. Update stage lists in docs/02, docs/04, docs/05 and docs/10 where they enumerate stages (docs/02 §6 still lists the old sort_map/sort_reduce names — fix those too).
3. runs_log gets the categories value; topic_index and mirror tables carry scope_key.
Tests: CATRUN-07 stored items reused with zero new Jev calls for them, CATRUN-08 strict versus loose, CATRUN-13 default_categories used by cron and CATEGORY_NO_SOURCES blocker.

PACKAGE S4 - Sorting events and state (60 min)
1. Emit on the existing run stream /api/runs/:id/stream (batched, at most 20 events per second, titles cut to 60 characters, text only). PipelineEventType in server/src/pipeline/events.ts is a closed union — add the five sort_* types; the 500-event ring buffer and Last-Event-ID resume (afterSeq) already exist:
   sort_batch {stage: "classify", items: [{id, t, c (category slug), q (quality 0-1), f (fallback boolean), d (discarded), o (off_category)}], done, total, jev_calls, fallback_calls, cost_usd}
   sort_clusters {clusters: [{id, category, size, member_ids (max 12)}]}
   sort_topics {topics: [{cluster_id, title}]} (as each writer batch returns)
   sort_rank {ranks: [{cluster_id, rank, score}]}
   sort_phase {phase: "classify"|"filter"|"cluster"|"write"|"rank"|"done"}
2. GET /api/runs/active returns the active run id and scope or null. GET /api/runs/:id/sort-state returns the current state (items placed, clusters, topics, ranks, phase) so a page opened mid-sort can start from it. Honor Last-Event-ID.
3. Persist a compact copy of the events for replay in sort_events (run_id, seq, payload_json), keep the last 3 runs only, cap 5 MB per run.
Tests: SORTANIM-01 batching and throttle (500 items give a bounded number of events) and titles truncated, SORTANIM-02 snapshot equals the state implied by replaying the events, SORTANIM-03 mid-sort open gets snapshot then deltas, Last-Event-ID resume, SORTANIM-04 fallback, discarded and off-category flags present, SORTANIM-15 retention of the last 3 runs.

PACKAGE S5 - Frontend (150 min)
Design: docs/11 section 4 tokens, light only, lowercase copy, mono counters, 4 px radius. No animation library; use CSS transforms and opacity, requestAnimationFrame batching, and the FLIP technique for reordering.
1. CategoryPicker on Today: multi-select chips (max 5), "all" chip clears the selection; strict/loose toggle; estimate popover from /api/runs/estimate; the run button text becomes "run for ai + finance"; "default categories" link to Settings; selection stored in the URL (?scope=ai+finance). The topic list, hero digest line, top topic and the live graph (server/src/pulse, web/src/components/LiveChart.tsx — Doc 16 was never written as a file; the feature shipped in pulse-G0..G5) follow the selected scope. A scope with no set yet shows the empty nudge "no set for this scope yet" with a lime run button.
2. SortingStage component, shown while the active run is in a sorting stage and for a few seconds after, collapsible, with a compact variant on the Runs detail page:
   - Phase 1 classify: dots (one per item, max 150, rest counted as "+n") drop from an unsorted pile into 14 category bins plus "off-category" and "discarded" trays as sort_batch events arrive. Dot color from category tokens plus a one-letter code so color is never the only carrier; a hollow ring marks fallback-classified items. Bin counts update live.
   - Phase 2 filter: low-quality dots fall into the discarded tray, off-category dots (strict) slide to the off-category tray.
   - Phase 3 cluster: dots inside a bin pull together into blobs showing their size.
   - Phase 4 write: each blob becomes a topic card and its title appears as sort_topics arrive.
   - Phase 5 rank: cards reorder with FLIP by score; the top card gets the lime highlight; the top-topic hero updates.
   - A playback queue shows events at a readable pace, never more than 4 seconds behind real time; "skip" jumps to the final state immediately; "replay" replays the stored events of the last run.
   - Counters: "classify 83/120 · jev 80 · fallback 3 · $0.004".
   - If the page opens mid-run, load /api/runs/:id/sort-state first, then apply deltas.
3. Reduced motion: no movement or transitions; show only the counters, the phase label, a progress bar and the final ranked list.
4. Accessibility: region labelled "sorting progress", polite live announcements only on phase changes (not per item), visible focus ring, keyboard: Tab reaches skip and replay and each bin (Enter lists the last 5 titles in it). All titles rendered as text.
5. Performance: only transform and opacity animate; at most 150 animated elements; no layout thrash; no long task over 100 ms while 300 events arrive in 5 seconds.
Tests: SORTANIM-05 phase rendering from event fixtures, SORTANIM-06 bin counts equal classification results and the 150 cap shows "+n", SORTANIM-07 FLIP final order equals score order and top card highlighted, SORTANIM-08 reduced motion, SORTANIM-09 axe scan and live-region throttling, SORTANIM-10 hostile titles inert, SORTANIM-11 compact variant and replay on the Runs page, SORTANIM-12 performance budget (Playwright trace), SORTANIM-14 picker behavior (multi-select, estimate popover, strict/loose, URL state, default categories).

PACKAGE S6 - Demo mode and end to end (60 min)
1. dev:fake options: --sort-delay=60ms (artificial delay per item inside the fake Jev and writer so the animation is watchable) and a fake category registry with fixtures. The real pipeline is never slowed down.
2. Playwright: start a category run (ai + finance) in dev:fake; assert the sorting panel appears, the dot and bin counters grow, phases advance in order, cards re-order, the final top topic equals rank 1, the panel fades after done, only the selected categories' fake sources were called, rows exist for the new scope while the all-scope set is still latest for its scope; then a reduced-motion run and screenshots at 375, 800 and 1280 px into test-runs/evidence/<date>/.
Tests: SORTANIM-13 end-to-end animation, CATRUN-end-to-end scope isolation.

PACKAGE S7 - Real check and close-out (30 min)
Run one real category run for "ai" (HN keyword search, GitHub topic, arXiv RSS) against the live endpoints with your real keys if present. Paste: items per source, new raw rows, share of items Jev placed in the selected category (precision), items excluded by strict mode, Jev calls and cost, durations, and what the sorting stage showed. Run lint, typecheck, tests, the e2e suite and verify. Update DECISIONS.md and NEXT.md. State every source you dropped and why (CATRUN-16 is this live check).

RULES
- Follow CLAUDE.md; tests first; Windows-safe scripts; no new heavy dependencies; never log keys.
- Never fake animation data or delay the real pipeline. The UI queue only affects display.
- Category runs must not call general sources and must not hide the all-scope set.
- Honest copy: say "sorting" only while sorting; no invented numbers.
- Commit per package: `catsort-Sn: summary`. After each package report in 6 lines: status, time vs box, tests passing/total, deviations, needs from me, next. Keep going unless blocked.
- CUT ORDER if late: S2b discovery, replay, compact Runs variant, estimate popover detail, loose mode, per-category settings editor.
````

## 4. Not yet wired

This work has no requirement numbers, health rows or phase in `10 master plan.md`, and no entry in `13_FEATURE_TEST_PLAN.md` or the docs checker. (The docs checker already reports a pre-existing error — "no cumulative rows line" in the master plan — unrelated to this doc.) Say "wire it" to add FRs, rows, a phase, the sheet column changes in `05`, and the stage list change in `02`, `04` and `10`.

## 5. Acceptance checklist

- [ ] Category picker on Today with estimate and strict/loose; run button reflects the selection
- [ ] A category run calls only that category's sources and reuses today's stored items
- [ ] A sorted set exists per date and scope; the all-categories set stays latest for `all`
- [ ] Sorting panel shows real items moving into bins, merging, titled and ranked; skip and replay work
- [ ] Reduced motion shows counters only; keyboard and screen-reader paths work
- [ ] No long tasks over 100 ms with 300 events in 5 seconds; 150 dot cap with "+n"
- [ ] One real "ai" category run reported with precision, cost and dropped sources
## 6. Superseded by Doc 19 (2026-10-07)

The scope model above (`scope_key`, `sorted_trends.scope`, scope-aware markLatest, strict/loose focus) was replaced by `19_TOP5_PER_CATEGORY_PROMPT.md`: selection is `my_categories`, `is_latest` is unique per (`run_date`, category), the writer runs only for each category's top clusters, and the digest is written by full runs only. Existing scoped rows are tagged `legacy` and never join a category set. The sorting animation and the category source registry from this doc are kept (bins now show the selected categories plus off-category and discarded).
