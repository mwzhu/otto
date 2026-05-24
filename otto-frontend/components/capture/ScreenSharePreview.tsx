import { GradientMark } from "@/components/brand/GradientMark";

export function ScreenSharePreview() {
  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-md border border-subtle bg-[#1F1F1B]">
      <FakeBrowserChrome />
      <div className="absolute inset-x-6 bottom-6 top-12 grid grid-cols-2 gap-3">
        <FakePane title="Promo System" hint="proposal_2026Q2" />
        <FakePane title="promo-funding-jul.xlsx" hint="14 rows · Excel" />
      </div>

      {/* Dimmed overlay matching mockup */}
      <div className="absolute inset-0 bg-canvas/55 backdrop-blur-[1px]" />
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center gap-2.5 text-center">
          <GradientMark variant="logo" size={56} />
          <div className="text-[13px] font-semibold text-ink">Preview dimmed</div>
          <p className="max-w-[280px] text-[11.5px] leading-relaxed text-ink-secondary">
            We&apos;ve dimmed the recording preview so you don&apos;t have to watch the
            infinite mirror effect. Sharing is unaffected.
          </p>
          <button className="mt-1 rounded-full bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-secondary shadow-card">
            Show preview anyway
          </button>
        </div>
      </div>
    </div>
  );
}

function FakeBrowserChrome() {
  return (
    <div className="flex items-center gap-2 border-b border-white/10 bg-[#2A2A26] px-3 py-2">
      <span className="size-2.5 rounded-full bg-[#FF5F57]" />
      <span className="size-2.5 rounded-full bg-[#FEBC2E]" />
      <span className="size-2.5 rounded-full bg-[#28C840]" />
      <div className="ml-3 inline-flex h-6 max-w-[260px] flex-1 items-center rounded bg-[#1F1F1B] px-3 text-[10.5px] text-white/70">
        promosystem.internal/promo/2026Q2/beverages
      </div>
    </div>
  );
}

function FakePane({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded bg-white/95 p-2 shadow">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-secondary">
        {title}
      </div>
      <div className="mt-1 text-[10px] text-ink-muted">{hint}</div>
      <div className="mt-2 space-y-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-1.5 rounded bg-ink/5"
            style={{ width: `${72 + Math.sin(i) * 15}%` }}
          />
        ))}
      </div>
    </div>
  );
}
