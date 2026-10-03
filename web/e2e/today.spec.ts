import { expect, test } from "@playwright/test";
import { mockApi, mockEmptyRuns } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await mockEmptyRuns(page);
});

test("Today renders hero blocks and ranked topics with zero clicks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("today's trends")).toBeVisible();
  for (const label of ["topics", "items", "sources", "ai cost"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText("Alpha launch day")).toBeVisible();
  await expect(page.getByText("Beta markets rally")).toBeVisible();
});

test("category chip narrows the list and syncs the URL", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Beta markets rally")).toBeVisible();
  await page.getByRole("button", { name: "finance", exact: true }).click();
  await expect(page.getByText("Beta markets rally")).toBeVisible();
  await expect(page.getByText("Alpha launch day")).toHaveCount(0);
  await expect(page).toHaveURL(/category=Finance/);
  await page.getByRole("button", { name: "clear filters" }).click();
  await expect(page).not.toHaveURL(/category=Finance/);
  await expect(page.getByText("Alpha launch day")).toBeVisible();
});

test("clicking a row opens the panel; Escape closes it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Alpha launch day/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("score breakdown");
  await expect(dialog.getByRole("link", { name: /Alpha launch day/ })).toHaveAttribute(
    "href",
    "https://a.example.com/1",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
