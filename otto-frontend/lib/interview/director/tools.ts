import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  auditLog,
  candidateProcesses,
  evidence,
  followUpTasks,
  people,
  roles,
  slotStates,
  systems,
} from "@/lib/db/schema";
import {
  writeClaim,
  writeClaimInTransaction,
  type ClaimWriteTx,
  type WriteClaimInput,
} from "@/lib/db/write-claim";
import {
  assertDirectorSlotPath,
  slotPriority,
  type DirectorSlotStatus,
} from "@/lib/interview/director/slot-schema";
import { normalizeDirectorSlotValue } from "@/lib/interview/director/slot-values";
import { isNonAnswerSlotExtraction } from "@/lib/interview/director/slot-non-answer";
import {
  directorSlotPolicy,
  mergeSlotStringLists,
  slotValuesEqual,
} from "@/lib/interview/director/slot-policy";
import type {
  DirectorProcessReconciliationDecision,
  DirectorSlotChangeKind,
  DirectorSlotReconciliationDecision,
} from "@/lib/interview/director/reconciliation";
import { stableStringify } from "@/lib/http/json";
import { sanitizeForLogs, sanitizeJsonForLogs } from "@/lib/security/sanitize";
import {
  candidateNameTokenSet,
  isPlausibleCandidateProcessName,
  isTokenSubset,
} from "@/lib/candidate-processes/name-quality";
import { canonicalizeSystemName } from "@/lib/systems/canonicalize";

export type DirectorToolContext = {
  orgId: string;
  workspaceId: string;
  captureSessionId: string;
  userId: string;
};

export type SlotUpdateInput = {
  slotPath: string;
  candidateProcessId?: string;
  value?: unknown;
  status: DirectorSlotStatus;
  confidence: number;
  evidenceIds?: string[];
  candidates?: unknown[];
  lastAskedAt?: Date;
  changeKind?: DirectorSlotChangeKind;
};

type DirectorToolTx = ClaimWriteTx;
type DirectorToolOptions = {
  tx?: DirectorToolTx;
  onSlotReconciliationDecision?: (
    decision: DirectorSlotReconciliationDecision,
  ) => void;
  onProcessReconciliationDecision?: (
    decision: DirectorProcessReconciliationDecision,
  ) => void;
};

export async function createTranscriptEvidence(input: {
  orgId: string;
  workspaceId: string;
  transcriptSegmentId: string;
  quote: string;
  confidence?: number;
}, options: DirectorToolOptions = {}) {
  return withNamedEntityTx(input.orgId, options.tx, async (tx) => {
    return (
      await tx
        .insert(evidence)
        .values({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          sourceType: "transcript_segment",
          sourceId: input.transcriptSegmentId,
          evidenceLabel: "stated_director",
          spanStart: 0,
          spanEnd: input.quote.length,
          quote: input.quote,
          observedAt: new Date(),
          confidence: String(input.confidence ?? 0.8),
        })
        .returning()
    )[0];
  });
}

export async function createDocumentEvidence(input: {
  orgId: string;
  workspaceId: string;
  documentChunkId: string;
  quote: string;
  spanStart?: number;
  spanEnd?: number;
  confidence?: number;
}, options: DirectorToolOptions = {}) {
  return withNamedEntityTx(input.orgId, options.tx, async (tx) => {
    return (
      await tx
        .insert(evidence)
        .values({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          sourceType: "document_chunk",
          sourceId: input.documentChunkId,
          evidenceLabel: "documented",
          spanStart: input.spanStart ?? 0,
          spanEnd: input.spanEnd ?? input.quote.length,
          quote: input.quote,
          observedAt: new Date(),
          confidence: String(input.confidence ?? 0.9),
        })
        .returning()
    )[0];
  });
}

export async function touchSlotAskedAt(
  context: DirectorToolContext,
  slotPath: string,
  askedAt = new Date(),
  options: DirectorToolOptions = {},
  candidateProcessId?: string,
) {
  assertDirectorSlotPath(slotPath);
  return withDirectorToolTx(context, options, async (tx) => {
    await lockSlotState(tx, context.captureSessionId, slotPath, candidateProcessId);
    const rows = await tx
      .update(slotStates)
      .set({ lastAskedAt: askedAt, updatedAt: new Date() })
      .where(slotIdentityWhere(context, slotPath, candidateProcessId))
      .returning({ id: slotStates.id });
    if (rows[0]) return rows[0];
    return (
      await tx
        .insert(slotStates)
        .values({
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          captureSessionId: context.captureSessionId,
          candidateProcessId,
          slotPath,
          status: "empty",
          confidence: "0",
          evidenceIds: [],
          lastAskedAt: askedAt,
          priority: slotPriority(slotPath),
        })
        .returning({ id: slotStates.id })
    )[0];
  });
}

