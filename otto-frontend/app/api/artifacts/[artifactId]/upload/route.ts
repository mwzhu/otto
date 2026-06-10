import { and, eq } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { artifacts, auditLog } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import { uploadArtifactObject } from "@/lib/adapters/storage";
import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  MAX_SCREEN_RECORDING_UPLOAD_BYTES,
} from "@/lib/documents/validation";
import { ApiError, apiError, apiJson } from "@/lib/http/json";

export const runtime = "nodejs";

const MAX_PROXY_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ artifactId: string }> },
) {
  try {
    const { artifactId } = await ctx.params;
    const auth = await requireAuth(request);
    const db = getDb();
    const artifact = await db.transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      return (
        await tx
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.id, artifactId), eq(artifacts.orgId, auth.orgId)))
          .limit(1)
      )[0];
    });
    if (!artifact) {
      throw new ApiError(404, "not_found", "Artifact not found.");
    }
    await ensureWorkspaceRole(auth, artifact.workspaceId, ["director", "operator"]);
    if (artifact.status !== "pending_upload") {
      throw new ApiError(409, "conflict", "Artifact upload has already completed.");
    }

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    const maxBytes = maxUploadBytes(artifact.artifactType);
    if (contentLength > maxBytes) {
      throw uploadTooLargeError(artifact.artifactType, maxBytes);
    }

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      throw uploadTooLargeError(artifact.artifactType, maxBytes);
    }
    if (artifact.sizeBytes && bytes.byteLength > artifact.sizeBytes) {
      throw new ApiError(
        400,
        "bad_request",
        "Uploaded file is larger than the requested artifact size.",
      );
    }

    const contentType =
      request.headers.get("content-type") ?? artifact.mimeType ?? "application/octet-stream";
    const uploaded = await uploadArtifactObject({
      key: artifact.storageKey,
      bytes,
      contentType,
    });

    await db.transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx
        .update(artifacts)
        .set({
          storageUrl: uploaded.url,
          sizeBytes: bytes.byteLength,
          updatedAt: new Date(),
        })
        .where(and(eq(artifacts.id, artifact.id), eq(artifacts.orgId, auth.orgId)));
      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: artifact.workspaceId,
        userId: auth.userId,
        eventType: "artifact.upload",
        subjectType: "artifact",
        subjectId: artifact.id,
        metadataJson: {
          storage: uploaded.storage,
          size_bytes: uploaded.sizeBytes,
        },
      });
    });

    return apiJson({ ok: true, artifact_id: artifact.id, storage: uploaded.storage });
  } catch (error) {
    return apiError(error);
  }
}

function maxUploadBytes(artifactType: string) {
  if (artifactType === "video") return MAX_SCREEN_RECORDING_UPLOAD_BYTES;
  if (artifactType === "document") return MAX_DOCUMENT_UPLOAD_BYTES;
  return MAX_PROXY_UPLOAD_BYTES;
}

function uploadTooLargeError(artifactType: string, maxBytes: number) {
  const label =
    artifactType === "video"
      ? "Screen recording"
      : artifactType === "document"
        ? "Document"
        : "File";
  return new ApiError(
    413,
    "bad_request",
    `${label} is too large. Maximum supported size is ${Math.round(
      maxBytes / 1024 / 1024,
    )}MB.`,
  );
}
