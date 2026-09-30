# 03 — UI / UX Design

## 1. Design principles

1. **Answer first.** Opening the app shows today's ranked topics, no clicks needed.
2. **Trust through evidence.** Every topic links to the raw items that support it.
3. **Calm and dense.** Information-rich but quiet; color carries meaning only (score, momentum, status).
4. **Local and transparent.** Always show data freshness, run status and where data lives (Sheet link).
5. **Never a blank screen.** Every page has loading, empty, error and partial states.

## 2. Information architecture

```
Sidebar
├─ Today          (default)  ranked topics + digest
├─ Explore                   any date, filters, compare
├─ Raw Data                  table of collected items
├─ Sources                   enable/disable, health, custom feeds
├─ Runs                      history + live log
└─ Settings                  connections, schedule, scoring, niches
First run → Setup Wizard (full-screen, 5 steps)
```

## 3. Layout

- App shell: left sidebar 240 px (collapses to 64 px icons under 1024 px), top bar 56 px.
- Top bar: date picker (prev / today / next), search, **Sync** icon button, **Run now** primary button, run-status pill.
- Content max width 1280 px, 24 px gutters.
- Breakpoints: `sm 640`, `md 768`, `lg 1024`, `xl 1280`. Below `md` the sidebar becomes a bottom tab bar with 5 items.

## 4. Design tokens

**Color (dark first, light supported)**

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--bg` | `#0B0F17` | `#F7F8FA` | app background |
| `--surface` | `#121826` | `#FFFFFF` | cards |
| `--surface-2` | `#182033` | `#F0F2F6` | hover, inputs |
| `--border` | `#26304A` | `#E2E6EE` | dividers |
| `--text` | `#E7EAF3` | `#0F1626` | primary text |
| `--text-dim` | `#98A2B8` | `#5B6478` | secondary text |
| `--brand` | `#6366F1` | `#4F46E5` | primary actions, focus ring |
| `--good` | `#22C55E` | `#16A34A` | success, rising |
| `--warn` | `#F59E0B` | `#D97706` | partial, peak |
| `--bad` | `#EF4444` | `#DC2626` | error, fading negative |
| `--info` | `#38BDF8` | `#0284C7` | new, info |

Score ring gradient: 0–39 `--text-dim`, 40–69 `--info`, 70–84 `--brand`, 85–100 `--good`.

Category chip colors: fixed hue per category (Tech blue, AI violet, Business amber, Finance green, Science cyan, Health rose, Politics slate, World teal, Sports orange, Entertainment pink, Culture fuchsia, Gaming lime, Lifestyle sand, Other gray). Text always passes 4.5:1 on chip background.

**Type:** Inter (UI), JetBrains Mono (ids, logs). Scale: 12 / 14 / 16 / 20 / 24 / 32. Body 14, line-height 1.5, headings 600.
**Spacing:** 4-pt grid (4, 8, 12, 16, 24, 32). **Radius:** 8 (inputs), 12 (cards), 999 (chips). **Shadow:** subtle, only on popovers and drawers.
**Motion:** 150 ms ease-out for hover and drawers, skeleton shimmer 1.2 s. Respect `prefers-reduced-motion`.
**Icons:** lucide-react, 16/20 px, stroke 1.75.

## 5. Screens

### 5.1 Today

```
┌───────────────┬────────────────────────────────────────────────────────────┐
│ ▣ TrendPulse  │ ‹ Wed 30 Sep 2026 ›   [search…]   ⟳ Sync   [▶ Run now] ● ok│
│               ├────────────────────────────────────────────────────────────┤
│ ● Today       │ DAILY DIGEST                                  ↗ Open sheet │
│   Explore     │ AI agents dominate HN and Reddit; GPU supply news …        │
│   Raw Data    │ 48 topics · 412 items · 7/8 sources · run 06:02 (3m 41s)   │
│   Sources     ├────────────────────────────────────────────────────────────┤
│   Runs        │ [All][Tech][AI][Business][Science]…   Sort: Score ▾  ⌄More │
│   Settings    ├────────────────────────────────────────────────────────────┤
│               │ ┌──────────────────────────┐ ┌──────────────────────────┐ │
│               │ │ 1  (92)  ▲ rising         │ │ 2  (88)  ● new           │ │
│               │ │ Title of the topic        │ │ Title of the topic       │ │
│               │ │ Two-line summary …        │ │ Two-line summary …       │ │
│               │ │ [AI] #agents #llm  HN R G │ │ [Tech] #chips   HN GT    │ │
│               │ │ ▸ 3 content angles        │ │ ▸ 3 content angles       │ │
│               │ └──────────────────────────┘ └──────────────────────────┘ │
└───────────────┴────────────────────────────────────────────────────────────┘
```

