import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
