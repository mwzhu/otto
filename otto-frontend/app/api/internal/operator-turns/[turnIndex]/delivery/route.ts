import { z } from "zod";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import {
  readTerminalOperatorTurnDelivery,
  resolveOperatorSessionContext,
  updateOperatorTurnDelivery,
} from "@/lib/interview/operator/turn-transaction";
import {
  ApiError,
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    capture_session_id: z.string().uuid(),
    decision_log_id: z.string().uuid(),
    delivery_status: z.enum(["completed", "truncated", "failed_text_fallback"]),
    delivered_utterance: z.string().nullable(),
    spoken_fraction: z.number().min(0).max(1),
    latency_ms: z.record(z.string(), z.number().int().min(0)).optional(),
    audio_metadata: z.record(z.string(), z.unknown()).optional(),
    local_turn_correlation_id: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const delivered = body.delivered_utterance?.trim() ?? "";
    if (body.delivery_status === "completed" && body.spoken_fraction !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["spoken_fraction"],
        message: "completed delivery requires spoken_fraction to equal 1.",
      });
    }
    if (body.delivery_status === "completed" && !delivered) {
      ctx.addIssue({
        code: "custom",
        path: ["delivered_utterance"],
        message: "completed delivery requires delivered_utterance.",
      });
    }
    if (body.delivery_status === "failed_text_fallback" && body.spoken_fraction !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["spoken_fraction"],
        message: "failed text fallback delivery requires spoken_fraction to equal 0.",
      });
    }
    if (body.delivery_status === "truncated" && body.spoken_fraction > 0 && !delivered) {
      ctx.addIssue({
        code: "custom",
        path: ["delivered_utterance"],
        message: "truncated delivery with spoken audio requires the spoken prefix.",
      });
    }
  });

export async function POST(
  request: Request,
  ctx: { params: Promise<{ turnIndex: string }> },
) {
  try {
    requireLiveKitAgentService(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { turnIndex } = await ctx.params;
    const parsedTurnIndex = Number(turnIndex);
    if (!Number.isInteger(parsedTurnIndex) || parsedTurnIndex < 0) {
      throw new ApiError(400, "bad_request", "turnIndex must be a non-negative integer.");
    }

    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const context = await resolveOperatorSessionContext(body.capture_session_id);
    const route = "POST /api/internal/operator-turns/:turnIndex/delivery";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
      let cached;
      try {
        cached = await reserveIdempotentRequest(tx, {
          orgId: context.orgId,
          key: idempotencyKey,
          route,
          requestHash: hash,
        });
      } catch (error) {
        if (!isIdempotencyBodyMismatch(error)) throw error;
        const terminalDelivery = await readTerminalOperatorTurnDelivery({
          context,
          turnIndex: parsedTurnIndex,
          decisionLogId: body.decision_log_id,
          tx,
        });
        if (!terminalDelivery) throw error;
        return { response: { delivery: terminalDelivery }, statusCode: 200 };
      }
      if (cached.hit) {
        return {
          response: cached.responseJson,
          statusCode: cached.statusCode,
        };
      }
      const delivery = await updateOperatorTurnDelivery({
        context,
        turnIndex: parsedTurnIndex,
        decisionLogId: body.decision_log_id,
        deliveryStatus: body.delivery_status,
        deliveredUtterance: body.delivered_utterance,
        spokenFraction: body.spoken_fraction,
        latencyMs: body.latency_ms,
        audioMetadata: body.audio_metadata,
        localTurnCorrelationId: body.local_turn_correlation_id,
        tx,
      });
      const response = { delivery };
      await storeIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 200,
      });
      return { response, statusCode: 200 };
    });
    return apiJson(result.response, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}

function isIdempotencyBodyMismatch(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.message.includes("different request body")
  );
}
