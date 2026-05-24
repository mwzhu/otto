import { cn } from "@/lib/cn";

export function ComplexityBar({
  value,
  max = 100,
  className,
  showLabel = false,
  size = "md",
}: {
  value: number;
  max?: number;
  className?: string;
  showLabel?: boolean;
  size?: "sm" | "md";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const tone =
    pct >= 70
      ? "from-[#F1A38E] via-[#E47C5F] to-[#D04F2B]"
      : pct >= 40
      ? "from-[#F7D596] via-[#EDB05A] to-[#D88A2A]"
      : "from-[#BFE4C0] via-[#9CD49D] to-[#5EA967]";
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div
        className={cn(
          "relative flex-1 overflow-hidden rounded-full bg-muted",
          size === "sm" ? "h-1.5" : "h-2",
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full bg-gradient-to-r",
            tone,
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className="font-mono text-[11px] tabular-nums text-ink-secondary">
          {value} / {max}
        </span>
      )}
    </div>
  );
}
