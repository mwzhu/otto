import Link from "next/link";
import { GradientMark } from "@/components/brand/GradientMark";
import { Button } from "@/components/ui/Button";
import { LanguageSelect } from "@/components/onboarding/LanguageSelect";

export default function VoicePreStartPage() {
  return (
    <div className="space-y-10">
      <header className="space-y-2 text-center">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">
          Clarity starts with your perspective
        </h1>
        <p className="mx-auto max-w-[560px] text-[13px] leading-relaxed text-ink-secondary">
          Tell us about your team: who&apos;s involved, how work flows, where the pain
          points are. We&apos;ll turn it into a structured overview of your operations.
        </p>
      </header>

      <section className="mx-auto flex max-w-[560px] flex-col items-center gap-8 rounded-lg border border-subtle bg-surface px-8 py-10 shadow-card">
        <GradientMark variant="wave" size={140} />
        <p className="text-center text-[12.5px] leading-relaxed text-ink-secondary">
          The interview covers ~10 focused questions across key areas of your
          operations and takes about 15-20 minutes.
        </p>
        <div className="flex flex-col items-center gap-3">
          <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
            <GlobeIcon /> Select interview language
          </div>
          <LanguageSelect />
        </div>
        <div className="flex items-center gap-2">
          <Link href="/onboarding">
            <Button variant="secondary">Cancel</Button>
          </Link>
          <Link href="/onboarding/voice/live">
            <Button>Start Interview</Button>
          </Link>
        </div>
      </section>
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" className="mr-1 inline-block" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}
