# 13 — Feature Test Plan (test every feature)

Runbook to prove, feature by feature, that the platform works. Every health row in `10_MASTER_PLAN.md` §5 (69 rows: F01–F54, S01–S06, J01, J02, U01, D01–D06) has a manual walk here, and every test ID is mapped to a feature (§10). The docs checker enforces both.

Relationship to other docs: `07` and `11` hold the test-case catalogue (steps and expected results per ID), `10` schedules them, `npm run verify` runs the automated mirror. This file is the **human walkthrough plus the plan around it**: environments, data, order, journeys, negative cases, non-functional checks, data probes, sign-off.

## 1. Tiers

| Tier | What | Time | When |
|------|------|------|------|
| 0 Preflight | `npm run doctor`, `npm run verify` (fake) | 5 min | Before any manual testing |
| 1 Smoke | §3, 14 steps | 15 min | Every build, every phase gate |
| 2 Feature walk | §4, rows up to the current phase | MVP rows ≈ 4 h, v1.1 ≈ 1.5 h, v1.2 ≈ 1 h | Each phase gate (only that phase's new rows) and each release (all rows) |
| 2b Journeys | §5, 10 end-to-end scenarios | 2 h | Release candidates |
| 3 Release | `verify --mode live`, chaos drills (§6), security and non-functional (§7), soak 72 h wall time | 4 h plus soak | Release candidates |

Rule: a row passes only when its automated tests are green **and** its manual walk matches the expected result. Record each result in the run log (§11).

## 2. Environments and data

### 2.1 Modes

| Mode | Command | Backends | Credentials | Use |
|------|---------|----------|-------------|-----|
| Fake | `npm run dev:fake` | Fake Sheets, fake OmniRoute, fake Jev, recorded source fixtures, local test site, seeded data | None | Tier 0–2 manual walks, visual checks |
| Live | `npm run dev` with real `.env` | Test spreadsheet `TrendPulse-TEST`, real OmniRoute, real Jev, real sources | Yes | Tier 3, "live" parts of rows |
| Hybrid | `npm run dev:fake -- --live-sheets` | Real Sheets only | Google only | Sheet-side checks |

`dev:fake` options: `--now=2026-10-05T05:59:30Z` fake clock (cron, catch-up, dates), `--jev=ok|bad_choice|missing_answer|http429|timeout`, `--writer=ok|invalid|timeout`, `--sheets=ok|http403|http429|deleted_tab`, `--source-fail=reddit,github`. Every manual walk below that says "fake switch" uses these.

Live mode refuses to run unless the spreadsheet title starts with `TrendPulse-TEST`.

### 2.2 Golden dataset (`npm run seed:test`)

Loads 100 items into the fake collectors and seeds `seen_items` so outcomes are known. Exact expectations live in `server/test/golden/expected.json`.

| Group | Items | Purpose |
|-------|-------|---------|
| Normal items across Hacker News, Reddit, Google Trends, GitHub, Wikipedia, RSS | 60 | Baseline |
| Near-duplicate pairs (same story, different wording, different sources) | 10 (5 pairs) | Clustering |
| Exact duplicates with tracking params in the URL | 5 | Canonicalize and dedupe |
| Spam, ad and empty-noise items | 8 | Quality filter |
| Hostile strings: script tags, prompt-injection text, 10,000-character title, emoji, right-to-left text | 5 | XSS, injection, caps |
| Items without engagement numbers | 4 | Position fallback (overlaps the groups above) |
| Items already seen yesterday | 3 | Cross-day dedupe |
| Items matching the niche "ai agents" | 5 | Niche fit |

Expected pipeline counts after a first run: 100 collected; 5 exact duplicates merged; 5 near-duplicate pairs merged; 3 dropped as seen yesterday; 8 discarded by the quality filter; topic count equal to the golden value; rerun the same day adds 0 raw rows.

### 2.3 Other test assets

| Asset | Detail |
|-------|--------|
| Test spreadsheet | `TrendPulse-TEST`, shared with the service account; a second blank sheet for init tests |
| Local test site | Static page, JS-rendered page, `robots.txt`, layout A and layout B of one list, 403, 429, challenge page, slow page, oversized page, redirect to a private address |
| Decode CSV samples | 200 valid rows; a file with 10 bad rows; a file with 2,001 rows |
| Browsers | Chrome, Edge, Firefox, Safari (latest) |
| Viewports | 375, 800, 1280, 1920 px; zoom 200% |
| Operating systems | Windows 11, macOS, Ubuntu; Node 20 and 22 |
| Tools | `sqlite3` CLI, `curl`, browser devtools, axe, a phone on the same network |

## 3. Tier 1 smoke test (15 minutes, fake mode)

| # | Step | Expected |
|---|------|----------|
| 1 | `npm run doctor` | All checks pass |
| 2 | `npm run dev:fake`, open `http://localhost:4317` | Today loads in the paper/lime design, no console errors |
| 3 | Press **run now** | Status pill shows running, flow strip advances through all stages |
| 4 | Wait for done | Hero blocks show topics, items, sources ok, ai cost; topic list filled |
| 5 | Click the first topic | Side panel shows score parts, why trending, 3 angles, evidence links |
| 6 | Filter by a category and search a word | List narrows; URL query string updates; reload keeps it |
| 7 | Open **runs** | Latest run listed with all stages done and per-source table |
| 8 | Open **sources**, disable one source, **run now** | That source shows skipped in the new run |
| 9 | **settings** → test connection for sheets, omniroute, jev | Each shows a ✓ pill |
| 10 | **sheet ↗** | Opens the sheet tab with rows from this run |
| 11 | Export CSV from Today | File opens with correct columns |
| 12 | Run now again | 0 new raw rows, topics refresh |
| 13 | `npm run verify` | All rows for the current phase PASS |
| 14 | Stop and restart the app | Data still there; next run time shown |

## 4. Tier 2 feature walk

Columns: **Row** (health row), **Manual steps**, **Expected result**, **Automated** (test IDs that must also be green). Use fake mode unless a step says live.

### Area A — Setup, config, security, packaging

| Row | Feature | Manual steps | Expected result | Automated |
|-----|---------|--------------|-----------------|-----------|
| F01 | Setup wizard completes | Start with no `data/` folder. Walk the first-run steps: sheets (key file and sheet id), omniroute (URL, key, model), jev (URL, key, model), sources, niches, schedule. Enter a wrong value at each test once. Close the browser at step 3 and reopen. | Each test shows a ✓ pill or a specific error with a fix hint; next step unlocks only after a pass; reopening resumes at step 3; finishing sets setup complete, starts the first run and lands on Today | W-11, SET-01…09 |
| F32 | Settings with connection tests | Open settings. Put a junk Jev model, press test connection; fix it. Set schedule to every 5 minutes and save. Change niches. Check secrets fields. | Test result pill appears, save stays disabled until a pass; the next run time in the top bar changes without restart; secrets show •••• with a replace button | UI-11, API-11, API-12, W-17 |
| F34 | Open-in-Sheets links | Press **sheet ↗** on Today and on Raw Data. | Each opens the correct spreadsheet tab | UI-16, API-13 |
| F35 | Exports | Export topics CSV and Markdown from Today. Open the CSV in Excel. | UTF-8 with BOM; commas, quotes and newlines escaped; row count equals the list; Markdown has title, score, angles, links | API-14 |
| F36 | Localhost bind and password | Check the listening address (`ss -ltn` on Linux, `netstat -an` on Windows). From a phone on the same network request the app. Set `HOST=0.0.0.0` with no password. Then set `DASHBOARD_PASSWORD`. | Listens on 127.0.0.1 only; phone cannot connect; app refuses to start without a password; with a password every route except health answers 401 without credentials | SEC-01, SEC-02, SEC-03, API-16 |
| F37 | Retention | In the test sheet backdate `collected_at` on 50 raw rows to 40 days ago, run the pipeline with retention 30 days (archive mode, then delete mode). | Old rows move to the archive tab or are removed; counts recorded in `runs_log`; recent rows untouched | SHT-11, SHT-12, RUN-15 |
| F38 | Secrets never leaked | Run a full pipeline with debug logging. Search logs, API responses and browser storage for the Jev key, OmniRoute key, password and the key-file private key. | Zero matches anywhere | SEC-05, SEC-06, SEC-07 |
| F39 | Doctor and setup CLI | On a clean checkout run the setup CLI, then break one thing at a time (bad sheet id, OmniRoute stopped, wrong Jev key, scraper stopped, browsers missing) and run doctor. | Setup writes `.env` without echoing secrets; each failure prints a specific fix hint (browsers missing says to run the scraper setup); healthy state prints all ✓ | PKG-04, PKG-05, SCR-20, SET-10 |
| F40 | Clean install in 10 minutes | On a fresh machine or container follow the README only, with a stopwatch. | Today shows data within 10 minutes | PKG-01 |
| U01 | Design-system conformance | Open every page at 375, 800, 1280 px. Check paper background, lime primary buttons, Geist and Geist Mono, 4 px radius, lowercase copy. Block external font hosts in devtools and reload. Enable reduced motion. | Matches the design tokens; fonts load locally; no horizontal scroll; no animation under reduced motion; contrast passes | STY-01…05 |

### Area B — Collection and scraping

| Row | Feature | Manual steps | Expected result | Automated |
|-----|---------|--------------|-----------------|-----------|
| F03 | Hacker News | `npm run collect -- --source hackernews --limit 10` (fake, then live). | 10 items with title, url, points, comments; ids unique; stats ok | COL-01 |
| F04 | Reddit | Collect reddit. Fake switch: `--source-fail=reddit` and a 429 fixture. | Items with upvotes and comments; on 403 or 429 status `blocked`, no hammering | COL-02 |
| F05 | Google Trends | Collect with geo US then IN. | Items with traffic numbers parsed ("200K+" becomes 200000); geo changes the results | COL-03 |
| F06 | GitHub | Collect with and without a token. | Items with stars and forks; rate limit respected without a token | COL-04 |
| F07 | Wikipedia | Collect wikipedia. | No Main_Page or Special pages; views parsed | COL-05 |
| F08 | RSS | Add two feeds in sources, collect twice. | Items from both; second fetch is conditional (304 handled) | COL-06 |
| F09 | Web page and extraction | Add an article URL and a login-wall URL as `webpage` sources, run. Fake switch: stop OmniRoute once. | Article gets title and snippet; login wall is marked not an article and skipped; with OmniRoute down webpage items are skipped and others continue | COL-07, LLM-01, LLM-02, LLM-03 |
| F10 | Source failure isolation | Run with `--source-fail=reddit,github`. | Run status partial; other sources complete; sources page shows the error text for the two | COL-08, RUN-03 |
| F11 | Robots and rate limits | Add a URL disallowed by the test site's `robots.txt` and five URLs on one domain. | Disallowed URL skipped with a "robots" log line, zero requests to it; requests to one domain are at least 1 s apart | COL-10, COL-11 |
| F12 | Niche keywords | Set niches to "ai agents", re-sort the same data. Clear niches, re-sort. | Niche-fit question is asked only with niches; niche topics rise in rank, then fall back | COL-12, SRT-11 |
| S01 | Sidecar healthy and supervised | Open settings → scraper status. Kill the sidecar process four times within five minutes. | Status ok; supervisor restarts it three times then the breaker opens and shows open; recovers after the cool-down | SCR-01, SCR-13 |
| S02 | HTTP and browser fetch | In recipes, test a static page and the JS-rendered test page with mode auto. Test the slow and the oversized pages. | Static page via http; JS page escalates to browser once and content is present; domain hint stored; slow page times out cleanly; oversized page rejected | SCR-02, SCR-03, SCR-06, SCR-11, SCR-23 |
| S03 | Politeness, blocked handling, no stealth | Test the 403, 429 and challenge pages. Send a fetch request with mode `stealth`. | Status blocked, one retry after backoff, then skipped with advice to use an API or RSS; stealth mode returns 400 | SCR-04, SCR-05, SCR-10, SCR-18 |
| S04 | SSRF protection | Enter these URLs in a recipe: localhost, `10.0.0.5`, `169.254.169.254`, `[::1]`, a `file:` URL, a hostname resolving to a private IP, a link that redirects to a private IP. | Every one is rejected as SSRF in normal mode | SCR-14 |
| S05 | Recipes and adaptive healing | Create a recipe on layout A of the test site, test, save. Switch the site to layout B (class names changed) and test. Then switch to a layout with no match. | Layout B still returns items and health shows healed with an amber banner; no-match layout shows broken with a clear error and the run continues | SCR-07, SCR-08, SCR-09, SCR-16, SCR-24 |
| S06 | Recipes UI, API and fallback | Create, edit and delete a recipe. Try more than 10 fields, an XPath selector, a bad URL. Try saving before a passing test. Stop the sidecar and run. | CRUD works; validation errors are clear; save stays disabled until a test passes; with the sidecar down `webpage` falls back to plain fetch and recipe sources show scraper unavailable; run is partial; no page bodies in logs | SCR-12, SCR-15, SCR-17, SCR-19, SCR-22 |

### Area C — Processing

| Row | Feature | Manual steps | Expected result | Automated |
|-----|---------|--------------|-----------------|-----------|
| F13 | Canonicalize and dedupe | Run on the golden dataset, then run again. Look at the raw sheet for the five tracking-parameter duplicates and the five near-duplicate pairs. | One row per canonical URL; near-duplicates merged with the other source in `merged_sources`; items seen yesterday dropped; second run adds 0 raw rows | NRM-01…05 |
| F14 | Engagement normalization | Read `engagement_norm` in the raw sheet. | All values between 0 and 1; the top item of each source is 1; items without engagement use the position score | NRM-06, NRM-07 |

### Area D — Storage and Google Sheets

| Row | Feature | Manual steps | Expected result | Automated |
|-----|---------|--------------|-----------------|-----------|
| F02 | Tabs auto-created | Point the app at the blank sheet, run init twice. Delete a tab, then trigger a write. | Required tabs with headers and a frozen first row; second init changes nothing; the deleted tab is recreated automatically | SHT-01, SHT-02 |
| F15 | Raw rows written | Run the golden dataset. Compare the sheet row count for the run with the persisted count. Seed 1,200 items and run. | Counts match; rows only appended, never edited; 1,200 rows go out in three batches of at most 500 | SHT-03, SHT-16 |
| F33 | Cache and Sync | Open Today. Edit a title cell in `sorted_trends`. Reload within 60 seconds, then press sync. | Old title until sync, then the new title; cache age shown | SHT-10, API-03 |

### Area E — Classification and sorting

| Row | Feature | Manual steps | Expected result | Automated |
|-----|---------|--------------|-----------------|-----------|
| J01 | Jev typed classification | Settings → test jev. Run 20 items. Run again on the same items. Set a very low run budget and run. Check the `item_labels` table and the ai cost block. | Every item has category, quality, novelty and sentiment with confidence between 0 and 1; the second run makes no new Jev calls; cost is recorded; budget exhaustion stops classification and marks the run partial with the rest pending | JEV-01…06, JEV-08…11, JEV-13 |
| J02 | Fallback classifier | Fake switch `--jev=timeout`, or use a wrong Jev key (live). Run. | Run completes; labels show the fallback classifier; run is flagged "fallback classifier used" | JEV-07, JEV-12 |
| F16 | Clustering and topic text | Run the golden dataset. Compare with the golden clusters. | Near-duplicates share a topic, unrelated items stay apart; every topic has a title under 140 characters, summary under 280, 3 angles; evidence links resolve to raw rows | SRT-01…04 |
| F17 | Score and rank | Compare scores with `expected.json`. Change score weights in settings and re-sort. | Scores match the golden values and stay between 0 and 100; ranks are contiguous; new weights change the order; momentum follows the rules and never shows fading | SRT-05, SRT-06, SRT-07, SRT-14 |
| F18 | Bad Jev or writer output handled | Fake switches: `--jev=bad_choice`, `--jev=missing_answer`, `--writer=invalid`. | No crash; flags visible; run partial with reasons; re-sort only offered | SRT-08, LLM-06, LLM-07 |
| F19 | Daily digest | Run and read the hero line and the `daily_digest` row. | 3–5 sentences using only top topics | SRT-10 |
| F20 | Sorted rows and latest flag | Change the writer model, press re-sort on the same date. | New rows appended, older rows flagged not latest, UI shows only the latest, models recorded in the row | SHT-08, SRT-15 |

### Area F — Runs and scheduling

| Row | Feature | Manual steps | Expected result | Automated |
|-----|---------|--------------|-----------------|-----------|
| F21 | Cron | Set the schedule to the next minute (fake clock or live). Wait. | Run starts at that minute in the app timezone; next run time updates | RUN-09 |
| F22 | Missed-run catch-up | Stop the app, move the clock past the schedule with no success today, start the app. | One catch-up run with trigger catch-up and a toast | RUN-10 |
| F23 | Single run lock | Press run now twice quickly; call the run route twice. Kill the app mid-run, wait over 5 minutes, restart. | Second request says a run is already in progress (409); stale lock is recovered and the old run becomes interrupted | RUN-07, RUN-08 |
| F24 | Crash resume | Kill -9 the app during sorting, restart, resume. | Run continues from the first stage not done; no duplicate raw rows; final result equals a clean run | RUN-05 |
| F25 | Re-sort and retry | On the runs page press retry failed stage; press re-sort only. | Retry continues from the failed stage; re-sort uses stored items and creates a new latest set | RUN-06, RUN-11 |
| F26 | Live progress | Start a run with slow fake collectors; open the runs page in a second tab, then a third tab late. | Pill, flow strip and per-source rows update live; the late tab sees the last 50 events; stream stays open with heartbeats | RUN-12, UI-04 |

### Area G — Dashboard pages

| Row | Feature | Manual steps | Expected result | Automated |
|-----|---------|--------------|-----------------|-----------|
| F27 | Today page | Open Today. Filter by category, search, move the date. Reload. Open with no data and with a broken connection. | Hero blocks, flow strip, filters and list correct; filters live in the URL and survive reload; empty and error states show a plain sentence and one button | UI-02, UI-03 |
| F28 | Topic side panel | Click a topic. Copy an angle and the whole topic as Markdown. Open evidence links. | Score parts, why trending, 3 angles; copy shows a toast and the clipboard matches; links open in a new tab safely | UI-05, UI-06 |
| F29 | Explore and Raw Data | Explore a date range, switch cards and table, compare two dates. On Raw Data filter by source and status, search, export CSV, scroll with 10,000 rows. | Compare lists new, gone and rising topics; raw table scrolls smoothly and filters work | UI-07, UI-08 |
| F30 | Sources page | Toggle a source off and run. Add a custom RSS feed and test it. Look at a source missing its key. | Disabled source skipped next run; feed test works; requirement hint shown for the missing key | UI-09, API-07 |
| F31 | Runs page | Open a past run. Use the log level filter, retry and re-sort buttons. | Stages, per-source table, tokens and cost shown; actions work | UI-10 |

### Area H — Own-content pack (v1.1)

| Row | Feature | Manual steps | Expected result | Automated |
|-----|---------|--------------|-----------------|-----------|
| F41 | Creator profile applied | Settings → creator: fill niches, audience, tone, language, avoid-list, two voice samples. Generate a draft. Check logs. | Draft follows tone and language; avoid-list terms absent; voice samples never in logs | PRF-01…04 |
| F42 | Feedback buttons | Like, dislike, hide and mark used on four topics. Reload. Use show hidden. Set `hidden` to TRUE on a row in the sheet and sync. | States persist and are announced; hidden topics vanish and return with show hidden; the sheet flag also hides | FBK-01…04 |
| F43 | For-you ranking | Give 20 feedback clicks (likes on AI, dislikes on Politics). Toggle trending and for you. Check the digest preview. | Order differs; the panel explains the fit; digest uses the same order | FBK-05…07, FBK-09, UI-19 |
| F44 | Personalization summary and reset | Open settings → personalization. Reset. | Top affinities listed; reset clears events and the order returns to the global one | FBK-08 |
| F45 | Drafts in six formats | On one topic generate each format, 3 variants, and one with the instruction "shorter, for beginners". | Each format meets its rules; variants differ; instruction reflected | GEN-01, GEN-07, GEN-08 |
| F46 | Draft guards | Use a topic whose evidence has no numbers; ask for a thread that runs long. | Invented numbers listed in fact notes; "too close to source" flag when text copies evidence; thread posts at most 280 characters or flagged | GEN-02…06, GEN-12 |
| F47 | Draft edit, regenerate, copy, export | Edit a draft, copy it, regenerate, export Markdown. | Edits saved apart from the original; regenerate keeps the old version; export equals what is on screen | GEN-09, GEN-10, UI-21 |
| F48 | More angles | Press more angles, add focus "contrarian", save one. | 5 distinct angles; saving creates an idea in the inbox | ANG-01…03 |
| F49 | Ideas board | Create from an angle, drag to drafting, move another with the keyboard, set date, notes and posted URL, save the same angle twice. | Moves persist; keyboard move works and is announced; invalid URL rejected; duplicate returns the existing idea | IDEA-01…05, IDEA-09, IDEA-10, UI-23 |
| F50 | Idea event log and CSV | After a few changes open the `content_ideas` tab; export ideas CSV. | One event row per change; CSV complete | IDEA-06…08 |
| F51 | Telegram digest | Notifications → test, preview, then run. | Message on the phone within 4,096 characters, top N correct, text escaped | DIG-01, DIG-02, DIG-11 |
| F52 | Slack digest | Same for Slack. | Message in the channel | DIG-03 |
| F53 | Email digest | Same for email. | Email with text and HTML parts arrives | DIG-04 |
| F54 | Digest idempotent, isolated, modes | Run twice the same day; press send again; stop the Telegram fake and run; switch to scheduled mode; trigger a failed run; use a partial run. | One message per date and channel; resend forced works; a failing channel does not fail the run and is retried three times; failure notice only if enabled; partial run notes "7 of 8 sources worked"; no topics sends nothing | DIG-05…10, DIG-12, DIG-13 |

### Area I — Format Decode (v1.2)

| Row | Feature | Manual steps | Expected result | Automated |
|-----|---------|--------------|-----------------|-----------|
| D01 | Library, collection, CSV import | Create a library with 6 formats; try 0, 13 and duplicate keys. Build a collection by source and date. Import the 200-row, 10-bad-row and 2,001-row CSVs. | 1–12 formats accepted and `none` added; invalid libraries rejected; bad CSV rows reported by line number, valid rows kept; 2,001 rows rejected | DEC-01…03 |
| D02 | Classification, cost control, resume | Read the estimate, run 60 items, cancel midway, resume. Try a collection above the item cap. | Estimate within 20% of the actual cost; over-cap runs ask for confirmation; cancel stops spending; resume reuses cached labels | DEC-04, DEC-05, DEC-09 |
| D03 | Analytics | Run the golden decode dataset. Include a format with 4 items and a mixed-source collection. | Median not mean; multiple equals format median divided by overall median; 4-item format shown as too small and never the winner; normalized axis labeled | DEC-06…08 |
| D04 | Persistence, API, exports | Finish a run, reopen it from history, export CSV and Markdown, open the `decode_results` tab. | Same numbers everywhere | DEC-10, DEC-11, DEC-16 |
| D05 | Chart, chips, panel, table | Hover and click dots, click chips, read the table, play replay, enable reduced motion. | Log-scale scatter; chip highlights its format; panel shows hook, numbers, text excerpt, link; table sorted by median with the winner marked and thin rows dimmed; replay plays once and is off under reduced motion | DEC-12…15 |
| D06 | Thumbnails, live decode, Jev-down drill | Enable thumbnails and try a private image URL and a non-image URL. Decode 100 real items (live). Stop Jev mid-run. | Proxy rejects private and non-image URLs; winners look sensible to a human; fallback classifier finishes the run as partial | DEC-17…19 |

## 5. Journeys (end-to-end, Tier 2b)

| # | Journey | Steps | Expected | Seams |
|---|---------|-------|----------|-------|
| SC-01 | First day | Install, wizard, first run, read Today, open a topic, export CSV | Working dashboard with data in under 10 minutes; sheet tabs filled | W-11, W-07 |
| SC-02 | Unattended days | Leave cron running 3 days (live) | Each day a success or partial run; day 2 and 3 drop yesterday's items; no duplicate rows; retention works; `runs_log` grows | W-07, NFR-03 |
| SC-03 | Bad day | One run with Reddit blocked, Jev down and Sheets returning 429 once | Run partial; fallback classifier used; writes retried; every problem visible in runs and flagged | W-07, W-08, CH-02…05 |
| SC-04 | Creator flow | Pick a topic, like it, write a thread, read fact notes, edit, save as idea, move to ready, mark posted | Idea has event rows; next morning's digest excludes the used topic | W-13, W-14, W-15, W-16 |
| SC-05 | Digest day | Run in after-run mode with Telegram, Slack and email; take Telegram down; resend | Others delivered, Telegram retried then failed in history; resend works; run unaffected | W-16, CH-12 |
| SC-06 | Decode flow | Import 200 CSV rows, define 6 formats, estimate, run, read winners, export, reopen | Same numbers on screen, in exports and in the sheet | W-22 |
| SC-07 | Upgrade path | Take an MVP database and sheet, start the v1.1 build, then the v1.2 build | Data intact; new tabs created once; migrations apply in order | W-19 |
| SC-08 | Recovery | Corrupt `state.db`, rebuild state, run; delete a sheet tab, run | Rebuild restores dedupe state, next run adds no duplicates; tab recreated automatically | CH-09, SHT-06 |
| SC-09 | Offline | Turn the network off, browse the dashboard, run, restore the network, run | Dashboard works from cache with a banner; run fails with a clear message; later run succeeds | NFR-05 |
| SC-10 | Hot reload | Change Jev model, writer model, niches, schedule and creator profile without restart | Next run, sort and draft use the new values | W-17 |

## 6. Negative, boundary and chaos testing

### 6.1 Break-it matrix

| Area | Cases to try |
|------|--------------|
| Config | Missing required variable, wrong type, port in use, unreadable key file, wrong sheet id |
| Collectors | Empty list, one item, 10,000 items, malformed JSON or XML, redirect loop, timeout, gzip body, non-UTF-8 text |
| Items | Missing title, missing URL, title of 10,000 characters, emoji and right-to-left text, HTML and script tags, identical items from five sources |
| Dedupe | Same story with different URLs, same URL with different casing and parameter order, item that reappears after 4 days |
| Sheets | Empty spreadsheet, tab renamed, header row edited by hand, number typed into a text cell, cell over 50,000 characters, 429 burst, 403, offline |
| Jev | Unknown choice, missing answer, confidence outside 0–1, 429 with Retry-After, timeout, 500, wrong key, state over 4,000 characters, injection text |
| Writer | Fenced JSON, trailing text, invalid JSON twice, unknown cluster id, missing cluster, empty output, very slow reply |
| Runs | Two triggers at once, restart during each stage, run across midnight, clock moved back, cron string invalid |
| API | Missing and extra fields, wrong types, limit over 100, unknown id, very long query string, wrong password |
| UI | No data, one topic, 500 topics, very long titles, offline, slow API, 200% zoom, keyboard only |
| Scraper | Disallowed path, private address, redirect to private, 403, 429, challenge page, oversized, non-HTML, layout change, browser hang |
| Own-content | Feedback spam, profile with maximum lengths, draft for topic with no evidence, duplicate idea, invalid posted URL, digest with zero topics |
| Decode | 0 and 13 formats, CSV with BOM, CSV with missing columns, all items one format, all items `none`, zero engagement values, one item |

### 6.2 Chaos drill execution

| ID | How to run it |
|----|---------------|
| CH-01 | Kill -9 the server during each stage (loop through stages with the fake clock), restart |
| CH-02 | Turn the network off mid-collect (or block outbound traffic), restore after one minute |
| CH-03 | Remove the service account from the sheet's sharing mid-run, restore later |
| CH-04 | Stop OmniRoute during the write stage, restart it, press retry |
| CH-05 | `--jev=bad_choice --writer=invalid` for every call |
| CH-06 | Fill the test sheet to about 9.9 million cells with filler tabs and run |
| CH-07 | Mount a tiny RAM disk for `data/` and fill it |
| CH-08 | Change the system timezone and clock during a run |
| CH-09 | Truncate `data/state.db`, start the app, run `rebuild-state` |
| CH-10 | Start a second instance against the same data folder |
| CH-11 | Kill the app while saving an idea edit |
| CH-12 | Make the Telegram fake return 500 for a day of fake time |
| CH-13 | Make the fake writer return the evidence text verbatim for a draft |
| CH-14 | Fire 500 feedback clicks in one minute with a script |
| CH-15 | Make the test site hang a browser fetch forever |
| CH-16 | Swap the test site from layout A to layout B between runs |
| CH-17 | Make the test site answer 429 for every request |
| CH-18 | Enter an internal address as a recipe URL |

Pass rule for every drill: no crash, no data loss, no duplicate rows, the problem is visible in the UI, recovery needs at most one button press.

## 7. Non-functional testing

| Area | Method | Pass criteria |
|------|--------|---------------|
| Performance | Time a full live run with 8 sources and about 400 items (NFR-01). Load Today with 50,000 sheet rows (NFR-02). Time 1,000 items through dedupe (NFR-07) | Run ≤ 10 min; Today ≤ 1.5 s from cache, ≤ 6 s uncached; dedupe < 2 s |
| Soak | Real cron for 72 hours (NFR-03). Sample memory, open handles, database size and Sheets quota use every hour | ≥ 95% runs success or partial; memory growth ≤ 20%; no duplicate rows; no quota exhaustion |
| Capacity | Project sheet growth (NFR-04); Jev spend per day (NFR-06) | Warning raised when under 90 days from the 10 million cell cap; spend visible per run |
| Time handling | Run at 23:59 and 00:01, in two timezones (NFR-08) | `run_date` consistent with the app timezone |
| Offline | Network off during use (NFR-05) | Cache serves the dashboard, banner shown |
| Security | Secrets scan (SEC-05, SEC-06, SEC-07), hostile corpus (SEC-08), outbound request review in devtools or a proxy (SEC-09), `npm audit --omit=dev` and `pip-audit` (SEC-10), path traversal (SEC-11), notification secrets (SEC-12), voice samples (SEC-13) | No secret anywhere; no script execution; only configured services and sources contacted; no high or critical advisories |
| Privacy | Capture all outbound hosts during one run | Only configured sources, Google, OmniRoute, Jev and chosen notification channels |
| Accessibility | axe on every page; 5-minute keyboard-only walk of Today, a topic, settings and the ideas board; screen reader pass on run progress; 200% zoom (UI-14, UI-15) | No serious or critical axe issues; every action reachable; focus always visible; progress announced |
| Visual regression | Playwright snapshots of every page at 375, 800, 1280 px (STY-02) | Within tolerance of the approved baselines |
| Cross-browser and OS | Smoke plus rows F27, F28, F49 on each browser and OS (PKG-02, PKG-07) | Identical behavior |

## 8. Data integrity probes

Run these after a Tier 2 run and after every chaos drill. Replace `RUN` with the run id and `DATE` with `YYYY-MM-DD`.

### 8.1 SQLite (`sqlite3 data/state.db`)

```sql
-- persisted items per run (must equal raw sheet rows for that run)
SELECT run_id, SUM(persisted) FROM items_run GROUP BY run_id;

-- duplicate content hashes persisted on one date (expect no rows)
SELECT content_hash, COUNT(*) c FROM items_run WHERE persisted=1 AND run_date='DATE' GROUP BY content_hash HAVING c>1;

-- runs stuck in running for over 30 minutes (expect no rows)
SELECT id, status, started_at FROM runs WHERE status='running' AND started_at < datetime('now','-30 minutes');

-- a full successful run has all 11 stages done (expect 11)
SELECT COUNT(*) FROM run_stages WHERE run_id='RUN' AND status='done';

-- LLM usage and cost per client for a run
SELECT client, COUNT(*), SUM(tokens_in), SUM(tokens_out), SUM(cost_usd) FROM llm_calls WHERE run_id='RUN' GROUP BY client;

-- items sorted or discarded without a category label (expect 0)
SELECT COUNT(*) FROM items_run i LEFT JOIN item_labels l ON l.item_id=i.id AND l.question='category'
WHERE i.run_id='RUN' AND i.sort_status IN ('sorted','discarded') AND l.item_id IS NULL;

-- how many labels came from the fallback classifier
SELECT classifier, COUNT(*) FROM item_labels WHERE question='category' GROUP BY classifier;

-- digest deliveries (one row per date and channel)
SELECT run_date, channel, status, attempts FROM digest_deliveries ORDER BY run_date DESC;

-- idea board counts by status
SELECT status, COUNT(*) FROM ideas GROUP BY status;

-- decode run: items per format
SELECT format_key, COUNT(*) FROM decode_items WHERE run_id='DECODE_RUN' GROUP BY format_key;
```

### 8.2 Google Sheet formulas (put in a scratch tab)

| Check | Formula | Expected |
|-------|---------|----------|
| Raw rows for a run | `=COUNTIF(raw_trends!B:B,"RUN")` | Equals persisted count |
| Duplicate hashes (single-day sheet) | `=COUNTA(raw_trends!P2:P)-COUNTA(UNIQUE(raw_trends!P2:P))` | 0 |
| Top rank equals topic count for the latest set | `=MAXIFS(sorted_trends!D:D,sorted_trends!C:C,"DATE",sorted_trends!X:X,TRUE)` and `=COUNTIFS(sorted_trends!C:C,"DATE",sorted_trends!X:X,TRUE)` | Same number |
| Scores in range | `=COUNTIF(sorted_trends!I2:I,"<0")+COUNTIF(sorted_trends!I2:I,">100")` | 0 |
| One latest set per date | `=COUNTUNIQUE(FILTER(sorted_trends!B2:B,sorted_trends!C2:C="DATE",sorted_trends!X2:X=TRUE))` | 1 |
| Source labels for recipes | `=COUNTIFS(raw_trends!D:D,"recipe",raw_trends!S:S,"")` | 0 |

## 9. Defects, flaky tests, regression

- Severity, bug template and rules: `07_TESTING_PLAN.md` §7. Every S1 or S2 fix adds a regression test whose title contains the bug id.
- Flaky test: quarantine for at most 48 hours with an issue linked; two quarantines of the same test mean it is rewritten, not retried.
- A failed row blocks its phase gate; a failed row in an earlier phase blocks every later gate until fixed.
- After any fix touching a seam (Sheets mappers, scoring, label cache, migrations, API schemas) rerun the matching wiring tests from `10_MASTER_PLAN.md` §3.2 plus Tier 1.

## 10. Test ID → feature coverage

Every defined test ID belongs to at least one feature or suite here. Deferred, not mapped: COL-15, SCR-25.

| Test IDs | Feature rows or suite |
|----------|-----------------------|
| INF-01…07 | Foundation: doctor, verify runner, harness, config (Tier 0) |
| SET-01…11 | F01, F32, F39 |
| COL-01…14 | F03…F12 |
| NRM-01…10 | F13, F14, F15 |
| LLM-01…14 | F09, F18, J01 |
| JEV-01…15 | J01, J02, F16 |
| SHT-01…16 | F02, F15, F20, F33, F37 |
| SRT-01…16 | F12, F16, F17, F18, F19, F20 |
| RUN-01…16 | F10, F21…F26, F37 |
| API-01…16 | F30, F32, F33, F34, F35, F36 |
| UI-01…18 | F26…F32, F34 |
| UI-19…25 | F43, F45…F49, F51…F54 |
| SEC-01…13 | F36, F38, F46, F54, S03, S04, §7 security |
| NFR-01…08 | §7 performance, soak, capacity, time, offline |
| PKG-01…07 | F39, F40, §7 cross-browser and OS |
| STY-01…05 | U01 |
| PRF-01…04 | F41 |
| FBK-01…09 | F42, F43, F44 |
| GEN-01…14 | F41, F45, F46, F47 |
| ANG-01…03 | F48 |
| IDEA-01…10 | F49, F50 |
| DIG-01…13 | F51…F54 |
| SCR-01…24 | S01…S06, F39 |
| DEC-01…19 | D01…D06 |
| W-01…23 | §5 journeys, §9 seam reruns |
| CH-01…18 | §6.2 chaos drills |

## 11. Templates and sign-off

### 11.1 Run log (`test-runs/YYYY-MM-DD.md`)

```markdown
# Test run YYYY-MM-DD
Build: <git sha> · Mode: fake | live · Tester: <name> · Phase gate: P<N> | release v<x>
Environment: OS, Node, browser, spreadsheet title, Jev model, writer model

| Row | Automated | Manual | Evidence (screenshot, log, sheet link) | Defect | Notes |
|-----|-----------|--------|----------------------------------------|--------|-------|
| F01 | PASS | PASS | link | | |
| F02 | PASS | FAIL | link | BUG-12 | tab not recreated |

Summary: <n> rows passed, <n> failed, <n> skipped (reason).
Chaos drills run: CH-.. | Journeys run: SC-.. | Probes run: §8.1 / §8.2
Decision: gate passed | gate blocked
```

### 11.2 Defect report

`BUG-<n> · severity S1–S4 · row/test ID · mode · steps · expected · actual · run id · logs/screenshot · suspected module`

### 11.3 Release sign-off

**MVP (v1.0.0)**
- [ ] Tier 0, 1, 2 (rows F01–F40, S01–S06, J01, J02, U01) and 2b journeys SC-01…SC-03, SC-08…SC-10 logged as passed
- [ ] `verify` 49/49 fake and live; chaos drills CH-01…10 and CH-15…18; soak passed
- [ ] §7 security, privacy, accessibility, visual, cross-browser and OS sections done
- [ ] §8 probes clean after the final run; no open S1 or S2 defects
- [ ] Docs checker clean: `python tools/check_docs_wiring.py docs`

**v1.1 (v1.1.0)**
- [ ] Rows F41–F54 passed; journeys SC-04, SC-05, SC-07, SC-10; CH-11…14; `verify` 63/63

**v1.2 (v1.2.0)**
- [ ] Rows D01–D06 passed; journey SC-06; `verify` 69/69; live decode of 100 real items reviewed by hand
