"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

type UploadKind = "screen_recording" | "document";

type FileRow = {
  name: string;
  size: number;
  status: "idle" | "uploading" | "binding" | "done" | "failed";
  error?: string;
};

const MAX_DOCUMENT_UPLOAD_BYTES = 50 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = [
  ".txt",
  ".text",
  ".log",
  ".json",
  ".yaml",
  ".yml",
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
];
const DOCUMENT_MIME_TYPES = [
  "text/plain",
  "application/json",
  "text/yaml",
  "application/yaml",
  "application/x-yaml",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".webm"];
const VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
];

export function ProcessCaptureUploadClient({
  workspaceId,
  processId,
  uploadKind,
}: {
  workspaceId: string;
  processId: string;
  uploadKind: UploadKind;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [row, setRow] = useState<FileRow | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFiles = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file || busy) return;
      const validationError = validateProcessUploadFile(file, uploadKind);
      if (validationError) {
        setRow({
          name: file.name,
          size: file.size,
          status: "failed",
          error: validationError,
        });
        return;
      }
      setBusy(true);
      setRow({ name: file.name, size: file.size, status: "uploading" });
      try {
        const artifactType = uploadKind === "screen_recording" ? "video" : "document";
        const presign = await withUploadStep(
          "Preparing upload",
          () =>
            postJson<{
              artifact: { id: string };
              upload_url: string;
            }>(
              `/api/workspaces/${workspaceId}/artifacts/presign`,
              {
                filename: file.name,
                mime_type: file.type || fallbackMimeType(uploadKind),
                size_bytes: file.size,
                artifact_type: artifactType,
              },
              `process-capture-presign-${processId}-${file.name}-${file.size}`,
            ),
        );
        await withUploadStep("Uploading file", async () => {
          const upload = await fetch(presign.upload_url, {
            method: "PUT",
            headers: { "content-type": file.type || fallbackMimeType(uploadKind) },
            body: file,
          });
          if (!upload.ok) {
            throw new Error(`storage upload failed (${upload.status})`);
          }
        });
        setRow({ name: file.name, size: file.size, status: "binding" });
        await withUploadStep(
          "Creating capture",
          () =>
            postJson(
              `/api/processes/${processId}/captures/uploads`,
              {
                workspace_id: workspaceId,
                artifact_id: presign.artifact.id,
                upload_kind: uploadKind,
              },
              `process-capture-complete-${processId}-${presign.artifact.id}`,
            ),
        );
        setRow({ name: file.name, size: file.size, status: "done" });
      } catch (error) {
        setRow({
          name: file.name,
          size: file.size,
          status: "failed",
          error: error instanceof Error ? error.message : "Upload failed.",
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, processId, uploadKind, workspaceId],
  );

  const done = row?.status === "done";

  return (
    <div className="mx-auto max-w-[720px] space-y-6">
      <section
        onDragOver={(event) => {
          event.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDrag(false);
          void handleFiles(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          "grid place-items-center rounded-lg border-2 border-dashed bg-surface px-8 py-12 text-center transition",
          drag ? "border-ink bg-muted" : "border-subtle",
        )}
      >
        <UploadCloud size={42} className="text-ink-secondary" aria-hidden />
        <p className="mt-4 text-[14px] font-medium text-ink">
          Drop {uploadKind === "screen_recording" ? "a screen recording" : "an SOP"} here
        </p>
        <p className="mt-1 max-w-[420px] text-[12px] leading-relaxed text-ink-muted">
          {uploadKind === "screen_recording"
            ? "Accepted formats include MP4, QuickTime, and WebM."
            : "Accepted formats include SOPs, structured files, and similar process documents."}
        </p>
        <input
          key={`${uploadKind}-upload-file-input-v2`}
          ref={inputRef}
          type="file"
          accept={acceptedFileTypes(uploadKind)}
          className="hidden"
          onChange={(event) => void handleFiles(Array.from(event.target.files ?? []))}
        />
        <Button
          type="button"
          variant="secondary"
          className="mt-4"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" aria-hidden />
              Uploading
            </>
          ) : (
            "Browse files"
          )}
        </Button>
      </section>

      {row && (
        <section className="rounded-lg border border-subtle bg-surface px-4 py-3">
          <div className="flex items-center justify-between gap-4 text-[12.5px]">
            <div className="min-w-0 truncate font-medium text-ink">{row.name}</div>
            <div className="shrink-0 text-ink-muted">
              {row.error ?? statusLabel(row.status)} · {formatSize(row.size)}
            </div>
          </div>
        </section>
      )}

      {done && (
        <div className="flex justify-end">
          <Button
            type="button"
            onClick={() =>
              router.push(
                `/synthesis?next=${encodeURIComponent(
                  `/process/${processId}/workspace`,
                )}&workspace_id=${encodeURIComponent(workspaceId)}`,
              )
            }
          >
            Continue to synthesis
          </Button>
        </div>
      )}
    </div>
  );
}

function fallbackMimeType(uploadKind: UploadKind) {
  return uploadKind === "screen_recording"
    ? "video/mp4"
    : "application/octet-stream";
}

function acceptedFileTypes(uploadKind: UploadKind) {
  return uploadKind === "screen_recording"
    ? [...VIDEO_EXTENSIONS, ...VIDEO_MIME_TYPES].join(",")
    : "*/*";
}

function validateProcessUploadFile(file: File, uploadKind: UploadKind) {
  if (file.size === 0) {
    return "Unsupported file: empty files cannot be uploaded.";
  }
  if (uploadKind === "document" && file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
    return "Unsupported file: process documents must be 50 MB or smaller.";
  }
  if (!isAcceptedProcessUploadFile(file, uploadKind)) {
    return uploadKind === "screen_recording"
      ? "Unsupported file type. Upload an MP4, QuickTime, or WebM screen recording."
      : "Unsupported file type. Upload a supported SOP, structured file, or process document.";
  }
  return null;
}

function isAcceptedProcessUploadFile(file: File, uploadKind: UploadKind) {
  const normalizedName = file.name.toLowerCase();
  const mimeTypes =
    uploadKind === "screen_recording" ? VIDEO_MIME_TYPES : DOCUMENT_MIME_TYPES;
  const extensions =
    uploadKind === "screen_recording" ? VIDEO_EXTENSIONS : DOCUMENT_EXTENSIONS;
  if (mimeTypes.includes(file.type)) return true;
  return extensions.some((extension) => normalizedName.endsWith(extension));
}

async function withUploadStep<T>(
  step: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed.";
    throw new Error(`${step}: ${message}`);
  }
}

function statusLabel(status: FileRow["status"]) {
  switch (status) {
    case "uploading":
      return "Uploading";
    case "binding":
      return "Creating capture";
    case "done":
      return "Ready";
    case "failed":
      return "Failed";
    default:
      return "Queued";
  }
}

function formatSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

async function postJson<T>(url: string, body: unknown, idempotencyKey: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
  }
  return payload as T;
}
