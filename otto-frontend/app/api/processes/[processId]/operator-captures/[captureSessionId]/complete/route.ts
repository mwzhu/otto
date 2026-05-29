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
import { inngest, operatorCaptureCompletedEventName } from "@/lib/inngest/client";

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
        return {
          body: cached.responseJson,
          statusCode: cached.statusCode,
          shouldSendEvent: false,
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
      return {
        body: response,
        statusCode: 200,
        shouldSendEvent: existing.completedAt === null,
      };
    });

    const captureSession = (result.body as {
      capture_session?: { id?: string };
    }).capture_session;
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
