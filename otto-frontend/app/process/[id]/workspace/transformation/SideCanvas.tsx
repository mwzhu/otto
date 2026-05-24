"use client";

import { ProcessCanvas } from "@/components/canvas/ProcessCanvas";
import type { ProcessGraph } from "@/lib/types";
import { cn } from "@/lib/cn";

export default function SideCanvas({
  title,
  graph,
  variant,
}: {
  title: string;
  graph: ProcessGraph;
  variant: "current" | "proposed";
}) {
  return (
    <section className={cn("relative flex flex-col", variant === "current" && "border-r border-subtle")}>
      <header className="flex items-center gap-2 border-b border-subtle bg-surface px-4 py-2.5">
        <span
          className={cn(
            "inline-flex size-2.5 rounded-full",
            variant === "current" ? "bg-status-warn" : "bg-status-success",
          )}
        />
        <div className="text-[12.5px] font-semibold text-ink">{title}</div>
        <div className="text-[11px] text-ink-muted">
          {variant === "current"
            ? `${graph.nodes.length} steps · 2 rework loops`
            : `${graph.nodes.length} steps · 0 rework loops`}
        </div>
      </header>
      <div className="relative flex-1">
        <ProcessCanvas graph={graph} />
      </div>
    </section>
  );
}
