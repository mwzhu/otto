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
      setBusy(true);
      setRow({ name: file.name, size: file.size, status: "uploading" });
      try {
        const artifactType = uploadKind === "screen_recording" ? "video" : "document";
        const presign = await postJson<{
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
        );
        const upload = await fetch(presign.upload_url, {
          method: "PUT",
          headers: { "content-type": file.type || fallbackMimeType(uploadKind) },
          body: file,
        });
        if (!upload.ok) {
          throw new Error(`Upload failed (${upload.status}).`);
        }
        setRow({ name: file.name, size: file.size, status: "binding" });
        await postJson(
          `/api/processes/${processId}/captures/uploads`,
          {
            workspace_id: workspaceId,
            artifact_id: presign.artifact.id,
            upload_kind: uploadKind,
          },
          `process-capture-complete-${processId}-${presign.artifact.id}`,
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
            : "Accepted formats include PDF, DOCX, PPTX, XLSX, and similar process documents."}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={uploadKind === "screen_recording" ? "video/*" : undefined}
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
