import "server-only";

import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getServerEnv, requireEnv } from "@/lib/env";
import { withRetry, type RetryOptions } from "@/lib/adapters/retry";
import {
  deleteLocalUpload,
  localUploadUrl,
  writeLocalUpload,
} from "@/lib/adapters/local-upload";

let s3: S3Client | null = null;

export type ArtifactStorageKeyInput = {
  orgId: string;
  workspaceId: string;
  artifactId: string;
  filename: string;
};

export function artifactStorageKey(input: ArtifactStorageKeyInput) {
  return [
    "org",
    input.orgId,
    "workspace",
    input.workspaceId,
    "artifacts",
    input.artifactId,
    safeFilename(input.filename),
  ].join("/");
}

export async function createPresignedArtifactUpload(input: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
  retry?: RetryOptions;
}) {
  if (shouldUseLocalUploadFallback()) {
    return localUploadUrl(input.key);
  }
  return withRetry(async () => {
    const command = new PutObjectCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Key: input.key,
      ContentType: input.contentType,
    });
    return getSignedUrl(getS3(), command, {
      expiresIn: input.expiresInSeconds ?? 900,
    });
  }, input.retry);
}

export async function uploadArtifactObject(input: {
  key: string;
  bytes: Buffer | ArrayBuffer | Uint8Array;
  contentType: string;
  retry?: RetryOptions;
}) {
  const bytes = toArrayBuffer(input.bytes);
  if (shouldUseLocalUploadFallback()) {
    await writeLocalUpload({
      key: input.key,
      bytes,
      contentType: input.contentType,
    });
    return {
      ok: true as const,
      storage: "local" as const,
      url: localUploadUrl(input.key),
      sizeBytes: bytes.byteLength,
    };
  }
  await withRetry(async () => {
    await getS3().send(
      new PutObjectCommand({
        Bucket: requireEnv("R2_BUCKET"),
        Key: input.key,
        Body: Buffer.from(bytes),
        ContentType: input.contentType,
      }),
    );
  }, input.retry);
  return {
    ok: true as const,
    storage: "r2" as const,
    url: storagePublicUrl(input.key),
    sizeBytes: bytes.byteLength,
  };
}

export function storagePublicUrl(key: string) {
  if (shouldUseLocalUploadFallback()) {
    return localUploadUrl(key);
  }
  const base = requireEnv("R2_PUBLIC_BASE_URL").replace(/\/$/, "");
  return `${base}/${key}`;
}

export function r2S3UploadConfig() {
  if (!hasR2Config()) return null;
  const accountId = requireEnv("R2_ACCOUNT_ID");
  return {
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucket: requireEnv("R2_BUCKET"),
    accessKey: requireEnv("R2_ACCESS_KEY_ID"),
    secret: requireEnv("R2_SECRET_ACCESS_KEY"),
    region: "auto",
    forcePathStyle: true,
  };
}

export async function deleteArtifactObject(input: {
  key: string;
  retry?: RetryOptions;
}) {
  if (shouldUseLocalUploadFallback()) {
    await deleteLocalUpload(input.key);
    return { ok: true as const, storage: "local" as const };
  }
  await withRetry(async () => {
    await getS3().send(
      new DeleteObjectCommand({
        Bucket: requireEnv("R2_BUCKET"),
        Key: input.key,
      }),
    );
  }, input.retry);
  return { ok: true as const, storage: "r2" as const };
}

function getS3() {
  if (!s3) {
    const accountId = requireEnv("R2_ACCOUNT_ID");
    s3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return s3;
}

function hasR2Config() {
  const env = getServerEnv();
  return Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.R2_BUCKET &&
      env.R2_PUBLIC_BASE_URL,
  );
}

function shouldUseLocalUploadFallback() {
  const env = getServerEnv();
  return !hasR2Config() && env.NODE_ENV !== "production";
}

function toArrayBuffer(bytes: Buffer | ArrayBuffer | Uint8Array) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return copy.buffer;
  }
  return bytes;
}

function safeFilename(filename: string) {
  return filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 180) || "artifact";
}
