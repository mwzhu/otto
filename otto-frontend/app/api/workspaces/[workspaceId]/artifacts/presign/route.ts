import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { artifacts, auditLog } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import {
  artifactStorageKey,
  createPresignedArtifactUpload,
  storagePublicUrl,
} from "@/lib/adapters/storage";
import { validateDocumentUploadMetadata } from "@/lib/documents/validation";

export const runtime = "nodejs";

const bodySchema = z.object({
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  size_bytes: z.number().int().positive().optional(),
  artifact_type: z
    .enum(["document", "audio", "video", "screen_frame", "image", "other"])
    .default("document"),
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await ctx.params;
    const auth = await requireAuth(request);
    await ensureWorkspaceRole(auth, workspaceId, ["director", "operator"]);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const validatedUpload = validateDocumentUploadMetadata({
      filename: body.filename,
      mimeType: body.mime_type,
      sizeBytes: body.size_bytes,
      artifactType: body.artifact_type,
    });
    const route = "POST /api/workspaces/:workspaceId/artifacts/presign";
    const db = getDb();

    const result = await db.transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return { body: cached.responseJson, statusCode: cached.statusCode };
      }

      const artifactId = crypto.randomUUID();
      const key = artifactStorageKey({
        orgId: auth.orgId,
        workspaceId,
        artifactId,
        filename: body.filename,
      });
      const uploadUrl = await createPresignedArtifactUpload({
        key,
        contentType: validatedUpload.mimeType,
      });
      const artifact = (
        await tx
          .insert(artifacts)
          .values({
            id: artifactId,
            orgId: auth.orgId,
            workspaceId,
            uploadedByUserId: auth.userId,
            artifactType: body.artifact_type,
            status: "pending_upload",
            storageKey: key,
            storageUrl: storagePublicUrl(key),
            filename: body.filename,
            mimeType: validatedUpload.mimeType,
            sizeBytes: body.size_bytes,
          })
          .returning()
      )[0];
      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId,
        userId: auth.userId,
        eventType: "artifact.presign",
        subjectType: "artifact",
        subjectId: artifact.id,
        metadataJson: { idempotency_key: idempotencyKey },
      });
      const response = { artifact, upload_url: uploadUrl };
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
