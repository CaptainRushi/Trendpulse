# 19 — Top 5 per Category, Only for My Categories (prompt only)

Today shows **only the top 5 trending topics for each category**, and **only the categories the user selected** are scraped and sorted. Nothing is collected, classified or written for the other categories.

This replaces the "scope" idea of `17_SORT_ANIMATION_AND_CATEGORY_RUN_PROMPT.md` (combined scopes such as `ai+finance`) with something simpler: **one latest set per date and category**. The sorting animation and the category source registry from doc 17 are reused. Prompt only; not wired into `10_MASTER_PLAN.md` or the checker; test names are temporary (`TOP5-nn`).

## 1. Decisions and limits

| Topic | Decision |
|-------|----------|
| My categories | An ordered list in settings (`my_categories`), 1 to `MAX_CATEGORIES` (default 6) of the 14 Jev categories. Empty list: no run starts, Today shows a "pick your categories" card |
| What is scraped | Only the registry sources of the selected categories. General sources (front page, Google Trends and similar) are **not** called, because they cannot know the category before classification. Optional switch `INCLUDE_GENERAL_SOURCES` (default off) with a cost warning |
| What is classified | Only items from those sources, plus today's stored items that already have cached labels whose category is selected. Items of unselected categories are never sent to Jev |
| Assignment rule | Jev category with confidence at least 0.6 and **selected** → that category. Jev category with confidence at least 0.6 but **not selected** → excluded (still stored raw). Confidence below 0.6 → the category whose source found it. An item belongs to exactly one category |
| Top 5 | Per category, by `trend_score`; tie-break more sources, then newer. `TOP_PER_CATEGORY` default 5 (allowed 1 to 10). Fewer than 5 are shown as they are, with a note |
| Cost saver | Score first, write later: clustering and scoring happen before the writer runs, and the writer is called only for each category's top clusters |
| Sets | `is_latest` is unique per (run_date, category). Refreshing one category replaces only that category's set. `sorted_trends.rank` now means rank within the category (1 to 5) |
| Digest | Written only by a full run (all my categories), from the top topics across categories. A single-category refresh never rewrites it |
| Removing a category | Its section disappears from Today; stored data stays and remains visible in Explore. Adding one offers "run for finance now" |
| Hidden topics | A topic hidden by the user leaves 4 in that section, with a note. No backfill (only the top 5 get written text) |
| Limits | Thin categories give fewer than 5 topics. Without general sources `source_count` is lower, so scores are lower overall. Reddit stays blocked without OAuth. Registry feeds and queries must be verified, not assumed |
| Scraping policy | Unchanged: official APIs and RSS first, robots.txt, rate limits, no stealth or challenge bypass |

### What changes compared with earlier docs

| Earlier | Now |
|---------|-----|
| Run scope `all` or `ai+finance`, `sorted_trends.scope` column | No scope. Selection = `my_categories`. Do not add the `scope` column; if doc 17 code already added it, leave it unused and tag old rows `legacy` |
| `TOP_N=50` topics per run | `TOP_PER_CATEGORY=5` per selected category |
| Stages: classify, focus, cluster, write, score | classify, assign, cluster, **score**, **write (top only)**, persist |
| Sorting animation bins = 14 categories | Bins = selected categories plus off-category and discarded |
| `rank` = rank in the whole set | `rank` = rank within the category |

## 2. Layout (Decode design system)

```
today · my categories: [ ai × ] [ finance × ] [ science × ] [ + add ]            [ run now ]   estimate ≈ $0.01
HERO   top topic across my categories · digest line · blocks: categories · topics · items · ai cost
┌ ai  ● updated 06:02 · 4 sources ok · [ refresh ai ] ──────┐ ┌ finance  ● updated 06:02 · 2 sources · [ refresh ] ┐
│ 1  Title of the topic                      92   ▲ rising   │ │ 1  Title …                           88   ● new     │
│    one-line summary · 3 sources                              │ │ …                                                    │
│ 2 …   3 …   4 …   5 …                                       │ │ only 3 topics found · sources may be thin            │
└──────────────────────────────────────────────────────────────┘ └──────────────────────────────────────────────────────┘
(two columns from 1080 px, one below)   click a row → side panel (score parts, angles, evidence)
```

## 3. The prompt

Paste at the repo root. Needs the Today page, the orchestrator and its stages, the collectors and Jev classifier, `dev:fake`, and the Decode-style components. The category registry and sorting animation from doc 17 are used if they exist; otherwise build the registry as step Q2 describes.

