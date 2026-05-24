import { TranscriptChat } from "@/components/onboarding/TranscriptChat";

export default function VoiceLivePage() {
  return (
    <div className="space-y-8">
      <header className="space-y-1.5 text-center text-ink-muted">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink-muted">
          Clarity starts with your perspective
        </h1>
        <p className="mx-auto max-w-[520px] text-[12.5px] leading-relaxed">
          Tell us about your team: who&apos;s involved, how work flows, where the pain
          points are. We&apos;ll turn it into a structured overview of your operations.
        </p>
      </header>

      <TranscriptChat nextHref="/overview" />
    </div>
  );
}
