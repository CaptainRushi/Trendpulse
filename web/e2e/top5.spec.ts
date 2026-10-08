/**
 * Doc 19 Q6 e2e (mocked API, real frontend): ai+finance run posts only those
 * categories; panels cap at 5 with no science panel; per-panel refresh is
 * isolated; add/remove categories persist; empty selection onboards.
 * Server-side source/Jev/writer isolation is proven by TOP5-05/12/13.
 */
import { expect, test } from "@playwright/test";
import { mockApi, mockEmptyRuns, mockTop5, top5State } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await mockEmptyRuns(page);
});

test("ai+finance run posts only those categories; panels cap at 5", async ({ page }) => {
  const state = top5State();
  await mockTop5(page, state);
  await page.goto("/");
  const aiPanel = page.getByLabel("ai trends", { exact: true });
  await expect(aiPanel).toBeVisible();
  await expect(aiPanel.getByRole("button", { name: /Open / })).toHaveCount(5);
  await expect(page.getByLabel("finance trends", { exact: true })).toBeVisible();
  await expect(page.getByLabel("science trends", { exact: true })).toHaveCount(0);
  await page.getByRole("region", { name: "My categories" }).getByRole("button", { name: "run now", exact: true }).click();
  await expect.poll(() => state.posts.length, { timeout: 10000 }).toBe(1);
  expect(state.posts[0]?.body).toEqual({ categories: ["ai", "finance"] });
});

test("refresh finance posts only finance; ai panel unchanged", async ({ page }) => {
  const state = top5State();
  await mockTop5(page, state);
  await page.goto("/");
  await page.getByRole("button", { name: "refresh finance" }).click();
  await expect.poll(() => state.posts.length, { timeout: 10000 }).toBe(1);
  expect(state.posts[0]?.body).toEqual({ categories: ["finance"] });
  await expect(page.getByLabel("ai trends", { exact: true })).toBeVisible();
  await expect(page.getByLabel("ai trends", { exact: true }).getByRole("button", { name: /Open / })).toHaveCount(5);
});

test("add science shows its panel; remove ai hides it", async ({ page }) => {
  const state = top5State();
  await mockTop5(page, state);
  await page.goto("/");
  await page.getByLabel("add a category").selectOption("science");
  await expect.poll(() => state.my, { timeout: 10000 }).toEqual(["ai", "finance", "science"]);
  await expect(page.getByLabel("science trends", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "remove ai" }).click();
  await expect.poll(() => state.my, { timeout: 10000 }).toEqual(["finance", "science"]);
  await expect(page.getByLabel("ai trends", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("finance trends", { exact: true })).toBeVisible();
});

test("empty selection shows onboarding; saving reveals panels", async ({ page }) => {
  const state = top5State();
  state.my = [];
  await mockTop5(page, state);
  await page.goto("/");
  await expect(page.getByText("pick your categories")).toBeVisible();
  await page.getByRole("button", { name: "ai", exact: true }).click();
  await page.getByRole("button", { name: "finance", exact: true }).click();
  await page.getByRole("button", { name: /save 2 categories/ }).click();
  await expect.poll(() => state.my, { timeout: 10000 }).toEqual(["ai", "finance"]);
  await expect(page.getByLabel("ai trends", { exact: true })).toBeVisible();
});

test("TOP5-26 layout at 375, 800, 1280px with no horizontal scroll", async ({ page }) => {
  const state = top5State();
  await mockTop5(page, state);
  const stamp = new Date().toISOString().slice(0, 10);
  for (const width of [375, 800, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.getByLabel("ai trends", { exact: true })).toBeVisible();
    const overflow = await page.evaluate(
      () => (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth,
    );
    expect(overflow, `sideways overflow at ${String(width)}px`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `../test-runs/evidence/${stamp}/top5-${String(width)}.png` });
  }
});