export async function updateSlotState(
  context: DirectorToolContext,
  update: SlotUpdateInput,
  options: DirectorToolOptions = {},
) {
  assertDirectorSlotPath(update.slotPath);
  const value = normalizeDirectorSlotValue(update.slotPath, update.value);
  return withDirectorToolTx(context, options, async (tx) => {
    await lockSlotState(
      tx,
      context.captureSessionId,
      update.slotPath,
      update.candidateProcessId,
    );
    const existing = (
      await tx
        .select({
          id: slotStates.id,
          status: slotStates.status,
          confidence: slotStates.confidence,
          value: slotStates.value,
          evidenceIds: slotStates.evidenceIds,
          candidates: slotStates.candidates,
        })
        .from(slotStates)
        .where(slotIdentityWhere(context, update.slotPath, update.candidateProcessId))
        .limit(1)
        .for("update")
    )[0];
    const reconciliation = reconcileSlotUpdate(
      existing
        ? {
            slotPath: update.slotPath,
            candidateProcessId: update.candidateProcessId,
            value: existing.value,
            status: existing.status,
            confidence: Number(existing.confidence),
            evidenceIds: existing.evidenceIds ?? [],
            candidates: arrayCandidates(existing.candidates),
          }
        : undefined,
      {
        slotPath: update.slotPath,
        candidateProcessId: update.candidateProcessId,
        value,
        status: update.status,
        confidence: update.confidence,
        evidenceIds: update.evidenceIds ?? [],
        candidates: update.candidates ?? [],
        changeKind: update.changeKind,
      },
    );
    options.onSlotReconciliationDecision?.(reconciliation.decision);

    if (existing && reconciliation.write === "ignore") {
      if (update.lastAskedAt) {
        await tx
          .update(slotStates)
          .set({ lastAskedAt: update.lastAskedAt, updatedAt: new Date() })
          .where(eq(slotStates.id, existing.id));
      }
      return (
        await tx
          .select()
          .from(slotStates)
          .where(eq(slotStates.id, existing.id))
          .limit(1)
      )[0];
    }
    const values = {
      value: reconciliation.value,
      status: reconciliation.status,
      confidence: String(reconciliation.confidence),
      evidenceIds: reconciliation.evidenceIds,
      lastAskedAt: update.lastAskedAt,
      priority: slotPriority(update.slotPath),
      candidates: reconciliation.candidates,
      updatedAt: new Date(),
    };
    if (existing) {
      return (
        await tx
          .update(slotStates)
          .set(values)
          .where(eq(slotStates.id, existing.id))
          .returning()
      )[0];
    }
    return (
      await tx
        .insert(slotStates)
        .values({
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          captureSessionId: context.captureSessionId,
          candidateProcessId: update.candidateProcessId,
          slotPath: update.slotPath,
          ...values,
        })
        .returning()
    )[0];
  });
}

type ReconcileSlotRecord = {
  slotPath: string;
  candidateProcessId?: string;
  value: unknown;
  status: DirectorSlotStatus;
  confidence: number;
  evidenceIds: string[];
  candidates: unknown[];
};

type ReconcileIncomingSlotRecord = ReconcileSlotRecord & {
  changeKind?: DirectorSlotChangeKind;
};

type ReconciledSlotUpdate = {
  write: "upsert" | "ignore";
  value: unknown;
  status: DirectorSlotStatus;
  confidence: number;
  evidenceIds: string[];
  candidates?: unknown[];
  decision: DirectorSlotReconciliationDecision;
};

