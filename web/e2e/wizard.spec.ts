import { expect, test } from "@playwright/test";
import { mockApi, mockEmptyRuns, SOURCES } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await mockEmptyRuns(page);
});

test("fresh DB walks the wizard to a first run", async ({ page }) => {
  let setupDone = false;
  await mockApi(page, { setupComplete: () => setupDone });
  await page.route("**/api/setup/test-sheets", (route) => route.fulfill({ json: { ok: true, tabs: [] } }));
  await page.route("**/api/setup/test-omniroute", (route) => route.fulfill({ json: { ok: true, models: ["m"] } }));
  await page.route("**/api/setup/test-jev", (route) => route.fulfill({ json: { ok: true, model: "j" } }));
  await page.route("**/api/sources/rss", (route) => route.fulfill({ json: SOURCES[1] }));
  await page.route("**/api/sources/hackernews", (route) => route.fulfill({ json: SOURCES[0] }));
  await page.route("**/api/settings", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    if (body && body["setup_complete"] === true) setupDone = true;
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/runs", (route) => route.fulfill({ json: { run_id: "run-first" } }));

  await page.goto("/");
  await expect(page).toHaveURL(/\/wizard$/);
  await expect(page.getByText("Set up TrendPulse")).toBeVisible();

  // 1 → 2 → 3 → 4: each probe-gated step passes with mocked probes.
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByLabel("Sheet ID (from the sheet URL)").fill("sheet-1");
  await page.getByRole("button", { name: /Test/ }).click();
  await expect(page.getByText("Connection works.").first()).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await page.getByLabel("Base URL").fill("http://localhost:20128/v1");
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText("Connection works.").first()).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await page.getByLabel("Model").fill("jev-test");
  await page.getByRole("button", { name: /sample/i }).click();
  await expect(page.getByText("Connection works.").first()).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  // Sources step → finish fires the first collection and lands on the run.
  await expect(page.getByText("Sources & schedule")).toBeVisible();
  await page.getByRole("button", { name: /Finish/ }).click();
  await expect(page).toHaveURL(/\/runs\/run-first$/);
});

test("wizard resumes mid-flow after a reload", async ({ page }) => {
  await mockApi(page, { setupComplete: false });
  await page.goto("/");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Google Sheets")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Google Sheets")).toBeVisible();
});
