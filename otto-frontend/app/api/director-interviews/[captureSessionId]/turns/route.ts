import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  agentDecisionLog,
  captureSessions,
  transcriptSegments,
} from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import {
  ApiError,
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import {
  clearPendingIdempotentRequest,
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import { runDirectorTurn } from "@/lib/interview/director/brain";
import {
  directorTranscriptSegmentInputSchema,
  ingestDirectorTurn,
} from "@/lib/interview/director/turn-transaction";

export const runtime = "nodejs";

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  utterance: z.string().min(1).optional(),
  transcript_segments: z.array(directorTranscriptSegmentInputSchema).optional(),
}).strict();

const querySchema = z.object({
  workspace_id: z.string().uuid(),
});

type TranscriptHistoryMessage = {
  id: string;
  speaker: "director" | "agent";
  text: string;
  ts: string;
  turn_index: number | null;
  stage_name?: string | null;
};

export async function GET(
  request: Request,
  ctx: { params: Promise<{ captureSessionId: string }> },
) {
  try {
    const { captureSessionId } = await ctx.params;
    const auth = await requireAuth(request);
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    await ensureWorkspaceRole(auth, query.workspace_id, ["director", "viewer"]);

    const messages = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const session = (
        await tx
          .select({ id: captureSessions.id })
          .from(captureSessions)
          .where(
            and(
              eq(captureSessions.id, captureSessionId),
              eq(captureSessions.orgId, auth.orgId),
              eq(captureSessions.workspaceId, query.workspace_id),
              eq(captureSessions.captureType, "director_interview"),
            ),
          )
          .limit(1)
      )[0];
      if (!session) {
        throw new ApiError(404, "not_found", "Director interview not found.");
      }

      const directorRows = await tx
        .select({
          id: transcriptSegments.id,
          text: transcriptSegments.text,
          createdAt: transcriptSegments.createdAt,
          turnIndex: transcriptSegments.turnIndex,
          startMs: transcriptSegments.startMs,
        })
        .from(transcriptSegments)
        .where(
          and(
            eq(transcriptSegments.orgId, auth.orgId),
            eq(transcriptSegments.workspaceId, query.workspace_id),
            eq(transcriptSegments.captureSessionId, captureSessionId),
          ),
        );

      const agentRows = await tx
        .select({
          id: agentDecisionLog.id,
          turnIndex: agentDecisionLog.turnIndex,
          stageName: agentDecisionLog.stageName,
          tsStart: agentDecisionLog.tsStart,
          transcriptSegmentIds: agentDecisionLog.transcriptSegmentIds,
          sanitizedAgentUtterance: agentDecisionLog.sanitizedAgentUtterance,
          deliveryJson: agentDecisionLog.deliveryJson,
        })
        .from(agentDecisionLog)
        .where(
          and(
            eq(agentDecisionLog.orgId, auth.orgId),
            eq(agentDecisionLog.workspaceId, query.workspace_id),
            eq(agentDecisionLog.captureSessionId, captureSessionId),
            inArray(agentDecisionLog.stageName, [
              "director.opening",
              "director.notice.asr_stall",
              "director.turn",
            ]),
          ),
        );
      const segmentTurnIndexes = new Map<string, number>();
      for (const row of agentRows) {
        if (row.turnIndex === null) continue;
        for (const segmentId of row.transcriptSegmentIds ?? []) {
          segmentTurnIndexes.set(segmentId, row.turnIndex);
        }
      }

      return [
        ...directorRows.map((row): TranscriptHistoryMessage => ({
          id: row.id,
          speaker: "director",
          text: row.text,
          ts: row.createdAt.toISOString(),
          turn_index: row.turnIndex ?? segmentTurnIndexes.get(row.id) ?? null,
        })),
        ...agentRows
          .map((row): TranscriptHistoryMessage | null => {
            const text = transcriptAgentUtterance(
              row.deliveryJson,
              row.sanitizedAgentUtterance,
            );
            if (!text) return null;
            return {
              id: row.id,
              speaker: "agent",
              text,
              ts: row.tsStart.toISOString(),
              turn_index: row.turnIndex,
              stage_name: row.stageName,
            };
          })
          .filter((row): row is TranscriptHistoryMessage => Boolean(row)),
      ].sort(
        (a, b) =>
          new Date(a.ts).getTime() - new Date(b.ts).getTime() ||
          speakerOrder(a.speaker) - speakerOrder(b.speaker),
      );
    });

    return apiJson({ capture_session_id: captureSessionId, messages });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ captureSessionId: string }> },
) {
  let pendingIdempotency:
    | { orgId: string; key: string; route: string; requestHash: string }
    | null = null;
  try {
    const { captureSessionId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director"]);
    const route = "POST /api/director-interviews/:captureSessionId/turns";

    const ingestResult = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const cached = await reserveIdempotentRequest(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return {
          cached,
          turn: null,
        };
      }
      pendingIdempotency = {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      };

      const session = (
        await tx
          .select()
          .from(captureSessions)
          .where(
            and(
              eq(captureSessions.id, captureSessionId),
              eq(captureSessions.orgId, auth.orgId),
              eq(captureSessions.workspaceId, body.workspace_id),
              eq(captureSessions.captureType, "director_interview"),
            ),
          )
          .limit(1)
      )[0];
      if (!session) {
        throw new ApiError(404, "not_found", "Director interview not found.");
      }

      const turn = await ingestDirectorTurn({
        context: {
          orgId: auth.orgId,
          workspaceId: body.workspace_id,
          captureSessionId,
          userId: auth.userId,
          language: languageFromMetadata(session.metadataJson),
        },
        utterance: body.utterance,
        transcriptSegments: body.transcript_segments,
        tx,
      });
      return {
        cached: null,
        turn,
      };
    });
    if (ingestResult.cached?.hit) {
      return apiJson(ingestResult.cached.responseJson, {
        status: ingestResult.cached.statusCode,
      });
    }
    const ingestedTurn = ingestResult.turn;
    if (!ingestedTurn) {
      throw new ApiError(500, "server_error", "Director turn ingest did not return a turn.");
    }

    const turn = await runDirectorTurn({
      orgId: auth.orgId,
      workspaceId: body.workspace_id,
      captureSessionId,
      userId: auth.userId,
      latestUtterance: ingestedTurn.latest_utterance,
      transcriptSegmentIds: ingestedTurn.transcript_segment_ids,
      evidenceIds: ingestedTurn.evidence_ids,
      turnIndex: ingestedTurn.turn_index,
    });

    const response = {
      transcript_segments: ingestedTurn.transcript_segments,
      evidence: ingestedTurn.evidence,
      ...turn,
    };
    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      pendingIdempotency = null;
    });

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
    // Preserve the original route error.
  }
}

