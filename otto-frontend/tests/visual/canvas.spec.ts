import { test, expect } from "@playwright/test";

test("overview renders without seeded process graph data", async ({ page }) => {
  await page.goto("/overview");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("High Level Overview")).toBeVisible();
});
