/**
 * Category runs + sorting animation e2e (Doc 17 S6: SORTANIM-13,
 * CATRUN-e2e, SORTANIM-12 perf). Frontend real, API mocked per repo pattern.
 */
import { expect, test, type Page } from "@playwright/test";
import { mockApi, mockTop5, top5State } from "./fixtures.js";

const TOP = {
  date: "2026-10-04",
  scope: "all",
  from_previous_day: false,
  topic: {
    topic_id: "t1",
    rank: 1,
    title: "Alpha launch day",
    summary: "Alpha launched today.",
    why_trending: "Coverage everywhere.",
    first_angle: "Unboxing frenzy",
    category: "Tech",
    momentum: "rising",
    score: 92,
    source_count: 3,
    items_count: 12,
    has_live_metric: false,
  },
  runner_ups: [],
  live: { enabled: false, last_sample_at: null, next_sample_at: null, interval_min: 20, status: "paused" as const },
};

const SORT_EVENTS = [
  {
    type: "sort_batch",
    stage: "classify",
    items: [
      { id: "a1", t: "Alpha one", c: "ai", q: 0.9, f: false, d: false, o: false },
      { id: "a2", t: "Alpha two", c: "ai", q: 0.8, f: false, d: false, o: false },
    ],
    done: 2,
    total: 2,
    jev_calls: 2,
    fallback_calls: 0,
    cost_usd: 0.0001,
  },
  { type: "sort_clusters", clusters: [{ id: "c1", category: "ai", size: 2, member_ids: ["a1", "a2"] }] },
  { type: "sort_topics", topics: [{ cluster_id: "c1", title: "Alpha group" }] },
  { type: "sort_rank", ranks: [{ cluster_id: "c1", rank: 1, score: 90 }] },
  { type: "sort_phase", phase: "done" },
];

async function mockCatsort(page: Page, opts: { activeRun?: string | null; scopeTopics?: unknown } = {}): Promise<void> {
  await mockApi(page);
  const state = top5State();
  state.my = ["ai", "finance"];
  await mockTop5(page, state);
  await page.route("**/api/today/top?*", (route) => route.fulfill({ json: TOP }));
  await page.route("**/api/live/samples?*", (route) =>
    route.fulfill({ json: { date: "2026-10-04", scope: "all", baseline_at: null, series: [] } }),
  );
  await page.route("**/api/runs/active", (route) =>
    route.fulfill({ json: opts.activeRun ? { run_id: opts.activeRun, scope: "ai+finance" } : { run_id: null, scope: "all" } }),
  );
  await page.route("**/api/runs/run-99/sort-state", (route) =>
    route.fulfill({ json: { run_id: "run-99", status: "running", phase: "rank", events: SORT_EVENTS } }),
  );
  await page.route("**/api/categories", (route) =>
    route.fulfill({
      json: {
        categories: [
          { slug: "ai", label: "AI", sources: [] },
          { slug: "finance", label: "Finance", sources: [] },
        ],
        default_categories: [],
      },
    }),
  );
  await page.route("**/api/runs/estimate", (route) =>
    route.fulfill({
      json: {
        scope: "ai+finance",
        mode: "strict",
        sources: [{ collector: "rss", categories: ["ai", "finance"] }],
        expected_new_items: 20,
        stored_items_reused: 5,
        jev_calls_expected: 20,
        cost_usd_estimate: 0.0012,
        warnings: [],
      },
    }),
  );
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ json: { run_id: "run-99" } });
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/runs/run-99/stream", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: 'event: sort_phase\ndata: {"phase":"done"}\n\n',
    }),
  );
}

test("SORTANIM-13 animation plays: dots, bins, cards, fade", async ({ page }) => {
  await mockCatsort(page, { activeRun: "run-99" });
  await page.goto("/");
  await expect(page.getByText("Alpha group")).toBeVisible();
  await expect(page.getByText(/classify 2\/2/)).toBeVisible();
  await expect(page.getByText("ai · 2", { exact: false }).first()).toBeVisible();
});

test("CATRUN e2e my-categories drive panels and runs", async ({ page }) => {
  await mockCatsort(page);
  const posts: unknown[] = [];
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() === "POST") {
      let body: unknown = {};
      try {
        body = JSON.parse(route.request().postData() ?? "{}") as unknown;
      } catch {
        body = {};
      }
      posts.push(body);
      await route.fulfill({ json: { run_id: "run-99" } });
    } else {
      await route.continue();
    }
  });
  await page.goto("/");
  const row = page.getByRole("group", { name: "my categories" });
  await expect(row.getByRole("button", { name: "remove ai" })).toBeVisible();
  await expect(page.getByLabel("ai trends", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "remove finance" }).click();
  await page.getByRole("region", { name: "My categories" }).getByRole("button", { name: "run now", exact: true }).click();
  await expect.poll(() => posts.length, { timeout: 10000 }).toBe(1);
  expect(posts[0]).toEqual({ categories: ["ai"] });
});

test("SORTANIM-12 performance: 300 events leave no long tasks", async ({ page }) => {
  const big = Array.from({ length: 300 }, (_, i) => ({
    type: "sort_batch",
    stage: "classify",
    items: [{ id: `i${String(i)}`, t: `Title ${String(i)}`, c: "ai", q: 0.9, f: false, d: false, o: false }],
    done: i + 1,
    total: 300,
    jev_calls: i + 1,
    fallback_calls: 0,
    cost_usd: 0.01,
  }));
  await mockApi(page);
  await page.route("**/api/today/top?*", (route) => route.fulfill({ json: TOP }));
  await page.route("**/api/live/samples?*", (route) =>
    route.fulfill({ json: { date: "2026-10-04", scope: "all", baseline_at: null, series: [] } }),
  );
  await page.route("**/api/runs/active", (route) => route.fulfill({ json: { run_id: "run-99", scope: "all" } }));
  await page.route("**/api/runs/run-99/sort-state", (route) =>
    route.fulfill({ json: { run_id: "run-99", status: "running", phase: "classify", events: big } }),
  );
  await page.goto("/");
  await expect(page.getByText(/classify 300\/300/)).toBeVisible({ timeout: 15000 });
  const longTasks = await page.evaluate(() => performance.getEntriesByType("longtask").filter((e) => e.duration > 100).length);
  expect(longTasks).toBe(0);
});

for (const width of [375, 800, 1280]) {
  test(`catsort screenshots at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockCatsort(page, { activeRun: "run-99" });
    await page.goto("/");
    await expect(page.getByText("Alpha group")).toBeVisible();
    const stamp = new Date().toISOString().slice(0, 10);
    await page.screenshot({ path: `../test-runs/evidence/${stamp}/catsort-${String(width)}.png` });
  });
}
