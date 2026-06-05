"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import type { WorkspaceTab } from "@/lib/store/workspace";

type TabDef = { id: WorkspaceTab; label: string; count?: number };

export function TabBar({
  className,
  counts = {},
}: {
  className?: string;
  counts?: Partial<Record<WorkspaceTab, number>>;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const requested = sp.get("tab");
  const active = isWorkspaceTab(requested) ? requested : "summary";

  const tabs: TabDef[] = [
    { id: "summary", label: "Summary" },
    { id: "steps", label: "Steps", count: counts.steps },
    { id: "insights", label: "Insights", count: counts.insights },
    { id: "risk", label: "Risk & Vulnerabilities", count: counts.risk },
  ];

  function setTab(id: WorkspaceTab) {
    const params = new URLSearchParams(sp.toString());
    params.set("tab", id);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  return (
    <div className={cn("flex items-center gap-5 border-b border-subtle px-5", className)}>
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "relative flex items-center gap-1.5 py-3 text-[13px] font-medium transition",
              isActive ? "text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            {t.label}
            {typeof t.count === "number" && (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] font-semibold leading-4 tabular-nums",
                  isActive ? "bg-ink text-canvas" : "bg-muted text-ink-secondary",
                )}
              >
                {t.count}
              </span>
            )}
            <span
              className={cn(
                "absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-ink transition-opacity",
                isActive ? "opacity-100" : "opacity-0",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

function isWorkspaceTab(value: string | null): value is WorkspaceTab {
  return value === "summary" || value === "steps" || value === "insights" || value === "risk";
}
