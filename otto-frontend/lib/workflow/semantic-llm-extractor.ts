import "server-only";

import {
  StructuredOutputError,
  structured,
  type Generation,
} from "@/lib/adapters/llm";
import { anthropicModelForPrompt } from "@/lib/ai/models";
import { getServerEnv } from "@/lib/env";
import type { OperatorEvidencePack } from "@/lib/synthesis/operator-process";
import {
  DEFAULT_SEMANTIC_PROMPT_CONTEXT_LIMITS,
  buildSemanticPromptContext,
  semanticPromptContextToText,
  type SemanticPromptContextLimits,
} from "@/lib/workflow/semantic-context";
import {
  computeSemanticEvidencePackHash,
  computeSemanticModelHash,
  hashSemanticObject,
  workflowSemanticModelSchema,
  type WorkflowSemanticExtractionResult,
  type WorkflowSemanticModel,
} from "@/lib/workflow/semantic-model";
import {
  quoteMatchesEvidence,
  validateWorkflowSemanticModel,
  type WorkflowSemanticValidationIssue,
} from "@/lib/workflow/semantic-validation";

export type WorkflowSemanticLlmExtraction = WorkflowSemanticExtractionResult & {
  evidencePackHash: string;
  semanticModelHash: string;
  metadata: Generation;
  validationIssues: WorkflowSemanticValidationIssue[];
  promptTemplateId: string;
  promptTemplateVersion: string;
  modelId: string;
  llmRequestHash: string;
  llmResponseHash: string;
  rawModel: WorkflowSemanticModel;
};

export const RETRY_SEMANTIC_PROMPT_CONTEXT_LIMITS: SemanticPromptContextLimits =
  {
    transcriptSegments: 8,
    screenEvents: 6,
    visualObservations: 6,
    documentChunks: 4,
    slotStates: 8,
  };

export async function extractWorkflowSemanticModel(input: {
  pack: OperatorEvidencePack;
  limits?: SemanticPromptContextLimits;
  mock?: WorkflowSemanticModel;
}): Promise<WorkflowSemanticLlmExtraction> {
  const limits = input.limits ?? DEFAULT_SEMANTIC_PROMPT_CONTEXT_LIMITS;
  try {
    return await extractWorkflowSemanticModelWithLimits(input, limits);
  } catch (error) {
    if (!isStructuredTruncationError(error) || input.mock) throw error;
    return extractWorkflowSemanticModelWithLimits(
      input,
      retryLimitsFor(limits),
      "compact_retry",
    );
  }
}

