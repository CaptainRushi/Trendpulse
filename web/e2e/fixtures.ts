/** Shared API doubles for e2e: the backend is fake, the frontend is real. */
import type { Page } from "@playwright/test";

export const TOPICS = [
  {
    topic_id: "t1",
    run_id: "run-1",
    run_date: "2026-09-30",
    rank: 1,
    title: "Alpha launch day",
    summary: "Alpha launched today with wide coverage.",
    category: "Tech",
    tags: ["launch"],
    trend_score: 92,
    score_engagement: 0.9,
    score_diversity: 0.5,
    score_relevance: 0.9,
    score_novelty: 0.8,
    momentum: "rising",
    sentiment: "positive",
    why_trending: "Launch coverage.",
    content_angles: ["Unboxing", "Review", "Comparisons"],
    evidence_item_ids: ["a1"],
    source_count: 2,
    top_urls: ["https://a.example.com/1"],
    jev_model: "stub",
    prompt_version: "v1",
    sorted_at: "2026-09-30T07:00:00.000Z",
    is_latest: true,
    hidden: false,
  },
  {
    topic_id: "t2",
    run_id: "run-1",
    run_date: "2026-09-30",
    rank: 2,
    title: "Beta markets rally",
    summary: "Markets rally on Beta news.",
    category: "Finance",
    tags: ["markets"],
    trend_score: 61,
    score_engagement: 0.4,
    score_diversity: 0.25,
    score_relevance: 0.7,
    score_novelty: 0.5,
    momentum: "steady",
    sentiment: "positive",
    why_trending: "Broad gains.",
    content_angles: ["Index", "Winners", "Risks"],
    evidence_item_ids: ["b1"],
    source_count: 1,
    top_urls: [],
    jev_model: "stub",
    prompt_version: "v1",
    sorted_at: "2026-09-30T07:00:00.000Z",
    is_latest: true,
    hidden: false,
  },
];

export const DIGEST = {
  run_date: "2026-09-30",
  run_id: "run-1",
  digest: "Alpha launched. Beta rallied. A quiet day otherwise.",
  top_topic_id: "t1",
  topics_count: 2,
  items_count: 3,
  sources_ok: 2,
  sources_total: 2,
  top_categories: [{ category: "Tech", count: 1 }],
  created_at: "2026-09-30T07:00:00.000Z",
  is_latest: true,
};

export const SOURCES = [
  { key: "hackernews", label: "Hacker News", enabled: true, item_limit: 50, config: {}, requires: [], last_status: "ok", last_error: null, last_run_at: "2026-09-30T06:00:00.000Z", last_items: 3 },
  { key: "rss", label: "RSS", enabled: true, item_limit: 50, config: { feeds: [] }, requires: [], last_status: null, last_error: null, last_run_at: null, last_items: null },
];

export async function mockEmptyRuns(page: Page): Promise<void> {
  await page.route("**/api/runs?*", (route) => route.fulfill({ json: { runs: [], total: 0 } }));
}

export async function mockApi(
  page: Page,
  options: { setupComplete?: boolean | (() => boolean) } = {},
): Promise<void> {
  const isComplete = (): boolean => {
    const flag = options.setupComplete ?? true;
    return typeof flag === "function" ? flag() : flag;
  };
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        ok: true,
        version: "e2e",
        setup_complete: isComplete(),
        sheets: "ok",
        omniroute: "ok",
        jev: "ok",
        next_run_at: null,
        last_run: null,
      },
    }),
  );
  await page.route("**/api/trends?*", (route) => {
    // Honor category filters so filter tests exercise real narrowing.
    const url = new URL(route.request().url());
    const categories = url.searchParams.getAll("category");
    const items = categories.length > 0 ? TOPICS.filter((t) => categories.includes(t.category)) : TOPICS;
    return route.fulfill({
      json: { date: "2026-09-30", items, total: items.length, warnings: 0, cache: { age_s: 1 } },
    });
  });
  await page.route("**/api/trends/t1", (route) =>
    route.fulfill({
      json: {
        topic: TOPICS[0],
        evidence: [
          {
            id: "a1",
            run_id: "run-1",
            collected_at: "2026-09-30T06:00:00.000Z",
            source: "hackernews",
            source_item_id: "1",
            url: "https://a.example.com/1",
            title: "Alpha launch day",
            snippet: "Snippet.",
            author: null,
            published_at: null,
            engagement_score: 10,
            engagement_extra: {},
            engagement_norm: 1,
            language: "en",
            region: null,
            content_hash: "h",
            merged_sources: [],
            extraction_model: null,
            sort_status: "sorted",
          },
        ],
        warnings: 0,
        cache: { age_s: 1 },
      },
    }),
  );
  await page.route("**/api/digest?*", (route) => route.fulfill({ json: DIGEST }));
  await page.route("**/api/sources", (route) => route.fulfill({ json: SOURCES }));
  await page.route("**/api/settings", (route) => route.fulfill({ json: { settings: {} } }));
  await page.route("**/api/sheets/link", (route) =>
    route.fulfill({
      json: { spreadsheet_url: "https://example.com/sheet", tabs: { raw_trends: "https://example.com/sheet" } },
    }),
  );
  await page.route("**/api/dates", (route) => route.fulfill({ json: { dates: ["2026-09-30"] } }));
  await page.route("**/api/raw?*", (route) =>
    route.fulfill({ json: { date: "2026-09-30", items: [], total: 0, warnings: 0, cache: { age_s: 1 } } }),
  );
}
