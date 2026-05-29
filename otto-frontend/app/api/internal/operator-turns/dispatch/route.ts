import { z } from "zod";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  clearPendingIdempotentRequest,
  getIdempotentResponse,
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import { dispatchOperatorTurnPlan } from "@/lib/interview/operator/brain";
import { operatorTurnPlanSchema } from "@/lib/interview/operator/schema";
import {
  assertOperatorCaptureAcceptsTurns,
  assertOperatorTurnReferences,
  lockOperatorTurnSequence,
  resolveOperatorSessionContext,
} from "@/lib/interview/operator/turn-transaction";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";

export const runtime = "nodejs";

const metadataSchema = z
  .object({
    model: z.string(),
    prompt_template_id: z.string(),
    prompt_template_version: z.string(),
    token_count_input: z.number().int().min(0),
    token_count_output: z.number().int().min(0),
    cost_cents: z.number().min(0),
    latency_ms: z.number().int().min(0),
    cache_hit: z.boolean(),
    source: z.string(),
    utterance_source: z.string(),
    llm_call_elided: z.boolean(),
  })
  .passthrough();

const bodySchema = z
  .object({
    capture_session_id: z.string().uuid(),
    latest_utterance: z.string().min(1),
    transcript_segment_ids: z.array(z.string().uuid()),
    evidence_ids: z.array(z.string().uuid()),
    turn_index: z.number().int().min(0),
    plan: operatorTurnPlanSchema,
    planned_agent_utterance: z.string().min(1),
    metadata: metadataSchema,
    degraded_quality: z.boolean().default(false),
    degraded_reasons: z.array(z.string().min(1)).default([]),
    local_turn_correlation_id: z.string().min(1).optional(),
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
    const route = "POST /api/internal/operator-turns/dispatch";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
      const replay = await getIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (replay.hit) {
        return { response: replay.responseJson, statusCode: replay.statusCode };
      }
      await lockOperatorTurnSequence(context, tx);
      await assertOperatorCaptureAcceptsTurns(context, tx);
      const cached = await reserveIdempotentRequest(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return { response: cached.responseJson, statusCode: cached.statusCode };
      }
      pendingIdempotency = {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      };
    });
    if (result) return apiJson(result.response, { status: result.statusCode });

    await assertOperatorTurnReferences({
      context,
      transcriptSegmentIds: body.transcript_segment_ids,
      evidenceIds: body.evidence_ids,
      expectedTurnIndex: body.turn_index,
    });
    const response = await dispatchOperatorTurnPlan({
      ...context,
      latestUtterance: body.latest_utterance,
      transcriptSegmentIds: body.transcript_segment_ids,
      evidenceIds: body.evidence_ids,
      turnIndex: body.turn_index,
      plan: body.plan,
      planned_agent_utterance: body.planned_agent_utterance,
      metadata: body.metadata,
      degraded_quality: body.degraded_quality,
      degraded_reasons: body.degraded_reasons,
      started_at: new Date(),
      localTurnCorrelationId: body.local_turn_correlation_id,
      deliveryStatus: "pending",
    });
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
    // Preserve the original dispatch error.
  }
}
