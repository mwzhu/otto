import { BRAND } from "@/lib/brand";

export function DrilldownBanner() {
  return (
    <section className="rounded-lg border border-subtle bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 grid size-7 place-items-center rounded-full text-ink"
          style={{
            background:
              "linear-gradient(135deg, var(--color-grad-from), var(--color-grad-to))",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M2 8h12M9 3l5 5-5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="flex-1">
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">
            Your overview is ready
          </h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
            Each card below is a process {BRAND.name} identified across your team.
            Click any card to see the full breakdown — people involved, tools used,
            and where the scores indicate prioritize which processes to document
            or improve first.
          </p>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-ink-muted hover:bg-muted hover:text-ink"
          aria-label="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </section>
  );
}