function transcriptAgentUtterance(
  value: unknown,
  legacySanitizedUtterance: string | null,
) {
  const legacy = cleanTranscriptUtterance(legacySanitizedUtterance);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return legacy;
  }
  const delivery = value as {
    delivery_status?: unknown;
    delivered_utterance?: unknown;
    planned_utterance?: unknown;
  };
  const status =
    typeof delivery.delivery_status === "string"
      ? delivery.delivery_status
      : null;
  const delivered = cleanTranscriptUtterance(delivery.delivered_utterance);
  const planned = cleanTranscriptUtterance(delivery.planned_utterance);

  if (status === "pending") return null;
  if (status === "truncated") return planned ?? delivered;
  if (status === "completed" || status === "failed_text_fallback") {
    return delivered ?? planned ?? legacy;
  }
  return delivered ?? legacy;
}

function cleanTranscriptUtterance(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function languageFromMetadata(metadata: unknown) {
  if (
    metadata &&
    typeof metadata === "object" &&
    "language" in metadata &&
    typeof metadata.language === "string" &&
    metadata.language.trim()
  ) {
    return metadata.language.trim();
  }
  return "en";
}

function speakerOrder(speaker: TranscriptHistoryMessage["speaker"]) {
  return speaker === "director" ? 0 : 1;
}
