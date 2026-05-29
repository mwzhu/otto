import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createOperatorRoomToken,
  OperatorVoiceConfigurationError,
  operatorVoiceReadiness,
} from "@/lib/adapters/livekit";
import { getDb, setOrgContext } from "@/lib/db/client";
import { auditLog, captureSessions } from "@/lib/db/schema";
import { ensureWorkspaceRole, requireAuth } from "@/lib/auth/session";
import {
  ApiError,
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import { getServerEnv, type ServerEnv } from "@/lib/env";
import {
  clearPendingIdempotentRequest,
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
    capture_session_id: z.string().uuid(),
  })
  .strict();

export async function GET(request: Request) {
  try {
    await requireAuth(request);
    return apiJson(operatorVoiceReadiness(getServerEnv()));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  let pendingIdempotency:
    | { orgId: string; key: string; route: string; requestHash: string }
    | null = null;
  try {
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director", "operator"]);
    const route = "POST /api/livekit/operator-room";

    const reserved = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const captureRows = await tx
        .select({
          id: captureSessions.id,
          processId: captureSessions.processId,
          captureMode: captureSessions.captureMode,
          completedAt: captureSessions.completedAt,
          metadataJson: captureSessions.metadataJson,
        })
        .from(captureSessions)
        .where(
          and(
            eq(captureSessions.id, body.capture_session_id),
            eq(captureSessions.orgId, auth.orgId),
            eq(captureSessions.workspaceId, body.workspace_id),
            eq(captureSessions.captureType, "operator_interview"),
          ),
        )
        .limit(1);
      const capture = captureRows[0];
      if (!capture) {
        throw new ApiError(404, "not_found", "Operator capture not found.");
      }
      if (!capture.processId) {
        throw new ApiError(
          409,
          "conflict",
          "Operator capture is not linked to a process.",
        );
      }
      if (capture.completedAt) {
        throw new ApiError(
          409,
          "conflict",
          "Operator capture is already completed.",
        );
      }
      if (
        capture.captureMode !== "operator_voice" &&
        capture.captureMode !== "operator_screenshare"
      ) {
        throw new ApiError(
          409,
          "conflict",
          "Operator capture is not a live voice capture.",
        );
      }
      if (!captureHasConsent(capture)) {
        throw new ApiError(
          403,
          "forbidden",
          "Operator capture consent must be acknowledged before starting the room.",
        );
      }
      const participantUserId = captureParticipantUserId(capture);
      if (participantUserId && participantUserId !== auth.userId) {
        throw new ApiError(
          403,
          "forbidden",
          "Only the operator who started this capture can join its voice room.",
        );
      }
      const captureWithParticipant =
        participantUserId === null
          ? await persistCaptureParticipantUserId(tx, capture, auth.userId)
          : capture;
      const cached = await reserveIdempotentRequest(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return {
          capture: captureWithParticipant,
          cached: {
            responseJson: cached.responseJson,
            statusCode: cached.statusCode,
          },
        };
      }
      pendingIdempotency = {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      };
      return { capture: captureWithParticipant, cached: null };
    });
    if (reserved.cached) {
      return apiJson(reserved.cached.responseJson, {
        status: reserved.cached.statusCode,
      });
    }

    const room = await createOperatorRoomToken({
      captureSessionId: body.capture_session_id,
      processId: reserved.capture.processId!,
      captureMode: reserved.capture.captureMode as
        | "operator_voice"
        | "operator_screenshare",
      participantIdentity:
        captureParticipantUserId(reserved.capture) ?? auth.userId,
      language: captureLanguage(reserved.capture),
    });

    const env = getServerEnv();
    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${body.capture_session_id}, 2)
        )
      `);
      const existingVendorExportAudit = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.orgId, auth.orgId),
            eq(auditLog.workspaceId, body.workspace_id),
            eq(auditLog.eventType, "capture.operator_voice.vendor_export"),
            eq(auditLog.subjectType, "capture_session"),
            eq(auditLog.subjectId, body.capture_session_id),
          ),
        )
        .limit(1);
      const metadataJson = {
        capture_session_id: body.capture_session_id,
        process_id: reserved.capture.processId,
        consent: operatorVoiceConsentAudit(reserved.capture),
        vendors: operatorVoiceVendors(room.mode),
        vendor_privacy_controls: operatorVoiceVendorPrivacyControls(
          room.mode,
          env,
        ),
        room_mode: room.mode,
        room: room.room,
        capture_mode: room.captureMode,
        participant_user_id: captureParticipantUserId(reserved.capture),
        agent_name: room.agentName ?? null,
        agent_participant_identity: room.agentParticipantIdentity ?? null,
        dispatch_id: room.dispatchId ?? null,
        audio_recording_default: "off",
        egress_recording_default: "off",
        data_channel_logging: "not_logged_by_livekit",
      };
      if (!existingVendorExportAudit[0]) {
        await tx.insert(auditLog).values({
          orgId: auth.orgId,
          workspaceId: body.workspace_id,
          userId: auth.userId,
          eventType: "capture.operator_voice.vendor_export",
          subjectType: "capture_session",
          subjectId: body.capture_session_id,
          metadataJson,
        });
      } else {
        await tx
          .update(auditLog)
          .set({
            metadataJson: sql`${auditLog.metadataJson} || ${JSON.stringify(
              metadataJson,
            )}::jsonb`,
          })
          .where(eq(auditLog.id, existingVendorExportAudit[0].id));
      }
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: room,
        statusCode: 200,
      });
    });
    pendingIdempotency = null;
    return apiJson(room);
  } catch (error) {
    if (pendingIdempotency) {
      await clearPending(pendingIdempotency);
    }
    if (error instanceof OperatorVoiceConfigurationError) {
      return apiError(
        new ApiError(
          503,
          "server_error",
          `${error.message} Disable strict operator preflight for local simulated mode, or configure the missing vendor credentials/privacy acknowledgement.`,
        ),
      );
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

function operatorVoiceVendors(roomMode: "simulated" | "livekit") {
  if (roomMode !== "livekit") return [];
  return ["livekit", "deepgram", "cartesia", "anthropic"];
}

function operatorVoiceVendorPrivacyControls(
  roomMode: "simulated" | "livekit",
  env: ServerEnv,
) {
  return {
    livekit_audio_recording_default: "off",
    livekit_egress_recording_default: "off",
    livekit_data_channel_logging: "not_logged_by_livekit",
    mode: roomMode,
    use_livekit_inference: env.OTTO_USE_LIVEKIT_INFERENCE === true,
    vendor_privacy_ack: env.OTTO_VENDOR_PRIVACY_ACK === true,
    deepgram_no_store_ack: env.OTTO_DEEPGRAM_NO_STORE_ACK === true,
    cartesia_no_retention_ack: env.OTTO_CARTESIA_NO_RETENTION_ACK === true,
    anthropic_raw_logging_off_ack:
      env.OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK === true,
  };
}

function operatorVoiceConsentAudit(capture: { metadataJson?: unknown }) {
  const metadata = captureMetadata(capture);
  return {
    consent_acknowledged: metadata?.consent_acknowledged === true,
    consent_text_version:
      typeof metadata?.consent_text_version === "string"
        ? metadata.consent_text_version
        : null,
    consent_acknowledged_at:
      typeof metadata?.consent_acknowledged_at === "string"
        ? metadata.consent_acknowledged_at
        : null,
  };
}

function captureHasConsent(capture: { metadataJson?: unknown }) {
  const metadata = captureMetadata(capture);
  return metadata?.consent_acknowledged === true;
}

function captureLanguage(capture: { metadataJson?: unknown }) {
  const metadata = captureMetadata(capture);
  if (typeof metadata?.language === "string" && metadata.language.trim()) {
    return metadata.language.trim();
  }
  return "en";
}

function captureParticipantUserId(capture: { metadataJson?: unknown }) {
  const metadata = captureMetadata(capture);
  if (
    typeof metadata?.participant_user_id === "string" &&
    metadata.participant_user_id.trim()
  ) {
    return metadata.participant_user_id.trim();
  }
  return null;
}

async function persistCaptureParticipantUserId<
  TCapture extends { id: string; metadataJson?: unknown },
>(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  capture: TCapture,
  userId: string,
) {
  const metadata = {
    ...(captureMetadata(capture) ?? {}),
    participant_user_id: userId,
  };
  await tx
    .update(captureSessions)
    .set({ metadataJson: metadata })
    .where(eq(captureSessions.id, capture.id));
  return { ...capture, metadataJson: metadata };
}

function captureMetadata(capture: { metadataJson?: unknown }) {
  const metadata = capture.metadataJson;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  return metadata as Record<string, unknown>;
}
