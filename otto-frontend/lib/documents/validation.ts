import "server-only";

import { getServerEnv } from "@/lib/env";
import { ApiError } from "@/lib/http/json";

export const MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024;

const supportedDocumentTypes = new Map<string, string[]>([
  ["text/plain", [".txt", ".text", ".log"]],
  ["text/markdown", [".md", ".markdown"]],
  ["text/csv", [".csv"]],
  ["application/json", [".json"]],
  ["application/pdf", [".pdf"]],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    [".docx"],
  ],
  ["application/msword", [".doc"]],
]);

const mimeByExtension = new Map(
  Array.from(supportedDocumentTypes.entries()).flatMap(([mimeType, extensions]) =>
    extensions.map((extension) => [extension, mimeType] as const),
  ),
);

export function validateDocumentUploadMetadata(input: {
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  artifactType: string;
}) {
  if (input.artifactType === "document" && !input.sizeBytes) {
    throw new ApiError(400, "bad_request", "Document size is required.");
  }
  if (input.sizeBytes && input.sizeBytes > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new ApiError(
      400,
      "bad_request",
      `Document is too large. Maximum supported size is ${Math.round(
        MAX_DOCUMENT_UPLOAD_BYTES / 1024 / 1024,
      )}MB.`,
    );
  }
  if (input.artifactType !== "document") {
    return { mimeType: input.mimeType };
  }

  const extension = extensionOf(input.filename);
  const inferredMimeType = extension ? mimeByExtension.get(extension) : undefined;
  const rawMimeType = input.mimeType.toLowerCase();
  const mimeType =
    isFuzzyUnknownMimeType(rawMimeType) && inferredMimeType
      ? inferredMimeType
      : rawMimeType;

  if (!supportedDocumentTypes.has(mimeType)) {
    throw new ApiError(
      400,
      "bad_request",
      `Unsupported document type: ${input.mimeType}.`,
    );
  }
  const allowedExtensions = supportedDocumentTypes.get(mimeType) ?? [];
  if (extension && !allowedExtensions.includes(extension)) {
    throw new ApiError(
      400,
      "bad_request",
      `File extension ${extension} does not match ${mimeType}.`,
    );
  }
  const env = getServerEnv();
  const hasParser = Boolean(env.LLAMAPARSE_API_KEY || env.UNSTRUCTURED_API_KEY);
  const hasPublicStorage = Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.R2_BUCKET &&
      env.R2_PUBLIC_BASE_URL,
  );
  if (!isLocallyTextParsable(mimeType) && (!hasParser || !hasPublicStorage)) {
    throw new ApiError(
      400,
      "bad_request",
      `${mimeType} requires configured document parsing and public artifact storage. Use TXT, Markdown, CSV, or JSON for local dev without vendor storage.`,
    );
  }
  return { mimeType };
}

export function isLocallyTextParsable(mimeType: string) {
  return [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
  ].includes(mimeType.toLowerCase());
}

function extensionOf(filename: string) {
  const match = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0];
}

function isFuzzyUnknownMimeType(mimeType: string) {
  return [
    "",
    "application/octet-stream",
    "application/x-zip-compressed",
    "binary/octet-stream",
  ].includes(mimeType);
}
