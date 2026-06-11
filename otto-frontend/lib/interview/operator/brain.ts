import "server-only";

import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  generate,
  structured,
  structuredStream,
  type GenerateOpts,
  type Generation,
  type StructuredGeneration,
} from "@/lib/adapters/llm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env";
import {
  agentDecisionLog,
  documentChunks,
  followUpTasks,
  interviewState,
  operatorExtractionWindows,
  probeFirings,
  redactions,
  screenEvents,
  slotStates,
  transcriptSegments,
} from "@/lib/db/schema";
import { writeClaimInTransaction } from "@/lib/db/write-claim";
import { writeAgentDecisionInTransaction } from "@/lib/db/write-agent-decision";
import { inngest, operatorRedactionRequestedEventName } from "@/lib/inngest/client";
import { limitToSingleQuestion } from "@/lib/interview/_core/utterance";
import { readSharedSchemaArtifact } from "@/lib/interview/director/schema-artifacts";
import { isNonAnswerSlotExtraction } from "@/lib/interview/director/slot-non-answer";
import {
  operatorProbeConfigForIntent,
  operatorProbeDirectiveForIntent,
  operatorProbePhrasingsForIntent,
} from "@/lib/interview/operator/probe-library";
import { parseOperatorToolCall, type OperatorToolCall } from "@/lib/interview/operator/tools";
import {
  insertOperatorProvisionalStep,
  upsertOperatorSlotState,
  type OperatorSessionContext,
} from "@/lib/interview/operator/turn-transaction";
import {
  assertOperatorSlotPath,
  operatorSlotDefinitions,
  operatorSlotScope,
  operatorInterviewPhaseSchema,
  operatorTurnPlanSchema,
  type OperatorInterviewPhase,
  type OperatorIntent,
  type OperatorTurnPlan,
} from "@/lib/interview/operator/schema";

export type OperatorTurnInput = OperatorSessionContext & {
  latestUtterance: string;
  transcriptSegmentIds: string[];
  evidenceIds: string[];
  turnIndex: number;
};

export type OperatorTurnPlanResult = {
  plan: OperatorTurnPlan;
  planned_agent_utterance: string;
  metadata: OperatorPlanMetadata;
  degraded_quality: boolean;
  degraded_reasons: string[];
  started_at: Date;
};

export type OperatorSteeringContext = {
  next_objective: string;
  directive: string;
  anchor_phrasings: string[];
  verbatim_required: boolean;
  consecutive_intent_count: number;
  target_slots: string[];
  do_not_ask: string[];
  required_style: string;
  recent_screen_events: OperatorPlanningContext["recentScreenEvents"];
  live_reconciliation_signals: string[];
  pending_extraction_turns: number[];
  pending_slot_paths: string[];
  provisionally_answered_slots: string[];
  last_spoken_intent?: string;
};

export type OperatorSteeringPlanResult = OperatorTurnPlanResult & {
  input: OperatorTurnInput;
  planning_context: OperatorPlanningContext;
  live_reconciliation_signals: LiveReconciliationSignal[];
  steering_context: OperatorSteeringContext;
};

export type OperatorPlanMetadata = {
  model: string;
  prompt_template_id: string;
  prompt_template_version: string;
  token_count_input: number;
  token_count_output: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_cents: number;
  latency_ms: number;
  cache_hit: boolean;
  mocked?: boolean;
  streaming?: boolean;
  stream_cutoff?: "first_question" | "message_stop";
  source: string;
  utterance_source: string;
  llm_call_elided: boolean;
  reason?: string;
  voice_phrase_fallback?: boolean;
  voice_phrase_metadata?: Record<string, unknown>;
};

export type OperatorOutputCheckViolation = {
  type:
    | "asked_do_not_ask"
    | "unsupported_claim"
    | "ignored_next_objective"
    | "multiple_questions"
    | "too_verbose"
    | "internal_mechanics"
    | "contradicted_reconciliation";
  severity: "low" | "medium" | "high";
  message: string;
};

export type OperatorOutputCheckResult = {
  checker_status: "complete" | "failed";
  violations: OperatorOutputCheckViolation[];
  checker_violation_count: number;
  stale_question_count: number;
  metadata: Generation;
};

const operatorOutputCheckSchema = z
  .object({
    checker_status: z.enum(["complete", "failed"]).default("complete"),
    violations: z
      .array(
        z
          .object({
            type: z.enum([
              "asked_do_not_ask",
              "unsupported_claim",
              "ignored_next_objective",
              "multiple_questions",
              "too_verbose",
              "internal_mechanics",
              "contradicted_reconciliation",
            ]),
            severity: z.enum(["low", "medium", "high"]),
            message: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    checker_violation_count: z.number().int().min(0).default(0),
    stale_question_count: z.number().int().min(0).default(0),
  })
  .strict();

const operatorOutputCheckAnthropicToolSchema = {
  type: "object",
  properties: {
    checker_status: { type: "string", enum: ["complete", "failed"] },
    violations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "asked_do_not_ask",
              "unsupported_claim",
              "ignored_next_objective",
              "multiple_questions",
              "too_verbose",
              "internal_mechanics",
              "contradicted_reconciliation",
            ],
          },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          message: { type: "string" },
        },
        required: ["type", "severity", "message"],
        additionalProperties: false,
      },
    },
    checker_violation_count: { type: "integer" },
    stale_question_count: { type: "integer" },
  },
  required: [
    "checker_status",
    "violations",
    "checker_violation_count",
    "stale_question_count",
  ],
  additionalProperties: false,
} as const;

export type OperatorTurnPlanStreamEvent = {
  type: "planned_agent_utterance";
  utterance: string;
};

type OperatorPlanner = (
  opts: GenerateOpts & {
    schema_name: string;
    schema?: typeof operatorTurnPlanSchema;
    mock?: unknown;
  },
) => Promise<StructuredGeneration<OperatorTurnPlan>>;

type OperatorBrainTx = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export async function runOperatorTurn(input: OperatorTurnInput) {
  const planned = await planOperatorTurn(input);
  return dispatchOperatorTurnPlan({ ...input, ...planned });
}

export async function planOperatorTurn(
  input: OperatorTurnInput,
): Promise<OperatorTurnPlanResult> {
  return planOperatorTurnWithPlanner(input, (opts) => structured<OperatorTurnPlan>(opts));
}

export async function extractOperatorTurn(
  input: OperatorTurnInput,
): Promise<OperatorTurnPlanResult> {
  return planOperatorTurnWithPlanner(
    input,
    (opts) => structured<OperatorTurnPlan>(opts),
    { phrase: false, source: "operator_extraction_llm" },
  );
}

export async function buildOperatorSteeringPlan(
  input: OperatorTurnInput & {
    pendingExtractionTurns?: number[];
    pendingSlotPaths?: string[];
    lastSpokenIntent?: string;
  },
): Promise<OperatorSteeringPlanResult> {
  const startedAt = new Date();
  const [planningContext, steeringSignals] = await Promise.all([
    readOperatorPlanningContext(input),
    readOperatorSteeringSignals(input),
  ]);
  // The LiveKit worker threads pending_extraction_turns / pending_slot_paths,
  // but its bookkeeping is in-memory; union with the server-side pending
  // extraction windows so the guard survives worker restarts.
  const pendingExtractionTurns = uniqueNumbers([
    ...(input.pendingExtractionTurns ?? []),
    ...steeringSignals.pendingWindows.turnIndexes,
  ]);
  const pendingSlotPaths = uniqueStrings([
    ...(input.pendingSlotPaths ?? []),
    ...steeringSignals.pendingWindows.slotPaths,
  ]);
  const probeFiringSummaries = probeFiringSummariesFromRows(
    steeringSignals.probeFiringRows,
  );
  const provisionallyAnsweredSlots = uniqueStrings([
    ...provisionallyAnsweredSlotPaths({
      latestUtterance: input.latestUtterance,
      pendingExtractionTurns,
      recentFirings: steeringSignals.probeFiringRows,
    }),
    // pending_re_extract means the question was asked and answered but the
    // extraction failed. The answer exists in the transcript; re-asking it
    // burns operator trust. Keep these excluded until a re-extract succeeds.
    ...pendingReExtractSlotPaths(planningContext.currentSlots),
  ]);
  let plan = operatorTurnPlanSchema.parse(
    deterministicOperatorTurnPlan({
      ...input,
      currentPhase: planningContext.currentPhase,
      probeFiringSummaries,
      provisionallyAnsweredSlots,
    }),
  );
  // Live signals persist while the same screen events stay in the window, so
  // enforce the YAML cooldown/max_fires on them like any other probe.
  const liveReconciliationSignals = detectLiveReconciliationSignals(
    planningContext,
  ).filter(
    (signal) => applyProbeControls([signal.intent], probeFiringSummaries).length > 0,
  );
  plan = applyLiveReconciliationSignals(plan, liveReconciliationSignals);
  const normalized = normalizeOperatorPlan(plan, plan, input.evidenceIds);
  plan = normalized.plan;
  const filledSlots = planningContext.currentSlots
    .filter((slot) => ["filled", "asked_unknown"].includes(slot.status))
    .map((slot) => slot.slotPath);
  const checkerSignal = checkerVerdictSignalFromDeliveryJson(
    steeringSignals.priorTurnDeliveries[0]?.deliveryJson,
  );
  const metadata = deterministicPlannerMetadata(startedAt, input, plan, {
    source: "deterministic_operator_steering",
    utteranceSource: "fast_steering_phrase_pending",
    llmCallElided: true,
  });
  return {
    plan,
    planned_agent_utterance:
      plan.planned_agent_utterance ?? deterministicOperatorUtterance(plan.chosen_intent),
    metadata: {
      ...metadata,
      model: "deterministic-steering",
      prompt_template_id: "operator.turn.steering",
    },
    degraded_quality: normalized.degradedReasons.length > 0,
    degraded_reasons: normalized.degradedReasons,
    started_at: startedAt,
    input,
    planning_context: planningContext,
    live_reconciliation_signals: liveReconciliationSignals,
    steering_context: buildOperatorSteeringContext({
      chosenIntent: plan.chosen_intent,
      rankedIntents: plan.ranked_intents,
      filledSlotPaths: filledSlots,
      currentSlots: planningContext.currentSlots,
      recentAgentUtterances: steeringSignals.recentAgentUtterances,
      pendingExtractionTurns,
      pendingSlotPaths,
      provisionallyAnsweredSlots,
      priorConsecutiveIntentFirings: consecutivePriorIntentFirings(
        steeringSignals.probeFiringRows,
        plan.chosen_intent.intent,
      ),
      checkerSignal,
      lastSpokenIntent: input.lastSpokenIntent,
      recentScreenEvents: planningContext.recentScreenEvents,
      liveReconciliationSignals: liveReconciliationSignals.map((item) => item.signal),
    }),
  };
}

export async function phraseOperatorSteeringTurn(
  steering: OperatorSteeringPlanResult,
): Promise<OperatorVoicePhraseResult> {
  return phraseOperatorTurnWithSeparateVoice({
    input: steering.input,
    plan: steering.plan,
    planningContext: steering.planning_context,
    liveReconciliationSignals: steering.live_reconciliation_signals,
    fallbackUtterance: steering.planned_agent_utterance,
    fallbackUtteranceSource: "deterministic_operator_steering",
    steering: {
      directive: steering.steering_context.directive,
      anchorPhrasings: steering.steering_context.anchor_phrasings,
      doNotAsk: steering.steering_context.do_not_ask,
      verbatimRequired: steering.steering_context.verbatim_required,
      requiredStyle: steering.steering_context.required_style,
    },
  });
}

export function nonAuthoritativeOperatorSteeringPlan(
  plan: OperatorTurnPlan,
): OperatorTurnPlan {
  return {
    ...plan,
    step_updates: [],
    slot_updates: [],
    claims: [],
    tool_calls: [],
  };
}

/**
 * Explicit steering sections for the voice phraser. Passed as labeled prompt
 * sections (not a JSON pseudo-turn) so the fast model treats the directive as
 * binding rather than background noise. Mirrors DirectorVoiceSteering.
 */
export type OperatorVoiceSteering = {
  directive: string;
  anchorPhrasings: string[];
  doNotAsk: string[];
  verbatimRequired: boolean;
  requiredStyle?: string;
};

/**
 * Imperative instructions for intents that are not operator probes. Probe
 * intents resolve through probes/operator.yaml (`directive` / curated/derived
 * fallbacks in probe-library.ts).
 */
const nonProbeIntentDirectives: Record<string, string> = {
  clarify_operator_step:
    "Ask the operator to walk through the next concrete step in the workflow. One step, not the whole process.",
  clarify_observed_workaround:
    "Ask the operator whether the manual or duplicate-entry work just observed on screen is an expected part of the process or a workaround.",
};

/** Imperative instruction for the chosen intent (replaces the old status-string objective). */
export function operatorIntentDirective(chosenIntent: OperatorIntent): string {
  return (
    nonProbeIntentDirectives[chosenIntent.intent] ??
    operatorProbeDirectiveForIntent(chosenIntent.intent, chosenIntent.target_slot) ??
    `Ask the operator one concrete question that advances the "${chosenIntent.intent}" objective` +
      (chosenIntent.target_slot
        ? ` and fills the "${chosenIntent.target_slot}" slot.`
        : ".") +
      " Stay on the step being discussed."
  );
}

