"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtNum, fmtUSD } from "@/lib/roi";
import type { ROIRange } from "@/lib/roi";
import type {
  DepartmentAutomationOpportunity,
  DepartmentAutomationPlan,
} from "@/lib/overview/automation";

export function AutomationTab({
  plan,
  workspaceId,
  captureSessionId,
}: {
  plan: DepartmentAutomationPlan;
  workspaceId: string;
  captureSessionId?: string | null;
}) {
  if (plan.opportunityCount === 0) {
    return (
      <div className="space-y-4">
        <section className="rounded-lg border border-subtle bg-surface p-6">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Automation
          </div>
          <h2 className="mt-1 text-[20px] font-semibold tracking-tight text-ink">
            Department automation ROI is not ready yet
          </h2>
          <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-ink-secondary">
            {emptyStateCopy(plan)}
          </p>
          {plan.planState === "none" && (
            <GeneratePlanButton
              workspaceId={workspaceId}
              captureSessionId={captureSessionId}
            />
          )}
        </section>
        <StatusBanner
          plan={plan}
          workspaceId={workspaceId}
          captureSessionId={captureSessionId}
        />
        <Audit audit={plan.audit} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-subtle bg-surface p-6">
        <StatusBanner
          plan={plan}
          workspaceId={workspaceId}
          captureSessionId={captureSessionId}
        />
        <h2 className="text-[22px] font-semibold tracking-tight text-ink">
          {plan.departmentName} Automation Plan
        </h2>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <ImpactMetric
            label={
              plan.metrics.annualNetValueRange
                ? "Net annual value range"
                : "Net annual value"
            }
            value={fmtUSDValue(
              plan.metrics.annualNetValueRange ?? plan.metrics.annualNetValue,
            )}
            emphasis
          />
          <ImpactMetric
            label="Hours saved"
            value={fmtNumValue(
              plan.metrics.annualHoursSavedRange ?? plan.metrics.annualHoursSaved,
            )}
            suffix="/yr"
          />
          <ImpactMetric
            label="Processes automated"
            value={fmtNum(plan.opportunityCount)}
          />
        </div>
      </section>

      <Audit audit={plan.audit} />

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight text-ink">
              Automation plan
            </h3>
            <p className="mt-1 text-[12.5px] text-ink-secondary">
              Ranked by annual net value, with the agent automation and
              expected business result for each process.
            </p>
          </div>
        </div>
        <div className="grid gap-3">
          {plan.topOpportunities.map((opportunity, index) => (
            <OpportunityRow
              key={`${opportunity.processId}:${opportunity.id}`}
              opportunity={opportunity}
              rank={index + 1}
            />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-subtle bg-surface p-5">
        <h3 className="text-[15px] font-semibold tracking-tight text-ink">
          ROI calculation breakdown
        </h3>
        <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-ink-secondary">
          Value is shown as low-base-high planning ranges. The model uses
          department-specific process volume, minutes saved, error rate,
          exception rate, confidence, effort band, and workspace ROI prices.
        </p>
        <div className="mt-4 overflow-hidden rounded-md border border-subtle">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead className="bg-muted text-[10.5px] uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Value driver</th>
                <th className="px-3 py-2 font-semibold">Amount</th>
                <th className="px-3 py-2 font-semibold">Methodology</th>
              </tr>
            </thead>
            <tbody>
              <CalcRow
                label={roiLabel(plan, "time")}
                amount={fmtUSDValue(
                  plan.metrics.annualTimeValueRange ?? plan.metrics.annualTimeValue,
                )}
                methodology={roiMethodology(plan, "time")}
              />
              <CalcRow
                label={roiLabel(plan, "error")}
                amount={fmtUSDValue(
                  plan.metrics.annualErrorValueRange ?? plan.metrics.annualErrorValue,
                )}
                methodology={roiMethodology(plan, "error")}
              />
              <CalcRow
                label={roiLabel(plan, "delay")}
                amount={fmtUSDValue(
                  plan.metrics.annualDelayValueRange ?? plan.metrics.annualDelayValue,
                )}
                methodology={roiMethodology(plan, "delay")}
              />
              <CalcRow
                label="Confidence & effort adjustment"
                amount={`(${fmtUSDValue(roiAdjustment(plan))})`}
                methodology="Gross modeled value discounted out by each opportunity's confidence and delivery effort band. Shown in parentheses because it reduces the total."
              />
              <CalcRow
                label={`Net realized value (${plan.departmentName})`}
                amount={fmtUSDValue(
                  plan.metrics.annualNetValueRange ?? plan.metrics.annualNetValue,
                )}
                methodology="Manual effort removed + error reduction + delay reduction, less the confidence & effort adjustment — the realized value after discounting each opportunity."
              />
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Audit({ audit }: { audit: DepartmentAutomationPlan["audit"] }) {
  return (
    <section className="rounded-lg border border-subtle bg-surface p-6">
      <h3 className="text-[15px] font-semibold tracking-tight text-ink">
        Audit Findings
      </h3>

      <div className="mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          Problem
        </div>
        <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-ink-secondary">
          {audit.problem}
        </p>
      </div>

      {audit.patterns.length > 0 && (
        <div className="mt-5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Systemic patterns
          </div>
          <ul className="mt-2 space-y-2.5">
            {audit.patterns.map((pattern) => (
              <li
                key={`${pattern.text}:${pattern.metricBasis ?? ""}`}
                className="flex gap-2.5 text-[13px] leading-relaxed text-ink-secondary"
              >
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-muted" />
                <span>{pattern.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function OpportunityRow({
  opportunity,
  rank,
}: {
  opportunity: DepartmentAutomationOpportunity;
  rank: number;
}) {
  return (
    <article className="rounded-lg border border-subtle bg-surface p-5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-semibold tabular-nums text-canvas">
          {rank}
        </span>
        <h4 className="text-[15px] font-semibold tracking-tight text-ink">
          {opportunity.processName}
        </h4>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-subtle bg-canvas p-4">
          <div className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-muted">
            Implementation plan
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
            {opportunity.implementationPlan}
          </p>
        </div>
        <div className="rounded-lg border border-subtle bg-canvas p-4">
          <div className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-muted">
            Expected result
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
            {opportunity.expectedResult} {opportunity.hoursSavedRange ? "Modeled range" : "Modeled impact"}:{" "}
            {fmtNumValue(opportunity.hoursSavedRange ?? opportunity.hoursSaved)} hrs saved / yr;{" "}
            {fmtUSDValue(opportunity.grossValueRange ?? opportunity.grossValue)} gross impact at{" "}
            {Math.round(opportunity.assumptions.confidence * 100)}% confidence.
          </p>
        </div>
      </div>

      {opportunity.assumptionRanges && opportunity.assumptionDetails && (
        <Assumptions opportunity={opportunity} />
      )}
    </article>
  );
}

function ImpactMetric({
  label,
  value,
  suffix,
  emphasis,
}: {
  label: string;
  value: string;
  suffix?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-md border border-subtle bg-canvas px-4 py-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className={[
            "text-[24px] font-semibold tabular-nums tracking-tight",
            emphasis ? "text-complexity-high-ink" : "text-ink",
          ].join(" ")}
        >
          {value}
        </span>
        {suffix && <span className="text-[12px] text-ink-muted">{suffix}</span>}
      </div>
    </div>
  );
}

function CalcRow({
  label,
  amount,
  methodology,
}: {
  label: string;
  amount: string;
  methodology: string;
}) {
  return (
    <tr className="border-t border-subtle">
      <td className="px-3 py-3 font-medium text-ink">{label}</td>
      <td className="px-3 py-3 font-mono font-semibold tabular-nums text-ink">
        {amount}
      </td>
      <td className="px-3 py-3 leading-relaxed text-ink-secondary">
        {methodology}
      </td>
    </tr>
  );
}

function Assumptions({
  opportunity,
}: {
  opportunity: DepartmentAutomationOpportunity;
}) {
  const ranges = opportunity.assumptionRanges;
  const details = opportunity.assumptionDetails;
  if (!ranges || !details) return null;
  return (
    <div className="mt-4 grid gap-2 md:grid-cols-4">
      <AssumptionPill
        label="Annual volume"
        value={`${fmtNumValue(ranges.annual_volume)} cases`}
      />
      <AssumptionPill
        label="Minutes saved"
        value={`${fmtNumValue(ranges.minutes_saved_per_case)} min/case`}
      />
      <AssumptionPill
        label="Error rate"
        value={percentRange(ranges.error_rate)}
      />
      <AssumptionPill
        label="Exception rate"
        value={percentRange(ranges.exception_rate)}
      />
    </div>
  );
}

function AssumptionPill({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-subtle bg-canvas px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <div className="mt-1 font-mono text-[12.5px] font-semibold tabular-nums text-ink">
        {value}
      </div>
    </div>
  );
}

function StatusBanner({
  plan,
  workspaceId,
  captureSessionId,
}: {
  plan: DepartmentAutomationPlan;
  workspaceId: string;
  captureSessionId?: string | null;
}) {
  const state = plan.refreshState ?? plan.planState;
  const [retrying, setRetrying] = useState(false);
  const router = useRouter();
  if (state !== "pending" && state !== "running" && state !== "failed") {
    return null;
  }
  const copy =
    state === "failed"
      ? "Latest director automation refresh failed. Showing the last completed plan where available."
      : plan.opportunityCount > 0
        ? "A director automation refresh is running. Showing the latest completed plan for now."
        : "Director automation plan generation is running. This tab will populate once the plan is complete.";
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    const response = await fetch(
      `/api/automation-plan/status?${planRequestParams(workspaceId, captureSessionId)}`,
      { method: "POST" },
    );
    setRetrying(false);
    if (response.ok) router.refresh();
  };
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-subtle bg-canvas px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
      <span>{copy}</span>
      {state === "failed" && (
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          className="shrink-0 rounded-md border border-subtle bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink disabled:opacity-60"
        >
          {retrying ? "Retrying..." : "Retry"}
        </button>
      )}
    </div>
  );
}

function GeneratePlanButton({
  workspaceId,
  captureSessionId,
}: {
  workspaceId: string;
  captureSessionId?: string | null;
}) {
  const [requesting, setRequesting] = useState(false);
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  const generate = async () => {
    if (requesting) return;
    setRequesting(true);
    setFailed(false);
    const response = await fetch(
      `/api/automation-plan/status?${planRequestParams(workspaceId, captureSessionId)}`,
      { method: "POST" },
    );
    setRequesting(false);
    if (response.ok) {
      router.refresh();
    } else {
      setFailed(true);
    }
  };
  return (
    <div className="mt-4 flex items-center gap-3">
      <button
        type="button"
        onClick={generate}
        disabled={requesting}
        className="rounded-md border border-subtle bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink disabled:opacity-60"
      >
        {requesting ? "Requesting..." : "Generate automation plan"}
      </button>
      {failed && (
        <span className="text-[12px] text-ink-secondary">
          Could not start plan generation. Complete a director interview first,
          then try again.
        </span>
      )}
    </div>
  );
}

function planRequestParams(
  workspaceId: string,
  captureSessionId?: string | null,
) {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  if (captureSessionId) params.set("capture_session_id", captureSessionId);
  return params;
}

function emptyStateCopy(plan: DepartmentAutomationPlan) {
  if (plan.planState === "pending" || plan.planState === "running") {
    return "Otto is generating the director-led automation plan. Audit findings, automation-agent designs, and ROI ranges will appear here once the synthesis completes.";
  }
  if (plan.planState === "failed") {
    return "The latest director automation plan generation failed. Retry the director synthesis or review the captured inventory before presenting this tab.";
  }
  return "Complete a director interview to produce the department automation plan, then add operator captures for deeper workflow evidence on the highest-priority processes.";
}

function toRange(value: number | ROIRange): ROIRange {
  return typeof value === "number"
    ? { low: value, base: value, high: value }
    : value;
}

// The realized-value row applies a per-opportunity confidence/effort haircut,
// so the three gross drivers above it never summed to it. Derive the haircut
// from the exact ranges displayed (drivers - net) so the table reconciles at
// every bound: time + error + delay - adjustment = net realized value.
function roiAdjustment(plan: DepartmentAutomationPlan): ROIRange {
  const time = toRange(
    plan.metrics.annualTimeValueRange ?? plan.metrics.annualTimeValue,
  );
  const error = toRange(
    plan.metrics.annualErrorValueRange ?? plan.metrics.annualErrorValue,
  );
  const delay = toRange(
    plan.metrics.annualDelayValueRange ?? plan.metrics.annualDelayValue,
  );
  const net = toRange(
    plan.metrics.annualNetValueRange ?? plan.metrics.annualNetValue,
  );
  return {
    low: time.low + error.low + delay.low - net.low,
    base: time.base + error.base + delay.base - net.base,
    high: time.high + error.high + delay.high - net.high,
  };
}

function fmtUSDValue(value: number | ROIRange) {
  if (typeof value === "number") {
    return fmtUSD(value);
  }
  const low = fmtUSD(value.low);
  const high = fmtUSD(value.high);
  return low === high ? low : `${low}-${high}`;
}

function fmtNumValue(value: number | ROIRange) {
  if (typeof value === "number") {
    return fmtNum(Math.round(value));
  }
  const low = Math.round(value.low);
  const high = Math.round(value.high);
  return low === high ? fmtNum(low) : `${fmtNum(low)}-${fmtNum(high)}`;
}

function roiMethodology(
  plan: DepartmentAutomationPlan,
  driver: "time" | "error" | "delay",
) {
  const top = plan.topOpportunities[0];
  if (!top) {
    if (driver === "time") return "Annual volume x minutes saved per case x loaded hourly cost / 60.";
    if (driver === "error") return "Annual volume x error rate x cost per error.";
    return "Annual volume x exception rate x delay cost.";
  }
  if (driver === "time") {
    return `${top.processName}: ${rangeOrNumber(top.assumptionRanges?.annual_volume, top.assumptions.annual_volume)} cases x ${rangeOrNumber(top.assumptionRanges?.minutes_saved_per_case, top.assumptions.minutes_saved_per_case)} min saved/case x ${fmtUSD(top.assumptions.loaded_hourly_cost)}/hr, aggregated across ranked opportunities.`;
  }
  if (driver === "error") {
    return `${top.processName}: ${rangeOrNumber(top.assumptionRanges?.annual_volume, top.assumptions.annual_volume)} cases x ${percentRangeOrNumber(top.assumptionRanges?.error_rate, top.assumptions.error_rate)} error rate x ${fmtUSD(top.assumptions.cost_per_error)} error cost, aggregated across ranked opportunities.`;
  }
  return `${top.processName}: ${rangeOrNumber(top.assumptionRanges?.annual_volume, top.assumptions.annual_volume)} cases x ${percentRangeOrNumber(top.assumptionRanges?.exception_rate, top.assumptions.exception_rate)} exception rate x ${fmtUSD(top.assumptions.delay_cost)} delay cost, aggregated across ranked opportunities.`;
}

function roiLabel(
  plan: DepartmentAutomationPlan,
  driver: "time" | "error" | "delay",
) {
  const top = plan.topOpportunities[0];
  const scope = top?.processName ?? plan.departmentName;
  if (driver === "time") return `Manual effort removed (${scope})`;
  if (driver === "error") return `Error reduction (${scope})`;
  return `Exception delay reduction (${scope})`;
}

function rangeOrNumber(range: ROIRange | undefined, fallback: number) {
  if (!range) return fmtNum(Math.round(fallback));
  const low = Math.round(range.low);
  const high = Math.round(range.high);
  return low === high ? fmtNum(low) : `${fmtNum(low)}-${fmtNum(high)}`;
}

function percentRangeOrNumber(range: ROIRange | undefined, fallback: number) {
  if (!range) return `${Math.round(fallback * 100)}%`;
  const low = Math.round(range.low * 100);
  const high = Math.round(range.high * 100);
  return low === high ? `${low}%` : `${low}-${high}%`;
}

function percentRange(range: ROIRange) {
  const low = Math.round(range.low * 100);
  const high = Math.round(range.high * 100);
  return low === high ? `${low}%` : `${low}-${high}%`;
}
