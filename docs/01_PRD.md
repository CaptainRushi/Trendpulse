# 01 — Product Requirements Document (PRD)

**Product:** TrendPulse
**Version:** 1.0 (MVP)
**Type:** Local-first web app (runs on the user's own machine)

---

## 1. Problem

Content creators, marketers, founders and researchers spend 1–2 hours a day checking Reddit, Hacker News, Google Trends, YouTube, news sites and GitHub to learn what is trending. The work is repetitive, scattered across tabs, and nothing is saved in a form they can filter, share or build on.

## 2. Solution

A local app that, once a day (and on demand):

1. **Collects** trending items from many internet sources.
2. **Stores** every raw item in a Google Sheet (`raw_trends`).
3. Has **Jev** (AI model) cluster, score, categorize and summarize the raw items into ranked topics, written to a second sheet (`sorted_trends`) plus a `daily_digest`.
4. Shows everything in a **localhost dashboard** where anyone can browse, filter, and copy content ideas.

AI calls go through **OmniRoute** (or any OpenAI-compatible router), so the user can use free or cheap models with automatic fallback.

## 3. Target users

| Persona | Need | Success looks like |
|---------|------|--------------------|
| Creator (YouTube, X, LinkedIn, blog) | Daily topic ideas with angles | Opens dashboard at 8am, picks 2 topics in 5 minutes |
| Marketer / social manager | Spot niche trends early | Filters by category, exports to CSV |
| Indie hacker / founder | Market and tech signals | Sees rising GitHub / HN / PH items |
| Team lead | Shared source of truth | Team opens the same Google Sheet |
| Developer who clones the repo | Easy local install | Working in under 10 minutes |

## 4. Goals

- G1: Fully automatic daily run with zero manual steps after setup.
- G2: Every raw item and every ranked topic is inspectable in Google Sheets.
- G3: Setup in ≤ 10 minutes for a non-expert, using a guided wizard.
- G4: Works with free models; total AI cost near zero on a free-tier router.
- G5: A run never corrupts data: idempotent, resumable, dedupes across days.

## 5. Non-goals (MVP)

- No cloud hosting, multi-tenant accounts or billing.
- No bypassing logins, paywalls, captchas or robots.txt.
- No posting to social platforms.
- No mobile app (dashboard is responsive only).
- No historical backfill of trends older than the day of first run.

## 6. User stories

- US-1: As a user, I run the setup wizard and connect my Google Sheet, my OmniRoute URL and my Jev model, and each connection is tested before I continue.
- US-2: As a user, I see today's ranked topics with a summary, category, score and why it is trending.
- US-3: As a creator, I see 3 content angles per topic and can copy them.
- US-4: As a user, I click **Run now** and watch live progress per source.
- US-5: As a user, I enable or disable each source and add my own RSS feeds or page URLs.
- US-6: As a user, I filter by date, category, source and text search.
- US-7: As a user, I open the raw sheet or sorted sheet in Google Sheets with one click.
- US-8: As a user, I re-run only the sorting step if Jev failed or I changed the model.
- US-9: As a user, I see errors per source without the whole run failing.
- US-10: As a user, I export the day's topics as CSV or Markdown.

## 7. Functional requirements

### 7.1 Collection
- FR-1 Collectors for: Hacker News, Reddit, Google Trends (daily RSS), GitHub (new repos by stars), Wikipedia most-read, generic RSS list, generic web page list. (v1.1: YouTube, Product Hunt, Dev.to.)
- FR-2 Each collector returns normalized items (see schema) and per-source stats.
- FR-3 Source failure is isolated; run status becomes `partial`, not `failed`.
- FR-4 Respect robots.txt for web-page collector, honor per-domain rate limit, send a clear User-Agent.
- FR-5 Optional niche keywords bias collection and sorting.

### 7.2 Processing
- FR-6 Canonicalize URLs, hash items, dedupe within the run and against the last N days (default 3).
- FR-7 Messy pages go through an OmniRoute LLM extraction step that returns title, snippet, entities, publish date.
- FR-8 Engagement is normalized per source to a 0–1 value by code, not by the LLM.

### 7.3 Storage (Google Sheets)
- FR-9 App creates required tabs and headers (`raw_trends`, `sorted_trends`, `daily_digest`, `runs_log`) on demand.
- FR-10 `raw_trends` is append-only. Retention job archives or deletes rows older than `RETENTION_DAYS`.
- FR-11 Writes are batched and rate-limit safe.

### 7.4 Sorting (Jev)
- FR-12 Jev clusters raw items into topics, categorizes, summarizes, rates relevance and novelty, assigns momentum and sentiment, and proposes 3 content angles.
- FR-13 Final `trend_score` is computed by code from Jev ratings plus engagement and source diversity (formula in TRD).
- FR-14 Output validated against a schema. Invalid output triggers repair, then batch split, then a marked failure.
- FR-15 A `daily_digest` row holds a 3–5 sentence summary of the day.

### 7.5 Dashboard
- FR-16 Pages: Today, Explore (any date), Raw Data, Sources, Runs, Settings, Setup Wizard.
- FR-17 Live run progress by server-sent events.
- FR-18 Data comes from Google Sheets through a short-lived cache with a manual **Sync** button.
- FR-19 Binds to `127.0.0.1` by default. Optional password.

### 7.6 Scheduling
- FR-20 Cron schedule, default daily 06:00 local time.
- FR-21 If the app was off at schedule time, run once on next start (configurable).
- FR-22 One run at a time. Overlap is refused with a clear message.

## 8. Non-functional requirements

| Area | Requirement |
|------|-------------|
| Performance | Full run ≤ 10 min with 8 sources and ~400 items. Dashboard page load ≤ 1.5 s from cache |
| Reliability | Idempotent runs. Crash mid-run resumes without duplicate rows |
| Security | Secrets only in `.env` / `secrets/`, never logged, never sent to the browser |
| Privacy | Only public data collected. No personal accounts scraped |
| Portability | Windows, macOS, Linux. Node 20+. Optional Docker |
| Accessibility | WCAG 2.1 AA, keyboard navigable |
| Cost | Runs on free-tier models. Token use logged per run |

## 9. Success metrics

- Setup completed in ≤ 10 min by a new user (target 80%).
- ≥ 95% of scheduled runs finish `success` or `partial`.
- ≥ 90% of Jev outputs valid on first attempt.
- Duplicate topics on the same day < 5%.
- User picks ≥ 1 topic per day (self-reported in pilot).

## 10. Scope

| Release | Contents |
|---------|----------|
| MVP (v1.0) | 7 collectors, Sheets storage, Jev sorting, dashboard, cron, wizard, CSV export |
| v1.1 | YouTube, Product Hunt, Dev.to, Slack/Telegram digest, Playwright fallback on by default |
| v2 | Trend history charts, embeddings clustering, multi-sheet profiles, plugin collectors |

## 11. Assumptions

- User has a Google account and can create a service account (guided in wizard).
- OmniRoute (or another OpenAI-compatible router) runs locally, default `http://localhost:20128/v1`.
- Jev is reachable through an OpenAI-compatible chat endpoint (via OmniRoute or direct). Model id is configurable.
- Machine is on at least some time each day.

## 12. Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Site blocks scraping or changes layout | Missing data | Prefer official APIs/RSS, isolate failures, source health page |
| Terms-of-service violations | Legal | Public data only, robots.txt respected, no login bypass, docs warn user |
| Google Sheets quota (per-minute limits) | Failed writes | Batch appends, single writer queue, exponential backoff |
| Sheet grows too large | Slow, hits cell cap | Retention + archive tab |
| LLM returns invalid JSON | Broken sorting | Schema validation, repair prompt, batch split |
| Free model quota exhausted | Stalled run | OmniRoute combo fallback, resumable stages |
| Hallucinated summaries | Wrong info | Jev only sees fetched text, must cite item ids, discarded items listed |

## 13. Open questions (defaults chosen, change if needed)

1. Which niche(s) should be default? → none (general trends).
2. Which region for Google Trends? → `US`, configurable.
3. Is Jev served via OmniRoute or its own endpoint? → both supported through separate env vars.

## 14. Release criteria

All acceptance checks in `06_IMPLEMENTATION_PLAN.md` §Definition of Done pass on a clean machine.