export type OperatorCheckerVerdictSignal = {
  ignoredSteering: boolean;
  staleQuestion: boolean;
  offendingUtterance?: string;
};

/**
 * Task 4b feedback loop: interpret the prior turn's async output-checker
 * verdict (recorded into agent_decision_log.delivery_json by
 * recordOperatorOutputCheck) so an "ignored steering" / "stale question"
 * verdict on turn N escalates turn N+1 to verbatim-probe mode.
 */
export function checkerVerdictSignalFromDeliveryJson(
  deliveryJson: unknown,
): OperatorCheckerVerdictSignal {
  if (!deliveryJson || typeof deliveryJson !== "object") {
    return { ignoredSteering: false, staleQuestion: false };
  }
  const record = deliveryJson as Record<string, unknown>;
  const violationTypes = new Set(
    (Array.isArray(record.checker_violations) ? record.checker_violations : [])
      .map((violation) =>
        violation && typeof violation === "object"
          ? (violation as Record<string, unknown>).type
          : undefined,
      )
      .filter((type): type is string => typeof type === "string"),
  );
  const staleQuestionCount =
    typeof record.stale_question_count === "number" ? record.stale_question_count : 0;
  const ignoredSteering =
    violationTypes.has("ignored_next_objective") ||
    violationTypes.has("contradicted_reconciliation");
  const staleQuestion =
    staleQuestionCount > 0 || violationTypes.has("asked_do_not_ask");
  const offendingUtterance = [
    record.spoken_agent_utterance,
    record.delivered_utterance,
    record.planned_utterance,
  ].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return {
    ignoredSteering,
    staleQuestion,
    offendingUtterance:
      ignoredSteering || staleQuestion ? offendingUtterance : undefined,
  };
}

export type OperatorProbeFiringRow = {
  probeId: string;
  targetSlot: string | null;
  turnIndex: number | null;
  firedAt: Date;
};

type ProbeFiringSummary = {
  count: number;
  lastFiredAt?: Date;
};

export function probeFiringSummariesFromRows(
  rows: OperatorProbeFiringRow[],
): Map<string, ProbeFiringSummary> {
  const summaries = new Map<string, ProbeFiringSummary>();
  for (const row of rows) {
    bumpProbeSummary(summaries, `intent:${row.probeId}`, row.firedAt);
    if (row.targetSlot) {
      bumpProbeSummary(summaries, `slot:${row.targetSlot}`, row.firedAt);
    }
  }
  return summaries;
}

/**
 * How many of the most recent consecutive spoken turns fired the given intent
 * (probe_firings.probe_id records the chosen intent per spoken turn).
 */
export function consecutivePriorIntentFirings(
  rows: OperatorProbeFiringRow[],
  intentName: string,
): number {
  const ordered = orderProbeFiringsByRecency(rows);
  let count = 0;
  let lastTurnIndex: number | null | undefined;
  for (const row of ordered) {
    if (lastTurnIndex !== undefined && row.turnIndex === lastTurnIndex) continue;
    lastTurnIndex = row.turnIndex;
    if (row.probeId !== intentName) break;
    count += 1;
  }
  return count;
}

/**
 * Task 2 provisional-answer guard: a probe asked at turn N whose reply was
 * substantive is treated as provisionally answered while the extraction for
 * that exchange is uncommitted. If extraction later leaves the slot empty,
 * the pending sets clear and the probe becomes eligible again.
 */
export function provisionallyAnsweredSlotPaths(input: {
  latestUtterance: string;
  pendingExtractionTurns: number[];
  recentFirings: OperatorProbeFiringRow[];
}): string[] {
  const pendingTurns = new Set(input.pendingExtractionTurns);
  const provisional = new Set<string>();
  const ordered = orderProbeFiringsByRecency(input.recentFirings);
  for (const firing of ordered) {
    if (!firing.targetSlot || firing.turnIndex === null) continue;
    // The reply to the probe spoken at turn N arrives as turn N+1's utterance;
    // either turn pending means the exchange has not committed yet.
    if (pendingTurns.has(firing.turnIndex) || pendingTurns.has(firing.turnIndex + 1)) {
      provisional.add(firing.targetSlot);
    }
  }
  const latestFiring = ordered[0];
  if (latestFiring?.targetSlot) {
    const latestUtteranceType = utteranceType(input.latestUtterance);
    const substantiveReply =
      latestUtteranceType === "substantive_answer" ||
      latestUtteranceType === "partial_answer";
    if (substantiveReply) {
      // The utterance being answered right now responds to the most recent
      // probe; its extraction has not even started yet.
      provisional.add(latestFiring.targetSlot);
    } else {
      // A don't-know / non-answer does not provisionally answer the probe;
      // keep it eligible so the planner can pivot or re-approach.
      provisional.delete(latestFiring.targetSlot);
    }
  }
  return [...provisional];
}

function orderProbeFiringsByRecency(rows: OperatorProbeFiringRow[]) {
  return [...rows].sort((a, b) => {
    const turnDelta = (b.turnIndex ?? -1) - (a.turnIndex ?? -1);
    if (turnDelta !== 0) return turnDelta;
    return b.firedAt.getTime() - a.firedAt.getTime();
  });
}

export function pendingReExtractSlotPaths(
  currentSlots: Array<{ slotPath: string; status: string }>,
): string[] {
  return uniqueStrings(
    currentSlots
      .filter((slot) => slot.status === "pending_re_extract")
      .map((slot) => slot.slotPath),
  );
}

function bumpProbeSummary(
  summaries: Map<string, ProbeFiringSummary>,
  key: string,
  firedAt: Date,
) {
  const prior = summaries.get(key) ?? { count: 0 };
  summaries.set(key, {
    count: prior.count + 1,
    lastFiredAt:
      prior.lastFiredAt && prior.lastFiredAt > firedAt
        ? prior.lastFiredAt
        : firedAt,
  });
}

function mergedProbeSummary(
  candidate: OperatorIntent,
  summaries: Map<string, ProbeFiringSummary>,
) {
  const byIntent = summaries.get(`intent:${candidate.intent}`);
  const bySlot = candidate.target_slot
    ? summaries.get(`slot:${candidate.target_slot}`)
    : undefined;
  return {
    count: Math.max(byIntent?.count ?? 0, bySlot?.count ?? 0),
    lastFiredAt: latestDate(byIntent?.lastFiredAt, bySlot?.lastFiredAt),
  };
}

function latestDate(a?: Date, b?: Date) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function appendStyleHint(styleHint: string | undefined, hint: string) {
  if (!styleHint) return hint;
  return styleHint.includes(hint) ? styleHint : `${styleHint},${hint}`;
}

function isControllerExemptIntent(candidate: OperatorIntent) {
  // The chooser's terminal fallback; always eligible so exclusions can never
  // leave the agent with nothing to say.
  return candidate.intent === "clarify_operator_step";
}

/**
 * Step-advance intents re-fire by design — each ask targets the NEXT step, a
 * new fact every time — so the provisional-answer guard must not exclude
 * them. YAML cooldowns/max_fires still apply via applyProbeControls. (This is
 * the deliberate divergence from the director's Task 11 answered-probe guard:
 * director probes each target one fact, operator probes drive a step loop.)
 */
const STEP_ADVANCE_INTENTS = new Set(["capture_next_step", "clarify_operator_step"]);

