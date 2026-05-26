import { and, eq, inArray, sql } from "drizzle-orm";
import {
  artifactUploadedEventName,
  directorInterviewCompletedEventName,
  documentArtifactUploadedEventName,
  inventorySynthesisRequestedEventName,
  inngest,
} from "@/lib/inngest/client";
import { getDb, setOrgContext } from "@/lib/db/client";
import { getServiceDbPool } from "@/lib/db/service";
import { getServerEnv } from "@/lib/env";
import {
  auditLog,
  captureSessions,
  evidence,
  transcriptSegments,
  users,
} from "@/lib/db/schema";
import { writeAgentDecision } from "@/lib/db/write-agent-decision";
import { processDocumentArtifact } from "@/lib/documents/pipeline";
import {
  dispatchDirectorTurnPlan,
  planDirectorTurn,
} from "@/lib/interview/director/brain";
import { runInventorySynthesis } from "@/lib/synthesis/inventory";

export const artifactUploaded = inngest.createFunction(
  {
    id: "artifact-uploaded-v1",
    triggers: [
      { event: artifactUploadedEventName },
      { event: documentArtifactUploadedEventName },
    ],
  },
  async ({ event, step }) => {
    const artifactId = event.data.artifactId as string;
    await step.run("parse-chunk-embed-extract-and-publish", async () => {
      const orgId = event.data.orgId as string;
      const result = await processDocumentArtifact({
        artifactId,
        orgId,
        userId: event.data.userId as string | undefined,
        captureSessionId: event.data.captureSessionId as string | undefined,
        idempotencyKey: event.data.idempotencyKey as string | undefined,
      });
      if (result.ok) {
        await inngest.send({
          name: inventorySynthesisRequestedEventName,
          data: {
            orgId,
            workspaceId: event.data.workspaceId as string,
            captureSessionIds: [result.capture_session_id],
            runType: "document_inventory",
            userId: event.data.userId as string | undefined,
            idempotencyKey: event.data.idempotencyKey as string | undefined,
          },
        });
      }
      return result;
    });
  },
);

