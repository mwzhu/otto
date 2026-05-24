import { getServerEnv } from "@/lib/env";
import { ApiError, apiError, apiJson } from "@/lib/http/json";
import { readLocalUpload, writeLocalUpload } from "@/lib/adapters/local-upload";
import { MAX_DOCUMENT_UPLOAD_BYTES } from "@/lib/documents/validation";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  try {
    assertDevOnly();
    const key = requiredKey(request);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_DOCUMENT_UPLOAD_BYTES) {
      throw new ApiError(413, "bad_request", "Document is too large.");
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_DOCUMENT_UPLOAD_BYTES) {
      throw new ApiError(413, "bad_request", "Document is too large.");
    }
    await writeLocalUpload({
      key,
      bytes,
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
    });
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