function applyProbeControls(
  intents: OperatorIntent[],
  summaries: Map<string, ProbeFiringSummary>,
) {
  const now = Date.now();
  return intents
    .flatMap((candidate) => {
      if (isControllerExemptIntent(candidate)) return [candidate];
      const probeConfig = operatorProbeConfigForIntent(
        candidate.intent,
        candidate.target_slot,
      );
      const maxFires = probeConfig?.maxFires ?? 3;
      const cooldownSeconds = probeConfig?.cooldownSeconds ?? 60;
      const summary = mergedProbeSummary(candidate, summaries);
      if (summary.count >= maxFires) return [];
      if (
        summary.lastFiredAt &&
        now - summary.lastFiredAt.getTime() < cooldownSeconds * 1000
      ) {
        return [];
      }
      const nearMaxFire = summary.count === maxFires - 1;
      return [
        {
          ...candidate,
          score: nearMaxFire ? candidate.score * 0.5 : candidate.score,
          style_hint: nearMaxFire
            ? appendStyleHint(candidate.style_hint, "last_attempt")
            : candidate.style_hint,
        },
      ];
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Task 2 hard exclusion pass for the deterministic intent chooser. Enforces
 * cooldown_seconds/max_fires from probes/operator.yaml against probe_firings
 * and skips probes whose target slot is provisionally answered (asked +
 * substantively answered while extraction is uncommitted). Falls back to the
 * step-walkthrough bridge when every candidate is excluded.
 */
export function applySteeringIntentExclusions(
  rankedIntents: OperatorIntent[],
  input: {
    probeFiringSummaries?: Map<string, ProbeFiringSummary>;
    provisionallyAnsweredSlots?: string[];
  },
): OperatorIntent[] {
  const provisional = new Set(input.provisionallyAnsweredSlots ?? []);
  let eligible = input.probeFiringSummaries
    ? applyProbeControls(rankedIntents, input.probeFiringSummaries)
    : rankedIntents;
  if (provisional.size > 0) {
    eligible = eligible.filter((candidate) => {
      if (isControllerExemptIntent(candidate)) return true;
      if (STEP_ADVANCE_INTENTS.has(candidate.intent)) return true;
      if (candidate.target_slot && provisional.has(candidate.target_slot)) {
        return false;
      }
      return true;
    });
  }
  if (eligible.length > 0 || rankedIntents.length === 0) return eligible;
  return [
    {
      intent: "clarify_operator_step",
      target_slot: "step.action_object",
      score: 650,
      reason:
        "All matching probes are in cooldown or provisionally answered; advance the step walkthrough instead of repeating.",
      style_hint: appendStyleHint(rankedIntents[0]?.style_hint, "broaden_low_info"),
    },
  ];
}

/**
 * Assembles the steering context handed to the voice phraser and the output
 * checker. Pure so steering behavior is unit-testable without a database.
 */
export function buildOperatorSteeringContext(input: {
  chosenIntent: OperatorIntent;
  rankedIntents: OperatorIntent[];
  filledSlotPaths: string[];
  currentSlots: Array<{ slotPath: string; status: string }>;
  recentAgentUtterances: string[];
  pendingExtractionTurns: number[];
  pendingSlotPaths: string[];
  provisionallyAnsweredSlots: string[];
  priorConsecutiveIntentFirings: number;
  checkerSignal?: OperatorCheckerVerdictSignal;
  lastSpokenIntent?: string;
  recentScreenEvents?: OperatorPlanningContext["recentScreenEvents"];
  liveReconciliationSignals?: string[];
}): OperatorSteeringContext {
  const chosenIntent = input.chosenIntent;
  const directive = operatorIntentDirective(chosenIntent);
  const anchorPhrasings = operatorProbePhrasingsForIntent(
    chosenIntent.intent,
    chosenIntent.target_slot,
  );
  const targetSlots = uniqueStrings(
    [
      chosenIntent.target_slot,
      ...input.rankedIntents.slice(0, 3).map((intent) => intent.target_slot),
    ].filter((slotPath): slotPath is string => Boolean(slotPath)),
  );
  const consecutiveIntentCount = input.priorConsecutiveIntentFirings + 1;
  const targetSlotUnfilled = chosenIntent.target_slot
    ? !input.currentSlots.some(
        (slot) =>
          slot.slotPath === chosenIntent.target_slot &&
          ["filled", "asked_unknown"].includes(slot.status),
      )
    : false;
  const checkerSignal = input.checkerSignal;
  const verbatimRequired =
    anchorPhrasings.length > 0 &&
    ((consecutiveIntentCount >= 2 && targetSlotUnfilled) ||
      Boolean(checkerSignal?.ignoredSteering) ||
      Boolean(checkerSignal?.staleQuestion));
  return {
    next_objective: directive,
    directive,
    anchor_phrasings: anchorPhrasings,
    verbatim_required: verbatimRequired,
    consecutive_intent_count: consecutiveIntentCount,
    target_slots: targetSlots,
    do_not_ask: uniqueStrings([
      ...input.filledSlotPaths,
      ...input.pendingSlotPaths,
      ...input.provisionallyAnsweredSlots,
      // Verbatim utterances Otto already spoke; the phraser must not re-ask
      // paraphrases of these.
      ...input.recentAgentUtterances.slice(-3),
      ...(checkerSignal?.offendingUtterance ? [checkerSignal.offendingUtterance] : []),
    ]),
    required_style:
      "Be sparing. Let the operator narrate, acknowledge briefly, and ask at most one concrete workflow follow-up only when it fills a blocking gap or resolves ambiguity.",
    recent_screen_events: input.recentScreenEvents ?? [],
    live_reconciliation_signals: input.liveReconciliationSignals ?? [],
    pending_extraction_turns: input.pendingExtractionTurns,
    pending_slot_paths: input.pendingSlotPaths,
    provisionally_answered_slots: input.provisionallyAnsweredSlots,
    last_spoken_intent: input.lastSpokenIntent,
  };
}

/**
 * One-transaction read of the steering signals the deterministic plan needs:
 * probe firings (cooldowns, consecutive-intent count), the prior turns'
 * delivery rows (checker feedback loop + recent Otto questions), and pending
 * extraction windows (provisional-answer guard across worker restarts).
 */
async function readOperatorSteeringSignals(
  input: Pick<OperatorTurnInput, "orgId" | "workspaceId" | "captureSessionId" | "turnIndex">,
): Promise<{
  probeFiringRows: OperatorProbeFiringRow[];
  priorTurnDeliveries: Array<{ turnIndex: number | null; deliveryJson: unknown }>;
  recentAgentUtterances: string[];
  pendingWindows: { turnIndexes: number[]; slotPaths: string[] };
}> {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const probeFiringRows = await tx
      .select({
        probeId: probeFirings.probeId,
        targetSlot: probeFirings.targetSlot,
        turnIndex: probeFirings.turnIndex,
        firedAt: probeFirings.firedAt,
      })
      .from(probeFirings)
      .where(
        and(
          eq(probeFirings.orgId, input.orgId),
          eq(probeFirings.workspaceId, input.workspaceId),
          eq(probeFirings.captureSessionId, input.captureSessionId),
        ),
      )
      .orderBy(desc(probeFirings.firedAt))
      .limit(200);
    const priorTurnDeliveries =
      input.turnIndex > 0
        ? await tx
            .select({
              turnIndex: agentDecisionLog.turnIndex,
              deliveryJson: agentDecisionLog.deliveryJson,
            })
            .from(agentDecisionLog)
            .where(
              and(
                eq(agentDecisionLog.orgId, input.orgId),
                eq(agentDecisionLog.workspaceId, input.workspaceId),
                eq(agentDecisionLog.captureSessionId, input.captureSessionId),
                eq(agentDecisionLog.stageName, "operator.turn"),
                lt(agentDecisionLog.turnIndex, input.turnIndex),
              ),
            )
            .orderBy(desc(agentDecisionLog.turnIndex))
            .limit(3)
        : [];
    const pendingWindowRows = await tx
      .select({
        turnIndex: operatorExtractionWindows.turnIndex,
        metadataJson: operatorExtractionWindows.metadataJson,
      })
      .from(operatorExtractionWindows)
      .where(
        and(
          eq(operatorExtractionWindows.orgId, input.orgId),
          eq(operatorExtractionWindows.workspaceId, input.workspaceId),
          eq(operatorExtractionWindows.captureSessionId, input.captureSessionId),
          eq(operatorExtractionWindows.status, "pending"),
        ),
      )
      .orderBy(desc(operatorExtractionWindows.openedAt))
      .limit(20);
    const turnIndexes = new Set<number>();
    const slotPaths = new Set<string>();
    for (const row of pendingWindowRows) {
      if (typeof row.turnIndex === "number") turnIndexes.add(row.turnIndex);
      const metadata =
        row.metadataJson && typeof row.metadataJson === "object"
          ? (row.metadataJson as Record<string, unknown>)
          : undefined;
      const steering =
        metadata?.steering_context && typeof metadata.steering_context === "object"
          ? (metadata.steering_context as Record<string, unknown>)
          : undefined;
      const targets = Array.isArray(steering?.target_slots) ? steering.target_slots : [];
      for (const target of targets) {
        if (typeof target === "string" && target.trim()) slotPaths.add(target);
      }
    }
    const recentAgentUtterances = [...priorTurnDeliveries]
      .reverse()
      .map((row) => agentUtteranceFromDeliveryJson(row.deliveryJson))
      .filter((value): value is string => Boolean(value));
    return {
      probeFiringRows,
      priorTurnDeliveries,
      recentAgentUtterances,
      pendingWindows: { turnIndexes: [...turnIndexes], slotPaths: [...slotPaths] },
    };
  });
}

function agentUtteranceFromDeliveryJson(deliveryJson: unknown): string | undefined {
  if (!deliveryJson || typeof deliveryJson !== "object") return undefined;
  const record = deliveryJson as Record<string, unknown>;
  return [
    record.delivered_utterance,
    record.spoken_agent_utterance,
    record.planned_utterance,
  ].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

export async function planOperatorTurnStreamed(
  input: OperatorTurnInput,
  onEvent?: (event: OperatorTurnPlanStreamEvent) => void,
) {
  let emitted = false;
  const result = await planOperatorTurnWithPlanner(input, (opts) =>
    structuredStream<OperatorTurnPlan>({
      ...opts,
      onFieldComplete: (field, value) => {
        if (field !== "planned_agent_utterance" || emitted) return;
        const utterance = limitToSingleQuestion(value.trim());
        if (!utterance) return;
        emitted = true;
        onEvent?.({ type: "planned_agent_utterance", utterance });
      },
    }),
  );
  if (!emitted) {
    onEvent?.({
      type: "planned_agent_utterance",
      utterance: result.planned_agent_utterance,
    });
  }
  return result;
}

async function planOperatorTurnWithPlanner(
  input: OperatorTurnInput,
  planner: OperatorPlanner,
  options: { phrase?: boolean; source?: string } = {},
): Promise<OperatorTurnPlanResult> {
  const startedAt = new Date();
  const planningContext = await readOperatorPlanningContext(input);
  const deterministicPlan = operatorTurnPlanSchema.parse(
    deterministicOperatorTurnPlan({
      ...input,
      currentPhase: planningContext.currentPhase,
    }),
  );
  const liveReconciliationSignals =
    detectLiveReconciliationSignals(planningContext);
  const promptBlocks = buildOperatorPromptCacheBlocks({
    latestUtterance: input.latestUtterance,
    evidenceIds: input.evidenceIds,
    currentSlots: planningContext.currentSlots,
    workspaceMemory: planningContext.workspaceMemory,
    recentTurns: planningContext.recentTurns,
    recentScreenEvents: planningContext.recentScreenEvents,
    sopChunks: planningContext.sopChunks,
    liveReconciliationSignals,
    currentPhase: planningContext.currentPhase,
  });
  let plan = deterministicPlan;
  let llmResult: StructuredGeneration<OperatorTurnPlan> | undefined;
  let degradedQuality = false;
  const degradedReasons: string[] = [];

  try {
    llmResult = await planner({
      prompt_template_id: "operator.turn.plan",
      prompt_template_version: "1",
      schema_name: "operator-turn-plan",
      schema: operatorTurnPlanSchema,
      input: "",
      static_input: promptBlocks.staticBlock,
      dynamic_input: promptBlocks.dynamicBlock,
      anthropic_tool: {
        name: "emit_operator_turn_plan",
        description:
          "Emit the validated operator workflow interview turn plan, including provisional step updates, slots, contradictions, chosen intent, and the exact next spoken utterance.",
        input_schema: operatorTurnPlanAnthropicToolSchema(),
        strict: true,
      },
      mock: deterministicPlan,
    });
    plan = mergeOperatorDeterministicExtractions(
      llmResult.value,
      deterministicPlan,
    );
    degradedQuality = llmResult.metadata.mocked;
    if (llmResult.metadata.mocked) degradedReasons.push("llm_mocked");
  } catch (error) {
    degradedQuality = true;
    degradedReasons.push("structured_operator_plan_failed");
    plan = {
      ...deterministicPlan,
      contradiction_signals: [
        ...deterministicPlan.contradiction_signals,
        error instanceof Error ? error.message : "structured_operator_plan_failed",
      ],
    };
  }

  plan = applyLiveReconciliationSignals(plan, liveReconciliationSignals);

  const normalized = normalizeOperatorPlan(plan, deterministicPlan, input.evidenceIds);
  plan = normalized.plan;
  degradedReasons.push(...normalized.degradedReasons);
  degradedQuality = degradedQuality || normalized.degradedReasons.length > 0;

  const rawUtterance = plan.planned_agent_utterance?.trim();
  let plannedUtterance = limitToSingleQuestion(
    rawUtterance || deterministicOperatorUtterance(plan.chosen_intent),
  );
  let utteranceSource = rawUtterance
    ? "brain_planned_utterance"
    : "deterministic_phrase_fallback";
  let utteranceReason = rawUtterance ? undefined : "missing_planned_agent_utterance";
  let voicePhraseMetadata: Record<string, unknown> | undefined;
  let voicePhraseFallback = false;

  if (options.phrase !== false && shouldUseSeparateOperatorVoiceLlm()) {
    const phrased = await phraseOperatorTurnWithSeparateVoice({
      input,
      plan,
      planningContext,
      liveReconciliationSignals,
      fallbackUtterance: plannedUtterance,
      fallbackUtteranceSource: utteranceSource,
    });
    plannedUtterance = phrased.utterance;
    utteranceSource = phrased.utteranceSource;
    utteranceReason = phrased.reason ?? utteranceReason;
    voicePhraseMetadata = phrased.metadata;
    voicePhraseFallback = phrased.fallback;
  }

  plan = operatorTurnPlanSchema.parse({
    ...plan,
    planned_agent_utterance: plannedUtterance,
  });

  const metadata = llmResult
    ? metadataFromGeneration(llmResult.metadata, {
        utteranceSource,
        reason: utteranceReason,
        llmCallElided: utteranceSource !== "separate_voice_llm",
        voicePhraseFallback,
        voicePhraseMetadata,
      })
    : deterministicPlannerMetadata(startedAt, input, plan, {
        source: options.source ?? "deterministic_operator_planner",
        utteranceSource,
        reason: utteranceReason ?? "structured_operator_plan_failed",
        llmCallElided: utteranceSource !== "separate_voice_llm",
        voicePhraseFallback,
        voicePhraseMetadata,
      });

  return {
    plan,
    planned_agent_utterance: plannedUtterance,
    metadata,
    degraded_quality: degradedQuality,
    degraded_reasons: uniqueStrings(degradedReasons),
    started_at: startedAt,
  };
}

export async function dispatchOperatorTurnPlan(
  input: OperatorTurnInput &
    OperatorTurnPlanResult & {
      localTurnCorrelationId?: string;
      deliveryStatus?: "pending" | "completed";
      decisionStageName?: string;
      advanceConversationState?: boolean;
      deliveryJsonOverrides?: Record<string, unknown>;
      tx?: OperatorBrainTx;
    },
) {
  const commit = async (tx: OperatorBrainTx) => {
    await setOrgContext(tx, input.orgId);
    const insertedSteps = [];
    for (const [index, step] of input.plan.step_updates.entries()) {
      insertedSteps.push(
        await insertOperatorProvisionalStep(
          {
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            processId: input.processId,
            captureSessionId: input.captureSessionId,
            userId: input.userId,
            language: input.language,
          },
          {
            title: step.title,
            actionVerb: step.action_verb,
            actionObject: step.action_object,
            tsStartMs: step.ts_start_ms,
            tsEndMs: step.ts_end_ms,
            confidence: step.confidence,
            evidenceIds: step.evidence_ids,
            sourceEventId: `operator-turn-${input.turnIndex}`,
            idempotencyKey: `operator-turn:${input.turnIndex}:step:${index}`,
          },
          tx,
        ),
      );
    }
    const primaryStepId = insertedSteps[0]?.id;
    for (const slot of input.plan.slot_updates) {
      await upsertOperatorSlotState(
        {
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          processId: input.processId,
          captureSessionId: input.captureSessionId,
          userId: input.userId,
          language: input.language,
        },
        {
          slotPath: slot.slot_path,
          provisionalStepId: scopedOperatorProvisionalStepId(
            slot.slot_path,
            slot.provisional_step_id,
            primaryStepId,
          ),
          value: slot.value,
          status: slot.status,
          confidence: slot.confidence,
          evidenceIds: slot.evidence_ids,
          candidates: slot.candidates,
        },
        tx,
      );
    }
    const toolExecutions = await executeOperatorToolCalls({
      input,
      primaryStepId,
      tx,
    });
    const claimWrites = await dispatchOperatorPlanClaims(input, tx);
    if (input.advanceConversationState ?? true) {
      await writeOperatorInterviewState(
        input,
        {
          currentPhase: input.plan.proposed_next_phase,
          priorIntent: input.plan.chosen_intent.intent,
          phaseTransition: input.plan.phase_transition_ready
            ? {
                from: input.plan.current_phase,
                to: input.plan.proposed_next_phase,
                turn_index: input.turnIndex,
              }
            : undefined,
        },
        tx,
      );
      // Task 2: spoken turns record a probe firing so cooldown/max_fires
      // enforcement, the provisional-answer guard, and the consecutive-intent
      // count have data to read. The extraction dispatch passes
      // advanceConversationState: false and does not record one.
      await tx
        .insert(probeFirings)
        .values({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          captureSessionId: input.captureSessionId,
          probeId: input.plan.chosen_intent.intent,
          targetSlot: isControllerExemptIntent(input.plan.chosen_intent)
            ? undefined
            : input.plan.chosen_intent.target_slot,
          turnIndex: input.turnIndex,
          styleHint: input.plan.chosen_intent.style_hint,
        })
        .onConflictDoNothing();
    }
    const decision = await writeAgentDecisionInTransaction(tx, {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      captureSessionId: input.captureSessionId,
      turnIndex: input.turnIndex,
      stageName: input.decisionStageName ?? "operator.turn",
      tsStart: input.started_at,
      tsEnd: new Date(),
      transcriptSegmentIds: input.transcriptSegmentIds,
      slotUpdates: input.plan.slot_updates,
      rankedProbeIntents: input.plan.ranked_intents,
      chosenIntent: input.plan.chosen_intent,
      sanitizedAgentUtterance: input.planned_agent_utterance,
      promptTemplateId: input.metadata.prompt_template_id,
      promptTemplateVersion: input.metadata.prompt_template_version,
      toolCalls: input.plan.tool_calls,
      deliveryJson: {
        delivery_status: input.deliveryStatus ?? "pending",
        planned_utterance: input.planned_agent_utterance,
        local_turn_correlation_id: input.localTurnCorrelationId ?? null,
        voice_metadata: input.metadata,
        provisional_step_ids: insertedSteps.map((step) => step.id),
        tool_executions: toolExecutions,
        claim_write_count: claimWrites.length,
        ...input.deliveryJsonOverrides,
      },
      model: input.metadata.model,
      tokenCountInput: input.metadata.token_count_input,
      tokenCountOutput: input.metadata.token_count_output,
      costCents: input.metadata.cost_cents,
      latencyMs: input.metadata.latency_ms,
      cacheHit: input.metadata.cache_hit,
      degradedQuality: input.degraded_quality,
      degradedReasons: input.degraded_reasons,
    });
    return {
      plan: input.plan,
      planned_agent_utterance: input.planned_agent_utterance,
      metadata: input.metadata,
      degraded_quality: input.degraded_quality,
      degraded_reasons: input.degraded_reasons,
      decision_log_id: decision.id,
      provisional_steps: insertedSteps,
      tool_executions: toolExecutions,
      claim_writes: claimWrites,
    };
  };
  const result = input.tx ? await commit(input.tx) : await getDb().transaction(commit);
  await sendOperatorToolEvents(input, result.tool_executions);
  return result;
}

export async function checkOperatorSpokenOutput(input: {
  spokenAgentUtterance: string;
  steeringContext: Record<string, unknown>;
}): Promise<OperatorOutputCheckResult> {
  const started = new Date();
  const heuristic = heuristicOperatorOutputCheck(input);
  try {
    const result = await structured({
      prompt_template_id: "operator.checker.output",
      prompt_template_version: "1",
      schema_name: "operator-output-check",
      schema: operatorOutputCheckSchema,
      static_input: [
        "You are checking one spoken Otto operator-interview utterance after it was already delivered.",
        "Record your verdict with the emit_operator_output_check tool. Do not rewrite the utterance.",
        "Flag unsupported factual claims, stale questions, an ignored steering objective (ignored_next_objective), multiple questions, verbosity, internal mechanics, and contradictions with live reconciliation signals.",
      ].join("\n"),
      dynamic_input: JSON.stringify(
        {
          spoken_agent_utterance: input.spokenAgentUtterance,
          steering_context: input.steeringContext,
        },
        null,
        2,
      ),
      input:
        "Return checker_status, violations, checker_violation_count, and stale_question_count.",
      anthropic_tool: {
        name: "emit_operator_output_check",
        description:
          "Emit the post-hoc verdict for one delivered operator-interview utterance: checker status, steering violations, and counts.",
        input_schema: operatorOutputCheckAnthropicToolSchema as unknown as Record<string, unknown>,
        strict: true,
      },
      mock: heuristic,
    });
    return normalizeOperatorOutputCheck(result.value, result.metadata);
  } catch {
    return normalizeOperatorOutputCheck(
      {
        ...heuristic,
        checker_status: "failed",
      },
      operatorCheckerFallbackMetadata(started),
    );
  }
}

export async function recordOperatorOutputCheck(input: {
  context: OperatorSessionContext;
  turnIndex: number;
  decisionLogId: string;
  check: OperatorOutputCheckResult;
  localTurnCorrelationId?: string;
}) {
  const patch = {
    checker_status: input.check.checker_status,
    checker_violations: input.check.violations,
    checker_violation_count: input.check.checker_violation_count,
    stale_question_count: input.check.stale_question_count,
    checker_metadata: input.check.metadata,
    ...(input.localTurnCorrelationId
      ? { local_turn_correlation_id: input.localTurnCorrelationId }
      : {}),
  };
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.context.orgId);
    const hasCheckerIssue =
      input.check.checker_status === "failed" ||
      input.check.checker_violation_count > 0;
    const updated = await tx
      .update(agentDecisionLog)
      .set({
        deliveryJson: sql`coalesce(${agentDecisionLog.deliveryJson}, '{}'::jsonb) || ${JSON.stringify(
          patch,
        )}::jsonb`,
        ...(hasCheckerIssue
          ? {
              degradedQuality: true,
              degradedReasons:
                input.check.checker_status === "failed"
                  ? ["operator_output_checker_failed"]
                  : ["operator_output_checker_violation"],
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentDecisionLog.id, input.decisionLogId),
          eq(agentDecisionLog.orgId, input.context.orgId),
          eq(agentDecisionLog.workspaceId, input.context.workspaceId),
          eq(agentDecisionLog.captureSessionId, input.context.captureSessionId),
          eq(agentDecisionLog.turnIndex, input.turnIndex),
          eq(agentDecisionLog.stageName, "operator.turn"),
        ),
      )
      .returning();
    if (hasCheckerIssue) {
      await tx.insert(followUpTasks).values({
        orgId: input.context.orgId,
        workspaceId: input.context.workspaceId,
        processId: input.context.processId,
        captureSessionId: input.context.captureSessionId,
        taskType: "low_confidence_claim",
        title: "Review operator spoken-output checker result",
        description:
          input.check.violations[0]?.message ??
          "The async operator spoken-output checker failed or found a steering violation.",
        targetType: "capture_session",
        targetId: input.context.captureSessionId,
        priority: "0.75",
        status: "open",
        assignedToUserId: input.context.userId,
        contextJson: patch,
      });
    }
    return updated;
  });
}

