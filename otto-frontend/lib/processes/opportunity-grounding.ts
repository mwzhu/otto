import type { ProcessGraph } from "@/lib/types/graph";
import type { ROIAssumptions } from "@/lib/types/opportunity";
import { computeROI } from "@/lib/roi";
import {
  assumptionsForImpact,
  ROI_PRICE_DEFAULTS,
  type TransformationOpportunity,
} from "@/lib/processes/opportunity-heuristics";
import {
  OPPORTUNITY_PATTERN_CATALOG,
  type GroundedOpportunity,
  type OpportunityPriceConstants,
  type OpportunityProposal,
} from "@/lib/processes/opportunity-schema";

export { ROI_PRICE_DEFAULTS };

export type OpportunityGroundingDiagnostic = {
  code: string;
  message: string;
  opportunityTitle?: string;
  relatedEvidenceIds?: string[];
};

export type GroundOpportunitiesResult = {
  opportunities: GroundedOpportunity[];
  diagnostics: OpportunityGroundingDiagnostic[];
};

export const EFFORT_PENALTY_BY_BAND = {
  low: 1.1,
  med: 1.35,
  high: 1.7,
} as const;

const BOUNDS = {
  annual_volume: { min: 1, max: 5_000_000 },
  minutes_saved_per_case: { min: 0.5, max: 480 },
  error_rate: { min: 0, max: 1 },
  exception_rate: { min: 0, max: 1 },
  confidence: { min: 0, max: 1 },
  effort_penalty: { min: 1, max: 5 },
} as const;

export function groundOpportunities(
  proposals: OpportunityProposal[],
  input: {
    graph: ProcessGraph;
    allowedEvidenceIds: Iterable<string>;
    priceConstants: OpportunityPriceConstants;
  },
): GroundOpportunitiesResult {
  const allowedEvidenceIds = new Set(input.allowedEvidenceIds);
  const graphNodesById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const validPatternIds = new Set<string>(
    OPPORTUNITY_PATTERN_CATALOG.map((pattern) => pattern.pattern_id),
  );
  const diagnostics: OpportunityGroundingDiagnostic[] = [];
  const grounded: GroundedOpportunity[] = [];

  for (const proposal of proposals) {
    const sourceNodeIds = proposal.source_node_ids.filter((id) =>
      graphNodesById.has(id),
    );
    if (sourceNodeIds.length === 0) {
      diagnostics.push({
        code: "invalid_source_nodes",
        message: "Opportunity dropped because none of its source_node_ids exist.",
        opportunityTitle: proposal.title,
      });
      continue;
    }

    if (!validPatternIds.has(proposal.pattern_id)) {
      diagnostics.push({
        code: "invalid_pattern",
        message: `Opportunity dropped because pattern_id is not in the catalog: ${proposal.pattern_id}`,
        opportunityTitle: proposal.title,
      });
      continue;
    }

    const sourceNode = graphNodesById.get(sourceNodeIds[0])!;
    const evidenceIds = filterEvidenceIds(proposal.evidence_ids, allowedEvidenceIds);
    const defaultAssumptions = assumptionsForImpact(
      proposal.impact_band,
      clamp(proposal.assumption_confidence, BOUNDS.confidence),
    );
    const assumptionSources: GroundedOpportunity["assumption_sources"] = {};
    const confidenceValues = [proposal.assumption_confidence];

    const annualVolume = operationalValue({
      field: "annual_volume",
      proposal,
      allowedEvidenceIds,
      fallback: defaultAssumptions.annual_volume,
      diagnostics,
      assumptionSources,
      confidenceValues,
    });
    const minutesSaved = operationalValue({
      field: "minutes_saved_per_case",
      proposal,
      allowedEvidenceIds,
      fallback: defaultAssumptions.minutes_saved_per_case,
      diagnostics,
      assumptionSources,
      confidenceValues,
    });
    const errorRate = operationalValue({
      field: "error_rate",
      proposal,
      allowedEvidenceIds,
      fallback: defaultAssumptions.error_rate,
      diagnostics,
      assumptionSources,
      confidenceValues,
    });
    const exceptionRate = operationalValue({
      field: "exception_rate",
      proposal,
      allowedEvidenceIds,
      fallback: defaultAssumptions.exception_rate,
      diagnostics,
      assumptionSources,
      confidenceValues,
    });

    const assumptions: ROIAssumptions = {
      annual_volume: annualVolume,
      minutes_saved_per_case: minutesSaved,
      loaded_hourly_cost: input.priceConstants.loaded_hourly_cost,
      error_rate: errorRate,
      cost_per_error: input.priceConstants.cost_per_error,
      exception_rate: exceptionRate,
      delay_cost: input.priceConstants.delay_cost,
      confidence: clamp(Math.min(...confidenceValues), BOUNDS.confidence),
      effort_penalty: clamp(EFFORT_PENALTY_BY_BAND[proposal.effort_band], BOUNDS.effort_penalty),
    };
    const roi = computeROI(assumptions);
    grounded.push({
      id: `${sourceNodeIds[0]}-${proposal.pattern_id}`,
      process_id: input.graph.process_id,
      source_node_ids: sourceNodeIds,
      source_node_id: sourceNodeIds[0],
      source_node_title: sourceNode.data.title,
      title: proposal.title,
      problem: proposal.problem,
      proposed_solution: proposal.proposed_solution,
      implementation_plan: proposal.implementation_plan,
      expected_result: proposal.expected_result,
      automation_type: proposal.automation_type,
      pattern_id: proposal.pattern_id,
      pattern_label: proposal.pattern_label,
      assumptions,
      ...roi,
      integration_requirements:
        sourceNode.data.systems && sourceNode.data.systems.length > 0
          ? sourceNode.data.systems
          : ["Operator workflow evidence"],
      dependencies:
        evidenceIds.length > 0
          ? ["Confirm automation scope with process owner"]
          : ["Capture supporting evidence before approval"],
      claim_ids: sourceNode.data.claim_ids ?? [],
      evidence_ids: evidenceIds,
      evidence_label:
        evidenceIds.length > 0
          ? `${evidenceIds.length} linked evidence source${evidenceIds.length === 1 ? "" : "s"}`
          : "Assumption/open gap",
      current_state: proposal.current_state,
      target_state: proposal.target_state,
      impact: proposal.impact_band,
      effort_band: proposal.effort_band,
      grounding: evidenceIds.length > 0 ? "evidence" : "assumption",
      assumption_sources: assumptionSources,
    });
  }

  return {
    opportunities: dedupeAndRank(grounded),
    diagnostics,
  };
}

