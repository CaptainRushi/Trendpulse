# TrendPulse — Docs Pack

Local app. Collects trending topics from the internet every day, stores raw data in Google Sheets, has **Jev** sort and rank it into a second sheet, and shows both on a localhost dashboard anyone can run.

## Read order

| # | File | Purpose |
|---|------|---------|
| 0 | `00_MASTER_PROMPT.md` | Deep prompt. Paste into a coding agent to build the whole system |
| 1 | `01_PRD.md` | What and why: users, goals, requirements, scope |
| 2 | `02_TRD.md` | How: architecture, stack, pipeline, scoring, LLM prompts, security |
| 3 | `03_UI_UX_DESIGN.md` | Screens, wireframes, design tokens, states, accessibility |
| 4 | `04_APP_FLOW.md` | Setup, daily pipeline, manual run, dashboard read, error flows |
| 5 | `05_BACKEND_SCHEMA.md` | Sheets tabs, SQLite DDL, zod types, REST API, env vars |
| 6 | `06_IMPLEMENTATION_PLAN.md` | Phased tasks, acceptance criteria, tests, definition of done |

## Core idea in one picture

```
Sources (APIs / RSS / web pages)
        │  collectors (plain HTTP, no LLM needed to fetch)
        ▼
  normalize + dedupe ──► OmniRoute LLM (extract / clean messy pages)
        ▼
 Google Sheet: raw_trends        (append-only)
        ▼
   Jev via OpenAI-compatible API (cluster, score, categorize, summarize)
        ▼
 Google Sheet: sorted_trends + daily_digest
        ▼
 Localhost dashboard (http://localhost:4317) reads the sheets
```

## Important fact

OmniRoute is an **LLM gateway** (one OpenAI-compatible endpoint, many providers, fallback). It does not fetch web pages by itself. Fetching is done by collectors in the app. OmniRoute is used for the AI steps: extraction of messy pages and, if Jev is served through it, Jev's sorting calls.

## Quick start target (what the finished app should feel like)

```bash
git clone <repo> && cd trendpulse
npm install
npm run setup     # interactive: Google sheet, OmniRoute URL, Jev model
npm start         # http://localhost:4317
```