export const directorInterviewCompleted = inngest.createFunction(
  {
    id: "director-interview-completed-v1",
    triggers: [{ event: directorInterviewCompletedEventName }],
  },
  async ({ event, step }) => {
    await step.run("request-director-inventory-synthesis", async () => {
      const captureSessionId = event.data.captureSessionId as string;
      const eventOrgId = event.data.orgId as string;
      const idempotencyKey = event.data.idempotencyKey as string | undefined;
      const result = await getDb().transaction(async (tx) => {
        await setOrgContext(tx, eventOrgId);
        const rows = await tx
          .select()
          .from(captureSessions)
          .where(eq(captureSessions.id, captureSessionId))
          .limit(1);
        const captureSession = rows[0];
        if (!captureSession) {
          return { ok: false, reason: "capture_session_not_found" };
        }
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtext(${`synthesis.inventory.queued:${captureSession.id}:${idempotencyKey ?? ""}`}))
        `);
        const existingQueueRows = await tx.execute<{ id: string }>(sql`
          SELECT id
          FROM audit_log
          WHERE org_id = ${captureSession.orgId}
            AND workspace_id = ${captureSession.workspaceId}
            AND subject_type = 'capture_session'
            AND subject_id = ${captureSession.id}
            AND event_type = 'synthesis.inventory.queued'
            AND metadata_json->>'idempotency_key' = ${idempotencyKey ?? ""}
          LIMIT 1
        `);
        if (existingQueueRows.rows[0]) {
          return {
            ok: true,
            alreadyQueued: true,
            orgId: captureSession.orgId,
            workspaceId: captureSession.workspaceId,
            captureSessionId: captureSession.id,
          };
        }
        await tx.insert(auditLog).values({
          orgId: captureSession.orgId,
          workspaceId: captureSession.workspaceId,
          userId: (event.data.userId as string | undefined) ?? null,
          eventType: "synthesis.inventory.queued",
          subjectType: "capture_session",
          subjectId: captureSession.id,
          metadataJson: {
            capture_session_id: captureSession.id,
            idempotency_key: idempotencyKey,
          },
        });
        return {
          ok: true,
          alreadyQueued: false,
          orgId: captureSession.orgId,
          workspaceId: captureSession.workspaceId,
          captureSessionId: captureSession.id,
        };
      });
      if (isDecisionResult(result) && !result.alreadyQueued) {
        await writeAgentDecision({
          orgId: result.orgId,
          workspaceId: result.workspaceId,
          captureSessionId: result.captureSessionId,
          stageName: "week3_director_turns_ready",
          tsStart: new Date(),
          tsEnd: new Date(),
          promptTemplateId: "synthesis.inventory.week3-director-ready",
          promptTemplateVersion: "1",
          toolCalls: [],
          degradedQuality: false,
        });
        await inngest.send({
          name: inventorySynthesisRequestedEventName,
          data: {
            orgId: result.orgId,
            workspaceId: result.workspaceId,
            captureSessionIds: [result.captureSessionId],
            runType: "director_inventory",
            userId: event.data.userId as string | undefined,
            idempotencyKey,
          },
        });
      }
      return result;
    });
  },
);

export const inventorySynthesis = inngest.createFunction(
  {
    id: "inventory-synthesis-phase1-v1",
    triggers: [{ event: inventorySynthesisRequestedEventName }],
  },
  async ({ event, step }) => {
    return step.run("run-inventory-synthesis-subset", async () =>
      runInventorySynthesis({
        orgId: event.data.orgId as string,
        workspaceId: event.data.workspaceId as string,
        captureSessionIds: event.data.captureSessionIds as string[],
        runType: event.data.runType as
          | "document_inventory"
          | "director_inventory"
          | "combined_inventory"
          | undefined,
        userId: event.data.userId as string | undefined,
        idempotencyKey: event.data.idempotencyKey as string | undefined,
      }),
    );
  },
);

export const reExtractDegradedTurns = inngest.createFunction(
  {
    id: "re-extract-degraded-turns-v1",
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) => {
    return step.run("find-degraded-turns", async () => {
      const servicePool = getServiceDbPool();
      if (!servicePool) {
        return {
          queued: 0,
          skipped: "missing_DATABASE_SERVICE_URL_for_cross_org_scan",
        };
      }
      const orgRows = await servicePool.query<{ org_id: string }>(`
        SELECT DISTINCT org_id
        FROM agent_decision_log
        WHERE degraded_quality = true
      `);
      return recoverDegradedDirectorTurnsForOrgs(
        orgRows.rows.map((org) => org.org_id),
      );
    });
  },
);

export const inngestFunctions = [
  artifactUploaded,
  directorInterviewCompleted,
  inventorySynthesis,
  reExtractDegradedTurns,
];

function isDecisionResult(
  result: unknown,
): result is {
  ok: true;
  alreadyQueued?: boolean;
  orgId: string;
  workspaceId: string;
  captureSessionId: string;
} {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    (result as { ok?: unknown }).ok === true &&
    typeof (result as { orgId?: unknown }).orgId === "string" &&
    typeof (result as { workspaceId?: unknown }).workspaceId === "string" &&
    typeof (result as { captureSessionId?: unknown }).captureSessionId ===
      "string"
  );
}

export async function recoverDegradedDirectorTurnsForOrgs(orgIds: string[]) {
  const rows = (
    await Promise.all(orgIds.map((orgId) => loadRecoverableDegradedTurns(orgId)))
  ).flat();

  let recovered = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = await recoverDegradedDirectorTurn(row);
    if (result.ok) recovered += 1;
    else skipped += 1;
  }

  return { recovered, skipped, scanned: rows.length };
}

type RecoverableDegradedTurn = {
  id: string;
  orgId: string;
  workspaceId: string;
  captureSessionId: string;
  turnIndex: number | null;
  transcriptSegmentIds: string[];
};

async function loadRecoverableDegradedTurns(orgId: string) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    const result = await tx.execute<{
      id: string;
      org_id: string;
      workspace_id: string;
      capture_session_id: string;
      turn_index: number | null;
      transcript_segment_ids: string[];
    }>(sql`
      SELECT
        d.id,
        d.org_id,
        d.workspace_id,
        d.capture_session_id,
        d.turn_index,
        d.transcript_segment_ids
      FROM agent_decision_log d
      WHERE d.org_id = ${orgId}
        AND d.workspace_id IS NOT NULL
        AND d.capture_session_id IS NOT NULL
        AND cardinality(d.transcript_segment_ids) > 0
        AND d.degraded_quality = true
        AND NOT EXISTS (
          SELECT 1
          FROM agent_decision_log q
          WHERE q.org_id = d.org_id
            AND q.stage_name = 're_extract_degraded_turns.recovered'
            AND q.tool_calls->>'source_agent_decision_log_id' = d.id::text
        )
      ORDER BY d.ts_start ASC
      LIMIT 25
    `);
    return result.rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      captureSessionId: row.capture_session_id,
      turnIndex: row.turn_index,
      transcriptSegmentIds: row.transcript_segment_ids,
    }));
  });
}

async function recoverDegradedDirectorTurn(row: RecoverableDegradedTurn) {
  const started = new Date();
  if (!configuredRecoverySecret(getServerEnv().ANTHROPIC_API_KEY)) {
    await writeSkippedDegradedRecovery(row, started, "missing_anthropic_api_key");
    return { ok: false as const };
  }

  const payload = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, row.orgId);
    const segments = await tx
      .select({
        id: transcriptSegments.id,
        text: transcriptSegments.text,
      })
      .from(transcriptSegments)
      .where(inArray(transcriptSegments.id, row.transcriptSegmentIds))
      .orderBy(transcriptSegments.startMs);
    const evidenceRows = await tx
      .select({ id: evidence.id })
      .from(evidence)
      .where(
        and(
          eq(evidence.orgId, row.orgId),
          eq(evidence.workspaceId, row.workspaceId),
          eq(evidence.sourceType, "transcript_segment"),
          inArray(evidence.sourceId, row.transcriptSegmentIds),
        ),
      );
    const actor = (
      await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`${users.orgId} = ${row.orgId}`)
        .limit(1)
    )[0];
    return {
      latestUtterance: segments.map((segment) => segment.text).join("\n"),
      evidenceIds: evidenceRows.map((item) => item.id),
      userId: actor?.id,
    };
  });

  if (!payload.latestUtterance.trim() || !payload.userId) {
    await writeSkippedDegradedRecovery(
      row,
      started,
      payload.userId ? "missing_transcript" : "missing_actor_user",
    );
    return { ok: false as const };
  }

  const turnInput = {
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    captureSessionId: row.captureSessionId,
    userId: payload.userId,
    latestUtterance: payload.latestUtterance,
    transcriptSegmentIds: row.transcriptSegmentIds,
    evidenceIds: payload.evidenceIds,
    turnIndex: row.turnIndex ?? 0,
  };
  const planned = await planDirectorTurn(turnInput);
  if (planned.degraded_quality) {
    await writeSkippedDegradedRecovery(row, started, "rerun_still_degraded");
    return { ok: false as const };
  }
  const turn = await dispatchDirectorTurnPlan({
    ...turnInput,
    plan: planned.plan,
    plannedAgentUtterance: "",
    metadata: planned.metadata,
    degradedQuality: false,
    startedAt: planned.started_at,
    deliveryStatus: "pending",
    decisionStageName: "re_extract_degraded_turns.applied",
    advanceConversationState: false,
  });
  if (turn.degraded_quality) {
    await writeSkippedDegradedRecovery(row, started, "rerun_still_degraded");
    return { ok: false as const };
  }

  await writeAgentDecision({
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    captureSessionId: row.captureSessionId,
    stageName: "re_extract_degraded_turns.recovered",
    tsStart: started,
    tsEnd: new Date(),
    promptTemplateId: "director.turn.re-extract-degraded",
    promptTemplateVersion: "1",
    toolCalls: {
      source_agent_decision_log_id: row.id,
      candidate_process_ids: turn.candidate_process_ids,
      slot_update_count: turn.slot_updates.length,
    },
    model: turn.metadata.model,
    tokenCountInput: turn.metadata.token_count_input,
    tokenCountOutput: turn.metadata.token_count_output,
    costCents: turn.metadata.cost_cents,
    latencyMs: Date.now() - started.getTime(),
    cacheHit: turn.metadata.cache_hit,
    degradedQuality: false,
  });
  return { ok: true as const };
}

async function writeSkippedDegradedRecovery(
  row: RecoverableDegradedTurn,
  started: Date,
  reason: string,
) {
  await writeAgentDecision({
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    captureSessionId: row.captureSessionId,
    stageName: "re_extract_degraded_turns.skipped",
    tsStart: started,
    tsEnd: new Date(),
    promptTemplateId: "director.turn.re-extract-degraded",
    promptTemplateVersion: "1",
    toolCalls: {
      source_agent_decision_log_id: row.id,
      reason,
    },
    degradedQuality: false,
  });
}

function configuredRecoverySecret(value: string | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return false;
  const lowered = trimmed.toLowerCase();
  return !(
    lowered === "..." ||
    lowered === "replace-me" ||
    lowered === "replace_with_real_value" ||
    lowered.startsWith("replace-with") ||
    lowered.includes("your-project")
  );
}
