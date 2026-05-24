"use client";

import { useState } from "react";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { VariantReviewRow } from "@/lib/admin/variant-queries";

export function VariantQueue({ rows }: { rows: VariantReviewRow[] }) {
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject">>({});
  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const d = decisions[row.id];
        const confidence = Number(row.confidence ?? 0);
        return (
          <article
            key={row.id}
            className={cn(
              "rounded-lg border bg-surface p-4 transition",
              d === "accept"
                ? "border-[#BFE4C0]"
                : d === "reject"
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
            <div className="mt-3 flex items-center justify-end gap-2">
              {d ? (
                <span className="text-[12px] text-ink-muted">
                  Marked {d === "accept" ? "accepted" : "rejected"} ·{" "}
                  <button
                    onClick={() =>
                      setDecisions((prev) => {
                        const next = { ...prev };
                        delete next[row.id];
                        return next;
                      })
                    }
                    className="underline-offset-2 hover:underline"
                  >
                    Undo
                  </button>
                </span>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setDecisions((prev) => ({ ...prev, [row.id]: "reject" }))
                    }
                  >
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      setDecisions((prev) => ({ ...prev, [row.id]: "accept" }))
                    }
                  >
                    Mark reviewed
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
