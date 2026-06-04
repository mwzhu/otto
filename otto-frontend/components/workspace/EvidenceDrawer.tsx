"use client";

import { useEffect, useMemo, useRef } from "react";
import { useWorkspaceStore } from "@/lib/store/workspace";
import { Pill } from "@/components/ui/Pill";
import { ConfidenceBadge } from "@/components/common/ConfidenceBadge";
import type { Claim, Evidence } from "@/lib/types";

export function EvidenceDrawer({
  claims,
  evidenceById,
  workspaceId,
}: {
  claims?: Claim[];
  evidenceById?: Record<string, Evidence>;
  workspaceId?: string;
}) {
  const open = useWorkspaceStore((s) => s.evidenceOpen);
  const claimId = useWorkspaceStore((s) => s.evidenceClaimId);
  const close = useWorkspaceStore((s) => s.closeEvidence);
  const auditedEvidenceIds = useRef(new Set<string>());

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const claim =
    claimId && claims ? claims.find((item) => item.id === claimId) : null;
  const evidences = useMemo(
    () =>
      claim
        ? claim.evidence_ids
            .map((id) => evidenceById?.[id])
            .filter((item): item is Evidence => Boolean(item))
        : [],
    [claim, evidenceById],
  );

  useEffect(() => {
    if (!open || !workspaceId || evidences.length === 0) return;
    for (const item of evidences) {
      if (auditedEvidenceIds.current.has(item.id)) continue;
      auditedEvidenceIds.current.add(item.id);
      void fetch(
        `/api/workspaces/${workspaceId}/evidence?evidence_id=${encodeURIComponent(item.id)}`,
        { cache: "no-store" },
      ).catch(() => undefined);
    }
  }, [open, workspaceId, evidences]);

  if (!open) {
    return null;
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-ink/10"
        onClick={close}
      />
      <aside
        className="fixed right-0 top-0 z-50 flex h-full w-[420px] flex-col border-l border-subtle bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-subtle px-5 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              Evidence
            </div>
            <div className="mt-1 text-[14.5px] font-semibold tracking-tight text-ink">
              {claim ? claimTitle(claim) : "—"}
            </div>
            {claim && (
              <div className="mt-2">
                <ConfidenceBadge value={claim.confidence} />
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-muted hover:text-ink"
            aria-label="Close evidence"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {evidences.length === 0 && (
            <div className="rounded-md border border-dashed border-subtle p-4 text-[12px] text-ink-muted">
              No direct evidence row was attached to this claim.
            </div>
          )}
          <ul className="space-y-3">
            {evidences.map((e) => (
              <li
                key={e.id}
                className="rounded-md border border-subtle bg-canvas p-3.5"
              >
                <div className="flex items-center gap-1.5">
                  <LabelPill label={e.evidence_label} />
                  <span className="text-[11px] text-ink-muted">
                    {new Date(e.observed_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </div>
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink">
                  &ldquo;{e.quote}&rdquo;
                </p>
                <div className="mt-2 text-[11px] text-ink-muted">
                  {e.speaker ? `${e.speaker} · ` : ""}
                  {sourceLabel(e.source_type)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </>
  );
}

function claimTitle(claim: Claim): string {
  return `${claim.subject_type.replace("_", " ")} · ${claim.field.replace(/_/g, " ")}`;
}
function sourceLabel(s: string) {
  switch (s) {
    case "transcript_segment":
      return "Interview transcript";
    case "screen_event":
      return "Screen observation";
    case "document_chunk":
      return "Uploaded document";
    case "user_correction":
      return "Director correction";
    default:
      return s;
  }
}
function LabelPill({ label }: { label: string }) {
  const tone =
    label === "corrected" || label === "confirmed"
      ? "success"
      : label === "observed" || label === "stated_operator"
        ? "role"
        : label === "documented"
          ? "system"
          : label === "inferred"
            ? "warn"
            : "neutral";
  return (
    <Pill tone={tone as "neutral"}>
      {label.replace(/_/g, " ")}
    </Pill>
  );
}
