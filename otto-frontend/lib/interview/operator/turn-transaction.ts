import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, getServiceDb, setOrgContext } from "@/lib/db/client";
import {
  agentDecisionLog,
  captureSessions,
  evidence,
  provisionalSteps,
  slotStates,
  transcriptSegments,
  workspaces,
} from "@/lib/db/schema";
import { ApiError } from "@/lib/http/json";
import {
  assertOperatorSlotPath,
  operatorSlotPriority,
} from "@/lib/interview/operator/schema";
import { sanitizeJsonForLogs } from "@/lib/security/sanitize";

export const operatorTranscriptSegmentInputSchema = z
  .object({
    speaker: z.string().min(1).default("operator"),
    speaker_role: z.string().optional(),
    start_ms: z.number().int().min(0).optional(),
    end_ms: z.number().int().min(0).optional(),
    text: z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
    timing_source: z.string().min(1).optional(),
    metadata_json: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type OperatorTranscriptSegmentInput = z.infer<
  typeof operatorTranscriptSegmentInputSchema
>;

export type OperatorSessionContext = {
  orgId: string;
  workspaceId: string;
  processId: string;
  captureSessionId: string;
  userId: string;
  language: string;
};

type TransactionHandle = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export async function resolveOperatorSessionContext(
  captureSessionId: string,
): Promise<OperatorSessionContext> {
  const db = getServiceDb();
  const rows = await db
    .select({
      captureSessionId: captureSessions.id,
      orgId: captureSessions.orgId,
      workspaceId: captureSessions.workspaceId,
      processId: captureSessions.processId,
      metadataJson: captureSessions.metadataJson,
      createdByUserId: workspaces.createdByUserId,
    })
    .from(captureSessions)
    .innerJoin(workspaces, eq(workspaces.id, captureSessions.workspaceId))
    .where(
      and(
        eq(captureSessions.id, captureSessionId),
        eq(captureSessions.captureType, "operator_interview"),
      ),
    )
    .limit(1);
  const session = rows[0];
  if (!session?.processId) {
    throw new ApiError(404, "not_found", "Operator interview not found.");
  }
  const userId =
    userIdFromMetadata(session.metadataJson) ?? session.createdByUserId;
  if (!userId) {
    throw new ApiError(
      409,
      "conflict",
      "Operator interview has no user to attribute service writes to.",
    );
  }
  return {
    orgId: session.orgId,
    workspaceId: session.workspaceId,
    processId: session.processId,
    captureSessionId: session.captureSessionId,
    userId,
    language: languageFromMetadata(session.metadataJson),
  };
}

export async function ingestOperatorTurn(input: {
  context: OperatorSessionContext;
  utterance?: string;
  transcriptSegments?: OperatorTranscriptSegmentInput[];
  tx?: TransactionHandle;
}) {
  const submittedSegments =
    input.transcriptSegments?.length
      ? input.transcriptSegments
      : [{ speaker: "operator", text: input.utterance ?? "" }];
  const latestUtterance = submittedSegments.map((segment) => segment.text).join("\n");
  if (!latestUtterance.trim()) {
    throw new ApiError(400, "bad_request", "A transcript utterance is required.");
  }

  const ingest = async (tx: TransactionHandle) => {
    await lockOperatorTurnSequence(input.context, tx);
    await assertOperatorCaptureAcceptsTurns(input.context, tx);
    const nextTurnIndex = await nextOperatorTurnIndex(input.context, tx);
    const insertedSegments = await tx
      .insert(transcriptSegments)
      .values(
        submittedSegments.map((segment, index) => {
          const startMs = segment.start_ms ?? index * 1000;
          return {
            orgId: input.context.orgId,
            workspaceId: input.context.workspaceId,
            captureSessionId: input.context.captureSessionId,
            speaker: segment.speaker,
            speakerRole: segment.speaker_role ?? "operator",
            turnIndex: nextTurnIndex,
            startMs,
            endMs: segment.end_ms ?? startMs + Math.max(1000, segment.text.length * 35),
            text: segment.text,
            timingSource: segment.timing_source,
            metadataJson: sanitizedMetadata(segment.metadata_json),
            confidence:
              segment.confidence === undefined
                ? undefined
                : String(segment.confidence),
          };
        }),
      )
      .returning();
    const evidenceRows = [];
    for (const segment of insertedSegments) {
      evidenceRows.push(
        await createOperatorTranscriptEvidence(
          {
            orgId: input.context.orgId,
            workspaceId: input.context.workspaceId,
            transcriptSegmentId: segment.id,
            quote: segment.text,
            confidence: Number(segment.confidence ?? 0.8),
          },
          tx,
        ),
      );
    }
    return {
      transcript_segments: insertedSegments,
      evidence: evidenceRows,
      transcript_segment_ids: insertedSegments.map((segment) => segment.id),
      evidence_ids: evidenceRows.map((row) => row.id),
      turn_index: nextTurnIndex,
      latest_utterance: latestUtterance,
    };
  };
  if (input.tx) return ingest(input.tx);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.context.orgId);
    return ingest(tx);
  });
}

