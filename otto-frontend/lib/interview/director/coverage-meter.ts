/**
 * Coverage meter math for the live Operations Notes panel.
 *
 * Task 13: `partial` slots hold real, extracted data but previously contributed
 * zero to the headline number, so a rich interview read as nearly empty
 * (session 83fdd5a6 showed "4 of 16 slots covered · 25%" while slot_states were
 * 4 filled, 11 partial, 2 empty — true capture ~70%). We give `partial` slots
 * fractional credit so the percentage reflects real capture, and surface the
 * filled/partial split so the count stays honest.
 *
 * Pure and frontend-only: this does not touch extraction. Kept in its own module
 * (not inline in the client component) so it can be unit-tested directly.
 */

export type CoverageStatus =
  | "empty"
  | "partial"
  | "filled"
  | "asked_unknown"
  | "conflicting"
  | "pending_re_extract";

/** Weight applied to a `partial` slot when computing the coverage percentage. */
export const PARTIAL_SLOT_WEIGHT = 0.5;

/** Minimum slot total used so an early interview does not read as 100%. */
export const MIN_COVERAGE_DENOMINATOR = 13;

/** Statuses that count as fully covered (weight 1). */
const FULLY_COVERED_STATUSES: ReadonlySet<CoverageStatus> = new Set([
  "filled",
  "asked_unknown",
]);

export type CoverageSummary = {
  /** Slots fully captured: `filled` or `asked_unknown`. */
  filledSlots: number;
  /** Slots with real-but-incomplete data: `partial`. */
  partialSlots: number;
  /** Denominator used for the percentage (never below MIN_COVERAGE_DENOMINATOR). */
  totalSlots: number;
  /**
   * Weighted coverage percentage, rounded to an integer.
   * filled/asked_unknown = 1, partial = PARTIAL_SLOT_WEIGHT, others = 0.
   */
  coveragePercent: number;
};

/**
 * Compute the weighted coverage summary for a set of slots.
 *
 * Only `status` is read, so callers may pass any object carrying a status.
 */
export function computeCoverageSummary(
  slots: ReadonlyArray<{ status: CoverageStatus }>,
): CoverageSummary {
  let filledSlots = 0;
  let partialSlots = 0;
  for (const slot of slots) {
    if (FULLY_COVERED_STATUSES.has(slot.status)) {
      filledSlots += 1;
    } else if (slot.status === "partial") {
      partialSlots += 1;
    }
  }
  const totalSlots = Math.max(slots.length, MIN_COVERAGE_DENOMINATOR);
  const weightedCovered = filledSlots + partialSlots * PARTIAL_SLOT_WEIGHT;
  const coveragePercent = Math.round((weightedCovered / totalSlots) * 100);
  return { filledSlots, partialSlots, totalSlots, coveragePercent };
}
