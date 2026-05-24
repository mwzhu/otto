import { cn } from "@/lib/cn";
import type { ProcessDetail } from "@/lib/types";

export function RiskCallouts({ detail }: { detail: ProcessDetail }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[14px] font-semibold tracking-tight text-ink">
        Risks and friction
      </h3>
      <div className="space-y-2.5">
        {detail.risks.map((r, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-3 rounded-md border px-3.5 py-3",
              r.severity === "high"
                ? "border-[#F1C9B6] bg-[#FFF6F1]"
                : r.severity === "med"
                  ? "border-[#F0DCAA] bg-[#FFF9EB]"
                  : "border-subtle bg-muted",
            )}
          >
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-ink/5 text-[10px] font-bold text-ink-secondary">
              !
            </span>
            <div className="text-[12.5px] leading-relaxed">
              <div className="font-medium text-ink">{r.title}</div>
              <div className="mt-1 text-ink-secondary">{r.body}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