````text
You are changing TrendPulse so that Today shows only the top 5 trending topics for each category the user selected, and only those categories are scraped and sorted. Read CLAUDE.md, docs/11_DECODE_REWIRE_AND_UI.md sections 1 and 4, docs/02_TRD.md sections 4, 6, 7 and 8, docs/05_BACKEND_SCHEMA.md section 1, docs/17_SORT_ANIMATION_AND_CATEGORY_RUN_PROMPT.md and docs/19_TOP5_PER_CATEGORY_PROMPT.md sections 1 and 2. Inspect the repo first: the orchestrator and stage list, the collectors and any category registry, whether doc 17's scope code or sorting animation exist, sheets schema registry, API routes, Today and its components, dev:fake.

GOAL
1. The user picks 1 to 6 categories ("my categories"). 2. Runs scrape only those categories' sources and sort only their items. 3. Today shows a panel per selected category with at most 5 topics, each panel refreshable on its own.

DEFINITIONS (follow exactly)
- Categories (slugs lowercase): tech, ai, business, finance, science, health, politics, world, sports, entertainment, culture, gaming, lifestyle, other.
- my_categories: ordered array in settings, 1 to MAX_CATEGORIES (default 6), no duplicates, valid slugs only. Empty = no run starts (preflight blocker NO_CATEGORIES_SELECTED).
- Assignment per item: take the Jev category and its confidence. If confidence >= 0.6 and the category is in my_categories, assign it. If confidence >= 0.6 and the category is not in my_categories, exclude the item (keep the raw row, mark off_category). If confidence < 0.6, assign the target_category (the category whose source found the item; for stored items without a target use no assignment and exclude). Each item gets exactly one category.
- Top: per category sort clusters by trend_score descending, tie-break larger source_count, then newer first item; keep TOP_PER_CATEGORY (default 5, allowed 1-10).
- Sets: is_latest unique per (run_date, category). sorted_trends.rank = rank within the category set (1..5).
- Digest: only a full run (all my categories) writes the daily_digest row; a refresh of a subset does not.
- If doc 17's scope model exists (scope_key, sorted_trends.scope, scope-aware markLatest), migrate to this model: stop using scope, tag existing scoped rows as legacy, and keep the registry and the animation. Do not add the scope column if it does not exist.

PACKAGE Q0 - Plan (10 min)
Reply with a 12-line plan, the files to change, conflicts with the repo and what from doc 17 already exists. Log the definitions in DECISIONS.md. Continue without waiting.

PACKAGE Q1 - Data model, settings, API (50 min)
1. Settings: my_categories (ordered), MAX_CATEGORIES=6, TOP_PER_CATEGORY=5, INCLUDE_GENERAL_SOURCES=false; zod validation; env defaults in .env.example; remove the global TOP_N from the sorter.
2. Migration (next free number): runs.categories_json; items_run.target_category (if missing); topic_index(topic_id, run_id, run_date, category, rank, title, score, evidence_item_ids_json, is_latest) with is_latest unique per (run_date, category) (create or alter the existing table); category_runs(run_id, category, status, items_collected, items_kept, topics, started_at, finished_at, error) for per-category status.
3. Sheets schema registry: trailing columns raw_trends.target_category and runs_log.categories (if missing; update docs/05 section 1 and describe rank as rank within category); idempotent header upgrade that only writes missing empty header cells and never rewrites data. markLatest(date, category, run_id) flips only older rows with the same date and category.
4. API: GET and PUT /api/my-categories; GET /api/today/categories returning, per selected category: {category, status (idle|running|ok|partial|failed|no_sources), last_run_at, sources: [{name, status}], stats: {items_collected, items_kept}, topics: up to TOP_PER_CATEGORY summaries (id, title, one-line summary, category, score, momentum, source_count, rank), note?}; GET /api/trends accepts category and returns that category's latest set (max TOP_PER_CATEGORY).
Tests: TOP5-01 my_categories validation (empty, duplicates, unknown slug, 7 categories, order kept), TOP5-02 is_latest unique per (date, category) and refresh of one category leaves the others, TOP5-03 sheet header upgrade is idempotent and old rows readable, TOP5-04 API shapes with hidden topics excluded and the thin-category note.

