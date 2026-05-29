import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, getServiceDb, setOrgContext } from "@/lib/db/client";
import {
  agentDecisionLog,
  captureSessions,
  candidateProcesses,
  evidence,
  interviewState,
  probeFirings,
  slotStates,
  transcriptSegments,
  workspaceMemberships,
  workspaces,
} from "@/lib/db/schema";
import { ApiError } from "@/lib/http/json";
import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";
import { createTranscriptEvidence } from "@/lib/interview/director/tools";
import { sanitizeJsonForLogs } from "@/lib/security/sanitize";

const DIRECTOR_INTERVIEW_COST_BASELINE_CENTS = 275;
const DIRECTOR_INTERVIEW_COST_ALERT_THRESHOLD_CENTS =
  DIRECTOR_INTERVIEW_COST_BASELINE_CENTS * 2;

export const directorTranscriptSegmentInputSchema = z.object({
  speaker: z.string().min(1).default("director"),
  speaker_role: z.string().optional(),
  start_ms: z.number().int().min(0).optional(),
  end_ms: z.number().int().min(0).optional(),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  timing_source: z.string().min(1).optional(),
  metadata_json: z.record(z.string(), z.unknown()).optional(),
});

export type DirectorSessionContext = {
  orgId: string;
  workspaceId: string;
  captureSessionId: string;
  userId: string;
  language: string;
};

export type DirectorSessionScope = Pick<
  DirectorSessionContext,
  "orgId" | "workspaceId" | "captureSessionId"
>;

export type DirectorTranscriptSegmentInput = z.infer<
  typeof directorTranscriptSegmentInputSchema
>;

type TransactionHandle = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export async function resolveDirectorSessionContext(
  captureSessionId: string,
): Promise<DirectorSessionContext> {
  const db = getServiceDb();
  const rows = await db
    .select({
      captureSessionId: captureSessions.id,
      orgId: captureSessions.orgId,
      workspaceId: captureSessions.workspaceId,
      metadataJson: captureSessions.metadataJson,
      createdByUserId: workspaces.createdByUserId,
    })
    .from(captureSessions)
    .innerJoin(workspaces, eq(workspaces.id, captureSessions.workspaceId))
    .where(
      and(
        eq(captureSessions.id, captureSessionId),
        eq(captureSessions.captureType, "director_interview"),
      ),
    )
    .limit(1);
  const session = rows[0];
  if (!session) {
    throw new ApiError(404, "not_found", "Director interview not found.");
  }

  const userId =
    directorUserIdFromCaptureMetadata(session.metadataJson) ??
    session.createdByUserId ??
    (await firstWorkspaceMemberUserId(session.orgId, session.workspaceId));
  if (!userId) {
    throw new ApiError(
      409,
      "conflict",
      "Director interview has no user to attribute service writes to.",
    );
  }

  return {
    orgId: session.orgId,
    workspaceId: session.workspaceId,
    captureSessionId: session.captureSessionId,
    userId,
    language: languageFromCaptureMetadata(session.metadataJson),
  };
}

export async function assertDirectorTurnReferences(input: {
  context: DirectorSessionContext;
  transcriptSegmentIds: string[];
  evidenceIds: string[];
  expectedTurnIndex?: number;
  expectedTurnIndexes?: number[];
  allowMultipleTurnIndexes?: boolean;
  tx?: TransactionHandle;
}) {
  const transcriptSegmentIds = [...new Set(input.transcriptSegmentIds)];
  const evidenceIds = [...new Set(input.evidenceIds)];
  if (transcriptSegmentIds.length === 0) {
    throw new ApiError(
      400,
      "bad_request",
      "Director turn dispatch requires transcript_segment_ids from ingest.",
    );
  }
  if (evidenceIds.length === 0) {
    throw new ApiError(
      400,
      "bad_request",
      "Director turn dispatch requires evidence_ids from ingest.",
    );
  }

  const validate = async (activeTx: TransactionHandle) => {
    const segmentRows = await activeTx
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
        "All transcript_segment_ids must belong to this director capture session.",
      );
    }
    const segmentTurnIndexes = new Set(
      segmentRows
        .map((row) => row.turnIndex)
        .filter((turnIndex): turnIndex is number => turnIndex !== null),
    );
    const expectedTurnIndexes = new Set(
      input.expectedTurnIndexes?.length
        ? input.expectedTurnIndexes
        : input.expectedTurnIndex !== undefined
          ? [input.expectedTurnIndex]
          : [],
    );
    if (segmentTurnIndexes.size > 1 && !input.allowMultipleTurnIndexes) {
      throw new ApiError(
        400,
        "bad_request",
        "All transcript_segment_ids for a director turn must share the same turn_index.",
      );
    }
    if (input.allowMultipleTurnIndexes && expectedTurnIndexes.size > 0) {
      const invalidTurnIndexes = [...segmentTurnIndexes].filter(
        (turnIndex) => !expectedTurnIndexes.has(turnIndex),
      );
      if (
        segmentTurnIndexes.size === 0 ||
        invalidTurnIndexes.length > 0 ||
        [...expectedTurnIndexes].some((turnIndex) => !segmentTurnIndexes.has(turnIndex))
      ) {
        throw new ApiError(
          400,
          "bad_request",
          "Windowed director transcript segments must match the submitted turn indexes.",
        );
      }
    }
    if (input.expectedTurnIndex !== undefined && !input.allowMultipleTurnIndexes) {
      const [segmentTurnIndex] = [...segmentTurnIndexes];
      if (
        segmentTurnIndex === undefined ||
        segmentTurnIndex !== input.expectedTurnIndex
      ) {
        throw new ApiError(
          400,
          "bad_request",
          "Director turn_index must match the ingested transcript segment turn_index.",
        );
      }
    }

    const evidenceRows = await activeTx
      .select({
        id: evidence.id,
        sourceType: evidence.sourceType,
        sourceId: evidence.sourceId,
      })
      .from(evidence)
      .where(
        and(
          eq(evidence.orgId, input.context.orgId),
          eq(evidence.workspaceId, input.context.workspaceId),
          inArray(evidence.id, evidenceIds),
        ),
      );
    const segmentIdSet = new Set(transcriptSegmentIds);
    const invalidEvidence = evidenceRows.filter(
      (row) =>
        row.sourceType !== "transcript_segment" ||
        !row.sourceId ||
        !segmentIdSet.has(row.sourceId),
    );
    if (
      evidenceRows.length !== evidenceIds.length ||
      invalidEvidence.length > 0
    ) {
      throw new ApiError(
        400,
        "bad_request",
        "All evidence_ids must be transcript evidence created from the submitted segment ids.",
      );
    }
  };
  if (input.tx) return validate(input.tx);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.context.orgId);
    return validate(tx);
  });
}

function languageFromCaptureMetadata(metadata: unknown) {
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

function directorUserIdFromCaptureMetadata(metadata: unknown) {
  if (
    metadata &&
    typeof metadata === "object" &&
    "director_user_id" in metadata &&
    typeof metadata.director_user_id === "string" &&
    metadata.director_user_id.trim()
  ) {
    return metadata.director_user_id.trim();
  }
  return null;
}

function sanitizedTranscriptMetadata(
  metadata: DirectorTranscriptSegmentInput["metadata_json"],
) {
  const sanitized = sanitizeJsonForLogs(metadata ?? {});
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized
    : {};
}

export async function ingestDirectorTurn(input: {
  context: DirectorSessionContext;
  utterance?: string;
  transcriptSegments?: DirectorTranscriptSegmentInput[];
  tx?: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
}) {
  const submittedSegments =
    input.transcriptSegments?.length
      ? input.transcriptSegments
      : [{ speaker: "director", text: input.utterance ?? "" }];
  const latestUtterance = submittedSegments.map((segment) => segment.text).join("\n");
  if (!latestUtterance.trim()) {
    throw new ApiError(400, "bad_request", "A transcript utterance is required.");
  }

  const ingest = async (
    tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  ) => {
    await lockDirectorTurnSequence(input.context, tx);
    await assertDirectorCaptureAcceptsTurns(input.context, tx);
    const nextTurnIndex = await nextDirectorTurnIndex(input.context, tx);
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
            speakerRole: segment.speaker_role ?? "director",
            turnIndex: nextTurnIndex,
            startMs,
            endMs: segment.end_ms ?? startMs + Math.max(1000, segment.text.length * 35),
            text: segment.text,
            timingSource: segment.timing_source,
            metadataJson: sanitizedTranscriptMetadata(segment.metadata_json),
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
        await createTranscriptEvidence(
          {
            orgId: input.context.orgId,
            workspaceId: input.context.workspaceId,
            transcriptSegmentId: segment.id,
            quote: segment.text,
            confidence: Number(segment.confidence ?? 0.8),
          },
          { tx },
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

export async function assertDirectorCaptureAcceptsTurns(
  context: DirectorSessionScope,
  tx?: TransactionHandle,
) {
  const validate = async (activeTx: TransactionHandle) => {
    const rows = await activeTx
      .select({ completedAt: captureSessions.completedAt })
      .from(captureSessions)
      .where(
        and(
          eq(captureSessions.id, context.captureSessionId),
          eq(captureSessions.orgId, context.orgId),
          eq(captureSessions.workspaceId, context.workspaceId),
          eq(captureSessions.captureType, "director_interview"),
        ),
      )
      .limit(1);
    const session = rows[0];
    if (!session) {
      throw new ApiError(404, "not_found", "Director interview not found.");
    }
    if (session.completedAt) {
      throw new ApiError(
        409,
        "conflict",
        "Director interview is already completed and cannot accept new turns.",
      );
    }
  };
  if (tx) return validate(tx);
  return getDb().transaction(async (activeTx) => {
    await setOrgContext(activeTx, context.orgId);
    return validate(activeTx);
  });
}

export async function lockDirectorTurnSequence(
  context: DirectorSessionScope,
  tx: TransactionHandle,
) {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${context.captureSessionId}, 0)
    )
  `);
}

async function nextDirectorTurnIndex(
  context: DirectorSessionContext,
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
          AND stage_name = 'director.turn'
          AND turn_index IS NOT NULL
      ), -1)
    ) AS max_turn_index
  `);
  return Number(result.rows[0]?.max_turn_index ?? -1) + 1;
}

export async function updateDirectorTurnDelivery(input: {
  context: DirectorSessionContext;
  turnIndex: number;
  decisionLogId: string;
  deliveryStatus: "completed" | "truncated" | "failed_text_fallback";
  deliveredUtterance?: string;
  spokenFraction?: number;
  latencyMs?: Record<string, number>;
  audioMetadata?: Record<string, unknown>;
  localTurnCorrelationId?: string;
  tx?: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
}) {
  const update = async (
    activeTx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  ) => {
    const existing = await activeTx.execute<{
      id: string;
      delivery_json: unknown;
      delivery_status: string | null;
      planned_utterance: string | null;
    }>(sql`
      SELECT
        id,
        delivery_json,
        delivery_json->>'delivery_status' AS delivery_status,
        trim(coalesce(delivery_json->>'planned_utterance', sanitized_agent_utterance, ''))
          AS planned_utterance
      FROM agent_decision_log
      WHERE org_id = ${input.context.orgId}
        AND workspace_id = ${input.context.workspaceId}
        AND capture_session_id = ${input.context.captureSessionId}
        AND turn_index = ${input.turnIndex}
        ${input.decisionLogId ? sql`AND id = ${input.decisionLogId}` : sql``}
      LIMIT 1
      FOR UPDATE
    `);
    const existingRow = existing.rows[0];
    if (!existingRow) {
      throw new ApiError(404, "not_found", "Director turn decision log not found.");
    }
    if (isTerminalDeliveryStatus(existingRow.delivery_status)) {
      return { id: existingRow.id, deliveryJson: existingRow.delivery_json };
    }
    if (
      existingRow.delivery_status &&
      existingRow.delivery_status !== "pending"
    ) {
      throw new ApiError(
        409,
        "conflict",
        "Director turn delivery update was not applied.",
      );
    }
    assertDirectorDeliveryUpdateMatchesPlan({
      plannedUtterance: existingRow.planned_utterance ?? "",
      deliveryStatus: input.deliveryStatus,
      deliveredUtterance: input.deliveredUtterance ?? "",
      spokenFraction: input.spokenFraction ?? 0,
    });
    const patch = sanitizeJsonForLogs({
      delivery_status: input.deliveryStatus,
      delivered_utterance: input.deliveredUtterance ?? null,
      spoken_fraction: input.spokenFraction ?? 0,
      latency_ms: input.latencyMs ?? {},
      audio_metadata: input.audioMetadata ?? {},
      local_turn_correlation_id: input.localTurnCorrelationId ?? null,
    });
    const result = await activeTx.execute<{ id: string; delivery_json: unknown }>(sql`
      UPDATE agent_decision_log
      SET delivery_json = coalesce(delivery_json, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
          updated_at = now()
      WHERE id = ${existingRow.id}
        AND coalesce(delivery_json->>'delivery_status', 'pending') = 'pending'
      RETURNING id, delivery_json
    `);
    const row = result.rows[0];
    if (row) {
      return { id: row.id, deliveryJson: row.delivery_json };
    }
    throw new ApiError(409, "conflict", "Director turn delivery update was not applied.");
  };
  if (input.tx) return update(input.tx);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.context.orgId);
    return update(tx);
  });
}

