import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { auditLog, captureSessions } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";

export const runtime = "nodejs";

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  language: z.string().min(2).max(16).default("en"),
});

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director"]);
    const route = "POST /api/director-interviews";

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

      const captureSession = (
        await tx
          .insert(captureSessions)
          .values({
            orgId: auth.orgId,
            workspaceId: body.workspace_id,
            captureType: "director_interview",
            startedAt: new Date(),
          })
          .returning()
      )[0];

      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        eventType: "capture.director_interview.started",
        subjectType: "capture_session",
        subjectId: captureSession.id,
        metadataJson: {
          idempotency_key: idempotencyKey,
          language: body.language,
        },
      });

      const response = {
        capture_session: captureSession,
        language: body.language,
      };
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      return { body: response, statusCode: 201 };
    });

    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}
