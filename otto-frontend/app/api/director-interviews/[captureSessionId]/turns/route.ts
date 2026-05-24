import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { captureSessions, transcriptSegments } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import {
  ApiError,
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import { createTranscriptEvidence } from "@/lib/interview/director/tools";
import { runDirectorTurn } from "@/lib/interview/director/brain";

export const runtime = "nodejs";

const segmentSchema = z.object({
  speaker: z.string().min(1).default("director"),
  speaker_role: z.string().optional(),
  start_ms: z.number().int().min(0).optional(),
  end_ms: z.number().int().min(0).optional(),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  utterance: z.string().min(1).optional(),
  transcript_segments: z.array(segmentSchema).optional(),
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ captureSessionId: string }> },
) {
  try {
    const { captureSessionId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director"]);
    const route = "POST /api/director-interviews/:captureSessionId/turns";

    const cached = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      return getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
    });
    if (cached.hit) {
      return apiJson(cached.responseJson, { status: cached.statusCode });
    }

    const session = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const rows = await tx
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
        .limit(1);
      return rows[0];
    });
    if (!session) {
      throw new ApiError(404, "not_found", "Director interview not found.");
    }

    const submittedSegments =
      body.transcript_segments?.length
        ? body.transcript_segments
        : [{ speaker: "director", text: body.utterance ?? "" }];
    const latestUtterance = submittedSegments.map((segment) => segment.text).join("\n");
    if (!latestUtterance.trim()) {
      throw new ApiError(400, "bad_request", "A transcript utterance is required.");
    }

    const insertedSegments = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      return tx
        .insert(transcriptSegments)
        .values(
          submittedSegments.map((segment, index) => {
            const startMs = segment.start_ms ?? index * 1000;
            return {
              orgId: auth.orgId,
              workspaceId: body.workspace_id,
              captureSessionId,
              speaker: segment.speaker,
              speakerRole: segment.speaker_role ?? "director",
              startMs,
              endMs: segment.end_ms ?? startMs + Math.max(1000, segment.text.length * 35),
              text: segment.text,
              confidence:
                segment.confidence === undefined
                  ? undefined
                  : String(segment.confidence),
            };
          }),
        )
        .returning();
    });

    const evidenceRows = [];
    for (const segment of insertedSegments) {
      evidenceRows.push(
        await createTranscriptEvidence({
          orgId: auth.orgId,
          workspaceId: body.workspace_id,
          transcriptSegmentId: segment.id,
          quote: segment.text,
          confidence: Number(segment.confidence ?? 0.8),
        }),
      );
    }

    const priorTurnCount = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const result = await tx.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count
        FROM transcript_segments
        WHERE org_id = ${auth.orgId}
          AND workspace_id = ${body.workspace_id}
          AND capture_session_id = ${captureSessionId}
      `);
      return Number(result.rows[0]?.count ?? insertedSegments.length) - insertedSegments.length;
    });

    const turn = await runDirectorTurn({
      orgId: auth.orgId,
      workspaceId: body.workspace_id,
      captureSessionId,
      userId: auth.userId,
      latestUtterance,
      transcriptSegmentIds: insertedSegments.map((segment) => segment.id),
      evidenceIds: evidenceRows.map((row) => row.id),
      turnIndex: Math.max(0, priorTurnCount),
    });

    const response = {
      transcript_segments: insertedSegments,
      evidence: evidenceRows,
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

    return apiJson(response, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
