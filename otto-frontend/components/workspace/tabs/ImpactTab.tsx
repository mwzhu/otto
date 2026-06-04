"use client";

import { Pill } from "@/components/ui/Pill";
import { fmtUSD } from "@/lib/roi";
import type { ROIAssumptions } from "@/lib/types";

export type ImpactOpportunity = {
  id: string;
  title: string;
  proposed_solution: string;
  pattern_label: string;
  evidence_label: string;
  net_score?: number;
  gross_value?: number;
  assumptions: ROIAssumptions;
};

export function ImpactTab({
  processId: _processId,
  opportunities = [],
  source,
}: {
  processId?: string;
  opportunities?: ImpactOpportunity[];
  source?: "agent" | "heuristic";
}) {
  if (opportunities.length === 0) {
    return (
      <div className="px-5 py-5 text-[13px] text-ink-secondary">
        Impact metrics will appear after real ROI assumptions are captured.
      </div>
    );
  }

  return (
    <div className="space-y-3 px-5 py-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[14px] font-semibold tracking-tight text-ink">
          Automation impact
        </h3>
        {source && <Pill tone={source === "agent" ? "success" : "neutral"}>{source}</Pill>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Metric label="Top net score" value={fmtUSD(opportunities[0].net_score ?? 0)} />
        <Metric label="Gross value" value={fmtUSD(opportunities[0].gross_value ?? 0)} />
      </div>
      <div className="space-y-2">
        {opportunities.slice(0, 5).map((opportunity) => (
          <article
            key={opportunity.id}
            className="rounded-md border border-subtle bg-canvas px-3 py-2.5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium leading-snug text-ink">
                  {opportunity.title}
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                  {opportunity.proposed_solution}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[13px] font-semibold tabular-nums text-ink">
                  {fmtUSD(opportunity.net_score ?? 0)}
                </div>
                <div className="text-[10.5px] text-ink-muted">
                  {(opportunity.assumptions.confidence * 100).toFixed(0)}% conf
                </div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Pill tone="neutral">{opportunity.pattern_label}</Pill>
              <Pill tone={opportunity.evidence_label.includes("Assumption") ? "warn" : "success"}>
                {opportunity.evidence_label}
              </Pill>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-subtle bg-muted px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <div className="mt-1 font-mono text-[13px] font-semibold tabular-nums text-ink">
        {value}
      </div>
    </div>
  );
}
