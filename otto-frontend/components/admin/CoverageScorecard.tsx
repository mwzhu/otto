"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { type DirectorCoverage } from "@/lib/admin/coverage-types";
import { Pill } from "@/components/ui/Pill";

export function CoverageScorecard({ coverage }: { coverage: DirectorCoverage }) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setAnimated(true), 60);
    return () => clearTimeout(t);
  }, []);

  const pct =
    coverage.summary.totalSlots === 0
      ? 0
      : Math.round(
          ((coverage.summary.filled + coverage.summary.partial * 0.5) /
            coverage.summary.totalSlots) *
            100,
        );
  const healthTone =
    coverage.telemetry.failedSynthesisRuns > 0 ||
    coverage.telemetry.degradedTurns > 0
      ? "danger"
      : coverage.telemetry.partialSynthesisRuns > 0
        ? "warn"
        : "success";

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Slot coverage" value={`${pct}%`} />
        <Metric label="Open follow-ups" value={coverage.summary.openFollowUps} />
        <Metric label="Evidence links" value={coverage.summary.evidenceCount} />
        <Metric
          label="Avg confidence"
          value={`${coverage.summary.averageConfidence}%`}
        />
      </section>

      <section className="rounded-lg border border-subtle bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-semibold tracking-tight text-ink">
              Interview coverage by slot category
            </h3>
            <p className="mt-1 text-[12px] text-ink-secondary">
              FDE-visible matrix from persisted slot states for the active workspace.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill tone="success">{coverage.summary.filled} filled</Pill>
            <Pill tone="warn">{coverage.summary.partial} partial</Pill>
            <Pill tone="danger">{coverage.summary.conflicting} conflicting</Pill>
            <Pill tone="neutral">{coverage.summary.missing} missing</Pill>
          </div>
        </div>
        <ul className="mt-4 space-y-2">
          {coverage.slots.map((row) => {
            const score = slotScore(row.status);
            const tone =
              row.status === "filled"
                ? "bg-success"
                : row.status === "partial" || row.status === "asked_unknown"
                  ? "bg-warn"
                  : row.status === "conflicting" ||
                      row.status === "pending_re_extract"
                    ? "bg-danger"
                    : "bg-ink-muted";
            return (
              <li key={`${row.candidateProcessId ?? "global"}:${row.slotPath}`}>
                <div className="flex items-baseline justify-between text-[12.5px]">
                  <div>
                    <span className="font-medium text-ink">{row.label}</span>
                    {row.processName ? (
                      <span className="ml-2 text-[11px] text-ink-muted">
                        {row.processName}
                      </span>
                    ) : null}
                    {row.openFollowUps ? (
                      <span className="ml-2 text-[11px] text-ink-muted">
                        {row.openFollowUps} open
                      </span>
                    ) : null}
                    {row.status === "conflicting" ? (
                      <span className="ml-2 text-[11px] text-complexity-high-ink">
                        conflict
                      </span>
                    ) : null}
                    {row.status === "pending_re_extract" ? (
                      <span className="ml-2 text-[11px] text-complexity-high-ink">
                        re-extract
                      </span>
                    ) : null}
                  </div>
                  <span className="font-mono text-[12px] tabular-nums text-ink">
                    {row.status.replaceAll("_", " ")} -{" "}
                    {Math.round(row.confidence * 100)}%
                  </span>
                </div>
                <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out",
                      tone,
                    )}
                    style={{ width: animated ? `${score}%` : "0%" }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-lg border border-subtle bg-surface p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-semibold tracking-tight text-ink">
              Phase 1 telemetry
            </h3>
            <p className="mt-1 text-[12px] text-ink-secondary">
              Cost, cache, latency, and synthesis health from agent decision logs.
            </p>
          </div>
          <Pill tone={healthTone}>
            {coverage.telemetry.latestSynthesisStatus ?? "no synthesis yet"}
          </Pill>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Telemetry label="Decisions" value={coverage.telemetry.decisionCount} />
          <Telemetry
            label="Observed cost"
            value={`${coverage.telemetry.totalCostCents.toFixed(3)}c`}
          />
          <Telemetry
            label="Cache hit rate"
            value={`${coverage.telemetry.cacheHitRate}%`}
          />
          <Telemetry
            label="p95 latency"
            value={`${coverage.telemetry.p95LatencyMs}ms`}
          />
        </div>
        {coverage.telemetry.degradedTurns ||
        coverage.telemetry.failedSynthesisRuns ||
        coverage.telemetry.partialSynthesisRuns ? (
          <div className="mt-4 rounded-md border border-complexity-high-bg bg-complexity-high-bg/40 px-3 py-2 text-[12px] text-complexity-high-ink">
            {coverage.telemetry.degradedTurns} degraded turns,{" "}
            {coverage.telemetry.failedSynthesisRuns} failed synthesis runs, and{" "}
            {coverage.telemetry.partialSynthesisRuns} partial synthesis runs need
            review.
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-subtle bg-surface p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <div className="mt-2 font-mono text-[20px] tabular-nums text-ink">
        {value}
      </div>
    </div>
  );
}

function Telemetry({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md bg-muted px-3 py-2">
      <div className="text-[11px] text-ink-muted">{label}</div>
      <div className="mt-1 font-mono text-[13px] tabular-nums text-ink">
        {value}
      </div>
    </div>
  );
}

function slotScore(status: string) {
  if (status === "filled") return 100;
  if (status === "partial") return 55;
  if (status === "asked_unknown") return 35;
  if (status === "conflicting") return 35;
  if (status === "pending_re_extract") return 20;
  return 8;
}