async function extractWorkflowSemanticModelWithLimits(
  input: {
    pack: OperatorEvidencePack;
    mock?: WorkflowSemanticModel;
  },
  limits: SemanticPromptContextLimits,
  attempt?: "compact_retry",
): Promise<WorkflowSemanticLlmExtraction> {
  const promptContext = buildSemanticPromptContext(input.pack, limits);
  const promptTemplateId = "operator.workflow_semantic_extraction";
  const promptTemplateVersion = attempt === "compact_retry" ? "1-compact" : "1";
  const { value, metadata } = await structured({
    prompt_template_id: promptTemplateId,
    prompt_template_version: promptTemplateVersion,
    schema_name: "WorkflowSemanticModel",
    schema: workflowSemanticModelSchema,
    input: semanticPromptContextToText(promptContext.context),
    anthropic_tool: {
      name: "emit_workflow_semantic_model",
      description:
        "Emit a compact, evidence-grounded business workflow semantic model from the operator screenshare interview pack.",
      input_schema: workflowSemanticModelAnthropicToolSchema,
    },
    mock: input.mock,
  });
  const env = getServerEnv();
  const modelId =
    metadata.model || anthropicModelForPrompt(env, promptTemplateId);
  const evidenceById = evidenceTextById(input.pack);
  const normalizedValue = normalizeQuotedCitations(
    normalizeInferredFollowUps(value),
    evidenceById,
  );
  const evidencePackHash = computeSemanticEvidencePackHash({
    orgId: input.pack.orgId,
    workspaceId: input.pack.workspaceId,
    processId: input.pack.processId,
    processName: input.pack.processName,
    captureSessionIds: input.pack.captureSessionIds,
    priorProcessVersionId: input.pack.priorVersion?.id ?? null,
    promptTemplateId,
    promptTemplateVersion,
    modelId,
    extractionConfig: limits,
    redactionVersion: redactionVersion(input.pack),
    evidence: promptContext.context,
  });
  const validation = validateWorkflowSemanticModel({
    model: normalizedValue,
    evidenceById,
    redactedEvidenceIds: redactedEvidenceIdsByTime(input.pack),
  });
  const diagnostics = [
    ...(normalizedValue.diagnostics ?? []),
    ...validation.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      relatedEvidenceIds: issue.evidenceId ? [issue.evidenceId] : [],
    })),
  ];
  return {
    model: validation.model,
    diagnostics,
    followUpQuestions: normalizedValue.unresolvedQuestions ?? [],
    evidencePackHash,
    semanticModelHash: computeSemanticModelHash(validation.model),
    metadata,
    validationIssues: validation.issues,
    promptTemplateId,
    promptTemplateVersion,
    modelId,
    llmRequestHash: hashSemanticObject(promptContext.context),
    llmResponseHash: hashSemanticObject(value),
    rawModel: value,
  };
}

function normalizeQuotedCitations(
  model: WorkflowSemanticModel,
  evidenceById: Map<string, string>,
): WorkflowSemanticModel {
  return {
    ...model,
    steps: model.steps.map((step) => {
      const citations = normalizeCitationList(step.citations ?? [], evidenceById);
      return {
        ...step,
        citations,
        grounding: normalizeItemGrounding(step.grounding, citations),
      };
    }),
    edges: model.edges.map((edge) => {
      const citations = normalizeCitationList(edge.citations ?? [], evidenceById);
      return {
        ...edge,
        citations,
        grounding: normalizeItemGrounding(edge.grounding, citations),
      };
    }),
  };
}

function normalizeCitationList<
  T extends {
    evidenceId: string;
    sourceType: string;
    quote?: string;
    grounding: "quoted" | "observed" | "documented" | "inferred";
  },
>(citations: T[], evidenceById: Map<string, string>) {
  return citations.map((citation) => {
    if (citation.grounding !== "quoted") return citation;
    const evidenceText = evidenceById.get(citation.evidenceId);
    if (
      citation.quote?.trim() &&
      evidenceText &&
      quoteMatchesEvidence(citation.quote, evidenceText)
    ) {
      return citation;
    }
    const { quote: _quote, ...rest } = citation;
    return {
      ...rest,
      grounding:
        citation.sourceType === "document_chunk" ? "documented" : "observed",
    } as T;
  });
}

function normalizeItemGrounding<
  T extends { grounding: "quoted" | "observed" | "documented" | "inferred" },
>(grounding: T["grounding"] | undefined, citations: T[]) {
  if (grounding !== "quoted") return grounding;
  if (citations.some((citation) => citation.grounding === "quoted")) {
    return "quoted";
  }
  if (citations.some((citation) => citation.grounding === "documented")) {
    return "documented";
  }
  if (citations.some((citation) => citation.grounding === "observed")) {
    return "observed";
  }
  return "inferred";
}

