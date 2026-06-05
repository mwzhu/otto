"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/Button";
import { useWorkspaceStore } from "@/lib/store/workspace";
import type { ProcessSummary } from "@/lib/types";

type Tab = { label: string; href: string; segment: string | null };

export function WorkspaceTopNav({
  processId,
  processName,
  processStatus = "draft",
}: {
  processId: string;
  processName: string;
  processStatus?: ProcessSummary["process_status"];
}) {
  const pathname = usePathname();
  const sp = useSearchParams();

  const base = `/process/${processId}/workspace`;
  const tabs: Tab[] = [
    { label: "Current Process", href: base, segment: null },
  ];

  const toggleRefine = useWorkspaceStore((s) => s.toggleRefine);
  const status = processStatus === "approved" ? "approved" : "draft";

  return (
    <div className="flex flex-col gap-3 border-b border-subtle bg-canvas px-6 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">
            {processName}
          </h1>
          <StatusBadge status={status} />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => toggleRefine()}>
            <RefineIcon /> Refine Process
          </Button>
          <Link
            href={`/process/${processId}/capture`}
            className="inline-flex"
            aria-label="Add captures"
          >
            <Button variant="secondary" size="sm">
              <PlusIcon /> Add Captures
            </Button>
          </Link>
          <Button variant="secondary" size="sm">
            <ShareIcon /> Invite Colleague
          </Button>
          {status === "approved" ? (
            <Button size="sm" variant="outline" disabled>
              Approved
            </Button>
          ) : (
            <Link href={base} className="inline-flex">
              <Button size="sm">Review Draft</Button>
            </Link>
          )}
        </div>
      </div>

      <nav aria-label="Workspace sections" className="flex items-center gap-1">
        {tabs.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={
                t.segment === null
                  ? `${t.href}?${sp.toString()}`
                  : t.href
              }
              className={cn(
                "rounded-md px-3 py-1.5 text-[13px] font-medium transition",
                active
                  ? "bg-surface text-ink shadow-card"
                  : "text-ink-secondary hover:text-ink",
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function ShareIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="M11 4l-5 4 5 4M11 4V2M11 14v-2M11 8H4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}
function RefineIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="M3 13l4-1 6-6-3-3-6 6-1 4z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
    </svg>
  );
}