PACKAGE Q2 - Category-only collection (70 min)
1. Registry: use docs/17 package S1 and S2 (up to 3 verified sources per category: hackernews keyword search via https://hn.algolia.com/api/v1/search, github topic search, rss feeds, arXiv RSS; reddit subreddits only with OAuth). If the registry does not exist build it now, verifying each endpoint live, recording a fixture and a verified_at date, and dropping anything that fails, is blocked by robots or has unclear terms. Settings let the user add or remove sources and keywords per category (zod, SSRF and robots guards).
2. Collection planner: for the selected categories collect only their registry sources; skip general sources unless INCLUDE_GENERAL_SOURCES (then warn about extra Jev cost in the estimate). Stamp items with target_category. Caps: CATEGORY_MAX_ITEMS=40 per source. Polite http client: User-Agent, at most 1 request per second per domain, robots for feeds and pages. One category failing never stops the others; each gets its category_runs row.
3. Preflight: blocker NO_CATEGORIES_SELECTED; per-category warning CATEGORY_NO_SOURCES (blocker only when no selected category has a usable source).
4. POST /api/runs/estimate {categories?} returns per category and total: sources, expected new items, stored items reused, Jev calls (cache aware), writer calls (top clusters only), cost.
Tests: TOP5-05 only selected categories' sources are called (request log), TOP5-06 general sources skipped by default and included only with the switch, TOP5-07 one failing category does not stop another and statuses are recorded, TOP5-08 politeness and caps, TOP5-09 preflight blockers and warnings, TOP5-10 estimate within 30 percent of actual.

PACKAGE Q3 - Per-category pipeline (90 min)
Stages (update the stage lists in docs/02, docs/04 and docs/10): collect, normalize, dedupe, select, sort_classify, sort_assign, sort_cluster, score, sort_write, persist_sorted, finalize.
1. select: assemble today's items for the selected categories: new items plus stored items that already have a cached Jev label whose category is selected. Stored items without a label are not classified (no Jev spend on unselected categories).
2. sort_classify: Jev questions as in docs/11 for the assembled items only (cache first, budget and fallback as before). Items outside my_categories are never sent to Jev.
3. sort_assign: apply the assignment rule; count assigned, off_category, low-confidence-by-target.
4. sort_cluster: cluster within each category only (trigram, plus the Jev same_story check for borderline pairs).
5. score: compute trend_score per cluster (formula in docs/02 section 7, unchanged), pick the top TOP_PER_CATEGORY clusters per category.
6. sort_write: call the writer only for those top clusters (batches of up to SORT_BATCH_SIZE), same guards as before (zod, repair, split, fallback text).
7. persist_sorted: write at most TOP_PER_CATEGORY rows per category with rank 1..n within the category, flip is_latest for that (date, category) only, update topic_index. Full runs also write the digest from the top topics across categories; a subset refresh does not.
8. POST /api/runs accepts {categories?: [...]} (subset of my_categories; default all); the same pipeline runs for the subset; a subset refresh replaces only those categories' sets. Cron uses all my_categories. Emit events with a category field and a category_status event {category, phase, status}.
Tests: TOP5-11 assignment rule matrix (confidence 0.59, 0.60, 0.61; selected, unselected, no label), TOP5-12 items of unselected categories are never sent to Jev (call counter) and never get a topic, TOP5-13 the writer is called only for the top clusters (at most TOP_PER_CATEGORY per category), TOP5-14 ranks are 1..n within each category and at most 5 rows per category are persisted, TOP5-15 a category with fewer than 5 clusters and an empty category, TOP5-16 subset refresh replaces only its categories and leaves the digest alone, TOP5-17 full run writes one digest, TOP5-18 same-day rerun adds about 0 raw rows and uses cached labels, TOP5-19 Jev down uses the fallback classifier for the items and the writer failing gives fallback text without crashing.

PACKAGE Q4 - Sorting animation integration (30 min, only if doc 17's animation exists)
Bins show only the selected categories plus off-category and discarded; each event carries its category; a subset refresh animates only that category's items. Keep reduced-motion and performance rules.
Tests: TOP5-20 bins match my_categories and counts equal the assignment results.

PACKAGE Q5 - Frontend (120 min)
Design: docs/11 section 4; light only; lowercase copy.
1. "my categories" chip row at the top of Today: add (menu of the remaining categories, max MAX_CATEGORIES), remove (x), reorder (keyboard-accessible move left/right; drag optional). Changes save immediately to /api/my-categories. Adding a category shows "run for finance now". Removing hides its panel; data stays and is reachable in Explore.
2. Onboarding: when my_categories is empty, Today shows one card "pick your categories" with chips and a lime button; the first-run checklist gets this step.
3. CategoryPanel per selected category: header with category pill, status pill, "updated 06:02", sources count with a tooltip listing source statuses, and a "refresh <category>" button that runs only that category (disabled while any run is active). Body: up to 5 rows (rank, title, one-line summary, score, momentum badge, source count). Click a row opens the existing side panel. Notes: "only 3 topics found, sources may be thin", "1 topic hidden by you", "failed: reason, retry", "no usable sources, edit sources in settings". Two columns from 1080 px, one column below; panels refresh independently from category_status events.
4. Hero: top topic across the shown categories (highest score) and the digest line; if docs/16 (live graph) exists, show one series per category's #1 and follow the selected panel.
5. Run button: "run now" runs all my categories; popover shows the estimate per category. While running, panels show running state and the sorting animation if present.
6. Accessibility and states: loading skeleton per panel, empty and error nudges, axe clean, keyboard reachable chips and refresh buttons, aria-live announcement only when a category finishes, all text rendered as text, reduced motion respected.
Tests: TOP5-21 chip add, remove, reorder and persistence, TOP5-22 onboarding when empty, TOP5-23 a panel shows at most TOP_PER_CATEGORY rows with correct notes (thin, hidden, failed, no sources), TOP5-24 per-panel refresh affects only that panel, TOP5-25 estimate popover, TOP5-26 layout at 375, 800, 1280 px with no horizontal scroll, TOP5-27 axe and keyboard, TOP5-28 hostile titles inert.

PACKAGE Q6 - Demo, end to end, live check (60 min)
1. dev:fake: per-category fake sources and fixtures for at least ai, finance and science, with some off-category and low-confidence items so every branch of the assignment rule is exercised; --sort-delay still works.
2. Playwright: choose ai + finance only, run; assert only those categories' fake sources were requested, at most 5 topics per panel, no panel for science, Jev classified only those items, the writer was called only for the top clusters; refresh finance only and assert the ai panel is unchanged; add science and run it; remove ai (panel hidden, data kept in Explore); cron-style run uses my_categories; empty selection shows onboarding; screenshots at 375, 800 and 1280 px into test-runs/evidence/<date>/.
3. Live check (needs real keys): a real run for two categories (for example ai and finance). Report per category: sources and status, items collected, items kept after assignment, share excluded as off-category, topics produced (5 or fewer and why), Jev calls and cost, writer calls, duration, and sources you dropped. State honestly if a category is too thin.

PACKAGE Q7 - Close-out (20 min)
Run lint, typecheck, unit, API and e2e suites. Update docs/05 (rank within category, new columns), docs/02, docs/04 and docs/10 stage lists, add a note to docs/17 that scope was replaced. Update DECISIONS.md and NEXT.md. Final report: generated counts, defects, what is live-verified and what only against fakes.

RULES
- Follow CLAUDE.md. Tests first. Windows-safe scripts. No new heavy dependencies. Never log keys.
- Unselected categories are never scraped, classified or written. Verify this with call counters, not by reading code.
- Commit per package: `top5-Qn: summary`. After each package report in 6 lines: status, time vs box, tests passing/total, deviations, needs from me, next. Keep going unless blocked.
- CUT ORDER if late: drag reordering, estimate popover, INCLUDE_GENERAL_SOURCES switch, hero integration, Explore history link.
````

## 4. Acceptance checklist

- [ ] No categories selected: Today shows the "pick your categories" card, runs do not start
- [ ] Only selected categories' sources are requested; call counters show no Jev or writer work for others
- [ ] Each selected category shows at most 5 topics, ranked 1 to 5 within the category
- [ ] "refresh ai" changes only the ai panel; the digest changes only after a full run
- [ ] Adding, removing and reordering categories persists and behaves as described
- [ ] Thin, hidden, failed and no-source states show plain notes
- [ ] A real two-category run is reported with items, kept share, topics, cost and dropped sources

## 5. Not yet wired

No requirement numbers, health rows or phase in the plan, and the docs checker does not track `TOP5-nn`. Docs 02, 04, 05 and 10 still show the older stage list and global `TOP_N` until the prompt's close-out step (or a wiring pass) updates them.
