import { describe, expect, test } from "vitest";
import { computeComplexityScore } from "@/lib/synthesis/complexity";
import { generateCandidateNarrative } from "@/lib/synthesis/narrative";

describe("Week 4 synthesis and DB-backed UI contracts", () => {
  test("complexity scoring explains every factor with evidence or assumptions", () => {
    const score = computeComplexityScore({
      systemCount: 3,
      roleCount: 2,
      frequency: "daily",
      painPoints: [{ text: "manual spreadsheet cleanup", evidenceIds: ["e1"] }],
      risks: [{ text: "single point of failure", evidenceIds: ["e2"] }],
      documentationEvidenceCount: 1,
      evidenceIds: ["e1", "e2"],
    });

    expect(score.total).toBeGreaterThan(45);
    expect(Object.keys(score.factors)).toEqual([
      "system_sprawl",
      "handoff_count",
      "frequency_pressure",
      "friction_severity",
      "spof_risk",
      "documentation_gap",
    ]);
    expect(score.factors.spof_risk.evidenceIds).toContain("e2");
  });

  test("narrative generation labels thin evidence instead of inventing certainty", () => {
    const complexity = computeComplexityScore({
      frequency: null,
      evidenceIds: ["e1"],
    });
    const narrative = generateCandidateNarrative({
      name: "Promotion Management",
      evidenceIds: ["e1"],
      complexity,
    });

    expect(narrative.inferred).toBe(true);
    expect(narrative.whatThisProcessInvolves).toContain("Evidence is still thin");
    expect(narrative.evidenceLinks).toEqual(["e1"]);
  });
});
