"use client";

import { cn } from "@/lib/cn";
import { useWorkspaceStore } from "@/lib/store/workspace";

const MODES: { id: ReturnType<typeof useWorkspaceStore.getState>["layoutMode"]; label: string }[] =
  [
    { id: "authored", label: "Default" },
    { id: "vertical", label: "Vertical" },
    { id: "swimlane-role", label: "Swimlanes (Role)" },
    { id: "swimlane-system", label: "Swimlanes (System)" },
    { id: "exception", label: "Exceptions" },
  ];

export function LayoutModeToggle({ className }: { className?: string }) {
  const mode = useWorkspaceStore((s) => s.layoutMode);
  const setMode = useWorkspaceStore((s) => s.setLayoutMode);

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-lg border border-subtle bg-surface/95 p-1 shadow-card backdrop-blur",
        className,
      )}
    >
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => setMode(m.id)}
          className={cn(
            "rounded-md px-2.5 py-1 text-[11.5px] font-medium transition",
            mode === m.id
              ? "bg-ink text-canvas"
              : "text-ink-secondary hover:bg-muted hover:text-ink",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
