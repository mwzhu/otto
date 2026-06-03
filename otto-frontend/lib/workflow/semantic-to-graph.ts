import { randomUUID } from "node:crypto";

import {
  layoutOperatorGraph,
  operatorEdgeWaypoints,
} from "@/lib/synthesis/operator-layout";
import type { GraphEdge, GraphNode, NodeType } from "@/lib/types/graph";
import type {
  WorkflowGrounding,
  WorkflowSemanticEdge,
  WorkflowSemanticModel,
  WorkflowSemanticStep,
} from "@/lib/workflow/semantic-model";

export function workflowSemanticModelToGraph(model: WorkflowSemanticModel): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: Array<{ code: string; message: string }>;
} {
  const semanticSteps = model.steps.filter((step) => step.type !== "terminal");
  const terminalStepsById = new Map(
    model.steps
      .filter((step) => step.type === "terminal")
      .map((step) => [step.id, step]),
  );
  const nodeIdBySemanticStepId = new Map(
    semanticSteps.map((step) => [step.id, randomUUID()]),
  );
  const layout = layoutOperatorGraph(semanticSteps.length);
  const start: GraphNode = {
    id: randomUUID(),
    type: "start",
    position: layout.startPosition,
    data: {
      title: "Start",
      description: model.processName
        ? `Begin ${model.processName}.`
        : "Begin workflow.",
      confidence: 0.35,
    },
  };
  const end: GraphNode = {
    id: randomUUID(),
    type: "end",
    position: layout.endPosition,
    data: {
      title: "End",
      description: model.processName
        ? `Complete ${model.processName}.`
        : "Complete workflow.",
      confidence: 0.35,
    },
  };
  const stepNodes = semanticSteps.map((step, index) =>
    semanticStepToGraphNode(
      step,
      step.type === "decision"
        ? layout.decisionPosition(index)
        : layout.taskPosition(index),
      nodeIdBySemanticStepId.get(step.id) ?? randomUUID(),
    ),
  );
  const nodes = [start, ...stepNodes, end];
  const nodeBySemanticStepId = new Map(
    stepNodes.map((node) => [String(node.data.semantic_step_id), node]),
  );
  const edges: GraphEdge[] = [];

  if (stepNodes.length === 0) {
    edges.push(
      graphEdgeFromPositions({
        source: start,
        target: end,
        edgeType: "seq",
        evidenceIds: [],
      }),
    );
    return { nodes, edges, warnings: [] };
  }

  const incomingSemanticTargets = new Set(
    model.edges
      .map((edge) => edge.targetId)
      .filter((targetId): targetId is string => Boolean(targetId)),
  );
  const outgoingSemanticSources = new Set(
    model.edges.map((edge) => edge.sourceId),
  );
  const entryNode =
    stepNodes.find(
      (node) =>
        !incomingSemanticTargets.has(String(node.data.semantic_step_id)),
    ) ??
    stepNodes[0];
  edges.push(
    graphEdgeFromPositions({
      source: start,
      target: entryNode,
      edgeType: "seq",
      evidenceIds: entryNode.data.evidence_ids ?? [],
    }),
  );

  for (const edge of model.edges) {
    const source = nodeBySemanticStepId.get(edge.sourceId);
    const terminalTarget = edge.targetId
      ? terminalStepsById.get(edge.targetId)
      : undefined;
    const target = terminalTarget
      ? end
      : edge.targetId
        ? nodeBySemanticStepId.get(edge.targetId)
        : undefined;
    if (!source || !target) continue;
    edges.push(semanticEdgeToGraphEdge(edge, source, target, terminalTarget));
  }

  for (const node of stepNodes) {
    if (outgoingSemanticSources.has(String(node.data.semantic_step_id))) continue;
    edges.push(
      graphEdgeFromPositions({
        source: node,
        target: end,
        edgeType: "seq",
        evidenceIds: node.data.evidence_ids ?? [],
      }),
    );
  }

  return { nodes, edges, warnings: [] };
}

