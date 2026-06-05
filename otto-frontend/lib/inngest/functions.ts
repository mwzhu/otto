import { and, eq, inArray, sql } from "drizzle-orm";
import {
  artifactUploadedEventName,
  directorAutomationPlanRequestedEventName,
  directorInterviewCompletedEventName,
  documentArtifactUploadedEventName,
  inventorySynthesisRequestedEventName,
  inngest,
  operatorCaptureCompletedEventName,
  operatorProcessSynthesisRequestedEventName,
  operatorRedactionRequestedEventName,
  operatorScreenFrameCapturedEventName,
  operatorScreenRecordingUploadedEventName,
  processDocumentUploadedEventName,
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
import { processSpecificDocumentArtifact } from "@/lib/documents/process-document";
import { processScreenRecordingArtifact } from "@/lib/video/process-screen-recording";
import { processOperatorScreenFrame } from "@/lib/vision/operator-screen-frame";
import { runOperatorRedaction } from "@/lib/redactions/operator-redaction";
import {
  dispatchDirectorTurnPlan,
  extractDirectorTurn,
} from "@/lib/interview/director/brain";
import { runInventorySynthesis } from "@/lib/synthesis/inventory";
import { runDirectorAutomationPlan } from "@/lib/synthesis/director-automation";
import { runOperatorProcessSynthesis } from "@/lib/synthesis/operator-process";

const synthesisConcurrency: [
  { limit: number; key: string },
  { limit: number },
] = [
  { limit: 1, key: "event.data.orgId" },
  { limit: 8 },
];

const synthesisOrgThrottle = {
  limit: 12,
  period: "1m",
  key: "event.data.orgId",
} as const;

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
    concurrency: synthesisConcurrency,
    throttle: synthesisOrgThrottle,
    triggers: [{ event: inventorySynthesisRequestedEventName }],
  },
  async ({ event, step }) => {
    const result = await step.run("run-inventory-synthesis-subset", async () =>
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
    const runType = event.data.runType as string | undefined;
    const env = getServerEnv();
    if (
      result.ok &&
      (runType === "director_inventory" || runType === "combined_inventory") &&
      env.DIRECTOR_AUTOMATION_PLAN_GENERATION_ENABLED
    ) {
      await step.run("request-director-automation-plan", async () =>
        inngest.send({
          name: directorAutomationPlanRequestedEventName,
          data: {
            orgId: event.data.orgId as string,
            workspaceId: event.data.workspaceId as string,
            captureSessionIds: event.data.captureSessionIds as string[],
            userId: event.data.userId as string | undefined,
            idempotencyKey: event.data.idempotencyKey as string | undefined,
          },
        }),
      );
    }
    return result;
  },
);

export const directorAutomationPlanSynthesis = inngest.createFunction(
  {
    id: "director-automation-plan-synthesis-v1",
    concurrency: synthesisConcurrency,
    throttle: synthesisOrgThrottle,
    triggers: [{ event: directorAutomationPlanRequestedEventName }],
  },
  async ({ event, step }) => {
    return step.run("run-director-automation-plan", async () =>
      runDirectorAutomationPlan({
        orgId: event.data.orgId as string,
        workspaceId: event.data.workspaceId as string,
        captureSessionIds: event.data.captureSessionIds as string[],
        userId: event.data.userId as string | undefined,
        idempotencyKey: event.data.idempotencyKey as string | undefined,
      }),
    );
  },
);

