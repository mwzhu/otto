import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  candidateProcesses,
  slotStates,
  transcriptSegments,
} from "@/lib/db/schema";
import { structured } from "@/lib/adapters/llm";
import { writeAgentDecision } from "@/lib/db/write-agent-decision";
import {
  directorSlotDefinitions,
  slotPriority,
  type DirectorSlotStatus,
} from "@/lib/interview/director/slot-schema";
import { fallbackProbeForSlot, probeLibrary, type ProbeIntent } from "@/lib/interview/director/probe-library";
import { phraseProbe } from "@/lib/interview/director/voice";
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
import { slotExtractionSchema } from "@/lib/schemas/phase1";
import {
  ownershipRolesValue,
  processBoundaryValue,
} from "@/lib/interview/director/slot-values";

type DirectorExtraction = z.infer<typeof slotExtractionSchema>;

export type DirectorTurnInput = DirectorToolContext & {
  latestUtterance: string;
  transcriptSegmentIds: string[];
  evidenceIds: string[];
  turnIndex: number;
};

export type DirectorTurnResult = {
  next_prompt: string;
  chosen_intent: ProbeIntent;
  ranked_intents: ProbeIntent[];
  slot_updates: Array<{
    slot_path: string;
    status: DirectorSlotStatus;
    confidence: number;
    value?: unknown;
    evidence_ids: string[];
  }>;
  candidate_process_ids: string[];
  degraded_quality: boolean;
  metadata: {
    model: string;
    token_count_input: number;
    token_count_output: number;
    cost_cents: number;
    latency_ms: number;
    cache_hit: boolean;
  };
};

