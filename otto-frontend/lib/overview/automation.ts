import "server-only";

import { getCurrentProcessGraph } from "@/lib/processes/graph-queries";
import { getProcessOpportunities } from "@/lib/processes/opportunity-queries";
import type { ProcessOpportunitySource } from "@/lib/processes/opportunity-queries";
import { EFFORT_PENALTY_BY_BAND } from "@/lib/processes/opportunity-grounding";
import { computeRoiRange, type ROIRange, type ROIRangeAssumptions } from "@/lib/roi";
import {
  getDirectorAutomationPlanStatus,
  loadLatestDirectorAutomationPlan,
  type DirectorAutomationPlanRecord,
  type DirectorAutomationPlanStatus,
} from "@/lib/synthesis/director-automation";
import type { ProcessSummary, ROIAssumptions } from "@/lib/types";
import { getWorkspaceRoiPrices } from "@/lib/workspaces/roi-prices";

type DepartmentAutomationSource = ProcessOpportunitySource | "director";
type DepartmentAutomationPlanState = "ready" | "pending" | "running" | "failed" | "none";
type AssumptionBasis = "evidence" | "inferred";

export type DepartmentAutomationAssumptionDetail = {
  basis: AssumptionBasis;
  confidence: number;
  evidenceIds: string[];
};

export type DepartmentAutomationAuditPattern = {
  text: string;
  metricBasis?: string;
};

export type DepartmentAutomationOpportunity = {
  id: string;
  processId: string;
  processName: string;
  department: string;
  title: string;
  problem: string;
  proposedSolution: string;
  implementationPlan: string;
  expectedResult: string;
  currentState: string;
  targetState: string;
  patternLabel: string;
  evidenceLabel: string;
  integrationRequirements: string[];
  dependencies: string[];
  assumptions: ROIAssumptions;
  annualTimeValue: number;
  annualErrorValue: number;
  annualDelayValue: number;
  grossValue: number;
  netScore: number;
  hoursSaved: number;
  annualTimeValueRange?: ROIRange;
  annualErrorValueRange?: ROIRange;
  annualDelayValueRange?: ROIRange;
  grossValueRange?: ROIRange;
  netScoreRange?: ROIRange;
  hoursSavedRange?: ROIRange;
  assumptionRanges?: ROIRangeAssumptions;
  assumptionDetails?: {
    annual_volume: DepartmentAutomationAssumptionDetail;
    minutes_saved_per_case: DepartmentAutomationAssumptionDetail;
    error_rate: DepartmentAutomationAssumptionDetail;
    exception_rate: DepartmentAutomationAssumptionDetail;
  };
  source: DepartmentAutomationSource;
};

export type DepartmentAutomationPlan = {
  departmentName: string;
  processCount: number;
  processGraphCount: number;
  opportunityCount: number;
  source: DepartmentAutomationSource | "mixed" | "none";
  planState: DepartmentAutomationPlanState;
  refreshState:
    | Exclude<DirectorAutomationPlanStatus["run_state"], "completed" | "none">
    | null;
  updatedAt: string | null;
  topOpportunities: DepartmentAutomationOpportunity[];
  metrics: {
    annualNetValue: number;
    annualGrossValue: number;
    annualHoursSaved: number;
    annualTimeValue: number;
    annualErrorValue: number;
    annualDelayValue: number;
    averageConfidence: number;
    annualNetValueRange?: ROIRange;
    annualGrossValueRange?: ROIRange;
    annualHoursSavedRange?: ROIRange;
    annualTimeValueRange?: ROIRange;
    annualErrorValueRange?: ROIRange;
    annualDelayValueRange?: ROIRange;
  };
  audit: {
    problem: string;
    patterns: DepartmentAutomationAuditPattern[];
  };
};

