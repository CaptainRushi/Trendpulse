import { expect, test } from "@playwright/test";
import { mockApi, mockEmptyRuns } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await mockEmptyRuns(page);
});

test("Today renders ranked topics with zero clicks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Alpha launch day")).toBeVisible();
  await expect(page.getByText("Beta markets rally")).toBeVisible();
  await expect(page.getByLabel(/Trend score 92/)).toBeVisible();
});

test("category chip narrows the list and syncs the URL", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Beta markets rally")).toBeVisible();
  await page.getByRole("button", { name: "Finance", exact: true }).click();
  await expect(page.getByText("Beta markets rally")).toBeVisible();
  await expect(page.getByText("Alpha launch day")).toHaveCount(0);
  await expect(page).toHaveURL(/category=Finance/);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/category=Finance/);
  await expect(page.getByText("Alpha launch day")).toBeVisible();
});

test("keyboard j/k + Enter opens the drawer; Escape closes it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Alpha launch day")).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Alpha launch day");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("clicking a card opens evidence with source links", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Alpha launch day/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Score breakdown")).toBeVisible();
  await expect(dialog.getByRole("link", { name: /Alpha launch day/ })).toHaveAttribute(
    "href",
    "https://a.example.com/1",
  );
});
