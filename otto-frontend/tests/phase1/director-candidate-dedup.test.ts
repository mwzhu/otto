import { describe, expect, test } from "vitest";
import {
  materializeDirectorProcessInventory,
  candidateProcessBelongsToSession,
} from "@/lib/interview/director/brain";
import {
  reconcileSlotUpdate,
  shouldBlockSlotDowngrade,
} from "@/lib/interview/director/tools";
import {
  isNonAnswerSlotExtraction,
  extractionValueText,
} from "@/lib/interview/director/slot-non-answer";
import { normalizeSlotExtractionEvidence } from "@/lib/interview/director/brain";
import type { DirectorTurnPlan } from "@/lib/schemas/phase1";

const evidenceId = "00000000-0000-0000-0000-000000000301";

function candidateProcessTool(targetProcess: string, confidence: number) {
  return {
    name: "recordCandidateProcessClaim",
    arguments: {
      targetProcess,
      field: "proposed_name",
      value: targetProcess,
      confidence,
    },
  };
}

function basePlan(overrides: Partial<DirectorTurnPlan>): DirectorTurnPlan {
  const chosenIntent = {
    intent: "discover_processes",
    target_slot: "process.inventory",
    score: 100,
    reason: "Capture the named processes.",
  };
  return {
    utterance_type: "substantive_answer",
    slot_updates: [],
    claims: [],
    tool_calls: [],
    contradiction_signals: [],
    current_phase: "inventory",
    proposed_next_phase: "expand",
    phase_transition_ready: true,
    ranked_intents: [chosenIntent],
    chosen_intent: chosenIntent,
    planned_agent_utterance: "Which one should we map first?",
    ...overrides,
  } satisfies DirectorTurnPlan;
}

function recordedProcessNames(plan: DirectorTurnPlan): string[] {
  return plan.tool_calls
    .filter((tool) => tool.name === "recordProcess")
    .map((tool) => String(tool.arguments.name));
}