export async function getDepartmentAutomationPlan(input: {
  orgId: string;
  workspaceId: string;
  departmentName: string;
  processes: ProcessSummary[];
  captureSessionId?: string | null;
}): Promise<DepartmentAutomationPlan> {
  const directorPlan = await loadLatestDirectorAutomationPlan({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    captureSessionId: input.captureSessionId,
  });
  const directorStatus = await getDirectorAutomationPlanStatus({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    captureSessionId: input.captureSessionId,
    completedPlan: directorPlan,
  });
  if (directorPlan) {
    return buildDirectorPlan({
      ...input,
      directorPlan,
      directorStatus,
    });
  }

  const processCards = input.processes.filter((process) => process.source === "process");
  const graphResults = await Promise.all(
    processCards.map(async (process) => {
      const graph = await getCurrentProcessGraph(input.orgId, input.workspaceId, process.id);
      if (!graph) return null;
      const result = await getProcessOpportunities({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        processId: process.id,
        graph,
      });
      return { process, graph, result };
    }),
  );

  const opportunities = graphResults
    .flatMap((item) => {
      if (!item) return [];
      if (item.result.source !== "agent") return [];
      return item.result.opportunities.map((opportunity) => {
        const assumptions = opportunity.assumptions;
        const hoursSaved =
          (assumptions.annual_volume * assumptions.minutes_saved_per_case) / 60;
        return {
          id: opportunity.id,
          processId: item.process.id,
          processName: item.process.name,
          department: item.process.department || input.departmentName,
          title: opportunity.title,
          problem: opportunity.problem,
          proposedSolution: opportunity.proposed_solution,
          implementationPlan: opportunity.implementation_plan,
          expectedResult: opportunity.expected_result,
          currentState: opportunity.current_state,
          targetState: opportunity.target_state,
          patternLabel: opportunity.pattern_label,
          evidenceLabel: opportunity.evidence_label,
          integrationRequirements: opportunity.integration_requirements,
          dependencies: opportunity.dependencies,
          assumptions,
          annualTimeValue: opportunity.annual_time_value ?? 0,
          annualErrorValue: opportunity.annual_error_value ?? 0,
          annualDelayValue: opportunity.annual_delay_value ?? 0,
          grossValue: opportunity.gross_value ?? 0,
          netScore: opportunity.net_score ?? 0,
          hoursSaved,
          source: item.result.source,
        } satisfies DepartmentAutomationOpportunity;
      });
    })
    .sort((a, b) => b.netScore - a.netScore);

  const topOpportunities = opportunities.slice(0, 6);
  const source = sourceLabel(topOpportunities.map((opportunity) => opportunity.source));
  const metrics = summarize(topOpportunities);

  return {
    departmentName: input.departmentName,
    processCount: input.processes.length,
    processGraphCount: graphResults.filter(Boolean).length,
    opportunityCount: opportunities.length,
    source,
    planState: planStateFromStatus(directorStatus, false),
    refreshState: null,
    updatedAt: directorStatus.updated_at?.toISOString() ?? null,
    topOpportunities,
    metrics,
    audit: buildAudit({
      departmentName: input.departmentName,
      processes: input.processes,
      opportunities: topOpportunities,
      processGraphCount: graphResults.filter(Boolean).length,
      metrics,
    }),
  };
}

