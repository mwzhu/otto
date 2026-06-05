import { EntryTile } from "@/components/onboarding/EntryTile";
import { GradientMark } from "@/components/brand/GradientMark";
import { BRAND } from "@/lib/brand";

export default function OnboardingPage() {
  return (
    <div className="space-y-12">
      <header className="space-y-2 text-center">
        <h1 className="text-[28px] font-semibold tracking-tight text-ink">
          Otto starts with your perspective
        </h1>
        <p className="mx-auto max-w-[520px] text-[13.5px] leading-relaxed text-ink-secondary">
          Tell us about your team: who&apos;s involved, how work flows, where the pain
          points are. {BRAND.name} will turn it into a structured overview of your
          operations.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-5">
        <EntryTile
          title="Walk us through how your team works"
          description={`${BRAND.name} asks about your team structure, departments, KPIs, and how work flows. Just talk, we handle the rest.`}
          illustration={<GradientMark variant="wave" size={88} />}
          href="/onboarding/voice"
          cta={
            <>
              <MicIcon /> Start Voice Interview
            </>
          }
        />
        <EntryTile
          title="Let your documents do the talking"
          description="Upload high-level docs like org charts or team overviews and we'll extract how your operations are set up."
          illustration={<GradientMark variant="doc" size={88} />}
          href="/onboarding/upload"
          cta={
            <>
              <UploadIcon /> Upload Documents
            </>
          }
        />
      </section>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <rect x="6" y="2" width="4" height="8" rx="2" fill="currentColor" />
      <path d="M4 8a4 4 0 008 0M8 12v2" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}
function UploadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 3v8M5 6l3-3 3 3M3 13h10" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