**Topic card:** rank number, score ring (number inside), momentum badge (▲ rising green, ● new blue, ◆ peak amber, ─ steady gray, ▼ fading red), title (max 2 lines), summary (max 3 lines), category chip, tags (max 3 + count), source icons (with count on hover), expandable "3 content angles" with copy buttons, overflow menu (copy as Markdown, open sources, hide).
**Interactions:** click card → Topic Drawer. `j/k` move selection, `Enter` opens drawer, `c` copies angles, `/` focuses search.
**Filters:** category multi-select chips, source multi-select, momentum, min score slider, text search. State persisted in URL query string.

### 5.2 Topic Drawer (right, 520 px)
Sections: header (title, score ring, badges) → Why it's trending → Summary → **Score breakdown** (4 bars: Engagement, Source diversity, Relevance, Novelty, with weights) → Content angles (copy each / copy all) → Evidence list (source icon, title, engagement, time, external link) → Footer (Copy as Markdown, Open row in Sheets).

### 5.3 Explore
Date range picker, same filters, view toggle (Cards / Table). Table columns: rank, title, category, score, momentum, sources, date. Compare mode: pick two dates, show new / disappeared / rising topics.

### 5.4 Raw Data
Virtualized table (TanStack): time, source, title, engagement, url, status (`sorted | sort_failed | discarded | pending`). Column filters, text search, CSV export, row click → side panel with full snippet and hash.

### 5.5 Sources
Card per source: toggle, health dot (ok / warn / error / off), last run items count, last error, requirements checklist (e.g. "Needs YOUTUBE_API_KEY"), per-source limit input. Custom lists: RSS feeds and page URLs (add / remove / test button). Niche keywords chip input.

### 5.6 Runs
Left: history list (date, trigger manual/cron, status pill, duration, items, topics, tokens). Right: detail with stage stepper (collect → normalize → dedupe → persist raw → sort → score → persist sorted → finalize), per-source table, live log (monospace, autoscroll, level filter). Actions: **Retry failed stage**, **Re-sort only**.

### 5.7 Settings
Tabs: Connections (Google Sheets, OmniRoute, Jev — each with **Test** button and result toast), Schedule (cron picker with human preview "Every day at 06:00"), Sorting (batch size, top N, score weights sliders that sum to 100%), Data (retention days and mode, dedupe days), Appearance (theme), Security (password). Secrets displayed masked; **Replace** button to edit.

### 5.8 Setup Wizard (full screen, stepper)
1. **Welcome** — what it does, requirements checklist.
2. **Google Sheets** — guided: create service account, download JSON, share sheet with shown email, paste Sheet URL. **Test & create tabs**.
3. **OmniRoute** — base URL default `http://localhost:20128/v1`, API key, extract model dropdown loaded from `/models`. **Test**.
4. **Jev** — same endpoint or custom, model id, **Test with sample** (shows a tiny JSON answer).
5. **Sources & schedule** — pick sources, niches, time. **Finish & run first collection**.
Each step blocks Next until its test passes; user can go back; progress saved.

## 6. Component inventory

`AppShell, Sidebar, TopBar, DatePicker, RunButton, RunStatusPill, DigestCard, FilterBar, CategoryChip, MomentumBadge, ScoreRing, SourceIcon, TopicCard, TopicDrawer, ScoreBreakdown, AnglesList, EvidenceList, DataTable, SourceCard, ChipInput, CronPicker, StageStepper, LogViewer, ConnectionForm, TestResultToast, EmptyState, ErrorState, SkeletonCard, ConfirmDialog, Toast`.

## 7. States

| State | Behavior |
|-------|----------|
| Loading | Skeleton cards (6), no spinners over content |
| Empty (no run yet) | Illustration + "Run your first collection" button |
| Empty (filters) | "No topics match" + **Clear filters** |
| Running | Top pill "Running · sorting 12/48", Today shows previous data with banner "New data arriving" |
| Partial | Amber banner: "7 of 8 sources worked. Reddit failed: rate limited" with **View run** |
| Failed | Red banner with failed stage and **Retry** |
| Sheets disconnected | Blocking card with reconnect steps and **Open settings** |
| Stale cache | Subtle "Updated 4 min ago" with **Sync** |
| Offline internet | Banner, dashboard still works from cache |

## 8. Copywriting

Plain words, no jargon. Buttons are verbs ("Run now", "Test connection"). Errors say what happened, why, and what to do: "Google Sheets denied access. Share the sheet with `bot@project.iam.gserviceaccount.com` as Editor, then press Test."

## 9. Accessibility

WCAG 2.1 AA; visible focus ring (2 px `--brand`); all controls keyboard reachable; `aria-live="polite"` for run progress; charts have text alternatives; color never the only carrier (momentum uses icon + label); minimum touch target 40 px; dialogs trap focus; reduced-motion respected; light and dark themes both checked for contrast.

## 10. Export formats

- **CSV** for tables (UTF-8 with BOM for Excel).
- **Markdown** for a topic or the day: title, score, summary, angles, source links.