function semanticStepToGraphNode(
  step: WorkflowSemanticStep,
  position: GraphNode["position"],
  id: string,
): GraphNode {
  return {
    id,
    type: graphNodeTypeForSemanticStep(step),
    position,
    data: {
      title: step.title,
      description: step.description,
      role: step.actorRole,
      systems: step.systemNames ?? [],
      confidence: step.confidence,
      evidence_ids: citationEvidenceIds(step.citations ?? []),
      inputs: (step.inputs ?? []).map((input) => ({
        name: input.name,
        description: input.description,
        evidence_ids: input.evidenceIds ?? [],
      })),
      outputs: (step.outputs ?? []).map((output) => ({
        name: output.name,
        description: output.description,
        evidence_ids: output.evidenceIds ?? [],
      })),
      semantic_step_id: step.id,
      semantic_grounding: step.grounding ?? "inferred",
      follow_up_question: step.needsFollowUp
        ? step.followUpQuestion
        : undefined,
    },
  };
}

function semanticEdgeToGraphEdge(
  edge: WorkflowSemanticEdge,
  source: GraphNode,
  target: GraphNode,
  terminalTarget?: WorkflowSemanticStep,
): GraphEdge {
  return graphEdgeFromPositions({
    source,
    target,
    edgeType: graphEdgeTypeForSemanticEdge(edge),
    evidenceIds: citationEvidenceIds(edge.citations ?? []),
    label: displayLabelForSemanticEdge(edge, terminalTarget),
    condition: edge.condition ?? terminalTarget?.terminalOutcome,
    isExceptionPath: edge.type === "exception" || edge.type === "loop",
    semanticEdgeId: edge.id,
    semanticGrounding: edge.grounding ?? "inferred",
  });
}

function displayLabelForSemanticEdge(
  edge: WorkflowSemanticEdge,
  terminalTarget?: WorkflowSemanticStep,
) {
  if (
    edge.type === "conditional" ||
    edge.type === "handoff" ||
    edge.type === "parallel" ||
    edge.type === "exception" ||
    edge.type === "loop"
  ) {
    return compactBranchLabel(
      edge.label ?? terminalTarget?.terminalOutcome ?? terminalTarget?.title,
    );
  }
  return undefined;
}

function compactBranchLabel(label: string | undefined) {
  const normalized = label?.trim();
  if (!normalized) return undefined;
  if (/^yes\b/i.test(normalized)) return "Yes";
  if (/^no\b/i.test(normalized)) return "No";
  return normalized;
}

function graphEdgeFromPositions(input: {
  id?: string;
  source: GraphNode;
  target: GraphNode;
  edgeType: GraphEdge["edge_type"];
  evidenceIds: string[];
  label?: string;
  condition?: string;
  isExceptionPath?: boolean;
  semanticEdgeId?: string;
  semanticGrounding?: WorkflowGrounding;
}): GraphEdge {
  return {
    id: input.id ?? randomUUID(),
    source: input.source.id,
    target: input.target.id,
    edge_type: input.edgeType,
    label: input.label,
    condition: input.condition,
    is_exception_path: input.isExceptionPath,
    evidence_ids: input.evidenceIds,
    waypoints: operatorEdgeWaypoints(
      input.source.position,
      input.target.position,
    ),
    sourceSide: "bottom",
    targetSide: "top",
    semantic_edge_id: input.semanticEdgeId,
    semantic_grounding: input.semanticGrounding,
  };
}

function graphNodeTypeForSemanticStep(step: WorkflowSemanticStep): NodeType {
  switch (step.type) {
    case "decision":
      return "decision";
    case "wait":
      return "wait";
    case "handoff":
      return "handoff";
    case "exception":
      return "exception";
    case "task":
    case "terminal":
      return "task";
  }
}

function graphEdgeTypeForSemanticEdge(
  edge: WorkflowSemanticEdge,
): GraphEdge["edge_type"] {
  switch (edge.type) {
    case "conditional":
      return "conditional";
    case "handoff":
      return "handoff";
    case "parallel":
      return "parallel";
    case "sequence":
    case "exception":
    case "loop":
      return "seq";
  }
}

function citationEvidenceIds(citations: Array<{ evidenceId: string }>) {
  return Array.from(new Set(citations.map((citation) => citation.evidenceId)));
}