export const operatorCaptureReady = inngest.createFunction(
  {
    id: "operator-capture-ready-v1",
    triggers: [
      { event: operatorCaptureCompletedEventName },
      { event: operatorScreenRecordingUploadedEventName },
      { event: processDocumentUploadedEventName },
    ],
  },
  async ({ event, step }) => {
    let captureProcessingResult:
      | { ok: boolean; reason?: string }
      | undefined;
    if (event.name === processDocumentUploadedEventName) {
      captureProcessingResult = await step.run("parse-process-specific-document", async () =>
        processSpecificDocumentArtifact({
          artifactId: event.data.artifactId as string,
          orgId: event.data.orgId as string,
          captureSessionId: event.data.captureSessionId as string,
          processId: event.data.processId as string,
          userId: event.data.userId as string | undefined,
          idempotencyKey: event.data.idempotencyKey as string | undefined,
        }),
      );
    }
    if (event.name === operatorScreenRecordingUploadedEventName) {
      captureProcessingResult = await step.run("process-operator-screen-recording", async () =>
        processScreenRecordingArtifact({
          artifactId: event.data.artifactId as string,
          orgId: event.data.orgId as string,
          captureSessionId: event.data.captureSessionId as string,
          processId: event.data.processId as string,
          userId: event.data.userId as string | undefined,
          idempotencyKey: event.data.idempotencyKey as string | undefined,
        }),
      );
    }
    if (captureProcessingResult && captureProcessingResult.ok !== true) {
      return {
        ok: false as const,
        reason: "operator_capture_processing_failed",
        processing: captureProcessingResult,
      };
    }
    return step.run("request-operator-process-synthesis", async () => {
      const captureSessionId = event.data.captureSessionId as string;
      const processId = event.data.processId as string;
      const orgId = event.data.orgId as string;
      const workspaceId = event.data.workspaceId as string;
      const userId = event.data.userId as string | undefined;
      const idempotencyKey = event.data.idempotencyKey as string | undefined;

      const queued = await getDb().transaction(async (tx) => {
        await setOrgContext(tx, orgId);
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtext(${`synthesis.operator.queued:${captureSessionId}:${idempotencyKey ?? ""}`}))
        `);
        const existing = await tx.execute<{ id: string }>(sql`
          SELECT id
          FROM audit_log
          WHERE org_id = ${orgId}
            AND workspace_id = ${workspaceId}
            AND subject_type = 'capture_session'
            AND subject_id = ${captureSessionId}
            AND event_type = 'synthesis.operator.queued'
            AND metadata_json->>'idempotency_key' = ${idempotencyKey ?? ""}
          LIMIT 1
        `);
        if (existing.rows[0]) {
          return { ok: true as const, alreadyQueued: true };
        }
        await tx.insert(auditLog).values({
          orgId,
          workspaceId,
          userId: userId ?? null,
          eventType: "synthesis.operator.queued",
          subjectType: "capture_session",
          subjectId: captureSessionId,
          metadataJson: {
            process_id: processId,
            capture_session_id: captureSessionId,
            source_event: event.name,
            idempotency_key: idempotencyKey,
          },
        });
        return { ok: true as const, alreadyQueued: false };
      });

      if (!queued.alreadyQueued) {
        await inngest.send({
          name: operatorProcessSynthesisRequestedEventName,
          data: {
            orgId,
            workspaceId,
            processId,
            captureSessionIds: [captureSessionId],
            userId,
            idempotencyKey,
          },
        });
      }
      return queued;
    });
  },
);

export const operatorProcessSynthesis = inngest.createFunction(
  {
    id: "operator-process-synthesis-v1",
    concurrency: synthesisConcurrency,
    throttle: synthesisOrgThrottle,
    triggers: [{ event: operatorProcessSynthesisRequestedEventName }],
  },
  async ({ event, step }) => {
    return step.run("create-operator-process-synthesis-run", async () =>
      runOperatorProcessSynthesis({
        orgId: event.data.orgId as string,
        workspaceId: event.data.workspaceId as string,
        processId: event.data.processId as string,
        captureSessionIds: event.data.captureSessionIds as string[],
        userId: event.data.userId as string | undefined,
        idempotencyKey: event.data.idempotencyKey as string | undefined,
      }),
    );
  },
);

export const operatorScreenFrameCaptured = inngest.createFunction(
  {
    id: "operator-screen-frame-captured-v1",
    triggers: [{ event: operatorScreenFrameCapturedEventName }],
  },
  async ({ event, step }) => {
    return step.run("process-operator-screen-frame-vision", async () =>
      processOperatorScreenFrame({
        orgId: event.data.orgId as string,
        workspaceId: event.data.workspaceId as string,
        processId: event.data.processId as string,
        captureSessionId: event.data.captureSessionId as string,
        artifactId: event.data.artifactId as string,
        screenEventId: event.data.screenEventId as string,
        userId: event.data.userId as string | undefined,
        idempotencyKey: event.data.idempotencyKey as string | undefined,
      }),
    );
  },
);

export const operatorRedactionRequested = inngest.createFunction(
  {
    id: "operator-redaction-requested-v1",
    triggers: [{ event: operatorRedactionRequestedEventName }],
  },
  async ({ event, step }) => {
    const result = await step.run("cascade-operator-redaction", async () =>
      runOperatorRedaction({
        orgId: event.data.orgId as string,
        workspaceId: event.data.workspaceId as string,
        processId: event.data.processId as string,
        captureSessionId: event.data.captureSessionId as string,
        redactionId: event.data.redactionId as string,
        userId: event.data.userId as string | undefined,
        idempotencyKey: event.data.idempotencyKey as string | undefined,
      }),
    );
    if (isCompletedOperatorRedaction(result)) {
      await step.run("request-post-redaction-operator-synthesis", async () =>
        inngest.send({
          name: operatorProcessSynthesisRequestedEventName,
          data: {
            orgId: event.data.orgId as string,
            workspaceId: event.data.workspaceId as string,
            processId: event.data.processId as string,
            captureSessionIds: [event.data.captureSessionId as string],
            userId: event.data.userId as string | undefined,
            idempotencyKey: `redaction:${event.data.redactionId as string}`,
          },
        }),
      );
    }
    return result;
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
  directorAutomationPlanSynthesis,
  operatorCaptureReady,
  operatorProcessSynthesis,
  operatorScreenFrameCaptured,
  operatorRedactionRequested,
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

function isCompletedOperatorRedaction(value: unknown): value is { ok: true } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "ok" in value &&
      (value as { ok?: unknown }).ok === true,
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
  const planned = await extractDirectorTurn(turnInput);
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
