"use client";

import { useState } from "react";
import { useWorkspaceStore } from "@/lib/store/workspace";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { AnimatedDots } from "@/components/common/AnimatedDots";
import { BRAND } from "@/lib/brand";

type Msg = { id: string; role: "user" | "agent"; text: string };

export function RefineProcessChat() {
  const open = useWorkspaceStore((s) => s.refineOpen);
  const toggle = useWorkspaceStore((s) => s.toggleRefine);
  const addCorrection = useWorkspaceStore((s) => s.addCorrection);

  const [msgs, setMsgs] = useState<Msg[]>([
    {
      id: "m-0",
      role: "agent",
      text: `Tell me what's off — a node, a step, a system, or an exception I missed. I'll capture it as a correction with high-priority evidence.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);

  function submit() {
    const text = input.trim();
    if (!text) return;
    const userMsg: Msg = { id: `m-${Date.now()}`, role: "user", text };
    setMsgs((prev) => [...prev, userMsg]);
    setInput("");
    setThinking(true);
    setTimeout(() => {
      // Heuristic: which node does the user mention?
      const lc = text.toLowerCase();
      const targetNode =
        (lc.includes("approval") && "n-4") ||
        (lc.includes("entry") && "n-6") ||
        (lc.includes("brief") && "n-9") ||
        (lc.includes("error") && "n-8") ||
        "n-3";
      addCorrection(targetNode);
      setMsgs((prev) => [
        ...prev,
        {
          id: `m-${Date.now() + 1}`,
          role: "agent",
          text: `Captured. I've added that as a user_correction evidence row on the affected node and marked it on the canvas. It supersedes the prior synthesized claim and will be used when the map is regenerated.`,
        },
      ]);
      setThinking(false);
    }, 900);
  }

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-ink/10 transition-opacity",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => toggle(false)}
      />
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-[440px] flex-col border-l border-subtle bg-surface shadow-pop transition-transform",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-start justify-between border-b border-subtle px-5 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              Refine Process
            </div>
            <div className="mt-1 text-[14.5px] font-semibold tracking-tight text-ink">
              Tell {BRAND.name} what to correct
            </div>
          </div>
          <button
            type="button"
            onClick={() => toggle(false)}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-muted hover:text-ink"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-[13px]">
          {msgs.map((m) => (
            <div
              key={m.id}
              className={cn(
                "flex",
                m.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 leading-snug",
                  m.role === "user"
                    ? "bg-ink text-canvas"
                    : "border border-subtle bg-canvas text-ink-secondary",
                )}
              >
                {m.text}
              </div>
            </div>
          ))}
          {thinking && (
            <div className="flex justify-start">
              <div className="rounded-lg border border-subtle bg-canvas px-3 py-2.5">
                <AnimatedDots />
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-subtle px-5 py-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder="e.g. The approval step also requires legal review for top-15 suppliers."
              className="flex-1 resize-none rounded-md border border-subtle bg-canvas px-3 py-2 text-[13px] leading-snug text-ink placeholder:text-ink-muted focus:border-ink-muted focus:outline-none"
            />
            <Button onClick={submit} size="md" disabled={!input.trim() || thinking}>
              Send
            </Button>
          </div>
          <div className="mt-1.5 text-[10.5px] text-ink-muted">
            ↵ to send · ⇧ + ↵ for newline. Corrections create user_correction evidence rows with confidence 1.0.
          </div>
        </div>
      </aside>
    </>
  );
}
