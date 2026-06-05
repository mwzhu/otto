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
  buildDirectorSteeringPlan,
  dispatchDirectorTurnPlan,
  nonAuthoritativeDirectorSteeringPlan,
  phraseDirectorSteeringTurn,
  upsertDirectorExtractionWindow,
  voiceMetadataDegrades,
} from "@/lib/interview/director/brain";
import {
  assertDirectorCaptureAcceptsTurns,
  assertDirectorTurnReferences,
  resolveDirectorSessionContext,
} from "@/lib/interview/director/turn-transaction";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import { limitToSingleQuestion } from "@/lib/interview/_core/utterance";

export const runtime = "nodejs";

const bodySchema = z.object({
  capture_session_id: z.string().uuid(),
  latest_utterance: z.string().min(1),
  transcript_segment_ids: z.array(z.string().uuid()),
  evidence_ids: z.array(z.string().uuid()),
  turn_index: z.number().int().min(0),
  pending_extraction_turns: z.array(z.number().int().min(0)).default([]),
  pending_slot_paths: z.array(z.string().min(1)).default([]),
  last_spoken_intent: z.string().min(1).optional(),
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
    const route = "POST /api/internal/director-turns/respond";
    const wantsStream = request.headers.get("accept")?.includes("text/event-stream");

    const cached = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
      const replay = await getIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (replay.hit) return replay;
      await assertDirectorCaptureAcceptsTurns(context, tx);
      return reserveIdempotentRequest(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
    });
    if (cached.hit) {
      if (wantsStream) return streamCachedRespond(cached.responseJson);
      return apiJson(cached.responseJson, { status: cached.statusCode });
    }
    pendingIdempotency = {
      orgId: context.orgId,
      key: idempotencyKey,
      route,
      requestHash: hash,
    };

    const turnInput = {
      ...context,
      latestUtterance: body.latest_utterance,
      transcriptSegmentIds: body.transcript_segment_ids,
      evidenceIds: body.evidence_ids,
      turnIndex: body.turn_index,
      pendingExtractionTurns: body.pending_extraction_turns,
      pendingSlotPaths: body.pending_slot_paths,
      lastSpokenIntent: body.last_spoken_intent,
    };
    await assertDirectorTurnReferences({
      context,
      transcriptSegmentIds: body.transcript_segment_ids,
      evidenceIds: body.evidence_ids,
      expectedTurnIndex: body.turn_index,
    });

    const run = async (send?: (event: string, data: unknown) => void) => {
      send?.("ready", { status: "responding" });
      const steering = await buildDirectorSteeringPlan(turnInput);
      let streamedText = "";
      let streamClosed = false;
      const phrased = await phraseDirectorSteeringTurn(steering, {
        onTextDelta: (_delta, textSoFar) => {
          if (!send || streamClosed) return;
          const speakableText = limitToSingleQuestion(textSoFar);
          if (!speakableText || speakableText.length <= streamedText.length) return;
          const delta = speakableText.slice(streamedText.length);
          streamedText = speakableText;
          send("agent_text_delta", {
            delta,
            text: streamedText,
            turn_index: body.turn_index,
            stage_name: "director.turn",
            local_turn_correlation_id: body.local_turn_correlation_id,
          });
          if (speakableText.includes("?")) streamClosed = true;
        },
      });
      send?.("planned_agent_utterance", { utterance: phrased.utterance });
      if (body.extraction_window_id) {
        await upsertDirectorExtractionWindow({
          context,
          extractionWindowId: body.extraction_window_id,
          turnIndex: body.turn_index,
          transcriptSegmentIds: body.transcript_segment_ids,
          closedBy: "assistant_spoke",
          status: "pending",
          metadataJson: {
            local_turn_correlation_id: body.local_turn_correlation_id,
            steering_context: steering.steering_context,
          },
        });
      }
      const degradedQuality = voiceMetadataDegrades(phrased.metadata);
      const degradedReasons = degradedQuality ? ["voice_phrase_fallback"] : [];
      const responsePlan = nonAuthoritativeDirectorSteeringPlan(steering.plan);
      let response: {
        plan: typeof responsePlan;
        planned_agent_utterance: string;
        metadata: typeof steering.metadata;
        voice_metadata: typeof phrased.metadata;
        steering_context: typeof steering.steering_context;
        decision_log_id: string;
        degraded_quality: boolean;
        degraded_reasons: string[];
        extraction_status: "pending";
        extraction_window_id: string | undefined;
        started_at: string;
        local_turn_correlation_id: string | undefined;
      };
      await getDb().transaction(async (tx) => {
        await setOrgContext(tx, context.orgId);
        const dispatched = await dispatchDirectorTurnPlan({
          ...turnInput,
          plan: responsePlan,
          plannedAgentUtterance: phrased.utterance,
          metadata: steering.metadata,
          voiceMetadata: phrased.metadata,
          degradedQuality,
          degradedReasons,
          startedAt: steering.started_at,
          deliveryStatus: "pending",
          localTurnCorrelationId: body.local_turn_correlation_id,
          advanceConversationState: true,
          tx,
          deliveryJsonOverrides: {
            speech_delivery_status: "pending",
            extraction_status: "pending",
            extraction_window_id: body.extraction_window_id,
            agent_utterance_source: "fast_phrase",
            steering_intent: steering.plan.chosen_intent,
            spoken_agent_utterance: phrased.utterance,
            steering_context: steering.steering_context,
          },
        });
        if (!dispatched.decision_log_id) {
          throw new Error("Director respond dispatch did not return a decision log id.");
        }
        response = {
          plan: responsePlan,
          planned_agent_utterance: phrased.utterance,
          metadata: steering.metadata,
          voice_metadata: phrased.metadata,
          steering_context: steering.steering_context,
          decision_log_id: dispatched.decision_log_id,
          degraded_quality: degradedQuality,
          degraded_reasons: degradedReasons,
          extraction_status: "pending",
          extraction_window_id: body.extraction_window_id,
          started_at: steering.started_at.toISOString(),
          local_turn_correlation_id: body.local_turn_correlation_id,
        };
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
      // response is assigned in the transaction above before idempotency is stored.
      const finalResponse = response!;
      send?.("final", finalResponse);
      return finalResponse;
    };

    if (wantsStream) {
      return sseStream(async (send) => {
        try {
          await run(send);
        } catch (error) {
          if (pendingIdempotency) await clearPending(pendingIdempotency);
          send("error", {
            message: error instanceof Error ? error.message : "Respond stream failed.",
          });
        }
      });
    }
    return apiJson(await run(), { status: 201 });
  } catch (error) {
    if (pendingIdempotency) {
      await clearPending(pendingIdempotency);
    }
    return apiError(error);
  }
}

function streamCachedRespond(response: unknown) {
  return sseStream(async (send) => {
    const body = response as { planned_agent_utterance?: unknown };
    if (typeof body.planned_agent_utterance === "string") {
      send("planned_agent_utterance", { utterance: body.planned_agent_utterance });
    }
    send("final", response);
  });
}

function sseStream(
  run: (send: (event: string, data: unknown) => void) => Promise<void>,
) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        };
        await run(send);
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    },
  );
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
