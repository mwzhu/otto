import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type LocalUploadMetadata = {
  key: string;
  contentType: string;
  sizeBytes: number;
  storedAt: string;
};

const uploadDir = join(process.cwd(), ".local-uploads");

export function localUploadUrl(key: string) {
  return `/api/dev/null-upload?key=${encodeURIComponent(key)}`;
}

export function localUploadKeyFromUrl(url?: string | null) {
  if (!url) return null;
  const parsed = new URL(url, "http://local.otto");
  if (parsed.pathname !== "/api/dev/null-upload") return null;
  return parsed.searchParams.get("key");
}

export async function writeLocalUpload(input: {
  key: string;
  bytes: ArrayBuffer;
  contentType: string;
}) {
  await mkdir(uploadDir, { recursive: true });
  const data = Buffer.from(input.bytes);
  await writeFile(localUploadDataPath(input.key), data);
  await writeFile(
    localUploadMetadataPath(input.key),
    JSON.stringify(
      {
        key: input.key,
        contentType: input.contentType,
        sizeBytes: data.byteLength,
        storedAt: new Date().toISOString(),
      } satisfies LocalUploadMetadata,
      null,
      2,
    ),
  );
}

export async function readLocalUpload(key: string) {
  const [bytes, metadataRaw] = await Promise.all([
    readFile(localUploadDataPath(key)),
    readFile(localUploadMetadataPath(key), "utf8"),
  ]);
  return {
    bytes,
    metadata: JSON.parse(metadataRaw) as LocalUploadMetadata,
  };
}

function localUploadDataPath(key: string) {
  return join(uploadDir, `${digestKey(key)}.bin`);
}

function localUploadMetadataPath(key: string) {
  return join(uploadDir, `${digestKey(key)}.json`);
}

function digestKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}