export async function createOperatorTranscriptEvidence(
  input: {
    orgId: string;
    workspaceId: string;
    transcriptSegmentId: string;
    quote: string;
    confidence?: number;
  },
  tx: TransactionHandle,
) {
  return (
    await tx
      .insert(evidence)
      .values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        sourceType: "transcript_segment",
        sourceId: input.transcriptSegmentId,
        evidenceLabel: "stated_operator",
        spanStart: 0,
        spanEnd: input.quote.length,
        quote: input.quote,
        observedAt: new Date(),
        confidence: String(input.confidence ?? 0.8),
      })
      .returning()
  )[0];
}

export async function assertOperatorTurnReferences(input: {
  context: OperatorSessionContext;
  transcriptSegmentIds: string[];
  evidenceIds: string[];
  expectedTurnIndex?: number;
  expectedTurnIndexes?: number[];
  allowMultipleTurnIndexes?: boolean;
  tx?: TransactionHandle;
}) {
  const transcriptSegmentIds = [...new Set(input.transcriptSegmentIds)];
  const evidenceIds = [...new Set(input.evidenceIds)];
  if (transcriptSegmentIds.length === 0 || evidenceIds.length === 0) {
    throw new ApiError(
      400,
      "bad_request",
      "Operator turn dispatch requires transcript_segment_ids and evidence_ids from ingest.",
    );
  }
  const validate = async (tx: TransactionHandle) => {
    const segmentRows = await tx
      .select({ id: transcriptSegments.id, turnIndex: transcriptSegments.turnIndex })
      .from(transcriptSegments)
      .where(
        and(
          eq(transcriptSegments.orgId, input.context.orgId),
          eq(transcriptSegments.workspaceId, input.context.workspaceId),
          eq(transcriptSegments.captureSessionId, input.context.captureSessionId),
          inArray(transcriptSegments.id, transcriptSegmentIds),
        ),
      );
    if (segmentRows.length !== transcriptSegmentIds.length) {
      throw new ApiError(
        400,
        "bad_request",
        "All transcript_segment_ids must belong to this operator capture session.",
      );
    }
    const expectedTurnIndexes = input.expectedTurnIndexes?.length
      ? new Set(input.expectedTurnIndexes)
      : undefined;
    if (expectedTurnIndexes) {
      const turnIndexes = new Set(segmentRows.map((row) => row.turnIndex));
      const unexpected = [...turnIndexes].filter(
        (turnIndex) => turnIndex === null || !expectedTurnIndexes.has(turnIndex),
      );
      if (
        unexpected.length > 0 ||
        (!input.allowMultipleTurnIndexes && turnIndexes.size > 1)
      ) {
        throw new ApiError(
          400,
          "bad_request",
          "Operator transcript segment turn_index values must match the extraction window.",
        );
      }
    } else if (input.expectedTurnIndex !== undefined) {
      const turnIndexes = new Set(segmentRows.map((row) => row.turnIndex));
      if (turnIndexes.size !== 1 || !turnIndexes.has(input.expectedTurnIndex)) {
        throw new ApiError(
          400,
          "bad_request",
          "Operator turn_index must match the ingested transcript segment turn_index.",
        );
      }
    }
    const evidenceRows = await tx
      .select({ id: evidence.id, sourceType: evidence.sourceType, sourceId: evidence.sourceId })
      .from(evidence)
      .where(
        and(
          eq(evidence.orgId, input.context.orgId),
          eq(evidence.workspaceId, input.context.workspaceId),
          inArray(evidence.id, evidenceIds),
        ),
      );
    const segmentSet = new Set(transcriptSegmentIds);
    if (
      evidenceRows.length !== evidenceIds.length ||
      evidenceRows.some(
        (row) =>
          row.sourceType !== "transcript_segment" ||
          !row.sourceId ||
          !segmentSet.has(row.sourceId),
      )
    ) {
      throw new ApiError(
        400,
        "bad_request",
        "All evidence_ids must be transcript evidence created from the submitted operator segments.",
      );
    }
  };
  if (input.tx) return validate(input.tx);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.context.orgId);
    return validate(tx);
  });
}