async function buildDirectorPlan(input: {
  orgId: string;
  workspaceId: string;
  departmentName: string;
  processes: ProcessSummary[];
  captureSessionId?: string | null;
  directorPlan: DirectorAutomationPlanRecord;
  directorStatus: DirectorAutomationPlanStatus;
}): Promise<DepartmentAutomationPlan> {
  const prices = await getWorkspaceRoiPrices(input.orgId, input.workspaceId);
  const opportunities = input.directorPlan.planJson.processes
    .map((process) => {
      const assumptionRanges: ROIRangeAssumptions = {
        annual_volume: numericRange(process.assumptions.annual_volume),
        minutes_saved_per_case: numericRange(process.assumptions.minutes_saved_per_case),
        error_rate: numericRange(process.assumptions.error_rate),
        exception_rate: numericRange(process.assumptions.exception_rate),
      };
      const effortPenalty = EFFORT_PENALTY_BY_BAND[process.effort_band];
      const roiRange = computeRoiRange(
        assumptionRanges,
        prices,
        {
          confidence: process.confidence,
          effort_penalty: effortPenalty,
        },
      );
      const hoursSavedRange: ROIRange = {
        low:
          (assumptionRanges.annual_volume.low *
            assumptionRanges.minutes_saved_per_case.low) /
          60,
        base:
          (assumptionRanges.annual_volume.base *
            assumptionRanges.minutes_saved_per_case.base) /
          60,
        high:
          (assumptionRanges.annual_volume.high *
            assumptionRanges.minutes_saved_per_case.high) /
          60,
      };
      const assumptions: ROIAssumptions = {
        annual_volume: assumptionRanges.annual_volume.base,
        minutes_saved_per_case: assumptionRanges.minutes_saved_per_case.base,
        loaded_hourly_cost: prices.loaded_hourly_cost,
        error_rate: assumptionRanges.error_rate.base,
        cost_per_error: prices.cost_per_error,
        exception_rate: assumptionRanges.exception_rate.base,
        delay_cost: prices.delay_cost,
        confidence: process.confidence,
        effort_penalty: effortPenalty,
      };
      return {
        id: `director:${process.candidate_process_id}`,
        processId: process.candidate_process_id,
        processName: process.process_name,
        department: input.directorPlan.planJson.department_name || input.departmentName,
        title: `${process.pattern_label} for ${process.process_name}`,
        problem: input.directorPlan.planJson.audit.problem,
        proposedSolution: process.implementation_plan,
        implementationPlan: process.implementation_plan,
        expectedResult: process.expected_result,
        currentState: `${process.process_name} depends on ${joinOrFallback(
          process.affected_roles,
          "the current team",
        )} working across ${joinOrFallback(process.affected_systems, "existing systems")}.`,
        targetState: `${process.pattern_label} agent with controls, exception routing, and human review for the cases that need judgment.`,
        patternLabel: process.pattern_label,
        evidenceLabel:
          process.evidence_gaps.length > 0
            ? `${process.evidence_gaps.length} evidence gap${
                process.evidence_gaps.length === 1 ? "" : "s"
              } to validate`
            : "Director interview inventory",
        integrationRequirements: process.affected_systems,
        dependencies: process.evidence_gaps,
        assumptions,
        annualTimeValue: roiRange.annual_time_value.base,
        annualErrorValue: roiRange.annual_error_value.base,
        annualDelayValue: roiRange.annual_delay_value.base,
        grossValue: roiRange.gross_value.base,
        netScore: roiRange.net_score.base,
        hoursSaved: hoursSavedRange.base,
        annualTimeValueRange: roiRange.annual_time_value,
        annualErrorValueRange: roiRange.annual_error_value,
        annualDelayValueRange: roiRange.annual_delay_value,
        grossValueRange: roiRange.gross_value,
        netScoreRange: roiRange.net_score,
        hoursSavedRange,
        assumptionRanges,
        assumptionDetails: {
          annual_volume: assumptionDetail(process.assumptions.annual_volume),
          minutes_saved_per_case: assumptionDetail(
            process.assumptions.minutes_saved_per_case,
          ),
          error_rate: assumptionDetail(process.assumptions.error_rate),
          exception_rate: assumptionDetail(process.assumptions.exception_rate),
        },
        source: "director",
      } satisfies DepartmentAutomationOpportunity;
    })
    .sort((a, b) => b.netScore - a.netScore);
  const topOpportunities = opportunities.slice(0, 6);
  const metrics = summarize(topOpportunities);
  return {
    departmentName: input.directorPlan.planJson.department_name || input.departmentName,
    processCount: input.processes.length || input.directorPlan.planJson.processes.length,
    processGraphCount: 0,
    opportunityCount: opportunities.length,
    source: "director",
    planState: "ready",
    refreshState: refreshState(input.directorStatus, true),
    updatedAt: input.directorPlan.updatedAt.toISOString(),
    topOpportunities,
    metrics,
    audit: {
      problem: input.directorPlan.planJson.audit.problem,
      patterns: input.directorPlan.planJson.audit.patterns.map((pattern) => ({
        text: pattern.text,
        metricBasis: pattern.metric_basis,
      })),
    },
  };
}

function numericRange(range: { low: number; base: number; high: number }): ROIRange {
  return { low: range.low, base: range.base, high: range.high };
}

function assumptionDetail(range: {
  basis: AssumptionBasis;
  confidence: number;
  evidence_ids: string[];
}): DepartmentAutomationAssumptionDetail {
  return {
    basis: range.basis,
    confidence: range.confidence,
    evidenceIds: range.evidence_ids,
  };
}