export async function readTerminalDirectorTurnDelivery(input: {
  context: DirectorSessionContext;
  turnIndex: number;
  decisionLogId: string;
  tx?: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
}) {
  const read = async (
    activeTx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  ) => {
    const result = await activeTx.execute<{ id: string; delivery_json: unknown }>(sql`
      SELECT id, delivery_json
      FROM agent_decision_log
      WHERE org_id = ${input.context.orgId}
        AND workspace_id = ${input.context.workspaceId}
        AND capture_session_id = ${input.context.captureSessionId}
        AND turn_index = ${input.turnIndex}
        AND id = ${input.decisionLogId}
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

function isTerminalDeliveryStatus(status: string | null | undefined) {
  return (
    status === "completed" ||
    status === "truncated" ||
    status === "failed_text_fallback"
  );
}

function assertDirectorDeliveryUpdateMatchesPlan(input: {
  plannedUtterance: string;
  deliveryStatus: "completed" | "truncated" | "failed_text_fallback";
  deliveredUtterance: string;
  spokenFraction: number;
}) {
  const planned = input.plannedUtterance.trim();
  const delivered = input.deliveredUtterance.trim();
  if (!planned) {
    throw new ApiError(
      409,
      "conflict",
      "Director delivery update is missing the planned utterance evidence.",
    );
  }
  if (
    input.deliveryStatus === "completed" &&
    (input.spokenFraction !== 1 || delivered !== planned)
  ) {
    throw new ApiError(
      409,
      "conflict",
      "Completed director delivery must match the planned utterance exactly.",
    );
  }
  if (
    input.deliveryStatus === "failed_text_fallback" &&
    (input.spokenFraction !== 0 || delivered !== planned)
  ) {
    throw new ApiError(
      409,
      "conflict",
      "Failed text fallback delivery must preserve the planned utterance.",
    );
  }
  if (input.deliveryStatus !== "truncated") return;
  if (input.spokenFraction < 0 || input.spokenFraction >= 1) {
    throw new ApiError(
      409,
      "conflict",
      "Truncated director delivery requires spoken_fraction below 1.",
    );
  }
  if (input.spokenFraction === 0) {
    if (delivered === "") return;
    throw new ApiError(
      409,
      "conflict",
      "Truncated director delivery with no spoken audio must have an empty delivered utterance.",
    );
  }
  const spokenPrefix = delivered.replace(/\.\.\.$/, "").trim();
  if (!spokenPrefix || !planned.startsWith(spokenPrefix)) {
    throw new ApiError(
      409,
      "conflict",
      "Truncated director delivery must preserve the spoken prefix of the planned utterance.",
    );
  }
}

export async function readDirectorPlanningContext(
  context: DirectorSessionContext,
) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    const slotRows = await tx
      .select({
        slotPath: slotStates.slotPath,
        candidateProcessId: slotStates.candidateProcessId,
        value: slotStates.value,
        status: slotStates.status,
        confidence: slotStates.confidence,
        evidenceIds: slotStates.evidenceIds,
        lastAskedAt: slotStates.lastAskedAt,
        priority: slotStates.priority,
        candidates: slotStates.candidates,
      })
      .from(slotStates)
      .where(
        and(
          eq(slotStates.orgId, context.orgId),
          eq(slotStates.workspaceId, context.workspaceId),
          eq(slotStates.captureSessionId, context.captureSessionId),
        ),
      );
    const recentTurnRows = (
      await tx.execute<{ text: string }>(sql`
        WITH recent_events AS (
          SELECT
            created_at,
            'Director: ' || text AS text
          FROM transcript_segments
          WHERE org_id = ${context.orgId}
            AND workspace_id = ${context.workspaceId}
            AND capture_session_id = ${context.captureSessionId}
            AND speaker_role = 'director'
          UNION ALL
          SELECT
            coalesce(ts_start, created_at) AS created_at,
            'Otto: ' || (
              CASE
                WHEN delivery_json->>'delivery_status' = 'pending' THEN NULL
                WHEN delivery_json->>'delivery_status' = 'truncated'
                  THEN nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), '')
                WHEN delivery_json->>'delivery_status' IN ('completed', 'failed_text_fallback')
                  THEN coalesce(
                    nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), ''),
                    nullif(trim(coalesce(delivery_json->>'planned_utterance', '')), ''),
                    nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                  )
                WHEN delivery_json->>'delivery_status' IS NULL
                  THEN nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                ELSE coalesce(
                  nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), ''),
                  nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                )
              END
            ) AS text
          FROM agent_decision_log
          WHERE org_id = ${context.orgId}
            AND workspace_id = ${context.workspaceId}
            AND capture_session_id = ${context.captureSessionId}
            AND stage_name IN (
              'director.opening',
              'director.notice.asr_stall',
              'director.turn'
            )
            AND (
              CASE
                WHEN delivery_json->>'delivery_status' = 'pending' THEN NULL
                WHEN delivery_json->>'delivery_status' = 'truncated'
                  THEN nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), '')
                WHEN delivery_json->>'delivery_status' IN ('completed', 'failed_text_fallback')
                  THEN coalesce(
                    nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), ''),
                    nullif(trim(coalesce(delivery_json->>'planned_utterance', '')), ''),
                    nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                  )
                WHEN delivery_json->>'delivery_status' IS NULL
                  THEN nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                ELSE coalesce(
                  nullif(trim(coalesce(delivery_json->>'delivered_utterance', '')), ''),
                  nullif(trim(coalesce(sanitized_agent_utterance, '')), '')
                )
              END
            ) IS NOT NULL
        )
        SELECT text
        FROM recent_events
        ORDER BY created_at DESC
        LIMIT 8
      `)
    ).rows;
    const stateRows = await tx
      .select()
      .from(interviewState)
      .where(
        and(
          eq(interviewState.orgId, context.orgId),
          eq(interviewState.workspaceId, context.workspaceId),
          eq(interviewState.captureSessionId, context.captureSessionId),
        ),
      )
      .limit(1);
    const openingRows = await tx
      .select({
        id: agentDecisionLog.id,
        deliveryJson: agentDecisionLog.deliveryJson,
      })
      .from(agentDecisionLog)
      .where(
        and(
          eq(agentDecisionLog.orgId, context.orgId),
          eq(agentDecisionLog.workspaceId, context.workspaceId),
          eq(agentDecisionLog.captureSessionId, context.captureSessionId),
          eq(agentDecisionLog.stageName, "director.opening"),
        ),
      )
      .limit(1);
    const openingDeliveryStatus = deliveryStatusFromJson(
      openingRows[0]?.deliveryJson,
    );
    const hasTerminalOpeningPrompt =
      openingDeliveryStatus === "completed" ||
      openingDeliveryStatus === "truncated" ||
      openingDeliveryStatus === "failed_text_fallback";
    const candidateRows = await tx
      .select({
        id: candidateProcesses.id,
        proposedName: candidateProcesses.proposedName,
        proposedFunction: candidateProcesses.proposedFunction,
        frequency: candidateProcesses.frequency,
        complexityHint: candidateProcesses.complexityHint,
        confidence: candidateProcesses.confidence,
      })
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
      .limit(12);
    const probeFiringRows = await tx
      .select({
        probeId: probeFirings.probeId,
        targetSlot: probeFirings.targetSlot,
        targetCandidateProcessId: probeFirings.targetCandidateProcessId,
        turnIndex: probeFirings.turnIndex,
        firedAt: probeFirings.firedAt,
      })
      .from(probeFirings)
      .where(
        and(
          eq(probeFirings.orgId, context.orgId),
          eq(probeFirings.workspaceId, context.workspaceId),
          eq(probeFirings.captureSessionId, context.captureSessionId),
        ),
      )
      .orderBy(desc(probeFirings.firedAt))
      .limit(200);
    const stalePendingDeliveryRows = (
      await tx.execute<{
        decision_log_id: string;
        turn_index: number | null;
        stage_name: string | null;
        planned_utterance: string | null;
      }>(sql`
        SELECT
          id AS decision_log_id,
          turn_index,
          stage_name,
          coalesce(
            delivery_json->>'planned_utterance',
            sanitized_agent_utterance
          ) AS planned_utterance
        FROM agent_decision_log
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND capture_session_id = ${context.captureSessionId}
          AND stage_name IN ('director.turn', 'director.notice.asr_stall')
          AND turn_index IS NOT NULL
          AND coalesce(delivery_json->>'delivery_status', 'pending') = 'pending'
          AND created_at < now() - interval '30 seconds'
        ORDER BY ts_start ASC
        LIMIT 8
      `)
    ).rows;
    const noticeTurnRows = (
      await tx.execute<{ max_notice_turn_index: string | number | null }>(sql`
        SELECT coalesce(max(turn_index), 1000000000)::int AS max_notice_turn_index
        FROM agent_decision_log
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND capture_session_id = ${context.captureSessionId}
          AND stage_name = 'director.notice.asr_stall'
          AND turn_index IS NOT NULL
      `)
    ).rows;
    const state = stateRows[0];
    const nextTurnIndex = await nextDirectorTurnIndex(context, tx);
    const nextNoticeTurnIndex =
      Number(noticeTurnRows[0]?.max_notice_turn_index ?? 1_000_000_000) + 1;
    return {
      org_id: context.orgId,
      workspace_id: context.workspaceId,
      capture_session_id: context.captureSessionId,
      director_user_id: context.userId,
      language: context.language,
      next_turn_index: nextTurnIndex,
      next_notice_turn_index: nextNoticeTurnIndex,
      current_phase: state?.currentPhase ?? "orient",
      focus_candidate_process_id: state?.focusCandidateProcessId ?? null,
      prior_intent: state?.priorIntent ?? null,
      low_info_turn_count: state?.lowInfoTurnCount ?? 0,
      last_new_slot_turn_index: state?.lastNewSlotTurnIndex ?? null,
      phase_history: state?.phaseHistory ?? [],
      has_opening_prompt: openingRows.length > 0,
      has_terminal_opening_prompt: hasTerminalOpeningPrompt,
      opening_prompt_delivery_status: openingDeliveryStatus,
      slots: slotRows.map((slot) => ({
        slot_path: slot.slotPath,
        ...(slot.candidateProcessId
          ? { candidate_process_id: slot.candidateProcessId }
          : {}),
        value: slot.value,
        status: slot.status,
        confidence: Number(slot.confidence ?? 0),
        evidence_ids: slot.evidenceIds,
        last_asked_at: slot.lastAskedAt?.toISOString(),
        priority: slot.priority,
        candidates: slot.candidates,
      })),
      recent_turns: recentTurnRows.map((row) => row.text).reverse(),
      candidate_processes: candidateRows.map((candidate) => ({
        id: candidate.id,
        proposed_name: candidate.proposedName,
        proposed_function: candidate.proposedFunction,
        frequency: candidate.frequency,
        complexity_hint: candidate.complexityHint,
        confidence: Number(candidate.confidence ?? 0),
      })),
      probe_firings: probeFiringRows.map((firing) => ({
        probe_id: firing.probeId,
        target_slot: firing.targetSlot,
        target_candidate_process_id: firing.targetCandidateProcessId,
        turn_index: firing.turnIndex,
        fired_at: firing.firedAt.toISOString(),
      })),
      stale_pending_delivery_decisions: stalePendingDeliveryRows
        .filter(
          (row) =>
            row.turn_index !== null &&
            row.stage_name !== null &&
            row.planned_utterance !== null &&
            row.planned_utterance.trim().length > 0,
        )
        .map((row) => ({
          decision_log_id: row.decision_log_id,
          turn_index: row.turn_index as number,
          stage_name: row.stage_name as string,
          planned_utterance: row.planned_utterance as string,
        })),
    };
  });
}

export async function readDirectorSessionVerification(
  context: DirectorSessionContext,
) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    const decisionRows = (
      await tx.execute<{
        decision_turns: string | number | null;
        degraded_turns: string | number | null;
        recovered_degraded_turns: string | number | null;
        unresolved_degraded_turns: string | number | null;
        llm_brain_turns: string | number | null;
        llm_voice_turns: string | number | null;
        completed_turns: string | number | null;
        truncated_turns: string | number | null;
        failed_text_fallback_turns: string | number | null;
        pending_delivery_turns: string | number | null;
        unknown_delivery_turns: string | number | null;
        delivery_fidelity_turns: string | number | null;
        tts_playout_turns: string | number | null;
        audible_tts_turns: string | number | null;
        configured_tts_runtime_turns: string | number | null;
        privacy_configured_tts_runtime_turns: string | number | null;
        avg_backend_pre_tts_ms: string | number | null;
        p50_backend_pre_tts_ms: string | number | null;
        p95_backend_pre_tts_ms: string | number | null;
        total_cost_cents: string | number | null;
        cache_hits: string | number | null;
        cache_observed: string | number | null;
        llm_cache_hits: string | number | null;
        llm_cache_observed: string | number | null;
        voice_cache_hits: string | number | null;
        voice_cache_observed: string | number | null;
        llm_cache_read_input_tokens: string | number | null;
        llm_cache_creation_input_tokens: string | number | null;
        voice_cache_read_input_tokens: string | number | null;
        voice_cache_creation_input_tokens: string | number | null;
        streamed_voice_turns: string | number | null;
        voice_timeout_fallback_turns: string | number | null;
        voice_degraded_turns: string | number | null;
      }>(sql`
        WITH recovered AS (
          SELECT tool_calls->>'source_agent_decision_log_id' AS source_decision_log_id
          FROM agent_decision_log
          WHERE org_id = ${context.orgId}
            AND workspace_id = ${context.workspaceId}
            AND capture_session_id = ${context.captureSessionId}
            AND stage_name = 're_extract_degraded_turns.recovered'
        ),
        turns AS (
          SELECT
            d.id,
            d.delivery_json,
            degraded_quality,
            recovered.source_decision_log_id IS NOT NULL AS degraded_recovered,
            model,
            coalesce(cost_cents, 0) AS brain_cost_cents,
            coalesce((delivery_json #>> '{voice_metadata,cost_cents}')::numeric, 0)
              AS voice_cost_cents,
            cache_hit,
            delivery_json #>> '{voice_metadata,model}' AS voice_model,
            delivery_json #>> '{voice_metadata,cache_hit}' AS voice_cache_hit,
            delivery_json #>> '{voice_metadata,streaming}' AS voice_streaming,
            delivery_json #>> '{voice_metadata,stream_cutoff}' AS voice_stream_cutoff,
            delivery_json #>> '{voice_metadata,voice_timeout_fallback}'
              AS voice_timeout_fallback,
            delivery_json #>> '{voice_metadata,voice_degraded}' AS voice_degraded,
            coalesce((delivery_json #>> '{brain_metadata,cache_read_input_tokens}')::int, 0)
              AS brain_cache_read_input_tokens,
            coalesce((delivery_json #>> '{brain_metadata,cache_creation_input_tokens}')::int, 0)
              AS brain_cache_creation_input_tokens,
            coalesce((delivery_json #>> '{voice_metadata,cache_read_input_tokens}')::int, 0)
              AS voice_cache_read_input_tokens,
            coalesce((delivery_json #>> '{voice_metadata,cache_creation_input_tokens}')::int, 0)
              AS voice_cache_creation_input_tokens,
            delivery_json #>> '{audio_metadata,source}' AS audio_source,
            delivery_json #>> '{audio_metadata,provider}' AS audio_provider,
            delivery_json #>> '{audio_metadata,playout}' AS audio_playout,
            delivery_json #>> '{audio_metadata,model}' AS audio_model,
            delivery_json #>> '{audio_metadata,voice_id}' AS audio_voice_id,
            delivery_json #>> '{audio_metadata,language}' AS audio_language,
            delivery_json #>> '{audio_metadata,transport}' AS audio_transport,
            delivery_json->>'delivery_status' AS delivery_status,
            trim(coalesce(delivery_json->>'planned_utterance', ''))
              AS planned_utterance,
            trim(coalesce(delivery_json->>'delivered_utterance', ''))
              AS delivered_utterance,
            coalesce((delivery_json->>'spoken_fraction')::numeric, 0)
              AS spoken_fraction,
            coalesce((delivery_json #>> '{latency_ms,tts_playout_ms}')::int, 0)
              AS tts_playout_ms,
            greatest(
              coalesce((delivery_json #>> '{latency_ms,turn_total_ms}')::int, 0)
              - coalesce((delivery_json #>> '{latency_ms,tts_playout_ms}')::int, 0),
              0
            ) AS backend_pre_tts_ms
          FROM agent_decision_log d
          LEFT JOIN recovered ON recovered.source_decision_log_id = d.id::text
          WHERE d.org_id = ${context.orgId}
            AND d.workspace_id = ${context.workspaceId}
            AND d.capture_session_id = ${context.captureSessionId}
            AND d.stage_name = 'director.turn'
        )
        SELECT
          count(*)::int AS decision_turns,
          count(*) FILTER (WHERE degraded_quality)::int AS degraded_turns,
          count(*) FILTER (
            WHERE degraded_quality AND degraded_recovered
          )::int AS recovered_degraded_turns,
          count(*) FILTER (
            WHERE degraded_quality AND NOT degraded_recovered
          )::int AS unresolved_degraded_turns,
          count(*) FILTER (
            WHERE model IS NOT NULL
              AND model NOT LIKE 'deterministic-%'
          )::int AS llm_brain_turns,
          count(*) FILTER (
            WHERE voice_model IS NOT NULL
              AND voice_model NOT LIKE 'deterministic-%'
          )::int AS llm_voice_turns,
          count(*) FILTER (WHERE delivery_status = 'completed')::int AS completed_turns,
          count(*) FILTER (WHERE delivery_status = 'truncated')::int AS truncated_turns,
          count(*) FILTER (WHERE delivery_status = 'failed_text_fallback')::int AS failed_text_fallback_turns,
          count(*) FILTER (
            WHERE delivery_status IS NULL OR delivery_status = 'pending'
          )::int AS pending_delivery_turns,
          count(*) FILTER (
            WHERE delivery_status IS NOT NULL
              AND delivery_status NOT IN (
                'pending',
                'completed',
                'truncated',
                'failed_text_fallback'
              )
          )::int AS unknown_delivery_turns,
          count(*) FILTER (
            WHERE delivery_status = 'completed'
              AND spoken_fraction = 1
              AND planned_utterance <> ''
              AND delivered_utterance = planned_utterance
          )::int
          + count(*) FILTER (
            WHERE delivery_status = 'truncated'
              AND spoken_fraction >= 0
              AND spoken_fraction < 1
              AND planned_utterance <> ''
              AND (
                (spoken_fraction = 0 AND delivered_utterance = '')
                OR (
                  spoken_fraction > 0
                  AND regexp_replace(delivered_utterance, '\\.\\.\\.$', '') <> ''
                  AND left(
                    planned_utterance,
                    length(regexp_replace(delivered_utterance, '\\.\\.\\.$', ''))
                  ) = regexp_replace(delivered_utterance, '\\.\\.\\.$', '')
                )
              )
          )::int
          + count(*) FILTER (
            WHERE delivery_status = 'failed_text_fallback'
              AND spoken_fraction = 0
              AND planned_utterance <> ''
              AND delivered_utterance = planned_utterance
          )::int AS delivery_fidelity_turns,
          count(*) FILTER (
            WHERE tts_playout_ms > 0
              AND audio_source = 'livekit_agents'
              AND audio_provider = 'cartesia'
              AND audio_playout = 'session.say.wait_for_playout'
          )::int AS tts_playout_turns,
          count(*) FILTER (
            WHERE tts_playout_ms > 0
              AND audio_source = 'livekit_agents'
              AND audio_provider = 'cartesia'
              AND audio_playout = 'session.say.wait_for_playout'
              AND delivery_status IN ('completed', 'truncated')
              AND spoken_fraction > 0
          )::int AS audible_tts_turns,
          count(*) FILTER (
            WHERE tts_playout_ms > 0
              AND audio_source = 'livekit_agents'
              AND audio_provider = 'cartesia'
              AND audio_playout = 'session.say.wait_for_playout'
              AND coalesce(audio_model, '') <> ''
              AND coalesce(audio_voice_id, '') <> ''
              AND coalesce(audio_language, '') <> ''
              AND audio_transport IN ('direct_plugin', 'livekit_inference')
          )::int AS configured_tts_runtime_turns,
          count(*) FILTER (
            WHERE tts_playout_ms > 0
              AND audio_source = 'livekit_agents'
              AND audio_provider = 'cartesia'
              AND audio_playout = 'session.say.wait_for_playout'
              AND coalesce(audio_model, '') <> ''
              AND coalesce(audio_voice_id, '') <> ''
              AND coalesce(audio_language, '') <> ''
              AND audio_transport IN ('direct_plugin', 'livekit_inference')
              AND delivery_json #>> '{audio_metadata,vendor_privacy_ack}' = 'true'
              AND delivery_json #>> '{audio_metadata,privacy_no_retention_ack}' = 'true'
          )::int AS privacy_configured_tts_runtime_turns,
          coalesce(avg(nullif(backend_pre_tts_ms, 0)), 0) AS avg_backend_pre_tts_ms,
          coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY nullif(backend_pre_tts_ms, 0)), 0) AS p50_backend_pre_tts_ms,
          coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY nullif(backend_pre_tts_ms, 0)), 0) AS p95_backend_pre_tts_ms,
          coalesce(sum(brain_cost_cents + voice_cost_cents), 0) AS total_cost_cents,
          count(*) FILTER (WHERE cache_hit IS TRUE)::int AS cache_hits,
          count(*) FILTER (WHERE cache_hit IS NOT NULL)::int AS cache_observed,
          count(*) FILTER (
            WHERE model IS NOT NULL
              AND model NOT LIKE 'deterministic-%'
              AND cache_hit IS TRUE
          )::int AS llm_cache_hits,
          count(*) FILTER (
            WHERE model IS NOT NULL
              AND model NOT LIKE 'deterministic-%'
              AND cache_hit IS NOT NULL
          )::int AS llm_cache_observed,
          count(*) FILTER (
            WHERE voice_model IS NOT NULL
              AND voice_model NOT LIKE 'deterministic-%'
              AND voice_cache_hit = 'true'
          )::int AS voice_cache_hits,
          count(*) FILTER (
            WHERE voice_model IS NOT NULL
              AND voice_model NOT LIKE 'deterministic-%'
              AND voice_cache_hit IS NOT NULL
          )::int AS voice_cache_observed,
          coalesce(sum(brain_cache_read_input_tokens), 0)::int
            AS llm_cache_read_input_tokens,
          coalesce(sum(brain_cache_creation_input_tokens), 0)::int
            AS llm_cache_creation_input_tokens,
          coalesce(sum(voice_cache_read_input_tokens), 0)::int
            AS voice_cache_read_input_tokens,
          coalesce(sum(voice_cache_creation_input_tokens), 0)::int
            AS voice_cache_creation_input_tokens,
          count(*) FILTER (
            WHERE voice_model IS NOT NULL
              AND voice_model NOT LIKE 'deterministic-%'
              AND voice_streaming = 'true'
              AND voice_stream_cutoff = 'first_question'
          )::int AS streamed_voice_turns,
          count(*) FILTER (WHERE voice_timeout_fallback = 'true')::int
            AS voice_timeout_fallback_turns,
          count(*) FILTER (WHERE voice_degraded = 'true')::int
            AS voice_degraded_turns
        FROM turns
      `)
    ).rows[0];

    const promptRows = (
      await tx.execute<{
        voice_prompt_turns: string | number | null;
        opening_prompt_turns: string | number | null;
        completed_prompt_turns: string | number | null;
        truncated_prompt_turns: string | number | null;
        failed_text_fallback_prompt_turns: string | number | null;
        pending_prompt_delivery_turns: string | number | null;
        unknown_prompt_delivery_turns: string | number | null;
        prompt_delivery_fidelity_turns: string | number | null;
        tts_playout_prompt_turns: string | number | null;
        audible_prompt_turns: string | number | null;
        configured_tts_runtime_prompt_turns: string | number | null;
        privacy_configured_tts_runtime_prompt_turns: string | number | null;
      }>(sql`
        WITH prompts AS (
          SELECT
            stage_name,
            delivery_json #>> '{audio_metadata,source}' AS audio_source,
            delivery_json #>> '{audio_metadata,provider}' AS audio_provider,
            delivery_json #>> '{audio_metadata,playout}' AS audio_playout,
            delivery_json #>> '{audio_metadata,model}' AS audio_model,
            delivery_json #>> '{audio_metadata,voice_id}' AS audio_voice_id,
            delivery_json #>> '{audio_metadata,language}' AS audio_language,
            delivery_json #>> '{audio_metadata,transport}' AS audio_transport,
            delivery_json #>> '{audio_metadata,vendor_privacy_ack}' AS vendor_privacy_ack,
            delivery_json #>> '{audio_metadata,privacy_no_retention_ack}'
              AS privacy_no_retention_ack,
            delivery_json->>'delivery_status' AS delivery_status,
            trim(coalesce(delivery_json->>'planned_utterance', ''))
              AS planned_utterance,
            trim(coalesce(delivery_json->>'delivered_utterance', ''))
              AS delivered_utterance,
            coalesce((delivery_json->>'spoken_fraction')::numeric, 0)
              AS spoken_fraction,
            coalesce((delivery_json #>> '{latency_ms,tts_playout_ms}')::int, 0)
              AS tts_playout_ms
          FROM agent_decision_log
          WHERE org_id = ${context.orgId}
            AND workspace_id = ${context.workspaceId}
            AND capture_session_id = ${context.captureSessionId}
            AND stage_name IN ('director.opening', 'director.notice.asr_stall')
        )
        SELECT
          count(*)::int AS voice_prompt_turns,
          count(*) FILTER (WHERE stage_name = 'director.opening')::int AS opening_prompt_turns,
          count(*) FILTER (WHERE delivery_status = 'completed')::int AS completed_prompt_turns,
          count(*) FILTER (WHERE delivery_status = 'truncated')::int AS truncated_prompt_turns,
          count(*) FILTER (WHERE delivery_status = 'failed_text_fallback')::int AS failed_text_fallback_prompt_turns,
          count(*) FILTER (
            WHERE delivery_status IS NULL OR delivery_status = 'pending'
          )::int AS pending_prompt_delivery_turns,
          count(*) FILTER (
            WHERE delivery_status IS NOT NULL
              AND delivery_status NOT IN (
                'pending',
                'completed',
                'truncated',
                'failed_text_fallback'
              )
          )::int AS unknown_prompt_delivery_turns,
          count(*) FILTER (
            WHERE delivery_status = 'completed'
              AND spoken_fraction = 1
              AND planned_utterance <> ''
              AND delivered_utterance = planned_utterance
          )::int
          + count(*) FILTER (
            WHERE delivery_status = 'truncated'
              AND spoken_fraction >= 0
              AND spoken_fraction < 1
              AND planned_utterance <> ''
              AND (
                (spoken_fraction = 0 AND delivered_utterance = '')
                OR (
                  spoken_fraction > 0
                  AND regexp_replace(delivered_utterance, '\\.\\.\\.$', '') <> ''
                  AND left(
                    planned_utterance,
                    length(regexp_replace(delivered_utterance, '\\.\\.\\.$', ''))
                  ) = regexp_replace(delivered_utterance, '\\.\\.\\.$', '')
                )
              )
          )::int
          + count(*) FILTER (
            WHERE delivery_status = 'failed_text_fallback'
              AND spoken_fraction = 0
              AND planned_utterance <> ''
              AND delivered_utterance = planned_utterance
          )::int AS prompt_delivery_fidelity_turns,
          count(*) FILTER (
            WHERE tts_playout_ms > 0
              AND audio_source = 'livekit_agents'
              AND audio_provider = 'cartesia'
              AND audio_playout = 'session.say.wait_for_playout'
          )::int AS tts_playout_prompt_turns,
          count(*) FILTER (
            WHERE tts_playout_ms > 0
              AND audio_source = 'livekit_agents'
              AND audio_provider = 'cartesia'
              AND audio_playout = 'session.say.wait_for_playout'
              AND delivery_status IN ('completed', 'truncated')
              AND spoken_fraction > 0
          )::int AS audible_prompt_turns,
          count(*) FILTER (
            WHERE tts_playout_ms > 0
              AND audio_source = 'livekit_agents'
              AND audio_provider = 'cartesia'
              AND audio_playout = 'session.say.wait_for_playout'
              AND coalesce(audio_model, '') <> ''
              AND coalesce(audio_voice_id, '') <> ''
              AND coalesce(audio_language, '') <> ''
              AND audio_transport IN ('direct_plugin', 'livekit_inference')
          )::int AS configured_tts_runtime_prompt_turns,
          count(*) FILTER (
            WHERE tts_playout_ms > 0
              AND audio_source = 'livekit_agents'
              AND audio_provider = 'cartesia'
              AND audio_playout = 'session.say.wait_for_playout'
              AND coalesce(audio_model, '') <> ''
              AND coalesce(audio_voice_id, '') <> ''
              AND coalesce(audio_language, '') <> ''
              AND audio_transport IN ('direct_plugin', 'livekit_inference')
              AND vendor_privacy_ack = 'true'
              AND privacy_no_retention_ack = 'true'
          )::int AS privacy_configured_tts_runtime_prompt_turns
        FROM prompts
      `)
    ).rows[0];

    const captureRow = (
      await tx
        .select({ completedAt: captureSessions.completedAt })
        .from(captureSessions)
        .where(
          and(
            eq(captureSessions.orgId, context.orgId),
            eq(captureSessions.workspaceId, context.workspaceId),
            eq(captureSessions.id, context.captureSessionId),
            eq(captureSessions.captureType, "director_interview"),
          ),
        )
        .limit(1)
    )[0];

    const transcriptRows = (
      await tx.execute<{
        transcript_turns: string | number | null;
        transcript_segments: string | number | null;
        asr_metrics_turns: string | number | null;
        asr_metrics_segments: string | number | null;
        livekit_deepgram_asr_metrics_turns: string | number | null;
        livekit_deepgram_asr_metrics_segments: string | number | null;
        configured_asr_runtime_turns: string | number | null;
        configured_asr_runtime_segments: string | number | null;
        privacy_configured_asr_runtime_turns: string | number | null;
        privacy_configured_asr_runtime_segments: string | number | null;
        estimated_timing_turns: string | number | null;
        estimated_timing_segments: string | number | null;
      }>(sql`
        WITH director_segments AS (
          SELECT
            id,
            coalesce(turn_index::text, id::text) AS turn_key,
            timing_source,
            metadata_json
          FROM transcript_segments
          WHERE org_id = ${context.orgId}
            AND workspace_id = ${context.workspaceId}
            AND capture_session_id = ${context.captureSessionId}
            AND speaker_role = 'director'
        )
        SELECT
          count(DISTINCT turn_key)::int AS transcript_turns,
          count(*)::int AS transcript_segments,
          count(DISTINCT turn_key) FILTER (
            WHERE timing_source = 'asr_metrics'
          )::int AS asr_metrics_turns,
          count(*) FILTER (WHERE timing_source = 'asr_metrics')::int AS asr_metrics_segments,
          count(DISTINCT turn_key) FILTER (
            WHERE timing_source = 'asr_metrics'
              AND metadata_json->>'source' = 'livekit_agents'
              AND metadata_json->>'provider' = 'deepgram'
              AND metadata_json->>'timing' = 'started_stopped_speaking_at'
          )::int AS livekit_deepgram_asr_metrics_turns,
          count(*) FILTER (
            WHERE timing_source = 'asr_metrics'
              AND metadata_json->>'source' = 'livekit_agents'
              AND metadata_json->>'provider' = 'deepgram'
              AND metadata_json->>'timing' = 'started_stopped_speaking_at'
          )::int AS livekit_deepgram_asr_metrics_segments,
          count(DISTINCT turn_key) FILTER (
            WHERE timing_source = 'asr_metrics'
              AND metadata_json->>'source' = 'livekit_agents'
              AND metadata_json->>'provider' = 'deepgram'
              AND metadata_json->>'timing' = 'started_stopped_speaking_at'
              AND coalesce(metadata_json->>'model', '') <> ''
              AND coalesce(metadata_json->>'language', '') <> ''
              AND metadata_json->>'transport' IN ('direct_plugin', 'livekit_inference')
          )::int AS configured_asr_runtime_turns,
          count(*) FILTER (
            WHERE timing_source = 'asr_metrics'
              AND metadata_json->>'source' = 'livekit_agents'
              AND metadata_json->>'provider' = 'deepgram'
              AND metadata_json->>'timing' = 'started_stopped_speaking_at'
              AND coalesce(metadata_json->>'model', '') <> ''
              AND coalesce(metadata_json->>'language', '') <> ''
              AND metadata_json->>'transport' IN ('direct_plugin', 'livekit_inference')
          )::int AS configured_asr_runtime_segments,
          count(DISTINCT turn_key) FILTER (
            WHERE timing_source = 'asr_metrics'
              AND metadata_json->>'source' = 'livekit_agents'
              AND metadata_json->>'provider' = 'deepgram'
              AND metadata_json->>'timing' = 'started_stopped_speaking_at'
              AND coalesce(metadata_json->>'model', '') <> ''
              AND coalesce(metadata_json->>'language', '') <> ''
              AND metadata_json->>'transport' IN ('direct_plugin', 'livekit_inference')
              AND metadata_json->>'vendor_privacy_ack' = 'true'
              AND metadata_json->>'privacy_no_store_ack' = 'true'
              AND metadata_json->>'mip_opt_out' IN ('true', 'managed_by_livekit_inference')
          )::int AS privacy_configured_asr_runtime_turns,
          count(*) FILTER (
            WHERE timing_source = 'asr_metrics'
              AND metadata_json->>'source' = 'livekit_agents'
              AND metadata_json->>'provider' = 'deepgram'
              AND metadata_json->>'timing' = 'started_stopped_speaking_at'
              AND coalesce(metadata_json->>'model', '') <> ''
              AND coalesce(metadata_json->>'language', '') <> ''
              AND metadata_json->>'transport' IN ('direct_plugin', 'livekit_inference')
              AND metadata_json->>'vendor_privacy_ack' = 'true'
              AND metadata_json->>'privacy_no_store_ack' = 'true'
              AND metadata_json->>'mip_opt_out' IN ('true', 'managed_by_livekit_inference')
          )::int AS privacy_configured_asr_runtime_segments,
          count(DISTINCT turn_key) FILTER (
            WHERE timing_source IS NULL OR timing_source <> 'asr_metrics'
          )::int AS estimated_timing_turns,
          count(*) FILTER (
            WHERE timing_source IS NULL OR timing_source <> 'asr_metrics'
          )::int AS estimated_timing_segments
        FROM director_segments
      `)
    ).rows[0];
    const turnContractRows = (
      await tx.execute<{
        decision_turns_with_transcript_segments: string | number | null;
        decision_turns_with_matching_transcript_segments: string | number | null;
        decision_turns_with_transcript_evidence: string | number | null;
      }>(sql`
        WITH turns AS (
          SELECT id, turn_index, transcript_segment_ids
          FROM agent_decision_log
          WHERE org_id = ${context.orgId}
            AND workspace_id = ${context.workspaceId}
            AND capture_session_id = ${context.captureSessionId}
            AND stage_name = 'director.turn'
        )
        SELECT
          count(*) FILTER (
            WHERE cardinality(coalesce(transcript_segment_ids, '{}'::uuid[])) > 0
          )::int AS decision_turns_with_transcript_segments,
          count(*) FILTER (
            WHERE cardinality(coalesce(transcript_segment_ids, '{}'::uuid[])) > 0
              AND NOT EXISTS (
                SELECT 1
                FROM unnest(transcript_segment_ids) AS segment(segment_id)
                LEFT JOIN transcript_segments ts
                  ON ts.id = segment.segment_id
                 AND ts.org_id = ${context.orgId}
                 AND ts.workspace_id = ${context.workspaceId}
                 AND ts.capture_session_id = ${context.captureSessionId}
                 AND ts.speaker_role = 'director'
                 AND ts.turn_index = turns.turn_index
                WHERE ts.id IS NULL
              )
          )::int AS decision_turns_with_matching_transcript_segments,
          count(*) FILTER (
            WHERE cardinality(coalesce(transcript_segment_ids, '{}'::uuid[])) > 0
              AND NOT EXISTS (
                SELECT 1
                FROM unnest(transcript_segment_ids) AS segment(segment_id)
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM evidence e
                  WHERE e.org_id = ${context.orgId}
                    AND e.workspace_id = ${context.workspaceId}
                    AND e.source_type = 'transcript_segment'
                    AND e.source_id = segment.segment_id
                )
              )
          )::int AS decision_turns_with_transcript_evidence
        FROM turns
      `)
    ).rows[0];

    const vendorAuditRows = (
      await tx.execute<{
        vendor_export_audits: string | number | null;
        livekit_vendor_export_audits: string | number | null;
        anthropic_vendor_export_audits: string | number | null;
        privacy_ack_vendor_export_audits: string | number | null;
        stable_agent_identity_audits: string | number | null;
        audio_retention_vendor_audits: string | number | null;
        audio_retention_enabled_audits: string | number | null;
        raw_payload_logging_vendor_audits: string | number | null;
        raw_payload_logging_enabled_audits: string | number | null;
      }>(sql`
        WITH capture_audits AS (
          SELECT event_type, metadata_json
          FROM audit_log
          WHERE org_id = ${context.orgId}
            AND workspace_id = ${context.workspaceId}
            AND subject_type = 'capture_session'
            AND subject_id = ${context.captureSessionId}
            AND event_type IN (
              'capture.director_voice.vendor_export',
              'capture.director_voice.audio_retention_enabled',
              'capture.director_voice.raw_payload_logging_enabled'
            )
        ),
        vendor_audits AS (
          SELECT metadata_json
          FROM capture_audits
          WHERE event_type = 'capture.director_voice.vendor_export'
        )
        SELECT
          count(*)::int AS vendor_export_audits,
          count(*) FILTER (
            WHERE metadata_json->>'room_mode' = 'livekit'
              AND metadata_json->'vendors' ? 'livekit'
              AND metadata_json->'vendors' ? 'deepgram'
              AND metadata_json->'vendors' ? 'cartesia'
          )::int AS livekit_vendor_export_audits,
          count(*) FILTER (
            WHERE metadata_json->>'room_mode' = 'livekit'
              AND metadata_json->'vendors' ? 'anthropic'
          )::int AS anthropic_vendor_export_audits,
          count(*) FILTER (
            WHERE metadata_json #>> '{vendor_privacy_controls,vendor_privacy_ack}' = 'true'
              AND metadata_json #>> '{vendor_privacy_controls,deepgram_no_store_ack}' = 'true'
              AND metadata_json #>> '{vendor_privacy_controls,cartesia_no_retention_ack}' = 'true'
              AND metadata_json #>> '{vendor_privacy_controls,anthropic_raw_logging_off_ack}' = 'true'
          )::int AS privacy_ack_vendor_export_audits,
          count(*) FILTER (
            WHERE metadata_json->>'room_mode' = 'livekit'
              AND metadata_json->>'agent_participant_identity' =
                ('otto-director-agent-' || ${context.captureSessionId})
          )::int AS stable_agent_identity_audits,
          count(*) FILTER (
            WHERE metadata_json #>> '{retention_policy,audio_recording_enabled}' = 'true'
          )::int AS audio_retention_vendor_audits,
          (
            SELECT count(*)::int
            FROM capture_audits
            WHERE event_type = 'capture.director_voice.audio_retention_enabled'
          ) AS audio_retention_enabled_audits,
          count(*) FILTER (
            WHERE metadata_json #>> '{retention_policy,raw_payload_logging}' = 'debug_window_enabled'
          )::int AS raw_payload_logging_vendor_audits,
          (
            SELECT count(*)::int
            FROM capture_audits
            WHERE event_type = 'capture.director_voice.raw_payload_logging_enabled'
          ) AS raw_payload_logging_enabled_audits
        FROM vendor_audits
      `)
    ).rows[0];

    const candidateCountRows = (
      await tx.execute<{ candidate_process_count: string | number | null }>(sql`
        SELECT count(*)::int AS candidate_process_count
        FROM candidate_processes
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND capture_session_id = ${context.captureSessionId}
      `)
    ).rows[0];
    const duplicateCandidateRows = (
      await tx.execute<{
        duplicate_candidate_process_name_groups: string | number | null;
        duplicate_candidate_process_names: unknown;
      }>(sql`
        WITH normalized_candidates AS (
          SELECT
            lower(regexp_replace(trim(proposed_name), '\\s+', ' ', 'g'))
              AS normalized_name,
            array_agg(proposed_name ORDER BY created_at) AS proposed_names
          FROM candidate_processes
          WHERE org_id = ${context.orgId}
            AND workspace_id = ${context.workspaceId}
            AND capture_session_id = ${context.captureSessionId}
          GROUP BY lower(regexp_replace(trim(proposed_name), '\\s+', ' ', 'g'))
          HAVING count(*) > 1
        )
        SELECT
          count(*)::int AS duplicate_candidate_process_name_groups,
          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'normalized_name',
                normalized_name,
                'proposed_names',
                proposed_names
              )
              ORDER BY normalized_name
            ),
            '[]'::jsonb
          ) AS duplicate_candidate_process_names
        FROM normalized_candidates
      `)
    ).rows[0];
    const candidateRows = await tx
      .select({
        id: candidateProcesses.id,
        proposedName: candidateProcesses.proposedName,
        proposedFunction: candidateProcesses.proposedFunction,
        status: candidateProcesses.status,
      })
      .from(candidateProcesses)
      .where(
        and(
          eq(candidateProcesses.orgId, context.orgId),
          eq(candidateProcesses.workspaceId, context.workspaceId),
          eq(candidateProcesses.captureSessionId, context.captureSessionId),
        ),
      )
      .orderBy(desc(candidateProcesses.createdAt))
      .limit(20);
    const synthesisRows = (
      await tx.execute<{
        synthesis_run_count: string | number | null;
        terminal_synthesis_run_count: string | number | null;
        completed_synthesis_run_count: string | number | null;
        partial_synthesis_run_count: string | number | null;
      }>(sql`
        SELECT
          count(*)::int AS synthesis_run_count,
          count(*) FILTER (
            WHERE status IN ('completed', 'partial_synthesis')
          )::int AS terminal_synthesis_run_count,
          count(*) FILTER (WHERE status = 'completed')::int
            AS completed_synthesis_run_count,
          count(*) FILTER (WHERE status = 'partial_synthesis')::int
            AS partial_synthesis_run_count
        FROM synthesis_runs
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND capture_session_ids @> ARRAY[${context.captureSessionId}]::uuid[]
      `)
    ).rows[0];
    const overviewRows = (
      await tx.execute<{
        overview_process_cards: string | number | null;
        evidence_linked_overview_cards: string | number | null;
      }>(sql`
        WITH cards AS (
          SELECT
            cp.id,
            cardinality(coalesce(cp.evidence_ids, '{}'::uuid[])) AS evidence_count
          FROM candidate_processes cp
          WHERE cp.org_id = ${context.orgId}
            AND cp.workspace_id = ${context.workspaceId}
            AND cp.status = 'pending'
          UNION ALL
          SELECT
            p.id,
            count(DISTINCT ce.evidence_id)::int AS evidence_count
          FROM processes p
          LEFT JOIN claims evidence_claim
            ON evidence_claim.subject_type = 'process'
           AND evidence_claim.subject_id = p.id
           AND evidence_claim.status = 'active'
           AND evidence_claim.superseded_by_claim_id IS NULL
          LEFT JOIN claim_evidence ce ON ce.claim_id = evidence_claim.id
          WHERE p.org_id = ${context.orgId}
            AND p.workspace_id = ${context.workspaceId}
            AND p.status IN ('draft', 'approved')
          GROUP BY p.id
        )
        SELECT
          count(*)::int AS overview_process_cards,
          count(*) FILTER (WHERE evidence_count > 0)::int
            AS evidence_linked_overview_cards
        FROM cards
      `)
    ).rows[0];

    const priority1Definitions = directorSlotDefinitions.filter(
      (definition) => definition.priority >= 90,
    );
    const priority1SlotPaths = priority1Definitions.map((definition) => definition.path);
    const priority1SlotRows = priority1SlotPaths.length
      ? await tx
          .select({
            slotPath: slotStates.slotPath,
            status: slotStates.status,
          })
          .from(slotStates)
          .where(
            and(
              eq(slotStates.orgId, context.orgId),
              eq(slotStates.workspaceId, context.workspaceId),
              eq(slotStates.captureSessionId, context.captureSessionId),
              inArray(slotStates.slotPath, priority1SlotPaths),
            ),
          )
      : [];

    const decisionTurns = toVerificationNumber(decisionRows?.decision_turns);
    const degradedTurns = toVerificationNumber(decisionRows?.degraded_turns);
    const recoveredDegradedTurns = toVerificationNumber(
      decisionRows?.recovered_degraded_turns,
    );
    const unresolvedDegradedTurns = toVerificationNumber(
      decisionRows?.unresolved_degraded_turns,
    );
    const llmBrainTurns = toVerificationNumber(decisionRows?.llm_brain_turns);
    const llmVoiceTurns = toVerificationNumber(decisionRows?.llm_voice_turns);
    const pendingDeliveryTurns = toVerificationNumber(
      decisionRows?.pending_delivery_turns,
    );
    const completedTurns = toVerificationNumber(decisionRows?.completed_turns);
    const truncatedTurns = toVerificationNumber(decisionRows?.truncated_turns);
    const failedTextFallbackTurns = toVerificationNumber(
      decisionRows?.failed_text_fallback_turns,
    );
    const unknownDeliveryTurns = toVerificationNumber(
      decisionRows?.unknown_delivery_turns,
    );
    const terminalDeliveryTurns =
      completedTurns + truncatedTurns + failedTextFallbackTurns;
    const deliveryFidelityTurns = toVerificationNumber(
      decisionRows?.delivery_fidelity_turns,
    );
    const ttsPlayoutTurns = toVerificationNumber(decisionRows?.tts_playout_turns);
    const audibleTtsTurns = toVerificationNumber(decisionRows?.audible_tts_turns);
    const voicePromptTurns = toVerificationNumber(promptRows?.voice_prompt_turns);
    const openingPromptTurns = toVerificationNumber(promptRows?.opening_prompt_turns);
    const completedPromptTurns = toVerificationNumber(
      promptRows?.completed_prompt_turns,
    );
    const truncatedPromptTurns = toVerificationNumber(
      promptRows?.truncated_prompt_turns,
    );
    const failedTextFallbackPromptTurns = toVerificationNumber(
      promptRows?.failed_text_fallback_prompt_turns,
    );
    const pendingPromptDeliveryTurns = toVerificationNumber(
      promptRows?.pending_prompt_delivery_turns,
    );
    const unknownPromptDeliveryTurns = toVerificationNumber(
      promptRows?.unknown_prompt_delivery_turns,
    );
    const terminalPromptDeliveryTurns =
      completedPromptTurns + truncatedPromptTurns + failedTextFallbackPromptTurns;
    const promptDeliveryFidelityTurns = toVerificationNumber(
      promptRows?.prompt_delivery_fidelity_turns,
    );
    const ttsPlayoutPromptTurns = toVerificationNumber(
      promptRows?.tts_playout_prompt_turns,
    );
    const audiblePromptTurns = toVerificationNumber(promptRows?.audible_prompt_turns);
    const configuredTtsRuntimePromptTurns = toVerificationNumber(
      promptRows?.configured_tts_runtime_prompt_turns,
    );
    const privacyConfiguredTtsRuntimePromptTurns = toVerificationNumber(
      promptRows?.privacy_configured_tts_runtime_prompt_turns,
    );
    const candidateProcessCount = toVerificationNumber(
      candidateCountRows?.candidate_process_count,
    );
    const duplicateCandidateProcessNameGroups = toVerificationNumber(
      duplicateCandidateRows?.duplicate_candidate_process_name_groups,
    );
    const synthesisRunCount = toVerificationNumber(
      synthesisRows?.synthesis_run_count,
    );
    const terminalSynthesisRunCount = toVerificationNumber(
      synthesisRows?.terminal_synthesis_run_count,
    );
    const completedSynthesisRunCount = toVerificationNumber(
      synthesisRows?.completed_synthesis_run_count,
    );
    const partialSynthesisRunCount = toVerificationNumber(
      synthesisRows?.partial_synthesis_run_count,
    );
    const overviewProcessCards = toVerificationNumber(
      overviewRows?.overview_process_cards,
    );
    const evidenceLinkedOverviewCards = toVerificationNumber(
      overviewRows?.evidence_linked_overview_cards,
    );
    const transcriptTurns = toVerificationNumber(transcriptRows?.transcript_turns);
    const transcriptSegmentCount = toVerificationNumber(
      transcriptRows?.transcript_segments,
    );
    const decisionTurnsWithTranscriptSegments = toVerificationNumber(
      turnContractRows?.decision_turns_with_transcript_segments,
    );
    const decisionTurnsWithMatchingTranscriptSegments = toVerificationNumber(
      turnContractRows?.decision_turns_with_matching_transcript_segments,
    );
    const decisionTurnsWithTranscriptEvidence = toVerificationNumber(
      turnContractRows?.decision_turns_with_transcript_evidence,
    );
    const asrMetricsTurns = toVerificationNumber(transcriptRows?.asr_metrics_turns);
    const asrMetricsSegmentCount = toVerificationNumber(
      transcriptRows?.asr_metrics_segments,
    );
    const livekitDeepgramAsrMetricsTurns = toVerificationNumber(
      transcriptRows?.livekit_deepgram_asr_metrics_turns,
    );
    const livekitDeepgramAsrMetricsSegmentCount = toVerificationNumber(
      transcriptRows?.livekit_deepgram_asr_metrics_segments,
    );
    const configuredAsrRuntimeTurns = toVerificationNumber(
      transcriptRows?.configured_asr_runtime_turns,
    );
    const configuredAsrRuntimeSegmentCount = toVerificationNumber(
      transcriptRows?.configured_asr_runtime_segments,
    );
    const privacyConfiguredAsrRuntimeTurns = toVerificationNumber(
      transcriptRows?.privacy_configured_asr_runtime_turns,
    );
    const privacyConfiguredAsrRuntimeSegmentCount = toVerificationNumber(
      transcriptRows?.privacy_configured_asr_runtime_segments,
    );
    const vendorExportAudits = toVerificationNumber(
      vendorAuditRows?.vendor_export_audits,
    );
    const livekitVendorExportAudits = toVerificationNumber(
      vendorAuditRows?.livekit_vendor_export_audits,
    );
    const anthropicVendorExportAudits = toVerificationNumber(
      vendorAuditRows?.anthropic_vendor_export_audits,
    );
    const privacyAckVendorExportAudits = toVerificationNumber(
      vendorAuditRows?.privacy_ack_vendor_export_audits,
    );
    const stableAgentIdentityAudits = toVerificationNumber(
      vendorAuditRows?.stable_agent_identity_audits,
    );
    const audioRetentionVendorAudits = toVerificationNumber(
      vendorAuditRows?.audio_retention_vendor_audits,
    );
    const audioRetentionEnabledAudits = toVerificationNumber(
      vendorAuditRows?.audio_retention_enabled_audits,
    );
    const rawPayloadLoggingVendorAudits = toVerificationNumber(
      vendorAuditRows?.raw_payload_logging_vendor_audits,
    );
    const rawPayloadLoggingEnabledAudits = toVerificationNumber(
      vendorAuditRows?.raw_payload_logging_enabled_audits,
    );
    const estimatedTimingTurns = toVerificationNumber(
      transcriptRows?.estimated_timing_turns,
    );
    const estimatedTimingSegmentCount = toVerificationNumber(
      transcriptRows?.estimated_timing_segments,
    );
    const p95BackendPreTtsMs = Math.round(
      toVerificationNumber(decisionRows?.p95_backend_pre_tts_ms),
    );
    const p50BackendPreTtsMs = Math.round(
      toVerificationNumber(decisionRows?.p50_backend_pre_tts_ms),
    );
    const totalCostCents = toVerificationNumber(decisionRows?.total_cost_cents);
    const priority1StatusByPath = new Map(
      priority1SlotRows.map((slot) => [slot.slotPath, slot.status]),
    );
    const priority1Slots = priority1Definitions.length;
    const priority1CoveredSlots = priority1Definitions.filter((definition) =>
      ["filled", "asked_unknown"].includes(
        priority1StatusByPath.get(definition.path) ?? "empty",
      ),
    ).length;
    const priority1PartialOrConflictingSlots = priority1Definitions.filter((definition) =>
      ["partial", "conflicting"].includes(
        priority1StatusByPath.get(definition.path) ?? "empty",
      ),
    ).length;
    const cacheObserved = toVerificationNumber(decisionRows?.cache_observed);
    const llmCacheHits = toVerificationNumber(decisionRows?.llm_cache_hits);
    const llmCacheObserved = toVerificationNumber(decisionRows?.llm_cache_observed);
    const voiceCacheHits = toVerificationNumber(decisionRows?.voice_cache_hits);
    const voiceCacheObserved = toVerificationNumber(
      decisionRows?.voice_cache_observed,
    );
    const llmCacheHitRate =
      llmCacheObserved === 0 ? 0 : Math.round((llmCacheHits / llmCacheObserved) * 100);
    const voiceCacheHitRate =
      voiceCacheObserved === 0
        ? 0
        : Math.round((voiceCacheHits / voiceCacheObserved) * 100);
    const llmCacheReadInputTokens = toVerificationNumber(
      decisionRows?.llm_cache_read_input_tokens,
    );
    const llmCacheCreationInputTokens = toVerificationNumber(
      decisionRows?.llm_cache_creation_input_tokens,
    );
    const voiceCacheReadInputTokens = toVerificationNumber(
      decisionRows?.voice_cache_read_input_tokens,
    );
    const voiceCacheCreationInputTokens = toVerificationNumber(
      decisionRows?.voice_cache_creation_input_tokens,
    );
    const streamedVoiceTurns = toVerificationNumber(
      decisionRows?.streamed_voice_turns,
    );
    const voiceTimeoutFallbackTurns = toVerificationNumber(
      decisionRows?.voice_timeout_fallback_turns,
    );
    const voiceDegradedTurns = toVerificationNumber(
      decisionRows?.voice_degraded_turns,
    );
    const configuredTtsRuntimeTurns = toVerificationNumber(
      decisionRows?.configured_tts_runtime_turns,
    );
    const privacyConfiguredTtsRuntimeTurns = toVerificationNumber(
      decisionRows?.privacy_configured_tts_runtime_turns,
    );
    const priority1CoverageRatio =
      priority1Slots === 0 ? 1 : priority1CoveredSlots / priority1Slots;
    const acceptance = {
      has_transcript: transcriptTurns > 0,
      capture_session_completed: Boolean(captureRow?.completedAt),
      has_real_asr_timing: livekitDeepgramAsrMetricsTurns > 0,
      has_configured_asr_runtime: configuredAsrRuntimeTurns > 0,
      has_privacy_configured_asr_runtime:
        privacyConfiguredAsrRuntimeTurns > 0,
      has_tts_playout_timing: ttsPlayoutTurns > 0,
      has_audible_tts_delivery: audibleTtsTurns > 0,
      has_configured_tts_runtime: configuredTtsRuntimeTurns > 0,
      has_privacy_configured_tts_runtime:
        privacyConfiguredTtsRuntimeTurns > 0,
      has_vendor_export_audit: vendorExportAudits > 0,
      no_duplicate_vendor_export_audits: vendorExportAudits <= 1,
      has_livekit_vendor_export_audit: livekitVendorExportAudits > 0,
      has_anthropic_vendor_export_audit: anthropicVendorExportAudits > 0,
      has_stable_livekit_agent_identity: stableAgentIdentityAudits > 0,
      vendor_privacy_controls_acknowledged: privacyAckVendorExportAudits > 0,
      audio_retention_audit_consistent:
        audioRetentionVendorAudits === 0 || audioRetentionEnabledAudits > 0,
      raw_payload_logging_audit_consistent:
        rawPayloadLoggingVendorAudits === 0 || rawPayloadLoggingEnabledAudits > 0,
      no_failed_text_fallback_turns: decisionTurns > 0 && failedTextFallbackTurns === 0,
      has_opening_prompt: openingPromptTurns > 0,
      opening_prompt_has_tts_playout: ttsPlayoutPromptTurns > 0,
      voice_prompts_have_configured_tts_runtime:
        voicePromptTurns > 0 &&
        configuredTtsRuntimePromptTurns === voicePromptTurns,
      voice_prompts_have_privacy_configured_tts_runtime:
        voicePromptTurns > 0 &&
        privacyConfiguredTtsRuntimePromptTurns === voicePromptTurns,
      all_voice_prompts_delivery_terminal:
        voicePromptTurns > 0 &&
        pendingPromptDeliveryTurns === 0 &&
        unknownPromptDeliveryTurns === 0 &&
        terminalPromptDeliveryTurns === voicePromptTurns,
      all_voice_prompts_have_spoken_evidence:
        voicePromptTurns > 0 && promptDeliveryFidelityTurns === voicePromptTurns,
      no_failed_text_fallback_voice_prompts:
        voicePromptTurns > 0 && failedTextFallbackPromptTurns === 0,
      has_llm_brain_turn: llmBrainTurns > 0,
      has_llm_voice_turn: llmVoiceTurns > 0,
      has_streamed_voice_turn: streamedVoiceTurns > 0,
      has_llm_cache_observation: llmCacheObserved > 0,
      has_voice_cache_observation: voiceCacheObserved > 0,
      llm_cache_hit_rate_target: llmCacheObserved > 0 && llmCacheHitRate >= 60,
      voice_cache_hit_rate_target:
        voiceCacheObserved > 0 && voiceCacheHitRate >= 60,
      no_degraded_turns: decisionTurns > 0 && unresolvedDegradedTurns === 0,
      has_decision_turns: decisionTurns > 0,
      all_decisions_have_ingested_transcript_evidence:
        decisionTurns > 0 &&
        decisionTurnsWithTranscriptSegments === decisionTurns &&
        decisionTurnsWithMatchingTranscriptSegments === decisionTurns &&
        decisionTurnsWithTranscriptEvidence === decisionTurns,
      all_delivery_terminal:
        decisionTurns > 0 &&
        pendingDeliveryTurns === 0 &&
        unknownDeliveryTurns === 0 &&
        terminalDeliveryTurns === decisionTurns,
      all_terminal_delivery_has_spoken_evidence:
        decisionTurns > 0 && deliveryFidelityTurns === decisionTurns,
      has_candidate_processes: candidateProcessCount > 0,
      no_duplicate_candidate_process_names:
        duplicateCandidateProcessNameGroups === 0,
      has_synthesis_run_for_capture: synthesisRunCount > 0,
      synthesis_terminal_for_capture: terminalSynthesisRunCount > 0,
      overview_ready:
        overviewProcessCards > 0 && terminalSynthesisRunCount > 0,
      overview_has_evidence_linked_card: evidenceLinkedOverviewCards > 0,
      backend_pre_tts_p95_ok:
        decisionTurns > 0 && p95BackendPreTtsMs > 0 && p95BackendPreTtsMs <= 1500,
      backend_pre_tts_p50_ok:
        decisionTurns > 0 && p50BackendPreTtsMs > 0 && p50BackendPreTtsMs <= 1000,
      total_cost_within_2x_baseline:
        decisionTurns > 0 &&
        totalCostCents <= DIRECTOR_INTERVIEW_COST_ALERT_THRESHOLD_CENTS,
      priority_1_progress: priority1CoverageRatio >= 0.5,
      priority_1_no_partial_or_conflicting:
        priority1PartialOrConflictingSlots === 0,
    };
    const failedAcceptanceChecks = Object.entries(acceptance)
      .filter(([, passed]) => passed !== true)
      .map(([key]) => key)
      .sort();

    return {
      ok: failedAcceptanceChecks.length === 0,
      capture_session_id: context.captureSessionId,
      workspace_id: context.workspaceId,
      capture_session_completed: Boolean(captureRow?.completedAt),
      capture_session_completed_at:
        captureRow?.completedAt?.toISOString() ?? null,
      transcript_turns: transcriptTurns,
      transcript_segments: transcriptSegmentCount,
      turn_contract: {
        decision_turns_with_transcript_segments:
          decisionTurnsWithTranscriptSegments,
        decision_turns_with_matching_transcript_segments:
          decisionTurnsWithMatchingTranscriptSegments,
        decision_turns_with_transcript_evidence:
          decisionTurnsWithTranscriptEvidence,
      },
      asr_timing: {
        asr_metrics_turns: asrMetricsTurns,
        asr_metrics_segments: asrMetricsSegmentCount,
        livekit_deepgram_asr_metrics_turns: livekitDeepgramAsrMetricsTurns,
        livekit_deepgram_asr_metrics_segments:
          livekitDeepgramAsrMetricsSegmentCount,
        configured_asr_runtime_turns: configuredAsrRuntimeTurns,
        configured_asr_runtime_segments: configuredAsrRuntimeSegmentCount,
        privacy_configured_asr_runtime_turns:
          privacyConfiguredAsrRuntimeTurns,
        privacy_configured_asr_runtime_segments:
          privacyConfiguredAsrRuntimeSegmentCount,
        estimated_timing_turns: estimatedTimingTurns,
        estimated_timing_segments: estimatedTimingSegmentCount,
      },
      vendor_privacy: {
        vendor_export_audits: vendorExportAudits,
        livekit_vendor_export_audits: livekitVendorExportAudits,
        anthropic_vendor_export_audits: anthropicVendorExportAudits,
        privacy_ack_vendor_export_audits: privacyAckVendorExportAudits,
        stable_agent_identity_audits: stableAgentIdentityAudits,
        audio_retention_vendor_audits: audioRetentionVendorAudits,
        audio_retention_enabled_audits: audioRetentionEnabledAudits,
        raw_payload_logging_vendor_audits: rawPayloadLoggingVendorAudits,
        raw_payload_logging_enabled_audits: rawPayloadLoggingEnabledAudits,
      },
      decision_turns: decisionTurns,
      brain: {
        llm_brain_turns: llmBrainTurns,
        degraded_turns: degradedTurns,
        recovered_degraded_turns: recoveredDegradedTurns,
        unresolved_degraded_turns: unresolvedDegradedTurns,
      },
      voice: {
        llm_voice_turns: llmVoiceTurns,
        streamed_voice_turns: streamedVoiceTurns,
        voice_timeout_fallback_turns: voiceTimeoutFallbackTurns,
        voice_degraded_turns: voiceDegradedTurns,
      },
      delivery: {
        completed_turns: completedTurns,
        truncated_turns: truncatedTurns,
        failed_text_fallback_turns: failedTextFallbackTurns,
        pending_delivery_turns: pendingDeliveryTurns,
        unknown_delivery_turns: unknownDeliveryTurns,
        terminal_delivery_turns: terminalDeliveryTurns,
        delivery_fidelity_turns: deliveryFidelityTurns,
      },
      voice_prompts: {
        prompt_turns: voicePromptTurns,
        opening_prompt_turns: openingPromptTurns,
        completed_prompt_turns: completedPromptTurns,
        truncated_prompt_turns: truncatedPromptTurns,
        failed_text_fallback_prompt_turns: failedTextFallbackPromptTurns,
        pending_prompt_delivery_turns: pendingPromptDeliveryTurns,
        unknown_prompt_delivery_turns: unknownPromptDeliveryTurns,
        terminal_prompt_delivery_turns: terminalPromptDeliveryTurns,
        prompt_delivery_fidelity_turns: promptDeliveryFidelityTurns,
        configured_tts_runtime_prompt_turns:
          configuredTtsRuntimePromptTurns,
        privacy_configured_tts_runtime_prompt_turns:
          privacyConfiguredTtsRuntimePromptTurns,
      },
      delivery_timing: {
        tts_playout_turns: ttsPlayoutTurns,
        audible_tts_turns: audibleTtsTurns,
        configured_tts_runtime_turns: configuredTtsRuntimeTurns,
        privacy_configured_tts_runtime_turns:
          privacyConfiguredTtsRuntimeTurns,
        tts_playout_prompt_turns: ttsPlayoutPromptTurns,
        audible_prompt_turns: audiblePromptTurns,
      },
      candidate_process_count: candidateProcessCount,
      duplicate_candidate_process_name_groups:
        duplicateCandidateProcessNameGroups,
      duplicate_candidate_process_names: Array.isArray(
        duplicateCandidateRows?.duplicate_candidate_process_names,
      )
        ? duplicateCandidateRows.duplicate_candidate_process_names
        : [],
      candidate_processes: candidateRows.map((candidate) => ({
        id: candidate.id,
        proposed_name: candidate.proposedName,
        proposed_function: candidate.proposedFunction,
        status: candidate.status,
      })),
      synthesis: {
        run_count: synthesisRunCount,
        terminal_run_count: terminalSynthesisRunCount,
        completed_run_count: completedSynthesisRunCount,
        partial_synthesis_run_count: partialSynthesisRunCount,
      },
      overview: {
        process_cards: overviewProcessCards,
        evidence_linked_cards: evidenceLinkedOverviewCards,
      },
      priority_1_slots: priority1Slots,
      priority_1_covered_slots: priority1CoveredSlots,
      priority_1_partial_or_conflicting_slots:
        priority1PartialOrConflictingSlots,
      priority_1_coverage_ratio: priority1CoverageRatio,
      telemetry: {
        degraded_turns: degradedTurns,
        recovered_degraded_turns: recoveredDegradedTurns,
        unresolved_degraded_turns: unresolvedDegradedTurns,
        total_cost_cents: totalCostCents,
        cost_baseline_cents: DIRECTOR_INTERVIEW_COST_BASELINE_CENTS,
        cost_alert_threshold_cents:
          DIRECTOR_INTERVIEW_COST_ALERT_THRESHOLD_CENTS,
        avg_backend_pre_tts_ms: Math.round(
          toVerificationNumber(decisionRows?.avg_backend_pre_tts_ms),
        ),
        p50_backend_pre_tts_ms: p50BackendPreTtsMs,
        p95_backend_pre_tts_ms: p95BackendPreTtsMs,
        cache_hit_rate:
          cacheObserved === 0
            ? 0
            : Math.round(
                (toVerificationNumber(decisionRows?.cache_hits) / cacheObserved) *
                  100,
              ),
        cache_observed_turns: cacheObserved,
        llm_cache_hits: llmCacheHits,
        llm_cache_observed_turns: llmCacheObserved,
        llm_cache_hit_rate: llmCacheHitRate,
        voice_cache_hits: voiceCacheHits,
        voice_cache_observed_turns: voiceCacheObserved,
        voice_cache_hit_rate: voiceCacheHitRate,
        llm_cache_read_input_tokens: llmCacheReadInputTokens,
        llm_cache_creation_input_tokens: llmCacheCreationInputTokens,
        voice_cache_read_input_tokens: voiceCacheReadInputTokens,
        voice_cache_creation_input_tokens: voiceCacheCreationInputTokens,
        voice_timeout_fallback_turns: voiceTimeoutFallbackTurns,
        voice_degraded_turns: voiceDegradedTurns,
      },
      acceptance,
      failed_acceptance_checks: failedAcceptanceChecks,
    };
  });
}

function toVerificationNumber(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function deliveryStatusFromJson(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = (value as { delivery_status?: unknown }).delivery_status;
  return typeof status === "string" ? status : null;
}

async function firstWorkspaceMemberUserId(orgId: string, workspaceId: string) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.orgId, orgId),
          eq(workspaceMemberships.workspaceId, workspaceId),
        ),
      )
      .limit(1);
  });
  return rows[0]?.userId ?? null;
}
