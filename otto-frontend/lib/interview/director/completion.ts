import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { auditLog, captureSessions, followUpTasks, slotStates } from "@/lib/db/schema";
import { ApiError } from "@/lib/http/json";
import { directorInterviewCompletedEventName, inngest } from "@/lib/inngest/client";
import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";
import { createFollowUpTask } from "@/lib/interview/director/tools";
import { lockDirectorTurnSequence } from "@/lib/interview/director/turn-transaction";

type DirectorCompletionTx = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export type DirectorCompletionEventData = {
  orgId: string;
  workspaceId: string;
  captureSessionId: string;
  userId: string;
  idempotencyKey: string;
};

export async function completeDirectorInterviewInTransaction(
  tx: DirectorCompletionTx,
  input: {
    orgId: string;
    workspaceId: string;
    captureSessionId: string;
    userId: string;
    idempotencyKey: string;
    source: "browser" | "livekit_agent";
  },
) {
  await lockDirectorTurnSequence(input, tx);
  if (input.source === "browser") {
    await recoverStalePendingDirectorVoiceDeliveries(tx, input);
  }
  await assertAllDirectorVoiceDeliveryTerminal(tx, input);

  const completedAt = new Date();
  const completedRows = await tx
    .update(captureSessions)
    .set({ completedAt, updatedAt: completedAt })
    .where(
      and(
        eq(captureSessions.id, input.captureSessionId),
        eq(captureSessions.orgId, input.orgId),
        eq(captureSessions.workspaceId, input.workspaceId),
        eq(captureSessions.captureType, "director_interview"),
        isNull(captureSessions.completedAt),
      ),
    )
    .returning();
  const newlyCompleted = completedRows[0];
  if (newlyCompleted) {
    const followUpTasksCreated = await createUnresolvedPrioritySlotFollowUps(tx, input);
    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      eventType: "capture.director_interview.completed",
      subjectType: "capture_session",
      subjectId: newlyCompleted.id,
      metadataJson: {
        idempotency_key: input.idempotencyKey,
        source: input.source,
        unresolved_priority_follow_up_tasks_created: followUpTasksCreated,
      },
    });
    return {
      body: { capture_session: newlyCompleted },
      statusCode: 200,
      eventData: {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        captureSessionId: newlyCompleted.id,
        userId: input.userId,
        idempotencyKey: completionEventIdempotencyKey(input.captureSessionId),
      },
    };
  }

  const existing = (
    await tx
      .select()
      .from(captureSessions)
      .where(
        and(
          eq(captureSessions.id, input.captureSessionId),
          eq(captureSessions.orgId, input.orgId),
          eq(captureSessions.workspaceId, input.workspaceId),
          eq(captureSessions.captureType, "director_interview"),
        ),
      )
      .limit(1)
  )[0];
  if (!existing) {
    throw new ApiError(404, "not_found", "Director interview not found.");
  }
  const completionEventKey = completionEventIdempotencyKey(input.captureSessionId);
  const alreadyQueued = await hasQueuedDirectorSynthesis(tx, {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    captureSessionId: input.captureSessionId,
    idempotencyKey: completionEventKey,
  });
  return {
    body: { capture_session: existing },
    statusCode: 200,
    eventData: alreadyQueued
      ? null
      : {
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          captureSessionId: input.captureSessionId,
          userId: input.userId,
          idempotencyKey: completionEventKey,
        },
  };
}

async function recoverStalePendingDirectorVoiceDeliveries(
  tx: DirectorCompletionTx,
  input: {
    orgId: string;
    workspaceId: string;
    captureSessionId: string;
    userId: string;
    idempotencyKey: string;
  },
) {
  const recovered = await tx.execute<{ id: string }>(sql`
    WITH stale_pending AS (
      SELECT
        id,
        trim(coalesce(delivery_json->>'planned_utterance', sanitized_agent_utterance, ''))
          AS planned_utterance
      FROM agent_decision_log
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND capture_session_id = ${input.captureSessionId}
        AND stage_name IN ('director.opening', 'director.notice.asr_stall', 'director.turn')
        AND coalesce(delivery_json->>'delivery_status', 'pending') = 'pending'
        AND coalesce(updated_at, created_at) < now() - interval '5 seconds'
      FOR UPDATE
    )
    UPDATE agent_decision_log
    SET delivery_json = coalesce(delivery_json, '{}'::jsonb)
      || jsonb_build_object(
        'delivery_status', 'failed_text_fallback',
        'delivered_utterance', stale_pending.planned_utterance,
        'spoken_fraction', 0,
        'browser_completion_recovery', true,
        'browser_completion_recovered_at', now()
      ),
      updated_at = now()
    FROM stale_pending
    WHERE agent_decision_log.id = stale_pending.id
      AND stale_pending.planned_utterance <> ''
    RETURNING agent_decision_log.id
  `);
  if (recovered.rows.length === 0) return;
  await tx.insert(auditLog).values({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    eventType: "capture.director_voice.stale_delivery_recovered",
    subjectType: "capture_session",
    subjectId: input.captureSessionId,
    metadataJson: {
      idempotency_key: input.idempotencyKey,
      source: "browser_completion",
      recovered_decision_log_ids: recovered.rows.map((row) => row.id),
      recovered_count: recovered.rows.length,
    },
  });
}

