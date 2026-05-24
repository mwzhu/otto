import { Pill } from "@/components/ui/Pill";
import type { ProcessDetail } from "@/lib/types";

export function SystemPills({ detail }: { detail: ProcessDetail }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[14px] font-semibold tracking-tight text-ink">
        Systems it touches
      </h3>
      <p className="text-[12.5px] leading-relaxed text-ink-secondary">
        {detail.systems_detail.length > 0
          ? detail.systems_detail
              .map((system) => `${system.name}${system.purpose ? `: ${system.purpose}` : ""}`)
              .join(" ")
          : "No systems have been linked to this process yet."}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {detail.systems_detail.map((s) => (
          <Pill key={s.name} tone="system">
            {s.name}
          </Pill>
        ))}
      </div>
    </section>
  );
}
