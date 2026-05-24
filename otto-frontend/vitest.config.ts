import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      "server-only": path.resolve(__dirname, "tests/phase0/server-only-stub.ts"),
    },
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