async function assertAllDirectorVoiceDeliveryTerminal(
  tx: DirectorCompletionTx,
  input: {
    orgId: string;
    workspaceId: string;
    captureSessionId: string;
  },
) {
  const result = await tx.execute<{
    pending_delivery_turns: string | number;
    unknown_delivery_turns: string | number;
    invalid_delivery_fidelity_turns: string | number;
  }>(sql`
    WITH delivery_rows AS (
      SELECT
        delivery_json->>'delivery_status' AS delivery_status,
        trim(coalesce(delivery_json->>'planned_utterance', ''))
          AS planned_utterance,
        trim(coalesce(delivery_json->>'delivered_utterance', ''))
          AS delivered_utterance,
        coalesce((delivery_json->>'spoken_fraction')::numeric, 0)
          AS spoken_fraction
      FROM agent_decision_log
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND capture_session_id = ${input.captureSessionId}
        AND stage_name IN ('director.opening', 'director.notice.asr_stall', 'director.turn')
    )
    SELECT
      count(*) FILTER (
        WHERE delivery_status IS NULL
          OR delivery_status = 'pending'
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
        WHERE delivery_status IN (
          'completed',
          'truncated',
          'failed_text_fallback'
        )
        AND NOT (
          (
            delivery_status = 'completed'
            AND spoken_fraction = 1
            AND planned_utterance <> ''
            AND delivered_utterance = planned_utterance
          )
          OR (
            delivery_status = 'truncated'
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
          )
          OR (
            delivery_status = 'failed_text_fallback'
            AND spoken_fraction = 0
            AND planned_utterance <> ''
            AND delivered_utterance = planned_utterance
          )
        )
      )::int AS invalid_delivery_fidelity_turns
    FROM delivery_rows
  `);
  const pendingDeliveryTurns = Number(result.rows[0]?.pending_delivery_turns ?? 0);
  const unknownDeliveryTurns = Number(result.rows[0]?.unknown_delivery_turns ?? 0);
  const invalidDeliveryFidelityTurns = Number(
    result.rows[0]?.invalid_delivery_fidelity_turns ?? 0,
  );
  if (
    pendingDeliveryTurns > 0 ||
    unknownDeliveryTurns > 0 ||
    invalidDeliveryFidelityTurns > 0
  ) {
    throw new ApiError(
      409,
      "conflict",
      "Director interview has pending, unknown, or inconsistent voice delivery evidence (delivery_pending). Retry completion after delivery settles.",
    );
  }
}

async function hasQueuedDirectorSynthesis(
  tx: DirectorCompletionTx,
  input: {
    orgId: string;
    workspaceId: string;
    captureSessionId: string;
    idempotencyKey: string;
  },
) {
  const result = await tx.execute<{ id: string }>(sql`
    SELECT id
    FROM audit_log
    WHERE org_id = ${input.orgId}
      AND workspace_id = ${input.workspaceId}
      AND subject_type = 'capture_session'
      AND subject_id = ${input.captureSessionId}
      AND event_type = 'synthesis.inventory.queued'
      AND metadata_json->>'idempotency_key' = ${input.idempotencyKey}
    LIMIT 1
  `);
  return Boolean(result.rows[0]);
}

async function createUnresolvedPrioritySlotFollowUps(
  tx: DirectorCompletionTx,
  input: {
    orgId: string;
    workspaceId: string;
    captureSessionId: string;
    userId: string;
  },
) {
  const prioritySlots = directorSlotDefinitions.filter(
    (definition) => definition.priority >= 90,
  );
  if (prioritySlots.length === 0) return 0;

  const slotPaths = prioritySlots.map((definition) => definition.path);
  const existingSlotRows = await tx
    .select({
      id: slotStates.id,
      slotPath: slotStates.slotPath,
      status: slotStates.status,
    })
    .from(slotStates)
    .where(
      and(
        eq(slotStates.orgId, input.orgId),
        eq(slotStates.workspaceId, input.workspaceId),
        eq(slotStates.captureSessionId, input.captureSessionId),
        inArray(slotStates.slotPath, slotPaths),
      ),
    );
  const existingSlots = new Map(
    existingSlotRows.map((slot) => [slot.slotPath, slot]),
  );

  let created = 0;
  for (const definition of prioritySlots) {
    const slot = existingSlots.get(definition.path);
    const status = slot?.status ?? "empty";
    if (status === "filled" || status === "asked_unknown") continue;

    const duplicate = await tx
      .select({ id: followUpTasks.id })
      .from(followUpTasks)
      .where(
        and(
          eq(followUpTasks.orgId, input.orgId),
          eq(followUpTasks.workspaceId, input.workspaceId),
          eq(followUpTasks.captureSessionId, input.captureSessionId),
          eq(followUpTasks.status, "open"),
          eq(followUpTasks.taskType, "open_question"),
          eq(followUpTasks.targetType, "director_slot"),
          eq(followUpTasks.title, closeoutFollowUpTitle(definition.label)),
        ),
      )
      .limit(1);
    if (duplicate[0]) continue;

    await createFollowUpTask(
      {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        captureSessionId: input.captureSessionId,
        userId: input.userId,
      },
      {
        title: closeoutFollowUpTitle(definition.label),
        description: `The director interview ended before "${definition.label}" was covered. Capture this before relying on the process map.`,
        taskType: "open_question",
        targetType: "director_slot",
        targetId: slot?.id,
        priority: definition.priority / 100,
        contextJson: {
          source: "director_closeout",
          slot_path: definition.path,
          slot_label: definition.label,
          slot_status: status,
          slot_priority: definition.priority,
        },
      },
      { tx },
    );
    created += 1;
  }
  return created;
}

function closeoutFollowUpTitle(slotLabel: string) {
  return `Resolve director interview gap: ${slotLabel}`;
}

export async function sendDirectorCompletionEvent(
  eventData: DirectorCompletionEventData | null,
) {
  if (!eventData) return;
  await inngest.send({
    name: directorInterviewCompletedEventName,
    data: eventData,
  });
}

function completionEventIdempotencyKey(captureSessionId: string) {
  return `director-complete:${captureSessionId}`;
}
