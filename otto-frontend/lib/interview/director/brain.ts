import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  agentDecisionLog,
  candidateProcesses,
  directorExtractionWindows,
  interviewState,
  probeFirings,
  slotStates,
} from "@/lib/db/schema";
import { StructuredOutputError, structured } from "@/lib/adapters/llm";
import { writeAgentDecisionInTransaction } from "@/lib/db/write-agent-decision";
import {
  directorSlotDefinitions,
  isCaptureLevelDirectorSlot,
  slotPriority,
  type DirectorSlotStatus,
} from "@/lib/interview/director/slot-schema";
import {
  probeConfigForIntent,
  probeLibrary,
} from "@/lib/interview/director/probe-library";
import {
  deterministicPhrase,
  limitToSingleQuestion,
  phraseDirectorTurnDetailed,
} from "@/lib/interview/director/voice";
import {
  createFollowUpTask,
  recordPainPoint,
  recordPerson,
  recordProcess,
  recordSpof,
  recordSystem,
  touchSlotAskedAt,
  updateSlotState,
  type DirectorToolContext,
} from "@/lib/interview/director/tools";
import {
  writeClaimInTransaction,
  type ClaimWriteTx,
} from "@/lib/db/write-claim";
import { stableStringify } from "@/lib/http/json";
import {
  directorTurnPlanSchema,
  type DirectorIntent,
  type DirectorInterviewPhase,
  type DirectorTurnPlan,
  type DirectorUtteranceType,
} from "@/lib/schemas/phase1";
import {
  ownershipRolesValue,
  processBoundaryValue,
} from "@/lib/interview/director/slot-values";
import {
  allowedDirectorClaimSubjects,
  validateDirectorPlanClaim,
} from "@/lib/interview/director/claim-allowlist";
import {
  directorClaimZodSchema,
  directorClaimsAnthropicSchema,
  readSharedSchemaArtifact,
} from "@/lib/interview/director/schema-artifacts";
import {
  assertDirectorCaptureAcceptsTurns,
  lockDirectorTurnSequence,
} from "@/lib/interview/director/turn-transaction";

export type DirectorTurnInput = DirectorToolContext & {
  latestUtterance: string;
  transcriptSegmentIds: string[];
  evidenceIds: string[];
  turnIndex: number;
};

export type DirectorTurnResult = {
  next_prompt: string;
  chosen_intent: DirectorIntent;
  ranked_intents: DirectorIntent[];
  utterance_type: DirectorUtteranceType;
  current_phase: DirectorInterviewPhase;
  proposed_next_phase: DirectorInterviewPhase;
  slot_updates: Array<{
    slot_path: string;
    status: DirectorSlotStatus;
    confidence: number;
    value?: unknown;
    evidence_ids: string[];
  }>;
  candidate_process_ids: string[];
  coverage_slots: DirectorCoverageSlot[];
  degraded_quality: boolean;
  degraded_reasons: string[];
  metadata: {
    model: string;
    token_count_input: number;
    token_count_output: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cost_cents: number;
    latency_ms: number;
    cache_hit: boolean;
  };
  decision_log_id?: string;
};

export type DirectorCoverageSlot = {
  slot_path: string;
  candidate_process_id?: string;
  label: string;
  priority: number;
  status: DirectorSlotStatus;
  confidence: number;
  evidence_count: number;
  last_asked_at: string | null;
  value: unknown;
};

export type DirectorModelMetadata = {
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
  source?: string;
  utterance_source?: string;
  llm_call_elided?: boolean;
  brain_model?: string;
  voice_phrase_fallback?: boolean;
  reason?: string;
};

type DirectorToolExecutionLog = {
  tool_index: number;
  tool_name: string;
  target_candidate_process_id?: string;
  status: "succeeded" | "failed";
  idempotency_key: string;
  latency_ms: number;
  error_message?: string;
};

export type DirectorTurnPlanResult = {
  plan: DirectorTurnPlan;
  degraded_quality: boolean;
  metadata: DirectorModelMetadata;
  degraded_reasons: string[];
  started_at: Date;
};

// Client-side mirror of the extraction tool schema. No `.passthrough()` —
// unknown keys are stripped so validation matches what the (strict) tool
// schema allows. Claims reuse the discriminated union generated from
// schemas/claim-subject-fields.json; `subject_id` stays permissive enough to
// carry a plain entity name instead of a UUID (dispatch resolves names).
const looseSlotExtractionSchema = z.object({
  slot_updates: z
    .array(
      z.object({
        slot_path: z.string().min(1),
        candidate_process_id: z.string().optional(),
        value: z.unknown().optional(),
        status: z.enum([
          "empty",
          "partial",
          "filled",
          "asked_unknown",
          "conflicting",
          "pending_re_extract",
        ]),
        confidence: z.number().min(0).max(1),
        evidence_ids: z.array(z.string()).default([]),
        last_asked_at: z.string().optional(),
        priority: z.number().int().min(0),
        candidates: z.array(z.unknown()).optional(),
      }),
    )
    .default([]),
  claims: z.array(directorClaimZodSchema()).default([]),
  tool_calls: z
    .array(
      z.object({
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()),
      }),
    )
    .default([]),
  contradiction_signals: z.array(z.string()).default([]),
});

type LooseSlotExtraction = z.infer<typeof looseSlotExtractionSchema>;

export type DirectorSteeringPlanResult = {
  plan: DirectorTurnPlan;
  current_slots: Map<string, { status: string; confidence: string | number | null }>;
  recent_turns: string[];
  coverage_summary: string;
  focus_process_name?: string;
  metadata: DirectorModelMetadata;
  started_at: Date;
  steering_context: {
    next_objective: string;
    target_slots: string[];
    do_not_ask: string[];
    forbidden_claims: string[];
    required_style: string;
    pending_extraction_turns: number[];
    pending_slot_paths: string[];
    pending_transcript_windows: number[];
    pending_steering_targets: string[];
    last_spoken_intent?: string;
    last_spoken_objective?: string;
    focus_candidate_process_id?: string;
  };
};

export type DirectorOutputCheckViolation = {
  type:
    | "asked_do_not_ask"
    | "unsupported_claim"
    | "ignored_next_objective"
    | "multiple_questions"
    | "too_verbose"
    | "contradicted_steering";
  severity: "low" | "medium" | "high";
  message: string;
};

export type DirectorOutputCheckResult = {
  checker_status: "complete" | "failed";
  violations: DirectorOutputCheckViolation[];
  checker_violation_count: number;
  stale_question_count: number;
  metadata: DirectorModelMetadata;
};

const directorOutputCheckSchema = z.object({
  checker_status: z.enum(["complete", "failed"]).default("complete"),
  violations: z.array(z.object({
    type: z.enum([
      "asked_do_not_ask",
      "unsupported_claim",
      "ignored_next_objective",
      "multiple_questions",
      "too_verbose",
      "contradicted_steering",
    ]),
    severity: z.enum(["low", "medium", "high"]),
    message: z.string().min(1),
  }).strict()).default([]),
  checker_violation_count: z.number().int().min(0).default(0),
  stale_question_count: z.number().int().min(0).default(0),
}).strict();

const directorOutputCheckAnthropicToolSchema = {
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
              "contradicted_steering",
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

export async function runDirectorTurn(
  input: DirectorTurnInput,
): Promise<DirectorTurnResult> {
  const planned = await extractDirectorTurn(input);
  const plannedUtterance = planned.plan.planned_agent_utterance ?? "";
  return dispatchDirectorTurnPlan({
    ...input,
    plan: planned.plan,
    plannedAgentUtterance: plannedUtterance,
    metadata: planned.metadata,
    voiceMetadata: {
      ...planned.metadata,
      utterance_source: "extraction_planned_utterance",
      llm_call_elided: true,
    },
    degradedQuality: planned.degraded_quality,
    degradedReasons: planned.degraded_reasons,
    startedAt: planned.started_at,
    deliveryStatus: "completed",
    deliveredAgentUtterance: plannedUtterance,
    spokenFraction: 1,
  });
}

export async function extractDirectorTurn(
  input: DirectorTurnInput,
): Promise<DirectorTurnPlanResult> {
  return planDirectorTurnWithExtractionPlanner(input, structured);
}

export async function buildDirectorSteeringPlan(
  input: DirectorTurnInput & {
    pendingExtractionTurns?: number[];
    pendingSlotPaths?: string[];
    lastSpokenIntent?: string;
  },
): Promise<DirectorSteeringPlanResult> {
  const started = new Date();
  const context: DirectorToolContext = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    captureSessionId: input.captureSessionId,
    userId: input.userId,
  };
  const statePromise = readInterviewState(context);
  const recentTurnsPromise = readRecentTurns(context);
  const candidateSummariesPromise = readCandidateSummaries(context);
  const state = await statePromise;
  const [currentSlots, recentTurns, candidateSummaries] = await Promise.all([
    readCurrentSlots(context, {
      candidateProcessId: state.focusCandidateProcessId,
    }),
    recentTurnsPromise,
    candidateSummariesPromise,
  ]);
  const plan = deterministicTurnPlan({
    latestUtterance: input.latestUtterance,
    evidenceIds: input.evidenceIds,
    currentSlots,
    currentPhase: state.currentPhase,
    candidateProcessNames: candidateSummaries.map((candidate) => candidate.proposedName),
    priorIntent: state.priorIntent,
    lowInfoTurnCount: state.lowInfoTurnCount,
    lastNewSlotTurnIndex: state.lastNewSlotTurnIndex,
    turnIndex: input.turnIndex,
  });
  const rankedIntents = plan.ranked_intents.length
    ? plan.ranked_intents
    : await rankProbeIntents(context, state.focusCandidateProcessId);
  const chosenIntent = plan.chosen_intent ?? rankedIntents[0];
  const normalizedPlan = {
    ...plan,
    chosen_intent: chosenIntent,
    ranked_intents: rankedIntents,
  };
  const filledSlots = Array.from(currentSlots.entries())
    .filter(([, slot]) => ["filled", "asked_unknown"].includes(slot.status))
    .map(([slotPath]) => slotPath);
  const targetSlots = [
    chosenIntent.target_slot,
    ...rankedIntents.slice(0, 3).map((intent) => intent.target_slot),
  ].filter((slotPath): slotPath is string => Boolean(slotPath));
  const focusProcessName =
    chosenIntent.target_process ?? candidateSummaries[0]?.proposedName;
  const metadata = fallbackMetadata("director.turn.steering", started);
  return {
    plan: normalizedPlan,
    current_slots: currentSlots,
    recent_turns: recentTurns,
    coverage_summary: summarizeCoverage(currentSlots),
    focus_process_name: focusProcessName,
    metadata: {
      ...metadata,
      model: "deterministic-steering",
      source: "deterministic_steering",
    },
    started_at: started,
    steering_context: {
      next_objective: chosenIntent.reason,
      target_slots: targetSlots,
      do_not_ask: uniqueStrings([
        ...filledSlots,
        ...(input.pendingSlotPaths ?? []),
      ]),
      forbidden_claims: [
        "Do not invent systems, owners, frequencies, risks, metrics, or process names.",
        "Do not claim Operations Notes are complete until extraction confirms them.",
      ],
      required_style:
        "Acknowledge briefly, ask one concrete follow-up, and keep the response under 45 words.",
      pending_extraction_turns: input.pendingExtractionTurns ?? [],
      pending_slot_paths: input.pendingSlotPaths ?? [],
      pending_transcript_windows: input.pendingExtractionTurns ?? [],
      pending_steering_targets: input.pendingSlotPaths ?? [],
      last_spoken_intent: input.lastSpokenIntent,
      last_spoken_objective: input.lastSpokenIntent,
      focus_candidate_process_id: state.focusCandidateProcessId,
    },
  };
}

export function nonAuthoritativeDirectorSteeringPlan(
  plan: DirectorTurnPlan,
): DirectorTurnPlan {
  return {
    ...plan,
    claims: [],
    slot_updates: [],
    tool_calls: [],
  };
}

export async function phraseDirectorSteeringTurn(
  input: DirectorSteeringPlanResult,
  options: {
    onTextDelta?: (delta: string, textSoFar: string) => void | Promise<void>;
  } = {},
) {
  return phraseDirectorTurnDetailed({
    plan: {
      ...input.plan,
      planned_agent_utterance: undefined,
    },
    recentTurns: [
      ...input.recent_turns,
      `Steering: ${JSON.stringify(input.steering_context)}`,
    ],
    coverageSummary: input.coverage_summary,
    focusProcessName: input.focus_process_name,
    forceSeparateVoiceLlm: true,
    onTextDelta: options.onTextDelta,
  });
}

async function planDirectorTurnWithExtractionPlanner(
  input: DirectorTurnInput,
  planner: typeof structured<LooseSlotExtraction>,
): Promise<DirectorTurnPlanResult> {
  const started = new Date();
  const context: DirectorToolContext = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    captureSessionId: input.captureSessionId,
    userId: input.userId,
  };
  const statePromise = readInterviewState(context);
  const recentTurnsPromise = readRecentTurns(context);
  const candidateSummariesPromise = readCandidateSummaries(context);
  const state = await statePromise;
  const [currentSlots, recentTurns, candidateSummaries] = await Promise.all([
    readCurrentSlots(context, {
      candidateProcessId: state.focusCandidateProcessId,
    }),
    recentTurnsPromise,
    candidateSummariesPromise,
  ]);
  const deterministicPlan = deterministicTurnPlan({
    latestUtterance: input.latestUtterance,
    evidenceIds: input.evidenceIds,
    currentSlots,
    currentPhase: state.currentPhase,
    candidateProcessNames: candidateSummaries.map((candidate) => candidate.proposedName),
    priorIntent: state.priorIntent,
    lowInfoTurnCount: state.lowInfoTurnCount,
    lastNewSlotTurnIndex: state.lastNewSlotTurnIndex,
    turnIndex: input.turnIndex,
  });
  const promptBlocks = buildExtractionPromptCacheBlocks({
    currentSlots,
    recentTurns,
    latestUtterance: input.latestUtterance,
    evidenceIds: input.evidenceIds,
    currentPhase: state.currentPhase,
    candidateProcesses: candidateSummaries,
  });
  let plan: DirectorTurnPlan = deterministicPlan;
  let degradedQuality = false;
  const degradedReasons: string[] = [];
  let llmResult:
    | Awaited<ReturnType<typeof structured<LooseSlotExtraction>>>
    | undefined;
  try {
    llmResult = await planner({
      prompt_template_id: "director.turn.extract",
      prompt_template_version: "1",
      schema_name: "slot-extraction",
      schema: looseSlotExtractionSchema,
      input: "",
      static_input: promptBlocks.staticBlock,
      dynamic_input: promptBlocks.dynamicBlock,
      anthropic_tool: {
        name: "emit_director_slot_extraction",
        description:
          "Emit only evidence-backed director interview extraction fields: slot updates, claims, tool calls, and contradiction signals. Do not plan speech or rank next intents.",
        input_schema: directorSlotExtractionAnthropicToolSchema(state.currentPhase),
        strict: true,
      },
      mock: deterministicSlotExtraction(deterministicPlan),
    });
    const extraction = normalizeSlotExtractionEvidence(llmResult.value, input.evidenceIds);
    plan = {
      ...deterministicPlan,
      slot_updates: extraction.slot_updates,
      claims: extraction.claims,
      tool_calls: extraction.tool_calls,
      contradiction_signals: extraction.contradiction_signals,
    };
    plan = materializeDirectorProcessInventory(plan);
    degradedQuality = llmResult.metadata.mocked;
    if (llmResult.metadata.mocked) {
      degradedReasons.push("llm_mocked");
    }
    plan = applyDeterministicFallbackForMockedResult(
      plan,
      deterministicPlan,
      llmResult.metadata,
    );
  } catch (error) {
    degradedQuality = true;
    degradedReasons.push(structuredExtractionFailureReason(error));
    plan = {
      ...deterministicPlan,
      utterance_type: "partial_answer",
      slot_updates: input.evidenceIds.map((evidenceId) => ({
        slot_path: "scope.boundaries",
        status: "pending_re_extract" as const,
        confidence: 0,
        evidence_ids: [evidenceId],
        priority: slotPriority("scope.boundaries"),
      })),
      claims: [],
      tool_calls: [],
      contradiction_signals: [
        error instanceof Error ? error.message : "structured_extraction_failed",
      ],
    };
  }

  plan = mergeDeterministicExtractions(plan, deterministicPlan);
  const metadata = llmResult?.metadata ?? fallbackMetadata("director.turn.extract", started);
  return {
    plan,
    degraded_quality: degradedQuality,
    degraded_reasons: uniqueStrings(degradedReasons),
    metadata,
    started_at: started,
  };
}

function structuredExtractionFailureReason(error: unknown) {
  if (
    error instanceof StructuredOutputError &&
    /truncated|max_tokens/i.test(error.message)
  ) {
    return "structured_extraction_truncated";
  }
  return "structured_extraction_failed";
}

export function applyDeterministicFallbackForMockedResult(
  plan: DirectorTurnPlan,
  deterministicPlan: DirectorTurnPlan,
  metadata: Pick<DirectorModelMetadata, "mocked">,
): DirectorTurnPlan {
  return metadata.mocked
    ? mergeDeterministicExtractions(plan, deterministicPlan)
    : plan;
}

export function materializeDirectorProcessInventory(
  plan: DirectorTurnPlan,
): DirectorTurnPlan {
  const materializedCandidates = directorProcessCandidatesFromPlan(plan);
  if (materializedCandidates.length === 0) return plan;

  const materializedNames = new Set(
    materializedCandidates.map((candidate) =>
      normalizeCandidateProcessName(candidate.name),
    ),
  );
  const retainedToolCalls = plan.tool_calls.filter((tool) => {
    if (!isProposedNameCandidateTool(tool)) return true;
    const processName = processNameFromProposedNameTool(tool);
    return !processName || !materializedNames.has(normalizeCandidateProcessName(processName));
  });
  const seenRecordProcesses = new Set(
    retainedToolCalls
      .filter((tool) => tool.name === "recordProcess")
      .map((tool) => normalizeCandidateProcessName(stringArg(tool.arguments.name) ?? "")),
  );
  const recordProcessTools = materializedCandidates
    .filter((candidate) => {
      const normalized = normalizeCandidateProcessName(candidate.name);
      if (seenRecordProcesses.has(normalized)) return false;
      seenRecordProcesses.add(normalized);
      return true;
    })
    .map((candidate) => ({
      name: "recordProcess",
      arguments: {
        name: candidate.name,
        confidence: candidate.confidence,
        ...(candidate.proposedFunction
          ? { proposedFunction: candidate.proposedFunction }
          : {}),
      },
    }));

  if (recordProcessTools.length === 0 && retainedToolCalls.length === plan.tool_calls.length) {
    return plan;
  }
  return {
    ...plan,
    tool_calls: [...recordProcessTools, ...retainedToolCalls],
  };
}

function directorProcessCandidatesFromPlan(plan: DirectorTurnPlan) {
  const proposedFunction = functionNameFromSlotUpdates(plan.slot_updates);
  const candidates: Array<{
    name: string;
    confidence: number;
    proposedFunction?: string;
  }> = [];
  const seen = new Set<string>();
  const addCandidate = (
    name: unknown,
    confidence: number,
    candidateFunction = proposedFunction,
  ) => {
    const processName = stringArg(name);
    if (!isPlausibleDirectorProcessName(processName)) return;
    const normalized = normalizeCandidateProcessName(processName);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({
      name: processName,
      confidence,
      proposedFunction: candidateFunction,
    });
  };

  for (const slotUpdate of plan.slot_updates) {
    if (slotUpdate.slot_path !== "process.inventory") continue;
    const confidence = numberArg(slotUpdate.confidence) ?? 0.74;
    for (const processName of processNamesFromInventoryValue(slotUpdate.value)) {
      addCandidate(processName, confidence);
    }
  }
  for (const tool of plan.tool_calls) {
    if (!isProposedNameCandidateTool(tool)) continue;
    const processName = processNameFromProposedNameTool(tool);
    addCandidate(processName, numberArg(tool.arguments.confidence) ?? 0.74);
  }

  return candidates;
}

