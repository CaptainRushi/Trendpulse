import { expect, test } from "@playwright/test";
import { mockApi, mockEmptyRuns, mockTop5, top5State } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await mockEmptyRuns(page);
  await mockTop5(page, top5State());
});

test("Today renders hero blocks and category panels with zero clicks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("today's trends")).toBeVisible();
  for (const label of ["categories", "topics", "items", "ai cost"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByLabel("ai trends", { exact: true })).toBeVisible();
  await expect(page.getByLabel("ai trends", { exact: true }).getByRole("button", { name: /Open / })).toHaveCount(5);
});

test("removing a chip persists it and hides the panel", async ({ page }) => {
  const state = top5State();
  await mockTop5(page, state);
  await page.goto("/");
  await expect(page.getByLabel("ai trends", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "remove ai" }).click();
  await expect.poll(() => state.my, { timeout: 10000 }).toEqual(["finance"]);
  await expect(page.getByLabel("ai trends", { exact: true })).toHaveCount(0);
});

test("clicking a row opens the panel; Escape closes it", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("ai trends", { exact: true }).getByRole("button", { name: /ai title 0/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("score breakdown");
  await expect(dialog.getByRole("link", { name: /ai title 0/ })).toHaveAttribute(
    "href",
    "https://a.example.com/1",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
