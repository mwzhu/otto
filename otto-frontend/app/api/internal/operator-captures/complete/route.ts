import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  clearPendingIdempotentRequest,
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import { auditLog, captureSessions } from "@/lib/db/schema";
import {
  ApiError,
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import { inngest, operatorCaptureCompletedEventName } from "@/lib/inngest/client";
import { resolveOperatorSessionContext } from "@/lib/interview/operator/turn-transaction";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    capture_session_id: z.string().uuid(),
  })
  .strict();

export async function POST(request: Request) {
  let pendingIdempotency:
    | { orgId: string; key: string; route: string; requestHash: string }
    | null = null;
  try {
    requireLiveKitAgentService(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const context = await resolveOperatorSessionContext(body.capture_session_id);
    const route = "POST /api/internal/operator-captures/complete";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
      const cached = await reserveIdempotentRequest(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return {
          body: cached.responseJson,
          statusCode: cached.statusCode,
          shouldSendEvent: false,
          storeIdempotency: false,
        };
      }
      pendingIdempotency = {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      };

      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`operator.capture.complete:${context.captureSessionId}`}))
      `);

      const existing = (
        await tx
          .select()
          .from(captureSessions)
          .where(
            and(
              eq(captureSessions.id, context.captureSessionId),
              eq(captureSessions.orgId, context.orgId),
              eq(captureSessions.workspaceId, context.workspaceId),
              eq(captureSessions.processId, context.processId),
              eq(captureSessions.captureType, "operator_interview"),
            ),
          )
          .limit(1)
      )[0];
      if (!existing) {
        throw new ApiError(404, "not_found", "Operator capture not found.");
      }

      const completedAt = new Date();
      const captureSession =
        existing.completedAt === null
          ? (
              await tx
                .update(captureSessions)
                .set({ completedAt, updatedAt: completedAt })
                .where(
                  and(
                    eq(captureSessions.id, context.captureSessionId),
                    isNull(captureSessions.completedAt),
                  ),
                )
                .returning()
            )[0] ?? existing
          : existing;
      const previousCompletionForThisKey =
        existing.completedAt !== null
          ? (
              await tx
                .select({ id: auditLog.id })
                .from(auditLog)
                .where(
                  and(
                    eq(auditLog.orgId, context.orgId),
                    eq(auditLog.workspaceId, context.workspaceId),
                    eq(auditLog.eventType, "capture.operator.completed"),
                    eq(auditLog.subjectType, "capture_session"),
                    eq(auditLog.subjectId, context.captureSessionId),
                    sql`${auditLog.metadataJson}->>'idempotency_key' = ${idempotencyKey}`,
                  ),
                )
                .limit(1)
            )[0]
          : null;

      await tx.insert(auditLog).values({
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        userId: context.userId,
        eventType: "capture.operator.completed",
        subjectType: "capture_session",
        subjectId: captureSession.id,
        metadataJson: {
          process_id: context.processId,
          capture_mode: captureSession.captureMode,
          idempotency_key: idempotencyKey,
          source: "livekit_agent",
          already_completed: existing.completedAt !== null,
        },
      });

      return {
        body: { capture_session: captureSession },
        statusCode: 200,
        shouldSendEvent:
          existing.completedAt === null || Boolean(previousCompletionForThisKey),
        storeIdempotency: true,
      };
    });

    if (result.shouldSendEvent) {
      try {
        await inngest.send({
          name: operatorCaptureCompletedEventName,
          data: {
            captureSessionId: context.captureSessionId,
            processId: context.processId,
            workspaceId: context.workspaceId,
            orgId: context.orgId,
            userId: context.userId,
            idempotencyKey,
          },
        });
      } catch (error) {
        console.error("Failed to enqueue operator capture completion event", error);
        result.body = {
          ...(result.body as Record<string, unknown>),
          background_event: {
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Could not enqueue background synthesis.",
          },
        };
      }
    }
    if (result.storeIdempotency) {
      await getDb().transaction(async (tx) => {
        await setOrgContext(tx, context.orgId);
        await storeIdempotentResponse(tx, {
          orgId: context.orgId,
          key: idempotencyKey,
          route,
          requestHash: hash,
          responseJson: result.body,
          statusCode: result.statusCode,
        });
      });
      pendingIdempotency = null;
    }

    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    if (pendingIdempotency) {
      await clearPending(pendingIdempotency);
    }
    return apiError(error);
  }
}

async function clearPending(input: {
  orgId: string;
  key: string;
  route: string;
  requestHash: string;
}) {
  try {
    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, input.orgId);
      await clearPendingIdempotentRequest(tx, input);
    });
  } catch {
    // Preserve the original route error.
  }
}
