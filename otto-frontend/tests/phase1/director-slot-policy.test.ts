import { describe, expect, test } from "vitest";
import {
  directorSlotPathsMissingPolicy,
  directorSlotPolicy,
  isClaimBackedSlot,
  mergeSlotStringLists,
  scopedSlotValuesEqual,
  slotStringList,
  slotValueKind,
  slotValueShape,
  slotValuesEqual,
} from "@/lib/interview/director/slot-policy";
import { boundedDirectorReconciliationTrace } from "@/lib/interview/director/reconciliation";
import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";

describe("director slot taxonomy (Phase 0.1)", () => {
  test("every defined slot has a reconciliation policy", () => {
    expect(directorSlotPathsMissingPolicy()).toEqual([]);
  });

  test("each defined slot resolves to a policy without throwing", () => {
    for (const definition of directorSlotDefinitions) {
      expect(() => directorSlotPolicy(definition.path)).not.toThrow();
    }
  });

  test("unknown slot path throws (schema drift surfaces early)", () => {
    expect(() => directorSlotPolicy("bogus.path")).toThrow(/policy/i);
  });

  test("backing matches the durable source of truth", () => {
    // candidate-backed
    expect(slotValueKind("process.inventory")).toBe("candidate");
    // slot-state-backed
    expect(slotValueKind("function.name")).toBe("slot_state");
    expect(slotValueKind("scope.boundaries")).toBe("slot_state");
    expect(slotValueKind("frequency.volume")).toBe("slot_state");
    // claim-backed — the majority class, incl. pain points / spofs / kpis / deps
    for (const path of [
      "systems.systems_of_record",
      "ownership.roles",
      "people.key_people",
      "friction.pain_points",
      "risk.spofs",
      "metrics.kpis",
      "handoffs.dependencies",
    ]) {
      expect(slotValueKind(path)).toBe("claim");
      expect(isClaimBackedSlot(path)).toBe(true);
    }
  });

  test("claim-backed slots are summary-shaped (merge happens in claim layer)", () => {
    expect(slotValueShape("systems.systems_of_record")).toBe("summary");
    expect(directorSlotPolicy("metrics.kpis").reconcile).toBe(
      "merge_in_claim_layer",
    );
  });

  test("function.name is scalar, outcomes/variants are list-like", () => {
    expect(slotValueShape("function.name")).toBe("scalar");
    expect(slotValueShape("outcomes.business_outcomes")).toBe("string_list");
    expect(slotValueShape("variants.exceptions")).toBe("string_list");
  });
});

describe("slot string-list primitives", () => {
  test("extracts from arrays, wrapper objects, and delimited strings", () => {
    expect(slotStringList(["A", "B"])).toEqual(["A", "B"]);
    expect(slotStringList({ roles: ["VP Ops", "CSR"] })).toEqual([
      "VP Ops",
      "CSR",
    ]);
    expect(slotStringList({ process_names: ["Order Intake"] })).toEqual([
      "Order Intake",
    ]);
    expect(slotStringList("cycle time, error rate; on-time")).toEqual([
      "cycle time",
      "error rate",
      "on-time",
    ]);
  });

  test("dedupes exact repeats, preserves order and casing", () => {
    expect(slotStringList(["Salesforce", "Salesforce", "NetSuite"])).toEqual([
      "Salesforce",
      "NetSuite",
    ]);
  });

  test("merge unions, dedupes case-insensitively, first casing wins", () => {
    expect(
      mergeSlotStringLists({ systems: ["Salesforce"] }, { systems: ["salesforce", "NetSuite"] }),
    ).toEqual(["Salesforce", "NetSuite"]);
  });

  test("merge preserves existing order before new additions", () => {
    expect(mergeSlotStringLists(["manual entry"], ["approval delays"])).toEqual([
      "manual entry",
      "approval delays",
    ]);
  });
});

