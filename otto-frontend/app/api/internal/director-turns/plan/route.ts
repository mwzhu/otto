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
  phrasePlannedDirectorTurnDetailed,
  planDirectorTurn,
  planDirectorTurnStreamed,
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

export const runtime = "nodejs";

const bodySchema = z.object({
  capture_session_id: z.string().uuid(),
  latest_utterance: z.string().min(1),
  transcript_segment_ids: z.array(z.string().uuid()),
  evidence_ids: z.array(z.string().uuid()),
  turn_index: z.number().int().min(0),
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
    const route = "POST /api/internal/director-turns/plan";

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
    const wantsStream = request.headers.get("accept")?.includes("text/event-stream");
    if (cached.hit) {
      if (wantsStream) return streamCachedPlan(cached.responseJson);
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
    };
    await assertDirectorTurnReferences({
      context,
      transcriptSegmentIds: body.transcript_segment_ids,
      evidenceIds: body.evidence_ids,
      expectedTurnIndex: body.turn_index,
    });
    if (wantsStream) {
      return streamPlanResponse({
        turnInput,
        contextOrgId: context.orgId,
        idempotencyKey,
        route,
        requestHash: hash,
        clearPendingInput: pendingIdempotency,
        onStored: () => {
          pendingIdempotency = null;
        },
      });
    }

    const planned = await planDirectorTurn(turnInput);
    const phrased = await phrasePlannedDirectorTurnDetailed({
      ...turnInput,
      plan: planned.plan,
    });
    const response = {
      plan: planned.plan,
      planned_agent_utterance: phrased.utterance,
      metadata: planned.metadata,
      voice_metadata: phrased.metadata,
      degraded_quality: planned.degraded_quality || voiceMetadataDegrades(phrased.metadata),
      degraded_reasons: [
        ...new Set([
          ...planned.degraded_reasons,
          ...(voiceMetadataDegrades(phrased.metadata) ? ["voice_phrase_fallback"] : []),
        ]),
      ],
      started_at: planned.started_at.toISOString(),
    };

    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
      await storeIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 200,
      });
    });
    pendingIdempotency = null;
    return apiJson(response);
  } catch (error) {
    if (pendingIdempotency) {
      await clearPending(pendingIdempotency);
    }
    return apiError(error);
  }
}

function streamCachedPlan(response: unknown) {
  return sseStream(async (send) => {
    const body = response as { planned_agent_utterance?: unknown };
    if (typeof body.planned_agent_utterance === "string") {
      send("planned_agent_utterance", { utterance: body.planned_agent_utterance });
    }
    send("final", response);
  });
}

function streamPlanResponse(input: {
  turnInput: Parameters<typeof planDirectorTurn>[0];
  contextOrgId: string;
  idempotencyKey: string;
  route: string;
  requestHash: string;
  clearPendingInput: {
    orgId: string;
    key: string;
    route: string;
    requestHash: string;
  } | null;
  onStored: () => void;
}) {
  return sseStream(async (send) => {
    try {
      send("ready", { status: "planning" });
      let earlyUtterance: string | null = null;
      const planned = await planDirectorTurnStreamed(input.turnInput, (event) => {
        if (event.type !== "planned_agent_utterance" || earlyUtterance) return;
        earlyUtterance = event.utterance;
        send("planned_agent_utterance", {
          utterance: event.utterance,
        });
      });
      const plannedUtterance = planned.plan.planned_agent_utterance?.trim();
      if (!plannedUtterance) {
        throw new Error("Director turn plan omitted planned_agent_utterance.");
      }
      if (!earlyUtterance) {
        send("planned_agent_utterance", {
          utterance: plannedUtterance,
        });
      }
      const response = {
        plan: planned.plan,
        planned_agent_utterance: plannedUtterance,
        metadata: planned.metadata,
        voice_metadata: {
          ...planned.metadata,
          streaming: planned.metadata.streaming ?? false,
          stream_cutoff: planned.metadata.stream_cutoff ?? "message_stop",
          utterance_source: "director_turn_plan",
          llm_call_elided: true,
        },
        degraded_quality: planned.degraded_quality || voiceMetadataDegrades(planned.metadata),
        degraded_reasons: planned.degraded_reasons,
        started_at: planned.started_at.toISOString(),
      };
      await getDb().transaction(async (tx) => {
        await setOrgContext(tx, input.contextOrgId);
        await storeIdempotentResponse(tx, {
          orgId: input.contextOrgId,
          key: input.idempotencyKey,
          route: input.route,
          requestHash: input.requestHash,
          responseJson: response,
          statusCode: 200,
        });
      });
      input.onStored();
      send("final", response);
    } catch (error) {
      if (input.clearPendingInput) await clearPending(input.clearPendingInput);
      send("error", {
        message: error instanceof Error ? error.message : "Plan stream failed.",
      });
    }
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
  try {
    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, input.orgId);
      await clearPendingIdempotentRequest(tx, input);
    });
  } catch {
    // Preserve the original route error.
  }
}
