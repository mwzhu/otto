import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  receiveLiveKitWebhook,
  startOperatorTrackEgress,
} from "@/lib/adapters/livekit";
import { storagePublicUrl } from "@/lib/adapters/storage";
import { getDb, setOrgContext } from "@/lib/db/client";
import { getServiceDbPool } from "@/lib/db/service";
import { artifacts, auditLog, captureSessions } from "@/lib/db/schema";
import {
  inngest,
  operatorScreenRecordingUploadedEventName,
} from "@/lib/inngest/client";
import { apiError, apiJson } from "@/lib/http/json";
import { sanitizeJsonForLogs } from "@/lib/security/sanitize";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const event = await receiveLiveKitWebhook(request);
    if (event.event === "track_published") {
      return apiJson(await handleTrackPublished(event));
    }
    if (event.event === "egress_ended") {
      return apiJson(await handleEgressEnded(event));
    }
    return apiJson({ ok: true, ignored: event.event });
  } catch (error) {
    return apiError(error);
  }
}

async function handleTrackPublished(event: unknown) {
  const roomName = eventRoomName(event);
  const trackSid = eventTrackSid(event);
  const trackSource = eventTrackSource(event);
  const captureSessionId = captureSessionIdFromRoom(roomName);
  if (!roomName || !trackSid || !captureSessionId) {
    return { ok: false as const, reason: "missing_room_track_or_capture" };
  }
  if (!isScreenTrackSource(trackSource)) {
    return { ok: true as const, ignored: "non_screen_track", track_source: trackSource };
  }
  const lookup = await lookupCaptureById(captureSessionId);
  if (!lookup) {
    return { ok: false as const, reason: "capture_session_not_found_or_service_db_unavailable" };
  }

  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, lookup.org_id);
    const capture = (
      await tx
        .select()
        .from(captureSessions)
        .where(
          and(
            eq(captureSessions.id, captureSessionId),
            eq(captureSessions.orgId, lookup.org_id),
          ),
        )
        .limit(1)
    )[0];
    if (!capture || capture.captureMode !== "operator_screenshare") {
      return { ok: false as const, reason: "capture_session_not_found" };
    }
    await setOrgContext(tx, capture.orgId);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`operator.egress.track:${roomName}:${trackSid}:${captureSessionId}`}))
    `);
    const metadata = metadataObject(capture.metadataJson);
    if (typeof metadata.egress_id === "string" || capture.recordingStatus === "recording") {
      return {
        ok: true as const,
        alreadyStarted: true,
        egress_id: metadata.egress_id ?? null,
      };
    }
    const started = await startOperatorTrackEgress({
      roomName,
      screenTrackSid: trackSid,
      captureSessionId,
      orgId: capture.orgId,
      workspaceId: capture.workspaceId,
    });
    const nextMetadata = sanitizeJsonForLogs({
      ...metadata,
      egress_room_name: roomName,
      egress_track_sid: trackSid,
      egress_id: started.egressId,
      egress_storage_key: started.storageKey,
      egress_provider: started.provider,
      egress_start_reason: started.reason ?? null,
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
      eventType: "capture.operator.egress_start_requested",
      subjectType: "capture_session",
      subjectId: capture.id,
      metadataJson: nextMetadata,
    });
    return { ok: true as const, egress: started };
  });
}

async function handleEgressEnded(event: unknown) {
  const egressId = eventEgressId(event);
  if (!egressId) return { ok: false as const, reason: "missing_egress_id" };
  const capture = await lookupCaptureByEgressId(egressId);
  if (!capture || !capture.process_id) {
    return { ok: false as const, reason: "capture_session_not_found" };
  }
  const artifactId = randomUUID();
  const metadata = metadataObject(capture.metadata_json);
  const storageKey = stringValue(metadata.egress_storage_key);
  if (!storageKey) return { ok: false as const, reason: "missing_storage_key" };

  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, capture.org_id);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`operator.egress.ended:${egressId}`}))
    `);
    const existingAudit = (
      await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.orgId, capture.org_id),
            eq(auditLog.eventType, "capture.operator.egress_artifact_registered"),
            eq(auditLog.subjectType, "capture_session"),
            eq(auditLog.subjectId, capture.id),
          ),
        )
        .limit(1)
    )[0];
    if (existingAudit || capture.recording_artifact_id) {
      return { ok: true as const, alreadyRegistered: true, artifactId: capture.recording_artifact_id };
    }
    const artifact = (
      await tx
        .insert(artifacts)
        .values({
          id: artifactId,
          orgId: capture.org_id,
          workspaceId: capture.workspace_id,
          captureSessionId: capture.id,
          artifactType: "video",
          status: "ready",
          storageKey,
          storageUrl: storagePublicUrl(storageKey),
          filename: `operator-capture-${capture.id}.mp4`,
          mimeType: "video/mp4",
        })
        .returning()
    )[0];
    await tx
      .update(captureSessions)
      .set({
        recordingArtifactId: artifact.id,
        recordingStatus: "ready",
        recordingCompletedAt: new Date(),
        updatedAt: new Date(),
        metadataJson: sanitizeJsonForLogs({
          ...metadata,
          egress_ended_event: true,
          recording_artifact_id: artifact.id,
        }),
      })
      .where(eq(captureSessions.id, capture.id));
    await tx.insert(auditLog).values({
      orgId: capture.org_id,
      workspaceId: capture.workspace_id,
      eventType: "capture.operator.egress_artifact_registered",
      subjectType: "capture_session",
      subjectId: capture.id,
      metadataJson: {
        egress_id: egressId,
        artifact_id: artifact.id,
        storage_key: storageKey,
      },
    });
    return { ok: true as const, alreadyRegistered: false, artifactId: artifact.id };
  });

  if (result.ok && !result.alreadyRegistered && result.artifactId) {
    await inngest.send({
      name: operatorScreenRecordingUploadedEventName,
      data: {
        artifactId: result.artifactId,
        orgId: capture.org_id,
        workspaceId: capture.workspace_id,
        captureSessionId: capture.id,
        processId: capture.process_id,
        idempotencyKey: `livekit-egress:${egressId}`,
      },
    });
  }
  return result;
}