async function dispatchOperatorPlanClaims(
  input: OperatorTurnInput & OperatorTurnPlanResult,
  tx: OperatorBrainTx,
) {
  const writes = [];
  for (const claim of input.plan.claims) {
    const subjectType = claim.subject_type;
    if (!isOperatorWritableClaimSubject(subjectType)) continue;
    const request = {
      subject_type: subjectType,
      subject_id: claim.subject_id,
      field: claim.field,
      value: claim.value,
      evidence_ids: claim.evidence_ids,
      confidence: claim.confidence,
      metadata: claim.metadata,
    };
    writes.push(
      await writeClaimInTransaction(tx, {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        subject: {
          type: subjectType,
          id: claim.subject_id,
        },
        field: claim.field,
        value: claim.value,
        evidenceIds: claim.evidence_ids,
        confidence: claim.confidence,
        idempotencyKey: `operator-plan-claim:${hash(request)}`,
        requestHash: hash(request),
        route: "operator-plan-claim",
        metadata: claim.metadata,
      }),
    );
  }
  return writes;
}

function isOperatorWritableClaimSubject(
  value: string,
): value is "process" | "process_version" | "candidate_process" | "system" | "role" | "person" {
  return ["process", "process_version", "candidate_process", "system", "role", "person"].includes(
    value,
  );
}

async function writeOperatorInterviewState(
  input: OperatorTurnInput & OperatorTurnPlanResult,
  state: {
    currentPhase: OperatorInterviewPhase;
    priorIntent: string;
    phaseTransition?: {
      from: OperatorInterviewPhase;
      to: OperatorInterviewPhase;
      turn_index: number;
    };
  },
  tx: OperatorBrainTx,
) {
  const existing = (
    await tx
      .select({
        lowInfoTurnCount: interviewState.lowInfoTurnCount,
        lastNewSlotTurnIndex: interviewState.lastNewSlotTurnIndex,
        phaseHistory: interviewState.phaseHistory,
        currentPhase: interviewState.currentPhase,
      })
      .from(interviewState)
      .where(eq(interviewState.captureSessionId, input.captureSessionId))
      .limit(1)
  )[0];
  const lowInfoTurn = isLowInfoOperatorTurn(input.plan.utterance_type);
  const nextLowInfoTurnCount = lowInfoTurn
    ? (existing?.lowInfoTurnCount ?? 0) + 1
    : 0;
  const shouldForceClose =
    lowInfoTurn &&
    nextLowInfoTurnCount >= 3 &&
    operatorPhase(existing?.currentPhase) !== "closeout";
  const forcedCloseTransition = shouldForceClose
    ? {
        from: operatorPhase(existing?.currentPhase ?? state.currentPhase),
        to: "closeout" as const,
        turn_index: input.turnIndex,
        reason: "three_low_info_operator_turns",
      }
    : undefined;
  const nextPhase = shouldForceClose ? "closeout" : state.currentPhase;
  const priorPhaseHistory = Array.isArray(existing?.phaseHistory)
    ? existing.phaseHistory
    : [];
  const nextPhaseHistory = [
    ...priorPhaseHistory,
    ...(state.phaseTransition ? [state.phaseTransition] : []),
    ...(forcedCloseTransition ? [forcedCloseTransition] : []),
  ].slice(-30);
  await tx
    .insert(interviewState)
    .values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      captureSessionId: input.captureSessionId,
      currentPhase: nextPhase,
      focusProcessId: input.processId,
      priorIntent: state.priorIntent,
      lowInfoTurnCount: nextLowInfoTurnCount,
      lastNewSlotTurnIndex: input.plan.slot_updates.length ? input.turnIndex : null,
      phaseHistory: nextPhaseHistory,
    })
    .onConflictDoUpdate({
      target: [interviewState.captureSessionId],
      set: {
        currentPhase: nextPhase,
        focusProcessId: input.processId,
        priorIntent: state.priorIntent,
        lowInfoTurnCount: nextLowInfoTurnCount,
        lastNewSlotTurnIndex: input.plan.slot_updates.length
          ? input.turnIndex
          : (existing?.lastNewSlotTurnIndex ?? null),
        phaseHistory: nextPhaseHistory,
        updatedAt: new Date(),
      },
    });
  if (shouldForceClose) {
    await tx.insert(followUpTasks).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      captureSessionId: input.captureSessionId,
      taskType: "open_question",
      title: "Operator interview forced close needs follow-up",
      description:
        "The operator interview hit three low-information turns. Review unresolved priority slots before approval.",
      targetType: "capture_session",
      targetId: input.captureSessionId,
      priority: "0.85",
      status: "open",
      assignedToUserId: input.userId,
      contextJson: {
        reason: "three_low_info_operator_turns",
        phase: nextPhase,
        turn_index: input.turnIndex,
      },
    });
  }
}

export async function updateOperatorExtractionStatus(input: {
  context: OperatorSessionContext;
  turnIndex: number;
  extractionStatus: "pending" | "complete" | "failed";
  extractionDecisionLogId?: string;
  extractionLatencyMs?: number;
  errorMessage?: string;
  localTurnCorrelationId?: string;
  extractionWindowId?: string;
  tx?: OperatorBrainTx;
}) {
  const patch = {
    extraction_status: input.extractionStatus,
    ...(input.extractionDecisionLogId
      ? { extraction_decision_log_id: input.extractionDecisionLogId }
      : {}),
    ...(typeof input.extractionLatencyMs === "number"
      ? { extraction_latency_ms: input.extractionLatencyMs }
      : {}),
    ...(input.errorMessage ? { extraction_error_message: input.errorMessage } : {}),
    ...(input.localTurnCorrelationId
      ? { local_turn_correlation_id: input.localTurnCorrelationId }
      : {}),
    ...(input.extractionWindowId ? { extraction_window_id: input.extractionWindowId } : {}),
  };
  const update = (tx: OperatorBrainTx) =>
    tx
      .update(agentDecisionLog)
      .set({
        deliveryJson: sql`coalesce(${agentDecisionLog.deliveryJson}, '{}'::jsonb) || ${JSON.stringify(
          patch,
        )}::jsonb`,
        ...(input.extractionStatus === "failed"
          ? {
              degradedQuality: true,
              degradedReasons: ["operator_extraction_failed"],
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentDecisionLog.captureSessionId, input.context.captureSessionId),
          eq(agentDecisionLog.turnIndex, input.turnIndex),
          eq(agentDecisionLog.stageName, "operator.turn"),
        ),
      )
      .returning();
  if (input.tx) return update(input.tx);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.context.orgId);
    return update(tx);
  });
}

