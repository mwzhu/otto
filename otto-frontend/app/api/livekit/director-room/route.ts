import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createDirectorRoomToken,
  DirectorVoiceConfigurationError,
  directorVoiceReadiness,
} from "@/lib/adapters/livekit";
import { getDb, setOrgContext } from "@/lib/db/client";
import { auditLog, captureSessions } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
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

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  capture_session_id: z.string().uuid(),
}).strict();

export async function GET(request: Request) {
  try {
    await requireAuth(request);
    return apiJson(directorVoiceReadiness(getServerEnv()));
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
    await ensureWorkspaceRole(auth, body.workspace_id, ["director"]);
    const route = "POST /api/livekit/director-room";

    const reserved = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const captureRows = await tx
        .select({
          id: captureSessions.id,
          completedAt: captureSessions.completedAt,
          metadataJson: captureSessions.metadataJson,
        })
        .from(captureSessions)
        .where(
          and(
            eq(captureSessions.id, body.capture_session_id),
            eq(captureSessions.orgId, auth.orgId),
            eq(captureSessions.workspaceId, body.workspace_id),
            eq(captureSessions.captureType, "director_interview"),
          ),
        )
        .limit(1);
      if (!captureRows[0]) {
        throw new ApiError(404, "not_found", "Director interview not found.");
      }
      if (captureRows[0].completedAt) {
        throw new ApiError(
          409,
          "conflict",
          "Director interview is already completed.",
        );
      }
      if (!captureHasConsent(captureRows[0])) {
        throw new ApiError(
          403,
          "forbidden",
          "Director interview voice consent must be acknowledged before starting the room.",
        );
      }
      const directorUserId = captureDirectorUserId(captureRows[0]);
      if (directorUserId && directorUserId !== auth.userId) {
        throw new ApiError(
          403,
          "forbidden",
          "Only the director who started this interview can join its voice room.",
        );
      }
      const capture =
        directorUserId === null
          ? await persistCaptureDirectorUserId(tx, captureRows[0], auth.userId)
          : captureRows[0];
      const cached = await reserveIdempotentRequest(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return {
          capture,
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
      return { capture, cached: null };
    });
    if (reserved.cached) {
      return apiJson(reserved.cached.responseJson, {
        status: reserved.cached.statusCode,
      });
    }

    const room = await createDirectorRoomToken({
      captureSessionId: body.capture_session_id,
      participantIdentity: captureDirectorUserId(reserved.capture) ?? auth.userId,
      language: captureLanguage(reserved.capture),
    });
    const env = getServerEnv();
    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${body.capture_session_id}, 1)
        )
      `);
      const existingVendorExportAudit = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.orgId, auth.orgId),
            eq(auditLog.workspaceId, body.workspace_id),
            eq(auditLog.eventType, "capture.director_voice.vendor_export"),
            eq(auditLog.subjectType, "capture_session"),
            eq(auditLog.subjectId, body.capture_session_id),
          ),
        )
        .limit(1);
      const auditIdentityMetadata = {
        room_mode: room.mode,
        room: room.room,
        director_user_id: captureDirectorUserId(reserved.capture),
        agent_name: room.agentName ?? null,
        agent_participant_identity: room.agentParticipantIdentity ?? null,
        dispatch_id: room.dispatchId ?? null,
      };
      const retentionPolicy = directorVoiceRetentionPolicy(reserved.capture);
      const vendorPrivacyControls = directorVoiceVendorPrivacyControls(
        room.mode,
        env,
      );
      if (!existingVendorExportAudit[0]) {
        await tx.insert(auditLog).values({
          orgId: auth.orgId,
          workspaceId: body.workspace_id,
          userId: auth.userId,
          eventType: "capture.director_voice.vendor_export",
          subjectType: "capture_session",
          subjectId: body.capture_session_id,
          metadataJson: {
            capture_session_id: body.capture_session_id,
            consent: directorVoiceConsentAudit(reserved.capture),
            vendors: directorVoiceVendors(room.mode),
            vendor_privacy_controls: vendorPrivacyControls,
            retention_policy: retentionPolicy,
            ...auditIdentityMetadata,
            audio_recording_default: "off",
            egress_recording_default: "off",
            data_channel_logging: "not_logged_by_livekit",
          },
        });
      } else {
        await tx
          .update(auditLog)
          .set({
            metadataJson: sql`${auditLog.metadataJson} || ${JSON.stringify(
              {
                ...auditIdentityMetadata,
                vendor_privacy_controls: vendorPrivacyControls,
                retention_policy: retentionPolicy,
              },
            )}::jsonb`,
          })
          .where(eq(auditLog.id, existingVendorExportAudit[0].id));
      }
      if (retentionPolicy.audio_recording_enabled) {
        const existingRetentionAudit = await tx
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.orgId, auth.orgId),
              eq(auditLog.workspaceId, body.workspace_id),
              eq(auditLog.eventType, "capture.director_voice.audio_retention_enabled"),
              eq(auditLog.subjectType, "capture_session"),
              eq(auditLog.subjectId, body.capture_session_id),
            ),
          )
          .limit(1);
        if (!existingRetentionAudit[0]) {
          await tx.insert(auditLog).values({
            orgId: auth.orgId,
            workspaceId: body.workspace_id,
            userId: auth.userId,
            eventType: "capture.director_voice.audio_retention_enabled",
            subjectType: "capture_session",
            subjectId: body.capture_session_id,
            metadataJson: {
              capture_session_id: body.capture_session_id,
              retention_policy: retentionPolicy,
            },
          });
        }
      }
      if (retentionPolicy.raw_payload_logging_enabled) {
        const existingRawPayloadAudit = await tx
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.orgId, auth.orgId),
              eq(auditLog.workspaceId, body.workspace_id),
              eq(auditLog.eventType, "capture.director_voice.raw_payload_logging_enabled"),
              eq(auditLog.subjectType, "capture_session"),
              eq(auditLog.subjectId, body.capture_session_id),
            ),
          )
          .limit(1);
        if (!existingRawPayloadAudit[0]) {
          await tx.insert(auditLog).values({
            orgId: auth.orgId,
            workspaceId: body.workspace_id,
            userId: auth.userId,
            eventType: "capture.director_voice.raw_payload_logging_enabled",
            subjectType: "capture_session",
            subjectId: body.capture_session_id,
            metadataJson: {
              capture_session_id: body.capture_session_id,
              retention_policy: retentionPolicy,
            },
          });
        }
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
    if (error instanceof DirectorVoiceConfigurationError) {
      return apiError(
        new ApiError(
          503,
          "server_error",
          `${error.message} Disable strict preflight for local simulated mode, or configure the missing vendor credentials/privacy acknowledgement.`,
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

function directorVoiceVendors(roomMode: "simulated" | "livekit") {
  if (roomMode !== "livekit") return [];
  return ["livekit", "deepgram", "cartesia", "anthropic"];
}

function directorVoiceVendorPrivacyControls(
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

function directorVoiceConsentAudit(capture: { metadataJson?: unknown }) {
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

function directorVoiceRetentionPolicy(capture: { metadataJson?: unknown }) {
  const metadata = captureMetadata(capture);
  const audioRetentionEnabled = metadata?.audio_retention_enabled === true;
  const rawPayloadLoggingEnabled =
    metadata?.raw_payload_logging_enabled === true;
  return {
    audio_recording_enabled: audioRetentionEnabled,
    audio_recording_default:
      typeof metadata?.audio_recording_default === "string"
        ? metadata.audio_recording_default
        : "off",
    audio_retention_days: audioRetentionEnabled
      ? numberMetadata(metadata, "audio_retention_days") ?? 30
      : null,
    raw_payload_logging: rawPayloadLoggingEnabled
      ? "debug_window_enabled"
      : "off",
    raw_payload_logging_enabled: rawPayloadLoggingEnabled,
    raw_payload_logging_expires_at:
      rawPayloadLoggingEnabled &&
      typeof metadata?.raw_payload_logging_expires_at === "string"
        ? metadata.raw_payload_logging_expires_at
        : null,
  };
}

function captureHasConsent(capture: { metadataJson?: unknown }) {
  const metadata = captureMetadata(capture);
  if (!metadata) return false;
  return "consent_acknowledged" in metadata && metadata.consent_acknowledged === true;
}

function captureLanguage(capture: { metadataJson?: unknown }) {
  const metadata = captureMetadata(capture);
  if (!metadata) return "en";
  if (
    "language" in metadata &&
    typeof metadata.language === "string" &&
    metadata.language.trim()
  ) {
    return metadata.language.trim();
  }
  return "en";
}

function captureDirectorUserId(capture: { metadataJson?: unknown }) {
  const metadata = captureMetadata(capture);
  if (
    metadata &&
    typeof metadata.director_user_id === "string" &&
    metadata.director_user_id.trim()
  ) {
    return metadata.director_user_id.trim();
  }
  return null;
}

async function persistCaptureDirectorUserId(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  capture: { id: string; metadataJson?: unknown },
  userId: string,
) {
  const metadata = {
    ...(captureMetadata(capture) ?? {}),
    director_user_id: userId,
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

function numberMetadata(metadata: Record<string, unknown> | null, key: string) {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
