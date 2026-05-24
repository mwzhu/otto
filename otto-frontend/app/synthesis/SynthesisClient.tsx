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

export default function SynthesisClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp.get("next") ?? "/overview";

  const [idx, setIdx] = useState(0);
  const done = idx >= STAGES.length;

  useEffect(() => {
    if (idx >= STAGES.length) {
      const t = setTimeout(() => router.push(next), 900);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setIdx((i) => i + 1), STAGE_MS);
    return () => clearTimeout(t);
  }, [idx, next, router]);

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-6">
      <div className="flex w-full max-w-[520px] flex-col items-center gap-6">
        <GradientMark variant="loops" size={120} />
        <div className="text-center">
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">
            {done ? "Draft ready" : `${BRAND.name} is synthesizing`}
          </h1>
          <p className="mt-1 text-[12.5px] text-ink-secondary">
            {done
              ? "Your process map is ready for review."
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
