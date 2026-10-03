/**
 * STEP 9 smoke: Today loads with a mocked API at phone, tablet and
 * desktop widths — hero blocks render and the page never scrolls
 * sideways (docs/11 §4.3: no horizontal scroll).
 */
import { expect, test } from "@playwright/test";
import { mockApi, mockEmptyRuns } from "./fixtures.js";

for (const width of [375, 800, 1280]) {
  test(`smoke at ${width}px: hero blocks render, no horizontal scroll`, async ({ page }) => {
    await mockApi(page);
    await mockEmptyRuns(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    for (const label of ["topics", "items", "sources", "ai cost"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByText("Alpha launch day")).toBeVisible();
    const overflow = await page.evaluate(
      () => (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
