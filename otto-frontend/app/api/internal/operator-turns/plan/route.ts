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
  planOperatorTurn,
  planOperatorTurnStreamed,
} from "@/lib/interview/operator/brain";
import {
  assertOperatorCaptureAcceptsTurns,
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
    const route = "POST /api/internal/operator-turns/plan";
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
      await assertOperatorCaptureAcceptsTurns(context, tx);
      await assertOperatorTurnReferences({
        context,
        transcriptSegmentIds: body.transcript_segment_ids,
        evidenceIds: body.evidence_ids,
        expectedTurnIndex: body.turn_index,
        tx,
      });
      return reserveIdempotentRequest(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
    });
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

    if (wantsStream) {
      return sseStream(async (send) => {
        try {
          const planned = await planOperatorTurnStreamed(turnInput, (event) => {
            send("planned_agent_utterance", { utterance: event.utterance });
          });
          await storePlan(context.orgId, idempotencyKey, route, hash, planned);
          pendingIdempotency = null;
          send("final", planned);
        } catch (error) {
          if (pendingIdempotency) await clearPending(pendingIdempotency);
          pendingIdempotency = null;
          send("error", {
            message: error instanceof Error ? error.message : "Plan stream failed.",
          });
        }
      });
    }

    const planned = await planOperatorTurn(turnInput);
    await storePlan(context.orgId, idempotencyKey, route, hash, planned);
    pendingIdempotency = null;
    return apiJson(planned);
  } catch (error) {
    if (pendingIdempotency) {
      await clearPending(pendingIdempotency);
    }
    return apiError(error);
  }
}

async function storePlan(
  orgId: string,
  idempotencyKey: string,
  route: string,
  requestHash: string,
  responseJson: unknown,
) {
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    await storeIdempotentResponse(tx, {
      orgId,
      key: idempotencyKey,
      route,
      requestHash,
      responseJson,
      statusCode: 200,
    });
  });
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
    // Preserve the original route or stream error.
  }
}
