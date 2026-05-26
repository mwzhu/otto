import { z } from "zod";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  getIdempotentResponse,
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import { writeAgentDecisionInTransaction } from "@/lib/db/write-agent-decision";
import {
  assertDirectorCaptureAcceptsTurns,
  lockDirectorTurnSequence,
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
  stage_name: z.literal("director.notice.asr_stall"),
  turn_index: z.number().int().min(0),
  planned_agent_utterance: z.string().min(1),
}).strict();

export async function POST(request: Request) {
  try {
    requireLiveKitAgentService(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const context = await resolveDirectorSessionContext(body.capture_session_id);
    const route = "POST /api/internal/director-turns/notice";

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

      const decision = await writeAgentDecisionInTransaction(tx, {
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        captureSessionId: context.captureSessionId,
        turnIndex: body.turn_index,
        stageName: body.stage_name,
        tsStart: new Date(),
        tsEnd: new Date(),
        transcriptSegmentIds: [],
        chosenIntent: {
          intent: "audio_recovery",
          score: 100,
          reason: "The voice worker detected an ASR stall and asked the director to repeat.",
        },
        sanitizedAgentUtterance: body.planned_agent_utterance,
        promptTemplateId: body.stage_name,
        promptTemplateVersion: "1",
        deliveryJson: {
          planned_utterance: body.planned_agent_utterance,
          delivered_utterance: null,
          delivery_status: "pending",
          spoken_fraction: 0,
        },
        model: "static-audio-recovery",
        tokenCountInput: 0,
        tokenCountOutput: 0,
        costCents: 0,
        latencyMs: 0,
        cacheHit: false,
        degradedQuality: false,
      });
      const response = {
        decision_log_id: decision.id,
        next_prompt: body.planned_agent_utterance,
      };
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
