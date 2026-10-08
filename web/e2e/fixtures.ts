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
  await page.route("**/api/runs/active", (route) => route.fulfill({ json: { run_id: null, scope: "all" } }));
}

/** Default Today doubles so every spec lands on panels, not onboarding. */
export async function mockTodayDefaults(page: Page): Promise<void> {
  await page.route("**/api/my-categories", (route) =>
    route.fulfill({
      json: { my_categories: ["tech", "finance"], max_categories: 6, top_per_category: 5, include_general_sources: false },
    }),
  );
  await page.route("**/api/today/categories", (route) =>
    route.fulfill({
      json: {
        categories: [
          {
            category: "tech", status: "ok", last_run_at: "2026-09-30T06:02:00.000Z",
            sources: [{ name: "rss", status: "ok" }], stats: { items_collected: 1, items_kept: 1 },
            topics: [
              { id: "t1", title: "Alpha launch day", summary: "Alpha launched today with wide coverage.", category: "tech", score: 92, momentum: "rising", source_count: 2, rank: 1 },
            ],
          },
          {
            category: "finance", status: "ok", last_run_at: "2026-09-30T06:02:00.000Z",
            sources: [{ name: "rss", status: "ok" }], stats: { items_collected: 1, items_kept: 1 },
            topics: [
              { id: "t2", title: "Beta markets rally", summary: "Markets rally on Beta news.", category: "finance", score: 61, momentum: "steady", source_count: 1, rank: 1 },
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/api/runs/estimate", (route) =>
    route.fulfill({
      json: {
        scope: "finance+tech", mode: "strict", sources: [], expected_new_items: 0, stored_items_reused: 2,
        jev_calls_expected: 0, writer_calls_expected: 0, cost_usd_estimate: 0, warnings: [], heuristic: true,
        per_category: [], general: { included: false, sources: [], expected_new_items: 0, jev_calls_expected: 0 },
      },
    }),
  );
}

export async function mockApi(
  page: Page,
  options: { setupComplete?: boolean | (() => boolean) } = {},
): Promise<void> {  const isComplete = (): boolean => {
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
  await page.route("**/api/jev/health", (route) =>
    route.fulfill({ json: { budget_used_usd: 0.31 } }),
  );
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

/* -- Doc 19 e2e doubles: stateful my-categories + per-category panels -- */

export interface Top5PanelTopic {
  id: string;
  title: string;
  summary: string;
  score: number;
  momentum: string;
  source_count: number;
  rank: number;
}

export interface Top5Panel {
  category: string;
  status: string;
  note?: string;
  topics: Top5PanelTopic[];
}

export interface Top5State {
  my: string[];
  panels: Top5Panel[];
  posts: { url: string; body: unknown }[];
  puts: { url: string; body: unknown }[];
}

export function top5Topics(n: number, prefix: string, score = 90): Top5PanelTopic[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-t${String(i)}`,
    title: `${prefix} title ${String(i)}`,
    summary: `${prefix} summary ${String(i)}.`,
    score: score - i,
    momentum: "rising",
    source_count: 2,
    rank: i + 1,
  }));
}

export function top5State(): Top5State {
  return {
    my: ["ai", "finance"],
    panels: [
      { category: "ai", status: "ok", topics: top5Topics(6, "ai") },
      { category: "finance", status: "ok", note: "only 2 topics found � sources may be thin", topics: top5Topics(2, "fin") },
      { category: "science", status: "ok", topics: [] },
      { category: "other", status: "no_sources", note: "no usable sources, edit sources in settings", topics: [] },
    ],
    posts: [],
    puts: [],
  };
}

function panelJson(panel: Top5Panel): unknown {
  // Mirrors the server contract: at most TOP_PER_CATEGORY (5) per panel.
  const topics = panel.topics.slice(0, 5);
  return {
    category: panel.category,
    status: panel.status,
    last_run_at: "2026-09-30T06:02:00.000Z",
    sources: [{ name: "rss", status: "ok" }],
    stats: { items_collected: topics.length, items_kept: topics.length },
    topics: topics.map((t) => ({ ...t, category: panel.category })),
    ...(panel.note ? { note: panel.note } : {}),
  };
}

export async function mockTop5(page: Page, state: Top5State): Promise<void> {
  await page.route("**/api/my-categories", async (route) => {
    if (route.request().method() === "PUT") {
      let body: { my_categories?: string[] } = {};
      try {
        body = JSON.parse(route.request().postData() ?? "{}") as { my_categories?: string[] };
      } catch {
        body = {};
      }
      if (Array.isArray(body.my_categories)) state.my = body.my_categories;
      await route.fulfill({ json: { my_categories: state.my } });
    } else {
      await route.fulfill({
        json: { my_categories: state.my, max_categories: 6, top_per_category: 5, include_general_sources: false },
      });
    }
  });
  await page.route("**/api/today/categories", async (route) => {
    const panels = state.panels
      .filter((p) => state.my.includes(p.category))
      .sort((a, b) => state.my.indexOf(a.category) - state.my.indexOf(b.category));
    await route.fulfill({ json: { categories: panels.map(panelJson) } });
  });
  await page.route("**/api/runs/estimate", (route) =>
    route.fulfill({
      json: {
        scope: [...state.my].sort().join("+"),
        mode: "strict",
        sources: [{ collector: "rss", categories: state.my }],
        expected_new_items: 40 * state.my.length,
        stored_items_reused: 0,
        jev_calls_expected: 40 * state.my.length,
        writer_calls_expected: state.my.length,
        cost_usd_estimate: 0.0024 * state.my.length,
        warnings: [],
        heuristic: true,
        per_category: state.my.map((category) => ({
          category,
          sources: ["rss"],
          expected_new_items: 40,
          stored_items_reused: 0,
          jev_calls_expected: 40,
          writer_clusters_expected: 5,
        })),
        general: { included: false, sources: [], expected_new_items: 0, jev_calls_expected: 0 },
      },
    }),
  );
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() === "POST") {
      let body: unknown = {};
      try {
        body = JSON.parse(route.request().postData() ?? "{}") as unknown;
      } catch {
        body = {};
      }
      state.posts.push({ url: route.request().url(), body });
      await route.fulfill({ json: { run_id: "run-new" } });
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/runs/active", (route) => route.fulfill({ json: { run_id: null, scope: "all" } }));
  await page.route("**/api/digest?*", (route) =>
    route.fulfill({
      json: {
        run_date: "2026-09-30",
        run_id: "run-1",
        digest: "Ai rallied. Banks steadied. Labs published.",
        top_topic_id: "ai-t0",
        topics_count: 8,
        items_count: 12,
        sources_ok: 2,
        sources_total: 2,
        top_categories: [{ category: "AI", count: 6 }],
        created_at: "2026-09-30T07:00:00.000Z",
        is_latest: true,
      },
    }),
  );
  await page.route("**/api/trends/ai-t0", (route) =>
    route.fulfill({
      json: {
        topic: {
          topic_id: "ai-t0", run_id: "run-1", run_date: "2026-09-30", rank: 1,
          title: "ai title 0", summary: "ai summary 0.", category: "AI", tags: [],
          trend_score: 90, score_engagement: 0.8, score_diversity: 0.5, score_relevance: 0.8,
          score_novelty: 0.6, momentum: "rising", sentiment: "neutral", why_trending: "Coverage.",
          content_angles: ["Angle one"], evidence_item_ids: ["a1"], source_count: 2, top_urls: [],
          jev_model: "stub", prompt_version: "v1", sorted_at: "2026-09-30T07:00:00.000Z",
          is_latest: true, hidden: false,
        },
        evidence: [{ id: "a1", title: "ai title 0", url: "https://a.example.com/1" }],
        warnings: 0,
        cache: { age_s: 1 },
      },
    }),
  );
}