export async function assertOperatorCaptureAcceptsTurns(
  context: Pick<OperatorSessionContext, "orgId" | "workspaceId" | "captureSessionId">,
  tx: TransactionHandle,
) {
  const session = (
    await tx
      .select({ completedAt: captureSessions.completedAt })
      .from(captureSessions)
      .where(
        and(
          eq(captureSessions.id, context.captureSessionId),
          eq(captureSessions.orgId, context.orgId),
          eq(captureSessions.workspaceId, context.workspaceId),
          eq(captureSessions.captureType, "operator_interview"),
        ),
      )
      .limit(1)
  )[0];
  if (!session) throw new ApiError(404, "not_found", "Operator interview not found.");
  if (session.completedAt) {
    throw new ApiError(
      409,
      "conflict",
      "Operator interview is already completed and cannot accept new turns.",
    );
  }
}

export async function lockOperatorTurnSequence(
  context: Pick<OperatorSessionContext, "captureSessionId">,
  tx: TransactionHandle,
) {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${context.captureSessionId}, 41))
  `);
}

export async function insertOperatorProvisionalStep(
  context: OperatorSessionContext,
  input: {
    title: string;
    actionVerb?: string;
    actionObject?: string;
    tsStartMs?: number;
    tsEndMs?: number;
    confidence: number;
    evidenceIds: string[];
    sourceEventId?: string;
    idempotencyKey?: string;
  },
  tx: TransactionHandle,
) {
  const values = {
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    captureSessionId: context.captureSessionId,
    processId: context.processId,
    tsStartMs: input.tsStartMs ?? 0,
    tsEndMs: input.tsEndMs,
    actionVerb: input.actionVerb,
    actionObject: input.actionObject ?? input.title,
    source: "operator_tool" as const,
    sourceEventId: input.sourceEventId,
    idempotencyKey: input.idempotencyKey,
    confidence: String(input.confidence),
    metadataJson: {
      title: input.title,
      evidence_ids: input.evidenceIds,
    },
  };
  const inserted = await tx
    .insert(provisionalSteps)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  if (!input.idempotencyKey) {
    throw new ApiError(
      409,
      "conflict",
      "Operator provisional step insert was skipped without an idempotency key.",
    );
  }
  const existing = (
    await tx
      .select()
      .from(provisionalSteps)
      .where(
        and(
          eq(provisionalSteps.captureSessionId, context.captureSessionId),
          eq(provisionalSteps.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)
  )[0];
  if (!existing) {
    throw new ApiError(
      409,
      "conflict",
      "Operator provisional step idempotency replay could not be resolved.",
    );
  }
  return existing;
}

export async function upsertOperatorSlotState(
  context: OperatorSessionContext,
  input: {
    slotPath: string;
    provisionalStepId?: string;
    value?: unknown;
    status: "empty" | "partial" | "filled" | "asked_unknown" | "conflicting" | "pending_re_extract";
    confidence: number;
    evidenceIds: string[];
    candidates?: unknown[];
  },
  tx: TransactionHandle,
) {
  assertOperatorSlotPath(input.slotPath);
  const existing = (
    await tx
      .select({ id: slotStates.id })
      .from(slotStates)
      .where(
        and(
          eq(slotStates.orgId, context.orgId),
          eq(slotStates.workspaceId, context.workspaceId),
          eq(slotStates.captureSessionId, context.captureSessionId),
          eq(slotStates.slotPath, input.slotPath),
          input.provisionalStepId
            ? eq(slotStates.provisionalStepId, input.provisionalStepId)
            : isNull(slotStates.provisionalStepId),
          isNull(slotStates.candidateProcessId),
        ),
      )
      .limit(1)
      .for("update")
  )[0];
  const values = {
    provisionalStepId: input.provisionalStepId,
    value: input.value,
    status: input.status,
    confidence: String(input.confidence),
    evidenceIds: input.evidenceIds,
    priority: operatorSlotPriority(input.slotPath),
    candidates: input.candidates,
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
        slotPath: input.slotPath,
        ...values,
      })
      .returning()
  )[0];
}

async function nextOperatorTurnIndex(
  context: OperatorSessionContext,
  tx: TransactionHandle,
) {
  const result = await tx.execute<{ max_turn_index: number | string | null }>(sql`
    SELECT greatest(
      coalesce((
        SELECT max(turn_index)
        FROM transcript_segments
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND capture_session_id = ${context.captureSessionId}
          AND turn_index IS NOT NULL
      ), -1),
      coalesce((
        SELECT max(turn_index)
        FROM agent_decision_log
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND capture_session_id = ${context.captureSessionId}
          AND stage_name = 'operator.turn'
          AND turn_index IS NOT NULL
      ), -1)
    ) AS max_turn_index
  `);
  return Number(result.rows[0]?.max_turn_index ?? -1) + 1;
}

function sanitizedMetadata(metadata: OperatorTranscriptSegmentInput["metadata_json"]) {
  const sanitized = sanitizeJsonForLogs(metadata ?? {});
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized
    : {};
}

export async function updateOperatorTurnDelivery(input: {
  context: OperatorSessionContext;
  turnIndex: number;
  decisionLogId: string;
  deliveryStatus: "completed" | "truncated" | "failed_text_fallback";
  deliveredUtterance: string | null;
  spokenFraction: number;
  latencyMs?: Record<string, number>;
  audioMetadata?: Record<string, unknown>;
  localTurnCorrelationId?: string;
  tx?: TransactionHandle;
}) {
  const update = async (tx: TransactionHandle) => {
    const existing = await tx
      .select({
        id: agentDecisionLog.id,
        deliveryJson: agentDecisionLog.deliveryJson,
      })
      .from(agentDecisionLog)
      .where(
        and(
          eq(agentDecisionLog.id, input.decisionLogId),
          eq(agentDecisionLog.orgId, input.context.orgId),
          eq(agentDecisionLog.workspaceId, input.context.workspaceId),
          eq(agentDecisionLog.captureSessionId, input.context.captureSessionId),
          eq(agentDecisionLog.turnIndex, input.turnIndex),
          eq(agentDecisionLog.stageName, "operator.turn"),
        ),
      )
      .limit(1);
    if (!existing[0]) {
      throw new ApiError(404, "not_found", "Operator turn decision log not found.");
    }
    const currentDelivery = deliveryObject(existing[0].deliveryJson);
    if (isTerminalDeliveryStatus(currentDelivery.delivery_status)) {
      return { id: existing[0].id, deliveryJson: existing[0].deliveryJson };
    }
    const patch = sanitizeJsonForLogs({
      delivery_status: input.deliveryStatus,
      delivered_utterance: input.deliveredUtterance,
      spoken_fraction: input.spokenFraction,
      latency_ms: input.latencyMs ?? {},
      audio_metadata: input.audioMetadata ?? {},
      local_turn_correlation_id: input.localTurnCorrelationId ?? null,
    });
    const result = await tx.execute<{ id: string; delivery_json: unknown }>(sql`
      UPDATE agent_decision_log
      SET delivery_json = coalesce(delivery_json, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
          updated_at = now()
      WHERE id = ${existing[0].id}
        AND coalesce(delivery_json->>'delivery_status', 'pending') = 'pending'
      RETURNING id, delivery_json
    `);
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(409, "conflict", "Operator turn delivery update was not applied.");
    }
    return { id: row.id, deliveryJson: row.delivery_json };
  };
  if (input.tx) return update(input.tx);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.context.orgId);
    return update(tx);
  });
}

export async function readTerminalOperatorTurnDelivery(input: {
  context: OperatorSessionContext;
  turnIndex: number;
  decisionLogId: string;
  tx?: TransactionHandle;
}) {
  const read = async (tx: TransactionHandle) => {
    const result = await tx.execute<{ id: string; delivery_json: unknown }>(sql`
      SELECT id, delivery_json
      FROM agent_decision_log
      WHERE org_id = ${input.context.orgId}
        AND workspace_id = ${input.context.workspaceId}
        AND capture_session_id = ${input.context.captureSessionId}
        AND turn_index = ${input.turnIndex}
        AND id = ${input.decisionLogId}
        AND stage_name = 'operator.turn'
        AND delivery_json->>'delivery_status' IN (
          'completed',
          'truncated',
          'failed_text_fallback'
        )
      LIMIT 1
    `);
    const row = result.rows[0];
    return row ? { id: row.id, deliveryJson: row.delivery_json } : null;
  };
  if (input.tx) return read(input.tx);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.context.orgId);
    return read(tx);
  });
}

function deliveryObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isTerminalDeliveryStatus(status: unknown) {
  return (
    status === "completed" ||
    status === "truncated" ||
    status === "failed_text_fallback"
  );
}

function userIdFromMetadata(metadata: unknown) {
  if (
    metadata &&
    typeof metadata === "object" &&
    "participant_user_id" in metadata &&
    typeof metadata.participant_user_id === "string" &&
    metadata.participant_user_id.trim()
  ) {
    return metadata.participant_user_id.trim();
  }
  return null;
}

function languageFromMetadata(metadata: unknown) {
  if (
    metadata &&
    typeof metadata === "object" &&
    "language" in metadata &&
    typeof metadata.language === "string" &&
    metadata.language.trim()
  ) {
    return metadata.language.trim();
  }
  return "en";
}
