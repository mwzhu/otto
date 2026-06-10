import { describe, expect, test } from "vitest";
import {
  applySteeringIntentExclusions,
  buildDirectorSteeringContext,
  checkerVerdictSignalFromDeliveryJson,
  consecutivePriorIntentFirings,
  deterministicTurnPlan,
  directorIntentDirective,
  probeFiringSummariesFromRows,
  provisionallyAnsweredSlotPaths,
  type DirectorProbeFiringRow,
} from "@/lib/interview/director/brain";
import { phraseDirectorTurnDetailed } from "@/lib/interview/director/voice";
import {
  probeDirectiveForIntent,
  probePhrasingsForIntent,
} from "@/lib/interview/director/probe-library";
import type { DirectorIntent } from "@/lib/schemas/phase1";

const evidenceId = "00000000-0000-0000-0000-000000000001";

function intentFixture(overrides: Partial<DirectorIntent> = {}): DirectorIntent {
  return {
    intent: "discover_processes",
    target_slot: "process.inventory",
    score: 1125,
    reason: "No process inventory is captured yet.",
    ...overrides,
  };
}

function firing(
  intentName: string,
  targetSlot: string,
  turnIndex: number,
  msAgo: number,
): DirectorProbeFiringRow {
  return {
    probeId: intentName,
    targetSlot,
    turnIndex,
    firedAt: new Date(Date.now() - msAgo),
  };
}

function steeringContextFixture(
  overrides: Partial<Parameters<typeof buildDirectorSteeringContext>[0]> = {},
) {
  const chosenIntent = overrides.chosenIntent ?? intentFixture();
  return buildDirectorSteeringContext({
    chosenIntent,
    rankedIntents: [chosenIntent],
    filledSlotPaths: [],
    currentSlots: new Map(),
    recentTurns: [],
    pendingExtractionTurns: [],
    pendingSlotPaths: [],
    provisionallyAnsweredSlots: [],
    priorConsecutiveIntentFirings: 0,
    ...overrides,
  });
}

