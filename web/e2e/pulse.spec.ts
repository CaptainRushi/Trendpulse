/**
 * Pulse e2e (Doc 16 G5, PULSE-31..33): frontend is real, API is mocked.
 * Screenshots land in test-runs/evidence/<date>/.
 */
import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./fixtures.js";

const TOP_V1 = {
  date: "2026-10-04",
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
    items_count: 412,
    has_live_metric: true,
  },
  runner_ups: [],
  live: {
    enabled: true,
    last_sample_at: "2026-10-04T06:00:00.000Z",
    next_sample_at: "2026-10-04T06:20:00.000Z",
    interval_min: 20,
    status: "live",
  },
};

const SERIES_V1 = {
  date: "2026-10-04",
  baseline_at: "2026-10-04T06:00:00.000Z",
  series: [
    {
      topic_id: "t1",
      title: "Topic 1",
      rank: 1,
      has_live_metric: true,
      sources: ["hackernews"],
      points: [{ t: "2026-10-04T06:00:00.000Z", index: 100, total: 40 }],
    },
  ],
};

const POINTS_V2 = [
  { t: "2026-10-04T06:00:00.000Z", index: 100, total: 40 },
  { t: "2026-10-04T06:20:00.000Z", index: 154, total: 61.6 },
];

const SERIES_V2 = {
  date: "2026-10-04",
  baseline_at: "2026-10-04T06:00:00.000Z",
  series: [
    {
      topic_id: "t1",
      title: "Topic 1",
      rank: 1,
      has_live_metric: true,
      sources: ["hackernews"],
      points: POINTS_V2,
    },
  ],
};

async function mockPulse(page: Page, series: () => unknown): Promise<void> {
  await mockApi(page);
  await page.route("**/api/today/top", (route) => route.fulfill({ json: TOP_V1 }));
  await page.route("**/api/live/samples?*", (route) => route.fulfill({ json: series() }));
  await page.route("**/api/live/stream", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: 'event: sample\ndata: {"topic_id":"t1"}\n\n',
    }),
  );
  await page.route("**/api/live/sample-now", (route) => route.fulfill({ json: { status: "ok" } }));
}

const widths = [375, 800, 1280];

test("PULSE-31 a new point appears without reload", async ({ page }) => {
  let v2 = false;
  await mockPulse(page, () => (v2 ? SERIES_V2 : SERIES_V1));
  await page.goto("/");
  await expect(page.getByText("Alpha launch day").first()).toBeVisible();
  await expect(page.getByText("Topic 1 +0%")).toBeVisible();
  v2 = true;
  await page.getByRole("button", { name: "sample now" }).click();
  await expect(page.getByText("Topic 1 +54%")).toBeVisible();
});

test("PULSE-32 history persists across reload", async ({ page }) => {
  await mockPulse(page, () => SERIES_V2);
  await page.goto("/");
  await expect(page.getByText("Topic 1 +54%")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Topic 1 +54%")).toBeVisible();
  await expect(page.getByText("Alpha launch day").first()).toBeVisible();
});

test("PULSE-33 offline stream shows the reconnecting state", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/today/top", (route) => route.fulfill({ json: TOP_V1 }));
  await page.route("**/api/live/samples?*", (route) => route.fulfill({ json: SERIES_V1 }));
  await page.route("**/api/live/stream", (route) => route.abort());
  await page.route("**/api/live/sample-now", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.goto("/");
  await expect(page.getByText("Alpha launch day").first()).toBeVisible();
  await expect(page.getByText(/reconnecting|polling/)).toBeVisible({ timeout: 45_000 });
});

for (const width of widths) {
  test(`pulse screenshots at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockPulse(page, () => SERIES_V2);
    await page.goto("/");
    await expect(page.getByText("Alpha launch day").first()).toBeVisible();
    const stamp = new Date().toISOString().slice(0, 10);
    await page.screenshot({ path: `../test-runs/evidence/${stamp}/pulse-${String(width)}.png` });
  });
}

