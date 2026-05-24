import { test } from "@playwright/test";

const SHOTS: { name: string; path: string; waitMs?: number }[] = [
  { name: "01-onboarding", path: "/onboarding" },
  { name: "02-voice-prestart", path: "/onboarding/voice" },
  { name: "03-voice-live", path: "/onboarding/voice/live", waitMs: 3500 },
  { name: "04-overview", path: "/overview", waitMs: 800 },
  { name: "04b-overview-team", path: "/overview", waitMs: 800 },
  { name: "19-synthesis", path: "/synthesis", waitMs: 1500 },
  { name: "20-admin", path: "/admin" },
  { name: "21-coverage", path: "/admin/coverage", waitMs: 1500 },
  { name: "22-variants", path: "/admin/variants" },
  { name: "23-evidence", path: "/admin/evidence" },
  { name: "24-settings", path: "/settings" },
];

test.describe("capture screenshots", () => {
  for (const s of SHOTS) {
    test(s.name, async ({ page }) => {
      await page.goto(s.path, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      if (s.waitMs) await page.waitForTimeout(s.waitMs);
      await page.screenshot({
        path: `screenshots/${s.name}.png`,
        fullPage: true,
      });
    });
  }
});
