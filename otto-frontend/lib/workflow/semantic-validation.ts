import type {
  WorkflowEvidenceCitation,
  WorkflowGrounding,
  WorkflowSemanticEdge,
  WorkflowSemanticModel,
  WorkflowSemanticStep,
} from "@/lib/workflow/semantic-model";

export type WorkflowSemanticValidationIssue = {
  code:
    | "duplicate_step_id"
    | "duplicate_edge_id"
    | "missing_step"
    | "dangling_edge"
    | "unresolved_topology_target"
    | "hallucinated_evidence_id"
    | "redacted_evidence_id"
    | "quoted_citation_missing_quote"
    | "quote_not_found_in_evidence"
    | "technical_capture_artifact"
    | "decision_missing_branch"
    | "inferred_without_followup";
  message: string;
  stepId?: string;
  edgeId?: string;
  evidenceId?: string;
};

export type WorkflowSemanticValidationResult = {
  ok: boolean;
  model: WorkflowSemanticModel;
  issues: WorkflowSemanticValidationIssue[];
};

export type WorkflowSemanticValidationInput = {
  model: WorkflowSemanticModel;
  evidenceById?:
    | Map<string, string | null | undefined>
    | Record<string, string | null | undefined>;
  redactedEvidenceIds?: Set<string> | string[];
};

const TECHNICAL_CAPTURE_PATTERNS = [
  /\bkeyframe candidate\b/i,
  /\boperator-capture\.webm\b/i,
  /\bscreen recording upload\b/i,
  /\bvideo keyframe\b/i,
  /\bocr pending\b/i,
  /\blivekit\b/i,
  /\blive preview\b/i,
];

export function validateWorkflowSemanticModel(
  input: WorkflowSemanticValidationInput,
): WorkflowSemanticValidationResult {
  const issues: WorkflowSemanticValidationIssue[] = [];
  const evidenceById = normalizeEvidenceLookup(input.evidenceById);
  const redactedEvidenceIds = new Set(input.redactedEvidenceIds ?? []);
  const stepIds = new Set<string>();
  const edgeIds = new Set<string>();

  for (const step of input.model.steps) {
    if (stepIds.has(step.id)) {
      issues.push({
        code: "duplicate_step_id",
        message: `Duplicate semantic step id ${step.id}.`,
        stepId: step.id,
      });
    }
    stepIds.add(step.id);
    validateTitle(step.title, issues, step.id);
    validateCitations(step.citations ?? [], {
      evidenceById,
      redactedEvidenceIds,
      issues,
      stepId: step.id,
    });
    validateInferenceFollowUp(step, issues);
  }

  if (input.model.steps.length === 0) {
    issues.push({
      code: "missing_step",
      message: "Semantic workflow model must contain at least one step.",
    });
  }

  for (const edge of input.model.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: "duplicate_edge_id",
        message: `Duplicate semantic edge id ${edge.id}.`,
        edgeId: edge.id,
      });
    }
    edgeIds.add(edge.id);
    if (
      !stepIds.has(edge.sourceId) ||
      !edge.targetId ||
      !stepIds.has(edge.targetId)
    ) {
      issues.push({
        code: edge.targetId ? "dangling_edge" : "unresolved_topology_target",
        message: `Semantic edge ${edge.id} references a missing source or target step.`,
        edgeId: edge.id,
      });
    }
    validateCitations(edge.citations ?? [], {
      evidenceById,
      redactedEvidenceIds,
      issues,
      edgeId: edge.id,
    });
    validateInferenceFollowUp(edge, issues);
  }

  validateDecisionCardinality(input.model, issues);

  const verifiedModel = applyVerifierConfidence(input.model);
  return { ok: issues.length === 0, model: verifiedModel, issues };
}

function validateTitle(
  title: string,
  issues: WorkflowSemanticValidationIssue[],
  stepId: string,
) {
  if (!TECHNICAL_CAPTURE_PATTERNS.some((pattern) => pattern.test(title)))
    return;
  issues.push({
    code: "technical_capture_artifact",
    message: "Technical capture labels cannot be published as workflow steps.",
    stepId,
  });
}

