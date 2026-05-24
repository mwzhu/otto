import { and, eq } from "drizzle-orm";
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
import { directorInterviewCompletedEventName, inngest } from "@/lib/inngest/client";

export const runtime = "nodejs";

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ captureSessionId: string }> },
) {
  try {
    const { captureSessionId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director"]);
    const route = "POST /api/director-interviews/:captureSessionId/complete";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return { body: cached.responseJson, statusCode: cached.statusCode };
      }

      const rows = await tx
        .update(captureSessions)
        .set({ completedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(captureSessions.id, captureSessionId),
            eq(captureSessions.orgId, auth.orgId),
            eq(captureSessions.workspaceId, body.workspace_id),
            eq(captureSessions.captureType, "director_interview"),
          ),
        )
        .returning();
      const captureSession = rows[0];
      if (!captureSession) {
        throw new ApiError(404, "not_found", "Director interview not found.");
      }

      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        eventType: "capture.director_interview.completed",
        subjectType: "capture_session",
        subjectId: captureSession.id,
        metadataJson: { idempotency_key: idempotencyKey },
      });

      await inngest.send({
        name: directorInterviewCompletedEventName,
        data: {
          orgId: auth.orgId,
          workspaceId: body.workspace_id,
          captureSessionId: captureSession.id,
          userId: auth.userId,
          idempotencyKey,
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
      return { body: response, statusCode: 200 };
    });

    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}
