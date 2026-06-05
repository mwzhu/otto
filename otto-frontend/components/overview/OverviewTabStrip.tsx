"use client";

import { cn } from "@/lib/cn";

export type OverviewTab = "overview" | "automation";

export function OverviewTabStrip({
  active,
  onChange,
}: {
  active: OverviewTab;
  onChange: (t: OverviewTab) => void;
}) {
  const tabs: { id: OverviewTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "automation", label: "Automation" },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-subtle">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            "relative px-3 py-2.5 text-[13px] font-medium transition",
            active === t.id
              ? "text-ink"
              : "text-ink-secondary hover:text-ink",
          )}
        >
          {t.label}
          <span
            className={cn(
              "absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-ink",
              active === t.id ? "opacity-100" : "opacity-0",
            )}
          />
        </button>
      ))}
    </div>
  );
}