export function reconcileSlotUpdate(
  existing: ReconcileSlotRecord | undefined,
  incoming: ReconcileIncomingSlotRecord,
): ReconciledSlotUpdate {
  const policy = directorSlotPolicy(incoming.slotPath);
  const incomingEvidenceIds = incoming.evidenceIds ?? [];
  const existingEvidenceIds = existing?.evidenceIds ?? [];
  const mergedEvidenceIds = unique([...existingEvidenceIds, ...incomingEvidenceIds]);
  const baseDecision = {
    slotPath: incoming.slotPath,
    candidateProcessId: incoming.candidateProcessId,
    backing: policy.backing,
    confidence: incoming.confidence,
    evidenceIds: mergedEvidenceIds,
    changeKind: incoming.changeKind,
    previousValue: existing?.value,
  } satisfies Partial<DirectorSlotReconciliationDecision>;

  if (!existing) {
    return {
      write: "upsert",
      value: incoming.value,
      status: incoming.status,
      confidence: incoming.confidence,
      evidenceIds: incomingEvidenceIds,
      candidates: mergeSlotCandidates([], incoming.candidates),
      decision: {
        ...baseDecision,
        action: "create",
        value: incoming.value,
        rationale: "No existing slot state; accepted incoming value.",
      },
    };
  }

  const existingCandidates = arrayCandidates(existing.candidates);
  const incomingCandidates = arrayCandidates(incoming.candidates);
  const existingHasValue = existing.value !== undefined && existing.value !== null;
  const incomingIsNonAnswer = isNonAnswerSlotExtraction(incoming.value);
  const explicitCorrection = incoming.changeKind === "correction";

  if (incomingIsNonAnswer && existingHasValue) {
    return ignoredSlotUpdate(existing, incoming, {
      evidenceIds: mergedEvidenceIds,
      candidates: existingCandidates,
      decision: {
        ...baseDecision,
        action: "ignore",
        value: existing.value,
        confidence: existing.confidence,
        rationale: "Ignored non-answer so it cannot clobber existing slot state.",
      },
    });
  }

  const sameValue = slotValuesEqual(incoming.slotPath, existing.value, incoming.value);
  if (sameValue) {
    return {
      write: "upsert",
      value: existing.value ?? incoming.value,
      status: strongerSlotStatus(existing.status, incoming.status),
      confidence: Math.max(existing.confidence, incoming.confidence),
      evidenceIds: mergedEvidenceIds,
      candidates: mergeSlotCandidates(existingCandidates, incomingCandidates),
      decision: {
        ...baseDecision,
        action: "confirm",
        value: existing.value ?? incoming.value,
        confidence: Math.max(existing.confidence, incoming.confidence),
        rationale: "Incoming value confirms existing slot state.",
      },
    };
  }

  if (policy.backing === "candidate") {
    const value = existingHasValue ? existing.value : incoming.value;
    const confidence = Math.max(existing.confidence, incoming.confidence);
    return {
      write: "upsert",
      value,
      status: candidateBackedSlotStatus(existing.status, incoming.status, value),
      confidence,
      evidenceIds: mergedEvidenceIds,
      candidates: mergeSlotCandidates(existingCandidates, incomingCandidates),
      decision: {
        ...baseDecision,
        action: existingHasValue ? "enrich" : "create",
        value,
        confidence,
        rationale:
          "Candidate-backed slot is a coverage summary; durable truth lives in candidate_processes.",
      },
    };
  }

  if (
    existingHasValue &&
    !explicitCorrection &&
    policy.shape !== "string_list" &&
    incoming.confidence < existing.confidence
  ) {
    return ignoredSlotUpdate(existing, incoming, {
      evidenceIds: mergedEvidenceIds,
      candidates: mergeSlotCandidates(existingCandidates, incomingCandidates),
      decision: {
        ...baseDecision,
        action: "ignore",
        value: existing.value,
        confidence: existing.confidence,
        rationale: "Ignored lower-confidence conflicting update without correction intent.",
      },
    });
  }

  if (explicitCorrection) {
    return {
      write: "upsert",
      value: incoming.value,
      status: incoming.status === "empty" ? "partial" : incoming.status,
      confidence: incoming.confidence,
      evidenceIds: mergedEvidenceIds,
      candidates: mergeSlotCandidates(
        [
          ...existingCandidates,
          slotCandidate(existing.value, {
            reason: "previous_value_before_correction",
            evidenceIds: existingEvidenceIds,
            confidence: existing.confidence,
          }),
        ],
        incomingCandidates,
      ),
      decision: {
        ...baseDecision,
        action: "correct",
        value: incoming.value,
        rationale: "Incoming update is marked as an explicit correction.",
      },
    };
  }

  if (policy.backing === "claim") {
    return {
      write: "upsert",
      value: existing.value ?? incoming.value,
      status: strongerSlotStatus(existing.status, incoming.status),
      confidence: Math.max(existing.confidence, incoming.confidence),
      evidenceIds: mergedEvidenceIds,
      candidates: mergeSlotCandidates(existingCandidates, [
        ...incomingCandidates,
        slotCandidate(incoming.value, {
          reason: "claim_layer_value_summary",
          evidenceIds: incomingEvidenceIds,
          confidence: incoming.confidence,
        }),
      ]),
      decision: {
        ...baseDecision,
        action: "enrich",
        value: existing.value ?? incoming.value,
        confidence: Math.max(existing.confidence, incoming.confidence),
        rationale:
          "Claim-backed slot keeps slot_states as coverage summary; durable merge happens in claims.",
      },
    };
  }

  if (policy.shape === "string_list") {
    const mergedValue = mergeSlotStringLists(existing.value, incoming.value);
    return {
      write: "upsert",
      value: mergedValue,
      status: strongerSlotStatus(existing.status, incoming.status),
      confidence: Math.max(existing.confidence, incoming.confidence),
      evidenceIds: mergedEvidenceIds,
      candidates: mergeSlotCandidates(existingCandidates, incomingCandidates),
      decision: {
        ...baseDecision,
        action: "merge",
        value: mergedValue,
        confidence: Math.max(existing.confidence, incoming.confidence),
        rationale: "Merged unique values for slot-state-backed list slot.",
      },
    };
  }

  if (
    policy.shape === "structured" &&
    policy.reconcile === "enrich_or_replace_on_correction"
  ) {
    const enrichedValue = mergeStructuredSlotValue(existing.value, incoming.value);
    return {
      write: "upsert",
      value: enrichedValue,
      status: strongerSlotStatus(existing.status, incoming.status),
      confidence: Math.max(existing.confidence, incoming.confidence),
      evidenceIds: mergedEvidenceIds,
      candidates: mergeSlotCandidates(existingCandidates, incomingCandidates),
      decision: {
        ...baseDecision,
        action: "enrich",
        value: enrichedValue,
        confidence: Math.max(existing.confidence, incoming.confidence),
        rationale: "Enriched structured slot value without discarding prior fields.",
      },
    };
  }

  return {
    write: "upsert",
    value: existing.value,
    status: "conflicting",
    confidence: Math.max(existing.confidence, incoming.confidence),
    evidenceIds: mergedEvidenceIds,
    candidates: mergeSlotCandidates(existingCandidates, [
      slotCandidate(existing.value, {
        reason: "current_value",
        evidenceIds: existingEvidenceIds,
        confidence: existing.confidence,
      }),
      slotCandidate(incoming.value, {
        reason: "conflicting_incoming_value",
        evidenceIds: incomingEvidenceIds,
        confidence: incoming.confidence,
      }),
      ...incomingCandidates,
    ]),
    decision: {
      ...baseDecision,
      action: "conflict",
      value: existing.value,
      confidence: Math.max(existing.confidence, incoming.confidence),
      followUpQuestion: clarificationQuestionForSlot(
        incoming.slotPath,
        existing.value,
        incoming.value,
      ),
      rationale: "Scalar slot value differs without correction or scope signal.",
    },
  };
}

