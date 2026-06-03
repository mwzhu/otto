import type { OperatorEvidencePack } from "@/lib/synthesis/operator-process";
import { computeSemanticEvidencePackHash } from "@/lib/workflow/semantic-model";

export type SemanticPromptContextLimits = {
  transcriptSegments: number;
  screenEvents: number;
  visualObservations: number;
  documentChunks: number;
  slotStates: number;
};

export const DEFAULT_SEMANTIC_PROMPT_CONTEXT_LIMITS: SemanticPromptContextLimits =
  {
    transcriptSegments: 16,
    screenEvents: 12,
    visualObservations: 12,
    documentChunks: 8,
    slotStates: 12,
  };

const MAX_TEXT_CHARS = 700;
const MAX_VISUAL_JSON_CHARS = 900;
const MAX_PROCESS_CLAIMS = 12;

export type SemanticPromptContext = ReturnType<
  typeof buildSemanticPromptContext
>;

export function buildSemanticPromptContext(
  pack: OperatorEvidencePack,
  limits: SemanticPromptContextLimits = DEFAULT_SEMANTIC_PROMPT_CONTEXT_LIMITS,
) {
  const transcriptCandidates = pack.transcriptSegments
    .filter(
      (segment) => !overlapsRedaction(pack, segment.startMs, segment.endMs),
    )
    .sort((a, b) => a.startMs - b.startMs);
  const transcriptSegments = takeChronologicalSamples(
    transcriptCandidates,
    limits.transcriptSegments,
  ).map((segment) => ({
    id: segment.id,
    text: compactText(segment.text, MAX_TEXT_CHARS),
    startMs: segment.startMs,
    endMs: segment.endMs,
    evidenceIds: segment.evidenceIds,
  }));

  const screenEventCandidates = pack.screenEvents
    .filter((event) => !overlapsRedaction(pack, event.tsMs, event.tsMs))
    .sort((a, b) => a.tsMs - b.tsMs);
  const screenEvents = takeChronologicalSamples(
    screenEventCandidates,
    limits.screenEvents,
  ).map((event) => ({
    id: event.id,
    tsMs: event.tsMs,
    label: compactText(event.label, 160),
    appName: event.appName,
    windowTitle: compactText(event.windowTitle, 160),
    ocrText: compactText(event.ocrText, MAX_TEXT_CHARS),
    signalTags: event.signalTags,
    evidenceIds: event.evidenceIds,
  }));

  const visualObservationCandidates = (pack.visualObservations ?? [])
    .filter(
      (observation) =>
        !overlapsRedaction(pack, observation.tsMs, observation.tsMs),
    )
    .sort((a, b) => a.tsMs - b.tsMs);
  const visualObservations = takeChronologicalSamples(
    visualObservationCandidates,
    limits.visualObservations,
  ).map((observation) => ({
    id: observation.id,
    tsMs: observation.tsMs,
    provider: observation.provider,
    uiSummary: compactText(observation.uiSummary, MAX_TEXT_CHARS),
    ocrText: compactText(observation.ocrText, MAX_TEXT_CHARS),
    structuredJson: compactStructuredJson(observation.structuredJson),
    confidence: observation.confidence,
    evidenceIds: observation.evidenceIds,
    degradedReasons: observation.degradedReasons,
  }));

  const documentChunkCandidates = [...pack.documentChunks].sort(
    (a, b) => a.ordinal - b.ordinal,
  );
  const documentChunks = takeChronologicalSamples(
    documentChunkCandidates,
    limits.documentChunks,
  ).map((chunk) => ({
    id: chunk.id,
    ordinal: chunk.ordinal,
    text: compactText(chunk.text, MAX_TEXT_CHARS),
    evidenceIds: chunk.evidenceIds,
  }));

  const slotStates = pack.slotStates
    .slice(0, limits.slotStates)
    .map((slot) => ({
      id: slot.id,
      slotPath: slot.slotPath,
      value: slot.value,
      status: slot.status,
      confidence: slot.confidence,
      evidenceIds: slot.evidenceIds,
    }));

  const context = {
    process: {
      id: pack.processId,
      name: pack.processName,
      priorVersion: pack.priorVersion
        ? {
            id: pack.priorVersion.id,
            versionNumber: pack.priorVersion.versionNumber,
            status: pack.priorVersion.status,
            summary: pack.priorVersion.summary,
          }
        : null,
    },
    captureSessionIds: pack.captureSessionIds,
    transcriptSegments,
    screenEvents,
    visualObservations,
    documentChunks,
    slotStates,
    processClaims: (pack.processClaims ?? [])
      .slice(0, MAX_PROCESS_CLAIMS)
      .map((claim) => ({
        id: claim.id,
        subjectType: claim.subjectType,
        field: claim.field,
        value: compactUnknown(claim.value, 450),
        confidence: claim.confidence,
        evidenceIds: claim.evidenceIds,
      })),
    omitted: {
      transcriptSegments: Math.max(
        0,
        pack.transcriptSegments.length - transcriptSegments.length,
      ),
      screenEvents: Math.max(0, pack.screenEvents.length - screenEvents.length),
      visualObservations: Math.max(
        0,
        (pack.visualObservations ?? []).length - visualObservations.length,
      ),
      documentChunks: Math.max(
        0,
        pack.documentChunks.length - documentChunks.length,
      ),
      slotStates: Math.max(0, pack.slotStates.length - slotStates.length),
    },
  };

  return {
    context,
    evidencePackHash: computeSemanticEvidencePackHash({
      orgId: pack.orgId,
      workspaceId: pack.workspaceId,
      processId: pack.processId,
      processName: pack.processName,
      captureSessionIds: pack.captureSessionIds,
      priorProcessVersionId: pack.priorVersion?.id ?? null,
      promptTemplateId: "operator.workflow_semantic_extraction",
      promptTemplateVersion: "1",
      modelId: "configured-at-runtime",
      extractionConfig: limits,
      redactionVersion: redactionVersion(pack),
      evidence: context,
    }),
  };
}

