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
    if (cached.hit) {
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
      degraded_quality: planned.degraded_quality || phrased.metadata.mocked,
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