function normalizeInferredFollowUps(
  model: WorkflowSemanticModel,
): WorkflowSemanticModel {
  return {
    ...model,
    steps: model.steps.map((step) => {
      if ((step.grounding ?? "inferred") !== "inferred") return step;
      const followUpQuestion =
        step.followUpQuestion?.trim() ||
        `Validate inferred workflow step: ${step.title}.`;
      return {
        ...step,
        needsFollowUp: true,
        followUpQuestion,
      };
    }),
    edges: model.edges.map((edge) => {
      if ((edge.grounding ?? "inferred") !== "inferred") return edge;
      const label = edge.label || edge.condition || edge.targetHint;
      const followUpQuestion =
        edge.followUpQuestion?.trim() ||
        `Validate inferred workflow path from ${edge.sourceId}` +
          `${edge.targetId ? ` to ${edge.targetId}` : ""}` +
          `${label ? ` (${label})` : ""}.`;
      return {
        ...edge,
        needsFollowUp: true,
        followUpQuestion,
      };
    }),
  };
}

function retryLimitsFor(
  limits: SemanticPromptContextLimits,
): SemanticPromptContextLimits {
  return {
    transcriptSegments: Math.min(
      limits.transcriptSegments,
      RETRY_SEMANTIC_PROMPT_CONTEXT_LIMITS.transcriptSegments,
    ),
    screenEvents: Math.min(
      limits.screenEvents,
      RETRY_SEMANTIC_PROMPT_CONTEXT_LIMITS.screenEvents,
    ),
    visualObservations: Math.min(
      limits.visualObservations,
      RETRY_SEMANTIC_PROMPT_CONTEXT_LIMITS.visualObservations,
    ),
    documentChunks: Math.min(
      limits.documentChunks,
      RETRY_SEMANTIC_PROMPT_CONTEXT_LIMITS.documentChunks,
    ),
    slotStates: Math.min(
      limits.slotStates,
      RETRY_SEMANTIC_PROMPT_CONTEXT_LIMITS.slotStates,
    ),
  };
}

function isStructuredTruncationError(error: unknown) {
  return (
    error instanceof StructuredOutputError &&
    /truncated|max_tokens/i.test(error.message)
  );
}

export const workflowSemanticModelAnthropicToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["processName", "steps", "edges", "unresolvedQuestions", "diagnostics"],
  properties: {
    processName: { type: "string" },
    steps: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "title", "citations", "grounding"],
        properties: {
          id: { type: "string" },
          type: {
            type: "string",
            enum: ["task", "decision", "wait", "handoff", "exception", "terminal"],
          },
          title: { type: "string", maxLength: 120 },
          description: { type: "string", maxLength: 220 },
          actorRole: { type: "string", maxLength: 80 },
          systemNames: { type: "array", maxItems: 6, items: { type: "string" } },
          inputs: {
            type: "array",
            maxItems: 4,
            items: { $ref: "#/$defs/io" },
          },
          outputs: {
            type: "array",
            maxItems: 4,
            items: { $ref: "#/$defs/io" },
          },
          citations: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: { $ref: "#/$defs/citation" },
          },
          modelConfidence: { type: "number", minimum: 0, maximum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          grounding: {
            type: "string",
            enum: ["quoted", "observed", "documented", "inferred"],
          },
          needsFollowUp: { type: "boolean" },
          followUpQuestion: { type: "string", maxLength: 180 },
          terminalOutcome: { type: "string", maxLength: 120 },
        },
      },
    },
    edges: {
      type: "array",
      maxItems: 18,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "sourceId", "type", "citations", "grounding"],
        properties: {
          id: { type: "string" },
          sourceId: { type: "string" },
          targetId: { type: "string" },
          targetHint: { type: "string", maxLength: 120 },
          type: {
            type: "string",
            enum: ["sequence", "conditional", "handoff", "exception", "loop", "parallel"],
          },
          label: { type: "string", maxLength: 60 },
          condition: { type: "string", maxLength: 140 },
          citations: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: { $ref: "#/$defs/citation" },
          },
          modelConfidence: { type: "number", minimum: 0, maximum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          grounding: {
            type: "string",
            enum: ["quoted", "observed", "documented", "inferred"],
          },
          needsFollowUp: { type: "boolean" },
          followUpQuestion: { type: "string", maxLength: 180 },
        },
      },
    },
    unresolvedQuestions: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "reason", "relatedEvidenceIds"],
        properties: {
          id: { type: "string" },
          question: { type: "string", maxLength: 180 },
          reason: { type: "string", maxLength: 180 },
          relatedEvidenceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    diagnostics: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "relatedEvidenceIds"],
        properties: {
          code: { type: "string" },
          message: { type: "string", maxLength: 220 },
          relatedEvidenceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  $defs: {
    io: {
      type: "object",
      additionalProperties: false,
      required: ["name", "evidenceIds"],
      properties: {
        name: { type: "string", maxLength: 100 },
        description: { type: "string", maxLength: 160 },
        evidenceIds: { type: "array", items: { type: "string" } },
      },
    },
    citation: {
      type: "object",
      additionalProperties: false,
      required: ["evidenceId", "sourceType", "grounding"],
      properties: {
        evidenceId: { type: "string" },
        sourceType: {
          type: "string",
          enum: [
            "transcript",
            "screen_event",
            "visual_observation",
            "document_chunk",
            "slot_state",
            "prior_graph",
            "manual",
          ],
        },
        sourceRef: { type: "string", maxLength: 80 },
        quote: { type: "string", maxLength: 220 },
        grounding: {
          type: "string",
          enum: ["quoted", "observed", "documented", "inferred"],
        },
      },
    },
  },
} as const;

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

