import "server-only";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getServerEnv, requireEnv } from "@/lib/env";
import { withRetry, type RetryOptions } from "@/lib/adapters/retry";
import { localUploadUrl } from "@/lib/adapters/local-upload";

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

export function storagePublicUrl(key: string) {
  if (shouldUseLocalUploadFallback()) {
    return localUploadUrl(key);
  }
  const base = requireEnv("R2_PUBLIC_BASE_URL").replace(/\/$/, "");
  return `${base}/${key}`;
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

function safeFilename(filename: string) {
  return filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 180) || "artifact";
}
