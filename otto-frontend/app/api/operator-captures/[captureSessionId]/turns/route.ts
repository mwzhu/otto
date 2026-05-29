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
import { runOperatorTurn } from "@/lib/interview/operator/brain";
import {
  ingestOperatorTurn,
  operatorTranscriptSegmentInputSchema,
} from "@/lib/interview/operator/turn-transaction";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
    utterance: z.string().min(1).optional(),
    transcript_segments: z.array(operatorTranscriptSegmentInputSchema).optional(),
  })
  .strict();

const querySchema = z.object({
  workspace_id: z.string().uuid(),
});

type TranscriptHistoryMessage = {
  id: string;
  speaker: "operator" | "agent";
  text: string;
  ts: string;
  turn_index: number | null;
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
    await ensureWorkspaceRole(auth, query.workspace_id, [
      "director",
      "operator",
      "viewer",
    ]);
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
              eq(captureSessions.captureType, "operator_interview"),
            ),
          )
          .limit(1)
      )[0];
      if (!session) {
        throw new ApiError(404, "not_found", "Operator interview not found.");
      }
      const operatorRows = await tx
        .select({
          id: transcriptSegments.id,
          text: transcriptSegments.text,
          createdAt: transcriptSegments.createdAt,
          turnIndex: transcriptSegments.turnIndex,
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
          tsStart: agentDecisionLog.tsStart,
          sanitizedAgentUtterance: agentDecisionLog.sanitizedAgentUtterance,
          deliveryJson: agentDecisionLog.deliveryJson,
        })
        .from(agentDecisionLog)
        .where(
          and(
            eq(agentDecisionLog.orgId, auth.orgId),
            eq(agentDecisionLog.workspaceId, query.workspace_id),
            eq(agentDecisionLog.captureSessionId, captureSessionId),
            inArray(agentDecisionLog.stageName, ["operator.turn"]),
          ),
        );
      return [
        ...operatorRows.map((row): TranscriptHistoryMessage => ({
          id: row.id,
          speaker: "operator",
          text: row.text,
          ts: row.createdAt.toISOString(),
          turn_index: row.turnIndex,
        })),
        ...agentRows
          .map((row): TranscriptHistoryMessage | null => {
            const text = agentUtterance(row.deliveryJson, row.sanitizedAgentUtterance);
            if (!text) return null;
            return {
              id: row.id,
              speaker: "agent",
              text,
              ts: row.tsStart.toISOString(),
              turn_index: row.turnIndex,
            };
          })
          .filter((row): row is TranscriptHistoryMessage => Boolean(row)),
      ].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
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
    await ensureWorkspaceRole(auth, body.workspace_id, ["director", "operator"]);
    const route = "POST /api/operator-captures/:captureSessionId/turns";

    const ingestResult = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const cached = await reserveIdempotentRequest(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) return { cached, turn: null, session: null };
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
              eq(captureSessions.captureType, "operator_interview"),
            ),
          )
          .limit(1)
      )[0];
      if (!session?.processId) {
        throw new ApiError(404, "not_found", "Operator interview not found.");
      }
      const turn = await ingestOperatorTurn({
        context: {
          orgId: auth.orgId,
          workspaceId: body.workspace_id,
          processId: session.processId,
          captureSessionId,
          userId: auth.userId,
          language: languageFromMetadata(session.metadataJson),
        },
        utterance: body.utterance,
        transcriptSegments: body.transcript_segments,
        tx,
      });
      return { cached: null, turn, session };
    });
    if (ingestResult.cached?.hit) {
      return apiJson(ingestResult.cached.responseJson, {
        status: ingestResult.cached.statusCode,
      });
    }
    if (!ingestResult.turn || !ingestResult.session?.processId) {
      throw new ApiError(500, "server_error", "Operator turn ingest failed.");
    }
    const turn = await runOperatorTurn({
      orgId: auth.orgId,
      workspaceId: body.workspace_id,
      processId: ingestResult.session.processId,
      captureSessionId,
      userId: auth.userId,
      language: languageFromMetadata(ingestResult.session.metadataJson),
      latestUtterance: ingestResult.turn.latest_utterance,
      transcriptSegmentIds: ingestResult.turn.transcript_segment_ids,
      evidenceIds: ingestResult.turn.evidence_ids,
      turnIndex: ingestResult.turn.turn_index,
    });
    const response = {
      transcript_segments: ingestResult.turn.transcript_segments,
      evidence: ingestResult.turn.evidence,
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
    // Preserve the original typed-turn error.
  }
}

function agentUtterance(value: unknown, legacy: string | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return legacy;
  const delivery = value as { delivered_utterance?: unknown; planned_utterance?: unknown };
  return clean(delivery.delivered_utterance) ?? clean(delivery.planned_utterance) ?? clean(legacy);
}

function clean(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
