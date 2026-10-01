import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mockApi, mockEmptyRuns } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await mockEmptyRuns(page);
});

async function expectNoSeriousViolations(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole("main").waitFor();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, JSON.stringify(serious.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([]);
}

test("a11y: Today has no serious violations", async ({ page }) => {
  await mockApi(page);
  await expectNoSeriousViolations(page, "/");
});

test("a11y: Runs and Settings have no serious violations", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/runs?*", (route) => route.fulfill({ json: { runs: [], total: 0 } }));
  await expectNoSeriousViolations(page, "/runs");
  await expectNoSeriousViolations(page, "/settings");
});

test("responsive: bottom tabs at 375px, sidebar at 1280px", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});
