import { createHash } from "node:crypto";
import { z } from "zod";

import { stableStringify } from "@/lib/http/json";

export const workflowGroundingSchema = z.enum([
  "quoted",
  "observed",
  "documented",
  "inferred",
]);

export const workflowEvidenceSourceTypeSchema = z.enum([
  "transcript",
  "screen_event",
  "visual_observation",
  "document_chunk",
  "slot_state",
  "prior_graph",
  "manual",
]);

export const workflowEvidenceCitationSchema = z.object({
  evidenceId: z.string().min(1),
  sourceType: workflowEvidenceSourceTypeSchema,
  sourceRef: z.string().optional(),
  quote: z.string().optional(),
  grounding: workflowGroundingSchema,
});

export const workflowSemanticStepTypeSchema = z.enum([
  "task",
  "decision",
  "wait",
  "handoff",
  "exception",
  "terminal",
]);

const semanticIoSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  evidenceIds: z.array(z.string().min(1)).default([]),
});

export const workflowSemanticStepSchema = z.object({
  id: z.string().min(1),
  type: workflowSemanticStepTypeSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  actorRole: z.string().optional(),
  systemNames: z.array(z.string().min(1)).default([]),
  inputs: z.array(semanticIoSchema).default([]),
  outputs: z.array(semanticIoSchema).default([]),
  citations: z.array(workflowEvidenceCitationSchema).default([]),
  modelConfidence: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  grounding: workflowGroundingSchema.default("inferred"),
  needsFollowUp: z.boolean().default(false),
  followUpQuestion: z.string().optional(),
  terminalOutcome: z.string().optional(),
});

export const workflowSemanticEdgeTypeSchema = z.enum([
  "sequence",
  "conditional",
  "handoff",
  "exception",
  "loop",
  "parallel",
]);

export const workflowSemanticEdgeSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  targetId: z.string().min(1).optional(),
  targetHint: z.string().optional(),
  type: workflowSemanticEdgeTypeSchema,
  label: z.string().optional(),
  condition: z.string().optional(),
  citations: z.array(workflowEvidenceCitationSchema).default([]),
  modelConfidence: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  grounding: workflowGroundingSchema.default("inferred"),
  needsFollowUp: z.boolean().default(false),
  followUpQuestion: z.string().optional(),
});

export const workflowFollowUpQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().min(1),
  relatedEvidenceIds: z.array(z.string().min(1)).default([]),
});

export const workflowSemanticDiagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  relatedEvidenceIds: z.array(z.string().min(1)).default([]),
});

export const workflowSemanticModelSchema = z.object({
  processName: z.string().optional(),
  steps: z.array(workflowSemanticStepSchema),
  edges: z.array(workflowSemanticEdgeSchema),
  unresolvedQuestions: z.array(workflowFollowUpQuestionSchema).default([]),
  diagnostics: z.array(workflowSemanticDiagnosticSchema).default([]),
});

export const workflowSemanticExtractionSchema = workflowSemanticModelSchema;

export type WorkflowGrounding = z.infer<typeof workflowGroundingSchema>;
export type WorkflowEvidenceSourceType = z.infer<
  typeof workflowEvidenceSourceTypeSchema
>;
export type WorkflowEvidenceCitation = z.infer<
  typeof workflowEvidenceCitationSchema
>;
export type WorkflowSemanticStepType = z.infer<
  typeof workflowSemanticStepTypeSchema
>;
export type WorkflowSemanticStep = z.input<typeof workflowSemanticStepSchema>;
export type WorkflowSemanticEdgeType = z.infer<
  typeof workflowSemanticEdgeTypeSchema
>;
export type WorkflowSemanticEdge = z.input<typeof workflowSemanticEdgeSchema>;
export type WorkflowFollowUpQuestion = z.input<
  typeof workflowFollowUpQuestionSchema
>;
export type WorkflowSemanticDiagnostic = z.input<
  typeof workflowSemanticDiagnosticSchema
>;
export type WorkflowSemanticModel = z.input<typeof workflowSemanticModelSchema>;

export type WorkflowSemanticExtractionResult = {
  model: WorkflowSemanticModel;
  diagnostics: WorkflowSemanticDiagnostic[];
  followUpQuestions: WorkflowFollowUpQuestion[];
};

export type WorkflowSemanticCacheKeyInput = {
  orgId: string;
  workspaceId: string;
  processId: string;
  processName?: string;
  captureSessionIds: string[];
  priorProcessVersionId?: string | null;
  promptTemplateId: string;
  promptTemplateVersion: string;
  modelId: string;
  extractionConfig: Record<string, unknown>;
  redactionVersion?: string | null;
  evidence: unknown;
};

export function computeSemanticEvidencePackHash(
  input: WorkflowSemanticCacheKeyInput,
) {
  return hashSemanticObject({
    schema: "workflow-semantic-evidence-pack-hash-v1",
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    processId: input.processId,
    processName: input.processName ?? null,
    captureSessionIds: [...input.captureSessionIds].sort(),
    priorProcessVersionId: input.priorProcessVersionId ?? null,
    promptTemplateId: input.promptTemplateId,
    promptTemplateVersion: input.promptTemplateVersion,
    modelId: input.modelId,
    extractionConfig: input.extractionConfig,
    redactionVersion: input.redactionVersion ?? null,
    evidence: input.evidence,
  });
}

export function computeSemanticModelHash(model: WorkflowSemanticModel) {
  return hashSemanticObject({
    schema: "workflow-semantic-model-hash-v1",
    model,
  });
}

export function hashSemanticObject(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
