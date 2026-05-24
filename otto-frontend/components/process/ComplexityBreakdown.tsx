import { ComplexityBar } from "@/components/common/ComplexityBar";
import type { ProcessDetail } from "@/lib/types";

export function ComplexityBreakdown({ detail }: { detail: ProcessDetail }) {
  return (
    <section className="rounded-lg border border-subtle bg-surface p-5">
      <h3 className="text-[14px] font-semibold tracking-tight text-ink">
        Complexity score breakdown
      </h3>
      <div className="mt-4 space-y-3">
        {detail.complexity_breakdown.map((row) => (
          <div key={row.label} className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <div>
                <div className="text-[12.5px] font-medium text-ink">
                  {row.label}
                </div>
                {row.detail && (
                  <div className="text-[11px] text-ink-muted">{row.detail}</div>
                )}
              </div>
              <div className="font-mono text-[12px] tabular-nums text-ink">
                {row.value}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 border-t border-subtle pt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-semibold text-ink">Total</span>
          <span className="font-mono text-[14px] font-semibold tabular-nums text-ink">
            {detail.complexity_score} / {detail.complexity_total_max}
          </span>
        </div>
        <ComplexityBar
          value={detail.complexity_score}
          max={detail.complexity_total_max}
          className="mt-2"
        />
      </div>
    </section>
  );
}
