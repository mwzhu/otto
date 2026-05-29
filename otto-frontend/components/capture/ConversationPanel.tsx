"use client";

import { BRAND } from "@/lib/brand";

export type CaptureConversationMessage = {
  id: string;
  speaker: "operator" | "agent" | "system";
  text: string;
  timestamp?: string;
};

export function ConversationPanel({
  messages = [],
  runtimeStatus,
  onRedactRequested,
}: {
  paused: boolean;
  messages?: CaptureConversationMessage[];
  runtimeStatus?: string;
  onRedactRequested: () => Promise<void> | void;
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
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex min-h-full items-center justify-center px-2 text-center">
            <div>
              <div className="mx-auto grid size-9 place-items-center rounded-full bg-muted text-[12px] font-semibold text-ink">
                {BRAND.name.slice(0, 1)}
              </div>
              <h2 className="mt-4 text-[14px] font-semibold tracking-tight text-ink">
                Listening for the walkthrough
              </h2>
              <p className="mt-2 max-w-[320px] text-[12.5px] leading-relaxed text-ink-secondary">
                Operator transcript, Otto questions, and capture notices will
                appear here as the live worker processes the session.
              </p>
              {runtimeStatus && (
                <p className="mt-3 font-mono text-[11px] text-ink-muted">
                  {runtimeStatus}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => (
              <ConversationBubble key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationBubble({
  message,
}: {
  message: CaptureConversationMessage;
}) {
  const isOperator = message.speaker === "operator";
  const isAgent = message.speaker === "agent";
  return (
    <article
      className={
        isOperator
          ? "ml-auto max-w-[82%] rounded-md bg-ink px-3 py-2 text-canvas"
          : isAgent
            ? "mr-auto max-w-[82%] rounded-md border border-subtle bg-canvas px-3 py-2 text-ink-secondary"
            : "mx-auto max-w-[88%] rounded-md border border-subtle bg-muted px-3 py-2 text-center text-ink-muted"
      }
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-70">
        {message.speaker === "operator"
          ? "Operator"
          : message.speaker === "agent"
            ? BRAND.name
            : "Capture"}
      </div>
      <div className="text-[12.5px] leading-relaxed">{message.text}</div>
      {message.timestamp && (
        <div className="mt-1 text-[10px] opacity-60">
          {formatMessageTime(message.timestamp)}
        </div>
      )}
    </article>
  );
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