export async function runDirectorTurn(
  input: DirectorTurnInput,
): Promise<DirectorTurnResult> {
  const started = new Date();
  const context: DirectorToolContext = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    captureSessionId: input.captureSessionId,
    userId: input.userId,
  };
  const currentSlots = await readCurrentSlots(context);
  const recentTurns = await readRecentTurns(context);
  const promptBlocks = buildPromptCacheBlocks({
    currentSlots,
    recentTurns,
    latestUtterance: input.latestUtterance,
  });

  let extraction: DirectorExtraction = deterministicExtraction(
    input.latestUtterance,
    input.evidenceIds,
  );
  let degradedQuality = false;
  let llmResult:
    | Awaited<ReturnType<typeof structured<DirectorExtraction>>>
    | undefined;
  try {
    llmResult = await structured({
      prompt_template_id: "director.turn.extract-and-rank",
      prompt_template_version: "1",
      schema_name: "slot-extraction",
      schema: slotExtractionSchema,
      input: "",
      static_input: promptBlocks.staticBlock,
      dynamic_input: promptBlocks.dynamicBlock,
      mock: extraction,
    });
    extraction = llmResult.value;
  } catch (error) {
    degradedQuality = true;
    extraction = {
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

  const candidateProcessIds: string[] = [];
  const processTool = extraction.tool_calls.find((tool) => tool.name === "recordProcess");
  if (processTool) {
    const args = processTool.arguments;
    const candidate = await recordProcess(context, {
      name: stringArg(args.name) ?? "Unnamed Director Process",
      proposedFunction: stringArg(args.proposedFunction),
      frequency: stringArg(args.frequency),
      complexityHint: stringArg(args.complexityHint),
      confidence: numberArg(args.confidence) ?? 0.74,
      evidenceIds: input.evidenceIds,
    });
    candidateProcessIds.push(candidate.id);
  }
  const activeCandidateId =
    candidateProcessIds[0] ?? (await latestCandidateProcessId(context));

  for (const tool of extraction.tool_calls) {
    if (tool.name === "recordSystem") {
      const systemName = stringArg(tool.arguments.name);
      if (systemName) {
        await recordSystem(context, {
          name: systemName,
          evidenceIds: input.evidenceIds,
          candidateProcessId: activeCandidateId,
        });
      }
    }
    if (tool.name === "recordPerson") {
      const personName = stringArg(tool.arguments.name);
      if (personName) {
        await recordPerson(context, {
          name: personName,
          title: stringArg(tool.arguments.title),
          roleName: stringArg(tool.arguments.roleName),
          evidenceIds: input.evidenceIds,
        });
      }
    }
    if (activeCandidateId && tool.name === "recordPainPoint") {
      const text = stringArg(tool.arguments.text);
      if (text) {
        await recordPainPoint(context, {
          candidateProcessId: activeCandidateId,
          text,
          evidenceIds: input.evidenceIds,
        });
      }
    }
    if (activeCandidateId && tool.name === "recordSpof") {
      const text = stringArg(tool.arguments.text);
      if (text) {
        await recordSpof(context, {
          candidateProcessId: activeCandidateId,
          text,
          evidenceIds: input.evidenceIds,
        });
      }
    }
  }

  for (const slotUpdate of extraction.slot_updates) {
    await updateSlotState(context, {
      slotPath: slotUpdate.slot_path,
      value: slotUpdate.value,
      status: slotUpdate.status,
      confidence: slotUpdate.confidence,
      evidenceIds: slotUpdate.evidence_ids,
      candidates: slotUpdate.candidates,
    });
  }

  if (degradedQuality) {
    await createFollowUpTask(context, {
      taskType: "low_confidence_claim",
      title: "Re-extract degraded director turn",
      description:
        "The transcript was saved, but structured extraction failed and needs a retry.",
      targetType: "capture_session",
      targetId: input.captureSessionId,
      priority: 2,
    });
  }

  const rankedIntents = await rankProbeIntents(context);
  const chosenIntent = rankedIntents[0] ?? fallbackProbeForSlot("scope.boundaries");
  const nextPrompt = phraseProbe(chosenIntent);

  await touchSlotAskedAt(context, chosenIntent.targetSlot);

  const metadata =
    llmResult?.metadata ??
    fallbackMetadata("director.turn.extract-and-rank", started);

  await writeAgentDecision({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    captureSessionId: input.captureSessionId,
    turnIndex: input.turnIndex,
    tsStart: started,
    tsEnd: new Date(),
    transcriptSegmentIds: input.transcriptSegmentIds,
    slotUpdates: extraction.slot_updates,
    rankedProbeIntents: rankedIntents,
    chosenIntent,
    sanitizedAgentUtterance: nextPrompt,
    promptTemplateId: metadata.prompt_template_id,
    promptTemplateVersion: metadata.prompt_template_version,
    toolCalls: extraction.tool_calls,
    model: metadata.model,
    tokenCountInput: metadata.token_count_input,
    tokenCountOutput: metadata.token_count_output,
    costCents: metadata.cost_cents,
    latencyMs: metadata.latency_ms,
    cacheHit: metadata.cache_hit,
    degradedQuality,
  });

  return {
    next_prompt: nextPrompt,
    chosen_intent: chosenIntent,
    ranked_intents: rankedIntents,
    slot_updates: extraction.slot_updates.map((slotUpdate) => ({
      slot_path: slotUpdate.slot_path,
      status: slotUpdate.status,
      confidence: slotUpdate.confidence,
      value: slotUpdate.value,
      evidence_ids: slotUpdate.evidence_ids,
    })),
    candidate_process_ids: candidateProcessIds,
    degraded_quality: degradedQuality,
    metadata: {
      model: metadata.model,
      token_count_input: metadata.token_count_input,
      token_count_output: metadata.token_count_output,
      cost_cents: metadata.cost_cents,
      latency_ms: metadata.latency_ms,
      cache_hit: metadata.cache_hit,
    },
  };
}

function fallbackMetadata(promptTemplateId: string, started: Date) {
  return {
    text: "",
    model: "structured-extraction-failed",
    prompt_template_id: promptTemplateId,
    prompt_template_version: "1",
    token_count_input: 0,
    token_count_output: 0,
    cost_cents: 0,
    latency_ms: Date.now() - started.getTime(),
    cache_hit: false,
    mocked: false,
  };
}

export function buildPromptCacheBlocks(input: {
  currentSlots: Map<string, { status: string; confidence: string | number | null }>;
  recentTurns: string[];
  latestUtterance: string;
}) {
  return {
    staticBlock: [
      "You are the Otto Director Interview Agent.",
      "Extract only evidence-backed director-layer process inventory facts.",
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
      "Current slot state:",
      ...Array.from(input.currentSlots.entries()).map(
        ([slotPath, slot]) => `- ${slotPath}: ${slot.status} (${slot.confidence ?? 0})`,
      ),
      "Recent turns:",
      ...input.recentTurns.slice(-4).map((turn) => `- ${turn}`),
      `Latest utterance: ${input.latestUtterance}`,
    ].join("\n"),
  };
}

const directorExtractionStaticContract = `
Structured output contract:
Return JSON with keys: slot_updates, claims, tool_calls, contradiction_signals.
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
- name: recordProcess, recordSystem, recordPerson, recordPainPoint, recordSpof, updateSlotState, createFollowUpTask.
- arguments: JSON object matching the tool name.
Allowed claim fields:
- process: frequency, description, volume, documentation_maturity, complexity_signal, pain_point, risk, kpi, upstream_dependency, downstream_dependency.
- system: vendor, used_in_process, source_of_truth, shadow_system.
- role: owns_process, participates_in_process, handoff_target.
- person: role, manager, single_point_of_failure.
Evidence discipline:
- Every extracted assertion must cite evidence_ids from the current turn.
- If a statement is implied but not directly said, set confidence <= 0.45 and mark metadata.inferred = true.
- Do not invent process names, system names, people, volumes, KPIs, or risks.
- Preserve original terminology from the director unless normalizing obvious capitalization.
- If a turn contradicts prior slot state, mark the slot conflicting and include contradiction_signals.
Probe-ranking guidance:
- Scope, ownership, and systems are must-fire slots.
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

async function readCurrentSlots(context: DirectorToolContext) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    return tx
      .select()
      .from(slotStates)
      .where(eq(slotStates.captureSessionId, context.captureSessionId));
  });
  return new Map(rows.map((row) => [row.slotPath, row]));
}

async function readRecentTurns(context: DirectorToolContext) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    return tx
      .select({ text: transcriptSegments.text })
      .from(transcriptSegments)
      .where(eq(transcriptSegments.captureSessionId, context.captureSessionId))
      .orderBy(desc(transcriptSegments.createdAt))
      .limit(4);
  });
  return rows.map((row) => row.text).reverse();
}

async function latestCandidateProcessId(context: DirectorToolContext) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    return tx
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
  });
  return rows[0]?.id;
}

async function rankProbeIntents(context: DirectorToolContext): Promise<ProbeIntent[]> {
  const currentSlots = await readCurrentSlots(context);
  const ranked = directorSlotDefinitions
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
      const probe = fallbackProbeForSlot(definition.path);
      return {
        ...probe,
        score: needsProbe ? base + statusBoost + definition.priority : 0,
        reason: needsProbe
          ? `${definition.label} is ${status}.`
          : `${definition.label} already has coverage.`,
      };
    })
    .filter((intent) => intent.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked.length > 0 ? ranked : [fallbackProbeForSlot("friction.pain_points")];
}

function deterministicExtraction(
  utterance: string,
  evidenceIds: string[],
): DirectorExtraction {
  const slotUpdates: Array<{
    slot_path: string;
    value?: unknown;
    status: DirectorSlotStatus;
    confidence: number;
    evidence_ids: string[];
    priority: number;
  }> = [];
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const text = utterance.trim();
  const lower = text.toLowerCase();
  const processName = extractProcessName(text);
  const frequency = extractFrequency(text);
  const systems = extractSystems(text);
  const roleName = extractRole(text);
  const personName = extractPerson(text);

  if (processName) {
    toolCalls.push({
      name: "recordProcess",
      arguments: {
        name: processName,
        frequency,
        complexityHint: extractComplexityHint(text),
        confidence: 0.78,
      },
    });
    slotUpdates.push(
      slotUpdate("scope.boundaries", processBoundaryValue([processName]), evidenceIds, 0.82),
    );
  }
  if (frequency) {
    slotUpdates.push(slotUpdate("frequency.volume", { frequency }, evidenceIds, 0.78));
  }
  if (systems.length > 0) {
    for (const system of systems) {
      toolCalls.push({ name: "recordSystem", arguments: { name: system } });
    }
    slotUpdates.push(slotUpdate("systems.systems_of_record", { systems }, evidenceIds, 0.8));
  }
  if (roleName) {
    slotUpdates.push(
      slotUpdate("ownership.roles", ownershipRolesValue([roleName]), evidenceIds, 0.72),
    );
  }
  if (personName) {
    toolCalls.push({
      name: "recordPerson",
      arguments: { name: personName, roleName },
    });
    slotUpdates.push(slotUpdate("people.key_people", { person: personName }, evidenceIds, 0.7));
  }
  if (/(manual|slow|delay|bottleneck|rework|cleanup|pain|break|stuck)/i.test(text)) {
    toolCalls.push({ name: "recordPainPoint", arguments: { text } });
    slotUpdates.push(slotUpdate("friction.pain_points", { pain_point: text }, evidenceIds, 0.78));
  }
  if (/(only|single point|one person|depends on|tribal knowledge|if .* out)/i.test(lower)) {
    toolCalls.push({ name: "recordSpof", arguments: { text } });
    slotUpdates.push(slotUpdate("risk.spofs", { spof: text }, evidenceIds, 0.76));
  }
  if (/(documented|sop|runbook|wiki|not documented|tribal knowledge)/i.test(text)) {
    slotUpdates.push(
      slotUpdate("documentation.maturity", { maturity_signal: text }, evidenceIds, 0.72),
    );
  }

  return {
    slot_updates: slotUpdates,
    claims: [],
    tool_calls: toolCalls,
    contradiction_signals: [],
  };
}

function slotUpdate(
  slotPath: string,
  value: unknown,
  evidenceIds: string[],
  confidence: number,
) {
  return {
    slot_path: slotPath,
    value,
    status: "filled" as const,
    confidence,
    evidence_ids: evidenceIds,
    priority: slotPriority(slotPath),
  };
}

function extractProcessName(text: string) {
  const patterns = [
    /(?:process is|process called|process:|workflow is|workflow called)\s+([^,.]+)/i,
    /(?:we handle|we run|we manage)\s+([^,.]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return titleCase(cleanPhrase(match[1]));
  }
  return undefined;
}

function extractFrequency(text: string) {
  const match = text.match(
    /\b(daily|weekly|monthly|quarterly|annually|every [^,.]+|\d+\s*(?:times|x)\s*(?:a|per)\s*(?:day|week|month|quarter|year))\b/i,
  );
  return match?.[1];
}

function extractSystems(text: string) {
  const known = [
    "Salesforce",
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
  return known.filter((system) => new RegExp(`\\b${escapeRegExp(system)}\\b`, "i").test(text));
}

function extractRole(text: string) {
  const match = text.match(
    /\b(?:owned by|owner is|accountable owner is|team is|handled by)\s+([^,.]+)/i,
  );
  return match?.[1] ? titleCase(cleanPhrase(match[1])) : undefined;
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

function stringArg(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