function validateCitations(
  citations: WorkflowEvidenceCitation[],
  context: {
    evidenceById: Map<string, string | null | undefined> | null;
    redactedEvidenceIds: Set<string>;
    issues: WorkflowSemanticValidationIssue[];
    stepId?: string;
    edgeId?: string;
  },
) {
  for (const citation of citations) {
    const evidenceText = context.evidenceById?.get(citation.evidenceId);
    if (
      context.evidenceById &&
      !context.evidenceById.has(citation.evidenceId)
    ) {
      context.issues.push({
        code: "hallucinated_evidence_id",
        message: `Citation references unknown evidence id ${citation.evidenceId}.`,
        stepId: context.stepId,
        edgeId: context.edgeId,
        evidenceId: citation.evidenceId,
      });
    }
    if (context.redactedEvidenceIds.has(citation.evidenceId)) {
      context.issues.push({
        code: "redacted_evidence_id",
        message: `Citation references redacted evidence id ${citation.evidenceId}.`,
        stepId: context.stepId,
        edgeId: context.edgeId,
        evidenceId: citation.evidenceId,
      });
    }
    if (
      citation.grounding === "quoted" &&
      (!citation.quote?.trim() || evidenceText == null)
    ) {
      context.issues.push({
        code: "quoted_citation_missing_quote",
        message: `Quoted citation for evidence id ${citation.evidenceId} must include a verifiable quote.`,
        stepId: context.stepId,
        edgeId: context.edgeId,
        evidenceId: citation.evidenceId,
      });
    } else if (
      citation.grounding === "quoted" &&
      citation.quote &&
      evidenceText != null &&
      !quoteMatchesEvidence(citation.quote, evidenceText)
    ) {
      context.issues.push({
        code: "quote_not_found_in_evidence",
        message: `Quoted citation text was not found in evidence id ${citation.evidenceId}.`,
        stepId: context.stepId,
        edgeId: context.edgeId,
        evidenceId: citation.evidenceId,
      });
    }
  }
}

function validateInferenceFollowUp(
  item: WorkflowSemanticStep | WorkflowSemanticEdge,
  issues: WorkflowSemanticValidationIssue[],
) {
  if ((item.grounding ?? "inferred") !== "inferred") return;
  if (item.needsFollowUp && item.followUpQuestion?.trim()) return;
  issues.push({
    code: "inferred_without_followup",
    message:
      "Inferred semantic claims must create or link to a follow-up question.",
    stepId: "sourceId" in item ? undefined : item.id,
    edgeId: "sourceId" in item ? item.id : undefined,
  });
}

function validateDecisionCardinality(
  model: WorkflowSemanticModel,
  issues: WorkflowSemanticValidationIssue[],
) {
  const outgoing = new Map<string, WorkflowSemanticEdge[]>();
  for (const edge of model.edges) {
    const edges = outgoing.get(edge.sourceId) ?? [];
    edges.push(edge);
    outgoing.set(edge.sourceId, edges);
  }
  for (const step of model.steps) {
    if (step.type !== "decision") continue;
    const branches = (outgoing.get(step.id) ?? []).filter(
      (edge) =>
        edge.type === "conditional" ||
        edge.type === "exception" ||
        edge.type === "loop",
    );
    const groundedBranches = branches.filter(
      (edge) => (edge.grounding ?? "inferred") !== "inferred",
    );
    const inferredBranchesWithFollowUp = branches.filter(
      (edge) =>
        (edge.grounding ?? "inferred") === "inferred" &&
        edge.needsFollowUp &&
        Boolean(edge.followUpQuestion?.trim()),
    );
    if (
      groundedBranches.length >= 2 ||
      (groundedBranches.length === 1 &&
        inferredBranchesWithFollowUp.length >= 1)
    ) {
      continue;
    }
    issues.push({
      code: "decision_missing_branch",
      message:
        "Decision nodes need two grounded branches or one grounded branch plus a low-confidence inferred branch with follow-up.",
      stepId: step.id,
    });
  }
}

export function applyVerifierConfidence(
  model: WorkflowSemanticModel,
): WorkflowSemanticModel {
  return {
    ...model,
    steps: model.steps.map((step) => ({
      ...step,
      confidence: verifierConfidenceForGrounding(step.grounding ?? "inferred"),
    })),
    edges: model.edges.map((edge) => ({
      ...edge,
      confidence: verifierConfidenceForGrounding(edge.grounding ?? "inferred"),
    })),
  };
}

function verifierConfidenceForGrounding(grounding: WorkflowGrounding) {
  switch (grounding) {
    case "quoted":
    case "documented":
      return 0.82;
    case "observed":
      return 0.64;
    case "inferred":
      return 0.42;
  }
}

function normalizeEvidenceLookup(
  lookup: WorkflowSemanticValidationInput["evidenceById"],
) {
  if (!lookup) return null;
  return lookup instanceof Map ? lookup : new Map(Object.entries(lookup));
}

export function quoteMatchesEvidence(quote: string, evidenceText: string) {
  const normalizedQuote = normalizeText(quote);
  const normalizedEvidence = normalizeText(evidenceText);
  if (!normalizedQuote) return true;
  if (normalizedEvidence.includes(normalizedQuote)) return true;

  const quoteTokens = normalizedQuote.split(" ").filter(Boolean);
  if (quoteTokens.length > 25) return false;

  const evidenceTokens = new Set(normalizedEvidence.split(" ").filter(Boolean));
  const overlap = quoteTokens.filter((token) =>
    evidenceTokens.has(token),
  ).length;
  return overlap / Math.max(quoteTokens.length, 1) >= 0.8;
}

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
