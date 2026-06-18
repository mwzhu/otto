import type { DirectorSlotBacking } from "@/lib/interview/director/slot-policy";

// Phase 1 of the Director Continuous Reconciliation plan
// (docs/DIRECTOR_CONTINUOUS_RECONCILIATION_PLAN.md): typed contracts for the
// reconciliation layer that sits between extraction and durable writes. These
// are the shapes logged into `agent_decision_log.delivery_json.reconciliation`
// and consumed by the dispatcher. No DB access here — types only.

/**
 * Emitted by the extraction model (which has full transcript context) and
 * consumed by the reconciler. Promoted from Open Question #3 so correction
 * intent is decided where the context lives, not regex-matched downstream.
 */
export type DirectorSlotChangeKind =
  | "new" // slot is being populated for the first time
  | "restate" // same fact restated; confirm / no-op
  | "correction" // director is replacing the prior value
  | "addition" // director is adding another true value
  | "scope_split"; // both values are true but for different scopes

export type DirectorExtractedSlotHypothesis = {
  slotPath: string;
  candidateProcessId?: string;
  value: unknown;
  changeKind: DirectorSlotChangeKind;
  confidence: number;
  evidenceIds: string[];
};

export type DirectorReconciliationAction =
  | "create"
  | "confirm"
  | "enrich"
  | "merge"
  | "rename"
  | "demote"
  | "correct"
  | "conflict"
  | "ignore"
  | "needs_clarification";

export type DirectorSlotReconciliationDecision = {
  slotPath: string;
  candidateProcessId?: string;
  backing: DirectorSlotBacking;
  action: DirectorReconciliationAction;
  value?: unknown;
  previousValue?: unknown;
  changeKind?: DirectorSlotChangeKind;
  confidence: number;
  evidenceIds: string[];
  rationale: string;
  followUpQuestion?: string;
};

export type DirectorProcessReconciliationAction =
  | "create_candidate"
  | "merge_candidate"
  | "rename_candidate"
  | "demote_to_candidate_detail"
  | "discard_as_junk"
  | "needs_clarification";

export type DirectorProcessReconciliationDecision = {
  incomingName: string;
  action: DirectorProcessReconciliationAction;
  targetCandidateProcessId?: string;
  canonicalName?: string;
  confidence: number;
  evidenceIds: string[];
  rationale: string;
};

/**
 * The bounded trace blob (Phase 0.5). `agent_decision_log.delivery_json` is
 * re-read on the next turn, so the reconciliation record must stay small:
 * cap decision counts, keep rationale short, store evidence ids only.
 */
export const RECONCILIATION_TRACE_BOUNDS = {
  maxSlotDecisions: 10,
  maxProcessDecisions: 10,
  maxRationaleChars: 240,
} as const;

export type DirectorReconciliationTrace = {
  slot_decisions: DirectorSlotReconciliationDecision[];
  process_decisions: DirectorProcessReconciliationDecision[];
  ambiguous_cases: DirectorSlotReconciliationDecision[];
  llm_reconciler_used: boolean;
  /** Count of decisions dropped to respect the bounds above (never silent). */
  dropped_decisions?: number;
};

export function boundedDirectorReconciliationTrace(input: {
  slotDecisions?: DirectorSlotReconciliationDecision[];
  processDecisions?: DirectorProcessReconciliationDecision[];
  llmReconcilerUsed?: boolean;
}): DirectorReconciliationTrace {
  const slotDecisions = (input.slotDecisions ?? []).map(boundSlotDecision);
  const processDecisions = (input.processDecisions ?? []).map(boundProcessDecision);
  const boundedSlotDecisions = slotDecisions.slice(
    0,
    RECONCILIATION_TRACE_BOUNDS.maxSlotDecisions,
  );
  const boundedProcessDecisions = processDecisions.slice(
    0,
    RECONCILIATION_TRACE_BOUNDS.maxProcessDecisions,
  );
  const droppedDecisions =
    Math.max(0, slotDecisions.length - boundedSlotDecisions.length) +
    Math.max(0, processDecisions.length - boundedProcessDecisions.length);

  return {
    slot_decisions: boundedSlotDecisions,
    process_decisions: boundedProcessDecisions,
    ambiguous_cases: boundedSlotDecisions.filter(
      (decision) =>
        decision.action === "conflict" ||
        decision.action === "needs_clarification",
    ),
    llm_reconciler_used: input.llmReconcilerUsed ?? false,
    ...(droppedDecisions > 0 ? { dropped_decisions: droppedDecisions } : {}),
  };
}

function boundSlotDecision(
  decision: DirectorSlotReconciliationDecision,
): DirectorSlotReconciliationDecision {
  return {
    ...decision,
    rationale: truncateRationale(decision.rationale),
    evidenceIds: decision.evidenceIds.slice(0, 12),
  };
}

function boundProcessDecision(
  decision: DirectorProcessReconciliationDecision,
): DirectorProcessReconciliationDecision {
  return {
    ...decision,
    rationale: truncateRationale(decision.rationale),
    evidenceIds: decision.evidenceIds.slice(0, 12),
  };
}

function truncateRationale(rationale: string): string {
  const trimmed = rationale.trim();
  if (trimmed.length <= RECONCILIATION_TRACE_BOUNDS.maxRationaleChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, RECONCILIATION_TRACE_BOUNDS.maxRationaleChars - 3)}...`;
}
