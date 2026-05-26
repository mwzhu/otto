import { z } from "zod";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import {
  directorTranscriptSegmentInputSchema,
  ingestDirectorTurn,
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
  utterance: z.string().min(1).optional(),
  transcript_segments: z.array(directorTranscriptSegmentInputSchema).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    requireLiveKitAgentService(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const context = await resolveDirectorSessionContext(body.capture_session_id);
    const route = "POST /api/internal/director-turns/ingest";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
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
      const response = await ingestDirectorTurn({
        context,
        utterance: body.utterance,
        transcriptSegments: body.transcript_segments,
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
