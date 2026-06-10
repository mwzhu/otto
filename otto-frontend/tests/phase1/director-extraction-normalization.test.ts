import { describe, expect, test } from "vitest";
import { normalizeSlotExtractionEvidence } from "@/lib/interview/director/brain";
import { missingFilledSlotComponents } from "@/lib/interview/director/slot-schema";

const evidenceId = "00000000-0000-0000-0000-000000000201";

type Extraction = Parameters<typeof normalizeSlotExtractionEvidence>[0];

function extraction(overrides: {
  slot_updates?: Array<Record<string, unknown>>;
  claims?: Array<Record<string, unknown>>;
}): Extraction {
  return {
    slot_updates: (overrides.slot_updates ??
      []) as unknown as Extraction["slot_updates"],
    claims: (overrides.claims ?? []) as unknown as Extraction["claims"],
    tool_calls: [],
    contradiction_signals: [],
  };
}

describe("director extraction normalization (Task 3)", () => {
  test("the demo session's verbatim non-answer pain point becomes asked_unknown with no value", () => {
    const result = normalizeSlotExtractionEvidence(
      extraction({
        slot_updates: [
          {
            slot_path: "friction.pain_points",
            status: "filled",
            confidence: 0.78,
            evidence_ids: [evidenceId],
            priority: 65,
            value: {
              pain_point:
                "Not sure. You would have to ask him, but I think he there's also some manual work. That happens. When we hit exceptions and things like that.",
            },
          },
        ],
      }),
      [evidenceId],
    );

    expect(result.slot_updates).toHaveLength(1);
    expect(result.slot_updates[0].status).toBe("asked_unknown");
    expect(result.slot_updates[0].value).toBeUndefined();
    expect(result.slot_updates[0].evidence_ids).toEqual([evidenceId]);
  });

  test("a dont_know turn never stores filled slot values", () => {
    const result = normalizeSlotExtractionEvidence(
      extraction({
        slot_updates: [
          {
            slot_path: "metrics.kpis",
            status: "filled",
            confidence: 0.8,
            evidence_ids: [evidenceId],
            priority: 70,
            value: { metrics: ["I would need to check with the team"] },
          },
        ],
      }),
      [evidenceId],
      { utteranceType: "dont_know" },
    );

    expect(result.slot_updates[0].status).toBe("asked_unknown");
    expect(result.slot_updates[0].value).toBeUndefined();
  });

  test("substantive pain points stay filled", () => {
    const result = normalizeSlotExtractionEvidence(
      extraction({
        slot_updates: [
          {
            slot_path: "friction.pain_points",
            status: "filled",
            confidence: 0.8,
            evidence_ids: [evidenceId],
            priority: 65,
            value: {
              pain_point:
                "Manual re-keying of orders into Odoo causes exception backlogs every week.",
            },
          },
        ],
      }),
      [evidenceId],
      { utteranceType: "substantive_answer" },
    );

    expect(result.slot_updates[0].status).toBe("filled");
    expect(result.slot_updates[0].value).toBeDefined();
    expect(result.slot_updates[0].confidence).toBe(0.8);
  });

  test("inferred slot updates are capped at 0.45 confidence", () => {
    const result = normalizeSlotExtractionEvidence(
      extraction({
        slot_updates: [
          {
            slot_path: "risk.spofs",
            status: "partial",
            confidence: 0.72,
            evidence_ids: [evidenceId],
            priority: 60,
            metadata: { inferred: true },
            value: { risk: "Marcus is probably the only one who knows picking" },
          },
        ],
      }),
      [evidenceId],
    );

    expect(result.slot_updates[0].confidence).toBe(0.45);
    expect(result.slot_updates[0].status).toBe("partial");
  });

  test("inferred claims are capped at 0.45 confidence", () => {
    const result = normalizeSlotExtractionEvidence(
      extraction({
        claims: [
          {
            subject_type: "person",
            subject_id: "Marcus",
            field: "single_point_of_failure",
            value: true,
            confidence: 0.9,
            evidence_ids: [evidenceId],
            metadata: { inferred: true },
          },
        ],
      }),
      [evidenceId],
    );

    expect(result.claims[0].confidence).toBe(0.45);
    expect(result.claims[0].metadata).toEqual({ inferred: true });
  });

  test("scope.boundaries without start and end conditions is demoted to partial", () => {
    const result = normalizeSlotExtractionEvidence(
      extraction({
        slot_updates: [
          {
            slot_path: "scope.boundaries",
            status: "filled",
            confidence: 0.85,
            evidence_ids: [evidenceId],
            priority: 100,
            value: { process_names: ["Order Intake"] },
          },
        ],
      }),
      [evidenceId],
    );

    expect(result.slot_updates[0].status).toBe("partial");
    expect(result.slot_updates[0].value).toEqual({
      process_names: ["Order Intake"],
    });
  });

  test("scope.boundaries with start and end conditions stays filled", () => {
    const result = normalizeSlotExtractionEvidence(
      extraction({
        slot_updates: [
          {
            slot_path: "scope.boundaries",
            status: "filled",
            confidence: 0.85,
            evidence_ids: [evidenceId],
            priority: 100,
            value: {
              start_condition: "an order email lands in the shared inbox",
              end_condition: "the order is in Odoo, confirmed, and released",
            },
          },
        ],
      }),
      [evidenceId],
    );

    expect(result.slot_updates[0].status).toBe("filled");
  });

  test("free-text boundaries that describe both ends stay filled", () => {
    expect(
      missingFilledSlotComponents(
        "scope.boundaries",
        "Starts when an order email lands and is done once it's in Odoo, confirmed, released.",
      ),
    ).toEqual([]);
    expect(
      missingFilledSlotComponents("scope.boundaries", "Order Intake"),
    ).toEqual(["start_condition", "end_condition"]);
  });

  test("empty business outcomes are demoted while populated ones stay filled", () => {
    const result = normalizeSlotExtractionEvidence(
      extraction({
        slot_updates: [
          {
            slot_path: "outcomes.business_outcomes",
            status: "filled",
            confidence: 0.8,
            evidence_ids: [evidenceId],
            priority: 98,
            value: {},
          },
          {
            slot_path: "outcomes.business_outcomes",
            status: "filled",
            confidence: 0.8,
            evidence_ids: [evidenceId],
            priority: 98,
            value: { outcomes: ["ship every order within 24 hours"] },
          },
        ],
      }),
      [evidenceId],
    );

    expect(result.slot_updates[0].status).toBe("partial");
    expect(result.slot_updates[1].status).toBe("filled");
  });

  test("evidence normalization still drops unknown evidence ids", () => {
    const result = normalizeSlotExtractionEvidence(
      extraction({
        slot_updates: [
          {
            slot_path: "metrics.kpis",
            status: "filled",
            confidence: 0.8,
            evidence_ids: ["11111111-1111-1111-1111-111111111111"],
            priority: 70,
            value: { metrics: ["cycle time"] },
          },
        ],
        claims: [
          {
            subject_type: "candidate_process",
            subject_id: "22222222-2222-2222-2222-222222222222",
            field: "kpi",
            value: { name: "cycle time" },
            confidence: 0.8,
            evidence_ids: ["11111111-1111-1111-1111-111111111111"],
          },
        ],
      }),
      [evidenceId],
    );

    expect(result.slot_updates[0].evidence_ids).toEqual([evidenceId]);
    expect(result.claims[0].evidence_ids).toEqual([]);
  });
});