export async function upsertOperatorExtractionWindow(input: {
  context: OperatorSessionContext;
  extractionWindowId: string;
  turnIndex: number;
  transcriptSegmentIds: string[];
  openedAt?: Date;
  closedAt?: Date;
  closedBy?: "assistant_spoke" | "silence" | "manual_end";
  status?: "pending" | "complete" | "failed";
  metadataJson?: Record<string, unknown>;
  tx?: OperatorBrainTx;
}) {
  const now = new Date();
  const upsert = async (tx: OperatorBrainTx) =>
    (
      await tx
        .insert(operatorExtractionWindows)
        .values({
          extractionWindowId: input.extractionWindowId,
          orgId: input.context.orgId,
          workspaceId: input.context.workspaceId,
          captureSessionId: input.context.captureSessionId,
          turnIndex: input.turnIndex,
          transcriptSegmentIds: input.transcriptSegmentIds,
          openedAt: input.openedAt ?? now,
          closedAt: input.closedAt ?? now,
          closedBy: input.closedBy ?? "assistant_spoke",
          status: input.status ?? "pending",
          metadataJson: input.metadataJson ?? {},
        })
        .onConflictDoUpdate({
          target: [operatorExtractionWindows.extractionWindowId],
          set: {
            transcriptSegmentIds: input.transcriptSegmentIds,
            closedAt: input.closedAt ?? now,
            closedBy: input.closedBy ?? "assistant_spoke",
            status: input.status ?? "pending",
            metadataJson: input.metadataJson ?? {},
            updatedAt: now,
          },
        })
        .returning()
    )[0];
  if (input.tx) return upsert(input.tx);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.context.orgId);
    return upsert(tx);
  });
}

type OperatorToolExecution = {
  name: string;
  status: "completed" | "skipped_invalid";
  target_id?: string;
  reason?: string;
};

async function executeOperatorToolCalls(input: {
  input: OperatorTurnInput & OperatorTurnPlanResult;
  primaryStepId?: string;
  tx: OperatorBrainTx;
}): Promise<OperatorToolExecution[]> {
  const executions: OperatorToolExecution[] = [];
  const context = {
    orgId: input.input.orgId,
    workspaceId: input.input.workspaceId,
    processId: input.input.processId,
    captureSessionId: input.input.captureSessionId,
    userId: input.input.userId,
    language: input.input.language,
  };
  for (const [callIndex, rawCall] of input.input.plan.tool_calls.entries()) {
    let call: OperatorToolCall;
    try {
      call = parseOperatorToolCall(rawCall);
    } catch (error) {
      executions.push({
        name: rawCall.name,
        status: "skipped_invalid",
        reason: error instanceof Error ? error.message : "invalid_tool_call",
      });
      continue;
    }
    if (call.name === "mark_step_boundary") {
      const args = call.arguments as {
        title: string;
        ts_start_ms?: number;
        ts_end_ms?: number;
        confidence: number;
        evidence_ids: string[];
      };
      const step = await insertOperatorProvisionalStep(
        context,
        {
          title: args.title,
          tsStartMs: args.ts_start_ms,
          tsEndMs: args.ts_end_ms,
          confidence: args.confidence,
          evidenceIds: args.evidence_ids,
          sourceEventId: `operator-tool-${input.input.turnIndex}:mark_step_boundary`,
          idempotencyKey: `operator-turn:${input.input.turnIndex}:tool:${callIndex}:mark_step_boundary`,
        },
        input.tx,
      );
      executions.push({ name: call.name, status: "completed", target_id: step.id });
      continue;
    }
    if (call.name === "request_redaction") {
      const args = call.arguments as {
        start_ms: number;
        end_ms: number;
        reason?: string;
      };
      const redaction = (
        await input.tx
          .insert(redactions)
          .values({
            orgId: input.input.orgId,
            workspaceId: input.input.workspaceId,
            captureSessionId: input.input.captureSessionId,
            startMs: args.start_ms,
            endMs: args.end_ms,
            requestedByUserId: input.input.userId,
            reason: args.reason ?? "operator_tool_requested_redaction",
            status: "pending",
          })
          .returning()
      )[0];
      executions.push({ name: call.name, status: "completed", target_id: redaction.id });
      continue;
    }
    if (call.name === "create_follow_up_gap") {
      const args = call.arguments as {
        question: string;
        target_slot?: string;
        priority: "low" | "medium" | "high";
        evidence_ids: string[];
      };
      const followUp = (
        await input.tx
          .insert(followUpTasks)
          .values({
            orgId: input.input.orgId,
            workspaceId: input.input.workspaceId,
            processId: input.input.processId,
            captureSessionId: input.input.captureSessionId,
            taskType: "open_question",
            title: args.question,
            description: args.question,
            targetType: "capture_session",
            targetId: input.input.captureSessionId,
            priority:
              args.priority === "high"
                ? "0.9"
                : args.priority === "low"
                  ? "0.35"
                  : "0.65",
            status: "open",
            assignedToUserId: input.input.userId,
            contextJson: {
              target_slot: args.target_slot ?? null,
              evidence_ids: args.evidence_ids,
              reason: "operator_tool_follow_up_gap",
            },
          })
          .returning()
      )[0];
      executions.push({ name: call.name, status: "completed", target_id: followUp.id });
      continue;
    }
    if (call.name === "update_slot_state") {
      const args = call.arguments as {
        slot_path: string;
        provisional_step_id?: string;
        value?: unknown;
        status: "empty" | "partial" | "filled" | "asked_unknown" | "conflicting" | "pending_re_extract";
        confidence: number;
        evidence_ids: string[];
      };
      assertOperatorSlotPath(args.slot_path);
      await upsertOperatorSlotState(
        context,
        {
          slotPath: args.slot_path,
          provisionalStepId: scopedOperatorProvisionalStepId(
            args.slot_path,
            args.provisional_step_id,
            input.primaryStepId,
          ),
          value: args.value,
          status: args.status,
          confidence: args.confidence,
          evidenceIds: args.evidence_ids,
        },
        input.tx,
      );
      executions.push({ name: call.name, status: "completed" });
      continue;
    }
    const slotUpdate = slotUpdateFromOperatorTool(call, input.primaryStepId);
    if (slotUpdate) {
      await upsertOperatorSlotState(context, slotUpdate, input.tx);
      executions.push({ name: call.name, status: "completed" });
    }
  }
  return executions;
}

function scopedOperatorProvisionalStepId(
  slotPath: string,
  explicitStepId?: string,
  primaryStepId?: string,
) {
  const scope = operatorSlotScope(slotPath);
  return scope === "step" || scope === "compatibility"
    ? explicitStepId ?? primaryStepId
    : undefined;
}

function slotUpdateFromOperatorTool(
  call: OperatorToolCall,
  primaryStepId?: string,
): Parameters<typeof upsertOperatorSlotState>[1] | null {
  switch (call.name) {
    case "record_system_observed":
      const systemArgs = call.arguments as {
        provisional_step_id?: string;
        system_name: string;
        role: string;
        evidence_ids: string[];
      };
      return {
        slotPath: "step.systems",
        provisionalStepId: systemArgs.provisional_step_id ?? primaryStepId,
        value: {
          system_name: systemArgs.system_name,
          role: systemArgs.role,
        },
        status: "filled",
        confidence: 0.72,
        evidenceIds: systemArgs.evidence_ids,
      };
    case "record_input_output":
      const ioArgs = call.arguments as {
        provisional_step_id?: string;
        io_type: string;
        label: string;
        medium?: string;
        evidence_ids: string[];
      };
      return {
        slotPath:
          ioArgs.io_type === "output" ? "step.output" : "step.data_copied_from",
        provisionalStepId: ioArgs.provisional_step_id ?? primaryStepId,
        value: {
          io_type: ioArgs.io_type,
          label: ioArgs.label,
          medium: ioArgs.medium ?? null,
        },
        status: "filled",
        confidence: 0.7,
        evidenceIds: ioArgs.evidence_ids,
      };
    case "record_decision_rule":
      const decisionArgs = call.arguments as {
        provisional_step_id?: string;
        condition: string;
        branches: string[];
        decision_owner?: string;
        evidence_ids: string[];
      };
      return {
        slotPath: "step.decision_criteria",
        provisionalStepId: decisionArgs.provisional_step_id ?? primaryStepId,
        value: {
          condition: decisionArgs.condition,
          branches: decisionArgs.branches,
          decision_owner: decisionArgs.decision_owner ?? null,
        },
        status: "filled",
        confidence: 0.68,
        evidenceIds: decisionArgs.evidence_ids,
      };
    case "record_handoff":
      const handoffArgs = call.arguments as {
        provisional_step_id?: string;
        next_owner: string;
        handoff_trigger?: string;
        medium?: string;
        evidence_ids: string[];
      };
      return {
        slotPath: "step.next_owner",
        provisionalStepId: handoffArgs.provisional_step_id ?? primaryStepId,
        value: {
          next_owner: handoffArgs.next_owner,
          handoff_trigger: handoffArgs.handoff_trigger ?? null,
          medium: handoffArgs.medium ?? null,
        },
        status: "filled",
        confidence: 0.68,
        evidenceIds: handoffArgs.evidence_ids,
      };
    case "record_exception":
      const exceptionArgs = call.arguments as {
        provisional_step_id?: string;
        condition: string;
        frequency?: string;
        impact?: string;
        evidence_ids: string[];
      };
      return {
        slotPath: "step.exceptions",
        provisionalStepId: exceptionArgs.provisional_step_id ?? primaryStepId,
        value: {
          condition: exceptionArgs.condition,
          frequency: exceptionArgs.frequency ?? null,
          impact: exceptionArgs.impact ?? null,
        },
        status: "filled",
        confidence: 0.7,
        evidenceIds: exceptionArgs.evidence_ids,
      };
    case "record_workaround":
      const workaroundArgs = call.arguments as {
        provisional_step_id?: string;
        workaround: string;
        reason?: string;
        normal_workflow?: boolean;
        evidence_ids: string[];
      };
      return {
        slotPath: "step.workarounds",
        provisionalStepId: workaroundArgs.provisional_step_id ?? primaryStepId,
        value: {
          workaround: workaroundArgs.workaround,
          reason: workaroundArgs.reason ?? null,
          normal_workflow: workaroundArgs.normal_workflow ?? null,
        },
        status: "filled",
        confidence: 0.7,
        evidenceIds: workaroundArgs.evidence_ids,
      };
    case "flag_intentional_deviation":
      const deviationArgs = call.arguments as {
        provisional_step_id?: string;
        deviation: string;
        reason?: string;
        normal_workflow?: boolean;
        evidence_ids: string[];
      };
      return {
        slotPath: "step.intentional_deviations",
        provisionalStepId: deviationArgs.provisional_step_id ?? primaryStepId,
        value: {
          deviation: deviationArgs.deviation,
          reason: deviationArgs.reason ?? null,
          normal_workflow: deviationArgs.normal_workflow ?? null,
        },
        status: "filled",
        confidence: 0.7,
        evidenceIds: deviationArgs.evidence_ids,
      };
    default:
      return null;
  }
}

async function sendOperatorToolEvents(
  input: OperatorTurnInput,
  executions: OperatorToolExecution[],
) {
  const redactionIds = executions
    .filter((execution) => execution.name === "request_redaction" && execution.target_id)
    .map((execution) => execution.target_id as string);
  await Promise.all(
    redactionIds.map((redactionId) =>
      inngest.send({
        name: operatorRedactionRequestedEventName,
        data: {
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          processId: input.processId,
          captureSessionId: input.captureSessionId,
          redactionId,
          userId: input.userId,
        },
      }),
    ),
  );
}

type OperatorPlanningContext = {
  currentPhase: OperatorInterviewPhase;
  currentSlots: Array<{
    slotPath: string;
    status: string;
    confidence: string | number | null;
    provisionalStepId: string | null;
    value: unknown;
  }>;
  workspaceMemory: {
    candidateProcesses: string[];
    systems: string[];
    roles: string[];
    people: string[];
    vocabulary: string[];
    claims: string[];
  };
  recentTurns: string[];
  recentScreenEvents: Array<{
    tsMs: number;
    eventType: string;
    appName: string | null;
    windowTitle: string | null;
    uiStateLabel: string | null;
    ocrText: string | null;
    signalTags: string[];
  }>;
  sopChunks: Array<{ ordinal: number; text: string }>;
};

type LiveReconciliationSignal = {
  kind: "sop_screen_contradiction" | "observed_workaround_probe";
  signal: string;
  intent: OperatorIntent;
  plannedUtterance: string;
};

type OperatorVoicePhraseResult = {
  utterance: string;
  utteranceSource: string;
  reason?: string;
  fallback: boolean;
  metadata?: Record<string, unknown>;
};

function shouldUseSeparateOperatorVoiceLlm() {
  return getServerEnv().OTTO_OPERATOR_USE_SEPARATE_VOICE_LLM === true;
}

