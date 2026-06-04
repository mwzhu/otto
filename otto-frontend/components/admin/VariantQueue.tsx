"use client";

import { useState } from "react";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type {
  ProcessMergeTarget,
  VariantReviewRow,
} from "@/lib/admin/variant-queries";

type DecisionState = {
  action: "promoted" | "merged" | "discarded";
  detail?: string;
};

export function VariantQueue({
  rows,
  workspaceId,
  mergeTargets,
}: {
  rows: VariantReviewRow[];
  workspaceId: string;
  mergeTargets: ProcessMergeTarget[];
}) {
  const [decisions, setDecisions] = useState<Record<string, DecisionState>>({});
  const [pending, setPending] = useState<Record<string, string | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [targets, setTargets] = useState<Record<string, string | undefined>>({});

  async function mutateCandidate(
    row: VariantReviewRow,
    action: "promote" | "merge" | "discard",
  ) {
    setPending((prev) => ({ ...prev, [row.id]: action }));
    setErrors((prev) => ({ ...prev, [row.id]: undefined }));
    const targetProcessId = targets[row.id] ?? mergeTargets[0]?.id;
    try {
      const response = await fetch(`/api/candidate-processes/${row.id}/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `admin-variant-${action}-${row.id}`,
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          ...(action === "merge" ? { target_process_id: targetProcessId } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          payload?.error?.message ?? `Could not ${action} candidate.`,
        );
      }
      setDecisions((prev) => ({
        ...prev,
        [row.id]:
          action === "promote"
            ? { action: "promoted", detail: payload.process_id }
            : action === "merge"
              ? {
                  action: "merged",
                  detail:
                    mergeTargets.find((target) => target.id === targetProcessId)
                      ?.name ?? "selected process",
                }
              : { action: "discarded" },
      }));
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [row.id]:
          error instanceof Error
            ? error.message
            : `Could not ${action} candidate.`,
      }));
    } finally {
      setPending((prev) => ({ ...prev, [row.id]: undefined }));
    }
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const d = decisions[row.id];
        const busy = pending[row.id];
        const confidence = Number(row.confidence ?? 0);
        return (
          <article
            key={row.id}
            className={cn(
              "rounded-lg border bg-surface p-4 transition",
              d?.action === "promoted" || d?.action === "merged"
                ? "border-[#BFE4C0]"
                : d?.action === "discarded"
                  ? "border-[#F1C9B6]"
                  : "border-subtle",
            )}
          >
            <header className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
                  {row.proposed_function ?? "Captured process"}
                </div>
                <div className="mt-0.5 text-[14px] font-semibold text-ink">
                  {row.proposed_name}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="font-mono text-[11.5px] tabular-nums text-ink">
                  confidence {(confidence * 100).toFixed(0)}%
                </span>
                <Pill tone={confidence >= 0.85 ? "success" : "warn"}>
                  {confidence >= 0.85 ? "high" : "needs review"}
                </Pill>
              </div>
            </header>
            <div className="mt-3 grid grid-cols-2 gap-3 text-[12.5px]">
              <div className="rounded-md border border-subtle bg-canvas p-3">
                <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
                  Candidate source
                </div>
                <p className="mt-1 leading-relaxed text-ink-secondary">
                  Created from intake evidence on {new Date(row.created_at).toLocaleDateString()}.
                </p>
              </div>
              <div className="rounded-md border border-subtle bg-canvas p-3">
                <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
                  Evidence
                </div>
                <p className="mt-1 leading-relaxed text-ink-secondary">
                  {row.evidence_count} linked evidence source{row.evidence_count === 1 ? "" : "s"}.
                </p>
              </div>
            </div>
            {errors[row.id] ? (
              <div className="mt-3 rounded-md border border-complexity-high-bg bg-complexity-high-bg/40 px-3 py-2 text-[12px] text-complexity-high-ink">
                {errors[row.id]}
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              {d ? (
                <span className="text-[12px] text-ink-muted">
                  {d.action === "promoted"
                    ? "Promoted to tracked process"
                    : d.action === "merged"
                      ? `Merged into ${d.detail}`
                      : "Discarded from queue"}
                </span>
              ) : (
                <>
                  {mergeTargets.length > 0 ? (
                    <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                      Merge into
                      <select
                        value={targets[row.id] ?? mergeTargets[0]?.id ?? ""}
                        onChange={(event) =>
                          setTargets((prev) => ({
                            ...prev,
                            [row.id]: event.target.value,
                          }))
                        }
                        className="h-8 max-w-[220px] rounded-md border border-subtle bg-canvas px-2 text-[12px] text-ink outline-none focus:border-ink-muted"
                      >
                        {mergeTargets.map((target) => (
                          <option key={target.id} value={target.id}>
                            {target.name} ({target.status})
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => mutateCandidate(row, "discard")}
                    disabled={Boolean(busy)}
                  >
                    {busy === "discard" ? "Discarding" : "Discard"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => mutateCandidate(row, "merge")}
                    disabled={Boolean(busy) || mergeTargets.length === 0}
                  >
                    {busy === "merge" ? "Merging" : "Merge"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => mutateCandidate(row, "promote")}
                    disabled={Boolean(busy)}
                  >
                    {busy === "promote" ? "Promoting" : "Promote to tracked process"}
                  </Button>
                </>
              )}
            </div>
          </article>
        );
      })}
      {rows.length === 0 && (
        <div className="rounded-lg border border-subtle bg-surface p-6 text-[13px] text-ink-secondary">
          No pending candidate processes need review.
        </div>
      )}
    </div>
  );
}