function sumRange(left: ROIRange | undefined, right: ROIRange | undefined) {
  if (!right) return left;
  if (!left) return right;
  return {
    low: left.low + right.low,
    base: left.base + right.base,
    high: left.high + right.high,
  };
}

function joinOrFallback(values: string[], fallback: string) {
  const clean = values.map((value) => value.trim()).filter(Boolean);
  if (clean.length === 0) return fallback;
  return clean.slice(0, 4).join(", ");
}

function planStateFromStatus(
  status: DirectorAutomationPlanStatus,
  hasCompletedPlan: boolean,
): DepartmentAutomationPlanState {
  if (hasCompletedPlan) return "ready";
  if (status.run_state === "completed") return "none";
  return status.run_state;
}

function refreshState(
  status: DirectorAutomationPlanStatus,
  hasCompletedPlan: boolean,
) {
  if (!hasCompletedPlan) return null;
  if (status.run_state === "pending" || status.run_state === "running") {
    return status.run_state;
  }
  if (status.run_state === "failed") return "failed";
  return null;
}

function summarize(opportunities: DepartmentAutomationOpportunity[]) {
  const totals = opportunities.reduce(
    (sum, opportunity) => ({
      annualNetValue: sum.annualNetValue + opportunity.netScore,
      annualGrossValue: sum.annualGrossValue + opportunity.grossValue,
      annualHoursSaved: sum.annualHoursSaved + opportunity.hoursSaved,
      annualTimeValue: sum.annualTimeValue + opportunity.annualTimeValue,
      annualErrorValue: sum.annualErrorValue + opportunity.annualErrorValue,
      annualDelayValue: sum.annualDelayValue + opportunity.annualDelayValue,
      annualNetValueRange: sumRange(sum.annualNetValueRange, opportunity.netScoreRange),
      annualGrossValueRange: sumRange(sum.annualGrossValueRange, opportunity.grossValueRange),
      annualHoursSavedRange: sumRange(sum.annualHoursSavedRange, opportunity.hoursSavedRange),
      annualTimeValueRange: sumRange(sum.annualTimeValueRange, opportunity.annualTimeValueRange),
      annualErrorValueRange: sumRange(sum.annualErrorValueRange, opportunity.annualErrorValueRange),
      annualDelayValueRange: sumRange(sum.annualDelayValueRange, opportunity.annualDelayValueRange),
      confidence:
        sum.confidence + opportunity.assumptions.confidence,
    }),
    {
      annualNetValue: 0,
      annualGrossValue: 0,
      annualHoursSaved: 0,
      annualTimeValue: 0,
      annualErrorValue: 0,
      annualDelayValue: 0,
      annualNetValueRange: undefined as ROIRange | undefined,
      annualGrossValueRange: undefined as ROIRange | undefined,
      annualHoursSavedRange: undefined as ROIRange | undefined,
      annualTimeValueRange: undefined as ROIRange | undefined,
      annualErrorValueRange: undefined as ROIRange | undefined,
      annualDelayValueRange: undefined as ROIRange | undefined,
      confidence: 0,
    },
  );
  return {
    annualNetValue: totals.annualNetValue,
    annualGrossValue: totals.annualGrossValue,
    annualHoursSaved: totals.annualHoursSaved,
    annualTimeValue: totals.annualTimeValue,
    annualErrorValue: totals.annualErrorValue,
    annualDelayValue: totals.annualDelayValue,
    averageConfidence:
      opportunities.length === 0 ? 0 : totals.confidence / opportunities.length,
    annualNetValueRange: totals.annualNetValueRange,
    annualGrossValueRange: totals.annualGrossValueRange,
    annualHoursSavedRange: totals.annualHoursSavedRange,
    annualTimeValueRange: totals.annualTimeValueRange,
    annualErrorValueRange: totals.annualErrorValueRange,
    annualDelayValueRange: totals.annualDelayValueRange,
  };
}

