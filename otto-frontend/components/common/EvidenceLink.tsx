"use client";

import { useWorkspaceStore } from "@/lib/store/workspace";
import { cn } from "@/lib/cn";

export function EvidenceLink({
  claimId,
  count,
  className,
}: {
  claimId: string;
  count?: number;
  className?: string;
}) {
  const openEvidence = useWorkspaceStore((s) => s.openEvidence);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openEvidence(claimId);
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-subtle bg-surface px-1.5 py-0.5 align-middle text-[10px] font-medium text-ink-secondary transition hover:border-ink-muted hover:text-ink",
        className,
      )}
      aria-label="View evidence"
    >
      <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden>
        <path
          d="M5 11l6-6M11 5H7M11 5v4"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      {typeof count === "number" && <span>{count}</span>}
    </button>
  );
}
