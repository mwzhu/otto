import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
import { writeClaim } from "@/lib/db/write-claim";
import { slotPriority, type DirectorSlotStatus } from "@/lib/interview/director/slot-schema";
import { stableStringify } from "@/lib/http/json";

export type DirectorToolContext = {
  orgId: string;
  workspaceId: string;
  captureSessionId: string;
  userId: string;
};

export type SlotUpdateInput = {
  slotPath: string;
  value?: unknown;
  status: DirectorSlotStatus;
  confidence: number;
  evidenceIds?: string[];
  candidates?: unknown[];
  lastAskedAt?: Date;
};

export async function createTranscriptEvidence(input: {
  orgId: string;
  workspaceId: string;
  transcriptSegmentId: string;
  quote: string;
  confidence?: number;
}) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
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
}) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
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
) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE slot_states
      SET last_asked_at = ${askedAt},
          updated_at = now()
      WHERE org_id = ${context.orgId}
        AND workspace_id = ${context.workspaceId}
        AND capture_session_id = ${context.captureSessionId}
        AND slot_path = ${slotPath}
      RETURNING id
    `);
    if (updated.rows[0]) return updated.rows[0];
    return (
      await tx
        .insert(slotStates)
        .values({
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          captureSessionId: context.captureSessionId,
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
) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    return (
      await tx
        .insert(slotStates)
        .values({
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          captureSessionId: context.captureSessionId,
          slotPath: update.slotPath,
          value: update.value,
          status: update.status,
          confidence: String(update.confidence),
          evidenceIds: update.evidenceIds ?? [],
          lastAskedAt: update.lastAskedAt,
          priority: slotPriority(update.slotPath),
          candidates: update.candidates,
        })
        .onConflictDoUpdate({
          target: [slotStates.captureSessionId, slotStates.slotPath],
          set: {
            value: update.value,
            status: update.status,
            confidence: String(update.confidence),
            evidenceIds: update.evidenceIds ?? [],
            lastAskedAt: update.lastAskedAt,
            priority: slotPriority(update.slotPath),
            candidates: update.candidates,
            updatedAt: new Date(),
          },
        })
        .returning()
    )[0];
  });
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
  },
) {
  const db = getDb();
  const normalized = normalizeName(input.name);
  const candidate = await db.transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    const existing = await tx.execute<{
      id: string;
      proposed_function: string | null;
      frequency: string | null;
      complexity_hint: string | null;
      evidence_ids: string[] | null;
    }>(sql`
      SELECT id, proposed_function, frequency, complexity_hint, evidence_ids
      FROM candidate_processes
      WHERE org_id = ${context.orgId}
        AND workspace_id = ${context.workspaceId}
        AND capture_session_id = ${context.captureSessionId}
        AND lower(proposed_name) = ${normalized}
        AND status = 'pending'
      LIMIT 1
      FOR UPDATE
    `);
    const existingRow = existing.rows[0];
    if (existingRow) {
      const mergedEvidenceIds = unique([
        ...(existingRow.evidence_ids ?? []),
        ...input.evidenceIds,
      ]);
      return (
        await tx
          .update(candidateProcesses)
          .set({
            proposedFunction: input.proposedFunction ?? existingRow.proposed_function ?? undefined,
            frequency: input.frequency ?? existingRow.frequency ?? undefined,
            complexityHint: input.complexityHint ?? existingRow.complexity_hint ?? undefined,
            evidenceIds: mergedEvidenceIds,
            confidence: String(input.confidence ?? 0.75),
            updatedAt: new Date(),
          })
          .where(eq(candidateProcesses.id, existingRow.id))
          .returning()
      )[0];
    }
    return (
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
  });

  await writeCandidateClaim(context, candidate.id, "proposed_name", candidate.proposedName, input.evidenceIds);
  if (input.frequency) {
    await writeCandidateClaim(context, candidate.id, "frequency", input.frequency, input.evidenceIds);
  }
  if (input.complexityHint) {
    await writeCandidateClaim(
      context,
      candidate.id,
      "complexity_hint",
      input.complexityHint,
      input.evidenceIds,
    );
  }
  return candidate;
}

export async function recordSystem(
  context: DirectorToolContext,
  input: { name: string; evidenceIds: string[]; candidateProcessId?: string },
) {
  const system = await upsertNamedSystem(context.orgId, input.name);
  if (input.candidateProcessId) {
    await writeClaim({
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
) {
  const role = await upsertNamedRole(context.orgId, input.name);
  if (input.candidateProcessId) {
    await writeClaim({
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
  input: { name: string; title?: string; roleName?: string; evidenceIds: string[] },
) {
  const db = getDb();
  const person = await db.transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM people
      WHERE org_id = ${context.orgId}
        AND lower(name) = ${normalizeName(input.name)}
      LIMIT 1
      FOR UPDATE
    `);
    if (existing.rows[0]) {
      return (
        await tx
          .update(people)
          .set({ title: input.title, updatedAt: new Date() })
          .where(eq(people.id, existing.rows[0].id))
          .returning()
      )[0];
    }
    return (
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
  });
  if (input.roleName) {
    const role = await upsertNamedRole(context.orgId, input.roleName);
    await writeClaim({
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
  return person;
}

export async function recordPainPoint(
  context: DirectorToolContext,
  input: { candidateProcessId: string; text: string; evidenceIds: string[] },
) {
  return writeClaim({
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
) {
  return writeClaim({
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
    taskType?: "open_question" | "conflicting_slot" | "low_confidence_claim";
    targetType?: string;
    targetId?: string;
    priority?: number;
    contextJson?: Record<string, unknown>;
  },
) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    const task = (
      await tx
        .insert(followUpTasks)
        .values({
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          captureSessionId: context.captureSessionId,
          taskType: input.taskType ?? "open_question",
          title: input.title,
          description: input.description,
          targetType: input.targetType,
          targetId: input.targetId,
          priority: String(input.priority ?? 1),
          contextJson: input.contextJson ?? {},
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
) {
  return writeClaim({
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

async function upsertNamedSystem(orgId: string, name: string) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM systems
      WHERE org_id = ${orgId}
        AND lower(name) = ${normalizeName(name)}
      LIMIT 1
      FOR UPDATE
    `);
    if (existing.rows[0]) {
      return (
        await tx
          .update(systems)
          .set({ updatedAt: new Date() })
          .where(and(eq(systems.id, existing.rows[0].id), eq(systems.orgId, orgId)))
          .returning()
      )[0];
    }
    return (
      await tx
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

async function upsertNamedRole(orgId: string, name: string) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM roles
      WHERE org_id = ${orgId}
        AND lower(name) = ${normalizeName(name)}
      LIMIT 1
      FOR UPDATE
    `);
    if (existing.rows[0]) {
      return (
        await tx
          .update(roles)
          .set({ updatedAt: new Date() })
          .where(and(eq(roles.id, existing.rows[0].id), eq(roles.orgId, orgId)))
          .returning()
      )[0];
    }
    return (
      await tx
        .insert(roles)
        .values({ orgId, name: name.trim(), canonicalKey: canonicalKey(name) })
        .returning()
    )[0];
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
