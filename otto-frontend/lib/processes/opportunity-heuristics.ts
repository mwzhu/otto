import type { GraphNode, ProcessGraph } from "@/lib/types/graph";
import type { Opportunity, ROIAssumptions } from "@/lib/types/opportunity";

export const HEURISTIC_OPPORTUNITY_VERSION = 1;

export const ROI_PRICE_DEFAULTS = {
  loaded_hourly_cost: 65,
  cost_per_error: 90,
  delay_cost: 35,
} as const;

export const ROI_ASSUMPTION_TIERS = {
  high: { volume: 4000, minutes: 8, errors: 0.04, exceptions: 0.08, effort: 1.7 },
  med: { volume: 2500, minutes: 5, errors: 0.025, exceptions: 0.05, effort: 1.35 },
  low: { volume: 1000, minutes: 2, errors: 0.01, exceptions: 0.02, effort: 1.1 },
} as const;

export type TransformationOpportunity = Opportunity & {
  source_node_id: string;
  source_node_title: string;
  evidence_ids: string[];
  evidence_label: string;
  current_state: string;
  target_state: string;
  impact: "high" | "med" | "low";
};

export function buildTransformationOpportunities(
  graph: ProcessGraph,
): TransformationOpportunity[] {
  const opportunities = graph.nodes
    .filter((node) => node.type !== "start" && node.type !== "end")
    .flatMap((node) => opportunitiesForNode(graph.process_id, node));

  if (opportunities.length > 0) {
    return opportunities.sort((a, b) => {
      const rank = { high: 3, med: 2, low: 1 };
      return rank[b.impact] - rank[a.impact];
    });
  }

  const task = graph.nodes.find((node) => node.type === "task");
  if (!task) return [];
  return [
    makeOpportunity({
      processId: graph.process_id,
      node: task,
      reason: "The current graph has a documented task but no extracted exception, wait, or workaround detail yet.",
      currentState:
        task.data.description ??
        `${task.data.title} is captured as a manual workflow step.`,
      targetState:
        "Collect one more operator capture focused on timing, handoffs, and systems before sizing an automation proposal.",
      patternLabel: "Evidence gap",
      patternId: "evidence-gap",
      type: "knowledge_base",
      impact: "low",
      confidence: 0.45,
    }),
  ];
}

function opportunitiesForNode(
  processId: string,
  node: GraphNode,
): TransformationOpportunity[] {
  const items: TransformationOpportunity[] = [];
  const systems = node.data.systems ?? [];
  const evidenceIds = collectEvidenceIds(node);

  for (const workaround of node.data.workarounds ?? []) {
    items.push(
      makeOpportunity({
        processId,
        node,
        reason: workaround.description,
        currentState: `${node.data.title}: ${workaround.description}`,
        targetState:
          systems.length > 0
            ? `Connect ${systems.join(" and ")} so the check happens in-flow and the operator only reviews exceptions.`
            : "Move the repeated lookup into the workflow so the operator only reviews exceptions.",
        patternLabel: systems.length > 1 ? "System integration" : "Agent assistant",
        patternId: systems.length > 1 ? "system-integration" : "agent-assistant",
        type: systems.length > 1 ? "system_integration" : "agent_assistant",
        impact: "high",
        confidence: evidenceIds.length > 0 ? 0.78 : 0.52,
      }),
    );
  }

  for (const exception of node.data.exceptions ?? []) {
    items.push(
      makeOpportunity({
        processId,
        node,
        reason: exception.trigger
          ? `${exception.label}: ${exception.trigger}`
          : exception.label,
        currentState: `${node.data.title} has an exception path: ${exception.label}.`,
        targetState:
          "Add exception detection and routing so non-standard cases are surfaced with the right context before the operator works them.",
        patternLabel: "Exception monitoring",
        patternId: "exception-monitoring",
        type: "exception_monitoring",
        impact: "med",
        confidence: evidenceIds.length > 0 ? 0.7 : 0.5,
      }),
    );
  }

  if (node.type === "wait" || (node.data.sla_seconds ?? 0) > 0) {
    items.push(
      makeOpportunity({
        processId,
        node,
        reason:
          node.type === "wait"
            ? "The workflow includes a waiting step."
            : "The step has a captured SLA.",
        currentState:
          node.data.description ??
          `${node.data.title} creates elapsed time in the process.`,
        targetState:
          "Trigger reminders and status updates automatically so the process does not depend on manual follow-up.",
        patternLabel: "Approval routing",
        patternId: "approval-routing",
        type: "approval_routing",
        impact: "med",
        confidence: evidenceIds.length > 0 ? 0.66 : 0.48,
      }),
    );
  }

  if ((node.data.confidence ?? 1) < 0.65 || node.data.follow_up_question) {
    items.push(
      makeOpportunity({
        processId,
        node,
        reason:
          node.data.follow_up_question ??
          "The step has low extraction confidence.",
        currentState:
          node.data.description ??
          `${node.data.title} still needs operator validation.`,
        targetState:
          "Resolve the open question before finalizing automation scope or downstream ROI.",
        patternLabel: "Evidence gap",
        patternId: "evidence-gap",
        type: "knowledge_base",
        impact: "low",
        confidence: 0.42,
      }),
    );
  }

  return items;
}

