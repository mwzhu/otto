"use client";

import { useState } from "react";
import { ScreenSharePreview } from "@/components/capture/ScreenSharePreview";
import { ConversationPanel } from "@/components/capture/ConversationPanel";
import { CaptureControls } from "@/components/capture/CaptureControls";

export default function ScreenshareClient({ processId }: { processId: string }) {
  const [paused, setPaused] = useState(false);
  const [redactToast, setRedactToast] = useState(false);

  return (
    <main className="mx-auto grid w-full max-w-[1400px] flex-1 grid-cols-[1.4fr_460px] gap-6 px-6 py-6">
      <section className="flex flex-col gap-4">
        <ScreenSharePreview />
        <CaptureControls
          processId={processId}
          onPauseChange={setPaused}
        />
        {redactToast && (
          <div className="self-center rounded-md bg-ink px-3 py-1.5 text-[11.5px] text-canvas shadow-pop">
            Got it — redacting the last 30 seconds across the recording, transcript,
            screen events, and embeddings.
          </div>
        )}
      </section>

      <aside className="flex h-[calc(100vh-130px)] flex-col overflow-hidden rounded-lg border border-subtle bg-surface shadow-card">
        <ConversationPanel
          paused={paused}
          onRedactRequested={() => {
            setRedactToast(true);
            setTimeout(() => setRedactToast(false), 3500);
          }}
        />
      </aside>
    </main>
  );
}
