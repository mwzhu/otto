import { Pill } from "@/components/ui/Pill";
import type { ProcessDetail } from "@/lib/types";

export function AccountabilityBlock({ detail }: { detail: ProcessDetail }) {
  return (
    <section className="space-y-4">
      <h3 className="text-[14px] font-semibold tracking-tight text-ink">
        Who is accountable
      </h3>
      <p className="text-[13px] leading-relaxed text-ink-secondary">
        {detail.accountability.length > 0
          ? "Accountability below is projected from active director and document evidence."
          : "No accountable role has been confirmed yet."}
      </p>
      <div className="space-y-2.5">
        {detail.accountability.map((a, i) => (
          <div
            key={i}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-muted px-3 py-2.5"
          >
            <span className="text-[12.5px] font-medium text-ink">
              {a.role}
            </span>
            {a.person && a.person !== a.role && (
              <span className="text-[11.5px] text-ink-muted">— {a.person}</span>
            )}
            <Pill tone={labelTone(a.label)}>{a.label}</Pill>
            <span className="text-[11.5px] text-ink-muted">· {a.domain}</span>
            <p className="basis-full text-[12px] leading-relaxed text-ink-secondary">
              {a.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function labelTone(l: string) {
  switch (l) {
    case "owner":
      return "system" as const;
    case "external":
      return "warn" as const;
    case "internal admin":
      return "role" as const;
    default:
      return "neutral" as const;
  }
}