function processNamesFromInventoryValue(value: unknown): string[] {
  if (typeof value === "string") return splitProcessList(value);
  if (Array.isArray(value)) return value.flatMap(processNamesFromInventoryValue);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const listValue =
    record.processes ??
    record.process_names ??
    record.workflows ??
    record.candidates ??
    record.items;
  if (listValue !== undefined) return processNamesFromInventoryValue(listValue);
  return [
    record.name,
    record.process,
    record.process_name,
    record.proposed_name,
  ].flatMap(processNamesFromInventoryValue);
}

function functionNameFromSlotUpdates(slotUpdates: DirectorTurnPlan["slot_updates"]) {
  const functionSlot = slotUpdates.find((slot) => slot.slot_path === "function.name");
  const value = functionSlot?.value;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      stringArg(record.name) ??
      stringArg(record.function) ??
      stringArg(record.function_name) ??
      stringArg(record.department)
    );
  }
  return undefined;
}

function isProposedNameCandidateTool(tool: DirectorTurnPlan["tool_calls"][number]) {
  return (
    tool.name === "recordCandidateProcessClaim" &&
    stringArg(tool.arguments.field)?.toLowerCase() === "proposed_name"
  );
}

function processNameFromProposedNameTool(
  tool: DirectorTurnPlan["tool_calls"][number],
) {
  const value = tool.arguments.value;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      stringArg(record.name) ??
      stringArg(record.process) ??
      stringArg(record.process_name) ??
      stringArg(record.proposed_name)
    );
  }
  return (
    stringArg(tool.arguments.targetProcess) ??
    stringArg(tool.arguments.name) ??
    stringArg(tool.arguments.text)
  );
}

export function mergeDeterministicExtractions(
  plan: DirectorTurnPlan,
  deterministicPlan: DirectorTurnPlan,
): DirectorTurnPlan {
  const deterministicEvidenceIds = new Set(
    deterministicPlan.slot_updates.flatMap((slot) => slot.evidence_ids),
  );
  const mergedSlotUpdates = [...plan.slot_updates];
  const seenSlots = new Set(mergedSlotUpdates.map((slot) => slot.slot_path));
  for (const slotUpdate of deterministicPlan.slot_updates) {
    const existingIndex = mergedSlotUpdates.findIndex(
      (candidate) => candidate.slot_path === slotUpdate.slot_path,
    );
    if (existingIndex >= 0) {
      const existing = mergedSlotUpdates[existingIndex];
      const hasInvalidEvidence = existing.evidence_ids.some(
        (evidenceId) => !deterministicEvidenceIds.has(evidenceId),
      );
      if (hasInvalidEvidence || shouldPreferDeterministicSlot(slotUpdate)) {
        mergedSlotUpdates[existingIndex] = slotUpdate;
      }
      continue;
    }
    if (!seenSlots.has(slotUpdate.slot_path)) {
      mergedSlotUpdates.push(slotUpdate);
      seenSlots.add(slotUpdate.slot_path);
    }
  }

  const mergedToolCalls = plan.tool_calls.filter(
    (toolCall) =>
      toolCall.name !== "recordProcess" ||
      isPlausibleDirectorProcessName(stringArg(toolCall.arguments.name)),
  );
  const seenToolCalls = new Set(mergedToolCalls.map(toolCallIdentity));
  for (const toolCall of deterministicPlan.tool_calls) {
    if (
      toolCall.name === "recordProcess" &&
      !isPlausibleDirectorProcessName(stringArg(toolCall.arguments.name))
    ) {
      continue;
    }
    const identity = toolCallIdentity(toolCall);
    if (!seenToolCalls.has(identity)) {
      mergedToolCalls.push(toolCall);
      seenToolCalls.add(identity);
    }
  }

  return {
    ...plan,
    slot_updates: mergedSlotUpdates,
    tool_calls: mergedToolCalls,
  };
}

function shouldPreferDeterministicSlot(
  slotUpdate: DirectorTurnPlan["slot_updates"][number],
) {
  if (
    slotUpdate.slot_path !== "scope.boundaries" &&
    slotUpdate.slot_path !== "ownership.roles"
  ) {
    return false;
  }
  if (slotUpdate.status !== "filled") return false;
  const value = slotUpdate.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (slotUpdate.slot_path === "scope.boundaries") {
    return Array.isArray(record.process_names) && record.process_names.length > 0;
  }
  return Array.isArray(record.roles) && record.roles.length > 0;
}

function deterministicSlotExtraction(plan: DirectorTurnPlan): LooseSlotExtraction {
  return {
    slot_updates: plan.slot_updates,
    claims: plan.claims,
    tool_calls: plan.tool_calls,
    contradiction_signals: plan.contradiction_signals,
  };
}

function normalizeSlotExtractionEvidence(
  extraction: LooseSlotExtraction,
  allowedEvidenceIds: string[],
): Pick<DirectorTurnPlan, "slot_updates" | "claims" | "tool_calls" | "contradiction_signals"> {
  const normalizedSlotUpdates: DirectorTurnPlan["slot_updates"] =
    extraction.slot_updates.map((slotUpdate) => ({
      slot_path: slotUpdate.slot_path,
      ...(slotUpdate.candidate_process_id
        ? { candidate_process_id: slotUpdate.candidate_process_id }
        : {}),
      ...(slotUpdate.value !== undefined ? { value: slotUpdate.value } : {}),
      status: slotUpdate.status,
      confidence: slotUpdate.confidence,
      evidence_ids: normalizeAssertionEvidenceIds(slotUpdate.evidence_ids, allowedEvidenceIds, {
        fallbackToCurrentTurn: true,
      }),
      ...(slotUpdate.last_asked_at ? { last_asked_at: slotUpdate.last_asked_at } : {}),
      priority: slotUpdate.priority,
      ...(slotUpdate.candidates ? { candidates: slotUpdate.candidates } : {}),
    }));
  const normalizedClaims: DirectorTurnPlan["claims"] = extraction.claims.map((claim) => ({
    subject_type: claim.subject_type,
    subject_id: claim.subject_id,
    field: claim.field,
    value: claim.value,
    confidence: claim.confidence,
    evidence_ids: normalizeAssertionEvidenceIds(claim.evidence_ids, allowedEvidenceIds, {
      fallbackToCurrentTurn: false,
    }),
    ...(claim.metadata ? { metadata: claim.metadata } : {}),
  }));
  const normalizedToolCalls: DirectorTurnPlan["tool_calls"] = extraction.tool_calls.map(
    (toolCall) => ({
      name: toolCall.name,
      arguments: toolCall.arguments,
    }),
  );
  return {
    slot_updates: normalizedSlotUpdates,
    claims: normalizedClaims,
    tool_calls: normalizedToolCalls,
    contradiction_signals: extraction.contradiction_signals,
  };
}

function normalizeAssertionEvidenceIds(
  evidenceIds: string[],
  allowedEvidenceIds: string[],
  options: { fallbackToCurrentTurn: boolean },
) {
  const allowed = new Set(allowedEvidenceIds);
  const valid = uniqueStrings(evidenceIds.filter((evidenceId) => allowed.has(evidenceId)));
  if (valid.length > 0) return valid;
  return options.fallbackToCurrentTurn && allowedEvidenceIds.length > 0
    ? [allowedEvidenceIds[0]]
    : [];
}

export async function phrasePlannedDirectorTurn(input: DirectorTurnInput & {
  plan: DirectorTurnPlan;
}) {
  const phrased = await phrasePlannedDirectorTurnDetailed(input);
  return phrased.utterance;
}

export async function phrasePlannedDirectorTurnDetailed(input: DirectorTurnInput & {
  plan: DirectorTurnPlan;
}) {
  const context: DirectorToolContext = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    captureSessionId: input.captureSessionId,
    userId: input.userId,
  };
  const state = await readInterviewState(context);
  const currentSlots = await readCurrentSlots(context, {
    candidateProcessId: state.focusCandidateProcessId,
  });
  const recentTurns = await readRecentTurns(context);
  const candidateSummaries = await readCandidateSummaries(context);
  const processToolName = input.plan.tool_calls
    .find((tool) => tool.name === "recordProcess")
    ?.arguments.name;
  const rankedIntents = input.plan.ranked_intents.length
    ? input.plan.ranked_intents
    : await rankProbeIntents(context, state.focusCandidateProcessId);
  const chosenIntent = input.plan.chosen_intent ?? rankedIntents[0];
  return phraseDirectorTurnDetailed({
    plan: { ...input.plan, ranked_intents: rankedIntents, chosen_intent: chosenIntent },
    recentTurns,
    coverageSummary: summarizeCoverage(currentSlots),
    focusProcessName:
      chosenIntent.target_process ??
      stringArg(processToolName) ??
      candidateSummaries[0]?.proposedName,
  });
}

export async function dispatchDirectorTurnPlan(
  input: DirectorTurnInput & {
    plan: DirectorTurnPlan;
    plannedAgentUtterance: string;
    metadata?: DirectorModelMetadata;
    voiceMetadata?: DirectorModelMetadata;
    degradedQuality?: boolean;
    degradedReasons?: string[];
    startedAt?: Date;
    deliveryStatus?: "pending" | "completed" | "truncated" | "failed_text_fallback";
    deliveredAgentUtterance?: string;
    spokenFraction?: number;
    localTurnCorrelationId?: string;
    decisionStageName?: string;
    advanceConversationState?: boolean;
    referenceFocusCandidateProcessId?: string;
    deliveryJsonOverrides?: Record<string, unknown>;
    tx?: ClaimWriteTx;
  },
): Promise<DirectorTurnResult> {
  const started = input.startedAt ?? new Date();
  const context: DirectorToolContext = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    captureSessionId: input.captureSessionId,
    userId: input.userId,
  };
  let plan = materializeDirectorProcessInventory(input.plan);
  let degradedQuality = Boolean(input.degradedQuality);
  const degradedReasons = new Set(input.degradedReasons ?? []);
  const stateBeforeDispatch = await readInterviewState(context);
  const evidencePreflight = preflightDirectorPlanEvidence(plan, input.evidenceIds);
  plan = evidencePreflight.plan;
  degradedQuality = degradedQuality || evidencePreflight.invalid.length > 0;
  if (evidencePreflight.invalid.length > 0) {
    degradedReasons.add("invalid_evidence_reference");
  }
  const rankedIntents = plan.ranked_intents.length
    ? plan.ranked_intents
    : await rankProbeIntents(context, stateBeforeDispatch.focusCandidateProcessId);
  const chosenIntent = plan.chosen_intent ?? rankedIntents[0];
  const nextPrompt = input.plannedAgentUtterance;
  const metadata =
    input.metadata ??
    fallbackMetadata("director.turn.plan", started);
  const claimPreflight = preflightDirectorPlanClaims(plan.claims);
  degradedQuality = degradedQuality || claimPreflight.invalid.length > 0;
  if (claimPreflight.invalid.length > 0) {
    degradedReasons.add("claim_validation_failed");
  }
  const advanceConversationState = input.advanceConversationState ?? true;

  const commit = async (tx: ClaimWriteTx) => {
    await setOrgContext(tx, context.orgId);
    await lockDirectorTurnSequence(context, tx);
    await assertDirectorCaptureAcceptsTurns(context, tx);
    const state = await readInterviewState(context, tx);
    const currentSlotsBeforeDispatch = await readCurrentSlots(
      context,
      { candidateProcessId: state.focusCandidateProcessId },
      tx,
    );
    const candidateProcessIds: string[] = [];
    const candidateProcessIdsByName = new Map<string, string>();
    const toolExecutionLog: DirectorToolExecutionLog[] = [];
    const runDirectorTool = async (
      toolIndex: number,
      toolName: string,
      toolArguments: Record<string, unknown>,
      targetCandidateId: string | undefined,
      run: () => Promise<unknown>,
    ) => {
      const toolStarted = Date.now();
      try {
        await run();
        toolExecutionLog.push(
          directorToolExecutionLogEntry({
            input,
            toolIndex,
            toolName,
            toolArguments,
            targetCandidateId,
            status: "succeeded",
            startedAtMs: toolStarted,
          }),
        );
      } catch (error) {
        toolExecutionLog.push(
          directorToolExecutionLogEntry({
            input,
            toolIndex,
            toolName,
            toolArguments,
            targetCandidateId,
            status: "failed",
            startedAtMs: toolStarted,
            error,
          }),
        );
        degradedQuality = true;
        degradedReasons.add("tool_write_failed");
        await createFollowUpTask(
          context,
          {
            taskType: "low_confidence_claim",
            title: `Review skipped director enrichment: ${toolName}`,
            description:
              error instanceof Error
                ? error.message
                : "Optional director enrichment could not be written automatically.",
            targetType: targetCandidateId ? "candidate_process" : "capture_session",
            targetId: targetCandidateId ?? input.captureSessionId,
            priority: 2,
            contextJson: {
              tool_name: toolName,
              arguments: toolArguments,
              evidence_ids: input.evidenceIds,
            },
          },
          { tx },
        );
      }
    };

    for (const invalidEvidence of evidencePreflight.invalid) {
      await createFollowUpTask(
        context,
        {
          taskType: "low_confidence_claim",
          title: `Review stale director evidence: ${invalidEvidence.target}`,
          description: invalidEvidence.reason,
          targetType: "capture_session",
          targetId: input.captureSessionId,
          priority: 2,
          contextJson: invalidEvidence,
        },
        { tx },
      );
    }

    for (const [toolIndex, processTool] of plan.tool_calls.entries()) {
      if (processTool.name !== "recordProcess") continue;
      const args = processTool.arguments;
      const processName = stringArg(args.name);
      if (!isPlausibleDirectorProcessName(processName)) {
        degradedQuality = true;
        degradedReasons.add("invalid_process_name");
        await createFollowUpTask(
          context,
          {
            taskType: "low_confidence_claim",
            title: "Review skipped director process candidate",
            description:
              "A proposed process name looked like step narration rather than a director-owned process.",
            targetType: "capture_session",
            targetId: input.captureSessionId,
            priority: 2,
            contextJson: {
              proposed_name: processName,
              evidence_ids: input.evidenceIds,
            },
          },
          { tx },
        );
        continue;
      }
      const toolStarted = Date.now();
      const candidate = await recordProcess(
        context,
        {
          name: normalizeProcessName(processName),
          proposedFunction: stringArg(args.proposedFunction),
          frequency: stringArg(args.frequency),
          complexityHint: stringArg(args.complexityHint),
          confidence: numberArg(args.confidence) ?? 0.74,
          evidenceIds: input.evidenceIds,
        },
        { tx },
      );
      toolExecutionLog.push(
        directorToolExecutionLogEntry({
          input,
          toolIndex,
          toolName: processTool.name,
          toolArguments: processTool.arguments,
          targetCandidateId: candidate.id,
          status: "succeeded",
          startedAtMs: toolStarted,
        }),
      );
      candidateProcessIds.push(candidate.id);
      candidateProcessIdsByName.set(
        normalizeCandidateProcessName(candidate.proposedName),
        candidate.id,
      );
    }
      const focusSelection = await selectActiveCandidateProcessId(context, {
        requestedFocusCandidateId: plan.focus_candidate_process_id,
        newCandidateProcessIds: candidateProcessIds,
        priorFocusCandidateProcessId:
          input.referenceFocusCandidateProcessId ?? state.focusCandidateProcessId,
        tx,
      });
    const activeCandidateId = focusSelection.activeCandidateId;
    if (focusSelection.rejectedFocusCandidateId) {
      degradedQuality = true;
      degradedReasons.add("invalid_focus_candidate");
      await createFollowUpTask(
        context,
        {
          taskType: "low_confidence_claim",
          title: "Review invalid director focus candidate",
          description:
            "The director planner selected a focus_candidate_process_id that does not belong to this capture session.",
          targetType: "capture_session",
          targetId: input.captureSessionId,
          priority: 2,
          contextJson: {
            rejected_focus_candidate_process_id:
              focusSelection.rejectedFocusCandidateId,
            fallback_focus_candidate_process_id: activeCandidateId,
          },
        },
        { tx },
      );
    }

    for (const tool of plan.tool_calls) {
      const toolCandidateId = await candidateProcessIdForTool(
        context,
        tool.arguments,
        activeCandidateId,
        candidateProcessIdsByName,
        tx,
      );
      if (tool.name === "recordSystem") {
        const systemName = stringArg(tool.arguments.name);
        if (systemName) {
          await runDirectorTool(
            plan.tool_calls.indexOf(tool),
            tool.name,
            tool.arguments,
            toolCandidateId,
            () =>
              recordSystem(
                context,
                {
                  name: systemName,
                  evidenceIds: input.evidenceIds,
                  candidateProcessId: toolCandidateId,
                },
                { tx },
              ),
          );
        }
      }
      if (tool.name === "recordPerson") {
        const personName = stringArg(tool.arguments.name);
        if (personName) {
          await runDirectorTool(
            plan.tool_calls.indexOf(tool),
            tool.name,
            tool.arguments,
            undefined,
            () =>
              recordPerson(
                context,
                {
                  name: personName,
                  title: stringArg(tool.arguments.title),
                  roleName: stringArg(tool.arguments.roleName),
                  evidenceIds: input.evidenceIds,
                },
                { tx },
              ),
          );
        }
      }
      if (toolCandidateId && tool.name === "recordPainPoint") {
        const text = stringArg(tool.arguments.text);
        if (text) {
          await runDirectorTool(
            plan.tool_calls.indexOf(tool),
            tool.name,
            tool.arguments,
            toolCandidateId,
            () =>
              recordPainPoint(
                context,
                {
                  candidateProcessId: toolCandidateId,
                  text,
                  evidenceIds: input.evidenceIds,
                },
                { tx },
              ),
          );
        }
      }
      if (toolCandidateId && tool.name === "recordSpof") {
        const text = stringArg(tool.arguments.text);
        if (text) {
          await runDirectorTool(
            plan.tool_calls.indexOf(tool),
            tool.name,
            tool.arguments,
            toolCandidateId,
            () =>
              recordSpof(
                context,
                {
                  candidateProcessId: toolCandidateId,
                  text,
                  evidenceIds: input.evidenceIds,
                },
                { tx },
              ),
          );
        }
      }
      if (toolCandidateId && tool.name === "recordCandidateProcessClaim") {
        await runDirectorTool(
          plan.tool_calls.indexOf(tool),
          tool.name,
          tool.arguments,
          toolCandidateId,
          () =>
            recordCandidateProcessClaimFromTool(
              context,
              toolCandidateId,
              tool.arguments,
              input.evidenceIds,
              tx,
            ),
        );
      }
      if (tool.name === "createFollowUpTask") {
        await runDirectorTool(
          plan.tool_calls.indexOf(tool),
          tool.name,
          tool.arguments,
          undefined,
          () =>
            createFollowUpTask(
              context,
              {
                taskType:
                  tool.arguments.taskType === "conflicting_slot" ||
                  tool.arguments.taskType === "low_confidence_claim"
                    ? tool.arguments.taskType
                    : "open_question",
                title: stringArg(tool.arguments.title) ?? "Review director interview follow-up",
                description: stringArg(tool.arguments.description),
                targetType: stringArg(tool.arguments.targetType),
                targetId: stringArg(tool.arguments.targetId),
                priority: numberArg(tool.arguments.priority) ?? 2,
                contextJson: {
                  source_tool_call: tool.arguments,
                  evidence_ids: input.evidenceIds,
                },
              },
              { tx },
            ),
        );
      }
    }

    const scopedSlotUpdates = await scopeSlotUpdatesToCandidateProcess(
      context,
      plan.slot_updates,
      activeCandidateId,
      tx,
    );
    plan = { ...plan, slot_updates: scopedSlotUpdates };

    for (const slotUpdate of scopedSlotUpdates) {
      await updateSlotState(
        context,
        {
          slotPath: slotUpdate.slot_path,
          candidateProcessId: slotUpdate.candidate_process_id,
          value: slotUpdate.value,
          status: slotUpdate.status,
          confidence: slotUpdate.confidence,
          evidenceIds: slotUpdate.evidence_ids,
          candidates: slotUpdate.candidates,
        },
        { tx },
      );
    }
    for (const invalidClaim of claimPreflight.invalid) {
      await createFollowUpTask(
        context,
        {
          taskType: "low_confidence_claim",
          title: `Review unsupported director claim: ${invalidClaim.claim.subject_type}.${invalidClaim.claim.field}`,
          description: invalidClaim.reason,
          targetType: invalidClaim.claim.subject_type,
          targetId: invalidClaim.claim.subject_id,
          priority: 2,
          contextJson: {
            field: invalidClaim.claim.field,
            value: invalidClaim.claim.value,
            evidence_ids: invalidClaim.claim.evidence_ids,
          },
        },
        { tx },
      );
    }
    const claimSubjectPreflight = await preflightDirectorPlanClaimSubjects(
      context,
      claimPreflight.valid,
      tx,
    );
    for (const invalidClaim of claimSubjectPreflight.invalid) {
      await createFollowUpTask(
        context,
        {
          taskType: "low_confidence_claim",
          title: `Review invalid director claim subject: ${invalidClaim.claim.subject_type}.${invalidClaim.claim.field}`,
          description: invalidClaim.reason,
          targetType: invalidClaim.claim.subject_type,
          targetId: invalidClaim.claim.subject_id,
          priority: 2,
          contextJson: {
            field: invalidClaim.claim.field,
            value: invalidClaim.claim.value,
            evidence_ids: invalidClaim.claim.evidence_ids,
          },
        },
        { tx },
      );
    }
    degradedQuality = degradedQuality || claimSubjectPreflight.invalid.length > 0;
    if (claimSubjectPreflight.invalid.length > 0) {
      degradedReasons.add("claim_subject_validation_failed");
    }
    const claimDispatch = await dispatchPlanClaims(
      context,
      claimSubjectPreflight.valid,
      tx,
    );
    degradedQuality = degradedQuality || claimDispatch.degraded;
    if (claimDispatch.degraded) degradedReasons.add("claim_dispatch_failed");

    if (degradedQuality) {
      if (degradedReasons.size === 0) {
        degradedReasons.add("unspecified_degraded_quality");
      }
      await createFollowUpTask(
        context,
        {
          taskType: "low_confidence_claim",
          title: "Re-extract degraded director turn",
          description:
            "The transcript was saved, but structured extraction failed and needs a retry.",
          targetType: "capture_session",
          targetId: input.captureSessionId,
          priority: 2,
        },
        { tx },
      );
    }

    if (advanceConversationState && chosenIntent.target_slot) {
      await touchSlotAskedAt(
        context,
        chosenIntent.target_slot,
        new Date(),
        { tx },
        candidateIdForSlot(chosenIntent.target_slot, activeCandidateId),
      );
    }
    if (advanceConversationState) {
      await writeInterviewState(
        context,
        {
          currentPhase: plan.proposed_next_phase,
          focusCandidateProcessId: activeCandidateId,
          priorIntent: chosenIntent.intent,
          lowInfoTurnCount: isLowInfoUtterance(plan.utterance_type)
            ? state.lowInfoTurnCount + 1
            : 0,
          lastNewSlotTurnIndex:
            hasMeaningfulNewSlotCoverage(
              currentSlotsBeforeDispatch,
              plan.slot_updates,
            )
              ? input.turnIndex
              : state.lastNewSlotTurnIndex,
          phaseHistory: appendPhaseHistory(state.phaseHistory, {
            turn_index: input.turnIndex,
            from: state.currentPhase,
            to: plan.proposed_next_phase,
            intent: chosenIntent.intent,
          }),
        },
        tx,
      );
      await recordProbeFiring(
        context,
        {
          probeId: chosenIntent.intent,
          targetSlot: isControllerExemptIntent(chosenIntent)
            ? undefined
            : chosenIntent.target_slot,
          targetCandidateProcessId: activeCandidateId,
          turnIndex: input.turnIndex,
          styleHint: chosenIntent.style_hint,
          resolvedStatusAfter:
            !isControllerExemptIntent(chosenIntent) && chosenIntent.target_slot
              ? await readResolvedSlotStatusAfterProbe(
                  context,
                  chosenIntent.target_slot,
                  candidateIdForSlot(chosenIntent.target_slot, activeCandidateId),
                  tx,
                )
            : undefined,
        },
        tx,
      );
    }

    const decisionLog = await writeAgentDecisionInTransaction(tx, {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      captureSessionId: input.captureSessionId,
      turnIndex: input.turnIndex,
      stageName: input.decisionStageName ?? "director.turn",
      tsStart: started,
      tsEnd: new Date(),
      transcriptSegmentIds: input.transcriptSegmentIds,
      slotUpdates: plan.slot_updates,
      rankedProbeIntents: rankedIntents,
      chosenIntent,
      sanitizedAgentUtterance: nextPrompt,
      deliveryJson: {
        planned_utterance: nextPrompt,
        delivered_utterance: input.deliveredAgentUtterance ?? null,
        delivery_status: input.deliveryStatus ?? "pending",
        spoken_fraction: input.spokenFraction ?? 0,
        brain_metadata: metadata,
        voice_metadata: input.voiceMetadata ?? null,
        local_turn_correlation_id: input.localTurnCorrelationId ?? null,
        ...input.deliveryJsonOverrides,
      },
      promptTemplateId: metadata.prompt_template_id,
      promptTemplateVersion: metadata.prompt_template_version,
      toolCalls: directorDecisionToolCalls(plan.tool_calls, toolExecutionLog),
      model: metadata.model,
      tokenCountInput: metadata.token_count_input,
      tokenCountOutput: metadata.token_count_output,
      costCents: metadata.cost_cents,
      latencyMs: metadata.latency_ms,
      cacheHit: metadata.cache_hit,
      degradedQuality,
      degradedReasons: [...degradedReasons],
    });

    const coverageSlots = await readCoverageSnapshot(context, tx, activeCandidateId);

    return {
      next_prompt: nextPrompt,
      chosen_intent: chosenIntent,
      ranked_intents: rankedIntents,
      utterance_type: plan.utterance_type,
      current_phase: plan.current_phase,
      proposed_next_phase: plan.proposed_next_phase,
      slot_updates: plan.slot_updates.map((slotUpdate) => ({
        slot_path: slotUpdate.slot_path,
        status: slotUpdate.status,
        confidence: slotUpdate.confidence,
        value: slotUpdate.value,
        evidence_ids: slotUpdate.evidence_ids,
      })),
      candidate_process_ids: candidateProcessIds,
      coverage_slots: coverageSlots,
      degraded_quality: degradedQuality,
      degraded_reasons: [...degradedReasons],
      metadata: {
        model: metadata.model,
        token_count_input: metadata.token_count_input,
        token_count_output: metadata.token_count_output,
        cache_read_input_tokens: metadata.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: metadata.cache_creation_input_tokens ?? 0,
        cost_cents: metadata.cost_cents,
        latency_ms: metadata.latency_ms,
        cache_hit: metadata.cache_hit,
      },
      decision_log_id: decisionLog.id,
    };
  };
  if (input.tx) return commit(input.tx);
  return getDb().transaction(commit);
}

