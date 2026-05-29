import { z } from "zod";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  getIdempotentResponse,
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import {
  dispatchDirectorTurnPlan,
  type DirectorModelMetadata,
} from "@/lib/interview/director/brain";
import {
  assertDirectorCaptureAcceptsTurns,
  assertDirectorTurnReferences,
  lockDirectorTurnSequence,
  resolveDirectorSessionContext,
} from "@/lib/interview/director/turn-transaction";
import { directorTurnPlanSchema } from "@/lib/schemas/phase1";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";

export const runtime = "nodejs";

const metadataSchema = z.object({
  model: z.string(),
  prompt_template_id: z.string(),
  prompt_template_version: z.string(),
  token_count_input: z.number().int().min(0),
  token_count_output: z.number().int().min(0),
  cache_read_input_tokens: z.number().int().min(0).optional(),
  cache_creation_input_tokens: z.number().int().min(0).optional(),
  cost_cents: z.number().min(0),
  latency_ms: z.number().int().min(0),
  cache_hit: z.boolean(),
  mocked: z.boolean().optional(),
  streaming: z.boolean().optional(),
  stream_cutoff: z.enum(["first_question", "message_stop"]).optional(),
  voice_timeout_fallback: z.boolean().optional(),
  voice_degraded: z.boolean().optional(),
  voice_timeout_ms: z.number().int().min(0).optional(),
  attempted_model: z.string().optional(),
  source: z.string().optional(),
  utterance_source: z.string().optional(),
  llm_call_elided: z.boolean().optional(),
  brain_model: z.string().optional(),
  voice_phrase_fallback: z.boolean().optional(),
  reason: z.string().optional(),
}).passthrough();

const bodySchema = z.object({
  capture_session_id: z.string().uuid(),
  latest_utterance: z.string().min(1),
  transcript_segment_ids: z.array(z.string().uuid()),
  evidence_ids: z.array(z.string().uuid()),
  turn_index: z.number().int().min(0),
  plan: directorTurnPlanSchema,
  planned_agent_utterance: z.string().min(1),
  metadata: metadataSchema.optional(),
  voice_metadata: metadataSchema.optional(),
  degraded_quality: z.boolean().default(false),
  degraded_reasons: z.array(z.string().min(1)).default([]),
  local_turn_correlation_id: z.string().min(1).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    requireLiveKitAgentService(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const context = await resolveDirectorSessionContext(body.capture_session_id);
    const route = "POST /api/internal/director-turns/dispatch";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
      const replay = await getIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (replay.hit) {
        return {
          response: replay.responseJson,
          statusCode: replay.statusCode,
        };
      }
      await lockDirectorTurnSequence(context, tx);
      await assertDirectorCaptureAcceptsTurns(context, tx);
      const cached = await reserveIdempotentRequest(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return {
          response: cached.responseJson,
          statusCode: cached.statusCode,
        };
      }

      await assertDirectorTurnReferences({
        context,
        transcriptSegmentIds: body.transcript_segment_ids,
        evidenceIds: body.evidence_ids,
        expectedTurnIndex: body.turn_index,
        tx,
      });
      const response = await dispatchDirectorTurnPlan({
        ...context,
        latestUtterance: body.latest_utterance,
        transcriptSegmentIds: body.transcript_segment_ids,
        evidenceIds: body.evidence_ids,
        turnIndex: body.turn_index,
        plan: body.plan,
        plannedAgentUtterance: body.planned_agent_utterance,
        metadata: body.metadata as DirectorModelMetadata | undefined,
        voiceMetadata: body.voice_metadata as DirectorModelMetadata | undefined,
        degradedQuality: body.degraded_quality,
        degradedReasons: body.degraded_reasons,
        localTurnCorrelationId: body.local_turn_correlation_id,
        deliveryStatus: "pending",
        tx,
      });
      await storeIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      return { response, statusCode: 201 };
    });
    return apiJson(result.response, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}
