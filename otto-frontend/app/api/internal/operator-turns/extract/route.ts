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
  dispatchOperatorTurnPlan,
  extractOperatorTurn,
  upsertOperatorExtractionWindow,
  updateOperatorExtractionStatus,
  voiceMetadataDegrades,
} from "@/lib/interview/operator/brain";
import {
  assertOperatorTurnReferences,
  resolveOperatorSessionContext,
} from "@/lib/interview/operator/turn-transaction";
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
    latest_utterance: z.string().min(1),
    transcript_segment_ids: z.array(z.string().uuid()),
    evidence_ids: z.array(z.string().uuid()),
    turn_index: z.number().int().min(0),
    spoken_agent_utterance: z.string().min(1),
    local_turn_correlation_id: z.string().min(1).optional(),
    extraction_window_id: z.string().min(1).optional(),
    window_turn_indexes: z.array(z.number().int().min(0)).optional(),
  })
  .strict();

export async function POST(request: Request) {
  let pendingIdempotency:
    | { orgId: string; key: string; route: string; requestHash: string }
    | null = null;
  let context:
    | Awaited<ReturnType<typeof resolveOperatorSessionContext>>
    | undefined;
  let body: z.infer<typeof bodySchema> | undefined;
  const extractionStarted = Date.now();
  try {
    requireLiveKitAgentService(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    body = bodySchema.parse(json);
    const requestBody = body;
    context = await resolveOperatorSessionContext(requestBody.capture_session_id);
    const route = "POST /api/internal/operator-turns/extract";

    const cached = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context!.orgId);
      const replay = await getIdempotentResponse(tx, {
        orgId: context!.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (replay.hit) return replay;
      return reserveIdempotentRequest(tx, {
        orgId: context!.orgId,
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

    await assertOperatorTurnReferences({
      context,
      transcriptSegmentIds: requestBody.transcript_segment_ids,
      evidenceIds: requestBody.evidence_ids,
      expectedTurnIndex: requestBody.turn_index,
      expectedTurnIndexes: requestBody.window_turn_indexes,
      allowMultipleTurnIndexes: Boolean(requestBody.extraction_window_id),
    });

    const turnInput = {
      ...context,
      latestUtterance: requestBody.latest_utterance,
      transcriptSegmentIds: requestBody.transcript_segment_ids,
      evidenceIds: requestBody.evidence_ids,
      turnIndex: requestBody.turn_index,
    };
    const planned = await extractOperatorTurn(turnInput);
    const extractionLatencyMs = Math.max(0, Date.now() - extractionStarted);
    let result: Awaited<ReturnType<typeof dispatchOperatorTurnPlan>> | undefined;
    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context!.orgId);
      result = await dispatchOperatorTurnPlan({
        ...turnInput,
        plan: planned.plan,
        planned_agent_utterance: requestBody.spoken_agent_utterance,
        metadata: planned.metadata,
        degraded_quality: planned.degraded_quality || voiceMetadataDegrades(planned.metadata),
        degraded_reasons: planned.degraded_reasons,
        started_at: planned.started_at,
        deliveryStatus: "completed",
        localTurnCorrelationId: requestBody.local_turn_correlation_id,
        decisionStageName: "operator.extraction",
        advanceConversationState: false,
        tx,
        deliveryJsonOverrides: {
          extraction_status: "complete",
          extraction_window_id: requestBody.extraction_window_id,
          extraction_advisory_utterance: planned.plan.planned_agent_utterance ?? null,
          delivered_utterance: requestBody.spoken_agent_utterance,
          spoken_fraction: 1,
          window_turn_indexes: extractionStatusTurnIndexes(requestBody),
        },
      });
      const response = {
        ...result,
        extraction_status: "complete",
        extraction_latency_ms: extractionLatencyMs,
        slot_update_latency_ms: extractionLatencyMs,
        extraction_window_id: requestBody.extraction_window_id,
      };
      const extractionDecisionLogId = result.decision_log_id;
      if (requestBody.extraction_window_id) {
        await upsertOperatorExtractionWindow({
          context: context!,
          extractionWindowId: requestBody.extraction_window_id,
          turnIndex: requestBody.turn_index,
          transcriptSegmentIds: requestBody.transcript_segment_ids,
          closedBy: "assistant_spoke",
          status: "complete",
          metadataJson: {
            local_turn_correlation_id: requestBody.local_turn_correlation_id,
            extraction_decision_log_id: extractionDecisionLogId,
            extraction_latency_ms: extractionLatencyMs,
            window_turn_indexes: extractionStatusTurnIndexes(requestBody),
          },
          tx,
        });
      }
      for (const turnIndex of extractionStatusTurnIndexes(requestBody)) {
        await updateOperatorExtractionStatus({
          context: context!,
          turnIndex,
          extractionStatus: "complete",
          extractionDecisionLogId,
          extractionLatencyMs,
          localTurnCorrelationId: requestBody.local_turn_correlation_id,
          extractionWindowId: requestBody.extraction_window_id,
          tx,
        });
      }
      await storeIdempotentResponse(tx, {
        orgId: context!.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
    });
    const response = {
      ...result!,
      extraction_status: "complete",
      extraction_latency_ms: extractionLatencyMs,
      slot_update_latency_ms: extractionLatencyMs,
      extraction_window_id: requestBody.extraction_window_id,
    };
    pendingIdempotency = null;
    return apiJson(response, { status: 201 });
  } catch (error) {
    if (pendingIdempotency) {
      await clearPending(pendingIdempotency);
    }
    if (context && body) {
      if (body.extraction_window_id) {
        await upsertOperatorExtractionWindow({
          context,
          extractionWindowId: body.extraction_window_id,
          turnIndex: body.turn_index,
          transcriptSegmentIds: body.transcript_segment_ids,
          closedBy: "assistant_spoke",
          status: "failed",
          metadataJson: {
            local_turn_correlation_id: body.local_turn_correlation_id,
            error_message: error instanceof Error ? error.message : "Extraction failed.",
          },
        }).catch(() => undefined);
      }
      for (const turnIndex of extractionStatusTurnIndexes(body)) {
        await updateOperatorExtractionStatus({
          context,
          turnIndex,
          extractionStatus: "failed",
          extractionLatencyMs: Math.max(0, Date.now() - extractionStarted),
          errorMessage: error instanceof Error ? error.message : "Extraction failed.",
          localTurnCorrelationId: body.local_turn_correlation_id,
          extractionWindowId: body.extraction_window_id,
        }).catch(() => undefined);
      }
    }
    return apiError(error);
  }
}

function extractionStatusTurnIndexes(body: z.infer<typeof bodySchema>) {
  const indexes = body.window_turn_indexes?.length
    ? body.window_turn_indexes
    : [body.turn_index];
  return [...new Set(indexes)].sort((a, b) => a - b);
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
