import { describe, expect, test } from "vitest";
import {
  answeredProbeIntentsThisSession,
  applySteeringIntentExclusions,
  buildDirectorSteeringContext,
  checkDirectorSpokenOutput,
  checkerVerdictSignalFromDeliveryJson,
  consecutivePriorIntentFirings,
  deterministicTurnPlan,
  directorIntentDirective,
  directorInvalidClaimRecoverable,
  probeFiringSummariesFromRows,
  pendingReExtractSlotPaths,
  provisionallyAnsweredSlotPaths,
  resolveDirectorSlotCandidateProcessId,
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
      recentFirings: [firing("capture_outcome", "outcomes.business_outcomes", 2, 8_000)],
    });
    expect(provisional).toContain("outcomes.business_outcomes");
  });

  test("a don't-know reply keeps the probe eligible", () => {
    const provisional = provisionallyAnsweredSlotPaths({
      latestUtterance: "I don't know, hard to say.",
      pendingExtractionTurns: [],
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

  test("only spoken probes are guarded; pending steering targets never asked are not", () => {
    const provisional = provisionallyAnsweredSlotPaths({
      latestUtterance:
        "We also coordinate the weekly vendor payment runs with the finance group downstream.",
      pendingExtractionTurns: [3, 4],
      recentFirings: [
        firing("capture_systems", "systems.systems_of_record", 4, 5_000),
        firing("capture_owner_roles", "ownership.roles", 3, 45_000),
      ],
    });
    expect(provisional).toContain("systems.systems_of_record");
    // turn 3 firing's reply turn (4) is pending, so its slot is guarded too.
    expect(provisional).toContain("ownership.roles");
    // Ranked-context slots that were never spoken (they ride along in
    // steering target_slots) must NOT be excluded from the chooser.
    expect(provisional).not.toContain("scope.boundaries");
    expect(provisional).toHaveLength(2);
  });
});

describe("heuristic checker with utterances in do_not_ask (Task 4b)", () => {
  test("prior-question utterances only flag on verbatim repeats, not shared common words", async () => {
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const steeringContext = {
        do_not_ask: [
          "function.name",
          "What are the main steps Marcus is working through?",
        ],
      };
      // Shares "what"/"main"/"working" with the blocked utterance but targets
      // a different question: must not be flagged stale.
      const onTopic = await checkDirectorSpokenOutput({
        spokenAgentUtterance:
          "Thanks. What outcome is Order Intake supposed to produce?",
        steeringContext,
      });
      expect(
        onTopic.violations.filter((violation) => violation.type === "asked_do_not_ask"),
      ).toHaveLength(0);
      expect(onTopic.stale_question_count).toBe(0);

      // A verbatim repeat of a blocked utterance is flagged.
      const repeated = await checkDirectorSpokenOutput({
        spokenAgentUtterance: "What are the main steps Marcus is working through?",
        steeringContext,
      });
      expect(
        repeated.violations.some((violation) => violation.type === "asked_do_not_ask"),
      ).toBe(true);
      expect(repeated.stale_question_count).toBeGreaterThan(0);

      // Slot paths still flag via term matching.
      const staleSlot = await checkDirectorSpokenOutput({
        spokenAgentUtterance: "And what is the name of your function?",
        steeringContext,
      });
      expect(staleSlot.stale_question_count).toBeGreaterThan(0);
    } finally {
      if (priorAnthropic !== undefined) {
        process.env.ANTHROPIC_API_KEY = priorAnthropic;
      }
    }
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

  test("verbatim escalation bypasses generation entirely, overriding even a planned utterance", async () => {
    const plan = deterministicTurnPlan({
      latestUtterance:
        "There is a lot happening across the department right now, more than I can list quickly.",
      evidenceIds: [evidenceId],
      currentSlots: new Map(),
      currentPhase: "inventory",
      candidateProcessNames: [],
    });
    const anchors = probePhrasingsForIntent("discover_processes", "process.inventory");
    const deltas: string[] = [];
    const phrased = await phraseDirectorTurnDetailed({
      plan: {
        ...plan,
        // The phraser/one-call path would normally speak this off-objective
        // utterance; verbatim escalation must win without calling any LLM.
        planned_agent_utterance:
          "When an order arrives, walk me through the first thing your team does.",
      },
      recentTurns: [],
      coverageSummary: "test coverage",
      onTextDelta: (delta) => {
        deltas.push(delta);
      },
      steering: {
        directive: directorIntentDirective(intentFixture()),
        anchorPhrasings: anchors,
        doNotAsk: [],
        verbatimRequired: true,
      },
    });
    expect(phrased.utterance).toBe(anchors[0]);
    // The streaming consumer (TTS) must receive the anchor, not LLM deltas.
    expect(deltas.join("")).toBe(anchors[0]);
    expect(
      (phrased.metadata as { utterance_source?: string }).utterance_source,
    ).toBe("deterministic_phrase_fallback");
  });
});

describe("extraction-failure re-ask guard (pending_re_extract)", () => {
  test("pending_re_extract slots are exposed for chooser exclusion", () => {
    const slots = new Map([
      ["ownership.roles", { status: "pending_re_extract" }],
      ["process.inventory", { status: "filled" }],
      ["metrics.kpis", { status: "empty" }],
    ]);
    expect(pendingReExtractSlotPaths(slots)).toEqual(["ownership.roles"]);
  });

  test("the chooser skips a pending_re_extract slot supplied as provisionally answered", () => {
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
  });
});

const FOCUS_CANDIDATE = "11111111-1111-1111-1111-111111111111";
const OTHER_CANDIDATE = "22222222-2222-2222-2222-222222222222";

describe("focus-authoritative slot scoping (Task 10)", () => {
  test("enrich-phase process slots are forced onto the focus candidate, overriding the extractor", () => {
    // Session 83fdd5a6: focus was "order intake" but the extractor scoped the
    // systems slot to the "returns and credit memos" candidate. Focus wins.
    const scoped = resolveDirectorSlotCandidateProcessId({
      slotPath: "systems.systems_of_record",
      extractorCandidateId: OTHER_CANDIDATE,
      focusCandidateId: FOCUS_CANDIDATE,
      phase: "enrich",
    });
    expect(scoped.candidateProcessId).toBe(FOCUS_CANDIDATE);
    expect(scoped.authoritative).toBe(true);
  });

  test("expand-phase process slots also default to the focus candidate", () => {
    const scoped = resolveDirectorSlotCandidateProcessId({
      slotPath: "scope.boundaries",
      focusCandidateId: FOCUS_CANDIDATE,
      phase: "expand",
    });
    expect(scoped.candidateProcessId).toBe(FOCUS_CANDIDATE);
    expect(scoped.authoritative).toBe(true);
  });

  test("capture-level slots never scope to a candidate, even with a focus set", () => {
    for (const slotPath of ["function.name", "process.inventory"]) {
      const scoped = resolveDirectorSlotCandidateProcessId({
        slotPath,
        extractorCandidateId: OTHER_CANDIDATE,
        focusCandidateId: FOCUS_CANDIDATE,
        phase: "enrich",
      });
      expect(scoped.candidateProcessId).toBeUndefined();
    }
  });

  test("inventory phase honors the extractor candidate (slots may land on a just-created candidate)", () => {
    const scoped = resolveDirectorSlotCandidateProcessId({
      slotPath: "scope.boundaries",
      extractorCandidateId: OTHER_CANDIDATE,
      focusCandidateId: FOCUS_CANDIDATE,
      phase: "inventory",
    });
    // Not yet expand/enrich: the extractor candidate is honored (the caller
    // still session-checks it). authoritative=false signals the belongs-check.
    expect(scoped.candidateProcessId).toBe(OTHER_CANDIDATE);
    expect(scoped.authoritative).toBe(false);
  });

  test("with no focus set, enrich slots fall back to the extractor candidate", () => {
    const scoped = resolveDirectorSlotCandidateProcessId({
      slotPath: "systems.systems_of_record",
      extractorCandidateId: OTHER_CANDIDATE,
      focusCandidateId: undefined,
      phase: "enrich",
    });
    expect(scoped.candidateProcessId).toBe(OTHER_CANDIDATE);
    expect(scoped.authoritative).toBe(false);
  });
});

describe("answered-but-not-filled re-ask guard (Task 11)", () => {
  test("focus selection fires once: re-asked after the director answered, the probe is excluded", () => {
    // "Which process should we focus on first?" maps to define_process_boundary.
    const firings = [firing("define_process_boundary", "scope.boundaries", 2, 5_000)];
    const answered = answeredProbeIntentsThisSession({
      recentFirings: firings,
      latestUtterance: "Let's focus on order intake easily.",
      currentSlots: new Map(),
      candidateProcessNames: ["order intake", "returns and credit memos"],
      // Focus was recorded from the answer — selection is satisfied.
      focusCandidateProcessId: FOCUS_CANDIDATE,
    });
    expect(answered).toContain("define_process_boundary");

    const eligible = applySteeringIntentExclusions(
      [intentFixture({ intent: "define_process_boundary", target_slot: "scope.boundaries" })],
      {
        answeredProbeIntents: answered,
        proposedNextPhase: "expand",
        candidateProcessNames: ["order intake"],
      },
    );
    expect(
      eligible.some((candidate) => candidate.intent === "define_process_boundary"),
    ).toBe(false);
  });

  test("inventory fires once: re-asked after a six-process answer, discover_processes is excluded", () => {
    const firings = [firing("discover_processes", "process.inventory", 1, 9_000)];
    const answered = answeredProbeIntentsThisSession({
      recentFirings: firings,
      latestUtterance:
        "We run order intake, invoicing, purchasing, shipping, returns, and vendor payments.",
      currentSlots: new Map([
        ["process.inventory", { status: "partial" }],
      ]),
      candidateProcessNames: ["order intake", "invoicing", "purchasing"],
    });
    expect(answered).toContain("discover_processes");
  });

  test("the special one-shot probes stay eligible until satisfied", () => {
    // define_process_boundary fired but no focus and no boundary value yet.
    const unsatisfiedFocus = answeredProbeIntentsThisSession({
      recentFirings: [firing("define_process_boundary", "scope.boundaries", 1, 9_000)],
      latestUtterance: "Hmm, hard to say which one.",
      currentSlots: new Map(),
      candidateProcessNames: ["order intake", "returns"],
      focusCandidateProcessId: undefined,
    });
    expect(unsatisfiedFocus).not.toContain("define_process_boundary");

    // discover_processes fired but the inventory is still empty (no candidates).
    const unsatisfiedInventory = answeredProbeIntentsThisSession({
      recentFirings: [firing("discover_processes", "process.inventory", 1, 9_000)],
      latestUtterance: "I'm not sure, there's a lot.",
      currentSlots: new Map(),
      candidateProcessNames: [],
    });
    expect(unsatisfiedInventory).not.toContain("discover_processes");
  });

  test("a probe answered substantively is excluded even though its slot is only partial", () => {
    const firings = [firing("capture_systems", "systems.systems_of_record", 3, 6_000)];
    const answered = answeredProbeIntentsThisSession({
      recentFirings: firings,
      latestUtterance:
        "We mostly work in Gmail and a couple of shared Google Sheets for tracking.",
      // Slot landed partial — the Task 10 mis-scope / weak-extraction case.
      currentSlots: new Map([
        ["systems.systems_of_record", { status: "partial" }],
      ]),
      candidateProcessNames: ["order intake"],
      focusCandidateProcessId: FOCUS_CANDIDATE,
    });
    expect(answered).toContain("capture_systems");

    const eligible = applySteeringIntentExclusions(
      [intentFixture({ intent: "capture_systems", target_slot: "systems.systems_of_record" })],
      {
        answeredProbeIntents: answered,
        proposedNextPhase: "enrich",
        candidateProcessNames: ["order intake"],
      },
    );
    expect(eligible.some((candidate) => candidate.intent === "capture_systems")).toBe(false);
  });

  test("the latest firing's probe stays eligible after a don't-know reply", () => {
    const answered = answeredProbeIntentsThisSession({
      recentFirings: [firing("capture_metrics", "metrics.kpis", 4, 4_000)],
      latestUtterance: "I don't know, you'd have to ask the team.",
      currentSlots: new Map(),
      candidateProcessNames: ["order intake"],
      focusCandidateProcessId: FOCUS_CANDIDATE,
    });
    expect(answered).not.toContain("capture_metrics");
  });

  test("controller-exempt intents are never excluded by the answered guard", () => {
    const eligible = applySteeringIntentExclusions(
      [intentFixture({ intent: "clarify_previous_question", target_slot: undefined })],
      {
        answeredProbeIntents: ["clarify_previous_question"],
        proposedNextPhase: "enrich",
        candidateProcessNames: [],
      },
    );
    expect(eligible.some((candidate) => candidate.intent === "clarify_previous_question")).toBe(
      true,
    );
  });
});

describe("claim_subject_validation_failed degrade gating (Task 12)", () => {
  const evidence = [evidenceId];

  test("a candidate/person claim named in the conversation is recoverable (not a drop)", () => {
    // Recoverable: drainDirectorRetryClaimTasks replays it once the candidate is
    // created in a later turn, so it must not flip the degrade flag.
    expect(
      directorInvalidClaimRecoverable("candidate_process", {
        subject_type: "candidate_process",
        subject_id: "Inventory Restock",
        field: "kpi",
        value: { name: "stockout rate" },
        confidence: 0.8,
        evidence_ids: evidence,
      }),
    ).toBe(true);
    expect(
      directorInvalidClaimRecoverable("person", {
        subject_type: "person",
        subject_id: "Marcus",
        field: "role",
        value: "warehouse lead",
        confidence: 0.75,
        evidence_ids: evidence,
      }),
    ).toBe(true);
  });

  test("an unknown subject type is genuinely dropped (sets the degrade flag)", () => {
    expect(
      directorInvalidClaimRecoverable("workflow", {
        subject_type: "workflow",
        subject_id: "some-unknown-thing",
        field: "note",
        value: "x",
        confidence: 0.5,
        evidence_ids: evidence,
      }),
    ).toBe(false);
  });

  test("a recoverable subject type without evidence cannot be replayed → dropped", () => {
    expect(
      directorInvalidClaimRecoverable("person", {
        subject_type: "person",
        subject_id: "Marcus",
        field: "role",
        value: "warehouse lead",
        confidence: 0.75,
        evidence_ids: [],
      }),
    ).toBe(false);
  });

  test("a recoverable subject type without a name reference cannot be matched → dropped", () => {
    expect(
      directorInvalidClaimRecoverable("candidate_process", {
        subject_type: "candidate_process",
        subject_id: "",
        field: "kpi",
        value: { name: "x" },
        confidence: 0.8,
        evidence_ids: evidence,
      }),
    ).toBe(false);
  });
});
