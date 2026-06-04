"use client";

import { useState } from "react";
import type { Opportunity, ROIAssumptions } from "@/lib/types";
import { computeROI, fmtUSD } from "@/lib/roi";
import { cn } from "@/lib/cn";
import { Pill } from "@/components/ui/Pill";
import { ConfidenceBadge } from "@/components/common/ConfidenceBadge";
import { EvidenceLink } from "@/components/common/EvidenceLink";

const OPERATIONAL_FIELDS: { key: keyof ROIAssumptions; label: string; suffix?: string; type: "int" | "pct" }[] =
  [
    { key: "annual_volume", label: "Annual volume", suffix: "/yr", type: "int" },
    { key: "minutes_saved_per_case", label: "Minutes saved / case", suffix: "min", type: "int" },
    { key: "error_rate", label: "Error rate", type: "pct" },
    { key: "exception_rate", label: "Exception rate", type: "pct" },
    { key: "confidence", label: "Confidence", type: "pct" },
    { key: "effort_penalty", label: "Effort penalty (>=1)", type: "int" },
  ];

type EditorOpportunity = Opportunity & {
  current_state?: string;
  evidence_ids?: string[];
  evidence_label?: string;
  opportunity_set_key?: string;
};

export function ROIAssumptionEditor({
  opportunity,
  processId,
  workspaceId,
  versionId,
  opportunitySetKey,
}: {
  opportunity: EditorOpportunity;
  processId?: string;
  workspaceId?: string;
  versionId?: string;
  opportunitySetKey?: string;
}) {
  const [a, setA] = useState<ROIAssumptions>(opportunity.assumptions);
  const roi = computeROI(a);
  const [expanded, setExpanded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const resolvedOpportunitySetKey = opportunitySetKey ?? opportunity.opportunity_set_key;
  const canSave = Boolean(processId && workspaceId && versionId && resolvedOpportunitySetKey);

  async function saveAssumptions() {
    if (!processId || !workspaceId || !versionId || !resolvedOpportunitySetKey) return;
    setSaveState("saving");
    try {
      const response = await fetch(
        `/api/processes/${processId}/opportunities/${opportunity.id}/assumptions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            workspace_id: workspaceId,
            version_id: versionId,
            opportunity_set_key: resolvedOpportunitySetKey,
            assumptions: operationalAssumptions(a),
          }),
        },
      );
      if (!response.ok) throw new Error("Failed to save assumptions.");
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  return (
    <article className="rounded-lg border border-subtle bg-surface p-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[14.5px] font-semibold tracking-tight text-ink">
              {opportunity.title}
            </h3>
            <Pill tone="neutral">pattern · {opportunity.pattern_label}</Pill>
            <ConfidenceBadge value={a.confidence} />
          </div>
          <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-ink-secondary">
            <strong className="font-medium text-ink">Problem.</strong>{" "}
            {opportunity.problem}
          </p>
          {opportunity.current_state && (
            <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-ink-secondary">
              <strong className="font-medium text-ink">Current.</strong>{" "}
              {opportunity.current_state}
            </p>
          )}
          <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-ink-secondary">
            <strong className="font-medium text-ink">Proposed.</strong>{" "}
            {opportunity.proposed_solution}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Net score (annual)
          </div>
          <div className="text-[22px] font-semibold tabular-nums tracking-tight text-ink">
            {fmtUSD(roi.net_score)}
          </div>
          <div className="text-[11px] text-ink-muted">
            Gross {fmtUSD(roi.gross_value)} · confidence {(a.confidence * 100).toFixed(0)}%
          </div>
        </div>
      </header>

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[12px] font-medium text-ink-secondary underline-offset-2 hover:underline"
        >
          {expanded ? "Hide assumptions" : "Edit assumptions"}
        </button>
        {opportunity.claim_ids[0] && (
          <EvidenceLink claimId={opportunity.claim_ids[0]} />
        )}
      </div>

      <div
        className={cn(
          "mt-3 grid gap-3 overflow-hidden transition-[max-height]",
          expanded ? "max-h-[600px]" : "max-h-0",
        )}
      >
        <div className="grid gap-3 rounded-md bg-muted p-3 text-[12px] sm:grid-cols-2 lg:grid-cols-3">
          {OPERATIONAL_FIELDS.map((f) => {
            const raw = a[f.key];
            const display = f.type === "pct"
              ? `${(Number(raw) * 100).toFixed(0)}`
              : Number(raw).toString();
            return (
              <label key={f.key} className="block">
                <span className="block font-mono text-[10px] uppercase tracking-wide text-ink-muted">
                  {f.key}
                </span>
                <span className="mt-0.5 block text-[11px] text-ink-secondary">
                  {f.label}
                </span>
                <div className="mt-1 flex items-center gap-1">
                  <input
                    type="number"
                    value={display}
                    step={f.type === "pct" ? 1 : 1}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      const next =
                        f.type === "pct" ? Math.max(0, v) / 100 : v;
                      setA((prev) => ({ ...prev, [f.key]: next }));
                      setSaveState("idle");
                    }}
                    className="w-full rounded-md border border-subtle bg-surface px-2 py-1.5 text-[12.5px] font-medium tabular-nums text-ink focus:border-ink-muted focus:outline-none"
                  />
                  <span className="text-[10.5px] text-ink-muted">
                    {f.type === "pct" ? "%" : f.suffix}
                  </span>
                </div>
              </label>
            );
          })}
        </div>
        <div className="grid gap-3 rounded-md border border-subtle p-3 text-[11.5px] sm:grid-cols-3">
          <Calc label="Hourly cost" value={fmtUSD(a.loaded_hourly_cost)} />
          <Calc label="Cost per error" value={fmtUSD(a.cost_per_error)} />
          <Calc label="Delay cost" value={fmtUSD(a.delay_cost)} />
        </div>
        <div className="grid grid-cols-3 gap-3 rounded-md border border-subtle p-3 text-[11.5px]">
          <Calc label="Time value" value={fmtUSD(roi.annual_time_value)} />
          <Calc label="Error value" value={fmtUSD(roi.annual_error_value)} />
          <Calc label="Delay value" value={fmtUSD(roi.annual_delay_value)} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] text-ink-muted">
            {saveState === "saved"
              ? "Saved"
              : saveState === "error"
                ? "Save failed"
                : canSave
                  ? "Unsaved edits update the score locally."
                  : "Open from a published workflow version to save edits."}
          </div>
          <button
            type="button"
            onClick={saveAssumptions}
            disabled={!canSave || saveState === "saving"}
            className="rounded-md border border-ink bg-ink px-3 py-1.5 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:border-subtle disabled:bg-muted disabled:text-ink-muted"
          >
            {saveState === "saving" ? "Saving" : "Save"}
          </button>
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
        {opportunity.integration_requirements.map((r) => (
          <Pill key={r} tone="system">
            {r}
          </Pill>
        ))}
        {opportunity.dependencies.map((d) => (
          <Pill key={d} tone="warn">
            dep · {d}
          </Pill>
        ))}
      </dl>
    </article>
  );
}

function operationalAssumptions(a: ROIAssumptions) {
  return {
    annual_volume: a.annual_volume,
    minutes_saved_per_case: a.minutes_saved_per_case,
    error_rate: a.error_rate,
    exception_rate: a.exception_rate,
    confidence: a.confidence,
    effort_penalty: a.effort_penalty,
  };
}

function Calc({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <div className="font-mono text-[13px] tabular-nums font-medium text-ink">
        {value}
      </div>
    </div>
  );
}
