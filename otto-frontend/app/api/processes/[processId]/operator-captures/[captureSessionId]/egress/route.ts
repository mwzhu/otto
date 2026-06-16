import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { startOperatorTrackEgress } from "@/lib/adapters/livekit";
import { ensureWorkspaceRole, requireAuth } from "@/lib/auth/session";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import { auditLog, captureSessions } from "@/lib/db/schema";
import {
  ApiError,
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import { sanitizeJsonForLogs } from "@/lib/security/sanitize";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
    room: z.string().min(1),
    screen_track_sid: z.string().min(1),
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
      "POST /api/processes/:processId/operator-captures/:captureSessionId/egress";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`operator.egress.track:${body.room}:${body.screen_track_sid}:${captureSessionId}`}))
      `);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return { body: cached.responseJson, statusCode: cached.statusCode };
      }

      const capture = (
        await tx
          .select()
          .from(captureSessions)
          .where(
            and(
              eq(captureSessions.id, captureSessionId),
              eq(captureSessions.orgId, auth.orgId),
              eq(captureSessions.workspaceId, body.workspace_id),
              eq(captureSessions.processId, processId),
              eq(captureSessions.captureType, "operator_interview"),
              eq(captureSessions.captureMode, "operator_screenshare"),
            ),
          )
          .limit(1)
      )[0];
      if (!capture) {
        throw new ApiError(404, "not_found", "Operator screenshare capture not found.");
      }
      if (capture.completedAt) {
        throw new ApiError(409, "conflict", "Operator capture is already completed.");
      }

      const metadata = metadataObject(capture.metadataJson);
      if (typeof metadata.egress_id === "string" || capture.recordingStatus === "recording") {
        const response = {
          ok: true,
          already_started: true,
          egress: {
            mode: "started",
            egressId: metadata.egress_id ?? null,
            storageKey: metadata.egress_storage_key ?? null,
            provider: metadata.egress_provider ?? "livekit-track-composite",
          },
        };
        await storeIdempotentResponse(tx, {
          orgId: auth.orgId,
          key: idempotencyKey,
          route,
          requestHash: hash,
          responseJson: response,
          statusCode: 200,
        });
        return { body: response, statusCode: 200 };
      }

      const started = await startOperatorTrackEgress({
        roomName: body.room,
        screenTrackSid: body.screen_track_sid,
        captureSessionId,
        orgId: capture.orgId,
        workspaceId: capture.workspaceId,
      });
      const nextMetadata = sanitizeJsonForLogs({
        ...metadata,
        egress_room_name: body.room,
        egress_track_sid: body.screen_track_sid,
        egress_id: started.egressId,
        egress_storage_key: started.storageKey,
        egress_provider: started.provider,
        egress_start_reason: started.reason ?? null,
        egress_start_source: "browser_track_publication",
      });
      await tx
        .update(captureSessions)
        .set({
          recordingStatus: started.mode === "started" ? "recording" : "degraded",
          recordingProvider: started.provider,
          recordingStartedAt: started.mode === "started" ? new Date() : null,
          metadataJson: nextMetadata,
          updatedAt: new Date(),
        })
        .where(and(eq(captureSessions.id, capture.id), eq(captureSessions.orgId, capture.orgId)));
      await tx.insert(auditLog).values({
        orgId: capture.orgId,
        workspaceId: capture.workspaceId,
        userId: auth.userId,
        eventType: "capture.operator.egress_start_requested",
        subjectType: "capture_session",
        subjectId: capture.id,
        metadataJson: nextMetadata,
      });

      const response = { ok: true, already_started: false, egress: started };
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      return { body: response, statusCode: 201 };
    });

    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
