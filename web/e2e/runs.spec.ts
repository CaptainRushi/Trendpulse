import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures.js";

const RUN = {
  run_id: "run-live",
  run_date: "2026-09-30",
  trigger: "manual",
  status: "running",
  stages_requested: ["collect", "normalize", "score", "finalize"],
  started_at: "2026-09-30T06:00:00.000Z",
  finished_at: null,
  items_collected: 3,
  items_new: 3,
  topics_count: 0,
  error: null,
};

const DETAIL = {
  run: RUN,
  stages: [
    { stage: "collect", status: "done", started_at: "2026-09-30T06:00:00.000Z", finished_at: "2026-09-30T06:00:10.000Z" },
    { stage: "normalize", status: "done", started_at: null, finished_at: null },
    { stage: "score", status: "running", started_at: null, finished_at: null },
    { stage: "finalize", status: "pending", started_at: null, finished_at: null },
  ],
  source_stats: [{ source: "hackernews", status: "ok", items: 3, duration_ms: 1200, error: null }],
  llm: { calls: 0, tokens_in: 0, tokens_out: 0 },
};

const STREAM = [
  "event: stage\ndata: {\"run_id\":\"run-live\",\"stage\":\"collect\",\"status\":\"done\"}\n\n",
  "event: source\ndata: {\"run_id\":\"run-live\",\"source\":\"hackernews\",\"status\":\"ok\",\"items\":3}\n\n",
  "event: done\ndata: {\"run_id\":\"run-live\",\"status\":\"success\"}\n\n",
].join("");

test("run detail shows stages, sources and the live SSE log", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/runs?*", (route) =>
    route.fulfill({ json: { runs: [RUN], total: 1 } }),
  );
  await page.route("**/api/runs/run-live", (route) => route.fulfill({ json: DETAIL }));
  await page.route("**/api/runs/run-live/stream", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: STREAM,
    }),
  );

  await page.goto("/runs/run-live");
  await expect(page.getByText("Collect", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "hackernews" })).toBeVisible();
  const log = page.getByRole("log");
  await expect(log).toContainText("hackernews");
  await expect(log).toContainText("done");
});
