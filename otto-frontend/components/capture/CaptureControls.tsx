"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function CaptureControls({
  onMuteChange,
  onPauseChange,
  onComplete,
  processId,
  workspaceId,
  captureSessionId,
}: {
  onMuteChange?: (muted: boolean) => Promise<void> | void;
  onPauseChange: (paused: boolean) => Promise<void> | void;
  onComplete?: () => Promise<void> | void;
  processId: string;
  workspaceId?: string;
  captureSessionId?: string;
}) {
  const router = useRouter();
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [paused]);

  return (
    <div className="flex items-center justify-center gap-3">
      <span className="inline-flex items-center gap-2 rounded-full bg-status-success/10 px-3 py-1.5 text-[11.5px] font-medium text-status-success">
        <span className="inline-flex size-2 animate-pulse rounded-full bg-status-success" />
        Recording in progress
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          const previous = muted;
          const next = !previous;
          setMuted(next);
          setError(null);
          try {
            await onMuteChange?.(next);
          } catch (err) {
            setMuted(previous);
            setError(
              err instanceof Error
                ? err.message
                : "Could not update microphone state.",
            );
          }
        }}
      >
        {muted ? "Unmute" : "Mute"}
      </Button>
      <span className="font-mono text-[12px] tabular-nums text-ink-secondary">
        {formatTime(elapsed)}
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          const previous = paused;
          const next = !previous;
          setPaused(next);
          setError(null);
          try {
            await onPauseChange(next);
          } catch (err) {
            setPaused(previous);
            setError(
              err instanceof Error
                ? err.message
                : "Could not update pause state.",
            );
          }
        }}
      >
        {paused ? "Resume" : "Pause Interview"}
      </Button>
      <Button
        size="sm"
        disabled={completing}
        onClick={async () => {
          setCompleting(true);
          setError(null);
          try {
            await onComplete?.();
            router.push(
              synthesisHref({
                next: `/process/${processId}/workspace`,
                workspaceId,
                captureSessionId,
              }),
            );
          } catch (err) {
            setError(
              err instanceof Error
                ? err.message
                : "Could not complete the interview.",
            );
          } finally {
            setCompleting(false);
          }
        }}
      >
        {completing ? "Completing" : "Complete Interview"}
      </Button>
      {error && (
        <span className="max-w-[220px] text-[11px] text-danger">{error}</span>
      )}
    </div>
  );
}

function synthesisHref(input: {
  next: string;
  workspaceId?: string;
  captureSessionId?: string;
}) {
  const params = new URLSearchParams({ next: input.next });
  if (input.workspaceId) params.set("workspace_id", input.workspaceId);
  if (input.captureSessionId) {
    params.set("capture_session_id", input.captureSessionId);
  }
  return `/synthesis?${params.toString()}`;
}

function formatTime(s: number) {
  const m = Math.floor(s / 60)
    .toString()
    .padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}