describe("shape-aware value equality", () => {
  test("scalar equality is whitespace/case-insensitive", () => {
    expect(slotValuesEqual("function.name", "VP of Operations", "vp of operations")).toBe(true);
    expect(slotValuesEqual("function.name", " VP  of Operations ", "VP of Operations")).toBe(true);
    expect(slotValuesEqual("function.name", "VP of Operations", "Customer Service")).toBe(false);
  });

  test("scalar equality unwraps a wrapper object", () => {
    expect(slotValuesEqual("function.name", { name: "VP of Operations" }, "vp of operations")).toBe(true);
  });

  test("scalar equality preserves meaningful wrapper context", () => {
    expect(
      slotValuesEqual(
        "frequency.volume",
        { value: "daily", scope: "month-end" },
        "daily",
      ),
    ).toBe(false);
    expect(
      slotValuesEqual(
        "frequency.volume",
        { value: "daily", scope: "month-end" },
        { value: "Daily", scope: "Month-End" },
      ),
    ).toBe(true);
  });

  test("scoped scalar equality treats same label in different process scopes as different facts", () => {
    expect(
      scopedSlotValuesEqual(
        {
          slotPath: "frequency.volume",
          candidateProcessId: "00000000-0000-0000-0000-000000000101",
          value: "daily",
        },
        {
          slotPath: "frequency.volume",
          candidateProcessId: "00000000-0000-0000-0000-000000000202",
          value: " daily ",
        },
      ),
    ).toBe(false);
    expect(
      scopedSlotValuesEqual(
        {
          slotPath: "frequency.volume",
          candidateProcessId: "00000000-0000-0000-0000-000000000101",
          value: "daily",
        },
        {
          slotPath: "frequency.volume",
          candidateProcessId: "00000000-0000-0000-0000-000000000101",
          value: " daily ",
        },
      ),
    ).toBe(true);
  });

  test("string-list equality is order-insensitive", () => {
    expect(
      slotValuesEqual(
        "outcomes.business_outcomes",
        { outcomes: ["on-time", "accuracy"] },
        { outcomes: ["accuracy", "on-time"] },
      ),
    ).toBe(true);
    expect(
      slotValuesEqual(
        "outcomes.business_outcomes",
        { outcomes: ["on-time"] },
        { outcomes: ["on-time", "accuracy"] },
      ),
    ).toBe(false);
  });

  test("structured equality is member-order insensitive", () => {
    expect(
      slotValuesEqual(
        "scope.boundaries",
        { process_names: ["Order Intake", "Returns"] },
        { process_names: ["Returns", "Order Intake"] },
      ),
    ).toBe(true);
  });

  test("null/undefined compare equal, differ from a real value", () => {
    expect(slotValuesEqual("function.name", null, undefined)).toBe(true);
    expect(slotValuesEqual("function.name", null, "VP Ops")).toBe(false);
  });
});

describe("reconciliation trace bounds", () => {
  test("caps decision counts and rationale length", () => {
    const trace = boundedDirectorReconciliationTrace({
      slotDecisions: Array.from({ length: 12 }, (_, index) => ({
        slotPath: "function.name",
        backing: "slot_state" as const,
        action: "confirm" as const,
        value: "VP Ops",
        confidence: 0.9,
        evidenceIds: ["00000000-0000-0000-0000-000000000101"],
        rationale: `decision ${index} ${"x".repeat(400)}`,
      })),
      processDecisions: Array.from({ length: 11 }, (_, index) => ({
        incomingName: `Process ${index}`,
        action: "create_candidate" as const,
        confidence: 0.8,
        evidenceIds: ["00000000-0000-0000-0000-000000000101"],
        rationale: "y".repeat(400),
      })),
    });

    expect(trace.slot_decisions).toHaveLength(10);
    expect(trace.process_decisions).toHaveLength(10);
    expect(trace.dropped_decisions).toBe(3);
    expect(trace.slot_decisions[0].rationale.length).toBeLessThanOrEqual(240);
    expect(trace.process_decisions[0].rationale.length).toBeLessThanOrEqual(240);
  });
});