// Task 9 downgrade guard (pure decision, unit-tested). Block a slot write that
// would weaken an already-`filled` slot: either the incoming value is a
// non-answer, or it is strictly lower confidence than what is stored. Empty,
// partial, asked_unknown, and conflicting slots are not protected (they can be
// freely refined), and an equal-or-higher-confidence real answer still
// overwrites (legitimate corrections/refreshes).
export function shouldBlockSlotDowngrade(
  existing: { status: DirectorSlotStatus; confidence: string | number },
  incoming: { value: unknown; confidence: number },
): boolean {
  if (existing.status !== "filled") return false;
  if (isNonAnswerSlotExtraction(incoming.value)) return true;
  const existingConfidence = Number(existing.confidence);
  return (
    Number.isFinite(existingConfidence) && incoming.confidence < existingConfidence
  );
}

function ignoredSlotUpdate(
  existing: ReconcileSlotRecord,
  incoming: ReconcileIncomingSlotRecord,
  result: Pick<
    ReconciledSlotUpdate,
    "evidenceIds" | "candidates" | "decision"
  >,
): ReconciledSlotUpdate {
  return {
    write: "ignore",
    value: existing.value,
    status: existing.status,
    confidence: existing.confidence,
    evidenceIds: result.evidenceIds,
    candidates: result.candidates,
    decision: {
      ...result.decision,
      slotPath: incoming.slotPath,
      candidateProcessId: incoming.candidateProcessId,
      previousValue: existing.value,
      evidenceIds: result.evidenceIds,
    },
  };
}

function strongerSlotStatus(
  existing: DirectorSlotStatus,
  incoming: DirectorSlotStatus,
): DirectorSlotStatus {
  return statusRank(incoming) > statusRank(existing) ? incoming : existing;
}

function candidateBackedSlotStatus(
  existing: DirectorSlotStatus,
  incoming: DirectorSlotStatus,
  value: unknown,
): DirectorSlotStatus {
  if (isNonAnswerSlotExtraction(value)) {
    return strongerSlotStatus(existing, incoming);
  }
  if (value !== undefined && value !== null && incoming !== "asked_unknown") {
    return "filled";
  }
  return strongerSlotStatus(existing, incoming);
}

function statusRank(status: DirectorSlotStatus): number {
  switch (status) {
    case "filled":
      return 5;
    case "conflicting":
      return 4;
    case "partial":
      return 3;
    case "asked_unknown":
      return 2;
    case "pending_re_extract":
      return 1;
    case "empty":
      return 0;
  }
}

function arrayCandidates(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mergeSlotCandidates(existing: unknown[], incoming: unknown[]): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const candidate of [...existing, ...incoming].filter(
    (entry) => entry !== undefined && entry !== null,
  )) {
    const key = stableStringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged.length > 0 ? merged : [];
}

function slotCandidate(
  value: unknown,
  input: { reason: string; evidenceIds: string[]; confidence: number },
) {
  return {
    value,
    reason: input.reason,
    evidence_ids: input.evidenceIds,
    confidence: input.confidence,
  };
}

