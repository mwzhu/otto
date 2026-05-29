import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  artifacts,
  auditLog,
  captureProcessLinks,
  captureSessions,
  processes,
} from "@/lib/db/schema";
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
  processDocumentUploadedEventName,
} from "@/lib/inngest/client";
import { isOperatorCaptureEligibleStatus } from "@/lib/processes/capture-eligibility";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
    artifact_id: z.string().uuid(),
    upload_kind: z.enum(["screen_recording", "document"]),
  })
  .strict();

export async function POST(
  request: Request,
  ctx: { params: Promise<{ processId: string }> },
) {
  try {
    const { processId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director", "operator"]);
    const route = "POST /api/processes/:processId/captures/uploads";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`process.capture.upload:${processId}:${idempotencyKey}`}))
      `);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return {
          body: cached.responseJson,
          statusCode: cached.statusCode,
          shouldSendEvent: false,
        };
      }

      const process = (
        await tx
          .select({ id: processes.id, status: processes.status })
          .from(processes)
          .where(
            and(
              eq(processes.id, processId),
              eq(processes.orgId, auth.orgId),
              eq(processes.workspaceId, body.workspace_id),
            ),
          )
          .limit(1)
      )[0];
      if (!process) {
        throw new ApiError(404, "not_found", "Process not found.");
      }
      if (!isOperatorCaptureEligibleStatus(process.status)) {
        throw new ApiError(
          409,
          "conflict",
          "Operator capture uploads require a draft or approved process.",
        );
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
            ),
          )
          .limit(1)
      )[0];
      if (!artifact) {
        throw new ApiError(404, "not_found", "Artifact not found.");
      }
      validateUploadKind(body.upload_kind, artifact.artifactType);

      const captureType =
        body.upload_kind === "screen_recording"
          ? "screen_recording_upload"
          : "document_upload";
      const captureMode =
        body.upload_kind === "screen_recording"
          ? "screen_recording_upload"
          : "process_document_upload";

      const captureSession = (
        await tx
          .insert(captureSessions)
          .values({
            orgId: auth.orgId,
            workspaceId: body.workspace_id,
            processId,
            captureType,
            captureMode,
            metadataJson: {
              upload_kind: body.upload_kind,
              source_artifact_ids: [artifact.id],
              participant_user_id: auth.userId,
            },
            startedAt: new Date(),
            completedAt: new Date(),
          })
          .returning()
      )[0];

      const updatedArtifact = (
        await tx
          .update(artifacts)
          .set({
            status: "uploaded",
            captureSessionId: captureSession.id,
            updatedAt: new Date(),
          })
          .where(eq(artifacts.id, artifact.id))
          .returning()
      )[0];

      await tx.insert(captureProcessLinks).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        captureSessionId: captureSession.id,
        processId,
        linkType: "enriched",
        confidence: "1",
      });

      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        eventType: `capture.${body.upload_kind}.uploaded`,
        subjectType: "capture_session",
        subjectId: captureSession.id,
        metadataJson: {
          process_id: processId,
          artifact_id: artifact.id,
          capture_type: captureType,
          capture_mode: captureMode,
          idempotency_key: idempotencyKey,
        },
      });

      const response = {
        capture_session: captureSession,
        artifact: updatedArtifact,
      };
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

    const captureSession = (result.body as {
      capture_session?: { id?: string };
    }).capture_session;
    if (result.shouldSendEvent && captureSession?.id) {
      await inngest.send({
        name:
          body.upload_kind === "screen_recording"
            ? operatorScreenRecordingUploadedEventName
            : processDocumentUploadedEventName,
        data: {
          artifactId: body.artifact_id,
          captureSessionId: captureSession.id,
          processId,
          workspaceId: body.workspace_id,
          orgId: auth.orgId,
          userId: auth.userId,
          idempotencyKey,
        },
      });
    }

    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}

function validateUploadKind(
  uploadKind: "screen_recording" | "document",
  artifactType: string,
) {
  if (uploadKind === "screen_recording" && artifactType !== "video") {
    throw new ApiError(
      400,
      "bad_request",
      "Screen recording uploads must use a video artifact.",
    );
  }
  if (uploadKind === "document" && artifactType !== "document") {
    throw new ApiError(
      400,
      "bad_request",
      "Process document uploads must use a document artifact.",
    );
  }
}
