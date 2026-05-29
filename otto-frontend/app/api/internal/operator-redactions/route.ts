import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import { getDb, setOrgContext } from "@/lib/db/client";
import { auditLog, redactions } from "@/lib/db/schema";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import { inngest, operatorRedactionRequestedEventName } from "@/lib/inngest/client";
import { resolveOperatorSessionContext } from "@/lib/interview/operator/turn-transaction";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    capture_session_id: z.string().uuid(),
    start_ms: z.number().int().min(0),
    end_ms: z.number().int().min(0),
    reason: z.string().max(240).optional(),
  })
  .strict()
  .refine((body) => body.end_ms >= body.start_ms, {
    path: ["end_ms"],
    message: "end_ms must be greater than or equal to start_ms.",
  });

export async function POST(request: Request) {
  try {
    requireLiveKitAgentService(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const context = await resolveOperatorSessionContext(body.capture_session_id);
    const route = "POST /api/internal/operator-redactions";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`operator.redaction.request:${context.captureSessionId}:${idempotencyKey}`}))
      `);
      const cached = await getIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        const redactionId = (cached.responseJson as { redaction?: { id?: unknown } })
          .redaction?.id;
        return {
          body: cached.responseJson,
          statusCode: cached.statusCode,
          eventData:
            typeof redactionId === "string"
              ? {
                  orgId: context.orgId,
                  workspaceId: context.workspaceId,
                  processId: context.processId,
                  captureSessionId: context.captureSessionId,
                  redactionId,
                  idempotencyKey,
                }
              : null,
        };
      }
      const redaction = (
        await tx
          .insert(redactions)
          .values({
            orgId: context.orgId,
            workspaceId: context.workspaceId,
            captureSessionId: context.captureSessionId,
            startMs: body.start_ms,
            endMs: body.end_ms,
            reason: body.reason ?? "operator_agent_requested_window",
            status: "pending",
          })
          .returning()
      )[0];
      await tx.insert(auditLog).values({
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        eventType: "capture.operator.redaction_requested_by_agent",
        subjectType: "redaction",
        subjectId: redaction.id,
        metadataJson: {
          process_id: context.processId,
          capture_session_id: context.captureSessionId,
          start_ms: body.start_ms,
          end_ms: body.end_ms,
          idempotency_key: idempotencyKey,
        },
      });
      const response = { redaction };
      await storeIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      return {
        body: response,
        statusCode: 201,
        eventData: {
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          processId: context.processId,
          captureSessionId: context.captureSessionId,
          redactionId: redaction.id,
          idempotencyKey,
        },
      };
    });

    if (result.eventData) {
      await inngest.send({
        name: operatorRedactionRequestedEventName,
        data: result.eventData,
      });
    }

    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}