describe("Task 7 — candidate process dedup at materialization", () => {
  // Session 83fdd5a6 produced 16 candidates from a six-process answer: the
  // extractor kept each compound phrase AND split it into atoms (the
  // containment-pair artifact the deterministic guard fixes). This replays the
  // emitted shape (compound names at 0.74, split atoms at 0.93). The order-intake
  // fulfillment-chain split (Order Picking/Shipping/Invoicing) is a separate
  // artifact class — sub-steps share no name containment with "order intake", so
  // the deterministic guard intentionally cannot catch them; the prompt rule
  // (Candidate Process Rules in director.turn.plan.md) prevents that one.
  test("the six-process utterance collapses to one candidate per named process", () => {
    const plan = materializeDirectorProcessInventory(
      basePlan({
        tool_calls: [
          // The six processes the director actually named.
          candidateProcessTool("order intake", 0.74),
          candidateProcessTool("vendor invoice processing", 0.74),
          candidateProcessTool("inventory cycle counts", 0.74),
          candidateProcessTool("purchasing and replenishment", 0.74),
          candidateProcessTool("new customer onboarding and credit setup", 0.74),
          candidateProcessTool("returns and credit memos", 0.74),
          // Over-extraction artifacts: compound names split into atoms.
          candidateProcessTool("Purchasing", 0.93),
          candidateProcessTool("Replenishment", 0.93),
          candidateProcessTool("New Customer Onboarding", 0.93),
          candidateProcessTool("Credit Setup", 0.93),
          candidateProcessTool("Returns", 0.93),
          candidateProcessTool("Credit Memos", 0.93),
        ],
      }),
    );

    const names = recordedProcessNames(plan);
    const normalized = names.map((name) => name.toLowerCase());

    // At most seven candidates (the six named processes survive; the split atoms
    // collapse into their compound).
    expect(names.length).toBeLessThanOrEqual(7);

    // No Purchasing + "purchasing and replenishment" pair; the compound wins.
    expect(normalized).toContain("purchasing and replenishment");
    expect(normalized).not.toContain("purchasing");
    expect(normalized).not.toContain("replenishment");

    // Same for the other two compounds.
    expect(normalized).toContain("returns and credit memos");
    expect(normalized).not.toContain("returns");
    expect(normalized).not.toContain("credit memos");
    expect(normalized).toContain("new customer onboarding and credit setup");
    expect(normalized).not.toContain("new customer onboarding");
    expect(normalized).not.toContain("credit setup");

    // The collapsed atoms must not survive as residual recordCandidateProcessClaim
    // proposed_name tools either — otherwise dispatch would resurface them.
    const residualClaimNames = plan.tool_calls
      .filter(
        (tool) =>
          tool.name === "recordCandidateProcessClaim" &&
          String(tool.arguments.field).toLowerCase() === "proposed_name",
      )
      .map((tool) => String(tool.arguments.targetProcess ?? tool.arguments.value).toLowerCase());
    expect(residualClaimNames).not.toContain("purchasing");
    expect(residualClaimNames).not.toContain("replenishment");
    expect(residualClaimNames).not.toContain("returns");
    expect(residualClaimNames).not.toContain("credit memos");
  });

  // The deterministic guard only collapses true containment pairs. "Order
  // Picking"/"Shipping"/"Invoicing" share no containment with "order intake", so
  // the *code* guard leaves them — the prompt rule is responsible for not
  // promoting sub-steps. When the director DOES separately enumerate steps as
  // their own processes, they are correctly preserved.
  test("non-containment processes are preserved (guard does not over-merge)", () => {
    const plan = materializeDirectorProcessInventory(
      basePlan({
        tool_calls: [
          candidateProcessTool("order intake", 0.9),
          candidateProcessTool("order picking", 0.9),
          candidateProcessTool("shipping", 0.9),
          candidateProcessTool("invoicing", 0.9),
        ],
      }),
    );
    const normalized = recordedProcessNames(plan).map((name) => name.toLowerCase());
    expect(normalized).toEqual([
      "order intake",
      "order picking",
      "shipping",
      "invoicing",
    ]);
  });

  test("pure case/whitespace duplicates collapse to the higher-confidence row", () => {
    const plan = materializeDirectorProcessInventory(
      basePlan({
        tool_calls: [
          candidateProcessTool("Purchasing", 0.6),
          candidateProcessTool("purchasing", 0.93),
        ],
      }),
    );
    const names = recordedProcessNames(plan);
    expect(names).toHaveLength(1);
  });
});

describe("Extract 500 — name-valued candidate id must not hit the uuid column", () => {
  // Prod regression (sessions 83fdd5a6 turn 4, db0597d3 turn 0): the extractor
  // handed back a process *name* ("order intake") as candidate_process_id. The
  // belongs-to-session guard compared it against the uuid `candidate_processes.id`
  // column, so Postgres threw `invalid input syntax for type uuid: "order intake"`,
  // which was unhandled and 500'd the whole turn's extraction (slots/claims lost).
  // The fix short-circuits non-UUID ids to false *before* touching the tx, so the
  // caller falls back to the focus candidate instead of crashing.
  const ctx = {
    orgId: "00000000-0000-0000-0000-0000000000aa",
    workspaceId: "00000000-0000-0000-0000-0000000000bb",
    captureSessionId: "00000000-0000-0000-0000-0000000000cc",
  } as never;

  // A tx that explodes the instant it is touched — proves the DB is never queried.
  const explodingTx = new Proxy(
    {},
    {
      get() {
        throw new Error(
          "candidate_processes must not be queried with a non-UUID id",
        );
      },
    },
  ) as never;

  test("a process-name candidate id returns false without querying the db", async () => {
    await expect(
      candidateProcessBelongsToSession(ctx, "order intake", explodingTx),
    ).resolves.toBe(false);
    await expect(
      candidateProcessBelongsToSession(ctx, "forecasting", explodingTx),
    ).resolves.toBe(false);
  });

  test("a real uuid still flows through to the db query", async () => {
    // With a valid uuid the guard passes and the tx IS used (then throws here),
    // confirming the short-circuit is scoped only to non-UUID input.
    await expect(
      candidateProcessBelongsToSession(
        ctx,
        "00000000-0000-0000-0000-0000000000dd",
        explodingTx,
      ),
    ).rejects.toThrow(/must not be queried with a non-UUID id/);
  });
});

