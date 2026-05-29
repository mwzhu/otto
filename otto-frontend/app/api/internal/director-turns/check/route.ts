import { z } from "zod";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  clearPendingIdempotentRequest,
  getIdempotentResponse,
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import {
  checkDirectorSpokenOutput,
  recordDirectorOutputCheck,
} from "@/lib/interview/director/brain";
import {
  resolveDirectorSessionContext,
} from "@/lib/interview/director/turn-transaction";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";

export const runtime = "nodejs";

const bodySchema = z.object({
  capture_session_id: z.string().uuid(),
  turn_index: z.number().int().min(0),
  spoken_agent_utterance: z.string().min(1),
  steering_context: z.record(z.string(), z.unknown()).default({}),
  local_turn_correlation_id: z.string().min(1).optional(),
  extraction_window_id: z.string().min(1).optional(),
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
    const route = "POST /api/internal/director-turns/check";

    const cached = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
      const replay = await getIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (replay.hit) return replay;
      return reserveIdempotentRequest(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
    });
    if (cached.hit) {
      return apiJson(cached.responseJson, { status: cached.statusCode });
    }
    pendingIdempotency = {
      orgId: context.orgId,
      key: idempotencyKey,
      route,
      requestHash: hash,
    };

    const check = await checkDirectorSpokenOutput({
      spokenAgentUtterance: body.spoken_agent_utterance,
      steeringContext: body.steering_context,
    });
    await recordDirectorOutputCheck({
      context,
      turnIndex: body.turn_index,
      check,
      localTurnCorrelationId: body.local_turn_correlation_id,
      extractionWindowId: body.extraction_window_id,
    });
    const response = {
      checker_status: check.checker_status,
      checker_violations: check.violations,
      checker_violation_count: check.checker_violation_count,
      stale_question_count: check.stale_question_count,
      metadata: check.metadata,
    };
    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
      await storeIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
    });
    pendingIdempotency = null;
    return apiJson(response, { status: 201 });
  } catch (error) {
    if (pendingIdempotency) await clearPending(pendingIdempotency);
    return apiError(error);
  }
}

async function clearPending(input: {
  orgId: string;
  key: string;
  route: string;
  requestHash: string;
}) {
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await clearPendingIdempotentRequest(tx, input);
  });
}
