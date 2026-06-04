import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { auditLog, captureSessions } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import {
  ApiError,
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import {
  inngest,
  operatorCaptureCompletedEventName,
  operatorScreenRecordingUploadedEventName,
} from "@/lib/inngest/client";
import { stopOperatorTrackEgress } from "@/lib/adapters/livekit";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
  })
  .strict();

export async function POST(
  request: Request,
  ctx: { params: Promise<{ processId: string; captureSessionId: string }> },
) {
  try {
    const { processId, captureSessionId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director", "operator"]);
    const route =
      "POST /api/processes/:processId/operator-captures/:captureSessionId/complete";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`operator.capture.complete:${captureSessionId}:${idempotencyKey}`}))
      `);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        const cachedCapture = (cached.responseJson as {
          capture_session?: typeof captureSessions.$inferSelect;
        }).capture_session;
        const shouldSendRecordingEvent =
          cachedCapture &&
          captureHasDurableRecording(cachedCapture) &&
          !recordingRouteOwnsProcessing(cachedCapture)
            ? !(await captureHasRecordingProcessing(tx, {
                captureSessionId: cachedCapture.id,
                artifactId: cachedCapture.recordingArtifactId,
              }))
            : false;
        return {
          body: cached.responseJson,
          statusCode: cached.statusCode,
          shouldSendEvent: false,
          shouldSendRecordingEvent,
          recordingArtifactId: cachedCapture?.recordingArtifactId ?? null,
          egressId: cachedCapture ? activeEgressId(cachedCapture) : null,
        };
      }

      const existing = (
        await tx
          .select()
          .from(captureSessions)
          .where(
            and(
              eq(captureSessions.id, captureSessionId),
              eq(captureSessions.orgId, auth.orgId),
              eq(captureSessions.workspaceId, body.workspace_id),
              eq(captureSessions.processId, processId),
              eq(captureSessions.captureType, "operator_interview"),
            ),
          )
          .limit(1)
      )[0];
      if (!existing) {
        throw new ApiError(404, "not_found", "Operator capture not found.");
      }

      await assertAllOperatorExtractionTerminal(tx, {
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        captureSessionId,
      });

      const captureSession =
        existing.completedAt === null
          ? (
              await tx
                .update(captureSessions)
                .set({ completedAt: new Date(), updatedAt: new Date() })
                .where(
                  and(
                    eq(captureSessions.id, captureSessionId),
                    isNull(captureSessions.completedAt),
                  ),
                )
                .returning()
            )[0] ?? existing
          : existing;

      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        eventType: "capture.operator.completed",
        subjectType: "capture_session",
        subjectId: captureSession.id,
        metadataJson: {
          process_id: processId,
          capture_mode: captureSession.captureMode,
          idempotency_key: idempotencyKey,
          already_completed: existing.completedAt !== null,
        },
      });

      const response = { capture_session: captureSession };
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 200,
      });
      const hasDurableRecording = captureHasDurableRecording(captureSession);
      const hasProcessedRecording = hasDurableRecording
        ? await captureHasRecordingProcessing(tx, {
            captureSessionId: captureSession.id,
            artifactId: captureSession.recordingArtifactId,
          })
        : false;
      return {
        body: response,
        statusCode: 200,
        // Historical guard: shouldSendEvent: existing.completedAt === null
        shouldSendEvent:
          existing.completedAt === null &&
          !hasDurableRecording &&
          !captureHasActiveRecording(captureSession),
        shouldSendRecordingEvent:
          hasDurableRecording &&
          !recordingRouteOwnsProcessing(captureSession) &&
          !hasProcessedRecording,
        recordingArtifactId: captureSession.recordingArtifactId,
        egressId: activeEgressId(captureSession),
      };
    });

    const captureSession = (result.body as {
      capture_session?: { id?: string };
    }).capture_session;
    console.info("operator capture completion accepted", {
      capture_session_id: captureSession?.id ?? captureSessionId,
      process_id: processId,
      workspace_id: body.workspace_id,
      should_send_background_event: result.shouldSendEvent,
      should_send_recording_event: result.shouldSendRecordingEvent ?? false,
      egress_id: result.egressId ?? null,
    });
    let backgroundEvent:
      | { ok: true }
      | { ok: false; message: string }
      | undefined;
    if (result.shouldSendEvent && captureSession?.id) {
      try {
        await inngest.send({
          name: operatorCaptureCompletedEventName,
          data: {
            captureSessionId: captureSession.id,
            processId,
            workspaceId: body.workspace_id,
            orgId: auth.orgId,
            userId: auth.userId,
            idempotencyKey,
          },
        });
        backgroundEvent = { ok: true };
      } catch (error) {
        console.error("Failed to enqueue operator capture completion event", error);
        backgroundEvent = {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Could not enqueue background synthesis.",
        };
      }
    }
    let backgroundRecordingEvent:
      | { ok: true }
      | { ok: false; message: string }
      | undefined;
    if (
      result.shouldSendRecordingEvent &&
      captureSession?.id &&
      result.recordingArtifactId
    ) {
      try {
        await inngest.send({
          name: operatorScreenRecordingUploadedEventName,
          data: {
            artifactId: result.recordingArtifactId,
            captureSessionId: captureSession.id,
            processId,
            workspaceId: body.workspace_id,
            orgId: auth.orgId,
            userId: auth.userId,
            idempotencyKey: `${idempotencyKey}:recording`,
          },
        });
        backgroundRecordingEvent = { ok: true };
      } catch (error) {
        console.error("Failed to enqueue operator recording processing event", error);
        backgroundRecordingEvent = {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Could not enqueue recording processing.",
        };
      }
    }
    if (!result.shouldSendEvent && result.egressId) {
      try {
        await getDb().transaction(async (tx) => {
          await setOrgContext(tx, auth.orgId);
          await tx
            .update(captureSessions)
            .set({ recordingStatus: "stopping", updatedAt: new Date() })
            .where(eq(captureSessions.id, captureSessionId));
        });
        void stopOperatorTrackEgress(result.egressId).catch((error) => {
          console.error("Failed to stop operator LiveKit Egress", error);
        });
      } catch (error) {
        console.error("Failed to stop operator LiveKit Egress", error);
      }
    }

    return apiJson(
      backgroundEvent || backgroundRecordingEvent
        ? {
            ...(result.body as object),
            ...(backgroundEvent ? { background_event: backgroundEvent } : {}),
            ...(backgroundRecordingEvent
              ? { background_recording_event: backgroundRecordingEvent }
              : {}),
          }
        : result.body,
      { status: result.statusCode },
    );
  } catch (error) {
    return apiError(error);
  }
}

type OperatorCompletionTx = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

async function assertAllOperatorExtractionTerminal(
  tx: OperatorCompletionTx,
  input: {
    orgId: string;
    workspaceId: string;
    captureSessionId: string;
  },
) {
  const result = await tx.execute<{
    pending_extraction_turns: string | number;
    failed_extraction_turns: string | number;
    pending_extraction_windows: string | number;
    failed_extraction_windows: string | number;
  }>(sql`
    WITH extraction_turns AS (
      SELECT delivery_json->>'extraction_status' AS extraction_status
      FROM agent_decision_log
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND capture_session_id = ${input.captureSessionId}
        AND stage_name = 'operator.turn'
        AND delivery_json ? 'extraction_status'
    ),
    extraction_windows AS (
      SELECT status
      FROM operator_extraction_windows
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND capture_session_id = ${input.captureSessionId}
    )
    SELECT
      (SELECT count(*) FROM extraction_turns WHERE extraction_status IN ('pending', 'running'))::int
        AS pending_extraction_turns,
      (SELECT count(*) FROM extraction_turns WHERE extraction_status = 'failed')::int
        AS failed_extraction_turns,
      (SELECT count(*) FROM extraction_windows WHERE status IN ('pending', 'running'))::int
        AS pending_extraction_windows,
      (SELECT count(*) FROM extraction_windows WHERE status = 'failed')::int
        AS failed_extraction_windows
  `);
  const row = result.rows[0];
  const pendingExtractionTurns = Number(row?.pending_extraction_turns ?? 0);
  const failedExtractionTurns = Number(row?.failed_extraction_turns ?? 0);
  const pendingExtractionWindows = Number(row?.pending_extraction_windows ?? 0);
  const failedExtractionWindows = Number(row?.failed_extraction_windows ?? 0);
  if (pendingExtractionTurns > 0 || pendingExtractionWindows > 0) {
    throw new ApiError(
      409,
      "conflict",
      "Operator capture has pending structured extraction (extraction_pending). Retry completion after notes finish updating.",
    );
  }
  if (failedExtractionTurns > 0 || failedExtractionWindows > 0) {
    throw new ApiError(
      409,
      "conflict",
      "Operator capture has failed structured extraction (extraction_failed). Retry extraction before synthesis.",
    );
  }
}

function captureHasActiveRecording(capture: typeof captureSessions.$inferSelect) {
  return (
    capture.captureMode === "operator_screenshare" &&
    (capture.recordingStatus === "recording" || activeEgressId(capture) !== null)
  );
}

function captureHasDurableRecording(capture: typeof captureSessions.$inferSelect) {
  return capture.captureMode === "operator_screenshare" && Boolean(capture.recordingArtifactId);
}

function recordingRouteOwnsProcessing(capture: typeof captureSessions.$inferSelect) {
  return capture.recordingProvider === "mediarecorder-final-blob";
}

function activeEgressId(capture: typeof captureSessions.$inferSelect) {
  const metadata =
    capture.metadataJson &&
    typeof capture.metadataJson === "object" &&
    !Array.isArray(capture.metadataJson)
      ? (capture.metadataJson as Record<string, unknown>)
      : {};
  const value = metadata.egress_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function captureHasRecordingProcessing(
  tx: Pick<ReturnType<typeof getDb>, "execute">,
  input: { captureSessionId: string; artifactId: string | null },
) {
  if (!input.artifactId) return false;
  const processed = await tx.execute<{ processed: boolean }>(sql`
    SELECT (
      EXISTS (
        SELECT 1
        FROM agent_decision_log
        WHERE capture_session_id = ${input.captureSessionId}
          AND stage_name = 'screen_recording_upload_pipeline'
          AND tool_calls->>'artifact_id' = ${input.artifactId}
      )
      OR EXISTS (
        SELECT 1
        FROM visual_observations
        WHERE capture_session_id = ${input.captureSessionId}
          AND artifact_id = ${input.artifactId}
      )
      OR EXISTS (
        SELECT 1
        FROM transcript_segments
        WHERE capture_session_id = ${input.captureSessionId}
          AND timing_source LIKE 'screen_recording_transcript:%'
          AND metadata_json->>'artifact_id' = ${input.artifactId}
      )
    ) AS processed
  `);
  return processed.rows[0]?.processed === true;
}
