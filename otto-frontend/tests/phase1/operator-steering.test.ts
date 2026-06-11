import { describe, expect, test } from "vitest";
import {
  applySteeringIntentExclusions,
  buildOperatorSteeringContext,
  checkerVerdictSignalFromDeliveryJson,
  consecutivePriorIntentFirings,
  deterministicOperatorTurnPlan,
  normalizeOperatorPlan,
  operatorIntentDirective,
  pendingReExtractSlotPaths,
  phraseOperatorSteeringTurn,
  probeFiringSummariesFromRows,
  provisionallyAnsweredSlotPaths,
  type OperatorProbeFiringRow,
  type OperatorSteeringPlanResult,
} from "@/lib/interview/operator/brain";
import {
  operatorProbeDirectiveForIntent,
  operatorProbePhrasingsForIntent,
} from "@/lib/interview/operator/probe-library";
import { shouldBlockSlotDowngrade } from "@/lib/interview/operator/turn-transaction";
import type { OperatorIntent, OperatorTurnPlan } from "@/lib/interview/operator/schema";

const evidenceId = "11111111-1111-4111-8111-111111111111";
const subjectId = "22222222-2222-4222-8222-222222222222";

function intentFixture(overrides: Partial<OperatorIntent> = {}): OperatorIntent {
  return {
    intent: "capture_exception_or_workaround",
    target_slot: "step.exceptions",
    score: 1000,
    reason: "The operator mentioned an exception or workaround.",
    ...overrides,
  };
}

function firing(
  intentName: string,
  targetSlot: string,
  turnIndex: number,
  msAgo: number,
): OperatorProbeFiringRow {
  return {
    probeId: intentName,
    targetSlot,
    turnIndex,
    firedAt: new Date(Date.now() - msAgo),
  };
}

function steeringContextFixture(
  overrides: Partial<Parameters<typeof buildOperatorSteeringContext>[0]> = {},
) {
  const chosenIntent = overrides.chosenIntent ?? intentFixture();
  return buildOperatorSteeringContext({
    chosenIntent,
    rankedIntents: [chosenIntent],
    filledSlotPaths: [],
    currentSlots: [],
    recentAgentUtterances: [],
    pendingExtractionTurns: [],
    pendingSlotPaths: [],
    provisionallyAnsweredSlots: [],
    priorConsecutiveIntentFirings: 0,
    ...overrides,
  });
}

function turnInputFixture(latestUtterance: string) {
  return {
    orgId: "00000000-0000-0000-0000-000000000011",
    workspaceId: "00000000-0000-0000-0000-000000000012",
    processId: "00000000-0000-0000-0000-000000000013",
    captureSessionId: "00000000-0000-0000-0000-000000000014",
    userId: "00000000-0000-0000-0000-000000000015",
    language: "en",
    latestUtterance,
    transcriptSegmentIds: ["00000000-0000-0000-0000-000000000016"],
    evidenceIds: [evidenceId],
    turnIndex: 3,
  };
}

function planFixture(overrides: Partial<OperatorTurnPlan> = {}): OperatorTurnPlan {
  const chosenIntent = overrides.chosen_intent ?? intentFixture();
  return {
    utterance_type: "substantive_answer",
    step_updates: [],
    slot_updates: [],
    claims: [],
    tool_calls: [],
    contradiction_signals: [],
    current_phase: "happy_path",
    proposed_next_phase: "happy_path",
    phase_transition_ready: false,
    ranked_intents: [chosenIntent],
    chosen_intent: chosenIntent,
    planned_agent_utterance: "When does this step fail or get stuck?",
    ...overrides,
  };
}

