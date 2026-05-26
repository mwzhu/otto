import { z } from "zod";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  clearPendingIdempotentRequest,
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import {
  completeDirectorInterviewInTransaction,
  sendDirectorCompletionEvent,
} from "@/lib/interview/director/completion";
import { resolveDirectorSessionContext } from "@/lib/interview/director/turn-transaction";

export const runtime = "nodejs";

const bodySchema = z.object({
  capture_session_id: z.string().uuid(),
}).strict();

export async function POST(request: Request) {
  let pendingIdempotency:
    | { orgId: string; key: string; route: string; requestHash: string }
    | null = null;
  try {
    requireLiveKitAgentService(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const context = await resolveDirectorSessionContext(body.capture_session_id);
    const route = "POST /api/internal/director-turns/complete";

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
          eventData: null,
          storeIdempotency: false,
        };
      }
      pendingIdempotency = {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      };

      const completion = await completeDirectorInterviewInTransaction(tx, {
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        captureSessionId: context.captureSessionId,
        userId: context.userId,
        idempotencyKey,
        source: "livekit_agent",
      });
      return {
        ...completion,
        storeIdempotency: true,
      };
    });

    if (result.eventData) {
      await sendDirectorCompletionEvent(result.eventData);
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
      await clearPendingIdempotentRequest(tx, {
        orgId: input.orgId,
        key: input.key,
        route: input.route,
        requestHash: input.requestHash,
      });
    });
  } catch {
    // Preserve the original route error.
  }
}
