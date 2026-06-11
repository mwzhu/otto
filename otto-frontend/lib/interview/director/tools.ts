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
import { stableStringify } from "@/lib/http/json";
import { sanitizeForLogs, sanitizeJsonForLogs } from "@/lib/security/sanitize";
import {
  candidateNameTokenSet,
  isPlausibleCandidateProcessName,
  isTokenSubset,
} from "@/lib/candidate-processes/name-quality";

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
};

type DirectorToolTx = ClaimWriteTx;
type DirectorToolOptions = { tx?: DirectorToolTx };

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
        })
        .from(slotStates)
        .where(slotIdentityWhere(context, update.slotPath, update.candidateProcessId))
        .limit(1)
        .for("update")
    )[0];
    // Task 9: do not let a non-answer or a strictly weaker extraction clobber an
    // already-`filled` slot. The garbled deflection "those employees I just
    // mentioned" was extracted as a value and overwrote a good "VP of operations"
    // on function.name. When the guard fires we never downgrade the value,
    // status, or confidence of the filled slot — only re-stamp last_asked_at if
    // we were explicitly asked to.
    if (
      existing &&
      shouldBlockSlotDowngrade(
        { status: existing.status, confidence: existing.confidence },
        { value, confidence: update.confidence },
      )
    ) {
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
      value,
      status: update.status,
      confidence: String(update.confidence),
      evidenceIds: update.evidenceIds ?? [],
      lastAskedAt: update.lastAskedAt,
      priority: slotPriority(update.slotPath),
      candidates: update.candidates,
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
    return null;
  }
  const normalized = normalizeName(input.name);
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
    const incomingTokens = candidateNameTokenSet(input.name);
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
        !exactRow &&
        relatedTokens.size < incomingTokens.size &&
        isTokenSubset(relatedTokens, incomingTokens);
      candidate = (
        await tx
          .update(candidateProcesses)
          .set({
            ...(shouldRename ? { proposedName: input.name.trim() } : {}),
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
            incoming_name: input.name.trim(),
            stored_name: relatedRow.proposed_name,
            action: shouldRename ? "renamed_to_compound" : "merged_into_existing",
            capture_session_id: context.captureSessionId,
          }) as Record<string, unknown>,
        });
      }
    } else {
      // Non-enumeration turns may only merge into existing candidates; a name
      // with no related pending candidate is not minted (B1 gate).
      if (input.allowNewCandidate === false) {
        return null;
      }
      candidate = (
        await tx
          .insert(candidateProcesses)
          .values({
            orgId: context.orgId,
            workspaceId: context.workspaceId,
            captureSessionId: context.captureSessionId,
            proposedName: input.name.trim(),
            proposedFunction: input.proposedFunction,
            frequency: input.frequency,
            complexityHint: input.complexityHint,
            evidenceIds: input.evidenceIds,
            confidence: String(input.confidence ?? 0.75),
          })
          .returning()
      )[0];
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
  return withNamedEntityTx(orgId, tx, async (activeTx) => {
    const existing = await activeTx.execute<{ id: string }>(sql`
      SELECT id FROM systems
      WHERE org_id = ${orgId}
        AND lower(name) = ${normalizeName(name)}
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
          name: name.trim(),
          type: "business_system",
          canonicalKey: canonicalKey(name),
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