describe("Task 9 — non-answer detection broadened", () => {
  test("the garbled function-name deflection is a non-answer", () => {
    expect(
      isNonAnswerSlotExtraction({
        function_name: "Those Peep Those Employees I Just Mentioned",
      }),
    ).toBe(true);
    expect(
      isNonAnswerSlotExtraction(
        "I oversee those peep those employees I just mentioned",
      ),
    ).toBe(true);
  });

  test("legitimate function-name answers are not non-answers", () => {
    expect(isNonAnswerSlotExtraction({ function_name: "VP of operations" })).toBe(
      false,
    );
    expect(isNonAnswerSlotExtraction("I lead the finance department")).toBe(false);
    expect(isNonAnswerSlotExtraction({ name: "Accounts Payable" })).toBe(false);
  });

  test("explicit don't-know phrasing is still caught", () => {
    expect(isNonAnswerSlotExtraction("Not sure, you'd have to ask him")).toBe(true);
  });

  test("the deflection is converted to asked_unknown by the normalizer", () => {
    const result = normalizeSlotExtractionEvidence(
      {
        slot_updates: [
          {
            slot_path: "function.name",
            status: "filled",
            confidence: 0.78,
            evidence_ids: [evidenceId],
            priority: 100,
            value: {
              function_name: "Those Peep Those Employees I Just Mentioned",
            },
          },
        ],
        claims: [],
        tool_calls: [],
        contradiction_signals: [],
      } as never,
      [evidenceId],
    );
    expect(result.slot_updates[0].status).toBe("asked_unknown");
    expect(result.slot_updates[0].value).toBeUndefined();
  });

  test("extractionValueText flattens nested slot values", () => {
    expect(extractionValueText({ function_name: "VP of operations" })).toBe(
      "VP of operations",
    );
  });
});

describe("Task 9 — slot downgrade guard", () => {
  const filledVpSlot = { status: "filled" as const, confidence: "0.91" };

  test("a non-answer never replaces a filled slot", () => {
    expect(
      shouldBlockSlotDowngrade(filledVpSlot, {
        value: { function_name: "Those Peep Those Employees I Just Mentioned" },
        confidence: 0.78,
      }),
    ).toBe(true);
  });

  test("a strictly lower-confidence value never replaces a filled slot", () => {
    expect(
      shouldBlockSlotDowngrade(filledVpSlot, {
        value: { function_name: "VP of ops" },
        confidence: 0.6,
      }),
    ).toBe(true);
  });

  test("an equal-or-higher-confidence real answer still overwrites", () => {
    expect(
      shouldBlockSlotDowngrade(filledVpSlot, {
        value: { function_name: "Chief Operating Officer" },
        confidence: 0.95,
      }),
    ).toBe(false);
    expect(
      shouldBlockSlotDowngrade(filledVpSlot, {
        value: { function_name: "VP of operations and logistics" },
        confidence: 0.91,
      }),
    ).toBe(false);
  });

  test("non-filled slots are never protected", () => {
    expect(
      shouldBlockSlotDowngrade(
        { status: "partial", confidence: "0.91" },
        { value: { function_name: "anything" }, confidence: 0.1 },
      ),
    ).toBe(false);
    expect(
      shouldBlockSlotDowngrade(
        { status: "empty", confidence: "0.91" },
        { value: { function_name: "anything" }, confidence: 0.1 },
      ),
    ).toBe(false);
  });

  // The full session sequence: "VP of operations" lands filled, then the garbled
  // deflection arrives. The guard blocks it, so the stored value stays "VP of
  // operations".
  test("replaying the two function.name turns keeps VP of operations", () => {
    // Turn 1 lands as a fresh filled value (no existing slot → not blocked).
    expect(
      shouldBlockSlotDowngrade(
        { status: "empty", confidence: "0" },
        { value: { function_name: "VP of operations" }, confidence: 0.9 },
      ),
    ).toBe(false);
    // Turn 2 (garbled deflection) is blocked against the now-filled slot.
    expect(
      shouldBlockSlotDowngrade(
        { status: "filled", confidence: "0.9" },
        {
          value: { function_name: "Those Peep Those Employees I Just Mentioned" },
          confidence: 0.78,
        },
      ),
    ).toBe(true);
  });
});