function buildAudit(input: {
  departmentName: string;
  processes: ProcessSummary[];
  opportunities: DepartmentAutomationOpportunity[];
  processGraphCount: number;
  metrics: DepartmentAutomationPlan["metrics"];
}): DepartmentAutomationPlan["audit"] {
  if (input.processes.length === 0) {
    return {
      problem: `No ${input.departmentName} interviews or uploaded evidence have produced a process inventory yet, so the department's operating risk is undocumented and unmeasured.`,
      patterns: [
        {
          text: "Automation sizing needs director intake first, then operator captures for the highest-volume workflows.",
        },
        {
          text: "Without baselined volume and exception rates, ROI cannot be quantified for any workflow.",
        },
        {
          text: "Single points of failure stay invisible until processes are mapped against named owners.",
        },
      ],
    };
  }

  const systems = new Set([
    ...input.processes.flatMap((process) => process.systems),
    ...input.opportunities.flatMap(
      (opportunity) => opportunity.integrationRequirements,
    ),
  ]);
  const top = input.opportunities[0];
  const highComplexity = input.processes.filter(
    (process) => process.complexity === "high",
  ).length;
  const patternLabels = topPatternLabels(input.opportunities);
  const totalAnnualVolume = input.opportunities.reduce(
    (sum, opportunity) => sum + opportunity.assumptions.annual_volume,
    0,
  );
  const worstException = input.opportunities.reduce<
    DepartmentAutomationOpportunity | null
  >((worst, opportunity) => {
    if (!worst) return opportunity;
    return opportunity.assumptions.exception_rate > worst.assumptions.exception_rate
      ? opportunity
      : worst;
  }, null);

  const problem = `${input.departmentName} runs ${input.processes.length} process${
    input.processes.length === 1 ? "" : "es"
  } across ${systems.size} system${
    systems.size === 1 ? "" : "s"
  } with manual handoffs and no consolidated operating layer — work is reconciled by hand, exceptions absorb senior time, and roughly ${Math.round(
    input.metrics.annualHoursSaved,
  ).toLocaleString()} hours a year are spent on tasks that could be automated.`;

  const patterns: string[] = [];

  patterns.push(
    highComplexity > 0
      ? `${highComplexity} of ${input.processes.length} captured process${
          highComplexity === 1 ? " is" : "es are"
        } high-complexity, concentrating operational risk and rework in a handful of workflows.`
      : `Work is spread across ${input.processes.length} process${
          input.processes.length === 1 ? "" : "es"
        } with no dominant workflow, so effort leaks through volume and handoffs rather than one obvious bottleneck.`,
  );

  if (top) {
    patterns.push(
      `${top.processName} is the largest single drain: ${top.patternLabel.toLowerCase()} ties up roughly ${Math.round(
        top.hoursSaved,
      ).toLocaleString()} manual hours per year (~${fmtUSDInline(
        top.grossValue,
      )} gross value at risk).`,
    );
  }

  if (worstException) {
    patterns.push(
      `Exception handling is unmanaged — ${worstException.processName} carries a ${Math.round(
        worstException.assumptions.exception_rate * 100,
      )}% exception rate against ${totalAnnualVolume.toLocaleString()} annual cases department-wide, with no routing or owner queue.`,
    );
  }

  patterns.push(
    patternLabels.length > 0
      ? `Repeated ${patternLabels.join(
          " and ",
        )} opportunities recur across processes, pointing to a department-level operating gap rather than isolated one-off fixes.`
      : `Recurring manual reconciliation and copy-paste steps appear across processes, pointing to a department-level operating gap rather than isolated one-off fixes.`,
  );

  if (patterns.length < 3) {
    patterns.push(
      `Automation value is not fully baselined yet: only ${input.processGraphCount} of ${input.processes.length} process${
        input.processes.length === 1 ? "" : "es"
      } has an automation-ready graph, so the current ROI view likely understates department-wide impact.`,
    );
  }

  return {
    problem,
    patterns: patterns.map((text) => ({ text })),
  };
}

function fmtUSDInline(value: number) {
  return `$${Math.round(value).toLocaleString()}`;
}

function topPatternLabels(opportunities: DepartmentAutomationOpportunity[]) {
  const counts = new Map<string, number>();
  for (const opportunity of opportunities) {
    counts.set(opportunity.patternLabel, (counts.get(opportunity.patternLabel) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label]) => label.toLowerCase());
}

function sourceLabel(sources: DepartmentAutomationSource[]) {
  const unique = new Set(sources);
  if (unique.size === 0) return "none" as const;
  if (unique.size === 1) return sources[0] ?? "none";
  return "mixed" as const;
}
