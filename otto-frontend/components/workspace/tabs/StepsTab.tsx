"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import type { ProcessGraph } from "@/lib/types";
import type { EvidenceLabel, EvidenceSource } from "@/lib/types/evidence";

type NodeEvidenceRow = {
  id: string;
  source_type: EvidenceSource;
  source_id: string | null;
  evidence_label: EvidenceLabel;
  quote: string;
  summary: string | null;
  observed_at: string;
  confidence: number;
  source_preview: string | null;
  speaker: string | null;
  screen_app_name: string | null;
  screen_window_title: string | null;
  screen_signal_tags: string[];
  screenshot_artifact_url: string | null;
  screenshot_artifact_expired: boolean;
  document_ordinal: number | null;
};

export function StepsTab({
  processId,
  workspaceId,
  graph,
}: {
  processId?: string;
  workspaceId?: string;
  graph?: ProcessGraph;
}) {
  const steps = graph?.nodes.filter((node) => node.type === "task") ?? [];
  const [drawer, setDrawer] = useState<{
    stepTitle: string;
    evidenceIds: string[];
  } | null>(null);
  if (steps.length === 0) {
    return (
      <div className="px-5 py-5 text-[13px] text-ink-secondary">
        No real step-level model has been published for this process yet.
      </div>
    );
  }

  return (
    <div className="divide-y divide-subtle">
      {steps.map((step, index) => (
        <div key={step.id} className="px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-ink-secondary">
              {index + 1}
            </div>
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold leading-snug text-ink">
                {step.data.title}
              </h3>
              {step.data.description && (
                <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                  {step.data.description}
                </p>
              )}
              <div className="mt-2 text-[11px] text-ink-muted">
                {(step.data.evidence_ids?.length ?? 0)} evidence source
                {(step.data.evidence_ids?.length ?? 0) === 1 ? "" : "s"}
                {typeof step.data.confidence === "number"
                  ? ` · ${Math.round(step.data.confidence * 100)}% confidence`
                  : null}
              </div>
              <StepDetails step={step} />
              {(step.data.evidence_ids?.length ?? 0) > 0 && processId && workspaceId && (
                <div className="mt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDrawer({
                        stepTitle: step.data.title,
                        evidenceIds: step.data.evidence_ids ?? [],
                      })
                    }
                  >
                    View evidence
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
      <NodeEvidenceDrawer
        open={Boolean(drawer)}
        workspaceId={workspaceId}
        processId={processId}
        versionId={graph?.version_id}
        stepTitle={drawer?.stepTitle}
        evidenceIds={drawer?.evidenceIds ?? []}
        onClose={() => setDrawer(null)}
      />
    </div>
  );
}

function StepDetails({ step }: { step: ProcessGraph["nodes"][number] }) {
  const inputs = step.data.inputs ?? [];
  const outputs = step.data.outputs ?? [];
  const exceptions = step.data.exceptions ?? [];
  const workarounds = step.data.workarounds ?? [];
  const variants = step.data.variants ?? [];
  if (
    inputs.length === 0 &&
    outputs.length === 0 &&
    exceptions.length === 0 &&
    workarounds.length === 0 &&
    variants.length === 0
  ) {
    return null;
  }
  return (
    <div className="mt-3 space-y-2">
      {(inputs.length > 0 || outputs.length > 0) && (
        <div className="grid grid-cols-2 gap-2">
          <DetailGroup
            label="Inputs"
            values={inputs.map((item) => item.name)}
          />
          <DetailGroup
            label="Outputs"
            values={outputs.map((item) => item.name)}
          />
        </div>
      )}
      {exceptions.length > 0 && (
        <DetailGroup
          label="Exceptions"
          values={exceptions.map((item) => item.label)}
          tone="danger"
        />
      )}
      {workarounds.length > 0 && (
        <DetailGroup
          label="Workarounds"
          values={workarounds.map((item) => item.description)}
          tone="warn"
        />
      )}
      {variants.length > 0 && (
        <DetailGroup
          label="Variants"
          values={variants.map((item) => item.condition)}
        />
      )}
    </div>
  );
}

function DetailGroup({
  label,
  values,
  tone = "neutral",
}: {
  label: string;
  values: string[];
  tone?: "neutral" | "warn" | "danger";
}) {
  if (values.length === 0) return null;
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {values.slice(0, 4).map((value) => (
          <span
            key={value}
            className={cn(
              "max-w-full truncate rounded-full border px-2 py-0.5 text-[11px]",
              tone === "danger"
                ? "border-complexity-high-bg bg-complexity-high-bg/30 text-complexity-high-ink"
                : tone === "warn"
                  ? "border-complexity-med-bg bg-complexity-med-bg/30 text-complexity-med-ink"
                  : "border-subtle bg-muted text-ink-secondary",
            )}
            title={value}
          >
            {value}
          </span>
        ))}
        {values.length > 4 && (
          <span className="rounded-full border border-subtle bg-muted px-2 py-0.5 text-[11px] text-ink-muted">
            +{values.length - 4}
          </span>
        )}
      </div>
    </div>
  );
}

export function NodeEvidenceDrawer({
  open,
  workspaceId,
  processId,
  versionId,
  stepTitle,
  evidenceIds,
  onClose,
}: {
  open: boolean;
  workspaceId?: string;
  processId?: string;
  versionId?: string;
  stepTitle?: string;
  evidenceIds: string[];
  onClose: () => void;
}) {
  const [rowsByKey, setRowsByKey] = useState<Record<string, NodeEvidenceRow[]>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useMemo(() => evidenceIds.join(","), [evidenceIds]);
  const rows = rowsByKey[key] ?? [];

  async function loadEvidence() {
    if (!workspaceId || !processId || evidenceIds.length === 0 || rowsByKey[key]) {
      return;
    }
    setLoadingKey(key);
    setError(null);
    try {
      const params = new URLSearchParams({
        workspace_id: workspaceId,
        evidence_ids: evidenceIds.join(","),
      });
      if (versionId) params.set("version_id", versionId);
      const response = await fetch(`/api/processes/${processId}/evidence?${params}`, {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Could not load evidence.");
      }
      setRowsByKey((current) => ({
        ...current,
        [key]: payload.evidence ?? [],
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load evidence.");
    } finally {
      setLoadingKey(null);
    }
  }

  useEffect(() => {
    if (!open || !key || loadingKey === key || rowsByKey[key] || error) return;
    void loadEvidence();
  }, [open, key, loadingKey, rowsByKey, error]);

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-ink/10 transition-opacity",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
      />
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-[440px] flex-col border-l border-subtle bg-surface shadow-pop transition-transform",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-subtle px-5 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              Step Evidence
            </div>
            <div className="mt-1 text-[14px] font-semibold leading-snug text-ink">
              {stepTitle ?? "Workflow step"}
            </div>
            <div className="mt-2 text-[11px] text-ink-muted">
              {evidenceIds.length} linked source{evidenceIds.length === 1 ? "" : "s"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-muted hover:text-ink"
            aria-label="Close evidence"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
              <path
                d="M3 3l10 10M13 3L3 13"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loadingKey === key && (
            <div className="text-[12px] text-ink-muted">Loading evidence...</div>
          )}
          {error && (
            <div className="rounded-md border border-danger/20 bg-danger/5 p-3 text-[12px] text-danger">
              {error}
            </div>
          )}
          {!loadingKey && !error && rows.length === 0 && (
            <div className="rounded-md border border-dashed border-subtle p-4 text-[12px] text-ink-muted">
              No retained evidence rows are available for this step.
            </div>
          )}
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.id} className="rounded-md border border-subtle bg-canvas p-3.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={evidenceTone(row.evidence_label)}>
                    {row.evidence_label.replace(/_/g, " ")}
                  </Pill>
                  <span className="text-[11px] text-ink-muted">
                    {sourceLabel(row)}
                  </span>
                </div>
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink">
                  &ldquo;{row.quote}&rdquo;
                </p>
                {row.source_preview && row.source_preview !== row.quote && (
                  <p className="mt-2 line-clamp-4 text-[12px] leading-relaxed text-ink-secondary">
                    {row.source_preview}
                  </p>
                )}
                {row.screenshot_artifact_url && (
                  <img
                    src={row.screenshot_artifact_url}
                    alt="Captured screen evidence"
                    className="mt-3 max-h-44 w-full rounded-md border border-subtle object-contain"
                  />
                )}
                {!row.screenshot_artifact_url && row.screenshot_artifact_expired && (
                  <div className="mt-3 rounded-md border border-dashed border-subtle px-3 py-2 text-[11px] text-ink-muted">
                    Frame expired by retention policy.
                  </div>
                )}
                <div className="mt-2 text-[11px] text-ink-muted">
                  {new Date(row.observed_at).toLocaleString()} ·{" "}
                  {Math.round(row.confidence * 100)}% confidence
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </>
  );
}

function sourceLabel(row: NodeEvidenceRow) {
  if (row.source_type === "transcript_segment") {
    return row.speaker ? `${row.speaker} transcript` : "Interview transcript";
  }
  if (row.source_type === "screen_event") {
    return [row.screen_app_name, row.screen_window_title]
      .filter(Boolean)
      .join(" · ") || "Screen observation";
  }
  if (row.source_type === "document_chunk") {
    return row.document_ordinal !== null
      ? `Uploaded document · chunk ${row.document_ordinal}`
      : "Uploaded document";
  }
  return row.source_type.replace(/_/g, " ");
}

function evidenceTone(label: EvidenceLabel) {
  if (label === "observed" || label === "stated_operator") return "role";
  if (label === "documented") return "system";
  if (label === "confirmed" || label === "corrected") return "success";
  if (label === "inferred") return "warn";
  return "neutral";
}