function evidenceTextById(pack: OperatorEvidencePack) {
  const evidence = new Map<string, string>();
  for (const segment of pack.transcriptSegments) {
    for (const evidenceId of segment.evidenceIds) {
      evidence.set(evidenceId, segment.text);
    }
  }
  for (const event of pack.screenEvents) {
    const text = [event.label, event.ocrText, event.appName, event.windowTitle]
      .filter(Boolean)
      .join("\n");
    for (const evidenceId of event.evidenceIds) {
      evidence.set(evidenceId, text);
    }
  }
  for (const observation of pack.visualObservations ?? []) {
    const text = [
      observation.uiSummary,
      observation.ocrText,
      JSON.stringify(observation.structuredJson),
    ]
      .filter(Boolean)
      .join("\n");
    for (const evidenceId of observation.evidenceIds) {
      evidence.set(evidenceId, text);
    }
  }
  for (const chunk of pack.documentChunks) {
    for (const evidenceId of chunk.evidenceIds) {
      evidence.set(evidenceId, chunk.text);
    }
  }
  for (const slot of pack.slotStates) {
    for (const evidenceId of slot.evidenceIds) {
      evidence.set(evidenceId, JSON.stringify(slot.value));
    }
  }
  for (const claim of pack.processClaims ?? []) {
    for (const item of claim.evidenceTexts ?? []) {
      evidence.set(item.id, item.text ?? JSON.stringify(claim.value));
    }
    for (const evidenceId of claim.evidenceIds) {
      if (evidence.has(evidenceId)) continue;
      evidence.set(evidenceId, JSON.stringify(claim.value));
    }
  }
  return evidence;
}

function redactedEvidenceIdsByTime(pack: OperatorEvidencePack) {
  const redactedIds = new Set<string>();
  for (const segment of pack.transcriptSegments) {
    if (!overlapsRedaction(pack, segment.startMs, segment.endMs)) continue;
    for (const evidenceId of segment.evidenceIds) redactedIds.add(evidenceId);
  }
  for (const event of pack.screenEvents) {
    if (!overlapsRedaction(pack, event.tsMs, event.tsMs)) continue;
    for (const evidenceId of event.evidenceIds) redactedIds.add(evidenceId);
  }
  for (const observation of pack.visualObservations ?? []) {
    if (!overlapsRedaction(pack, observation.tsMs, observation.tsMs)) continue;
    for (const evidenceId of observation.evidenceIds)
      redactedIds.add(evidenceId);
  }
  return redactedIds;
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
