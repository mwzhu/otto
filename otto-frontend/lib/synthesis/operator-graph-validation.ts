import type { GraphEdge, GraphNode, ProcessGraph } from "@/lib/types/graph";

export type OperatorGraphValidationIssue = {
  code:
    | "missing_node"
    | "duplicate_node_id"
    | "duplicate_edge_id"
    | "invalid_start_count"
    | "invalid_end_count"
    | "dangling_edge"
    | "unreachable_node"
    | "unreachable_end"
    | "missing_outgoing_edge"
    | "unevidenced_high_confidence_node";
  message: string;
  node_id?: string;
  edge_id?: string;
};

export type OperatorGraphValidationResult = {
  ok: boolean;
  issues: OperatorGraphValidationIssue[];
};

export function validateOperatorGraph(
  graph: Pick<ProcessGraph, "nodes" | "edges">,
): OperatorGraphValidationResult {
  const issues: OperatorGraphValidationIssue[] = [];
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (nodes.length === 0) {
    return {
      ok: false,
      issues: [
        {
          code: "missing_node",
          message: "Operator graph must contain at least one node.",
        },
      ],
    };
  }

  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        message: `Duplicate graph node id ${node.id}.`,
        node_id: node.id,
      });
    }
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: "duplicate_edge_id",
        message: `Duplicate graph edge id ${edge.id}.`,
        edge_id: edge.id,
      });
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push({
        code: "dangling_edge",
        message: `Edge ${edge.id} references a missing source or target node.`,
        edge_id: edge.id,
      });
    }
  }

  const starts = nodes.filter((node) => node.type === "start");
  const ends = nodes.filter((node) => node.type === "end");
  if (starts.length !== 1) {
    issues.push({
      code: "invalid_start_count",
      message: `Operator graph must contain exactly one start node; found ${starts.length}.`,
    });
  }
  if (ends.length !== 1) {
    issues.push({
      code: "invalid_end_count",
      message: `Operator graph must contain exactly one end node; found ${ends.length}.`,
    });
  }

  const start = starts[0];
  if (start) {
    const reachable = reachableNodeIds(start.id, edges);
    for (const node of nodes) {
      if (!reachable.has(node.id)) {
        issues.push({
          code: "unreachable_node",
          message: `Node ${node.id} is not reachable from the start node.`,
          node_id: node.id,
        });
      }
    }
    const end = ends[0];
    if (end && !reachable.has(end.id)) {
      issues.push({
        code: "unreachable_end",
        message: "End node is not reachable from the start node.",
        node_id: end.id,
      });
    }
  }

  const outgoingSources = new Set(edges.map((edge) => edge.source));
  for (const node of nodes) {
    if (node.type === "end" || node.data.terminal === true) continue;
    if (outgoingSources.has(node.id)) continue;
    issues.push({
      code: "missing_outgoing_edge",
      message:
        "Every non-end operator graph node needs an outgoing edge unless it is explicitly terminal.",
      node_id: node.id,
    });
  }

  for (const node of nodes) {
    if (node.type === "start" || node.type === "end") continue;
    if (nodeHasEvidenceOrLowConfidenceInference(node)) continue;
    issues.push({
      code: "unevidenced_high_confidence_node",
      message:
        "Synthesized graph nodes need evidence ids or must be marked as low-confidence inference.",
      node_id: node.id,
    });
  }

  return { ok: issues.length === 0, issues };
}

export function assertValidOperatorGraph(
  graph: Pick<ProcessGraph, "nodes" | "edges">,
) {
  const result = validateOperatorGraph(graph);
  if (!result.ok) {
    throw new OperatorGraphValidationError(result.issues);
  }
}

export class OperatorGraphValidationError extends Error {
  constructor(public readonly issues: OperatorGraphValidationIssue[]) {
    super(
      `Operator graph failed validation: ${issues
        .map((issue) => issue.code)
        .join(", ")}`,
    );
    this.name = "OperatorGraphValidationError";
  }
}

function reachableNodeIds(startId: string, edges: GraphEdge[]) {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const reachable = new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const target of outgoing.get(current) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  return reachable;
}

function nodeHasEvidenceOrLowConfidenceInference(node: GraphNode) {
  if ((node.data.evidence_ids ?? []).length > 0) return true;
  return (node.data.confidence ?? 0) <= 0.45;
}