export async function updateDirectorExtractionStatus(input: {
  context: DirectorToolContext;
  turnIndex: number;
  extractionStatus: "pending" | "complete" | "failed";
  extractionDecisionLogId?: string;
  extractionLatencyMs?: number;
  errorMessage?: string;
  localTurnCorrelationId?: string;
  extractionWindowId?: string;
  tx?: ClaimWriteTx;
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
  const update = (tx: ClaimWriteTx) =>
    tx
      .update(agentDecisionLog)
      .set({
        deliveryJson: sql`coalesce(${agentDecisionLog.deliveryJson}, '{}'::jsonb) || ${JSON.stringify(
          patch,
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentDecisionLog.captureSessionId, input.context.captureSessionId),
          eq(agentDecisionLog.turnIndex, input.turnIndex),
          eq(agentDecisionLog.stageName, "director.turn"),
        ),
      )
      .returning();
  if (input.tx) return update(input.tx);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.context.orgId);
    return update(tx);
  });
}

export async function upsertDirectorExtractionWindow(input: {
  context: DirectorToolContext;
  extractionWindowId: string;
  turnIndex: number;
  transcriptSegmentIds: string[];
  openedAt?: Date;
  closedAt?: Date;
  closedBy?: "assistant_spoke" | "silence" | "manual_end";
  status?: "pending" | "complete" | "failed";
  metadataJson?: Record<string, unknown>;
  tx?: ClaimWriteTx;
}) {
  const now = new Date();
  const upsert = async (tx: ClaimWriteTx) =>
    (
      await tx
        .insert(directorExtractionWindows)
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
          target: [directorExtractionWindows.extractionWindowId],
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

export async function checkDirectorSpokenOutput(input: {
  spokenAgentUtterance: string;
  steeringContext: Record<string, unknown>;
}): Promise<DirectorOutputCheckResult> {
  const started = new Date();
  const heuristic = heuristicDirectorOutputCheck(input);
  try {
    const result = await structured({
      prompt_template_id: "director.checker.output",
      prompt_template_version: "1",
      schema_name: "director-output-check",
      schema: directorOutputCheckSchema,
      static_input: [
        "You are checking one spoken Otto director-interview utterance after it was already delivered.",
        "Record your verdict with the emit_director_output_check tool. Do not rewrite the utterance.",
        "Flag unsupported factual claims, repeated/stale questions, ignored steering, multiple questions, verbosity, and steering contradictions.",
      ].join("\n"),
      dynamic_input: JSON.stringify(
        {
          spoken_agent_utterance: input.spokenAgentUtterance,
          steering_context: input.steeringContext,
        },
        null,
        2,
      ),
      input: "Return checker_status, violations, checker_violation_count, and stale_question_count.",
      anthropic_tool: {
        name: "emit_director_output_check",
        description:
          "Emit the post-hoc verdict for one delivered director-interview utterance: checker status, steering violations, and counts.",
        input_schema: directorOutputCheckAnthropicToolSchema as unknown as Record<string, unknown>,
        strict: true,
      },
      mock: heuristic,
    });
    return normalizeDirectorOutputCheck(result.value, result.metadata);
  } catch {
    return normalizeDirectorOutputCheck(
      {
        ...heuristic,
        checker_status: "failed",
      },
      fallbackMetadata("director.checker.output", started),
    );
  }
}

export async function recordDirectorOutputCheck(input: {
  context: DirectorToolContext;
  turnIndex: number;
  check: DirectorOutputCheckResult;
  localTurnCorrelationId?: string;
  extractionWindowId?: string;
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
    ...(input.extractionWindowId ? { extraction_window_id: input.extractionWindowId } : {}),
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
                  ? ["output_checker_failed"]
                  : ["output_checker_violation"],
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentDecisionLog.captureSessionId, input.context.captureSessionId),
          eq(agentDecisionLog.turnIndex, input.turnIndex),
          eq(agentDecisionLog.stageName, "director.turn"),
        ),
      )
      .returning();
    if (input.check.checker_status === "failed" || input.check.checker_violation_count > 0) {
      await createFollowUpTask(
        input.context,
        {
          taskType: "low_confidence_claim",
          title: "Review director spoken-output checker result",
          description:
            input.check.violations[0]?.message ??
            "The async spoken-output checker failed or found a steering violation.",
          targetType: "capture_session",
          targetId: input.context.captureSessionId,
          priority: 2,
          contextJson: patch,
        },
        { tx },
      );
    }
    return updated;
  });
}

function heuristicDirectorOutputCheck(input: {
  spokenAgentUtterance: string;
  steeringContext: Record<string, unknown>;
}) {
  const utterance = input.spokenAgentUtterance.trim();
  const lower = utterance.toLowerCase();
  const violations: DirectorOutputCheckViolation[] = [];
  const questionCount = (utterance.match(/\?/g) ?? []).length;
  if (questionCount > 1) {
    violations.push({
      type: "multiple_questions",
      severity: "medium",
      message: "The spoken response asked more than one question.",
    });
  }
  const wordCount = utterance.split(/\s+/).filter(Boolean).length;
  if (wordCount > 60) {
    violations.push({
      type: "too_verbose",
      severity: "low",
      message: "The spoken response exceeded the expected concise length.",
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
  return {
    checker_status: "complete" as const,
    violations,
    checker_violation_count: violations.length,
    stale_question_count: staleQuestions.length,
  };
}

function normalizeDirectorOutputCheck(
  value: z.infer<typeof directorOutputCheckSchema>,
  metadata: DirectorModelMetadata,
): DirectorOutputCheckResult {
  const violations = value.violations ?? [];
  return {
    checker_status: value.checker_status ?? "complete",
    violations,
    checker_violation_count: value.checker_violation_count ?? violations.length,
    stale_question_count: value.stale_question_count ?? 0,
    metadata,
  };
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function slotPathQuestionTerms(slotPath: string) {
  const tail = slotPath.split(".").at(-1) ?? slotPath;
  return uniqueStrings([
    tail.replaceAll("_", " ").toLowerCase(),
    ...tail.split(/[_\W]+/).map((part) => part.toLowerCase()).filter((part) => part.length > 3),
  ]);
}

function directorToolExecutionLogEntry(input: {
  input: DirectorTurnInput;
  toolIndex: number;
  toolName: string;
  toolArguments: Record<string, unknown>;
  targetCandidateId?: string;
  status: "succeeded" | "failed";
  startedAtMs: number;
  error?: unknown;
}): DirectorToolExecutionLog {
  const request = {
    capture_session_id: input.input.captureSessionId,
    turn_index: input.input.turnIndex,
    tool_index: input.toolIndex,
    tool_name: input.toolName,
    arguments: input.toolArguments,
    target_candidate_process_id: input.targetCandidateId,
    evidence_ids: input.input.evidenceIds,
  };
  return {
    tool_index: input.toolIndex,
    tool_name: input.toolName,
    target_candidate_process_id: input.targetCandidateId,
    status: input.status,
    idempotency_key: `director-tool:${hash(request)}`,
    latency_ms: Math.max(0, Date.now() - input.startedAtMs),
    ...(input.error
      ? {
          error_message:
            input.error instanceof Error
              ? input.error.message
              : "Director tool execution failed.",
        }
      : {}),
  };
}

function directorDecisionToolCalls(
  toolCalls: DirectorTurnPlan["tool_calls"],
  executions: DirectorToolExecutionLog[],
) {
  const executionsByIndex = new Map(executions.map((execution) => [execution.tool_index, execution]));
  return toolCalls.map((toolCall, index) => ({
    ...toolCall,
    execution: executionsByIndex.get(index) ?? {
      tool_index: index,
      tool_name: toolCall.name,
      status: "not_executed",
      idempotency_key: `director-tool:${hash({
        tool_index: index,
        tool_name: toolCall.name,
        arguments: toolCall.arguments,
      })}`,
      latency_ms: 0,
    },
  }));
}

async function readCoverageSnapshot(
  context: DirectorToolContext,
  tx: ClaimWriteTx,
  activeCandidateId?: string,
): Promise<DirectorCoverageSlot[]> {
  const rows = await tx
    .select()
    .from(slotStates)
    .where(
      and(
        eq(slotStates.orgId, context.orgId),
        eq(slotStates.workspaceId, context.workspaceId),
        eq(slotStates.captureSessionId, context.captureSessionId),
      ),
    );
  const byPath = new Map(
    rows
      .filter(
        (row) =>
          row.candidateProcessId === null ||
          (activeCandidateId && row.candidateProcessId === activeCandidateId),
      )
      .map((row) => [row.slotPath, row]),
  );
  return directorSlotDefinitions.map((definition) => {
    const row = byPath.get(definition.path);
    return {
      slot_path: definition.path,
      ...(row?.candidateProcessId ? { candidate_process_id: row.candidateProcessId } : {}),
      label: definition.label,
      priority: definition.priority,
      status: row?.status ?? "empty",
      confidence: Number(row?.confidence ?? 0),
      evidence_count: row?.evidenceIds.length ?? 0,
      last_asked_at: row?.lastAskedAt?.toISOString() ?? null,
      value: row?.value ?? null,
    };
  });
}

function fallbackMetadata(promptTemplateId: string, started: Date) {
  return {
    text: "",
    model: "structured-extraction-failed",
    prompt_template_id: promptTemplateId,
    prompt_template_version: "1",
    token_count_input: 0,
    token_count_output: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_cents: 0,
    latency_ms: Date.now() - started.getTime(),
    cache_hit: false,
    mocked: false,
  };
}

export function directorTurnPlanAnthropicToolSchema() {
  return constrainDirectorTurnPlanToolSchema(withRequiredAnthropicFields(
    inlineJsonSchemaRefs(readSharedSchemaArtifact("director-turn-plan.schema.json"), {
      "slot-state.schema.json": readSharedSchemaArtifact("slot-state.schema.json"),
      "claim.schema.json": readSharedSchemaArtifact("claim.schema.json"),
    }) as Record<string, unknown>,
    ["planned_agent_utterance"],
  ));
}

export function directorSlotExtractionAnthropicToolSchema(
  phase?: DirectorInterviewPhase,
) {
  const schema = constrainDirectorSlotExtractionToolSchema(withRequiredAnthropicFields(
    inlineJsonSchemaRefs(readSharedSchemaArtifact("slot-extraction.schema.json"), {
      "slot-state.schema.json": readSharedSchemaArtifact("slot-state.schema.json"),
      "claim.schema.json": readSharedSchemaArtifact("claim.schema.json"),
    }) as Record<string, unknown>,
    ["slot_updates", "claims", "tool_calls", "contradiction_signals"],
  ));
  // Replace the unconstrained claim.schema.json shape (string subject_type,
  // free-form value) with the phase-aware discriminated union generated from
  // schemas/claim-subject-fields.json.
  objectProperty(schema, "properties").claims = directorClaimsAnthropicSchema(phase);
  return schema;
}

function inlineJsonSchemaRefs(schema: unknown, refs: Record<string, unknown>): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => inlineJsonSchemaRefs(item, refs));
  }
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

const allowedDirectorIntentNames = [
  "orient_interview",
  "discover_function",
  "discover_processes",
  "select_process_to_expand",
  "define_process_boundary",
  "capture_outcome",
  "capture_owner_roles",
  "capture_systems",
  "quantify_frequency_volume",
  "capture_dependencies",
  "capture_handoffs",
  "capture_metrics",
  "capture_friction",
  "capture_risk_spof",
  "capture_variants",
  "capture_controls",
  "capture_exec_priority",
  "capture_priority",
  "capture_documentation",
  "reconcile_conflict",
  "clarify_previous_question",
  "playback_summary",
  "open_questions_closeout",
] as const;

function constrainDirectorTurnPlanToolSchema<T extends Record<string, unknown>>(schema: T): T {
  const properties = objectProperty(schema, "properties");
  constrainIntentSchema(objectProperty(properties, "chosen_intent"));
  const rankedIntents = objectProperty(properties, "ranked_intents");
  constrainIntentSchema(objectProperty(rankedIntents, "items"));
  const slotUpdates = objectProperty(properties, "slot_updates");
  const slotUpdate = objectProperty(slotUpdates, "items");
  const slotProperties = objectProperty(slotUpdate, "properties");
  const slotPath = objectProperty(slotProperties, "slot_path");
  slotPath.enum = directorSlotDefinitions.map((definition) => definition.path);
  return schema;
}

function constrainDirectorSlotExtractionToolSchema<T extends Record<string, unknown>>(schema: T): T {
  const properties = objectProperty(schema, "properties");
  const slotUpdates = objectProperty(properties, "slot_updates");
  const slotUpdate = objectProperty(slotUpdates, "items");
  const slotProperties = objectProperty(slotUpdate, "properties");
  const slotPath = objectProperty(slotProperties, "slot_path");
  slotPath.enum = directorSlotDefinitions.map((definition) => definition.path);
  return schema;
}

function constrainIntentSchema(schema: Record<string, unknown>) {
  const properties = objectProperty(schema, "properties");
  objectProperty(properties, "intent").enum = [...allowedDirectorIntentNames];
  objectProperty(properties, "target_slot").enum = directorSlotDefinitions.map(
    (definition) => definition.path,
  );
}

function objectProperty(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function preflightDirectorPlanClaims(claims: DirectorTurnPlan["claims"]) {
  const valid: DirectorTurnPlan["claims"] = [];
  const invalid: Array<{ claim: DirectorTurnPlan["claims"][number]; reason: string }> = [];
  for (const claim of claims) {
    const claimValidation = validateDirectorPlanClaim(claim);
    if (claimValidation.ok) {
      valid.push(claim);
    } else {
      invalid.push({ claim, reason: claimValidation.reason });
    }
  }
  return { valid, invalid };
}

export function preflightDirectorPlanEvidence(
  plan: DirectorTurnPlan,
  currentEvidenceIds: string[],
): {
  plan: DirectorTurnPlan;
  invalid: DirectorPlanEvidenceFailure[];
} {
  const allowed = new Set(currentEvidenceIds);
  const invalid: DirectorPlanEvidenceFailure[] = [];
  const validSlotUpdates = plan.slot_updates.filter((slotUpdate) => {
    const reason = evidenceDisciplineFailure(slotUpdate.evidence_ids, allowed);
    if (!reason) return true;
    invalid.push({
      kind: "slot_update",
      target: slotUpdate.slot_path,
      slot_path: slotUpdate.slot_path,
      evidence_ids: slotUpdate.evidence_ids,
      reason,
    });
    return false;
  });
  const validClaims = plan.claims.filter((claim) => {
    const reason = evidenceDisciplineFailure(claim.evidence_ids, allowed);
    if (!reason) return true;
    invalid.push({
      kind: "claim",
      target: `${claim.subject_type}.${claim.field}`,
      claim,
      evidence_ids: claim.evidence_ids,
      reason,
    });
    return false;
  });
  return {
    plan: {
      ...plan,
      slot_updates: validSlotUpdates,
      claims: validClaims,
    },
    invalid,
  };
}

type DirectorPlanEvidenceFailure =
  | {
      kind: "slot_update";
      target: string;
      slot_path: string;
      evidence_ids: string[];
      reason: string;
    }
  | {
      kind: "claim";
      target: string;
      claim: DirectorTurnPlan["claims"][number];
      evidence_ids: string[];
      reason: string;
    };

function evidenceDisciplineFailure(evidenceIds: string[], allowed: Set<string>) {
  if (evidenceIds.length === 0) {
    return "Director assertions must cite evidence ids from the current turn.";
  }
  const staleEvidence = evidenceIds.filter((evidenceId) => !allowed.has(evidenceId));
  if (staleEvidence.length > 0) {
    return `Director assertion cited evidence outside the current turn: ${staleEvidence.join(", ")}.`;
  }
  return null;
}

export function buildPromptCacheBlocks(input: {
  currentSlots: Map<string, { status: string; confidence: string | number | null }>;
  recentTurns: string[];
  latestUtterance: string;
  evidenceIds?: string[];
  currentPhase?: DirectorInterviewPhase;
  lowInfoTurnCount?: number;
  lastNewSlotTurnIndex?: number | null;
  candidateProcesses?: CandidateSummary[];
  candidateProcessNames?: string[];
}) {
  const candidateProcessLines =
    input.candidateProcesses?.length
      ? input.candidateProcesses.map(
          (candidate) => `- ${candidate.id}: ${candidate.proposedName}`,
        )
      : [(input.candidateProcessNames ?? []).join(", ") || "none"];
  return {
    staticBlock: [
      "You are the Otto Director Interview Agent.",
      "Classify the director's utterance, extract only evidence-backed director-layer process inventory facts, choose the next interview phase, and choose one next intent.",
      "Voice persona: warm but efficient operations consultant. Do not sound like a survey. Acknowledge briefly, then ask one targeted question. Keep the spoken line short and concrete.",
      "For live latency, choose chosen_intent and planned_agent_utterance first, then emit the bookkeeping fields.",
      "Probe library:",
      ...probeLibrary.map(
        (probe) => `- ${probe.probeId}: ${probe.targetSlot}: ${probe.phrasing}`,
      ),
      "Slot schema:",
      ...directorSlotDefinitions.map(
        (slot) => `- ${slot.path}: priority ${slot.priority}`,
      ),
      directorExtractionStaticContract,
    ].join("\n"),
    dynamicBlock: [
      `Current phase: ${input.currentPhase ?? "orient"}`,
      `Low-information turn count: ${input.lowInfoTurnCount ?? 0}`,
      `Last new slot turn index: ${input.lastNewSlotTurnIndex ?? "none"}`,
      "Known candidate processes:",
      ...candidateProcessLines,
      "Current slot state:",
      ...Array.from(input.currentSlots.entries()).map(
        ([slotPath, slot]) => `- ${slotPath}: ${slot.status} (${slot.confidence ?? 0})`,
      ),
      "Recent turns:",
      ...input.recentTurns.slice(-4).map((turn) => `- ${turn}`),
      "Current allowed evidence_ids:",
      ...(input.evidenceIds?.length
        ? input.evidenceIds.map((evidenceId) => `- ${evidenceId}`)
        : ["- none"]),
      `Latest utterance: ${input.latestUtterance}`,
    ].join("\n"),
  };
}

function buildExtractionPromptCacheBlocks(input: {
  currentSlots: Map<string, { status: string; confidence: string | number | null }>;
  recentTurns: string[];
  latestUtterance: string;
  evidenceIds: string[];
  currentPhase?: DirectorInterviewPhase;
  candidateProcesses?: CandidateSummary[];
}) {
  const candidateProcessLines =
    input.candidateProcesses?.length
      ? input.candidateProcesses.map(
          (candidate) => `- ${candidate.id}: ${candidate.proposedName}`,
        )
      : ["none"];
  return {
    staticBlock: [
      "You are the Otto Director Interview structured extractor.",
      "Extract only evidence-backed director-layer process inventory facts from the latest utterance and recent context.",
      "Do not write the next assistant utterance. Do not rank next intents. Do not plan interview phase transitions.",
      "Slot schema:",
      ...directorSlotDefinitions.map(
        (slot) => `- ${slot.path}: priority ${slot.priority}`,
      ),
      directorSlotExtractionStaticContract,
    ].join("\n"),
    dynamicBlock: [
      `Current phase for context only: ${input.currentPhase ?? "orient"}`,
      "Known candidate processes:",
      ...candidateProcessLines,
      "Current slot state:",
      ...Array.from(input.currentSlots.entries()).map(
        ([slotPath, slot]) => `- ${slotPath}: ${slot.status} (${slot.confidence ?? 0})`,
      ),
      "Recent turns:",
      ...input.recentTurns.slice(-4).map((turn) => `- ${turn}`),
      "Current allowed evidence_ids:",
      ...(input.evidenceIds.length
        ? input.evidenceIds.map((evidenceId) => `- ${evidenceId}`)
        : ["- none"]),
      `Latest utterance: ${input.latestUtterance}`,
    ].join("\n"),
  };
}

const directorExtractionStaticContract = `
Structured output contract:
Return JSON matching director-turn-plan:
- utterance_type: greeting, meta_question, clarification_request, substantive_answer, partial_answer, non_answer, dont_know, correction, contradiction, or off_topic.
- current_phase and proposed_next_phase: orient, inventory, expand, enrich, or closeout.
- phase_transition_ready: boolean.
- ranked_intents[] and chosen_intent with intent, optional target_slot, optional target_process, score, reason, and optional style_hint.
- slot_updates, claims, tool_calls, contradiction_signals.
- planned_agent_utterance: exact next thing Otto should say aloud; concise, natural, and at most one question.
slot_updates[] fields:
- slot_path: one of the declared director slot paths.
- value: compact JSON object containing only evidence-backed values.
- status: empty, partial, filled, asked_unknown, conflicting, or pending_re_extract.
- confidence: number from 0 to 1.
- evidence_ids: UUID array supplied by the caller.
- priority: integer matching the slot definition.
claims[] fields:
- subject_type, subject_id, field, value, confidence, evidence_ids, metadata.
tool_calls[] fields:
- name: recordProcess, recordSystem, recordPerson, recordPainPoint, recordSpof, recordCandidateProcessClaim, updateSlotState, createFollowUpTask.
- arguments: JSON object matching the tool name.
- Use recordProcess whenever the director names candidate processes in process.inventory. Do not represent new process names as recordCandidateProcessClaim(proposed_name).
- Use recordCandidateProcessClaim only for long-tail facts about a process that already has a known candidate_process id or targetProcess name; include targetProcess, field, value, and optional confidence.
- Never invent candidate_process ids, process ids, or evidence ids. Never use an evidence id as a claim subject_id.
Allowed claim fields:
- These are loaded from schemas/claim-subject-fields.json:
${allowedDirectorClaimSubjects()
  .map((subject) => `  - ${subject.subject_type}: ${subject.fields.join(", ")}`)
  .join("\n")}
Evidence discipline:
- Every extracted assertion must cite evidence_ids from the current turn.
- If a statement is implied but not directly said, set confidence <= 0.45 and mark metadata.inferred = true.
- Do not invent process names, system names, people, volumes, KPIs, or risks.
- Preserve original terminology from the director unless normalizing obvious capitalization.
- If a turn contradicts prior slot state, mark the slot conflicting and include contradiction_signals.
Conversation-flow discipline:
- The latest answer does not need to satisfy the chosen intent and does not need a slot update.
- Extract useful off-intent facts when directly evidenced, and return empty arrays when the turn has no new facts.
- Do not force a claim or slot update just to prove the asked question was answered.
Probe-ranking guidance:
- Start with orient_interview/discover_function until the director's remit is known.
- Then discover_processes to build the high-level inventory before drilling into one process.
- Then select_process_to_expand, define_process_boundary, capture_outcome, capture_owner_roles, capture_systems, quantify_frequency_volume, capture_metrics, capture_dependencies, capture_friction, and capture_risk_spof as coverage warrants.
- Prefer empty must-fire slots, then conflicting/pending_re_extract slots, then partial high-priority slots.
- Ask only one concise next question.
Tool guidance:
- recordProcess when the director names a workflow, process, operating cadence, or process boundary.
- recordSystem when a named application, spreadsheet, data store, or shadow tool is mentioned.
- recordPerson when a named person or clearly attributable role appears.
- recordPainPoint for manual cleanup, delays, rework, unclear ownership, bottlenecks, exception handling, or duplicate entry.
- recordSpof for one-person dependency, fragile workaround, tribal knowledge, or unrecoverable absence risk.
Quality gates:
- Prefer fewer high-confidence writes over broad weak extraction.
- Keep values small and structured; long transcript quotes belong in evidence, not slot values.
- If extraction fails or no valid JSON is possible, return empty arrays rather than prose.
`.repeat(4);

const directorSlotExtractionStaticContract = `
Structured output contract:
Return JSON matching slot-extraction:
- slot_updates, claims, tool_calls, contradiction_signals.
- Do not include planned_agent_utterance, ranked_intents, chosen_intent, current_phase, proposed_next_phase, or phase_transition_ready.
slot_updates[] fields:
- slot_path: one of the declared director slot paths.
- value: compact JSON object containing only evidence-backed values.
- status: empty, partial, filled, asked_unknown, conflicting, or pending_re_extract.
- confidence: number from 0 to 1.
- evidence_ids: cite only UUIDs listed under "Current allowed evidence_ids".
- priority: integer matching the slot definition.
claims[] fields:
- subject_type, subject_id, field, value, confidence, evidence_ids, metadata.
tool_calls[] fields:
- name: recordProcess, recordSystem, recordPerson, recordPainPoint, recordSpof, recordCandidateProcessClaim, updateSlotState, createFollowUpTask.
- arguments: JSON object matching the tool name.
- Use recordProcess whenever the director names candidate processes in process.inventory. Do not represent new process names as recordCandidateProcessClaim(proposed_name).
- Use recordCandidateProcessClaim only for long-tail facts about a process that already has a known candidate_process id or targetProcess name; include targetProcess, field, value, and optional confidence.
- Never invent candidate_process ids, process ids, or evidence ids. Never use an evidence id as a claim subject_id.
Allowed claim fields:
${allowedDirectorClaimSubjects()
  .map((subject) => `  - ${subject.subject_type}: ${subject.fields.join(", ")}`)
  .join("\n")}
Evidence discipline:
- Every extracted assertion must cite evidence_ids from the current allowed evidence_ids list.
- Never invent evidence ids. If no listed evidence id supports a fact, omit that fact.
- If a statement is implied but not directly said, set confidence <= 0.45 and mark metadata.inferred = true.
- Do not invent process names, system names, people, volumes, KPIs, or risks.
- Preserve original terminology from the director unless normalizing obvious capitalization.
- If a turn contradicts prior slot state, mark the slot conflicting and include contradiction_signals.
Conversation-flow discipline:
- The latest answer does not need to satisfy the chosen intent and does not need a slot update.
- Extract useful off-intent facts when directly evidenced, and return empty arrays when the turn has no new facts.
- Do not force a claim or slot update just to prove the asked question was answered.
Quality gates:
- Prefer fewer high-confidence writes over broad weak extraction.
- Keep values small and structured; long transcript quotes belong in evidence, not slot values.
- If extraction fails or no valid JSON is possible, return empty arrays rather than prose.
`.repeat(2);

async function readCurrentSlots(
  context: DirectorToolContext,
  optionsOrTx?: { candidateProcessId?: string } | ClaimWriteTx,
  maybeTx?: ClaimWriteTx,
) {
  const hasOptions = isReadCurrentSlotOptions(optionsOrTx);
  const candidateProcessId =
    hasOptions ? optionsOrTx.candidateProcessId : undefined;
  const tx = hasOptions ? maybeTx : optionsOrTx;
  const read = async (activeTx: ClaimWriteTx) =>
    (
      await activeTx.execute<{
        id: string;
        slotPath: string;
        value: unknown;
        status: DirectorSlotStatus;
        confidence: string | number | null;
        evidenceIds: string[];
        lastAskedAt: Date | null;
        priority: number;
        candidates: unknown;
        candidateProcessId: string | null;
      }>(sql`
        SELECT
          id,
          slot_path AS "slotPath",
          value,
          status::text AS status,
          confidence,
          evidence_ids AS "evidenceIds",
          last_asked_at AS "lastAskedAt",
          priority,
          candidates,
          candidate_process_id AS "candidateProcessId"
        FROM slot_states
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND capture_session_id = ${context.captureSessionId}
          AND (
            candidate_process_id IS NULL
            OR (${candidateProcessId ?? null}::uuid IS NOT NULL
              AND candidate_process_id = ${candidateProcessId ?? null}::uuid)
          )
        ORDER BY candidate_process_id NULLS FIRST
      `)
    ).rows;
  if (tx) {
    return new Map((await read(tx)).map((row) => [row.slotPath, row]));
  }
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    return read(tx);
  });
  return new Map(rows.map((row) => [row.slotPath, row]));
}

function isReadCurrentSlotOptions(
  value: { candidateProcessId?: string } | ClaimWriteTx | undefined,
): value is { candidateProcessId?: string } {
  return Boolean(value && "candidateProcessId" in value);
}

async function readRecentTurns(context: DirectorToolContext) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    return (
      await tx.execute<{ text: string }>(sql`
        WITH recent_events AS (
          SELECT
            created_at,
            'Director: ' || text AS text
          FROM transcript_segments
          WHERE org_id = ${context.orgId}
            AND workspace_id = ${context.workspaceId}
            AND capture_session_id = ${context.captureSessionId}
            AND speaker_role = 'director'
          UNION ALL
          SELECT
            coalesce(ts_start, created_at) AS created_at,
            'Otto: ' || (
              CASE
                WHEN delivery_json->>'delivery_status' = 'pending' THEN NULL
                WHEN delivery_json->>'delivery_status' = 'truncated'
                  THEN nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), '')
                WHEN delivery_json->>'delivery_status' IN ('completed', 'failed_text_fallback')
                  THEN coalesce(
                    nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), ''),
                    nullif(trim(coalesce(delivery_json->>'planned_utterance', '')), ''),
                    nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                  )
                WHEN delivery_json->>'delivery_status' IS NULL
                  THEN nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                ELSE coalesce(
                  nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), ''),
                  nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                )
              END
            ) AS text
          FROM agent_decision_log
          WHERE org_id = ${context.orgId}
            AND workspace_id = ${context.workspaceId}
            AND capture_session_id = ${context.captureSessionId}
            AND stage_name IN (
              'director.opening',
              'director.notice.asr_stall',
              'director.turn'
            )
            AND (
              CASE
                WHEN delivery_json->>'delivery_status' = 'pending' THEN NULL
                WHEN delivery_json->>'delivery_status' = 'truncated'
                  THEN nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), '')
                WHEN delivery_json->>'delivery_status' IN ('completed', 'failed_text_fallback')
                  THEN coalesce(
                    nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), ''),
                    nullif(trim(coalesce(delivery_json->>'planned_utterance', '')), ''),
                    nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                  )
                WHEN delivery_json->>'delivery_status' IS NULL
                  THEN nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                ELSE coalesce(
                  nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), ''),
                  nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                )
              END
            ) IS NOT NULL
        )
        SELECT text
        FROM recent_events
        ORDER BY created_at DESC
        LIMIT 8
      `)
    ).rows;
  });
  return rows.map((row) => row.text).reverse();
}

async function latestCandidateProcessId(
  context: DirectorToolContext,
  tx?: ClaimWriteTx,
) {
  const read = (activeTx: ClaimWriteTx) =>
    activeTx
      .select({ id: candidateProcesses.id })
      .from(candidateProcesses)
      .where(
        and(
          eq(candidateProcesses.orgId, context.orgId),
          eq(candidateProcesses.workspaceId, context.workspaceId),
          eq(candidateProcesses.captureSessionId, context.captureSessionId),
          eq(candidateProcesses.status, "pending"),
        ),
      )
      .orderBy(desc(candidateProcesses.createdAt))
      .limit(1);
  const rows = tx
    ? await read(tx)
    : await getDb().transaction(async (activeTx) => {
        await setOrgContext(activeTx, context.orgId);
        return read(activeTx);
  });
  return rows[0]?.id;
}

async function selectActiveCandidateProcessId(
  context: DirectorToolContext,
  input: {
    requestedFocusCandidateId?: string;
    newCandidateProcessIds: string[];
    priorFocusCandidateProcessId?: string;
    tx: ClaimWriteTx;
  },
) {
  let rejectedFocusCandidateId: string | undefined;
  if (input.requestedFocusCandidateId) {
    if (
      input.newCandidateProcessIds.includes(input.requestedFocusCandidateId) ||
      (await candidateProcessBelongsToSession(
        context,
        input.requestedFocusCandidateId,
        input.tx,
      ))
    ) {
      return {
        activeCandidateId: input.requestedFocusCandidateId,
        rejectedFocusCandidateId,
      };
    }
    rejectedFocusCandidateId = input.requestedFocusCandidateId;
  }

  if (input.newCandidateProcessIds[0]) {
    return {
      activeCandidateId: input.newCandidateProcessIds[0],
      rejectedFocusCandidateId,
    };
  }

  if (
    input.priorFocusCandidateProcessId &&
    (await candidateProcessBelongsToSession(
      context,
      input.priorFocusCandidateProcessId,
      input.tx,
    ))
  ) {
    if (
      !(await candidateHasCoreProcessCoverage(
        context,
        input.priorFocusCandidateProcessId,
        input.tx,
      ))
    ) {
      return {
        activeCandidateId: input.priorFocusCandidateProcessId,
        rejectedFocusCandidateId,
      };
    }
    const nextCandidateId = await nextCandidateProcessNeedingCoreCoverage(
      context,
      input.tx,
      input.priorFocusCandidateProcessId,
    );
    if (nextCandidateId) {
      return {
        activeCandidateId: nextCandidateId,
        rejectedFocusCandidateId,
      };
    }
  }

  return {
    activeCandidateId: await latestCandidateProcessId(context, input.tx),
    rejectedFocusCandidateId,
  };
}

async function candidateHasCoreProcessCoverage(
  context: DirectorToolContext,
  candidateProcessId: string,
  tx: ClaimWriteTx,
) {
  const rows = await tx.execute<{ covered: number }>(sql`
    SELECT count(DISTINCT slot_path)::int AS covered
    FROM slot_states
    WHERE org_id = ${context.orgId}
      AND workspace_id = ${context.workspaceId}
      AND capture_session_id = ${context.captureSessionId}
      AND candidate_process_id = ${candidateProcessId}
      AND slot_path IN (
        'scope.boundaries',
        'ownership.roles',
        'systems.systems_of_record'
      )
      AND status IN ('filled', 'asked_unknown')
  `);
  return Number(rows.rows[0]?.covered ?? 0) >= 3;
}

async function nextCandidateProcessNeedingCoreCoverage(
  context: DirectorToolContext,
  tx: ClaimWriteTx,
  excludeCandidateProcessId?: string,
) {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT c.id
    FROM candidate_processes c
    WHERE c.org_id = ${context.orgId}
      AND c.workspace_id = ${context.workspaceId}
      AND c.capture_session_id = ${context.captureSessionId}
      AND c.status = 'pending'
      AND (${excludeCandidateProcessId ?? null}::uuid IS NULL OR c.id <> ${excludeCandidateProcessId ?? null}::uuid)
      AND (
        SELECT count(DISTINCT s.slot_path)::int
        FROM slot_states s
        WHERE s.org_id = c.org_id
          AND s.workspace_id = c.workspace_id
          AND s.capture_session_id = c.capture_session_id
          AND s.candidate_process_id = c.id
          AND s.slot_path IN (
            'scope.boundaries',
            'ownership.roles',
            'systems.systems_of_record'
          )
          AND s.status IN ('filled', 'asked_unknown')
      ) < 3
    ORDER BY c.created_at ASC
    LIMIT 1
  `);
  return rows.rows[0]?.id;
}

