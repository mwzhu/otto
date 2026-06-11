import { describe, expect, test } from "vitest";
import { computeRoiRange, tightenRoiRange } from "@/lib/roi";
import { directorAutomationPlanPayloadSchema } from "@/lib/processes/director-automation-schema";

const validPlan = {
  department_name: "Finance",
  audit: {
    problem:
      "Finance closes are slowed by fragmented reconciliations and manual exception handling.",
    patterns: [
      {
        text: "Close work spans three systems and delays variance review.",
        metric_basis: "3 systems affected; 5-7 day close window.",
        evidence_ids: ["claim-1"],
      },
      {
        text: "Exception handling consumes senior analyst capacity.",
        metric_basis: "12-18% modeled exception rate.",
        evidence_ids: [],
      },
      {
        text: "Manual validation creates recurring rework.",
        metric_basis: "2-4% modeled error rate across reconciliations.",
        evidence_ids: [],
      },
    ],
  },
  processes: [
    {
      candidate_process_id: "candidate-1",
      process_name: "Accounts payable reconciliation",
      implementation_plan:
        "A reconciliation agent watches ERP and bank feeds, matches invoices to payments, flags exceptions into an owner queue, and routes ambiguous cases for controller review.",
      expected_result:
        "Reduce close-cycle reconciliation time by 400-800 hours per year while lowering exception aging from 5-7 days to 2-3 days.",
      automation_type: "system_integration",
      pattern_id: "system-integration",
      pattern_label: "System integration",
      affected_roles: ["AP analyst", "Controller"],
      affected_systems: ["ERP", "Bank portal"],
      evidence_gaps: ["Confirm annual invoice volume"],
      confidence: 0.7,
      effort_band: "med",
      assumptions: {
        annual_volume: range(9000, 12000, 15000, "evidence", 0.75, ["claim-1"]),
        minutes_saved_per_case: range(4, 6, 8, "inferred", 0.4, []),
        error_rate: range(0.02, 0.03, 0.04, "inferred", 0.35, []),
        exception_rate: range(0.12, 0.15, 0.18, "inferred", 0.4, []),
      },
    },
  ],
};

describe("director automation plan", () => {
  test("requires range ordering and evidence ids for evidence-based assumptions", () => {
    const invalid = structuredClone(validPlan);
    invalid.processes[0].assumptions.annual_volume = range(
      12000,
      9000,
      15000,
      "evidence",
      0.75,
      [],
    );

    expect(() => directorAutomationPlanPayloadSchema.parse(invalid)).toThrow(
      /range must satisfy|evidence_ids/,
    );
  });

  test("caps inferred assumption confidence", () => {
    const invalid = structuredClone(validPlan);
    invalid.processes[0].assumptions.minutes_saved_per_case = range(
      4,
      6,
      8,
      "inferred",
      0.8,
      [],
    );

    expect(() => directorAutomationPlanPayloadSchema.parse(invalid)).toThrow(
      /confidence must be <= 0.45/,
    );
  });

  test("computes deterministic low-base-high ROI ranges", () => {
    const result = computeRoiRange(
      {
        annual_volume: { low: 100, base: 200, high: 300 },
        minutes_saved_per_case: { low: 6, base: 12, high: 18 },
        error_rate: { low: 0.01, base: 0.02, high: 0.03 },
        exception_rate: { low: 0.05, base: 0.1, high: 0.15 },
      },
      {
        loaded_hourly_cost: 60,
        cost_per_error: 100,
        delay_cost: 20,
      },
      {
        confidence: 0.5,
        effort_penalty: 1.25,
      },
    );

    expect(result.annual_time_value).toEqual({ low: 600, base: 2400, high: 5400 });
    expect(result.annual_error_value).toEqual({ low: 100, base: 400, high: 900 });
    expect(result.annual_delay_value).toEqual({ low: 100, base: 400, high: 900 });
    expect(result.net_score).toEqual({ low: 320, base: 1280, high: 2880 });
  });

  test("tightens planning ranges to ±10% of base", () => {
    // Wide extracted range clamps to the band.
    expect(tightenRoiRange({ low: 600, base: 2400, high: 5400 })).toEqual({
      low: 2160,
      base: 2400,
      high: 2640,
    });
    // Genuinely narrower bounds are kept.
    expect(tightenRoiRange({ low: 2300, base: 2400, high: 2450 })).toEqual({
      low: 2300,
      base: 2400,
      high: 2450,
    });
    // Bounds never drift more than 10% from the midpoint, even asymmetric.
    const tightened = tightenRoiRange({ low: 2350, base: 2400, high: 9000 });
    const midpoint = (tightened.low + tightened.high) / 2;
    expect(Math.abs(tightened.low - midpoint) / midpoint).toBeLessThanOrEqual(0.1);
    expect(Math.abs(tightened.high - midpoint) / midpoint).toBeLessThanOrEqual(0.1);
  });
});

function range(
  low: number,
  base: number,
  high: number,
  basis: "evidence" | "inferred",
  confidence: number,
  evidence_ids: string[],
) {
  return { low, base, high, basis, confidence, evidence_ids };
}
