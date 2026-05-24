import { test, expect } from "@playwright/test";

const ROUTES = [
  "/onboarding",
  "/onboarding/voice",
  "/onboarding/voice/live",
  "/onboarding/upload",
  "/overview",
  "/synthesis",
  "/admin",
  "/admin/coverage",
  "/admin/variants",
  "/admin/evidence",
  "/admin/seeding",
  "/admin/exports",
  "/settings",
];

for (const path of ROUTES) {
  test(`renders ${path}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`);
    });

    const resp = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(resp?.ok(), `HTTP ${resp?.status()} for ${path}`).toBeTruthy();
    // Wait for hydration / first paint
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    // No actual Next.js error dialog (vs the dev indicator badge)
    const errorDialog = await page
      .locator("[data-nextjs-dialog-overlay], [data-nextjs-error-overlay]")
      .count();
    expect(errorDialog, `error dialog present at ${path}`).toBe(0);
    // No page errors during load (filter out benign hydration warnings)
    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes("Download the React DevTools") &&
        !e.includes("hydration mismatch") &&
        !e.includes("aria-controls"),
    );
    expect(realErrors, `errors at ${path}: ${realErrors.join(" | ")}`).toEqual([]);
  });
}
