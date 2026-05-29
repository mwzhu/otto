"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function CaptureControls({
  onMuteChange,
  onPauseChange,
  onComplete,
  processId,
}: {
  onMuteChange?: (muted: boolean) => Promise<void> | void;
  onPauseChange: (paused: boolean) => void;
  onComplete?: () => Promise<void> | void;
  processId: string;
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
        onClick={() => {
          setMuted((current) => {
            const next = !current;
            void Promise.resolve(onMuteChange?.(next)).catch((err) => {
              setError(
                err instanceof Error
                  ? err.message
                  : "Could not update microphone state.",
              );
            });
            return next;
          });
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
        onClick={() => {
          setPaused((p) => {
            onPauseChange(!p);
            return !p;
          });
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
              `/synthesis?next=${encodeURIComponent(
                `/process/${processId}/workspace`,
              )}`,
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

function formatTime(s: number) {
  const m = Math.floor(s / 60)
    .toString()
    .padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}