async function phraseOperatorTurnWithSeparateVoice(input: {
  input: OperatorTurnInput;
  plan: OperatorTurnPlan;
  planningContext: OperatorPlanningContext;
  liveReconciliationSignals: LiveReconciliationSignal[];
  fallbackUtterance: string;
  fallbackUtteranceSource: string;
  steering?: OperatorVoiceSteering;
}): Promise<OperatorVoicePhraseResult> {
  // Verbatim escalation exists because the phraser ignored steering; asking
  // the same phraser to comply via prompt would re-trust the failing
  // component. Bypass generation entirely and speak the canonical probe
  // phrasing.
  const verbatimAnchor =
    input.steering?.verbatimRequired && input.steering.anchorPhrasings[0]
      ? input.steering.anchorPhrasings[0]
      : undefined;
  if (verbatimAnchor) {
    return {
      utterance: limitToSingleQuestion(verbatimAnchor),
      utteranceSource: "verbatim_escalation",
      reason: "verbatim_escalation",
      fallback: false,
    };
  }
  const env = getServerEnv();
  if (!env.ANTHROPIC_API_KEY) {
    return {
      utterance: input.fallbackUtterance,
      utteranceSource: input.fallbackUtteranceSource,
      reason: "missing_anthropic_api_key",
      fallback: true,
    };
  }
  try {
    const result = await generate({
      prompt_template_id: "operator.voice.phrase-intent",
      prompt_template_version: "1",
      static_input: [
        "You are Otto, a calm workflow partner speaking live with an operator.",
        "Phrase exactly one next thing to say for a workflow deep-dive interview.",
        "HARD RULES:",
        "- Your question MUST target the OBJECTIVE below. Never substitute a different topic.",
        "- The ANCHOR PHRASINGS show what to ask; adapt the wording to the conversation, never the target.",
        "- Never re-ask anything in DO NOT ASK, including paraphrases of it.",
        "Be sparing. Let the operator narrate, and ask only when a blocking workflow gap or ambiguity needs a concrete answer.",
        "If a question is not needed, use a brief acknowledgement that invites the operator to keep going.",
        "Sound practical and curious, not like a survey.",
        "Do not mention slot names, schemas, extraction, or internal mechanics.",
        "If a screen/SOP contradiction is present, ask a clarification question without treating the SOP as more true than observed behavior.",
      ].join("\n"),
      dynamic_input: [
        operatorSteeringPromptSections(input.steering),
        [
          `Current phase: ${input.plan.current_phase}`,
          `Proposed phase: ${input.plan.proposed_next_phase}`,
          `Utterance type: ${input.plan.utterance_type}`,
          `Chosen intent: ${JSON.stringify(input.plan.chosen_intent)}`,
          `Fallback utterance: ${input.fallbackUtterance}`,
          "Recent operator turns:",
          ...(input.planningContext.recentTurns.length
            ? input.planningContext.recentTurns.slice(-4).map((turn) => `- ${turn}`)
            : ["- none"]),
          "Known workspace context:",
          ...formatWorkspaceMemory(input.planningContext.workspaceMemory),
          "Live reconciliation signals:",
          ...(input.liveReconciliationSignals.length
            ? input.liveReconciliationSignals.map((item) => `- ${item.signal}`)
            : ["- none"]),
          `Latest operator utterance: ${input.input.latestUtterance}`,
        ].join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n"),
      input: "Return only Otto's next spoken sentence or short pair of sentences. No JSON.",
    });
    const utterance = limitToSingleQuestion(result.text.trim());
    if (result.mocked || !utterance) {
      return {
        utterance: input.fallbackUtterance,
        utteranceSource: input.fallbackUtteranceSource,
        reason: result.mocked ? "separate_voice_llm_mocked" : "empty_separate_voice_llm",
        fallback: true,
        metadata: voicePhraseMetadataFromGeneration(result, input.fallbackUtteranceSource),
      };
    }
    return {
      utterance,
      utteranceSource: "separate_voice_llm",
      fallback: false,
      metadata: voicePhraseMetadataFromGeneration(result, "separate_voice_llm"),
    };
  } catch {
    return {
      utterance: input.fallbackUtterance,
      utteranceSource: input.fallbackUtteranceSource,
      reason: "separate_voice_llm_failed",
      fallback: true,
    };
  }
}

function operatorSteeringPromptSections(steering?: OperatorVoiceSteering) {
  if (!steering) return "";
  const sections = [
    "## OBJECTIVE (your question MUST target this)",
    steering.directive,
  ];
  if (steering.anchorPhrasings.length > 0) {
    sections.push(
      "## ANCHOR PHRASINGS (adapt wording to the conversation, never the target)",
      ...steering.anchorPhrasings.map((phrasing) => `- ${phrasing}`),
    );
  }
  sections.push(
    "## VERBATIM REQUIRED",
    steering.verbatimRequired
      ? "Yes. Speak the first anchor phrasing verbatim after a brief acknowledgment."
      : "No. Adapt the anchors naturally.",
  );
  if (steering.doNotAsk.length > 0) {
    sections.push(
      "## DO NOT ASK (already covered, pending, or just asked)",
      ...steering.doNotAsk.slice(0, 12).map((item) => `- ${item}`),
    );
  }
  if (steering.requiredStyle) {
    sections.push("## STYLE", steering.requiredStyle);
  }
  return sections.join("\n");
}

async function readOperatorPlanningContext(
  input: OperatorTurnInput,
): Promise<OperatorPlanningContext> {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const currentSlots = await tx
      .select({
        slotPath: slotStates.slotPath,
        status: slotStates.status,
        confidence: slotStates.confidence,
        provisionalStepId: slotStates.provisionalStepId,
        value: slotStates.value,
      })
      .from(slotStates)
      .where(
        and(
          eq(slotStates.orgId, input.orgId),
          eq(slotStates.workspaceId, input.workspaceId),
          eq(slotStates.captureSessionId, input.captureSessionId),
        ),
      )
      .orderBy(desc(slotStates.priority))
      .limit(24);
    const stateRows = await tx
      .select({
        currentPhase: interviewState.currentPhase,
      })
      .from(interviewState)
      .where(
        and(
          eq(interviewState.orgId, input.orgId),
          eq(interviewState.workspaceId, input.workspaceId),
          eq(interviewState.captureSessionId, input.captureSessionId),
        ),
      )
      .limit(1);
    const recentTurnRows = await tx
      .select({
        speaker: transcriptSegments.speaker,
        text: transcriptSegments.text,
        turnIndex: transcriptSegments.turnIndex,
      })
      .from(transcriptSegments)
      .where(
        and(
          eq(transcriptSegments.orgId, input.orgId),
          eq(transcriptSegments.workspaceId, input.workspaceId),
          eq(transcriptSegments.captureSessionId, input.captureSessionId),
        ),
      )
      .orderBy(desc(transcriptSegments.createdAt))
      .limit(8);
    const recentScreenEvents = await tx
      .select({
        tsMs: screenEvents.tsMs,
        eventType: screenEvents.eventType,
        appName: screenEvents.appName,
        windowTitle: screenEvents.windowTitle,
        uiStateLabel: screenEvents.uiStateLabel,
        ocrText: screenEvents.ocrText,
        signalTags: screenEvents.signalTags,
      })
      .from(screenEvents)
      .where(
        and(
          eq(screenEvents.orgId, input.orgId),
          eq(screenEvents.workspaceId, input.workspaceId),
          eq(screenEvents.captureSessionId, input.captureSessionId),
          sql`${screenEvents.deletedAt} IS NULL`,
          sql`${screenEvents.redactedAt} IS NULL`,
        ),
      )
      .orderBy(desc(screenEvents.tsMs))
      .limit(8);
    const sopChunks = await tx
      .select({
        ordinal: documentChunks.ordinal,
        text: documentChunks.text,
      })
      .from(documentChunks)
      .where(
        and(
          eq(documentChunks.orgId, input.orgId),
          eq(documentChunks.workspaceId, input.workspaceId),
          sql`${documentChunks.metadataJson}->>'process_id' = ${input.processId}`,
          sql`${documentChunks.redactedAt} IS NULL`,
        ),
      )
      .orderBy(documentChunks.ordinal)
      .limit(5);
    const workspaceMemory = await readOperatorWorkspaceMemory(tx, input);
    return {
      currentPhase: operatorPhase(stateRows[0]?.currentPhase),
      currentSlots,
      workspaceMemory,
      recentTurns: recentTurnRows
        .reverse()
        .map((turn) => `${turn.speaker}: ${turn.text}`),
      recentScreenEvents: recentScreenEvents.reverse(),
      sopChunks,
    };
  });
}