function mergeStructuredSlotValue(existing: unknown, incoming: unknown): unknown {
  if (!isRecord(existing) || !isRecord(incoming)) return incoming ?? existing;
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    const current = merged[key];
    if (Array.isArray(current) || Array.isArray(value)) {
      merged[key] = mergeSlotStringLists(current, value);
    } else if (current === undefined || current === null || current === "") {
      merged[key] = value;
    } else if (isRecord(current) && isRecord(value)) {
      merged[key] = mergeStructuredSlotValue(current, value);
    } else if (slotValuesEqual("function.name", current, value)) {
      merged[key] = current;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clarificationQuestionForSlot(
  slotPath: string,
  existingValue: unknown,
  incomingValue: unknown,
): string {
  return `Should ${slotPath} be ${briefSlotValue(existingValue)}, ${briefSlotValue(incomingValue)}, or are both true in different scopes?`;
}

function briefSlotValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (isRecord(value)) {
    for (const key of ["name", "text", "value", "label", "function_name"]) {
      if (typeof value[key] === "string") return value[key] as string;
    }
  }
  return stableStringify(value);
}

function slotIdentityWhere(
  context: DirectorToolContext,
  slotPath: string,
  candidateProcessId?: string,
) {
  return and(
    eq(slotStates.orgId, context.orgId),
    eq(slotStates.workspaceId, context.workspaceId),
    eq(slotStates.captureSessionId, context.captureSessionId),
    eq(slotStates.slotPath, slotPath),
    candidateProcessId
      ? eq(slotStates.candidateProcessId, candidateProcessId)
      : isNull(slotStates.candidateProcessId),
  );
}

async function lockSlotState(
  tx: DirectorToolTx,
  captureSessionId: string,
  slotPath: string,
  candidateProcessId?: string,
) {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${`${captureSessionId}:slot:${candidateProcessId ?? "global"}:${slotPath}`},
        17
      )
    )
  `);
}

export async function recordProcess(
  context: DirectorToolContext,
  input: {
    name: string;
    proposedFunction?: string;
    frequency?: string;
    complexityHint?: string;
    confidence?: number;
    evidenceIds: string[];
    /**
     * When false (non-enumeration turns), the name may merge into or rename
     * an existing pending candidate but never mint a brand-new one. Returns
     * null when no related candidate exists.
     */
    allowNewCandidate?: boolean;
  },
  options: DirectorToolOptions = {},
) {
  // Defense in depth: the full shared predicate (junk shapes, narration
  // fragments, bare system names) runs at write time so direct callers like
  // the document pipeline cannot insert a name the brain would reject.
  if (!isPlausibleCandidateProcessName(input.name)) {
    options.onProcessReconciliationDecision?.({
      incomingName: input.name,
      action: "discard_as_junk",
      confidence: input.confidence ?? 0,
      evidenceIds: input.evidenceIds,
      rationale: "Rejected by candidate process name plausibility guard.",
    });
    return null;
  }
  const displayName = canonicalProcessDisplayName(input.name);
  const normalized = normalizeName(displayName);
  return withDirectorToolTx(context, options, async (tx) => {
    // Session-wide reconciliation lock — deliberately NOT per-name. Related
    // names ("Purchasing" vs "Purchasing And Replenishment") hash to different
    // per-name keys, so a per-name lock cannot stop two concurrent extractions
    // from racing past the related-candidate scan below and inserting both.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`${context.captureSessionId}:candidate_process_reconcile`},
          13
        )
      )
    `);
    const pending = await tx.execute<{
      id: string;
      proposed_name: string;
      proposed_function: string | null;
      frequency: string | null;
      complexity_hint: string | null;
      evidence_ids: string[] | null;
    }>(sql`
      SELECT id, proposed_name, proposed_function, frequency, complexity_hint, evidence_ids
      FROM candidate_processes
      WHERE org_id = ${context.orgId}
        AND workspace_id = ${context.workspaceId}
        AND capture_session_id = ${context.captureSessionId}
        AND status = 'pending'
      ORDER BY created_at ASC
      FOR UPDATE
    `);
    const exactRow = pending.rows.find(
      (row) => normalizeName(row.proposed_name) === normalized,
    );
    // Cross-turn reconciliation: an incoming name whose significant-word set
    // contains (or is contained by) an existing pending candidate's is the
    // same process at different granularity — turn 0's "Purchasing" followed
    // by turn 1's "Purchasing And Replenishment" must end as one row.
    const incomingTokens = candidateNameTokenSet(displayName);
    const relatedRow =
      exactRow ??
      (incomingTokens.size > 0
        ? pending.rows.find((row) => {
            const rowTokens = candidateNameTokenSet(row.proposed_name);
            return (
              rowTokens.size > 0 &&
              (isTokenSubset(incomingTokens, rowTokens) ||
                isTokenSubset(rowTokens, incomingTokens))
            );
          })
        : undefined);
    let candidate;
    if (relatedRow) {
      const mergedEvidenceIds = unique([
        ...(relatedRow.evidence_ids ?? []),
        ...input.evidenceIds,
      ]);
      // The fuller (superset) phrasing is the director's compound name; when
      // the incoming name strictly contains the stored one, rename the row.
      const relatedTokens = candidateNameTokenSet(relatedRow.proposed_name);
      const shouldRename =
        (!exactRow &&
          relatedTokens.size < incomingTokens.size &&
          isTokenSubset(relatedTokens, incomingTokens)) ||
        normalizeName(relatedRow.proposed_name) === normalized;
      candidate = (
        await tx
          .update(candidateProcesses)
          .set({
            ...(shouldRename ? { proposedName: displayName } : {}),
            proposedFunction: input.proposedFunction ?? relatedRow.proposed_function ?? undefined,
            frequency: input.frequency ?? relatedRow.frequency ?? undefined,
            complexityHint: input.complexityHint ?? relatedRow.complexity_hint ?? undefined,
            evidenceIds: mergedEvidenceIds,
            confidence: String(input.confidence ?? 0.75),
            updatedAt: new Date(),
          })
          .where(eq(candidateProcesses.id, relatedRow.id))
          .returning()
      )[0];
      if (!exactRow) {
        await tx.insert(auditLog).values({
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          userId: context.userId,
          eventType: "candidate_process.reconciled",
          subjectType: "candidate_process",
          subjectId: relatedRow.id,
          metadataJson: sanitizeJsonForLogs({
            incoming_name: displayName,
            stored_name: relatedRow.proposed_name,
            action: shouldRename ? "renamed_to_compound" : "merged_into_existing",
            capture_session_id: context.captureSessionId,
          }) as Record<string, unknown>,
        });
      }
      options.onProcessReconciliationDecision?.({
        incomingName: displayName,
        action: shouldRename ? "rename_candidate" : "merge_candidate",
        targetCandidateProcessId: relatedRow.id,
        canonicalName: candidate.proposedName,
        confidence: input.confidence ?? 0.75,
        evidenceIds: mergedEvidenceIds,
        rationale: shouldRename
          ? "Incoming name is a fuller related phrase; renamed existing candidate."
          : "Incoming name matched or related to an existing pending candidate.",
      });
    } else {
      // Non-enumeration turns may only merge into existing candidates; a name
      // with no related pending candidate is not minted (B1 gate).
      if (input.allowNewCandidate === false) {
        options.onProcessReconciliationDecision?.({
          incomingName: displayName,
          action: "demote_to_candidate_detail",
          confidence: input.confidence ?? 0.75,
          evidenceIds: input.evidenceIds,
          rationale:
            "Candidate minting gate is closed and no related candidate exists.",
        });
        return null;
      }
      candidate = (
        await tx
          .insert(candidateProcesses)
          .values({
            orgId: context.orgId,
            workspaceId: context.workspaceId,
            captureSessionId: context.captureSessionId,
            proposedName: displayName,
            proposedFunction: input.proposedFunction,
            frequency: input.frequency,
            complexityHint: input.complexityHint,
            evidenceIds: input.evidenceIds,
            confidence: String(input.confidence ?? 0.75),
          })
          .returning()
      )[0];
      options.onProcessReconciliationDecision?.({
        incomingName: displayName,
        action: "create_candidate",
        targetCandidateProcessId: candidate.id,
        canonicalName: candidate.proposedName,
        confidence: input.confidence ?? 0.75,
        evidenceIds: input.evidenceIds,
        rationale: "Created candidate under the safe inventory creation floor.",
      });
    }

    await writeCandidateClaim(
      context,
      candidate.id,
      "proposed_name",
      candidate.proposedName,
      input.evidenceIds,
      tx,
    );
    if (input.frequency) {
      await writeCandidateClaim(
        context,
        candidate.id,
        "frequency",
        input.frequency,
        input.evidenceIds,
        tx,
      );
    }
    if (input.complexityHint) {
      await writeCandidateClaim(
        context,
        candidate.id,
        "complexity_hint",
        input.complexityHint,
        input.evidenceIds,
        tx,
      );
    }
    return candidate;
  });
}

