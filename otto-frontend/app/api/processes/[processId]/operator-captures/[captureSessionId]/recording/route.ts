import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { artifacts, auditLog, captureSessions } from "@/lib/db/schema";
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
  operatorScreenRecordingUploadedEventName,
} from "@/lib/inngest/client";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
    artifact_id: z.string().uuid(),
    provider: z.enum(["mediarecorder-final-blob"]),
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
      "POST /api/processes/:processId/operator-captures/:captureSessionId/recording";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`operator.capture.recording:${captureSessionId}:${idempotencyKey}`}))
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
        return {
          body: cached.responseJson,
          statusCode: cached.statusCode,
          shouldSendEvent: cachedCapture
            ? !(await captureHasRecordingProcessing(tx, {
                captureSessionId: cachedCapture.id,
                artifactId:
                  (cached.responseJson as {
                    artifact?: { id?: string | null };
                  }).artifact?.id ?? cachedCapture.recordingArtifactId,
              }))
            : false,
        };
      }
      const capture = (
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
              eq(captureSessions.captureMode, "operator_screenshare"),
            ),
          )
          .limit(1)
      )[0];
      if (!capture) {
        throw new ApiError(404, "not_found", "Operator screenshare capture not found.");
      }
      const artifact = (
        await tx
          .select()
          .from(artifacts)
          .where(
            and(
              eq(artifacts.id, body.artifact_id),
              eq(artifacts.orgId, auth.orgId),
              eq(artifacts.workspaceId, body.workspace_id),
              eq(artifacts.artifactType, "video"),
            ),
          )
          .limit(1)
      )[0];
      if (!artifact) {
        throw new ApiError(404, "not_found", "Recording artifact not found.");
      }
      if (artifact.captureSessionId && artifact.captureSessionId !== captureSessionId) {
        throw new ApiError(
          409,
          "conflict",
          "Recording artifact is linked to another capture session.",
        );
      }
      const updatedArtifact = (
        await tx
          .update(artifacts)
          .set({
            status: "uploaded",
            captureSessionId,
            updatedAt: new Date(),
          })
          .where(eq(artifacts.id, artifact.id))
          .returning()
      )[0];
      const updatedCapture = (
        await tx
          .update(captureSessions)
          .set({
            recordingArtifactId: artifact.id,
            recordingStatus: "ready",
            recordingProvider: body.provider,
            recordingCompletedAt: new Date(),
            metadataJson: sql`${captureSessions.metadataJson} || ${JSON.stringify({
              mediarecorder_fallback: "final_blob",
              recording_artifact_id: artifact.id,
            })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(captureSessions.id, capture.id))
          .returning()
      )[0];
      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        eventType: "capture.operator.recording_attached",
        subjectType: "capture_session",
        subjectId: capture.id,
        metadataJson: {
          process_id: processId,
          artifact_id: artifact.id,
          provider: body.provider,
          idempotency_key: idempotencyKey,
        },
      });
      const response = { capture_session: updatedCapture, artifact: updatedArtifact };
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      return { body: response, statusCode: 201, shouldSendEvent: true };
    });

    let backgroundEvent:
      | { ok: true }
      | { ok: false; message: string }
      | undefined;
    if (result.shouldSendEvent) {
      try {
        await inngest.send({
          name: operatorScreenRecordingUploadedEventName,
          data: {
            artifactId: body.artifact_id,
            captureSessionId,
            processId,
            workspaceId: body.workspace_id,
            orgId: auth.orgId,
            userId: auth.userId,
            idempotencyKey,
          },
        });
        backgroundEvent = { ok: true };
      } catch (error) {
        console.error("Failed to enqueue operator recording processing event", error);
        backgroundEvent = {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Could not enqueue recording processing.",
        };
      }
    }
    return apiJson(
      backgroundEvent
        ? { ...(result.body as object), background_event: backgroundEvent }
        : result.body,
      { status: result.statusCode },
    );
  } catch (error) {
    return apiError(error);
  }
}

async function captureHasRecordingProcessing(
  tx: Pick<ReturnType<typeof getDb>, "execute">,
  input: { captureSessionId: string; artifactId: string | null | undefined },
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
