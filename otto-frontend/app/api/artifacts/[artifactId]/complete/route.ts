import { and, eq } from "drizzle-orm";
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
import { documentArtifactUploadedEventName, inngest } from "@/lib/inngest/client";

export const runtime = "nodejs";

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ artifactId: string }> },
) {
  try {
    const { artifactId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director", "operator"]);
    const route = "POST /api/artifacts/:artifactId/complete";
    const db = getDb();

    const result = await db.transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
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
      const rows = await tx
        .update(artifacts)
        .set({ status: "uploaded", updatedAt: new Date() })
        .where(
          and(
            eq(artifacts.id, artifactId),
            eq(artifacts.orgId, auth.orgId),
            eq(artifacts.workspaceId, body.workspace_id),
          ),
        )
        .returning();
      const artifact = rows[0];
      if (!artifact) {
        throw new ApiError(404, "not_found", "Artifact not found.");
      }
      let captureSessionId = artifact.captureSessionId;
      if (!captureSessionId && artifact.artifactType === "document") {
        const captureSession = (
          await tx
            .insert(captureSessions)
            .values({
              orgId: auth.orgId,
              workspaceId: artifact.workspaceId,
              captureType: "document_upload",
              captureMode: "process_document_upload",
              metadataJson: {
                upload_kind: "document",
                source_artifact_ids: [artifact.id],
                participant_user_id: auth.userId,
              },
              startedAt: new Date(),
              completedAt: new Date(),
            })
            .returning()
        )[0];
        captureSessionId = captureSession.id;
        await tx
          .update(artifacts)
          .set({ captureSessionId, updatedAt: new Date() })
          .where(eq(artifacts.id, artifact.id));
        await tx.insert(auditLog).values({
          orgId: auth.orgId,
          workspaceId: artifact.workspaceId,
          userId: auth.userId,
          eventType: "capture.document_upload.completed",
          subjectType: "capture_session",
          subjectId: captureSession.id,
          metadataJson: {
            artifact_id: artifact.id,
            idempotency_key: idempotencyKey,
          },
        });
      }
      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: artifact.workspaceId,
        userId: auth.userId,
        eventType: "artifact.complete",
        subjectType: "artifact",
        subjectId: artifact.id,
        metadataJson: { idempotency_key: idempotencyKey },
      });
      const response = {
        artifact: { ...artifact, captureSessionId },
        capture_session_id: captureSessionId,
      };
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 200,
      });
      return { body: response, statusCode: 200, shouldSendEvent: true };
    });

    const responseBody = result.body as {
      artifact?: { id?: string };
      capture_session_id?: string;
    };
    if (
      result.shouldSendEvent &&
      responseBody.artifact?.id &&
      responseBody.capture_session_id
    ) {
      try {
        await inngest.send({
          name: documentArtifactUploadedEventName,
          data: {
            artifactId: responseBody.artifact.id,
            captureSessionId: responseBody.capture_session_id,
            workspaceId: body.workspace_id,
            orgId: auth.orgId,
            userId: auth.userId,
            idempotencyKey,
          },
        });
      } catch (eventError) {
        console.error("Failed to queue document artifact processing.", eventError);
      }
    }

    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}