export async function recordSystem(
  context: DirectorToolContext,
  input: { name: string; evidenceIds: string[]; candidateProcessId?: string },
  options: DirectorToolOptions = {},
) {
  const system = await upsertNamedSystem(context.orgId, input.name, options.tx);
  if (input.candidateProcessId) {
    await writeClaimWithOptionalTx(options.tx, {
      orgId: context.orgId,
      workspaceId: context.workspaceId,
      userId: context.userId,
      subject: { type: "system", id: system.id },
      field: "used_in_process",
      value: {
        candidate_process_id: input.candidateProcessId,
        system_name: system.name,
      },
      evidenceIds: input.evidenceIds,
      confidence: 0.72,
      idempotencyKey: claimKey("system", system.id, "used_in_process", input),
      requestHash: claimHash(input),
      route: "director-tool/record-system",
      metadata: { source: "director_tool" },
    });
  }
  return system;
}

export async function recordRole(
  context: DirectorToolContext,
  input: { name: string; evidenceIds: string[]; candidateProcessId?: string },
  options: DirectorToolOptions = {},
) {
  const role = await upsertNamedRole(context.orgId, input.name, options.tx);
  if (input.candidateProcessId) {
    await writeClaimWithOptionalTx(options.tx, {
      orgId: context.orgId,
      workspaceId: context.workspaceId,
      userId: context.userId,
      subject: { type: "role", id: role.id },
      field: "used_in_process",
      value: {
        candidate_process_id: input.candidateProcessId,
        role_name: role.name,
      },
      evidenceIds: input.evidenceIds,
      confidence: 0.72,
      idempotencyKey: claimKey("role", role.id, "used_in_process", input),
      requestHash: claimHash(input),
      route: "director-tool/record-role",
      metadata: { source: "director_tool" },
    });
  }
  return role;
}

