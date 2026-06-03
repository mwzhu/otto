import { getServerEnv } from "@/lib/env";
import { ApiError, apiError, apiJson } from "@/lib/http/json";
import {
  readLocalUpload,
  writeLocalUpload,
  writeLocalUploadStream,
} from "@/lib/adapters/local-upload";
import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  MAX_SCREEN_RECORDING_UPLOAD_BYTES,
} from "@/lib/documents/validation";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  try {
    assertDevOnly();
    const key = requiredKey(request);
    const contentType =
      request.headers.get("content-type") ?? "application/octet-stream";
    const maxBytes = maxLocalUploadBytes(contentType);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) {
      throw tooLargeError(contentType);
    }
    if (request.body) {
      try {
        await writeLocalUploadStream({
          key,
          stream: request.body,
          contentType,
          maxBytes,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "local_upload_size_limit_exceeded") {
          throw tooLargeError(contentType);
        }
        throw error;
      }
    } else {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > maxBytes) {
        throw tooLargeError(contentType);
      }
      await writeLocalUpload({
        key,
        bytes,
        contentType,
      });
    }
    return apiJson({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

export async function GET(request: Request) {
  try {
    assertDevOnly();
    const key = requiredKey(request);
    const upload = await readLocalUpload(key);
    return new Response(upload.bytes, {
      headers: {
        "content-type": upload.metadata.contentType,
        "content-length": String(upload.metadata.sizeBytes),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

function requiredKey(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) throw new ApiError(400, "bad_request", "Missing upload key.");
  return key;
}

function assertDevOnly() {
  const env = getServerEnv();
  if (env.NODE_ENV === "production") {
    throw new ApiError(404, "not_found", "Not found.");
  }
}

function maxLocalUploadBytes(contentType: string) {
  return contentType.toLowerCase().startsWith("video/")
    ? MAX_SCREEN_RECORDING_UPLOAD_BYTES
    : MAX_DOCUMENT_UPLOAD_BYTES;
}

function tooLargeError(contentType: string) {
  if (contentType.toLowerCase().startsWith("video/")) {
    return new ApiError(
      413,
      "bad_request",
      `Screen recording is too large. Maximum supported size is ${Math.round(
        MAX_SCREEN_RECORDING_UPLOAD_BYTES / 1024 / 1024,
      )}MB.`,
    );
  }
  return new ApiError(
    413,
    "bad_request",
    `Document is too large. Maximum supported size is ${Math.round(
      MAX_DOCUMENT_UPLOAD_BYTES / 1024 / 1024,
    )}MB.`,
  );
}
