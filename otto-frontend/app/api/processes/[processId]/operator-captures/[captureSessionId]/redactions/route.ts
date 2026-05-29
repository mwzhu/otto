import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  auditLog,
  captureSessions,
  redactions,
  screenEvents,
  transcriptSegments,
} from "@/lib/db/schema";
import { inngest, operatorRedactionRequestedEventName } from "@/lib/inngest/client";
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

export const runtime = "nodejs";

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
    last_seconds: z.number().int().min(1).max(300).default(30),
    reason: z.string().max(240).optional(),
  })
  .strict();

export async function POST(
  request: Request,
  ctx: { params: Promise<{ processId: string; captureSessionId: string }> },
) {
  try {
    const { processId, captureSessionId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director", "operator"]);
    const route =
      "POST /api/processes/:processId/operator-captures/:captureSessionId/redactions";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`operator.redaction.request:${captureSessionId}:${idempotencyKey}`}))
      `);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return {
          body: cached.responseJson,
          statusCode: cached.statusCode,
          shouldSendEvent: false,
        };
      }

      const capture = (
        await tx
          .select({ id: captureSessions.id })
          .from(captureSessions)
          .where(
            and(
              eq(captureSessions.id, captureSessionId),
              eq(captureSessions.orgId, auth.orgId),
              eq(captureSessions.workspaceId, body.workspace_id),
              eq(captureSessions.processId, processId),
              inArray(captureSessions.captureType, [
                "operator_interview",
                "screen_recording_upload",
              ]),
            ),
          )
          .limit(1)
      )[0];
      if (!capture) {
        throw new ApiError(404, "not_found", "Operator capture not found.");
      }

      const maxRows = await tx.execute<{ max_ms: number | null }>(sql`
        SELECT GREATEST(
          COALESCE((
            SELECT MAX(end_ms)
            FROM transcript_segments
            WHERE org_id = ${auth.orgId}
              AND workspace_id = ${body.workspace_id}
              AND capture_session_id = ${captureSessionId}
          ), 0),
          COALESCE((
            SELECT MAX(ts_ms)
            FROM screen_events
            WHERE org_id = ${auth.orgId}
              AND workspace_id = ${body.workspace_id}
              AND capture_session_id = ${captureSessionId}
          ), 0)
        )::int AS max_ms
      `);
      const endMs = Math.max(maxRows.rows[0]?.max_ms ?? 0, body.last_seconds * 1000);
      const startMs = Math.max(0, endMs - body.last_seconds * 1000);

      const redaction = (
        await tx
          .insert(redactions)
          .values({
            orgId: auth.orgId,
            workspaceId: body.workspace_id,
            captureSessionId,
            startMs,
            endMs,
            requestedByUserId: auth.userId,
            reason: body.reason ?? "user_requested_last_window",
            status: "pending",
          })
          .returning()
      )[0];

      const transcriptRows = await tx
        .update(transcriptSegments)
        .set({ redactedAt: new Date(), updatedAt: new Date() })
        .where(sql`
          capture_session_id = ${captureSessionId}
          AND org_id = ${auth.orgId}
          AND workspace_id = ${body.workspace_id}
          AND redacted_at IS NULL
          AND start_ms <= ${endMs}
          AND end_ms >= ${startMs}
        `)
        .returning({ id: transcriptSegments.id });
      const screenRows = await tx
        .update(screenEvents)
        .set({
          redactedAt: new Date(),
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(sql`
          capture_session_id = ${captureSessionId}
          AND org_id = ${auth.orgId}
          AND workspace_id = ${body.workspace_id}
          AND redacted_at IS NULL
          AND ts_ms BETWEEN ${startMs} AND ${endMs}
        `)
        .returning({ id: screenEvents.id });

      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        eventType: "capture.operator.redacted",
        subjectType: "redaction",
        subjectId: redaction.id,
        metadataJson: {
          process_id: processId,
          capture_session_id: captureSessionId,
          start_ms: startMs,
          end_ms: endMs,
          transcript_segment_ids: transcriptRows.map((row) => row.id),
          screen_event_ids: screenRows.map((row) => row.id),
          status: "pending",
          idempotency_key: idempotencyKey,
        },
      });

      const response = {
        redaction,
        affected: {
          transcript_segments: transcriptRows.length,
          screen_events: screenRows.length,
        },
      };
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      return { body: response, statusCode: 201, shouldSendEvent: true };
    });

    const redactionId = (result.body as { redaction?: { id?: string } }).redaction?.id;
    if (result.shouldSendEvent && redactionId) {
      await inngest.send({
        name: operatorRedactionRequestedEventName,
        data: {
          orgId: auth.orgId,
          workspaceId: body.workspace_id,
          processId,
          captureSessionId,
          redactionId,
          userId: auth.userId,
          idempotencyKey,
        },
      });
    }

    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}