export async function recordPerson(
  context: DirectorToolContext,
  input: {
    name: string;
    title?: string;
    roleName?: string;
    candidateProcessId?: string;
    evidenceIds: string[];
  },
  options: DirectorToolOptions = {},
) {
  return withDirectorToolTx(context, options, async (tx) => {
    let person;
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM people
      WHERE org_id = ${context.orgId}
        AND lower(name) = ${normalizeName(input.name)}
      LIMIT 1
      FOR UPDATE
    `);
    if (existing.rows[0]) {
      person = (
        await tx
          .update(people)
          .set({ title: input.title, updatedAt: new Date() })
          .where(eq(people.id, existing.rows[0].id))
          .returning()
      )[0];
    } else {
      person = (
        await tx
          .insert(people)
          .values({
            orgId: context.orgId,
            name: input.name.trim(),
            title: input.title,
            source: "director_interview",
          })
          .returning()
      )[0];
    }
    if (input.roleName) {
      const role = await upsertNamedRole(context.orgId, input.roleName, tx);
      await writeClaimInTransaction(tx, {
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        userId: context.userId,
        subject: { type: "person", id: person.id },
        field: "role",
        value: role.name,
        evidenceIds: input.evidenceIds,
        confidence: 0.72,
        idempotencyKey: claimKey("person", person.id, "role", input),
        requestHash: claimHash(input),
        route: "director-tool/record-person",
        metadata: { role_id: role.id, source: "director_tool" },
      });
    }
    // Person→candidate link: the overview people_count joins on this claim, so
    // a person only counts toward processes they were actually evidenced on
    // (previously every workspace person counted on every card).
    if (input.candidateProcessId) {
      await writeClaimInTransaction(tx, {
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        userId: context.userId,
        subject: { type: "person", id: person.id },
        field: "works_on",
        value: { candidate_process_id: input.candidateProcessId },
        evidenceIds: input.evidenceIds,
        confidence: 0.72,
        idempotencyKey: claimKey("person", person.id, "works_on", {
          candidateProcessId: input.candidateProcessId,
        }),
        requestHash: claimHash({
          candidateProcessId: input.candidateProcessId,
          evidenceIds: input.evidenceIds,
        }),
        route: "director-tool/record-person",
        metadata: { source: "director_tool" },
      });
    }
    return person;
  });
}

export async function recordPainPoint(
  context: DirectorToolContext,
  input: { candidateProcessId: string; text: string; evidenceIds: string[] },
  options: DirectorToolOptions = {},
) {
  return writeClaimWithOptionalTx(options.tx, {
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    userId: context.userId,
    subject: { type: "candidate_process", id: input.candidateProcessId },
    field: "pain_point",
    value: { text: input.text },
    evidenceIds: input.evidenceIds,
    confidence: 0.78,
    idempotencyKey: claimKey("candidate_process", input.candidateProcessId, "pain_point", input),
    requestHash: claimHash(input),
    route: "director-tool/record-pain-point",
    metadata: { source: "director_tool" },
  });
}

export async function recordSpof(
  context: DirectorToolContext,
  input: { candidateProcessId: string; text: string; evidenceIds: string[] },
  options: DirectorToolOptions = {},
) {
  return writeClaimWithOptionalTx(options.tx, {
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    userId: context.userId,
    subject: { type: "candidate_process", id: input.candidateProcessId },
    field: "risk",
    value: { type: "single_point_of_failure", text: input.text },
    evidenceIds: input.evidenceIds,
    confidence: 0.78,
    idempotencyKey: claimKey("candidate_process", input.candidateProcessId, "risk", input),
    requestHash: claimHash(input),
    route: "director-tool/record-spof",
    metadata: { source: "director_tool" },
  });
}

export async function createFollowUpTask(
  context: DirectorToolContext,
  input: {
    title: string;
    description?: string;
    taskType?:
      | "open_question"
      | "conflicting_slot"
      | "low_confidence_claim"
      | "failed_stage";
    targetType?: string;
    targetId?: string;
    priority?: number;
    contextJson?: Record<string, unknown>;
  },
  options: DirectorToolOptions = {},
) {
  return withDirectorToolTx(context, options, async (tx) => {
    const contextJson = sanitizeJsonForLogs(input.contextJson ?? {}) as Record<
      string,
      unknown
    >;
    const task = (
      await tx
        .insert(followUpTasks)
        .values({
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          captureSessionId: context.captureSessionId,
          taskType: input.taskType ?? "open_question",
          title: sanitizeForLogs(input.title),
          description: input.description
            ? sanitizeForLogs(input.description)
            : undefined,
          targetType: input.targetType,
          targetId: input.targetId,
          priority: String(input.priority ?? 1),
          contextJson,
        })
        .returning()
    )[0];
    await tx.insert(auditLog).values({
      orgId: context.orgId,
      workspaceId: context.workspaceId,
      userId: context.userId,
      eventType: "follow_up_task.create",
      subjectType: "follow_up_task",
      subjectId: task.id,
      metadataJson: { capture_session_id: context.captureSessionId },
    });
    return task;
  });
}

async function writeCandidateClaim(
  context: DirectorToolContext,
  candidateProcessId: string,
  field: string,
  value: string,
  evidenceIds: string[],
  tx?: DirectorToolTx,
) {
  return writeClaimWithOptionalTx(tx, {
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    userId: context.userId,
    subject: { type: "candidate_process", id: candidateProcessId },
    field,
    value,
    evidenceIds,
    confidence: 0.78,
    idempotencyKey: claimKey("candidate_process", candidateProcessId, field, {
      value,
      evidenceIds,
    }),
    requestHash: claimHash({ value, evidenceIds }),
    route: "director-tool/record-process",
    metadata: { source: "director_tool" },
  });
}

async function upsertNamedSystem(orgId: string, name: string, tx?: DirectorToolTx) {
  // F5: fold variants ("Google Sheet (Marcus)", "google sheets") into one
  // canonical system row — name variants were inflating the system-sprawl
  // complexity factor and cluttering process cards.
  const canonicalName = canonicalizeSystemName(name);
  return withNamedEntityTx(orgId, tx, async (activeTx) => {
    const existing = await activeTx.execute<{ id: string }>(sql`
      SELECT id FROM systems
      WHERE org_id = ${orgId}
        AND (
          lower(name) = ${normalizeName(canonicalName)}
          OR canonical_key = ${canonicalKey(canonicalName)}
        )
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE
    `);
    if (existing.rows[0]) {
      return (
        await activeTx
          .update(systems)
          .set({ updatedAt: new Date() })
          .where(and(eq(systems.id, existing.rows[0].id), eq(systems.orgId, orgId)))
          .returning()
      )[0];
    }
    return (
      await activeTx
        .insert(systems)
        .values({
          orgId,
          name: canonicalName,
          type: "business_system",
          canonicalKey: canonicalKey(canonicalName),
        })
        .returning()
    )[0];
  });
}

async function upsertNamedRole(orgId: string, name: string, tx?: DirectorToolTx) {
  return withNamedEntityTx(orgId, tx, async (activeTx) => {
    const existing = await activeTx.execute<{ id: string }>(sql`
      SELECT id FROM roles
      WHERE org_id = ${orgId}
        AND lower(name) = ${normalizeName(name)}
      LIMIT 1
      FOR UPDATE
    `);
    if (existing.rows[0]) {
      return (
        await activeTx
          .update(roles)
          .set({ updatedAt: new Date() })
          .where(and(eq(roles.id, existing.rows[0].id), eq(roles.orgId, orgId)))
          .returning()
      )[0];
    }
    return (
      await activeTx
        .insert(roles)
        .values({ orgId, name: name.trim(), canonicalKey: canonicalKey(name) })
        .returning()
    )[0];
  });
}

async function writeClaimWithOptionalTx(tx: DirectorToolTx | undefined, input: WriteClaimInput) {
  return tx ? writeClaimInTransaction(tx, input) : writeClaim(input);
}

async function withDirectorToolTx<T>(
  context: DirectorToolContext,
  options: DirectorToolOptions,
  fn: (tx: DirectorToolTx) => Promise<T>,
) {
  if (options.tx) return fn(options.tx);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    return fn(tx);
  });
}

async function withNamedEntityTx<T>(
  orgId: string,
  tx: DirectorToolTx | undefined,
  fn: (tx: DirectorToolTx) => Promise<T>,
) {
  if (tx) return fn(tx);
  return getDb().transaction(async (activeTx) => {
    await setOrgContext(activeTx, orgId);
    return fn(activeTx);
  });
}

function normalizeName(name: string) {
  return name.trim().toLowerCase();
}

function canonicalProcessDisplayName(name: string) {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b[A-Za-z][A-Za-z0-9'-]*\b/g, (word) => {
      if (/^[A-Z0-9]{2,4}$/.test(word)) return word;
      return `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`;
    });
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function canonicalKey(name: string) {
  return normalizeName(name).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function claimHash(input: unknown) {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

function claimKey(subjectType: string, subjectId: string, field: string, input: unknown) {
  const digest = createHash("sha1").update(stableStringify(input)).digest("hex");
  return `tool:${subjectType}:${subjectId}:${field}:${digest}`;
}

export function generatedIdempotencyKey(prefix: string) {
  return `${prefix}:${randomUUID()}`;
}
