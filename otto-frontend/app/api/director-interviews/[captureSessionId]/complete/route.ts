import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import {
  clearPendingIdempotentRequest,
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import {
  completeDirectorInterviewInTransaction,
  sendDirectorCompletionEvent,
} from "@/lib/interview/director/completion";

export const runtime = "nodejs";

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
}).strict();

export async function POST(
  request: Request,
  ctx: { params: Promise<{ captureSessionId: string }> },
) {
  let pendingIdempotency:
    | { orgId: string; key: string; route: string; requestHash: string }
    | null = null;
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
      const cached = await reserveIdempotentRequest(tx, {
        orgId: auth.orgId,
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
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      };

      const completion = await completeDirectorInterviewInTransaction(tx, {
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        captureSessionId,
        userId: auth.userId,
        idempotencyKey,
        source: "browser",
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
        await setOrgContext(tx, auth.orgId);
        await storeIdempotentResponse(tx, {
          orgId: auth.orgId,
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