function captureSessionIdFromRoom(roomName: string | null) {
  return roomName?.startsWith("operator-") ? roomName.slice("operator-".length) : null;
}

function eventRoomName(event: unknown) {
  const record = metadataObject(event);
  const room = metadataObject(record.room);
  return stringValue(room.name) ?? stringValue(record.roomName);
}

function eventTrackSid(event: unknown) {
  const record = metadataObject(event);
  const track = metadataObject(record.track);
  return stringValue(track.sid) ?? stringValue(track.id) ?? stringValue(record.trackSid);
}

function eventTrackSource(event: unknown) {
  const record = metadataObject(event);
  const track = metadataObject(record.track);
  return stringValue(track.source) ?? stringValue(record.trackSource);
}

function eventEgressId(event: unknown) {
  const record = metadataObject(event);
  const egressInfo = metadataObject(record.egressInfo);
  return stringValue(egressInfo.egressId) ?? stringValue(record.egressId);
}

function isScreenTrackSource(source: string | null) {
  return Boolean(source && /screen/i.test(source));
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type WebhookCaptureLookup = {
  id: string;
  org_id: string;
  workspace_id: string;
  process_id: string | null;
  capture_mode?: string | null;
  metadata_json: Record<string, unknown>;
  recording_artifact_id: string | null;
};

async function lookupCaptureById(captureSessionId: string) {
  const servicePool = getServiceDbPool();
  if (!servicePool) return null;
  const rows = await servicePool.query<WebhookCaptureLookup>(
    `
      SELECT id, org_id, workspace_id, process_id, capture_mode::text,
        metadata_json, recording_artifact_id
      FROM capture_sessions
      WHERE id = $1
      LIMIT 1
    `,
    [captureSessionId],
  );
  return rows.rows[0] ?? null;
}

async function lookupCaptureByEgressId(egressId: string) {
  const servicePool = getServiceDbPool();
  if (!servicePool) return null;
  const rows = await servicePool.query<WebhookCaptureLookup>(
    `
      SELECT id, org_id, workspace_id, process_id, capture_mode::text,
        metadata_json, recording_artifact_id
      FROM capture_sessions
      WHERE metadata_json->>'egress_id' = $1
      LIMIT 1
    `,
    [egressId],
  );
  return rows.rows[0] ?? null;
}