export function applyPricesToAssumptions(
  assumptions: ROIAssumptions,
  priceConstants: OpportunityPriceConstants,
): ROIAssumptions {
  return {
    ...assumptions,
    loaded_hourly_cost: priceConstants.loaded_hourly_cost,
    cost_per_error: priceConstants.cost_per_error,
    delay_cost: priceConstants.delay_cost,
  };
}

export function clampOperationalAssumptions(
  assumptions: ROIAssumptions,
): ROIAssumptions {
  return {
    ...assumptions,
    annual_volume: clamp(assumptions.annual_volume, BOUNDS.annual_volume),
    minutes_saved_per_case: clamp(
      assumptions.minutes_saved_per_case,
      BOUNDS.minutes_saved_per_case,
    ),
    error_rate: clamp(assumptions.error_rate, BOUNDS.error_rate),
    exception_rate: clamp(assumptions.exception_rate, BOUNDS.exception_rate),
    confidence: clamp(assumptions.confidence, BOUNDS.confidence),
    effort_penalty: clamp(assumptions.effort_penalty, BOUNDS.effort_penalty),
  };
}

export function injectPricesIntoHeuristicOpportunity(
  opportunity: TransformationOpportunity,
  priceConstants: OpportunityPriceConstants,
): TransformationOpportunity {
  return {
    ...opportunity,
    assumptions: applyPricesToAssumptions(opportunity.assumptions, priceConstants),
  };
}

function operationalValue(input: {
  field: "annual_volume" | "minutes_saved_per_case" | "error_rate" | "exception_rate";
  proposal: OpportunityProposal;
  allowedEvidenceIds: Set<string>;
  fallback: number;
  diagnostics: OpportunityGroundingDiagnostic[];
  assumptionSources: NonNullable<GroundedOpportunity["assumption_sources"]>;
  confidenceValues: number[];
}) {
  const value = input.proposal.assumptions[input.field];
  if (!value) return input.fallback;
  let basis = value.basis;
  let confidence = clamp(value.confidence, BOUNDS.confidence);
  const evidenceIds = filterEvidenceIds(value.evidence_ids, input.allowedEvidenceIds);
  if (basis === "evidence" && evidenceIds.length === 0) {
    basis = "inferred";
    confidence = Math.min(confidence, 0.45);
    input.diagnostics.push({
      code: "quantity_evidence_downgraded",
      message: `${input.field} was marked evidence-based but no cited evidence resolved; downgraded to inferred.`,
      opportunityTitle: input.proposal.title,
      relatedEvidenceIds: value.evidence_ids,
    });
  }
  if (basis === "inferred") confidence = Math.min(confidence, 0.45);
  input.confidenceValues.push(confidence);
  input.assumptionSources[input.field] = { basis, confidence, evidence_ids: evidenceIds };
  return clamp(value.value, BOUNDS[input.field]);
}

function filterEvidenceIds(values: string[], allowed: Set<string>) {
  return [...new Set(values.filter((id) => allowed.has(id)))];
}

function dedupeAndRank(opportunities: GroundedOpportunity[]) {
  const byKey = new Map<string, GroundedOpportunity>();
  for (const opportunity of opportunities) {
    const key = `${opportunity.source_node_id}:${opportunity.pattern_id}`;
    const existing = byKey.get(key);
    if (!existing || (opportunity.net_score ?? 0) > (existing.net_score ?? 0)) {
      byKey.set(key, opportunity);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => (b.net_score ?? 0) - (a.net_score ?? 0),
  );
}

function clamp(
  value: number,
  bounds: { min: number; max: number },
) {
  if (!Number.isFinite(value)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}