function makeOpportunity({
  processId,
  node,
  reason,
  currentState,
  targetState,
  patternLabel,
  patternId,
  type,
  impact,
  confidence,
}: {
  processId: string;
  node: GraphNode;
  reason: string;
  currentState: string;
  targetState: string;
  patternLabel: string;
  patternId: string;
  type: Opportunity["automation_type"];
  impact: TransformationOpportunity["impact"];
  confidence: number;
}): TransformationOpportunity {
  const evidenceIds = collectEvidenceIds(node);
  const systems = node.data.systems ?? [];
  const assumptions = assumptionsForImpact(impact, confidence);
  return {
    id: `${node.id}-${patternId}`,
    process_id: processId,
    source_node_id: node.id,
    source_node_title: node.data.title,
    title:
      patternId === "evidence-gap"
        ? `Validate ${node.data.title}`
        : `Transform ${node.data.title}`,
    problem: reason,
    proposed_solution: targetState,
    implementation_plan: implementationPlanFor({
      node,
      systems,
      patternLabel,
      targetState,
    }),
    expected_result: expectedResultFor({
      node,
      assumptions,
      patternLabel,
    }),
    automation_type: type,
    pattern_id: patternId,
    pattern_label: patternLabel,
    assumptions,
    integration_requirements:
      systems.length > 0 ? systems : ["Operator workflow evidence"],
    dependencies:
      evidenceIds.length > 0
        ? ["Confirm exception handling with process owner"]
        : ["Capture supporting evidence before approval"],
    claim_ids: node.data.claim_ids ?? [],
    evidence_ids: evidenceIds,
    evidence_label:
      evidenceIds.length > 0
        ? `${evidenceIds.length} linked evidence source${evidenceIds.length === 1 ? "" : "s"}`
        : "Assumption/open gap",
    current_state: currentState,
    target_state: targetState,
    impact,
  };
}

function implementationPlanFor({
  node,
  systems,
  patternLabel,
  targetState,
}: {
  node: GraphNode;
  systems: string[];
  patternLabel: string;
  targetState: string;
}) {
  const systemText =
    systems.length > 0 ? systems.join(" and ") : "the captured workflow evidence";
  return `${patternLabel} agent monitors ${node.data.title} using ${systemText}, applies the documented checks before the operator enters the step, routes exceptions with context, and keeps a human approval path for ambiguous cases. ${targetState}`;
}

function expectedResultFor({
  node,
  assumptions,
  patternLabel,
}: {
  node: GraphNode;
  assumptions: ROIAssumptions;
  patternLabel: string;
}) {
  const hours = Math.round(
    (assumptions.annual_volume * assumptions.minutes_saved_per_case) / 60,
  ).toLocaleString();
  return `${patternLabel} on ${node.data.title} should remove roughly ${hours} annual manual hours, reduce exceptions by focusing review on the modeled ${Math.round(
    assumptions.exception_rate * 100,
  )}% exception population, and cut preventable errors before downstream handoffs.`;
}

export function assumptionsForImpact(
  impact: TransformationOpportunity["impact"],
  confidence: number,
): ROIAssumptions {
  const tier = ROI_ASSUMPTION_TIERS[impact];

  return {
    annual_volume: tier.volume,
    minutes_saved_per_case: tier.minutes,
    loaded_hourly_cost: ROI_PRICE_DEFAULTS.loaded_hourly_cost,
    error_rate: tier.errors,
    cost_per_error: ROI_PRICE_DEFAULTS.cost_per_error,
    exception_rate: tier.exceptions,
    delay_cost: ROI_PRICE_DEFAULTS.delay_cost,
    confidence,
    effort_penalty: tier.effort,
  };
}

function collectEvidenceIds(node: GraphNode): string[] {
  const ids = new Set<string>();
  const add = (values?: string[]) => values?.forEach((id) => ids.add(id));
  add(node.data.evidence_ids);
  for (const item of node.data.inputs ?? []) add(item.evidence_ids);
  for (const item of node.data.outputs ?? []) add(item.evidence_ids);
  for (const item of node.data.exceptions ?? []) add(item.evidence_ids);
  for (const item of node.data.workarounds ?? []) add(item.evidence_ids);
  for (const item of node.data.variants ?? []) add(item.evidence_ids);
  return Array.from(ids);
}
