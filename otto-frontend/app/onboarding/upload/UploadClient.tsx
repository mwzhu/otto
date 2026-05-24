"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { GradientMark } from "@/components/brand/GradientMark";
import { cn } from "@/lib/cn";

type Status = "queued" | "extracting" | "ontology" | "done";

type FileRow = {
  id: string;
  name: string;
  size: number;
  status: Status;
  progress: number;
  error?: string;
};

const STAGE_LABEL: Record<Status, string> = {
  queued: "Queued",
  extracting: "Extracting claims",
  ontology: "Normalizing ontology",
  done: "Done",
};

export function UploadClient() {
  const router = useRouter();
  const [drag, setDrag] = useState(false);
  const [files, setFiles] = useState<FileRow[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((fl: File[]) => {
    const rows: FileRow[] = fl.map((f) => ({
      id: `${f.name}-${f.size}-${Math.random().toString(16).slice(2, 6)}`,
      name: f.name,
      size: f.size,
      status: "queued",
      progress: 0,
    }));
    setFiles((prev) => [...prev, ...rows]);

    rows.forEach((row, idx) => {
      uploadFile(fl[idx], row.id).catch((error) => {
        setFiles((prev) =>
          prev.map((item) =>
            item.id === row.id
              ? {
                  ...item,
                  status: "queued",
                  progress: 0,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Upload failed",
                }
              : item,
          ),
        );
      });
    });
  }, []);

  useEffect(() => {
    function onProgress(event: Event) {
      const detail = (event as CustomEvent<{
        id: string;
        status: Status;
        progress: number;
      }>).detail;
      setFiles((prev) =>
        prev.map((row) =>
          row.id === detail.id
            ? { ...row, status: detail.status, progress: detail.progress }
            : row,
        ),
      );
    }
    window.addEventListener("otto-upload-progress", onProgress);
    return () => window.removeEventListener("otto-upload-progress", onProgress);
  }, []);

  const allDone =
    files.length > 0 && files.every((f) => f.status === "done");

  return (
    <div className="mx-auto max-w-[720px] space-y-8">
      <header className="space-y-1.5 text-center">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">
          Upload the docs you already have
        </h1>
        <p className="mx-auto max-w-[520px] text-[13px] leading-relaxed text-ink-secondary">
          PDF, DOCX, PPTX, XLSX, or images of org charts, SOPs, KPI docs, team
          overviews, or meeting notes. We&apos;ll extract evidence-anchored
          claims from each.
        </p>
      </header>

      <section
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(Array.from(e.dataTransfer.files));
        }}
        className={cn(
          "grid place-items-center rounded-lg border-2 border-dashed bg-surface px-8 py-12 text-center transition",
          drag ? "border-ink bg-muted" : "border-subtle",
        )}
      >
        <GradientMark variant="doc" size={100} />
        <p className="mt-4 text-[14px] font-medium text-ink">
          Drop files here, or browse
        </p>
        <p className="mt-1 text-[12px] text-ink-muted">
          Max 50 MB per file. Org charts, SOPs, KPI docs, team overviews.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
        />
        <Button
          variant="secondary"
          size="md"
          className="mt-4"
          onClick={() => inputRef.current?.click()}
        >
          Browse files
        </Button>
      </section>

      {files.length > 0 && (
        <section className="rounded-lg border border-subtle bg-surface">
          <header className="border-b border-subtle px-4 py-3 text-[12px] font-medium uppercase tracking-wide text-ink-muted">
            Files ({files.length})
          </header>
          <ul className="divide-y divide-subtle">
            {files.map((f) => (
              <li key={f.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3 text-[12.5px]">
                  <div className="min-w-0 truncate font-medium text-ink">
                    {f.name}
                  </div>
                  <div className="flex items-center gap-2 text-ink-muted">
                    <span>{formatSize(f.size)}</span>
                    <span>·</span>
                    <span>{f.error ?? STAGE_LABEL[f.status]}</span>
                  </div>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-ink transition-[width]"
                    style={{ width: `${f.progress}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {allDone && (
        <div className="flex justify-end">
          <Button
            onClick={() =>
              router.push(
                `/synthesis?next=${encodeURIComponent("/overview")}`,
              )
            }
          >
            Continue → Synthesize
          </Button>
        </div>
      )}
    </div>
  );
}

async function uploadFile(file: File, rowId: string) {
  const workspaceId = await ensureWorkspace();
  updateUploadRow(rowId, "extracting", 20);
  const presign = await postJson<{
    artifact: { id: string };
    upload_url: string;
  }>(
    `/api/workspaces/${workspaceId}/artifacts/presign`,
    {
      filename: file.name,
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      artifact_type: file.type.startsWith("image/") ? "image" : "document",
    },
    `artifact-presign-${rowId}`,
  );
  updateUploadRow(rowId, "extracting", 45);
  const upload = await fetch(presign.upload_url, {
    method: "PUT",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!upload.ok) {
    throw new Error(`R2 upload failed (${upload.status})`);
  }
  updateUploadRow(rowId, "ontology", 75);
  await postJson(
    `/api/artifacts/${presign.artifact.id}/complete`,
    { workspace_id: workspaceId },
    `artifact-complete-${rowId}`,
  );
  updateUploadRow(rowId, "done", 100);
}

async function ensureWorkspace() {
  const existing = window.localStorage.getItem("otto.phase0.workspaceId");
  if (existing) return existing;
  const created = await postJson<{
    workspace: { id: string };
  }>(
    "/api/workspaces",
    {
      name: "Commercial Operations",
      function_name: "Commercial Department",
      create_starter_process: false,
    },
    "workspace-create-upload",
  );
  window.localStorage.setItem("otto.phase0.workspaceId", created.workspace.id);
  return created.workspace.id;
}

function updateUploadRow(id: string, status: Status, progress: number) {
  window.dispatchEvent(
    new CustomEvent("otto-upload-progress", { detail: { id, status, progress } }),
  );
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

function formatSize(b: number) {
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b > 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}