export function semanticPromptContextToText(
  context: SemanticPromptContext["context"],
) {
  return [
    "You are the operator workflow semantic extractor.",
    "Extract business workflow logic from this operator screenshare interview evidence.",
    "",
    "Hard rules:",
    "- Keep output compact: prefer 3-8 core business steps, short titles, and only include descriptions, inputs, and outputs when they add business meaning.",
    "- Do not create steps from technical capture mechanics such as keyframes, uploads, OCR pending states, LiveKit, previews, recording buffers, frame samples, or file names like operator-capture.webm.",
    "- The workflow must contain business semantics only: tasks, decisions, waits, handoffs, exceptions, loops, systems, inputs, outputs, roles, evidence, confidence, and follow-up questions.",
    "- The model owns topology. Propose sourceId/targetId edges for order, decisions, branches, exception loops, wait releases, and handoffs.",
    "- Every step and edge must cite real evidence IDs from this pack. Do not invent evidence IDs.",
    "- Include short exact quotes when text evidence exists. Keep quotes under 25 words when possible.",
    "- Decision titles should be questions, for example Supplier funding confirmed? or Data entry accurate?",
    "- Decisions need two grounded branches. If one branch is inferred, set grounding to inferred, needsFollowUp to true, and include a followUpQuestion.",
    "- If a branch target is uncertain, use unresolvedQuestions instead of creating a dangling edge.",
    "- Mark direct transcript/document quotes as quoted or documented. Mark screen/OCR observations as observed. Mark unsupported but useful topology as inferred and low-confidence.",
    "- Use concise business titles such as Align on promo proposal with category team, Wait for supplier funding approval, Resolve data errors and resubmit.",
    "- Do not copy long evidence text into descriptions or diagnostics.",
    "",
    "Return only JSON matching WorkflowSemanticModel:",
    "- processName?: string",
    "- steps: [{ id, type, title, description?, actorRole?, systemNames?, inputs?, outputs?, citations, modelConfidence?, grounding, needsFollowUp?, followUpQuestion? }]",
    "- edges: [{ id, sourceId, targetId, type, label?, condition?, citations, modelConfidence?, grounding, needsFollowUp?, followUpQuestion? }]",
    "- unresolvedQuestions: [{ id, question, reason, relatedEvidenceIds }]",
    "- diagnostics: [{ code, message, relatedEvidenceIds }]",
    "",
    "Evidence priority:",
    "1. Operator narration.",
    "2. OCR/UI text and structured visual observations.",
    "3. Documents and prior process claims.",
    "4. Screen signal tags only as supporting context, never as node titles.",
    "",
    "Evidence pack JSON:",
    JSON.stringify(context),
  ].join("\n");
}

function compactStructuredJson(value: unknown) {
  if (value == null) return value;
  return compactUnknown(value, MAX_VISUAL_JSON_CHARS);
}

function compactUnknown(value: unknown, maxChars: number) {
  if (typeof value === "string") return compactText(value, maxChars);
  const serialized = JSON.stringify(value);
  if (!serialized) return value;
  const compacted = compactText(serialized, maxChars) ?? "";
  try {
    return JSON.parse(compacted);
  } catch {
    return compacted;
  }
}

function compactText(value: string | null | undefined, maxChars: number) {
  if (!value) return value;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()} ... [truncated]`;
}

function overlapsRedaction(
  pack: OperatorEvidencePack,
  startMs: number,
  endMs: number,
) {
  return (pack.redactionWindows ?? []).some(
    (window) =>
      window.status !== "failed" &&
      startMs <= window.endMs &&
      endMs >= window.startMs,
  );
}

function redactionVersion(pack: OperatorEvidencePack) {
  const windows = pack.redactionWindows ?? [];
  if (windows.length === 0) return null;
  return windows
    .map(
      (window) =>
        `${window.id}:${window.status}:${window.startMs}:${window.endMs}`,
    )
    .sort()
    .join("|");
}

function takeChronologicalSamples<T>(items: T[], limit: number) {
  if (limit <= 0) return [];
  if (items.length <= limit) return items;
  if (limit === 1) return [items[0]];

  const selectedIndexes = new Set<number>();
  const maxIndex = items.length - 1;
  for (let index = 0; index < limit; index += 1) {
    selectedIndexes.add(Math.round((index * maxIndex) / (limit - 1)));
  }

  let backfillIndex = 0;
  while (selectedIndexes.size < limit && backfillIndex < items.length) {
    selectedIndexes.add(backfillIndex);
    backfillIndex += 1;
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => items[index]);
}