describe("steering context directive and anchors (Task 1)", () => {
  test("steering context carries an imperative directive and YAML anchor phrasings", () => {
    const context = steeringContextFixture({
      recentTurns: [
        "Director: I run supply chain.",
        "Otto: What part of the business do you oversee?",
      ],
    });
    expect(context.directive).toMatch(/recurring processes/i);
    expect(context.directive).toMatch(/^Ask the director/);
    // next_objective is the directive, not the status reason.
    expect(context.next_objective).toBe(context.directive);
    expect(context.next_objective).not.toBe("No process inventory is captured yet.");
    expect(context.anchor_phrasings).toContain(
      "What are the main recurring processes your team owns?",
    );
    expect(context.verbatim_required).toBe(false);
    expect(context.consecutive_intent_count).toBe(1);
    // Recently spoken Otto questions land in do_not_ask so the phraser
    // avoids paraphrase repeats.
    expect(context.do_not_ask).toContain("What part of the business do you oversee?");
  });

  test("probe library exposes directives and full phrasings per intent", () => {
    expect(probeDirectiveForIntent("capture_outcome", "outcomes.business_outcomes")).toMatch(
      /business outcome/i,
    );
    expect(
      probePhrasingsForIntent("capture_outcome", "outcomes.business_outcomes").length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("directive names the focus process when one is known", () => {
    const directive = directorIntentDirective(
      intentFixture({
        intent: "capture_outcome",
        target_slot: "outcomes.business_outcomes",
        target_process: "Order Intake",
      }),
    );
    expect(directive).toContain('The focus process is "Order Intake".');
  });

  test("controller intents get imperative directives too", () => {
    const directive = directorIntentDirective(
      intentFixture({ intent: "playback_summary", target_slot: undefined }),
    );
    expect(directive).toMatch(/play back/i);
  });
});

describe("verbatim escalation (Tasks 1 + 4b)", () => {
  test("verbatim_required after the same intent fired on 2 consecutive prior turns without slot fill", () => {
    const rows = [
      firing("discover_processes", "process.inventory", 5, 10_000),
      firing("discover_processes", "process.inventory", 4, 40_000),
      firing("capture_outcome", "outcomes.business_outcomes", 3, 70_000),
    ];
    expect(consecutivePriorIntentFirings(rows, "discover_processes")).toBe(2);
    const context = steeringContextFixture({
      currentSlots: new Map([
        ["process.inventory", { status: "partial", confidence: null }],
      ]),
      priorConsecutiveIntentFirings: 2,
    });
    expect(context.consecutive_intent_count).toBe(3);
    expect(context.verbatim_required).toBe(true);
  });

  test("a second consecutive choice of an unfilled intent already escalates", () => {
    const context = steeringContextFixture({ priorConsecutiveIntentFirings: 1 });
    expect(context.consecutive_intent_count).toBe(2);
    expect(context.verbatim_required).toBe(true);
  });

  test("no escalation when the target slot filled or the streak broke", () => {
    const filled = steeringContextFixture({
      currentSlots: new Map([
        ["process.inventory", { status: "filled", confidence: 0.9 }],
      ]),
      priorConsecutiveIntentFirings: 2,
    });
    expect(filled.verbatim_required).toBe(false);

    const rows = [
      firing("capture_outcome", "outcomes.business_outcomes", 5, 10_000),
      firing("discover_processes", "process.inventory", 4, 40_000),
    ];
    expect(consecutivePriorIntentFirings(rows, "discover_processes")).toBe(0);
    const fresh = steeringContextFixture({ priorConsecutiveIntentFirings: 0 });
    expect(fresh.verbatim_required).toBe(false);
  });

  test("prior-turn checker verdict flips verbatim_required and blocks the offending utterance", () => {
    const signal = checkerVerdictSignalFromDeliveryJson({
      checker_status: "complete",
      checker_violations: [
        {
          type: "ignored_next_objective",
          severity: "high",
          message: "Asked an L4 drill-down instead of the breadth sweep.",
        },
      ],
      checker_violation_count: 1,
      stale_question_count: 0,
      spoken_agent_utterance: "What are the main steps Marcus is working through?",
    });
    expect(signal.ignoredSteering).toBe(true);
    expect(signal.staleQuestion).toBe(false);
    expect(signal.offendingUtterance).toBe(
      "What are the main steps Marcus is working through?",
    );

    const context = steeringContextFixture({
      priorConsecutiveIntentFirings: 0,
      checkerSignal: signal,
    });
    expect(context.verbatim_required).toBe(true);
    expect(context.do_not_ask).toContain(
      "What are the main steps Marcus is working through?",
    );
  });

  test("stale question counts and asked_do_not_ask also escalate; clean verdicts do not", () => {
    expect(
      checkerVerdictSignalFromDeliveryJson({ stale_question_count: 2 }).staleQuestion,
    ).toBe(true);
    expect(
      checkerVerdictSignalFromDeliveryJson({
        checker_violations: [
          { type: "asked_do_not_ask", severity: "medium", message: "repeat" },
        ],
      }).staleQuestion,
    ).toBe(true);
    const clean = checkerVerdictSignalFromDeliveryJson({
      checker_status: "complete",
      checker_violations: [],
      checker_violation_count: 0,
      stale_question_count: 0,
    });
    expect(clean.ignoredSteering).toBe(false);
    expect(clean.staleQuestion).toBe(false);
    expect(checkerVerdictSignalFromDeliveryJson(undefined).ignoredSteering).toBe(false);
  });
});

describe("cooldown and max_fires enforcement (Task 2)", () => {
  test("a probe that fired twice inside its cooldown window is excluded by the chooser", () => {
    // discover_processes: cooldown 60s, max_fires 3 — two firings, last 5s ago.
    const summaries = probeFiringSummariesFromRows([
      firing("discover_processes", "process.inventory", 2, 5_000),
      firing("discover_processes", "process.inventory", 1, 35_000),
    ]);
    const plan = deterministicTurnPlan({
      latestUtterance:
        "There is a lot happening across the department right now, more than I can list quickly.",
      evidenceIds: [evidenceId],
      currentSlots: new Map([["function.name", { status: "filled", confidence: 0.9 }]]),
      currentPhase: "inventory",
      candidateProcessNames: [],
      probeFiringSummaries: summaries,
    });
    expect(plan.chosen_intent.intent).not.toBe("discover_processes");
    expect(
      plan.ranked_intents.some((candidate) => candidate.intent === "discover_processes"),
    ).toBe(false);
  });

  test("a probe at max_fires stays excluded even after the cooldown elapses", () => {
    const summaries = probeFiringSummariesFromRows([
      firing("discover_processes", "process.inventory", 3, 600_000),
      firing("discover_processes", "process.inventory", 2, 700_000),
      firing("discover_processes", "process.inventory", 1, 800_000),
    ]);
    const eligible = applySteeringIntentExclusions(
      [intentFixture()],
      {
        probeFiringSummaries: summaries,
        proposedNextPhase: "inventory",
        candidateProcessNames: [],
      },
    );
    expect(
      eligible.some((candidate) => candidate.intent === "discover_processes"),
    ).toBe(false);
  });

  test("falls back to a non-repeating bridge intent when every candidate is excluded", () => {
    const summaries = probeFiringSummariesFromRows([
      firing("discover_processes", "process.inventory", 2, 1_000),
    ]);
    const eligible = applySteeringIntentExclusions(
      [intentFixture()],
      {
        probeFiringSummaries: summaries,
        proposedNextPhase: "inventory",
        candidateProcessNames: ["Order Intake"],
      },
    );
    expect(eligible).toHaveLength(1);
    expect(eligible[0].intent).toBe("clarify_previous_question");
  });

  test("probes outside cooldown with remaining fires stay eligible", () => {
    const summaries = probeFiringSummariesFromRows([
      firing("discover_processes", "process.inventory", 1, 600_000),
    ]);
    const eligible = applySteeringIntentExclusions(
      [intentFixture()],
      {
        probeFiringSummaries: summaries,
        proposedNextPhase: "inventory",
        candidateProcessNames: [],
      },
    );
    expect(eligible[0]?.intent).toBe("discover_processes");
  });
});

describe("provisional-answer guard (Task 2)", () => {
  test("a probe answered substantively is provisionally answered while extraction is pending", () => {
    const provisional = provisionallyAnsweredSlotPaths({
      latestUtterance:
        "It keeps revenue flowing because orders ship out the same week they come in.",
      pendingExtractionTurns: [2],
      pendingSlotPaths: [],
      recentFirings: [firing("capture_outcome", "outcomes.business_outcomes", 2, 8_000)],
    });
    expect(provisional).toContain("outcomes.business_outcomes");
  });

  test("a don't-know reply keeps the probe eligible", () => {
    const provisional = provisionallyAnsweredSlotPaths({
      latestUtterance: "I don't know, hard to say.",
      pendingExtractionTurns: [],
      pendingSlotPaths: [],
      recentFirings: [firing("capture_outcome", "outcomes.business_outcomes", 2, 8_000)],
    });
    expect(provisional).not.toContain("outcomes.business_outcomes");
  });

  test("the chooser skips a provisionally answered slot and picks the next intent", () => {
    const baseInput = {
      latestUtterance:
        "There is a lot happening across the department right now, more than I can list quickly.",
      evidenceIds: [evidenceId],
      currentSlots: new Map([["function.name", { status: "filled", confidence: 0.9 }]]),
      currentPhase: "inventory" as const,
      candidateProcessNames: [],
    };
    const unguarded = deterministicTurnPlan(baseInput);
    const blockedSlot = unguarded.chosen_intent.target_slot;
    expect(blockedSlot).toBeTruthy();
    const guarded = deterministicTurnPlan({
      ...baseInput,
      provisionallyAnsweredSlots: [blockedSlot!],
    });
    expect(guarded.chosen_intent.target_slot).not.toBe(blockedSlot);
    expect(
      guarded.ranked_intents.some((candidate) => candidate.target_slot === blockedSlot),
    ).toBe(false);
  });

  test("caller-supplied pending slots flow into the provisional set", () => {
    const provisional = provisionallyAnsweredSlotPaths({
      latestUtterance:
        "We also coordinate the weekly vendor payment runs with the finance group downstream.",
      pendingExtractionTurns: [3, 4],
      pendingSlotPaths: ["systems.systems_of_record"],
      recentFirings: [
        firing("capture_systems", "systems.systems_of_record", 4, 5_000),
        firing("capture_owner_roles", "ownership.roles", 3, 45_000),
      ],
    });
    expect(provisional).toContain("systems.systems_of_record");
    // turn 3 firing's reply turn (4) is pending, so its slot is guarded too.
    expect(provisional).toContain("ownership.roles");
  });
});

describe("verbatim phrasing fallback (Task 1)", () => {
  test("deterministic fallback speaks the anchor phrasing when verbatim is required", async () => {
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const plan = deterministicTurnPlan({
        latestUtterance:
          "There is a lot happening across the department right now, more than I can list quickly.",
        evidenceIds: [evidenceId],
        currentSlots: new Map(),
        currentPhase: "inventory",
        candidateProcessNames: [],
      });
      const anchors = probePhrasingsForIntent(
        "discover_processes",
        "process.inventory",
      );
      const phrased = await phraseDirectorTurnDetailed({
        plan,
        recentTurns: [],
        coverageSummary: "test coverage",
        forceSeparateVoiceLlm: true,
        steering: {
          directive: directorIntentDirective(intentFixture()),
          anchorPhrasings: anchors,
          doNotAsk: [],
          verbatimRequired: true,
        },
      });
      expect(phrased.utterance).toBe(anchors[0]);
    } finally {
      if (priorAnthropic !== undefined) {
        process.env.ANTHROPIC_API_KEY = priorAnthropic;
      }
    }
  });
});