async function readOperatorWorkspaceMemory(
  tx: OperatorBrainTx,
  input: OperatorTurnInput,
): Promise<OperatorPlanningContext["workspaceMemory"]> {
  const candidateRows = await tx.execute<{
    proposed_name: string;
    proposed_function: string | null;
    owner_role: string | null;
  }>(sql`
    SELECT cp.proposed_name, cp.proposed_function, r.name AS owner_role
    FROM candidate_processes cp
    LEFT JOIN roles r
      ON r.id = cp.proposed_owner_role_id
     AND r.org_id = cp.org_id
    WHERE cp.org_id = ${input.orgId}
      AND cp.workspace_id = ${input.workspaceId}
      AND cp.status IN ('pending', 'promoted')
    ORDER BY cp.updated_at DESC, cp.created_at DESC
    LIMIT 8
  `);
  const systemRows = await tx.execute<{ name: string }>(sql`
    SELECT DISTINCT s.name
    FROM systems s
    WHERE s.org_id = ${input.orgId}
      AND (
        EXISTS (
          SELECT 1
          FROM claims c
          WHERE c.org_id = ${input.orgId}
            AND c.workspace_id = ${input.workspaceId}
            AND c.subject_type = 'system'
            AND c.subject_id = s.id
            AND c.status = 'active'
            AND c.superseded_by_claim_id IS NULL
            AND c.redacted_at IS NULL
            AND c.tombstoned_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM process_systems ps
          WHERE ps.org_id = ${input.orgId}
            AND ps.workspace_id = ${input.workspaceId}
            AND ps.system_id = s.id
        )
      )
    ORDER BY s.name
    LIMIT 12
  `);
  const roleRows = await tx.execute<{ name: string }>(sql`
    SELECT DISTINCT r.name
    FROM roles r
    WHERE r.org_id = ${input.orgId}
      AND (
        EXISTS (
          SELECT 1
          FROM candidate_processes cp
          WHERE cp.org_id = ${input.orgId}
            AND cp.workspace_id = ${input.workspaceId}
            AND cp.proposed_owner_role_id = r.id
        )
        OR EXISTS (
          SELECT 1
          FROM claims c
          WHERE c.org_id = ${input.orgId}
            AND c.workspace_id = ${input.workspaceId}
            AND c.subject_type = 'role'
            AND c.subject_id = r.id
            AND c.status = 'active'
            AND c.superseded_by_claim_id IS NULL
            AND c.redacted_at IS NULL
            AND c.tombstoned_at IS NULL
        )
      )
    ORDER BY r.name
    LIMIT 12
  `);
  const peopleRows = await tx.execute<{ name: string; title: string | null }>(sql`
    SELECT DISTINCT p.name, p.title
    FROM people p
    WHERE p.org_id = ${input.orgId}
      AND EXISTS (
        SELECT 1
        FROM claims c
        WHERE c.org_id = ${input.orgId}
          AND c.workspace_id = ${input.workspaceId}
          AND c.subject_type = 'person'
          AND c.subject_id = p.id
          AND c.status = 'active'
          AND c.superseded_by_claim_id IS NULL
          AND c.redacted_at IS NULL
          AND c.tombstoned_at IS NULL
      )
    ORDER BY p.name
    LIMIT 8
  `);
  const vocabularyRows = await tx.execute<{
    term: string;
    type: string;
    aliases: string[] | null;
  }>(sql`
    SELECT term, type::text, aliases
    FROM ontology_terms
    WHERE org_id = ${input.orgId}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 12
  `);
  const claimRows = await tx.execute<{
    subject_type: string;
    field: string;
    value: unknown;
  }>(sql`
    SELECT subject_type, field, value
    FROM claims
    WHERE org_id = ${input.orgId}
      AND workspace_id = ${input.workspaceId}
      AND status = 'active'
      AND superseded_by_claim_id IS NULL
      AND redacted_at IS NULL
      AND tombstoned_at IS NULL
      AND subject_type IN ('candidate_process', 'system', 'role', 'person')
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 12
  `);
  return {
    candidateProcesses: candidateRows.rows.map((row) =>
      [
        row.proposed_name,
        row.proposed_function ? `function=${row.proposed_function}` : "",
        row.owner_role ? `owner=${row.owner_role}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    ),
    systems: systemRows.rows.map((row) => row.name),
    roles: roleRows.rows.map((row) => row.name),
    people: peopleRows.rows.map((row) =>
      [row.name, row.title ? `(${row.title})` : ""].filter(Boolean).join(" "),
    ),
    vocabulary: vocabularyRows.rows.map((row) =>
      [
        `${row.term} [${row.type}]`,
        row.aliases?.length ? `aliases=${row.aliases.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    ),
    claims: claimRows.rows.map(
      (row) =>
        `${row.subject_type}.${row.field}=${trimText(JSON.stringify(row.value), 140)}`,
    ),
  };
}

export function buildOperatorPromptCacheBlocks(input: {
  latestUtterance: string;
  evidenceIds: string[];
  currentPhase: OperatorPlanningContext["currentPhase"];
  currentSlots: OperatorPlanningContext["currentSlots"];
  workspaceMemory: OperatorPlanningContext["workspaceMemory"];
  recentTurns: string[];
  recentScreenEvents: OperatorPlanningContext["recentScreenEvents"];
  sopChunks: OperatorPlanningContext["sopChunks"];
  liveReconciliationSignals: LiveReconciliationSignal[];
}) {
  return {
    staticBlock: [
      "You are the Otto Operator Interview Agent.",
      "Classify the operator's utterance, extract evidence-backed workflow steps, update step-scoped slots, identify contradictions, rank next probes, choose one next intent, and emit the exact next spoken line.",
      "Voice persona: calm workflow partner. Warm but efficient. Do not sound like a survey. Let the operator narrate; acknowledge briefly and ask only when a blocking workflow gap or ambiguity needs a concrete answer.",
      "For live latency, decide chosen_intent and planned_agent_utterance first, then emit the bookkeeping fields.",
      "Phase machine: orient -> happy_path -> hard_case -> exception_sweep -> playback -> closeout. Stay in the current phase unless the operator supplied enough information to advance.",
      "Evidence discipline: cite only current-turn evidence_ids for current-turn assertions. Observed screen events are evidence but not hidden intent. SOP chunks are documented evidence, not truth.",
      "Live reconciliation signals are priority hints. If a signal shows an SOP-vs-screen mismatch or observed manual workaround, ask one clarification question before continuing ordinary coverage.",
      "Slot schema:",
      ...operatorSlotDefinitions.map(
        (slot) => `- ${slot.path}: ${slot.label}, priority ${slot.priority}`,
      ),
      operatorExtractionStaticContract,
    ].join("\n"),
    dynamicBlock: [
      `Current turn evidence IDs: ${input.evidenceIds.join(", ") || "none"}`,
      `Current operator interview phase: ${input.currentPhase}`,
      "Current slot state:",
      ...(input.currentSlots.length
        ? input.currentSlots.map(
            (slot) =>
              `- ${slot.slotPath}${slot.provisionalStepId ? ` step=${slot.provisionalStepId}` : ""}: ${slot.status} (${slot.confidence ?? 0}) value=${JSON.stringify(slot.value ?? null)}`,
          )
        : ["- none"]),
      "Director-established workspace memory:",
      ...formatWorkspaceMemory(input.workspaceMemory),
      "Recent turns:",
      ...(input.recentTurns.length
        ? input.recentTurns.slice(-6).map((turn) => `- ${turn}`)
        : ["- none"]),
      "Recent screen events:",
      ...(input.recentScreenEvents.length
        ? input.recentScreenEvents.map((event) =>
            [
              `- ${event.tsMs}ms ${event.eventType}`,
              event.appName ? `app=${event.appName}` : "",
              event.windowTitle ? `window=${event.windowTitle}` : "",
              event.uiStateLabel ? `ui=${event.uiStateLabel}` : "",
              event.signalTags.length ? `signals=${event.signalTags.join(",")}` : "",
              event.ocrText ? `ocr=${trimText(event.ocrText, 160)}` : "",
            ]
              .filter(Boolean)
              .join(" "),
          )
        : ["- none"]),
      "SOP/document chunks for contradiction checks:",
      ...(input.sopChunks.length
        ? input.sopChunks.map(
            (chunk) => `- chunk ${chunk.ordinal}: ${trimText(chunk.text, 220)}`,
          )
        : ["- none"]),
      "Live reconciliation signals:",
      ...(input.liveReconciliationSignals.length
        ? input.liveReconciliationSignals.map((item) => `- ${item.signal}`)
        : ["- none"]),
      `Latest operator utterance: ${input.latestUtterance}`,
    ].join("\n"),
  };
}

function formatWorkspaceMemory(
  memory: OperatorPlanningContext["workspaceMemory"],
) {
  const lines = [
    ...formatMemoryGroup("candidate processes", memory.candidateProcesses),
    ...formatMemoryGroup("systems", memory.systems),
    ...formatMemoryGroup("roles", memory.roles),
    ...formatMemoryGroup("people", memory.people),
    ...formatMemoryGroup("vocabulary", memory.vocabulary),
    ...formatMemoryGroup("active claims", memory.claims),
  ];
  return lines.length ? lines : ["- none"];
}

function formatMemoryGroup(label: string, values: string[]) {
  if (!values.length) return [];
  return [`- ${label}: ${values.map((value) => trimText(value, 100)).join("; ")}`];
}

const operatorExtractionStaticContract = `
Structured output contract:
- Emit chosen_intent and planned_agent_utterance before long arrays when streaming.
- planned_agent_utterance is the exact next thing Otto should say aloud; concise, natural, and at most one question.
- Be sparing with questions. If the operator is already narrating a sequence, prefer a brief acknowledgement and do not ask generic filler.
- utterance_type is substantive_answer, partial_answer, dont_know, correction, contradiction, meta_question, or off_topic.
- current_phase, proposed_next_phase, and phase_transition_ready must follow the operator phase machine: orient, happy_path, hard_case, exception_sweep, playback, closeout.
- step_updates[] are provisional workflow steps only. Final graph rows are synthesis-only.
- slot_updates[] must use only declared operator slot paths and status empty, partial, filled, asked_unknown, conflicting, or pending_re_extract.
- ranked_intents[] and chosen_intent include intent, optional target_slot, optional target_step_title, score, reason, and optional style_hint.
- claims[] should be empty unless the subject_id is already known with high confidence.
- tool_calls[] may include mark_step_boundary, record_system_observed, record_input_output, record_decision_rule, record_handoff, record_exception, record_workaround, flag_intentional_deviation, update_slot_state, request_redaction, or create_follow_up_gap.
- contradiction_signals[] should include concise evidence of SOP/screen/operator conflicts.
Probe guidance:
- Prefer capturing exact next step, then system/source-of-truth, input/output, decision rule, handoff, exception, workaround, or SOP contradiction.
- If recent screen events show duplicate entry, spreadsheet use, manual search/filtering, file upload/download, waiting/refreshing, or comments as state, ask one targeted clarification.
- If enough coverage exists, ask a closeout question about hidden or unofficial steps.
`;

function mergeOperatorDeterministicExtractions(
  plan: OperatorTurnPlan,
  deterministicPlan: OperatorTurnPlan,
): OperatorTurnPlan {
  const slotUpdates = [...plan.slot_updates];
  const seenSlots = new Set(slotUpdates.map((slot) => slot.slot_path));
  for (const slot of deterministicPlan.slot_updates) {
    if (seenSlots.has(slot.slot_path)) continue;
    slotUpdates.push(slot);
    seenSlots.add(slot.slot_path);
  }
  const stepUpdates = [...plan.step_updates];
  const seenStepTitles = new Set(stepUpdates.map((step) => normalizeKey(step.title)));
  for (const step of deterministicPlan.step_updates) {
    const key = normalizeKey(step.title);
    if (seenStepTitles.has(key)) continue;
    stepUpdates.push(step);
    seenStepTitles.add(key);
  }
  return {
    ...plan,
    step_updates: stepUpdates,
    slot_updates: slotUpdates,
    ranked_intents: plan.ranked_intents.length
      ? plan.ranked_intents
      : deterministicPlan.ranked_intents,
    chosen_intent: plan.chosen_intent ?? deterministicPlan.chosen_intent,
  };
}

function applyLiveReconciliationSignals(
  plan: OperatorTurnPlan,
  signals: LiveReconciliationSignal[],
): OperatorTurnPlan {
  if (!signals.length) return plan;
  const priority = signals[0];
  const shouldOverride =
    priority.kind === "sop_screen_contradiction" ||
    priority.intent.score >= (plan.chosen_intent?.score ?? 0);
  return {
    ...plan,
    contradiction_signals: uniqueStrings([
      ...plan.contradiction_signals,
      ...signals.map((item) => item.signal),
    ]),
    ranked_intents: [
      priority.intent,
      ...plan.ranked_intents.filter(
        (intent) => intent.intent !== priority.intent.intent,
      ),
    ],
    chosen_intent: shouldOverride ? priority.intent : plan.chosen_intent,
    planned_agent_utterance: shouldOverride
      ? priority.plannedUtterance
      : plan.planned_agent_utterance,
  };
}

function detectLiveReconciliationSignals(
  context: OperatorPlanningContext,
): LiveReconciliationSignal[] {
  const screenText = context.recentScreenEvents
    .map((event) =>
      [
        event.appName,
        event.windowTitle,
        event.uiStateLabel,
        event.ocrText,
        event.signalTags.join(" "),
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n");
  const sopText = context.sopChunks.map((chunk) => chunk.text).join("\n");
  const screenTags = new Set(
    context.recentScreenEvents.flatMap((event) => event.signalTags),
  );
  const signals: LiveReconciliationSignal[] = [];

  if (
    screenLooksLikeSpreadsheet(screenText, screenTags) &&
    sopText.trim() &&
    !/excel|spreadsheet|google sheets|sheet|csv|xlsx/i.test(sopText)
  ) {
    signals.push({
      kind: "sop_screen_contradiction",
      signal:
        "SOP/document chunks do not mention spreadsheet work, but recent screen evidence shows spreadsheet or CSV/XLSX usage.",
      intent: {
        intent: "clarify_sop_contradiction",
        target_slot: "sop.contradictions",
        score: 1300,
        reason:
          "Recent screen evidence appears to conflict with the documented workflow.",
        style_hint:
          "Ask whether the observed spreadsheet path is normal workflow now or a workaround for this case.",
      },
      plannedUtterance:
        "Quick check: I saw spreadsheet work while the SOP describes another path. Is the spreadsheet the normal workflow now, or a workaround for this case?",
    });
  }

  if (
    screenTags.has("copy_paste_between_systems") ||
    screenTags.has("duplicate_data_entry") ||
    screenTags.has("left_system_of_record")
  ) {
    signals.push({
      kind: "observed_workaround_probe",
      signal:
        "Recent screen evidence shows copy/paste, duplicate entry, or work outside the system of record.",
      intent: {
        intent: "clarify_observed_workaround",
        target_slot: "step.workarounds",
        score: 1150,
        reason:
          "Recent screen events suggest a possible manual workaround or duplicate-entry step.",
        style_hint:
          "Ask whether the observed manual work is expected or a workaround.",
      },
      plannedUtterance:
        "I noticed some manual copy or duplicate-entry work there. Is that an expected part of the process, or a workaround?",
    });
  }

  return dedupeLiveSignals(signals);
}

function screenLooksLikeSpreadsheet(text: string, tags: Set<string>) {
  return (
    tags.has("alt_tab_to_spreadsheet") ||
    tags.has("left_system_of_record") ||
    /excel|spreadsheet|google sheets|csv|xlsx/i.test(text)
  );
}

function dedupeLiveSignals(signals: LiveReconciliationSignal[]) {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = signal.intent.intent;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeOperatorPlan(
  plan: OperatorTurnPlan,
  deterministicPlan: OperatorTurnPlan,
  allowedEvidenceIds: string[],
) {
  const degradedReasons: string[] = [];
  const allowedEvidence = new Set(allowedEvidenceIds);
  const sanitizeEvidence = (ids: string[]) => {
    const filtered = ids.filter((id) => allowedEvidence.has(id));
    if (filtered.length !== ids.length) degradedReasons.push("invalid_evidence_reference");
    return filtered;
  };
  const stepUpdates = plan.step_updates.map((step) => ({
    ...step,
    evidence_ids: sanitizeEvidence(step.evidence_ids),
  }));
  const slotUpdates = plan.slot_updates
    .filter((slot) => {
      try {
        assertOperatorSlotPath(slot.slot_path);
        return true;
      } catch {
        degradedReasons.push("invalid_operator_slot_path");
        return false;
      }
    })
    .map((slot) => {
      let status = slot.status;
      let value = slot.value;
      let confidence = slot.confidence;
      // Task 3 rule 1 (operator mirror): a don't-know reply is never a slot
      // value. Convert the update to asked_unknown and drop the quoted
      // non-answer.
      if (
        (status === "filled" || status === "partial") &&
        isNonAnswerSlotExtraction(
          value,
          plan.utterance_type === "dont_know" ? "dont_know" : undefined,
        )
      ) {
        status = "asked_unknown";
        value = undefined;
      }
      // Task 3 rule 2: inferred values are capped at 0.45 by code.
      if (isInferredExtractionRecord(undefined, value)) {
        confidence = Math.min(confidence, INFERRED_EXTRACTION_CONFIDENCE_CAP);
      }
      return {
        ...slot,
        value,
        status,
        confidence,
        evidence_ids: sanitizeEvidence(slot.evidence_ids),
      };
    });
  const claims = plan.claims.map((claim) => ({
    ...claim,
    confidence: isInferredExtractionRecord(claim.metadata, claim.value)
      ? Math.min(claim.confidence, INFERRED_EXTRACTION_CONFIDENCE_CAP)
      : claim.confidence,
  }));
  const normalized = operatorTurnPlanSchema.safeParse({
    ...plan,
    step_updates: stepUpdates,
    slot_updates: slotUpdates,
    claims,
  });
  if (normalized.success) {
    return { plan: normalized.data, degradedReasons: uniqueStrings(degradedReasons) };
  }
  degradedReasons.push("operator_plan_normalization_failed");
  return {
    plan: deterministicPlan,
    degradedReasons: uniqueStrings(degradedReasons),
  };
}

const INFERRED_EXTRACTION_CONFIDENCE_CAP = 0.45;

function isInferredExtractionRecord(metadata: unknown, value: unknown) {
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).inferred === true
  ) {
    return true;
  }
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).inferred === true,
  );
}

export function operatorTurnPlanAnthropicToolSchema() {
  return withRequiredAnthropicFields(
    inlineJsonSchemaRefs(
      readSharedSchemaArtifact("operator-turn-plan.schema.json"),
      {
        "claim.schema.json": readSharedSchemaArtifact("claim.schema.json"),
      },
    ) as Record<string, unknown>,
    ["planned_agent_utterance"],
  );
}

function inlineJsonSchemaRefs(schema: unknown, refs: Record<string, unknown>): unknown {
  if (Array.isArray(schema)) return schema.map((item) => inlineJsonSchemaRefs(item, refs));
  if (!schema || typeof schema !== "object") return schema;
  const object = schema as Record<string, unknown>;
  if (Object.keys(object).length === 1 && typeof object.$ref === "string") {
    const ref = refs[object.$ref];
    if (ref) return inlineJsonSchemaRefs(ref, refs);
  }
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => key !== "$schema" && key !== "$id")
      .map(([key, value]) => [key, inlineJsonSchemaRefs(value, refs)]),
  );
}

