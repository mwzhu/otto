"use client";

import { BRAND } from "@/lib/brand";

export function ConversationPanel({
  onRedactRequested,
}: {
  paused: boolean;
  onRedactRequested: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-subtle px-4 py-3">
        <div className="text-[13px] font-semibold tracking-tight text-ink">
          Conversation
        </div>
        <button
          type="button"
          onClick={onRedactRequested}
          className="rounded-md border border-subtle bg-surface px-2 py-1 text-[10.5px] font-medium text-ink-secondary transition hover:border-ink-muted hover:text-ink"
        >
          Redact last 30s
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div>
          <div className="mx-auto grid size-9 place-items-center rounded-full bg-muted text-[12px] font-semibold text-ink">
            {BRAND.name.slice(0, 1)}
          </div>
          <h2 className="mt-4 text-[14px] font-semibold tracking-tight text-ink">
            Waiting for live transcript
          </h2>
          <p className="mt-2 max-w-[320px] text-[12.5px] leading-relaxed text-ink-secondary">
            Real capture events will appear here once the recorder and speech
            pipeline are connected.
          </p>
        </div>
      </div>
    </div>
  );
}
