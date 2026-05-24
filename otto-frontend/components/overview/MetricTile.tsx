import { cn } from "@/lib/cn";

export function MetricTile({
  label,
  value,
  suffix,
  hint,
  className,
  highlight = false,
}: {
  label: string;
  value: string | number;
  suffix?: string;
  hint?: string;
  className?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-subtle bg-surface p-5 shadow-card",
        className,
      )}
    >
      <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span
          className={cn(
            "text-[28px] font-semibold tracking-tight tabular-nums text-ink",
            highlight && "text-complexity-high-ink",
          )}
        >
          {value}
        </span>
        {suffix && (
          <span className="text-[13px] font-medium text-ink-muted">
            {suffix}
          </span>
        )}
      </div>
      {hint && (
        <div className="mt-2 text-[11.5px] text-ink-muted">{hint}</div>
      )}
    </div>
  );
}