async function candidateProcessBelongsToSession(
  context: DirectorToolContext,
  candidateProcessId: string,
  tx: ClaimWriteTx,
) {
  const rows = await tx
    .select({ id: candidateProcesses.id })
    .from(candidateProcesses)
    .where(
      and(
        eq(candidateProcesses.id, candidateProcessId),
        eq(candidateProcesses.orgId, context.orgId),
        eq(candidateProcesses.workspaceId, context.workspaceId),
        eq(candidateProcesses.captureSessionId, context.captureSessionId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function scopeSlotUpdatesToCandidateProcess(
  context: DirectorToolContext,
  slotUpdates: DirectorTurnPlan["slot_updates"],
  activeCandidateId: string | undefined,
  tx: ClaimWriteTx,
) {
  const scoped: DirectorTurnPlan["slot_updates"] = [];
  for (const slotUpdate of slotUpdates) {
    const requestedCandidateId =
      slotUpdate.candidate_process_id ??
      candidateIdForSlot(slotUpdate.slot_path, activeCandidateId);
    const candidateProcessId =
      requestedCandidateId &&
      (await candidateProcessBelongsToSession(context, requestedCandidateId, tx))
        ? requestedCandidateId
        : undefined;
    scoped.push({
      ...slotUpdate,
      ...(candidateProcessId ? { candidate_process_id: candidateProcessId } : {}),
    });
  }
  return scoped;
}

function candidateIdForSlot(slotPath: string, activeCandidateId?: string) {
  return isCaptureLevelDirectorSlot(slotPath) ? undefined : activeCandidateId;
}

async function candidateProcessIdForTool(
  context: DirectorToolContext,
  toolArguments: Record<string, unknown>,
  fallbackCandidateProcessId: string | undefined,
  candidateProcessIdsByName: Map<string, string>,
  tx: ClaimWriteTx,
) {
  const explicitCandidateProcessId = stringArg(toolArguments.candidateProcessId);
  if (
    explicitCandidateProcessId &&
    (await candidateProcessBelongsToSession(context, explicitCandidateProcessId, tx))
  ) {
    return explicitCandidateProcessId;
  }

  const targetProcessName =
    stringArg(toolArguments.targetProcess) ??
    stringArg(toolArguments.candidateProcessName) ??
    stringArg(toolArguments.processName);
  if (targetProcessName) {
    const createdCandidateId = candidateProcessIdsByName.get(
      normalizeCandidateProcessName(targetProcessName),
    );
    if (createdCandidateId) return createdCandidateId;
    const existingCandidateId = await candidateProcessIdByName(
      context,
      targetProcessName,
      tx,
    );
    if (existingCandidateId) return existingCandidateId;
  }

  return fallbackCandidateProcessId;
}

async function candidateProcessIdByName(
  context: DirectorToolContext,
  processName: string,
  tx: ClaimWriteTx,
) {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id
    FROM candidate_processes
    WHERE org_id = ${context.orgId}
      AND workspace_id = ${context.workspaceId}
      AND capture_session_id = ${context.captureSessionId}
      AND lower(proposed_name) = ${normalizeCandidateProcessName(processName)}
      AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return rows.rows[0]?.id;
}

function normalizeCandidateProcessName(processName: string) {
  return processName.trim().toLowerCase();
}

async function recordCandidateProcessClaimFromTool(
  context: DirectorToolContext,
  candidateProcessId: string,
  toolArguments: Record<string, unknown>,
  evidenceIds: string[],
  tx: ClaimWriteTx,
) {
  const field = stringArg(toolArguments.field);
  if (!field) {
    throw new Error("recordCandidateProcessClaim requires a field.");
  }
  const value =
    toolArguments.value === undefined
      ? stringArg(toolArguments.text) ?? stringArg(toolArguments.name)
      : toolArguments.value;
  if (value === undefined) {
    throw new Error("recordCandidateProcessClaim requires a value.");
  }
  const claim = {
    subject_type: "candidate_process",
    subject_id: candidateProcessId,
    field,
    value,
    confidence: numberArg(toolArguments.confidence) ?? 0.72,
    evidence_ids: evidenceIds,
    metadata: {
      source: "director_candidate_process_claim_tool",
      target_process:
        stringArg(toolArguments.targetProcess) ??
        stringArg(toolArguments.candidateProcessName) ??
        stringArg(toolArguments.processName),
    },
  };
  const validation = validateDirectorPlanClaim(claim);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }
  const request = {
    subject_type: claim.subject_type,
    subject_id: claim.subject_id,
    field: claim.field,
    value: claim.value,
    evidence_ids: claim.evidence_ids,
    confidence: claim.confidence,
    metadata: claim.metadata,
  };
  return writeClaimInTransaction(tx, {
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    userId: context.userId,
    subject: { type: "candidate_process", id: candidateProcessId },
    field: claim.field,
    value: claim.value,
    evidenceIds: claim.evidence_ids,
    confidence: claim.confidence,
    idempotencyKey: `director-tool-candidate-claim:${hash(request)}`,
    requestHash: hash(request),
    route: "director-tool/record-candidate-process-claim",
    metadata: claim.metadata,
  });
}

async function dispatchPlanClaims(
  context: DirectorToolContext,
  claims: DirectorTurnPlan["claims"],
  tx: ClaimWriteTx,
): Promise<{ degraded: boolean; droppedClaims: number }> {
  let degraded = false;
  let droppedClaims = 0;
  for (const claim of claims) {
    const claimValidation = validateDirectorPlanClaim(claim);
    if (!claimValidation.ok) {
      degraded = true;
      droppedClaims += 1;
      await createFollowUpTask(
        context,
        {
          taskType: "low_confidence_claim",
          title: `Review unsupported director claim: ${claim.subject_type}.${claim.field}`,
          description: claimValidation.reason,
          targetType: claim.subject_type,
          targetId: claim.subject_id,
          priority: 2,
          contextJson: {
            field: claim.field,
            value: claim.value,
            evidence_ids: claim.evidence_ids,
          },
        },
        { tx },
      );
      continue;
    }
    const request = {
      subject_type: claim.subject_type,
      subject_id: claim.subject_id,
      field: claim.field,
      value: claim.value,
      evidence_ids: claim.evidence_ids,
      confidence: claim.confidence,
      metadata: claim.metadata,
    };
    try {
      await writeClaimInTransaction(tx, {
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        userId: context.userId,
        subject: {
          type: claim.subject_type as
            | "process"
            | "process_version"
            | "candidate_process"
            | "system"
            | "role"
            | "person",
          id: claim.subject_id,
        },
        field: claim.field,
        value: claim.value,
        evidenceIds: claim.evidence_ids,
        confidence: claim.confidence,
        idempotencyKey: `director-plan-claim:${hash(request)}`,
        requestHash: hash(request),
        route: "director-turn/dispatch-claim",
        metadata: { ...claim.metadata, source: "director_turn_plan" },
      });
    } catch (error) {
      degraded = true;
      droppedClaims += 1;
      await createFollowUpTask(
        context,
        {
          taskType: "low_confidence_claim",
          title: `Retry director claim: ${claim.subject_type}.${claim.field}`,
          description:
            error instanceof Error
              ? error.message
              : "The director claim could not be written automatically.",
          targetType: claim.subject_type,
          targetId: claim.subject_id,
          priority: 2,
          contextJson: {
            field: claim.field,
            value: claim.value,
            evidence_ids: claim.evidence_ids,
          },
        },
        { tx },
      );
    }
  }
  return { degraded, droppedClaims };
}

async function preflightDirectorPlanClaimSubjects(
  context: DirectorToolContext,
  claims: DirectorTurnPlan["claims"],
  tx: ClaimWriteTx,
) {
  const valid: DirectorTurnPlan["claims"] = [];
  const invalid: Array<{
    claim: DirectorTurnPlan["claims"][number];
    reason: string;
  }> = [];

  for (const claim of claims) {
    const reason = await directorClaimSubjectFailure(context, claim, tx);
    if (reason) {
      invalid.push({ claim, reason });
    } else {
      valid.push(claim);
    }
  }
  return { valid, invalid };
}

async function directorClaimSubjectFailure(
  context: DirectorToolContext,
  claim: DirectorTurnPlan["claims"][number],
  tx: ClaimWriteTx,
) {
  if (
    claim.subject_type === "process" ||
    claim.subject_type === "process_version"
  ) {
    return "Director Phase 1 claims must target candidate_process subjects until promotion.";
  }

  if (
    claim.subject_type === "candidate_process" &&
    !(await candidateProcessBelongsToSession(context, claim.subject_id, tx))
  ) {
    return "Director candidate_process claims must target a candidate from this capture session.";
  }

  const referencedCandidateProcessId = referencedCandidateProcessIdFromValue(claim.value);
  if (
    referencedCandidateProcessId &&
    !(await candidateProcessBelongsToSession(
      context,
      referencedCandidateProcessId,
      tx,
    ))
  ) {
    return "Director claims that reference candidate_process_id must reference this capture session.";
  }

  return null;
}

function referencedCandidateProcessIdFromValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidateProcessId = (value as Record<string, unknown>).candidate_process_id;
  return typeof candidateProcessId === "string" ? candidateProcessId : null;
}

type ProbeFiringSummary = {
  count: number;
  lastFiredAt?: Date;
};

async function applyDirectorController(
  context: DirectorToolContext,
  plan: DirectorTurnPlan,
  turnIndex?: number,
  stateSnapshot?: InterviewStateSnapshot,
  currentTurnEvidenceIds: string[] = [],
): Promise<DirectorTurnPlan> {
  const summaries = await readProbeFiringSummaries(context);
  const state = stateSnapshot ?? (await readInterviewState(context));
  const currentSlots = await readCurrentSlots(context, {
    candidateProcessId: state.focusCandidateProcessId,
  });
  const candidateSummaries = await readCandidateSummaries(context);
  const escalation = exhaustedProbeEscalation(
    plan.ranked_intents,
    summaries,
    currentSlots,
    planEvidenceIds(plan, currentTurnEvidenceIds),
  );
  const slotUpdates = [...plan.slot_updates, ...escalation.slotUpdates];
  const forceCloseout = shouldForceDirectorCloseout({
    utteranceType: plan.utterance_type,
    lowInfoTurnCount: state.lowInfoTurnCount,
    lastNewSlotTurnIndex: state.lastNewSlotTurnIndex,
    turnIndex,
    currentSlots,
    slotUpdates,
  });
  const gatedPhase = forceCloseout
    ? "closeout"
    : gateDirectorPhase(plan, currentSlots, candidateSummaries, slotUpdates);
  const rawRankedIntents = plan.ranked_intents.length
    ? plan.ranked_intents
    : await rankProbeIntents(context, state.focusCandidateProcessId);
  const rankedIntents = applyProbeControls(rawRankedIntents, summaries);
  const noEligibleProbe = rankedIntents.length === 0 && rawRankedIntents.length > 0;
  if (forceCloseout) {
    const closeoutIntent = intent(
      "open_questions_closeout",
      undefined,
      1400,
      forceCloseout,
      candidateSummaries[0]?.proposedName,
      "forced_closeout",
    );
    const toolCalls = [...plan.tool_calls, ...escalation.toolCalls];
    const closeoutFollowUps = unresolvedPriorityCloseoutFollowUps(
      currentSlots,
      slotUpdates,
      toolCalls,
    );
    return withControllerPlannedUtterance(plan, {
      ...plan,
      slot_updates: slotUpdates,
      tool_calls: [...toolCalls, ...closeoutFollowUps],
      proposed_next_phase: "closeout",
      phase_transition_ready: plan.current_phase !== "closeout",
      ranked_intents: ensureIntentRanked(closeoutIntent, rankedIntents),
      chosen_intent: closeoutIntent,
    });
  }
  const requestedIntent = noEligibleProbe
    ? cooldownBridgeIntent(gatedPhase, plan.chosen_intent, candidateSummaries)
    : rankedIntents.find((candidate) => candidate.intent === plan.chosen_intent.intent) ??
      rankedIntents[0] ??
      intent("playback_summary", undefined, 100, "No probe is currently eligible.");
  const { chosenIntent, rankedIntents: phaseRankedIntents } = selectPhaseGatedDirectorIntent(
    gatedPhase,
    currentSlots,
    candidateSummaries,
    slotUpdates,
    rankedIntents,
    requestedIntent,
  );

  return withControllerPlannedUtterance(plan, {
    ...plan,
    slot_updates: slotUpdates,
    tool_calls: [...plan.tool_calls, ...escalation.toolCalls],
    proposed_next_phase: gatedPhase,
    phase_transition_ready: gatedPhase !== plan.current_phase,
    ranked_intents: phaseRankedIntents,
    chosen_intent: chosenIntent,
  });
}

function withControllerPlannedUtterance(
  original: DirectorTurnPlan,
  controlled: DirectorTurnPlan,
): DirectorTurnPlan {
  if (!controllerChangedNextAsk(original, controlled)) return controlled;
  return {
    ...controlled,
    planned_agent_utterance: deterministicPhrase(controlled),
  };
}

function controllerChangedNextAsk(original: DirectorTurnPlan, controlled: DirectorTurnPlan) {
  return (
    original.proposed_next_phase !== controlled.proposed_next_phase ||
    original.chosen_intent.intent !== controlled.chosen_intent.intent ||
    original.chosen_intent.target_slot !== controlled.chosen_intent.target_slot ||
    original.chosen_intent.target_process !== controlled.chosen_intent.target_process
  );
}

function shouldForceDirectorCloseout(input: {
  utteranceType: DirectorUtteranceType;
  lowInfoTurnCount: number;
  lastNewSlotTurnIndex: number | null;
  turnIndex?: number;
  currentSlots: Map<string, { status: string | null | undefined }>;
  slotUpdates: DirectorTurnPlan["slot_updates"];
}) {
  const projectedLowInfoTurns =
    input.lowInfoTurnCount + (isLowInfoUtterance(input.utteranceType) ? 1 : 0);
  if (projectedLowInfoTurns >= 3) {
    return "Forced closeout after three low-information director turns; surface unresolved gaps instead of repeating probes.";
  }
  if (
    input.turnIndex !== undefined &&
    input.lastNewSlotTurnIndex !== null &&
    !hasMeaningfulNewSlotCoverage(input.currentSlots, input.slotUpdates) &&
    input.turnIndex - input.lastNewSlotTurnIndex >= 3
  ) {
    return "Forced closeout after three turns without new slot coverage; surface unresolved gaps before ending.";
  }
  return null;
}

function hasMeaningfulNewSlotCoverage(
  currentSlots: Map<string, { status: string | null | undefined }>,
  slotUpdates: DirectorTurnPlan["slot_updates"],
) {
  return slotUpdates.some((update) => {
    const currentRank = slotCoverageProgressRank(
      currentSlots.get(update.slot_path)?.status,
    );
    const updateRank = slotCoverageProgressRank(update.status);
    return updateRank > currentRank;
  });
}

function slotCoverageProgressRank(status: string | null | undefined) {
  if (status === "filled") return 3;
  if (status === "asked_unknown") return 2;
  if (status === "partial" || status === "conflicting") return 1;
  return 0;
}

function unresolvedPriorityCloseoutFollowUps(
  currentSlots: Map<string, { status: string | null | undefined }>,
  slotUpdates: DirectorTurnPlan["slot_updates"],
  existingToolCalls: DirectorTurnPlan["tool_calls"],
): DirectorTurnPlan["tool_calls"] {
  const existingTitles = new Set(
    existingToolCalls
      .filter((tool) => tool.name === "createFollowUpTask")
      .map((tool) => stringArg(tool.arguments.title))
      .filter(Boolean),
  );
  return directorSlotDefinitions
    .filter((definition) => definition.priority >= 90)
    .flatMap((definition) => {
      const updatedStatus = [...slotUpdates]
        .reverse()
        .find((slotUpdate) => slotUpdate.slot_path === definition.path)?.status;
      const status =
        updatedStatus ?? currentSlots.get(definition.path)?.status ?? "empty";
      if (status === "filled" || status === "asked_unknown") return [];
      const title = closeoutFollowUpTitle(definition.label);
      if (existingTitles.has(title)) return [];
      existingTitles.add(title);
      return [
        {
          name: "createFollowUpTask",
          arguments: {
            taskType: "open_question",
            title,
            description: `The director interview reached forced closeout before "${definition.label}" was covered. Capture this before relying on the process map.`,
            targetType: "director_slot",
            priority: definition.priority / 100,
            targetSlot: definition.path,
            source: "forced_closeout",
          },
        },
      ];
    });
}

function closeoutFollowUpTitle(slotLabel: string) {
  return `Resolve director interview gap: ${slotLabel}`;
}

export function gateDirectorPhase(
  plan: DirectorTurnPlan,
  currentSlots: Map<string, { status: string; confidence: string | number | null }>,
  candidateSummaries: CandidateSummary[],
  slotUpdates: DirectorTurnPlan["slot_updates"],
): DirectorInterviewPhase {
  if (!slotCoveredForPhase("function.name", currentSlots, slotUpdates, true)) {
    return "orient";
  }
  const hasInventory =
    candidateSummaries.length > 0 ||
    plan.tool_calls.some((tool) => tool.name === "recordProcess") ||
    slotCoveredForPhase("process.inventory", currentSlots, slotUpdates, true);
  if (!hasInventory) return "inventory";
  const coreSlots: string[] = [
    "scope.boundaries",
    "ownership.roles",
    "systems.systems_of_record",
  ];
  if (!coreSlots.every((slot) => slotCoveredForPhase(slot, currentSlots, slotUpdates))) {
    return "expand";
  }
  return plan.proposed_next_phase;
}

function slotCoveredForPhase(
  slotPath: string,
  currentSlots: Map<string, { status: string; confidence: string | number | null }>,
  slotUpdates: DirectorTurnPlan["slot_updates"],
  allowPartial = false,
) {
  const update = [...slotUpdates]
    .reverse()
    .find((candidate) => candidate.slot_path === slotPath);
  const status = update?.status ?? currentSlots.get(slotPath)?.status;
  return (
    status === "filled" ||
    status === "asked_unknown" ||
    (allowPartial && status === "partial")
  );
}

export function selectPhaseGatedDirectorIntent(
  phase: DirectorInterviewPhase,
  currentSlots: Map<string, { status: string; confidence: string | number | null }>,
  candidateSummaries: CandidateSummary[],
  slotUpdates: DirectorTurnPlan["slot_updates"],
  rankedIntents: DirectorIntent[],
  requestedIntent?: DirectorIntent,
) {
  const fallbackIntent =
    requestedIntent ?? rankedIntents[0] ?? phaseRepairIntent(phase, currentSlots, candidateSummaries, slotUpdates);
  if (phaseAllowsIntent(phase, fallbackIntent)) {
    const ranked = rankedIntents.length ? rankedIntents : [fallbackIntent];
    return { chosenIntent: fallbackIntent, rankedIntents: ensureIntentRanked(fallbackIntent, ranked) };
  }
  const repairedIntent = phaseRepairIntent(phase, currentSlots, candidateSummaries, slotUpdates);
  const existingIntent = rankedIntents.find(
    (candidate) =>
      candidate.intent === repairedIntent.intent &&
      candidate.target_slot === repairedIntent.target_slot,
  );
  const chosenIntent = existingIntent
    ? {
        ...existingIntent,
        score: Math.max(existingIntent.score, repairedIntent.score),
        reason: repairedIntent.reason,
        target_process: existingIntent.target_process ?? repairedIntent.target_process,
      }
    : repairedIntent;
  return {
    chosenIntent,
    rankedIntents: ensureIntentRanked(chosenIntent, rankedIntents),
  };
}

function phaseAllowsIntent(phase: DirectorInterviewPhase, candidate: DirectorIntent) {
  const allowed: Record<DirectorInterviewPhase, string[]> = {
    orient: [
      "orient_interview",
      "discover_function",
      "discover_processes",
      "clarify_previous_question",
    ],
    inventory: ["discover_processes", "clarify_previous_question"],
    expand: [
      "select_process_to_expand",
      "define_process_boundary",
      "capture_outcome",
      "capture_owner_roles",
      "capture_systems",
      "quantify_frequency_volume",
      "reconcile_conflict",
      "clarify_previous_question",
    ],
    enrich: [
      "capture_dependencies",
      "capture_handoffs",
      "capture_metrics",
      "capture_friction",
      "capture_risk_spof",
      "capture_variants",
      "capture_controls",
      "capture_exec_priority",
      "capture_priority",
      "capture_documentation",
      "reconcile_conflict",
      "clarify_previous_question",
    ],
    closeout: ["playback_summary", "open_questions_closeout", "reconcile_conflict"],
  };
  return allowed[phase].includes(candidate.intent);
}

function cooldownBridgeIntent(
  phase: DirectorInterviewPhase,
  blockedIntent: DirectorIntent | undefined,
  candidateSummaries: CandidateSummary[],
) {
  if (phase === "closeout") {
    return intent(
      "playback_summary",
      undefined,
      100,
      "No closeout probe is currently eligible; summarize instead of repeating.",
      candidateSummaries[0]?.proposedName,
      "cooldown_bridge",
    );
  }
  return intent(
    "clarify_previous_question",
    undefined,
    650,
    "All matching probes are in cooldown or exhausted; broaden instead of repeating the prior question.",
    blockedIntent?.target_process ?? candidateSummaries[0]?.proposedName,
    appendStyleHint(blockedIntent?.style_hint, "broaden_low_info"),
  );
}

function phaseRepairIntent(
  phase: DirectorInterviewPhase,
  currentSlots: Map<string, { status: string; confidence: string | number | null }>,
  candidateSummaries: CandidateSummary[],
  slotUpdates: DirectorTurnPlan["slot_updates"],
) {
  const targetProcess = candidateSummaries[0]?.proposedName;
  if (phase === "orient") {
    return intent("discover_function", "function.name", 1300, "Phase gate requires the director remit before process drilldown.");
  }
  if (phase === "inventory") {
    return intent("discover_processes", "process.inventory", 1300, "Phase gate requires a process inventory before selecting one to expand.");
  }
  if (phase === "expand") {
    const coreSlots = [
      "scope.boundaries",
      "ownership.roles",
      "systems.systems_of_record",
    ];
    const missingCoreSlot = coreSlots.find(
      (slotPath) => !slotCoveredForPhase(slotPath, currentSlots, slotUpdates),
    );
    if (missingCoreSlot) {
      return intent(
        intentNameForSlot(missingCoreSlot),
        missingCoreSlot,
        1300,
        "Phase gate requires core process coverage before enrichment or closeout.",
        targetProcess,
      );
    }
    return intent("select_process_to_expand", "scope.boundaries", 1250, "Phase gate requires choosing a process to expand.", targetProcess);
  }
  if (phase === "enrich") {
    const enrichSlots = [
      "handoffs.dependencies",
      "metrics.kpis",
      "friction.pain_points",
      "risk.spofs",
      "priority.executive_priority",
    ];
    const missingEnrichSlot = enrichSlots.find(
      (slotPath) => !slotCoveredForPhase(slotPath, currentSlots, slotUpdates),
    );
    const targetSlot = missingEnrichSlot ?? "metrics.kpis";
    return intent(
      intentNameForSlot(targetSlot),
      targetSlot,
      1200,
      "Phase gate keeps the interview in enrichment until high-value operating context is covered.",
      targetProcess,
    );
  }
  return intent("playback_summary", undefined, 1100, "Required coverage is present; summarize and close the interview.");
}

function ensureIntentRanked(chosenIntent: DirectorIntent, rankedIntents: DirectorIntent[]) {
  const rest = rankedIntents.filter(
    (candidate) =>
      candidate.intent !== chosenIntent.intent ||
      candidate.target_slot !== chosenIntent.target_slot,
  );
  return [chosenIntent, ...rest];
}

function exhaustedProbeEscalation(
  intents: DirectorIntent[],
  summaries: Map<string, ProbeFiringSummary>,
  currentSlots: Map<string, { status: string; confidence: string | number | null }>,
  evidenceIds: string[],
) {
  const slotUpdates: DirectorTurnPlan["slot_updates"] = [];
  const toolCalls: DirectorTurnPlan["tool_calls"] = [];
  const seenSlots = new Set<string>();
  for (const candidate of intents) {
    if (!candidate.target_slot || isControllerExemptIntent(candidate)) continue;
    if (seenSlots.has(candidate.target_slot)) continue;
    const currentStatus = currentSlots.get(candidate.target_slot)?.status ?? "empty";
    if (currentStatus === "filled" || currentStatus === "asked_unknown") continue;

    const probeConfig = probeConfigForIntent(candidate.intent, candidate.target_slot);
    const maxFires = probeConfig?.maxFires ?? 2;
    const summary = mergedProbeSummary(candidate, summaries);
    if (summary.count < maxFires) continue;

    seenSlots.add(candidate.target_slot);
    slotUpdates.push(
      slotUpdate(
        candidate.target_slot,
        {
          response: "unknown",
          source: "probe_max_fires",
          exhausted_intent: candidate.intent,
        },
        evidenceIds,
        1,
        "asked_unknown",
      ),
    );
    toolCalls.push({
      name: "createFollowUpTask",
      arguments: {
        taskType: "open_question",
        title: `Resolve unanswered director slot: ${candidate.target_slot}`,
        description: `The ${candidate.intent} probe reached max_fires without enough coverage. Capture this later before relying on the process map.`,
        targetType: "director_slot",
        priority: 2,
        targetSlot: candidate.target_slot,
      },
    });
  }
  return { slotUpdates, toolCalls };
}

function planEvidenceIds(plan: DirectorTurnPlan, fallbackEvidenceIds: string[] = []) {
  const evidenceIds = new Set<string>(fallbackEvidenceIds);
  for (const update of plan.slot_updates) {
    for (const evidenceId of update.evidence_ids) evidenceIds.add(evidenceId);
  }
  for (const claim of plan.claims) {
    for (const evidenceId of claim.evidence_ids) evidenceIds.add(evidenceId);
  }
  return [...evidenceIds];
}

function applyProbeControls(
  intents: DirectorIntent[],
  summaries: Map<string, ProbeFiringSummary>,
) {
  const now = Date.now();
  return intents
    .flatMap((candidate) => {
      if (isControllerExemptIntent(candidate)) return [candidate];
      const probeConfig = probeConfigForIntent(candidate.intent, candidate.target_slot);
      const maxFires = probeConfig?.maxFires ?? 2;
      const cooldownSeconds = probeConfig?.cooldownSeconds ?? 90;
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

async function readProbeFiringSummaries(context: DirectorToolContext) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    return tx
      .select({
        probeId: probeFirings.probeId,
        targetSlot: probeFirings.targetSlot,
        firedAt: probeFirings.firedAt,
      })
      .from(probeFirings)
      .where(
        and(
          eq(probeFirings.orgId, context.orgId),
          eq(probeFirings.workspaceId, context.workspaceId),
          eq(probeFirings.captureSessionId, context.captureSessionId),
        ),
      )
      .orderBy(desc(probeFirings.firedAt))
      .limit(200);
  });
  const summaries = new Map<string, ProbeFiringSummary>();
  for (const row of rows) {
    bumpProbeSummary(summaries, `intent:${row.probeId}`, row.firedAt);
    if (row.targetSlot) {
      bumpProbeSummary(summaries, `slot:${row.targetSlot}`, row.firedAt);
    }
  }
  return summaries;
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
  candidate: DirectorIntent,
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

function isControllerExemptIntent(candidate: DirectorIntent) {
  return [
    "orient_interview",
    "clarify_previous_question",
    "playback_summary",
    "open_questions_closeout",
    "reconcile_conflict",
  ].includes(candidate.intent);
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

type InterviewStateSnapshot = {
  currentPhase: DirectorInterviewPhase;
  focusCandidateProcessId?: string;
  priorIntent?: string;
  lowInfoTurnCount: number;
  lastNewSlotTurnIndex: number | null;
  phaseHistory: unknown[];
};

type CandidateSummary = {
  id: string;
  proposedName: string;
};

async function readInterviewState(
  context: DirectorToolContext,
  tx?: ClaimWriteTx,
): Promise<InterviewStateSnapshot> {
  const read = async (activeTx: ClaimWriteTx) =>
    activeTx
      .select()
      .from(interviewState)
      .where(eq(interviewState.captureSessionId, context.captureSessionId))
      .limit(1);
  const rows = tx
    ? await read(tx)
    : await getDb().transaction(async (activeTx) => {
        await setOrgContext(activeTx, context.orgId);
        return read(activeTx);
      });
  const row = rows[0];
  if (!row) {
    return {
      currentPhase: "orient",
      lowInfoTurnCount: 0,
      lastNewSlotTurnIndex: null,
      phaseHistory: [],
    };
  }
  return {
    currentPhase: directorPhase(row.currentPhase),
    focusCandidateProcessId: row.focusCandidateProcessId ?? undefined,
    priorIntent: row.priorIntent ?? undefined,
    lowInfoTurnCount: row.lowInfoTurnCount,
    lastNewSlotTurnIndex: row.lastNewSlotTurnIndex,
    phaseHistory: Array.isArray(row.phaseHistory) ? row.phaseHistory : [],
  };
}

async function writeInterviewState(
  context: DirectorToolContext,
  input: Omit<InterviewStateSnapshot, "currentPhase"> & {
    currentPhase: DirectorInterviewPhase;
  },
  tx?: ClaimWriteTx,
) {
  const write = async (activeTx: ClaimWriteTx) =>
    (
      await activeTx
        .insert(interviewState)
        .values({
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          captureSessionId: context.captureSessionId,
          currentPhase: input.currentPhase,
          focusCandidateProcessId: input.focusCandidateProcessId,
          priorIntent: input.priorIntent,
          lowInfoTurnCount: input.lowInfoTurnCount,
          lastNewSlotTurnIndex: input.lastNewSlotTurnIndex,
          phaseHistory: input.phaseHistory,
        })
        .onConflictDoUpdate({
          target: [interviewState.captureSessionId],
          set: {
            currentPhase: input.currentPhase,
            focusCandidateProcessId: input.focusCandidateProcessId,
            priorIntent: input.priorIntent,
            lowInfoTurnCount: input.lowInfoTurnCount,
            lastNewSlotTurnIndex: input.lastNewSlotTurnIndex,
            phaseHistory: input.phaseHistory,
            updatedAt: new Date(),
          },
        })
        .returning()
    )[0];
  if (tx) return write(tx);
  return getDb().transaction(async (activeTx) => {
    await setOrgContext(activeTx, context.orgId);
    return write(activeTx);
  });
}

async function recordProbeFiring(
  context: DirectorToolContext,
  input: {
    probeId: string;
    targetSlot?: string;
    targetCandidateProcessId?: string;
    turnIndex: number;
    styleHint?: string;
    resolvedStatusAfter?: string | null;
  },
  tx?: ClaimWriteTx,
) {
  const write = async (activeTx: ClaimWriteTx) =>
    (
      await activeTx
        .insert(probeFirings)
        .values({
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          captureSessionId: context.captureSessionId,
          probeId: input.probeId,
          targetSlot: input.targetSlot,
          targetCandidateProcessId: input.targetCandidateProcessId,
          turnIndex: input.turnIndex,
          styleHint: input.styleHint,
          resolvedStatusAfter: input.resolvedStatusAfter,
        })
        .onConflictDoNothing()
        .returning()
    )[0];
  if (tx) return write(tx);
  return getDb().transaction(async (activeTx) => {
    await setOrgContext(activeTx, context.orgId);
    return write(activeTx);
  });
}

async function readResolvedSlotStatusAfterProbe(
  context: DirectorToolContext,
  slotPath: string,
  candidateProcessId: string | undefined,
  tx: ClaimWriteTx,
) {
  const row = (
    await tx
      .select({ status: slotStates.status })
      .from(slotStates)
      .where(
        and(
          eq(slotStates.orgId, context.orgId),
          eq(slotStates.workspaceId, context.workspaceId),
          eq(slotStates.captureSessionId, context.captureSessionId),
          eq(slotStates.slotPath, slotPath),
          candidateProcessId
            ? eq(slotStates.candidateProcessId, candidateProcessId)
            : isNull(slotStates.candidateProcessId),
        ),
      )
      .limit(1)
  )[0];
  return row?.status ?? null;
}

async function readCandidateSummaries(
  context: DirectorToolContext,
): Promise<CandidateSummary[]> {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    return tx
      .select({
        id: candidateProcesses.id,
        proposedName: candidateProcesses.proposedName,
      })
      .from(candidateProcesses)
      .where(
        and(
          eq(candidateProcesses.orgId, context.orgId),
          eq(candidateProcesses.workspaceId, context.workspaceId),
          eq(candidateProcesses.captureSessionId, context.captureSessionId),
          eq(candidateProcesses.status, "pending"),
        ),
      )
      .orderBy(desc(candidateProcesses.createdAt))
      .limit(12);
  });
}

async function rankProbeIntents(
  context: DirectorToolContext,
  candidateProcessId?: string,
): Promise<DirectorIntent[]> {
  const currentSlots = await readCurrentSlots(context, { candidateProcessId });
  const summaries = await readProbeFiringSummaries(context);
  const ranked = applyProbeControls(
    directorSlotDefinitions
    .map((definition) => {
      const state = currentSlots.get(definition.path);
      const status = state?.status ?? "empty";
      const needsProbe = ["empty", "partial", "conflicting", "pending_re_extract"].includes(status);
      const base = definition.mustFire ? 1000 : 0;
      const statusBoost =
        status === "conflicting" || status === "pending_re_extract"
          ? 200
          : status === "empty"
            ? 100
            : status === "partial"
              ? 50
              : 0;
      return intent(
        intentNameForSlot(definition.path),
        definition.path,
        needsProbe ? base + statusBoost + definition.priority : 0,
        needsProbe
          ? `${definition.label} is ${status}.`
          : `${definition.label} already has coverage.`,
      );
    })
    .filter((intent) => intent.score > 0)
    .sort((a, b) => b.score - a.score),
    summaries,
  );
  return ranked.length > 0
    ? ranked
    : [intent("capture_friction", "friction.pain_points", 10, "Fallback question for uncovered friction.")];
}

export function deterministicTurnPlan(input: {
  latestUtterance: string;
  evidenceIds: string[];
  currentSlots: Map<string, { status: string; confidence: string | number | null }>;
  currentPhase: DirectorInterviewPhase;
  candidateProcessNames: string[];
  priorIntent?: string;
  lowInfoTurnCount?: number;
  lastNewSlotTurnIndex?: number | null;
  turnIndex?: number;
}): DirectorTurnPlan {
  const slotUpdates: Array<{
    slot_path: string;
    value?: unknown;
    status: DirectorSlotStatus;
    confidence: number;
    evidence_ids: string[];
    priority: number;
  }> = [];
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const text = input.latestUtterance.trim();
  const lower = text.toLowerCase();
  const utteranceType = classifyUtterance(text);
  const functionName = extractFunctionName(text);
  const processNames = extractProcessNames(text);
  const frequency = extractFrequency(text);
  const volume = extractVolume(text);
  const systems = extractSystems(text);
  const roleNames = extractRoles(text);
  const roleName = roleNames[0];
  const personName = extractPerson(text);
  const outcome = extractOutcome(text);
  const metric = extractMetric(text);
  const dependency = extractDependency(text);
  const processRelationship = extractProcessRelationship(text, [
    ...processNames,
    ...input.candidateProcessNames,
  ]);
  const control = extractControl(text);
  const executivePriority = extractExecutivePriority(text);
  const variant = extractVariant(text);
  const focusProcess = chooseFocusProcess(processNames, input.candidateProcessNames, text);

  if (functionName) {
    slotUpdates.push(
      slotUpdate("function.name", { function_name: functionName }, input.evidenceIds, 0.78),
    );
  }
  if (processNames.length > 0) {
    slotUpdates.push(
      slotUpdate("process.inventory", { processes: processNames }, input.evidenceIds, 0.82),
    );
  }
  for (const processName of processNames) {
    toolCalls.push({
      name: "recordProcess",
      arguments: {
        name: processName,
        proposedFunction: functionName,
        frequency,
        complexityHint: extractComplexityHint(text),
        confidence: 0.78,
      },
    });
  }
  if (focusProcess && (processNames.length === 1 || hasBoundarySignal(text))) {
    slotUpdates.push(
      slotUpdate("scope.boundaries", processBoundaryValue([focusProcess]), input.evidenceIds, 0.82),
    );
  }
  if (outcome) {
    slotUpdates.push(slotUpdate("outcomes.business_outcomes", { outcome }, input.evidenceIds, 0.72));
    if (focusProcess) {
      toolCalls.push({
        name: "recordCandidateProcessClaim",
        arguments: {
          targetProcess: focusProcess,
          field: "business_outcome",
          value: { outcome },
          confidence: 0.72,
        },
      });
    }
  }
  if ((frequency || volume) && utteranceType !== "contradiction") {
    slotUpdates.push(
      slotUpdate(
        "frequency.volume",
        { ...(frequency ? { frequency } : {}), ...(volume ? { volume } : {}) },
        input.evidenceIds,
        0.78,
      ),
    );
    if (volume && focusProcess) {
      toolCalls.push({
        name: "recordCandidateProcessClaim",
        arguments: {
          targetProcess: focusProcess,
          field: "volume",
          value: volume,
          confidence: 0.74,
        },
      });
    }
  }
  if (systems.length > 0) {
    for (const system of systems) {
      toolCalls.push({ name: "recordSystem", arguments: { name: system } });
    }
    slotUpdates.push(slotUpdate("systems.systems_of_record", { systems }, input.evidenceIds, 0.8));
  }
  if (roleNames.length > 0) {
    slotUpdates.push(
      slotUpdate("ownership.roles", ownershipRolesValue(roleNames), input.evidenceIds, 0.72),
    );
  }
  if (personName) {
    toolCalls.push({
      name: "recordPerson",
      arguments: { name: personName, roleName },
    });
    slotUpdates.push(slotUpdate("people.key_people", { person: personName }, input.evidenceIds, 0.7));
  }
  if (metric) {
    slotUpdates.push(slotUpdate("metrics.kpis", { metric }, input.evidenceIds, 0.7));
    if (focusProcess) {
      toolCalls.push({
        name: "recordCandidateProcessClaim",
        arguments: {
          targetProcess: focusProcess,
          field: "kpi",
          value: { name: metric },
          confidence: 0.7,
        },
      });
    }
  }
  if (dependency) {
    slotUpdates.push(
      slotUpdate("handoffs.dependencies", { dependency }, input.evidenceIds, 0.7),
    );
    if (focusProcess) {
      toolCalls.push({
        name: "recordCandidateProcessClaim",
        arguments: {
          targetProcess: focusProcess,
          field: "upstream_dependency",
          value: { name: dependency },
          confidence: 0.7,
        },
      });
    }
  }
  if (processRelationship) {
    slotUpdates.push(
      slotUpdate(
        "handoffs.dependencies",
        { relationship: processRelationship },
        input.evidenceIds,
        0.72,
      ),
    );
    toolCalls.push({
      name: "recordCandidateProcessClaim",
      arguments: {
        targetProcess: processRelationship.source_process ?? focusProcess,
        field: "process_relationship",
        value: processRelationship,
        confidence: 0.72,
      },
    });
  }
  if (/(manual|slow|delay|bottleneck|rework|cleanup|pain|break|stuck)/i.test(text)) {
    toolCalls.push({
      name: "recordPainPoint",
      arguments: { text, targetProcess: focusProcess },
    });
    slotUpdates.push(slotUpdate("friction.pain_points", { pain_point: text }, input.evidenceIds, 0.78));
  }
  if (/(only|single point|one person|depends on|tribal knowledge|if .* out)/i.test(lower)) {
    toolCalls.push({
      name: "recordSpof",
      arguments: { text, targetProcess: focusProcess },
    });
    slotUpdates.push(slotUpdate("risk.spofs", { spof: text }, input.evidenceIds, 0.76));
  }
  if (/(documented|sop|runbook|wiki|not documented|tribal knowledge)/i.test(text)) {
    slotUpdates.push(
      slotUpdate("documentation.maturity", { maturity_signal: text }, input.evidenceIds, 0.72),
    );
  }
  if (control) {
    slotUpdates.push(slotUpdate("controls.compliance", { control }, input.evidenceIds, 0.72));
    if (focusProcess) {
      toolCalls.push({
        name: "recordCandidateProcessClaim",
        arguments: {
          targetProcess: focusProcess,
          field: "control",
          value: { control },
          confidence: 0.72,
        },
      });
    }
  }
  if (executivePriority) {
    slotUpdates.push(
      slotUpdate(
        "priority.executive_priority",
        { priority: executivePriority },
        input.evidenceIds,
        0.72,
      ),
    );
    if (focusProcess) {
      toolCalls.push({
        name: "recordCandidateProcessClaim",
        arguments: {
          targetProcess: focusProcess,
          field: "exec_priority",
          value: { priority: executivePriority },
          confidence: 0.72,
        },
      });
    }
  }
  if (variant) {
    slotUpdates.push(slotUpdate("variants.exceptions", { variant }, input.evidenceIds, 0.72));
    if (focusProcess) {
      toolCalls.push({
        name: "recordCandidateProcessClaim",
        arguments: {
          targetProcess: focusProcess,
          field: "variant",
          value: { variant },
          confidence: 0.72,
        },
      });
    }
  }
  const conflictingSlot =
    utteranceType === "contradiction"
      ? contradictionTargetSlot(text, input.priorIntent)
      : undefined;
  if (conflictingSlot) {
    slotUpdates.push(
      slotUpdate(
        conflictingSlot,
        { conflict: text, source: "director_contradiction" },
        input.evidenceIds,
        0.5,
        "conflicting",
      ),
    );
  }
  const unknownSlot =
    utteranceType === "dont_know"
      ? slotForUnknownResponse(input.priorIntent, input.currentPhase)
      : undefined;
  if (unknownSlot && shouldMarkSlotAskedUnknown(input.currentSlots, slotUpdates, unknownSlot)) {
    slotUpdates.push(
      slotUpdate(
        unknownSlot,
        { response: "unknown", source: "director_dont_know" },
        input.evidenceIds,
        1,
        "asked_unknown",
      ),
    );
  }

  const currentPhase = input.currentPhase;
  let proposedNextPhase = chooseNextPhase({
    currentPhase,
    utteranceType,
    currentSlots: input.currentSlots,
    functionName,
    processNames,
    candidateProcessNames: input.candidateProcessNames,
    slotUpdates,
  });
  const rankedIntents = deterministicIntents({
    utteranceType,
    currentPhase,
    proposedNextPhase,
    currentSlots: input.currentSlots,
    processNames,
    candidateProcessNames: input.candidateProcessNames,
    focusProcess,
    functionName,
    unknownSlot,
    conflictingSlot,
    lowInfoTurnCount: input.lowInfoTurnCount ?? 0,
  });
  const forceCloseout = shouldForceDirectorCloseout({
    utteranceType,
    lowInfoTurnCount: input.lowInfoTurnCount ?? 0,
    lastNewSlotTurnIndex: input.lastNewSlotTurnIndex ?? null,
    turnIndex: input.turnIndex,
    currentSlots: input.currentSlots,
    slotUpdates,
  });
  if (forceCloseout) {
    proposedNextPhase = "closeout";
    const closeoutIntent = intent(
      "open_questions_closeout",
      undefined,
      1400,
      forceCloseout,
      focusProcess,
      "forced_closeout",
    );
    const closeoutFollowUps = unresolvedPriorityCloseoutFollowUps(
      input.currentSlots,
      slotUpdates,
      toolCalls,
    );
    const plan = {
      utterance_type: utteranceType,
      slot_updates: slotUpdates,
      claims: [],
      tool_calls: [...toolCalls, ...closeoutFollowUps],
      contradiction_signals: contradictionSignals(utteranceType, text),
      current_phase: currentPhase,
      proposed_next_phase: proposedNextPhase,
      phase_transition_ready: proposedNextPhase !== currentPhase,
      ranked_intents: ensureIntentRanked(closeoutIntent, rankedIntents),
      chosen_intent: closeoutIntent,
    };
    return {
      ...plan,
      planned_agent_utterance: deterministicPhrase(plan),
    };
  }

  const plan = {
    utterance_type: utteranceType,
    slot_updates: slotUpdates,
    claims: [],
    tool_calls: toolCalls,
    contradiction_signals: contradictionSignals(utteranceType, text),
    current_phase: currentPhase,
    proposed_next_phase: proposedNextPhase,
    phase_transition_ready: proposedNextPhase !== currentPhase,
    ranked_intents: rankedIntents,
    chosen_intent: rankedIntents[0],
  };
  return {
    ...plan,
    planned_agent_utterance: deterministicPhrase(plan),
  };
}

function slotUpdate(
  slotPath: string,
  value: unknown,
  evidenceIds: string[],
  confidence: number,
  status: DirectorSlotStatus = "filled",
) {
  return {
    slot_path: slotPath,
    value,
    status,
    confidence,
    evidence_ids: evidenceIds,
    priority: slotPriority(slotPath),
  };
}

function directorPhase(value: string): DirectorInterviewPhase {
  return ["orient", "inventory", "expand", "enrich", "closeout"].includes(value)
    ? (value as DirectorInterviewPhase)
    : "orient";
}

function intent(
  intentName: string,
  targetSlot: string | undefined,
  score: number,
  reason: string,
  targetProcess?: string,
  styleHint?: string,
): DirectorIntent {
  return {
    intent: intentName,
    target_slot: targetSlot,
    target_process: targetProcess,
    score,
    reason,
    style_hint: styleHint,
  };
}

function intentNameForSlot(slotPath: string) {
  const bySlot: Record<string, string> = {
    "function.name": "discover_function",
    "process.inventory": "discover_processes",
    "scope.boundaries": "define_process_boundary",
    "outcomes.business_outcomes": "capture_outcome",
    "ownership.roles": "capture_owner_roles",
    "people.key_people": "capture_owner_roles",
    "systems.systems_of_record": "capture_systems",
    "frequency.volume": "quantify_frequency_volume",
    "handoffs.dependencies": "capture_dependencies",
    "metrics.kpis": "capture_metrics",
    "friction.pain_points": "capture_friction",
    "risk.spofs": "capture_risk_spof",
    "controls.compliance": "capture_controls",
    "documentation.maturity": "capture_documentation",
    "priority.executive_priority": "capture_priority",
    "variants.exceptions": "capture_variants",
  };
  return bySlot[slotPath] ?? "open_questions_closeout";
}

function classifyUtterance(text: string): DirectorUtteranceType {
  const compact = text.trim().toLowerCase();
  if (!compact) return "non_answer";
  if (/^(hi|hello|hey|good (morning|afternoon|evening))[\s!.]*$/.test(compact)) {
    return "greeting";
  }
  if (/(what are we doing|what is this|how does this work|why are you asking|what are we going to do|how long|can you hear me|are you there|is this (thing )?working)/i.test(text)) {
    return "meta_question";
  }
  if (/\b(i don'?t know|not sure|no idea|hard to say|depends)\b/i.test(text)) {
    return "dont_know";
  }
  if (/\b(actually|correction|not exactly|scratch that|i meant)\b/i.test(text)) {
    return "correction";
  }
  if (/\b(that'?s wrong|that is wrong|not true|isn'?t true|not the case|contradicts?|opposite)\b/i.test(text)) {
    return "contradiction";
  }
  if (/\b(what do you mean|can you clarify|could you clarify|can you be more specific|could you be more specific|be more specific|what does .* mean|define|do you mean|what are systems of record|what is a system of record)\b/i.test(text)) {
    return "clarification_request";
  }
  if (
    /\b(unrelated|off topic|by the way|quick question)\b/i.test(text) &&
    !hasBusinessSignal(text)
  ) {
    return "off_topic";
  }
  if (/\b(lunch|restaurant|weather|sports|movie|weekend)\b/i.test(text) && !hasBusinessSignal(text)) {
    return "off_topic";
  }
  if (/^(yeah|yep|yes|ok|okay|sure|right|uh|um|so|so this is|mm-hmm)[\s!.]*$/i.test(text)) {
    return "non_answer";
  }
  if (text.split(/\s+/).length < 5 && !hasBusinessSignal(text)) return "non_answer";
  if (text.split(/\s+/).length < 10 && hasBusinessSignal(text)) return "partial_answer";
  return "substantive_answer";
}

function extractFunctionName(text: string) {
  const match =
    text.match(
      /\b(?:i run|i lead|i oversee|i manage|i own|my team owns|we own|we run|we lead|we oversee|own)\s+([^,.]+)/i,
    ) ??
    text.match(
      /\b(?:i(?:'m| am)|we(?:'re| are))\s+(?:in charge of|responsible for)\s+(?:the\s+)?([^,.]+(?:department|function|team|org|organization|operations?))/i,
    );
  if (!match?.[1]) return undefined;
  const cleaned = cleanPhrase(match[1])
    .replace(/\b(?:and our|and we|including|which includes)\b.*$/i, "")
    .trim();
  if (!cleaned || looksLikeProcessList(cleaned)) return undefined;
  return titleCase(cleaned);
}

function extractProcessNames(text: string) {
  const fragments: string[] = [];
  const ordinalNames = extractOrdinalProcessNames(text);
  const listText = normalizeProcessListContinuations(text);
  const listPatterns = [
    /\b(?:processes are|processes include|main processes are|my team owns|we own|we handle|we manage|we run)\s+([^.;]+)/i,
    /\b(?:in charge of|responsible for|responsible for the following|responsible for these|responsible for those)\s+([^.;]+)/i,
    /\b(?:including|includes)\s+([^.;]+)/i,
    /\b(?:processes|workflows|cadences)\s+like\s+([^.;]+)/i,
  ];
  for (const pattern of listPatterns) {
    const match = listText.match(pattern);
    if (match?.[1]) fragments.push(match[1]);
  }
  const namedProcess = text.match(/\b(?:process is|process called|process:|workflow is|workflow called)\s+([^,.]+)/i);
  if (namedProcess?.[1]) fragments.push(namedProcess[1]);

  const names = [...ordinalNames, ...fragments.flatMap(splitProcessList)].map((value) =>
    normalizeProcessName(value),
  );
  return unique(
    names.filter((name) => {
      const lower = name.toLowerCase();
      return (
        isPlausibleDirectorProcessName(name) &&
        !/^(the|our|my|a|an|team|business|function)$/.test(lower) &&
        !/^(a couple different things|couple different things|different things|a few things|several things|some things|multiple things|things)$/.test(lower) &&
        !/^(sales|rev ops|revenue operations|commercial operations|business operations|sales operations|marketing|finance|support)$/.test(lower)
      );
    }),
  );
}

function normalizeProcessListContinuations(text: string) {
  return text
    .replace(/\.\s+(?=(?:and|also|as well as|like)\b)/gi, ", ")
    .replace(
      /\.\s+(?=(?:payroll|cost|closing|close|accounting|procurement|reporting|invoice|invoicing|billing|collections|reconciliation|forecasting|budget|budgeting|tax|audit)\b)/gi,
      ", ",
    )
    .replace(/\b(and also|also|as well as|along with|plus)\b/gi, ", ")
    .replace(/\bother,\s+like\b/gi, "")
    .replace(
      /\b(?:(?:a\s+)?couple(?:\s+different)?|a\s+few|several|multiple|some|two|three|four|five|\d+)?\s*things?,\s*like\b/gi,
      "",
    )
    .replace(/\bthings?\s+like\b/gi, "");
}

function extractOrdinalProcessNames(text: string) {
  const names: string[] = [];
  const ordinalPattern =
    /\b(?:the\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+(?:one|thing|process))?\s+(?:being|is|was|would be|as)\s+([^,.;]+)/gi;
  for (const match of text.matchAll(ordinalPattern)) {
    if (match[1]) names.push(cleanPhrase(match[1]));
  }
  return names;
}

function splitProcessList(value: string) {
  return cleanPhrase(value)
    .replace(
      /^(?:(?:a\s+)?couple(?:\s+different)?|a\s+few|several|multiple|some|three|two|four|five|six|seven|eight|nine|ten|\d+)\s+things?[:,\s-]*/i,
      "",
    )
    .replace(/\b(as well as|along with|plus)\b/gi, ",")
    .replace(/\band\b/gi, ",")
    .split(",")
    .map((item) =>
      cleanPhrase(item)
        .replace(/^(?:other|others|like|including|also)\s+/i, "")
        .replace(/\b(?:process|workflow|workflows|cadence|cadences)\b$/i, "")
        .trim(),
    )
    .filter(Boolean);
}

function normalizeProcessName(value: string) {
  return titleCase(
    cleanPhrase(value)
      .replace(/\bclos(?:e|ing)\s+the\s+books\b/i, "closing books")
      .replace(/\bthe\s+books\b/i, "books")
      .trim(),
  );
}

function isPlausibleDirectorProcessName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const cleaned = cleanPhrase(value);
  const lower = cleaned.toLowerCase();
  if (cleaned.length < 3 || cleaned.length > 80) return false;
  if (cleaned.split(/\s+/).length > 8) return false;
  if (
    /^(then|and then|we then|we first|first|next|finally)\b/i.test(cleaned) ||
    /^(we\s+)?(?:begin|start|move|send|finish|look|open|check|copy|paste|reconcile|review|approve|export|upload|download)\b/i.test(cleaned)
  ) {
    return false;
  }
  if (
    /\b(?:begin by|starts? by|move data|send off|final check|we finish|looking at|make sure)\b/i.test(cleaned)
  ) {
    return false;
  }
  if (
    /^(?:google sheets?|netsuite|workday|salesforce|excel|slack|jira|asana|hubspot|zendesk)$/i.test(cleaned)
  ) {
    return false;
  }
  return !/^(?:and we|we|i|they|it|this|that|looks like|successful)$/i.test(lower);
}

function chooseFocusProcess(
  extractedProcesses: string[],
  knownProcesses: string[],
  text: string,
) {
  const allProcesses = [...extractedProcesses, ...knownProcesses];
  const explicitlyMentioned = knownProcesses.find((processName) =>
    new RegExp(`\\b${escapeRegExp(processName)}\\b`, "i").test(text),
  );
  const explicitPain = allProcesses.find((processName) =>
    new RegExp(
      `${escapeRegExp(processName)}[^.]*\\b(manual|slow|delay|bottleneck|pain|painful|break|stuck|cleanup)\\b`,
      "i",
    ).test(text),
  );
  return explicitPain ?? extractedProcesses[0] ?? explicitlyMentioned ?? knownProcesses[0];
}

function hasBoundarySignal(text: string) {
  return /\b(starts?|begins?|ends?|complete|finished|from .* to |boundary|handoff)\b/i.test(text);
}

function extractOutcome(text: string) {
  const match = text.match(/\b(?:outcome is|responsible for|so that|goal is|produces?)\s+([^,.]+)/i);
  return match?.[1] ? cleanPhrase(match[1]) : undefined;
}

function extractMetric(text: string) {
  const match = text.match(/\b(?:measure|metric|kpi|tracked by|target is)\s+([^,.]+)/i);
  return match?.[1] ? cleanPhrase(match[1]) : undefined;
}

function extractDependency(text: string) {
  const match = text.match(
    /\b(?:depends on|input from|handoff from|handoff to|downstream to|upstream from)\s+([^,.]+)/i,
  );
  if (match?.[1]) return cleanPhrase(match[1]);
  const pulledIn = text.match(
    /(?:^|[.;,]|\bbecause\b|\bwhen\b|\band\b)\s*([A-Za-z][A-Za-z &-]{1,40}?)\s+gets?\s+pulled\s+in\b/i,
  );
  if (pulledIn?.[1]) return cleanPhrase(pulledIn[1]);
  const involved = text.match(/\b(?:involves|requires|needs)\s+([A-Za-z][A-Za-z &-]{1,60})\b/i);
  if (involved?.[1]) return cleanPhrase(involved[1]);
  return match?.[1] ? cleanPhrase(match[1]) : undefined;
}

function extractProcessRelationship(text: string, processNames: string[]) {
  const canonicalProcesses = [...new Set(processNames.filter(Boolean))];
  for (const sourceProcess of canonicalProcesses) {
    for (const targetProcess of canonicalProcesses) {
      if (sourceProcess === targetProcess) continue;
      const source = escapeRegExp(sourceProcess);
      const target = escapeRegExp(targetProcess);
      const ordered = text.match(
        new RegExp(
          `\\b${source}\\b[^.]{0,80}?\\b(feeds|drives|informs|triggers|rolls into|flows into|hands off to)\\b[^.]{0,80}?\\b${target}\\b`,
          "i",
        ),
      );
      if (ordered?.[1]) {
        return {
          source_process: sourceProcess,
          target_process: targetProcess,
          relationship: ordered[1].toLowerCase(),
          statement: text.trim(),
        };
      }
      const dependency = text.match(
        new RegExp(
          `\\b${target}\\b[^.]{0,80}?\\b(depends on|uses input from|takes input from)\\b[^.]{0,80}?\\b${source}\\b`,
          "i",
        ),
      );
      if (dependency?.[1]) {
        return {
          source_process: sourceProcess,
          target_process: targetProcess,
          relationship: dependency[1].toLowerCase(),
          statement: text.trim(),
        };
      }
    }
  }
  return undefined;
}

function extractControl(text: string) {
  if (
    /\b(control|compliance|audit|sox|approval from|approval is required|approved by|sign[- ]?off|requires? approval|required approval|must be approved|governed by)\b/i.test(
      text,
    )
  ) {
    return text.trim();
  }
  return undefined;
}

function extractExecutivePriority(text: string) {
  if (
    /\b(top priority|high priority|medium priority|low priority|executive priority|exec priority|strategic priority|board priority|ceo|cfo|cro|this quarter|this year)\b/i.test(
      text,
    )
  ) {
    return text.trim();
  }
  return undefined;
}

function extractVariant(text: string) {
  if (
    /\b(exception|exceptions|variant|variants|edge case|edge cases|special case|manual override|override|enterprise deal|enterprise deals)\b/i.test(
      text,
    )
  ) {
    return text.trim();
  }
  return undefined;
}

function chooseNextPhase(input: {
  currentPhase: DirectorInterviewPhase;
  utteranceType: DirectorUtteranceType;
  currentSlots: Map<string, { status: string; confidence: string | number | null }>;
  functionName?: string;
  processNames: string[];
  candidateProcessNames: string[];
  slotUpdates: Array<{ slot_path: string }>;
}): DirectorInterviewPhase {
  if (isLowInfoUtterance(input.utteranceType)) return input.currentPhase;
  const hasFunction =
    input.functionName ||
    hasSlot(input.currentSlots, "function.name") ||
    input.slotUpdates.some((slot) => slot.slot_path === "function.name");
  const hasInventory =
    input.processNames.length > 0 ||
    input.candidateProcessNames.length > 0 ||
    hasSlot(input.currentSlots, "process.inventory") ||
    input.slotUpdates.some((slot) => slot.slot_path === "process.inventory");
  if (!hasFunction) return "orient";
  if (!hasInventory) return "inventory";
  if (input.currentPhase === "orient" || input.currentPhase === "inventory") return "expand";
  if (input.currentPhase === "expand" && hasSlot(input.currentSlots, "scope.boundaries")) {
    return "enrich";
  }
  return input.currentPhase;
}

function deterministicIntents(input: {
  utteranceType: DirectorUtteranceType;
  currentPhase: DirectorInterviewPhase;
  proposedNextPhase: DirectorInterviewPhase;
  currentSlots: Map<string, { status: string; confidence: string | number | null }>;
  processNames: string[];
  candidateProcessNames: string[];
  focusProcess?: string;
  functionName?: string;
  unknownSlot?: string;
  conflictingSlot?: string;
  lowInfoTurnCount: number;
}) {
  if (input.utteranceType === "greeting") {
    return [
      intent("discover_function", "function.name", 1200, "Orient the director before process drilldown.", undefined, "orientation"),
      intent("discover_processes", "process.inventory", 900, "Next, inventory owned processes."),
    ];
  }
  if (input.utteranceType === "meta_question") {
    return [
      metaContinuationIntent(input),
      intent("discover_function", "function.name", 800, "Recover director remit if the current phase cannot continue.", undefined, "meta_continue"),
    ];
  }
  if (input.utteranceType === "dont_know" || input.utteranceType === "non_answer") {
    if (input.utteranceType === "dont_know" && input.unknownSlot) {
      return [
        adjacentIntentAfterUnknown(input.unknownSlot, input.currentPhase),
        intent(
          "open_questions_closeout",
          undefined,
          600,
          `The director did not know ${input.unknownSlot}; move to an adjacent question.`,
        ),
      ];
    }
    const styleHint = input.lowInfoTurnCount >= 1 ? "easy_list,broaden_low_info" : "easy_list";
    return [
      intent("discover_processes", "process.inventory", 1100, "Low-information turn; ask for an easier process list.", undefined, styleHint),
      intent("discover_function", "function.name", 800, "Recover director remit if needed."),
    ];
  }
  if (input.utteranceType === "clarification_request") {
    return [
      intent(
        "clarify_previous_question",
        input.proposedNextPhase === "enrich" ? "systems.systems_of_record" : undefined,
        1250,
        "The director asked for clarification; answer briefly and re-ask the active probe.",
        input.focusProcess,
        "define_then_reask",
      ),
      intent("discover_processes", "process.inventory", 700, "Return to process inventory if clarification is not tied to a slot."),
    ];
  }
  if (input.utteranceType === "off_topic") {
    return [
      intent(
        input.currentPhase === "orient" ? "discover_function" : "discover_processes",
        input.currentPhase === "orient" ? "function.name" : "process.inventory",
        1200,
        "Acknowledge briefly, then steer back to the interview.",
        undefined,
        "warm_redirect",
      ),
    ];
  }
  if (input.utteranceType === "contradiction") {
    return [
      intent(
        "reconcile_conflict",
        input.conflictingSlot,
        1400,
        "The director contradicted prior context; resolve the trusted version before moving on.",
        input.focusProcess,
        "resolve_conflict",
      ),
      intent("open_questions_closeout", undefined, 600, "Confirm the trusted version if needed.", input.focusProcess),
    ];
  }
  if (input.utteranceType === "correction") {
    return [
      intent(
        input.focusProcess ? "capture_owner_roles" : "capture_correction",
        input.focusProcess ? "ownership.roles" : undefined,
        1300,
        "The director corrected prior context; capture the corrected fact before moving on.",
        input.focusProcess,
        "acknowledge_correction",
      ),
      intent("open_questions_closeout", undefined, 600, "Confirm the trusted version if needed.", input.focusProcess),
    ];
  }
  if (!input.functionName && !hasSlot(input.currentSlots, "function.name")) {
    return [
      intent("discover_function", "function.name", 1150, "Director remit is not known yet."),
      intent("discover_processes", "process.inventory", 900, "Process inventory follows remit."),
    ];
  }
  if (input.processNames.length > 0) {
    return [
      intent(
        "select_process_to_expand",
        "scope.boundaries",
        1200,
        "The director named multiple processes; choose one to drill into.",
        input.focusProcess,
      ),
      intent("capture_outcome", "outcomes.business_outcomes", 850, "Outcomes anchor process value.", input.focusProcess),
    ];
  }
  if (
    input.candidateProcessNames.length === 0 &&
    !hasSlot(input.currentSlots, "process.inventory")
  ) {
    return [
      intent("discover_processes", "process.inventory", 1125, "No process inventory is captured yet."),
      intent("discover_function", "function.name", 700, "Function context may need refinement."),
    ];
  }
  const ranked = directorSlotDefinitions
    .map((definition) => {
      const state = input.currentSlots.get(definition.path);
      const status = state?.status ?? "empty";
      const needsProbe = ["empty", "partial", "conflicting", "pending_re_extract"].includes(status);
      const base = definition.mustFire ? 1000 : 0;
      const statusBoost =
        status === "conflicting" || status === "pending_re_extract"
          ? 200
          : status === "empty"
            ? 100
            : status === "partial"
              ? 50
              : 0;
      return intent(
        intentNameForSlot(definition.path),
        definition.path,
        needsProbe ? base + statusBoost + definition.priority : 0,
        needsProbe ? `${definition.label} is ${status}.` : `${definition.label} is covered.`,
        input.focusProcess,
      );
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked.length > 0
    ? ranked
    : [intent("playback_summary", undefined, 100, "Core coverage exists; play back the map.")];
}

function metaContinuationIntent(input: {
  currentPhase: DirectorInterviewPhase;
  currentSlots: Map<string, { status: string; confidence: string | number | null }>;
  candidateProcessNames: string[];
  focusProcess?: string;
}) {
  const target = input.focusProcess ?? input.candidateProcessNames[0];
  if (input.currentPhase === "inventory") {
    return intent(
      "discover_processes",
      "process.inventory",
      1200,
      "Answer the meta-question, then continue the process inventory.",
      target,
      "meta_continue",
    );
  }
  if (input.currentPhase === "expand") {
    const coreSlots = [
      "scope.boundaries",
      "ownership.roles",
      "systems.systems_of_record",
    ];
    const missingCoreSlot =
      coreSlots.find((slotPath) => !hasSlot(input.currentSlots, slotPath)) ??
      "scope.boundaries";
    return intent(
      target ? intentNameForSlot(missingCoreSlot) : "select_process_to_expand",
      target ? missingCoreSlot : "scope.boundaries",
      1200,
      "Answer the meta-question, then continue the current process drilldown.",
      target,
      "meta_continue",
    );
  }
  if (input.currentPhase === "enrich") {
    return intent(
      "capture_metrics",
      "metrics.kpis",
      1200,
      "Answer the meta-question, then continue enrichment for the focus process.",
      target,
      "meta_continue",
    );
  }
  if (input.currentPhase === "closeout") {
    return intent(
      "playback_summary",
      undefined,
      1200,
      "Answer the meta-question, then continue closeout.",
      target,
      "meta_continue",
    );
  }
  return intent(
    "discover_function",
    "function.name",
    1200,
    "Answer the meta-question, then orient the director before process drilldown.",
    target,
    "meta_continue",
  );
}

function contradictionTargetSlot(text: string, priorIntent?: string) {
  if (/\b(daily|weekly|monthly|quarterly|annually|frequency|cadence|volume|how often)\b/i.test(text)) {
    return "frequency.volume";
  }
  if (/\b(system|salesforce|netsuite|workday|sheets?|spreadsheet|tool)\b/i.test(text)) {
    return "systems.systems_of_record";
  }
  if (/\b(owner|owned by|accountable|finance|rev ops|role|team)\b/i.test(text)) {
    return "ownership.roles";
  }
  if (/\b(start|begin|end|complete|boundary|handoff)\b/i.test(text)) {
    return "scope.boundaries";
  }
  if (/\b(metric|kpi|measure|target)\b/i.test(text)) {
    return "metrics.kpis";
  }
  return slotForUnknownResponse(priorIntent, "expand") ?? "scope.boundaries";
}

function slotForUnknownResponse(
  priorIntent: string | undefined,
  currentPhase: DirectorInterviewPhase,
) {
  const byIntent: Record<string, string> = {
    discover_function: "function.name",
    orient_interview: "function.name",
    discover_processes: "process.inventory",
    select_process_to_expand: "scope.boundaries",
    define_process_boundary: "scope.boundaries",
    capture_outcome: "outcomes.business_outcomes",
    capture_owner_roles: "ownership.roles",
    capture_systems: "systems.systems_of_record",
    quantify_frequency_volume: "frequency.volume",
    capture_dependencies: "handoffs.dependencies",
    capture_handoffs: "handoffs.dependencies",
    capture_metrics: "metrics.kpis",
    capture_friction: "friction.pain_points",
    capture_risk_spof: "risk.spofs",
    capture_controls: "controls.compliance",
    capture_documentation: "documentation.maturity",
    capture_priority: "priority.executive_priority",
    capture_exec_priority: "priority.executive_priority",
    capture_variants: "variants.exceptions",
  };
  if (priorIntent && byIntent[priorIntent]) return byIntent[priorIntent];
  switch (currentPhase) {
    case "orient":
      return "function.name";
    case "inventory":
      return "process.inventory";
    case "expand":
      return "scope.boundaries";
    case "enrich":
      return "metrics.kpis";
    case "closeout":
      return undefined;
  }
}

function shouldMarkSlotAskedUnknown(
  currentSlots: Map<string, { status: string; confidence: string | number | null }>,
  slotUpdates: Array<{ slot_path: string; status: DirectorSlotStatus }>,
  slotPath: string,
) {
  const existing = currentSlots.get(slotPath)?.status;
  if (existing === "filled" || existing === "asked_unknown") return false;
  return !slotUpdates.some(
    (update) =>
      update.slot_path === slotPath &&
      (update.status === "filled" || update.status === "asked_unknown"),
  );
}

function adjacentIntentAfterUnknown(
  unknownSlot: string,
  currentPhase: DirectorInterviewPhase,
) {
  switch (unknownSlot) {
    case "function.name":
      return intent(
        "discover_processes",
        "process.inventory",
        1125,
        "Director does not know the remit framing; ask for recurring work instead.",
        undefined,
        "pivot_from_unknown",
      );
    case "process.inventory":
      return intent(
        "discover_function",
        "function.name",
        1125,
        "Director does not know the process inventory; recover with remit/outcome context.",
        undefined,
        "pivot_from_unknown",
      );
    case "scope.boundaries":
      return intent(
        "capture_outcome",
        "outcomes.business_outcomes",
        1125,
        "Director does not know boundaries; ask for business outcome instead.",
        undefined,
        "pivot_from_unknown",
      );
    case "ownership.roles":
      return intent(
        "capture_systems",
        "systems.systems_of_record",
        1125,
        "Director does not know ownership; ask for systems context instead.",
        undefined,
        "pivot_from_unknown",
      );
    case "systems.systems_of_record":
      return intent(
        "capture_owner_roles",
        "ownership.roles",
        1125,
        "Director does not know systems; ask who is involved instead.",
        undefined,
        "pivot_from_unknown",
      );
    default:
      return intent(
        currentPhase === "enrich" ? "capture_friction" : "discover_processes",
        currentPhase === "enrich" ? "friction.pain_points" : "process.inventory",
        1125,
        "Director does not know the prior slot; pivot to an adjacent high-signal area.",
        undefined,
        "pivot_from_unknown",
      );
  }
}

function hasSlot(
  currentSlots: Map<string, { status: string; confidence: string | number | null }>,
  slotPath: string,
) {
  const status = currentSlots.get(slotPath)?.status;
  return status === "filled" || status === "partial";
}

function summarizeCoverage(
  currentSlots: Map<string, { status: string; confidence: string | number | null }>,
) {
  if (currentSlots.size === 0) return "No director slots have been captured yet.";
  const counts = new Map<string, number>();
  for (const slot of currentSlots.values()) {
    counts.set(slot.status, (counts.get(slot.status) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
}

function isLowInfoUtterance(utteranceType: DirectorUtteranceType) {
  return ["greeting", "meta_question", "non_answer", "dont_know", "off_topic"].includes(
    utteranceType,
  );
}

function appendPhaseHistory(
  phaseHistory: unknown[],
  entry: {
    turn_index: number;
    from: DirectorInterviewPhase;
    to: DirectorInterviewPhase;
    intent: string;
  },
) {
  return [...phaseHistory.slice(-19), { ...entry, at: new Date().toISOString() }];
}

function hasBusinessSignal(text: string) {
  return /(process|workflow|team|own|run|manage|system|salesforce|netsuite|workday|metric|kpi|weekly|monthly|approval|forecast|territory|quote|customer|handoff|manual)/i.test(text);
}

function looksLikeProcessList(text: string) {
  return /,|\band\b|\b(processes|workflows|cadences)\b/i.test(text);
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function extractFrequency(text: string) {
  const match = text.match(
    /\b(daily|weekly|monthly|quarterly|annually|every [^,.]+|\d+\s*(?:times|x)\s*(?:a|per)\s*(?:day|week|month|quarter|year))\b/i,
  );
  return match?.[1];
}

function extractVolume(text: string) {
  const countUnitPeriod = text.match(
    /\b(?:about|around|roughly|approximately|~)?\s*(\d[\d,]*)\s+([A-Za-z][A-Za-z -]{2,30}?)\s+(?:per|a|each)\s+(day|week|month|quarter|year)\b/i,
  );
  if (countUnitPeriod?.[1] && countUnitPeriod[2] && countUnitPeriod[3]) {
    return {
      count: Number(countUnitPeriod[1].replace(/,/g, "")),
      unit: cleanPhrase(countUnitPeriod[2].toLowerCase()),
      period: countUnitPeriod[3].toLowerCase(),
      statement: text.trim(),
    };
  }
  const perPeriod = text.match(
    /\b(?:volume is|volume runs|handle|handles|process|processes|review|reviews)\s+(?:about|around|roughly|approximately|~)?\s*(\d[\d,]*)\s+(?:per|a|each)\s+(day|week|month|quarter|year)\b/i,
  );
  if (perPeriod?.[1] && perPeriod[2]) {
    return {
      count: Number(perPeriod[1].replace(/,/g, "")),
      period: perPeriod[2].toLowerCase(),
      statement: text.trim(),
    };
  }
  return undefined;
}

function extractSystems(text: string) {
  const known = [
    "Salesforce",
    "Clari",
    "NetSuite",
    "Workday",
    "ServiceNow",
    "Slack",
    "Excel",
    "Google Sheets",
    "Zendesk",
    "Jira",
    "Asana",
    "HubSpot",
  ];
  const systems = known.filter((system) =>
    new RegExp(`\\b${escapeRegExp(system)}\\b`, "i").test(text),
  );
  if (/\bsheets\b/i.test(text) && !systems.includes("Google Sheets")) {
    systems.push("Google Sheets");
  }
  return systems;
}

function extractRoles(text: string) {
  const involved = text.match(/\b([A-Za-z][A-Za-z &,/-]{1,100})\s+are involved\b/i);
  if (involved?.[1]) {
    return splitProcessList(involved[1]).map((role) => titleCase(role));
  }
  const role = extractRole(text);
  return role ? [role] : [];
}

function extractRole(text: string) {
  const match = text.match(
    /\b(?:owned by|owner is|accountable owner is|team is|handled by)\s+([^,.]+)/i,
  );
  if (match?.[1]) return titleCase(cleanPhrase(match[1]));
  const possessive = text.match(/\b([A-Za-z][A-Za-z &-]{1,40})\s+owns?\b/i);
  if (possessive?.[1]) {
    const role = titleCase(cleanPhrase(possessive[1]));
    return /^(my|our)?\s*team$|^(and\s+)?we$|^i$|^they$/i.test(role)
      ? undefined
      : role;
  }
  const hyphenOwned = text.match(/\b([A-Za-z][A-Za-z &-]{1,40})-owned\b/i);
  return hyphenOwned?.[1] ? titleCase(cleanPhrase(hyphenOwned[1])) : undefined;
}

function contradictionSignals(utteranceType: DirectorUtteranceType, text: string) {
  if (utteranceType === "contradiction") return [`Director contradicted prior context: ${text}`];
  if (utteranceType === "correction") return [`Director corrected prior context: ${text}`];
  return [];
}

function extractPerson(text: string) {
  const match = text.match(/\b(?:by|owner is|ask)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/);
  return match?.[1];
}

function extractComplexityHint(text: string) {
  if (/(manual|spreadsheet|handoff|approval|exception|rework|delay)/i.test(text)) {
    return "manual handoffs or exception handling mentioned";
  }
  return undefined;
}

function cleanPhrase(value: string) {
  return value
    .replace(/\b(?:today|for us|right now|mostly|usually)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value: string) {
  return value.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
}

function toolCallIdentity(toolCall: DirectorTurnPlan["tool_calls"][number]) {
  if (toolCall.name === "recordCandidateProcessClaim") {
    const target =
      stringArg(toolCall.arguments.targetProcess) ??
      stringArg(toolCall.arguments.candidateProcessName) ??
      stringArg(toolCall.arguments.processName) ??
      stringArg(toolCall.arguments.candidateProcessId) ??
      "";
    const field = stringArg(toolCall.arguments.field) ?? "";
    return `${toolCall.name}:${target.toLowerCase()}:${field.toLowerCase()}:${stableStringify(toolCall.arguments.value ?? toolCall.arguments.text ?? toolCall.arguments.name ?? "")}`;
  }
  const name = stringArg(toolCall.arguments.name)?.toLowerCase() ?? "";
  return `${toolCall.name}:${name}`;
}

function stringArg(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function voiceMetadataDegrades(metadata: DirectorModelMetadata) {
  return metadata.mocked === true || metadata.utterance_source === "deterministic_phrase_fallback";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
