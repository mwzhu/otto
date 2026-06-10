import { describe, expect, test } from "vitest";
import { defaultClassifier } from "@/lib/adapters/retry";

describe("retry classifier: client errors are fatal", () => {
  test("a 400 (e.g. invalid strict schema) is fatal, not retried for ~31s", () => {
    expect(defaultClassifier(new Error("Anthropic request failed: 400"))).toBe("fatal");
  });
  test("401/403/404/422 are fatal", () => {
    for (const code of ["401", "403", "404", "422"]) {
      expect(defaultClassifier(new Error(`Anthropic request failed: ${code}`))).toBe("fatal");
    }
  });
  test("429 is still retryable (rate limit), not fatal", () => {
    expect(defaultClassifier(new Error("Anthropic request failed: 429"))).toBe("rate_limit");
  });
  test("5xx remain retryable", () => {
    expect(defaultClassifier(new Error("Anthropic request failed: 500"))).toBe("server");
    expect(defaultClassifier(new Error("Anthropic request failed: 503"))).toBe("server");
  });
  test("timeout/network remain retryable", () => {
    expect(defaultClassifier(new Error("request timeout"))).toBe("timeout");
    expect(defaultClassifier(new Error("network unreachable"))).toBe("network");
  });
});