function withRequiredAnthropicFields(
  schema: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> & { required: string[] } {
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  const existingRequired = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...schema,
    required: [
      ...new Set([
        ...existingRequired,
        ...fields.filter((field) => field in properties),
      ]),
    ],
  };
}

function metadataFromGeneration(
  generation: Generation,
  options: {
    utteranceSource: string;
    reason?: string;
    llmCallElided?: boolean;
    voicePhraseFallback?: boolean;
    voicePhraseMetadata?: Record<string, unknown>;
  },
): OperatorPlanMetadata {
  return {
    model: generation.model,
    prompt_template_id: generation.prompt_template_id,
    prompt_template_version: generation.prompt_template_version,
    token_count_input: generation.token_count_input,
    token_count_output: generation.token_count_output,
    cache_read_input_tokens: generation.cache_read_input_tokens,
    cache_creation_input_tokens: generation.cache_creation_input_tokens,
    cost_cents: generation.cost_cents,
    latency_ms: generation.latency_ms,
    cache_hit: generation.cache_hit,
    mocked: generation.mocked,
    streaming: generation.streaming,
    stream_cutoff: generation.stream_cutoff,
    source: generation.mocked ? "deterministic_operator_planner" : "operator_brain_llm",
    utterance_source: options.utteranceSource,
    llm_call_elided: options.llmCallElided ?? true,
    reason: options.reason,
    voice_phrase_fallback: options.voicePhraseFallback || undefined,
    voice_phrase_metadata: options.voicePhraseMetadata,
  };
}

function deterministicPlannerMetadata(
  startedAt: Date,
  input: OperatorTurnInput,
  plan: OperatorTurnPlan,
  options: {
    source: string;
    utteranceSource: string;
    reason?: string;
    llmCallElided?: boolean;
    voicePhraseFallback?: boolean;
    voicePhraseMetadata?: Record<string, unknown>;
  },
): OperatorPlanMetadata {
  return {
    model: "deterministic-operator-planner",
    prompt_template_id: "operator.turn.plan",
    prompt_template_version: "1",
    token_count_input: estimateTokens(input.latestUtterance),
    token_count_output: estimateTokens(JSON.stringify(plan)),
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_cents: 0,
    latency_ms: Date.now() - startedAt.getTime(),
    cache_hit: false,
    mocked: true,
    source: options.source,
    utterance_source: options.utteranceSource,
    llm_call_elided: options.llmCallElided ?? true,
    reason: options.reason,
    voice_phrase_fallback: options.voicePhraseFallback || undefined,
    voice_phrase_metadata: options.voicePhraseMetadata,
  };
}

function voicePhraseMetadataFromGeneration(
  generation: Generation,
  utteranceSource: string,
): Record<string, unknown> {
  return {
    model: generation.model,
    prompt_template_id: generation.prompt_template_id,
    prompt_template_version: generation.prompt_template_version,
    token_count_input: generation.token_count_input,
    token_count_output: generation.token_count_output,
    cache_read_input_tokens: generation.cache_read_input_tokens,
    cache_creation_input_tokens: generation.cache_creation_input_tokens,
    cost_cents: generation.cost_cents,
    latency_ms: generation.latency_ms,
    cache_hit: generation.cache_hit,
    mocked: generation.mocked,
    source: utteranceSource,
    utterance_source: utteranceSource,
  };
}

function heuristicOperatorOutputCheck(input: {
  spokenAgentUtterance: string;
  steeringContext: Record<string, unknown>;
}) {
  const utterance = input.spokenAgentUtterance.trim();
  const lower = utterance.toLowerCase();
  const violations: OperatorOutputCheckViolation[] = [];
  const questionCount = (utterance.match(/\?/g) ?? []).length;
  if (questionCount > 1) {
    violations.push({
      type: "multiple_questions",
      severity: "medium",
      message: "The spoken response asked more than one question.",
    });
  }
  const wordCount = utterance.split(/\s+/).filter(Boolean).length;
  if (wordCount > 50) {
    violations.push({
      type: "too_verbose",
      severity: "low",
      message: "The spoken response exceeded the expected concise operator-interview length.",
    });
  }
  if (/\b(slot|schema|ranked intent|tool call|extraction|json)\b/i.test(utterance)) {
    violations.push({
      type: "internal_mechanics",
      severity: "high",
      message: "The spoken response exposed internal planning or extraction mechanics.",
    });
  }
  const doNotAsk = arrayOfStrings(input.steeringContext.do_not_ask);
  const staleQuestions = doNotAsk.filter((slotPath) =>
    slotPathQuestionTerms(slotPath).some((term) => lower.includes(term)),
  );
  for (const slotPath of staleQuestions.slice(0, 3)) {
    violations.push({
      type: "asked_do_not_ask",
      severity: "medium",
      message: `The spoken response may have re-asked covered or pending slot ${slotPath}.`,
    });
  }
  const reconciliationSignals = arrayOfStrings(
    input.steeringContext.live_reconciliation_signals,
  );
  if (
    reconciliationSignals.length > 0 &&
    !/(sop|screen|workaround|manual|expected|normal|different|contradict|saw|noticed)/i.test(
      utterance,
    )
  ) {
    violations.push({
      type: "contradicted_reconciliation",
      severity: "medium",
      message:
        "The spoken response ignored active live reconciliation signals that should steer the next question.",
    });
  }
  return {
    checker_status: "complete" as const,
    violations,
    checker_violation_count: violations.length,
    stale_question_count: staleQuestions.length,
  };
}

function normalizeOperatorOutputCheck(
  value: z.infer<typeof operatorOutputCheckSchema>,
  metadata: Generation,
): OperatorOutputCheckResult {
  const violations = value.violations ?? [];
  return {
    checker_status: value.checker_status ?? "complete",
    violations,
    checker_violation_count: value.checker_violation_count ?? violations.length,
    stale_question_count: value.stale_question_count ?? 0,
    metadata,
  };
}

function operatorCheckerFallbackMetadata(startedAt: Date): Generation {
  return {
    text: "",
    model: "deterministic-operator-output-checker",
    prompt_template_id: "operator.checker.output",
    prompt_template_version: "1",
    token_count_input: 0,
    token_count_output: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_cents: 0,
    latency_ms: Date.now() - startedAt.getTime(),
    cache_hit: false,
    mocked: true,
  };
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function slotPathQuestionTerms(slotPath: string) {
  return slotPath
    .split(/[._-]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 4);
}

export function deterministicOperatorTurnPlan(
  input: OperatorTurnInput & {
    currentPhase?: OperatorInterviewPhase;
    probeFiringSummaries?: Map<string, ProbeFiringSummary>;
    provisionallyAnsweredSlots?: string[];
  },
): OperatorTurnPlan {
  const stepText = firstActionSentence(input.latestUtterance);
  const title = stepText ? titleCase(trimText(stepText, 72)) : "Captured operator step";
  const rankedIntents = applySteeringIntentExclusions(
    rankedOperatorIntentCandidates(input.latestUtterance, Boolean(stepText)),
    {
      probeFiringSummaries: input.probeFiringSummaries,
      provisionallyAnsweredSlots: input.provisionallyAnsweredSlots,
    },
  );
  const intent = rankedIntents[0];
  const currentPhase = input.currentPhase ?? "orient";
  const proposedNextPhase = nextOperatorPhase({
    currentPhase,
    utteranceType: utteranceType(input.latestUtterance),
    intent,
    hasStep: Boolean(stepText),
  });
  return {
    utterance_type: utteranceType(input.latestUtterance),
    step_updates: stepText
      ? [
          {
            title,
            action_verb: firstVerb(stepText),
            action_object: trimText(stepText, 120),
            confidence: 0.68,
            evidence_ids: input.evidenceIds,
          },
        ]
      : [],
    slot_updates: stepText
      ? [
          {
            slot_path: "step.action_object",
            value: { text: stepText },
            status: "filled",
            confidence: 0.68,
            evidence_ids: input.evidenceIds,
          },
        ]
      : [],
    claims: [],
    tool_calls: [],
    contradiction_signals: contradictionSignals(input.latestUtterance),
    current_phase: currentPhase,
    proposed_next_phase: proposedNextPhase,
    phase_transition_ready: proposedNextPhase !== currentPhase,
    ranked_intents: rankedIntents,
    chosen_intent: intent,
    planned_agent_utterance: deterministicOperatorUtterance(intent),
  };
}

function rankedOperatorIntentCandidates(text: string, hasStep: boolean): OperatorIntent[] {
  const candidates: OperatorIntent[] = [];
  if (/exception|error|fail|reject|stuck|blocked|workaround|manual/i.test(text)) {
    candidates.push({
      intent: "capture_exception_or_workaround",
      target_slot: /workaround|manual/i.test(text)
        ? "step.workarounds"
        : "step.exceptions",
      score: 1000,
      reason: "The operator mentioned an exception or workaround.",
    });
  }
  if (/approve|decide|if |unless|when /i.test(text)) {
    candidates.push({
      intent: "capture_decision_rule",
      target_slot: "step.decision_criteria",
      score: 900,
      reason: "The operator described a branch or decision.",
    });
  }
  if (hasStep) {
    candidates.push({
      intent: "capture_next_step",
      target_slot: "step.action_object",
      score: 820,
      reason: "The operator described an executable step.",
    });
  }
  candidates.push({
    intent: "clarify_operator_step",
    target_slot: "step.action_object",
    score: 700,
    reason: "The last operator turn needs a concrete next step.",
  });
  return candidates;
}

function deterministicOperatorUtterance(intent: OperatorIntent) {
  if (intent.intent === "capture_exception_or_workaround") {
    return "When that happens, what do you do next to get the work unstuck?";
  }
  if (intent.intent === "capture_decision_rule") {
    return "What decides which path you take at that point?";
  }
  if (intent.intent === "capture_next_step") {
    return "What happens immediately after that step?";
  }
  return "Can you walk me through the next concrete step in the process?";
}

function utteranceType(text: string): OperatorTurnPlan["utterance_type"] {
  if (/don't know|not sure|no idea/i.test(text)) return "dont_know";
  if (/actually|correction|instead/i.test(text)) return "correction";
  if (/but the SOP|different from|contradict/i.test(text)) return "contradiction";
  if (text.trim().endsWith("?")) return "meta_question";
  return text.length < 24 ? "partial_answer" : "substantive_answer";
}

function operatorPhase(value: unknown): OperatorInterviewPhase {
  const parsed = operatorInterviewPhaseSchema.safeParse(value);
  return parsed.success ? parsed.data : "orient";
}

function nextOperatorPhase(input: {
  currentPhase: OperatorInterviewPhase;
  utteranceType: OperatorTurnPlan["utterance_type"];
  intent: OperatorIntent;
  hasStep: boolean;
}): OperatorInterviewPhase {
  if (isLowInfoOperatorTurn(input.utteranceType)) return input.currentPhase;
  if (input.currentPhase === "orient" && input.hasStep) return "happy_path";
  if (
    input.currentPhase === "happy_path" &&
    input.intent.intent === "capture_exception_or_workaround"
  ) {
    return "hard_case";
  }
  if (
    input.currentPhase === "hard_case" &&
    input.intent.intent === "capture_exception_or_workaround"
  ) {
    return "exception_sweep";
  }
  if (input.currentPhase === "exception_sweep" && input.hasStep) return "playback";
  return input.currentPhase;
}

function isLowInfoOperatorTurn(utteranceType: OperatorTurnPlan["utterance_type"]) {
  return ["dont_know", "meta_question", "off_topic"].includes(utteranceType);
}

function contradictionSignals(text: string) {
  return /sop|supposed to|actually|instead|different from/i.test(text)
    ? [text]
    : [];
}

function firstActionSentence(text: string) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .find((part) =>
      /\b(then|next|after|open|check|copy|paste|enter|submit|approve|review|send|download|upload|update|create|look|go|export|import)\b/i.test(part),
    );
}

function firstVerb(text: string) {
  return text.match(/\b(open|check|copy|paste|enter|submit|approve|review|send|download|upload|update|create|look|go|export|import)\b/i)?.[1]?.toLowerCase();
}

function trimText(text: string, max: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}...`;
}

function titleCase(text: string) {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values)];
}

export function voiceMetadataDegrades(
  metadata: { mocked?: unknown; utterance_source?: unknown } | undefined,
) {
  return (
    metadata?.mocked === true ||
    metadata?.utterance_source === "deterministic_phrase_fallback"
  );
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hash(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url").slice(0, 80);
}
