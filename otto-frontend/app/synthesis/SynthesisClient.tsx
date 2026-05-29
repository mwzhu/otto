"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GradientMark } from "@/components/brand/GradientMark";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/cn";

const STAGES = [
  "Loading session artifacts",
  "Document extraction",
  "Director inventory extraction",
  "Re-segmenting transcript",
  "Ontology normalization",
  "Operator graph build",
  "Gap & contradiction detection",
  "Variant merge",
  "Complexity & SPOF scoring",
  "ROI / opportunity scoring",
  "Narrative generation",
  "Publishing draft",
];

const STAGE_MS = 650;
const STATUS_POLL_MS = 1500;
const STATUS_TIMEOUT_MS = 60_000;

type SynthesisStatus = {
  latest_run: { status: string; stage: string | null } | null;
  overview: { process_count: number; has_partial_synthesis?: boolean };
  ready_for_overview: boolean;
  terminal: boolean;
};

export default function SynthesisClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp.get("next") ?? "/overview";
  const workspaceId = sp.get("workspace_id");
  const captureSessionId = sp.get("capture_session_id");

  const [idx, setIdx] = useState(0);
  const [status, setStatus] = useState<SynthesisStatus | null>(null);
  const [statusTimedOut, setStatusTimedOut] = useState(false);
  const animationDone = idx >= STAGES.length;
  const synthesisBlocked =
    status?.terminal === true && status.ready_for_overview !== true;
  const backendDone =
    status?.ready_for_overview === true ||
    (!captureSessionId && !synthesisBlocked && statusTimedOut);
  const done = animationDone && backendDone;

  useEffect(() => {
    if (done) {
      const t = setTimeout(
        () =>
          router.push(
            appendCaptureContextToOverview(next, {
              captureSessionId,
              workspaceId,
            }),
          ),
        900,
      );
      return () => clearTimeout(t);
    }
    if (idx >= STAGES.length) return;
    const t = setTimeout(() => setIdx((i) => i + 1), STAGE_MS);
    return () => clearTimeout(t);
  }, [captureSessionId, done, idx, next, router, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    async function poll() {
      try {
        const params = new URLSearchParams();
        if (workspaceId) params.set("workspace_id", workspaceId);
        if (captureSessionId) params.set("capture_session_id", captureSessionId);
        const query = params.toString();
        const statusUrl = query ? `/api/synthesis/status?${query}` : "/api/synthesis/status";
        const response = await fetch(statusUrl, { cache: "no-store" });
        if (response.ok) {
          const nextStatus = (await response.json()) as SynthesisStatus;
          if (cancelled) return;
          setStatus(nextStatus);
          if (nextStatus.ready_for_overview || nextStatus.terminal) return;
        }
      } catch {
        // The timed local fallback below still gets the user to the overview.
      }
      if (cancelled) return;
      if (Date.now() - startedAt >= STATUS_TIMEOUT_MS) {
        setStatusTimedOut(true);
        return;
      }
      timeout = setTimeout(poll, STATUS_POLL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [captureSessionId, workspaceId]);

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-6">
      <div className="flex w-full max-w-[520px] flex-col items-center gap-6">
        <GradientMark variant="loops" size={120} />
        <div className="text-center">
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">
            {synthesisBlocked
              ? "Synthesis needs attention"
              : done
                ? "Draft ready"
                : `${BRAND.name} is synthesizing`}
          </h1>
          <p className="mt-1 text-[12.5px] text-ink-secondary">
            {synthesisBlocked
              ? "The latest synthesis run finished without an overview. Check the run before opening the process map."
              : done
              ? "Your process map is ready for review."
              : animationDone && !backendDone
                ? "Waiting for the latest synthesis run to finish."
                : "Turning captures into a versioned, evidence-anchored map."}
          </p>
        </div>
        <ol className="w-full space-y-2 rounded-lg border border-subtle bg-surface p-4 shadow-card">
          {STAGES.map((s, i) => {
            const state =
              i < idx ? "done" : i === idx ? "active" : "pending";
            return (
              <li
                key={s}
                className={cn(
                  "flex items-center gap-3 text-[12.5px] transition-colors",
                  state === "active"
                    ? "text-ink"
                    : state === "done"
                      ? "text-ink-secondary"
                      : "text-ink-muted",
                )}
              >
                <StageIcon state={state} />
                <span
                  className={cn(
                    "font-mono text-[10.5px] tabular-nums",
                    state === "done" ? "opacity-70" : "",
                  )}
                >
                  Stage {(i + 1).toString().padStart(2, "0")}
                </span>
                <span className="font-medium">{s}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function appendCaptureContextToOverview(
  next: string,
  context: { captureSessionId: string | null; workspaceId: string | null },
) {
  if (!next.startsWith("/overview")) return next;
  const [path, query = ""] = next.split("?");
  const params = new URLSearchParams(query);
  if (context.captureSessionId) {
    params.set("capture_session_id", context.captureSessionId);
  }
  if (context.workspaceId) {
    params.set("workspace_id", context.workspaceId);
  }
  const nextQuery = params.toString();
  return nextQuery ? `${path}?${nextQuery}` : path;
}

function StageIcon({ state }: { state: "done" | "active" | "pending" }) {
  if (state === "done") {
    return (
      <span className="grid size-4 place-items-center rounded-full bg-status-success text-canvas">
        <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 5l2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (state === "active") {
    return (
      <span className="grid size-4 place-items-center">
        <span className="size-2 animate-pulse rounded-full bg-ink" />
      </span>
    );
  }
  return <span className="size-4 rounded-full border border-subtle" />;
}
