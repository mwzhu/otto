import { describe, expect, test } from "vitest";
import {
  computeCoverageSummary,
  MIN_COVERAGE_DENOMINATOR,
  PARTIAL_SLOT_WEIGHT,
  type CoverageStatus,
} from "@/lib/interview/director/coverage-meter";

function slots(...statuses: CoverageStatus[]) {
  return statuses.map((status) => ({ status }));
}

describe("computeCoverageSummary", () => {
  test("credits partial slots so a rich interview is not undercounted (session 83fdd5a6)", () => {
    // Session 83fdd5a6: 16 slots that are mostly partial (real extracted data),
    // 4 fully filled, 2 empty. The old math counted only filled -> 4/16 = 25%,
    // making a rich interview read as nearly empty.
    const summary = computeCoverageSummary(
      slots(
        ...Array<CoverageStatus>(4).fill("filled"),
        ...Array<CoverageStatus>(10).fill("partial"),
        ...Array<CoverageStatus>(2).fill("empty"),
      ),
    );

    expect(summary.filledSlots).toBe(4);
    expect(summary.partialSlots).toBe(10);
    expect(summary.totalSlots).toBe(16);
    // (4 + 10*0.5) / 16 = 9/16 = 56.25% -> 56% (was 25% under filled-only math).
    expect(summary.coveragePercent).toBe(56);
    expect(summary.coveragePercent).toBeGreaterThan(25);
  });

  test("counts asked_unknown as fully covered, like filled", () => {
    const summary = computeCoverageSummary(slots("asked_unknown", "filled"));
    expect(summary.filledSlots).toBe(2);
    expect(summary.partialSlots).toBe(0);
  });

  test("conflicting and pending_re_extract earn no credit", () => {
    const summary = computeCoverageSummary(
      slots("conflicting", "pending_re_extract", "empty"),
    );
    expect(summary.filledSlots).toBe(0);
    expect(summary.partialSlots).toBe(0);
    expect(summary.coveragePercent).toBe(0);
  });

  test("partial weight is the documented constant", () => {
    // One partial out of the minimum denominator.
    const summary = computeCoverageSummary(slots("partial"));
    expect(summary.totalSlots).toBe(MIN_COVERAGE_DENOMINATOR);
    expect(summary.coveragePercent).toBe(
      Math.round((PARTIAL_SLOT_WEIGHT / MIN_COVERAGE_DENOMINATOR) * 100),
    );
  });

  test("uses the minimum denominator so an early interview does not read as 100%", () => {
    const summary = computeCoverageSummary(slots("filled"));
    expect(summary.totalSlots).toBe(MIN_COVERAGE_DENOMINATOR);
    expect(summary.coveragePercent).toBe(
      Math.round((1 / MIN_COVERAGE_DENOMINATOR) * 100),
    );
  });

  test("a fully filled interview reads as 100%", () => {
    const summary = computeCoverageSummary(
      slots(...Array<CoverageStatus>(16).fill("filled")),
    );
    expect(summary.totalSlots).toBe(16);
    expect(summary.coveragePercent).toBe(100);
  });

  test("empty coverage is 0% with no division-by-zero", () => {
    const summary = computeCoverageSummary([]);
    expect(summary.filledSlots).toBe(0);
    expect(summary.partialSlots).toBe(0);
    expect(summary.totalSlots).toBe(MIN_COVERAGE_DENOMINATOR);
    expect(summary.coveragePercent).toBe(0);
  });
});