describe("Director continuous slot reconciliation", () => {
  test("slot-state-backed lists merge unique values and evidence", () => {
    const result = reconcileSlotUpdate(
      {
        slotPath: "outcomes.business_outcomes",
        value: ["on-time delivery"],
        status: "partial",
        confidence: 0.7,
        evidenceIds: ["00000000-0000-0000-0000-000000000301"],
        candidates: [],
      },
      {
        slotPath: "outcomes.business_outcomes",
        value: ["On-Time Delivery", "fewer credits"],
        status: "filled",
        confidence: 0.65,
        evidenceIds: ["00000000-0000-0000-0000-000000000302"],
        candidates: [],
        changeKind: "addition",
      },
    );

    expect(result.write).toBe("upsert");
    expect(result.value).toEqual(["on-time delivery", "fewer credits"]);
    expect(result.status).toBe("filled");
    expect(result.evidenceIds).toEqual([
      "00000000-0000-0000-0000-000000000301",
      "00000000-0000-0000-0000-000000000302",
    ]);
    expect(result.decision.action).toBe("merge");
  });

  test("conflicting scalar values preserve both candidates", () => {
    const result = reconcileSlotUpdate(
      {
        slotPath: "frequency.volume",
        candidateProcessId: "00000000-0000-0000-0000-000000000401",
        value: "weekly",
        status: "filled",
        confidence: 0.8,
        evidenceIds: ["00000000-0000-0000-0000-000000000301"],
        candidates: [],
      },
      {
        slotPath: "frequency.volume",
        candidateProcessId: "00000000-0000-0000-0000-000000000401",
        value: "daily",
        status: "filled",
        confidence: 0.85,
        evidenceIds: ["00000000-0000-0000-0000-000000000302"],
        candidates: [],
      },
    );

    expect(result.write).toBe("upsert");
    expect(result.status).toBe("conflicting");
    expect(result.value).toBe("weekly");
    expect(result.decision.action).toBe("conflict");
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "weekly", reason: "current_value" }),
        expect.objectContaining({
          value: "daily",
          reason: "conflicting_incoming_value",
        }),
      ]),
    );
  });

  test("explicit scalar correction replaces value but preserves prior value", () => {
    const result = reconcileSlotUpdate(
      {
        slotPath: "frequency.volume",
        value: "weekly",
        status: "filled",
        confidence: 0.8,
        evidenceIds: ["00000000-0000-0000-0000-000000000301"],
        candidates: [],
      },
      {
        slotPath: "frequency.volume",
        value: "daily",
        status: "filled",
        confidence: 0.75,
        evidenceIds: ["00000000-0000-0000-0000-000000000302"],
        candidates: [],
        changeKind: "correction",
      },
    );

    expect(result.write).toBe("upsert");
    expect(result.value).toBe("daily");
    expect(result.status).toBe("filled");
    expect(result.decision.action).toBe("correct");
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "weekly",
          reason: "previous_value_before_correction",
        }),
      ]),
    );
  });

  test("claim-backed slot summaries do not become a second merged list", () => {
    const result = reconcileSlotUpdate(
      {
        slotPath: "systems.systems_of_record",
        value: { systems: ["Salesforce"] },
        status: "filled",
        confidence: 0.8,
        evidenceIds: ["00000000-0000-0000-0000-000000000301"],
        candidates: [],
      },
      {
        slotPath: "systems.systems_of_record",
        value: { systems: ["NetSuite"] },
        status: "filled",
        confidence: 0.85,
        evidenceIds: ["00000000-0000-0000-0000-000000000302"],
        candidates: [],
        changeKind: "addition",
      },
    );

    expect(result.write).toBe("upsert");
    expect(result.value).toEqual({ systems: ["Salesforce"] });
    expect(result.decision.action).toBe("enrich");
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: { systems: ["NetSuite"] },
          reason: "claim_layer_value_summary",
        }),
      ]),
    );
  });
});