describe("operator probe library directives and anchors (Task 1 mirror)", () => {
  test("YAML probes expose imperative directives and full phrasings", () => {
    const directive = operatorProbeDirectiveForIntent(
      "capture_decision_rule",
      "step.decision_criteria",
    );
    expect(directive).toMatch(/^Ask the operator/);
    expect(directive).toMatch(/decide/i);
    expect(
      operatorProbePhrasingsForIntent("capture_decision_rule", "step.decision_criteria")
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("brain intents missing from the YAML resolve through their target slot", () => {
    expect(
      operatorProbePhrasingsForIntent("capture_exception_or_workaround", "step.workarounds"),
    ).toContain("Is that the normal workflow, or a workaround?");
    expect(
      operatorProbePhrasingsForIntent("capture_exception_or_workaround", "step.exceptions"),
    ).toContain("When does this step fail or get stuck?");
  });

  test("non-probe intents get curated imperative directives", () => {
    const directive = operatorIntentDirective(
      intentFixture({ intent: "clarify_operator_step", target_slot: "step.action_object" }),
    );
    expect(directive).toMatch(/walk through the next concrete step/i);
  });
});

describe("operator steering context (Task 1 mirror)", () => {
  test("context carries the directive, anchors, and extended do_not_ask", () => {
    const context = steeringContextFixture({
      filledSlotPaths: ["process.objective"],
      pendingSlotPaths: ["step.systems"],
      recentAgentUtterances: ["When does this step fail or get stuck?"],
    });
    expect(context.directive).toMatch(/^Ask the operator/);
    expect(context.next_objective).toBe(context.directive);
    expect(context.next_objective).not.toBe(
      "The operator mentioned an exception or workaround.",
    );
    expect(context.anchor_phrasings).toContain("When does this step fail or get stuck?");
    expect(context.verbatim_required).toBe(false);
    expect(context.consecutive_intent_count).toBe(1);
    expect(context.do_not_ask).toContain("process.objective");
    expect(context.do_not_ask).toContain("step.systems");
    expect(context.do_not_ask).toContain("When does this step fail or get stuck?");
  });
});

describe("verbatim escalation (Tasks 1 + 4b mirror)", () => {
  test("repeat intent with an unfilled target escalates to verbatim", () => {
    const context = steeringContextFixture({ priorConsecutiveIntentFirings: 1 });
    expect(context.consecutive_intent_count).toBe(2);
    expect(context.verbatim_required).toBe(true);
  });

  test("a filled target slot suppresses the repeat escalation", () => {
    const context = steeringContextFixture({
      priorConsecutiveIntentFirings: 1,
      currentSlots: [{ slotPath: "step.exceptions", status: "filled" }],
    });
    expect(context.verbatim_required).toBe(false);
  });

  test("a checker ignored-steering verdict escalates on the first repeat", () => {
    const context = steeringContextFixture({
      checkerSignal: {
        ignoredSteering: true,
        staleQuestion: false,
        offendingUtterance: "So tell me about your day-to-day.",
      },
    });
    expect(context.verbatim_required).toBe(true);
    expect(context.do_not_ask).toContain("So tell me about your day-to-day.");
  });

  test("verbatim escalation bypasses the phraser and speaks the anchor", async () => {
    const plan = planFixture();
    const steering: OperatorSteeringPlanResult = {
      plan,
      planned_agent_utterance: plan.planned_agent_utterance ?? "",
      metadata: {
        model: "deterministic-steering",
        prompt_template_id: "operator.turn.steering",
        prompt_template_version: "1",
        token_count_input: 1,
        token_count_output: 1,
        cost_cents: 0,
        latency_ms: 1,
        cache_hit: false,
        source: "deterministic_operator_steering",
        utterance_source: "fast_steering_phrase_pending",
        llm_call_elided: true,
      },
      degraded_quality: false,
      degraded_reasons: [],
      started_at: new Date(),
      input: turnInputFixture("It fails when the PO number is missing."),
      planning_context: {
        currentPhase: "happy_path",
        currentSlots: [],
        workspaceMemory: {
          candidateProcesses: [],
          systems: [],
          roles: [],
          people: [],
          vocabulary: [],
          claims: [],
        },
        recentTurns: [],
        recentScreenEvents: [],
        sopChunks: [],
      },
      live_reconciliation_signals: [],
      steering_context: steeringContextFixture({ priorConsecutiveIntentFirings: 1 }),
    };
    expect(steering.steering_context.verbatim_required).toBe(true);
    const phrased = await phraseOperatorSteeringTurn(steering);
    expect(phrased.utterance).toBe(steering.steering_context.anchor_phrasings[0]);
    expect(phrased.utteranceSource).toBe("verbatim_escalation");
    expect(phrased.fallback).toBe(false);
  });
});

describe("checker verdict signal (Task 4b mirror)", () => {
  test("ignored_next_objective flags ignored steering with the offending utterance", () => {
    const signal = checkerVerdictSignalFromDeliveryJson({
      checker_violations: [
        { type: "ignored_next_objective", severity: "high", message: "off objective" },
      ],
      stale_question_count: 0,
      spoken_agent_utterance: "Tell me about something unrelated.",
    });
    expect(signal.ignoredSteering).toBe(true);
    expect(signal.staleQuestion).toBe(false);
    expect(signal.offendingUtterance).toBe("Tell me about something unrelated.");
  });

  test("stale questions and contradicted reconciliation flag too", () => {
    expect(
      checkerVerdictSignalFromDeliveryJson({ stale_question_count: 2 }).staleQuestion,
    ).toBe(true);
    expect(
      checkerVerdictSignalFromDeliveryJson({
        checker_violations: [
          { type: "contradicted_reconciliation", severity: "medium", message: "x" },
        ],
      }).ignoredSteering,
    ).toBe(true);
  });

  test("missing or malformed delivery json yields a quiet signal", () => {
    expect(checkerVerdictSignalFromDeliveryJson(undefined)).toEqual({
      ignoredSteering: false,
      staleQuestion: false,
    });
    expect(checkerVerdictSignalFromDeliveryJson("nope").ignoredSteering).toBe(false);
  });
});

describe("cooldown and max_fires enforcement (Task 2 mirror)", () => {
  test("a probe inside its cooldown window is excluded", () => {
    const summaries = probeFiringSummariesFromRows([
      firing("capture_decision_rule", "step.decision_criteria", 2, 5_000),
    ]);
    const eligible = applySteeringIntentExclusions(
      [
        intentFixture({
          intent: "capture_decision_rule",
          target_slot: "step.decision_criteria",
          score: 900,
        }),
        intentFixture({
          intent: "clarify_operator_step",
          target_slot: "step.action_object",
          score: 700,
        }),
      ],
      { probeFiringSummaries: summaries },
    );
    expect(eligible[0].intent).toBe("clarify_operator_step");
    expect(eligible.map((candidate) => candidate.intent)).not.toContain(
      "capture_decision_rule",
    );
  });

  test("a probe at max_fires is excluded even outside the cooldown", () => {
    // decision-rule allows max_fires 3 in probes/operator.yaml.
    const summaries = probeFiringSummariesFromRows([
      firing("capture_decision_rule", "step.decision_criteria", 1, 600_000),
      firing("capture_decision_rule", "step.decision_criteria", 3, 400_000),
      firing("capture_decision_rule", "step.decision_criteria", 5, 200_000),
    ]);
    const eligible = applySteeringIntentExclusions(
      [
        intentFixture({
          intent: "capture_decision_rule",
          target_slot: "step.decision_criteria",
          score: 900,
        }),
      ],
      { probeFiringSummaries: summaries },
    );
    expect(eligible[0].intent).toBe("clarify_operator_step");
  });

  test("the exempt step-walkthrough intent always survives", () => {
    const summaries = probeFiringSummariesFromRows([
      firing("clarify_operator_step", "step.action_object", 2, 1_000),
    ]);
    const eligible = applySteeringIntentExclusions(
      [
        intentFixture({
          intent: "clarify_operator_step",
          target_slot: "step.action_object",
          score: 700,
        }),
      ],
      { probeFiringSummaries: summaries },
    );
    expect(eligible[0].intent).toBe("clarify_operator_step");
  });

  test("deterministic plan skips a cooled-down probe and keeps moving", () => {
    const summaries = probeFiringSummariesFromRows([
      firing("capture_exception_or_workaround", "step.exceptions", 2, 5_000),
    ]);
    const plan = deterministicOperatorTurnPlan({
      ...turnInputFixture("It fails when the PO number is missing from the email."),
      currentPhase: "happy_path",
      probeFiringSummaries: summaries,
    });
    expect(plan.chosen_intent.intent).not.toBe("capture_exception_or_workaround");
  });

  test("without steering signals the chooser behaves exactly as before", () => {
    const plan = deterministicOperatorTurnPlan({
      ...turnInputFixture("It fails when the PO number is missing from the email."),
      currentPhase: "happy_path",
    });
    expect(plan.chosen_intent.intent).toBe("capture_exception_or_workaround");
  });
});

describe("provisional-answer guard (Task 2 mirror)", () => {
  test("a probe answered while extraction is pending is provisionally answered", () => {
    const provisional = provisionallyAnsweredSlotPaths({
      latestUtterance: "It usually fails when the vendor invoice has no PO number attached.",
      pendingExtractionTurns: [4],
      recentFirings: [firing("capture_exception_or_workaround", "step.exceptions", 4, 10_000)],
    });
    expect(provisional).toContain("step.exceptions");
  });

  test("a don't-know reply keeps the latest probe eligible", () => {
    const provisional = provisionallyAnsweredSlotPaths({
      latestUtterance: "I don't know, honestly.",
      pendingExtractionTurns: [],
      recentFirings: [firing("capture_exception_or_workaround", "step.exceptions", 4, 10_000)],
    });
    expect(provisional).not.toContain("step.exceptions");
  });

  test("provisionally answered slots exclude their probe from the chooser", () => {
    const eligible = applySteeringIntentExclusions(
      [
        intentFixture({ score: 1000 }),
        intentFixture({
          intent: "clarify_operator_step",
          target_slot: "step.action_object",
          score: 700,
        }),
      ],
      { provisionallyAnsweredSlots: ["step.exceptions"] },
    );
    expect(eligible.map((candidate) => candidate.intent)).not.toContain(
      "capture_exception_or_workaround",
    );
  });

  test("step-advance intents are never excluded by the provisional guard", () => {
    const eligible = applySteeringIntentExclusions(
      [
        intentFixture({
          intent: "capture_next_step",
          target_slot: "step.action_object",
          score: 820,
        }),
      ],
      { provisionallyAnsweredSlots: ["step.action_object"] },
    );
    expect(eligible[0].intent).toBe("capture_next_step");
  });

  test("pending_re_extract slots stay excluded until re-extraction succeeds", () => {
    expect(
      pendingReExtractSlotPaths([
        { slotPath: "step.exceptions", status: "pending_re_extract" },
        { slotPath: "step.systems", status: "filled" },
      ]),
    ).toEqual(["step.exceptions"]);
  });
});

describe("consecutive intent firings (Task 1 mirror)", () => {
  test("counts the streak of the most recent spoken turns", () => {
    const rows = [
      firing("capture_next_step", "step.action_object", 5, 1_000),
      firing("capture_next_step", "step.action_object", 4, 30_000),
      firing("capture_decision_rule", "step.decision_criteria", 3, 60_000),
    ];
    expect(consecutivePriorIntentFirings(rows, "capture_next_step")).toBe(2);
    expect(consecutivePriorIntentFirings(rows, "capture_decision_rule")).toBe(0);
  });
});

describe("non-answer extraction hygiene (Task 3 mirror)", () => {
  test("a quoted don't-know never lands as a slot value", () => {
    const plan = planFixture({
      slot_updates: [
        {
          slot_path: "step.exceptions",
          value: {
            condition: "Not sure. You would have to ask him, but I think there's manual work.",
          },
          status: "filled",
          confidence: 0.78,
          evidence_ids: [evidenceId],
        },
      ],
    });
    const normalized = normalizeOperatorPlan(plan, plan, [evidenceId]);
    expect(normalized.plan.slot_updates[0].status).toBe("asked_unknown");
    expect(normalized.plan.slot_updates[0].value).toBeUndefined();
  });

  test("a dont_know turn converts even an innocuous-looking value", () => {
    const plan = planFixture({
      utterance_type: "dont_know",
      slot_updates: [
        {
          slot_path: "step.systems",
          value: { system_name: "maybe the ERP" },
          status: "partial",
          confidence: 0.6,
          evidence_ids: [evidenceId],
        },
      ],
    });
    const normalized = normalizeOperatorPlan(plan, plan, [evidenceId]);
    expect(normalized.plan.slot_updates[0].status).toBe("asked_unknown");
  });

  test("inferred slot values and claims are capped at 0.45", () => {
    const plan = planFixture({
      slot_updates: [
        {
          slot_path: "step.next_owner",
          value: { next_owner: "probably the AP clerk", inferred: true },
          status: "partial",
          confidence: 0.9,
          evidence_ids: [evidenceId],
        },
      ],
      claims: [
        {
          subject_type: "system",
          subject_id: subjectId,
          field: "name",
          value: "Odoo",
          confidence: 0.9,
          evidence_ids: [evidenceId],
          metadata: { inferred: true },
        },
      ],
    });
    const normalized = normalizeOperatorPlan(plan, plan, [evidenceId]);
    expect(normalized.plan.slot_updates[0].confidence).toBeLessThanOrEqual(0.45);
    expect(normalized.plan.claims[0].confidence).toBeLessThanOrEqual(0.45);
  });
});

describe("slot downgrade guard (Task 9 mirror)", () => {
  test("a filled slot is protected from lower-confidence overwrites", () => {
    expect(
      shouldBlockSlotDowngrade(
        { status: "filled", confidence: "0.85" },
        { value: { text: "a weaker answer" }, confidence: 0.6 },
      ),
    ).toBe(true);
  });

  test("a filled slot is protected from non-answer overwrites at any confidence", () => {
    expect(
      shouldBlockSlotDowngrade(
        { status: "filled", confidence: "0.7" },
        { value: { text: "those employees I just mentioned" }, confidence: 0.95 },
      ),
    ).toBe(true);
  });

  test("higher-confidence real answers and partial slots still write", () => {
    expect(
      shouldBlockSlotDowngrade(
        { status: "filled", confidence: "0.7" },
        { value: { text: "the AP clerk approves it in Odoo" }, confidence: 0.9 },
      ),
    ).toBe(false);
    expect(
      shouldBlockSlotDowngrade(
        { status: "partial", confidence: "0.9" },
        { value: { text: "anything" }, confidence: 0.1 },
      ),
    ).toBe(false);
  });
});
