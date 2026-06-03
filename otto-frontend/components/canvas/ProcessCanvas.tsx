"use client";

import { useMemo } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Edge,
  type Node,
} from "reactflow";
import { TaskNode } from "./nodes/TaskNode";
import { DecisionNode } from "./nodes/DecisionNode";
import { WaitNode } from "./nodes/WaitNode";
import { EndNode } from "./nodes/EndNode";
import { StartNode } from "./nodes/StartNode";
import { HandoffNode } from "./nodes/HandoffNode";
import { ExceptionNode } from "./nodes/ExceptionNode";
import {
  LabeledEdge,
  VERTICAL_BRANCH_LANE_OFFSET_X,
} from "./edges/LabeledEdge";
import type { ProcessGraph } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/store/workspace";
import { LayoutModeToggle } from "./LayoutModeToggle";
import { layoutOperatorGraph } from "@/lib/synthesis/operator-layout";

const BRANCH_BOUNDS_NODE_TYPE = "branchBounds";

const nodeTypes = {
  task: TaskNode,
  decision: DecisionNode,
  wait: WaitNode,
  end: EndNode,
  start: StartNode,
  handoff: HandoffNode,
  exception: ExceptionNode,
  [BRANCH_BOUNDS_NODE_TYPE]: BranchBoundsNode,
};

const edgeTypes = {
  labeled: LabeledEdge,
};

export function ProcessCanvas({
  graph,
  onNodeEvidenceOpen,
}: {
  graph: ProcessGraph;
  onNodeEvidenceOpen?: (input: { title: string; evidenceIds: string[] }) => void;
}) {
  const correctedNodeIds = useWorkspaceStore((s) => s.correctedNodeIds);
  const setSelected = useWorkspaceStore((s) => s.setSelectedNodeId);
  const openEvidence = useWorkspaceStore((s) => s.openEvidence);
  const topDownGraph = useMemo(() => orientGraphTopDown(graph), [graph]);

  const nodes: Node[] = useMemo(
    () => [
      ...topDownGraph.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: {
          ...n.data,
          is_corrected: correctedNodeIds.includes(n.id),
        },
        draggable: false,
        connectable: false,
        selectable: true,
      })),
      ...branchBoundsNodes(topDownGraph),
    ],
    [topDownGraph, correctedNodeIds],
  );

  const edges: Edge[] = useMemo(
    () =>
      topDownGraph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "labeled",
        sourceHandle: undefined,
        targetHandle: undefined,
        data: {
          label: e.label,
          waypoints: e.waypoints,
          is_exception_path: e.is_exception_path,
          sourceSide: e.sourceSide,
          targetSide: e.targetSide,
        },
        markerEnd: e.is_exception_path ? "url(#arrow-exception)" : "url(#arrow)",
      })),
    [topDownGraph.edges],
  );

  return (
    <div className="canvas-dotted relative size-full">
      <svg className="absolute size-0">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 Z" fill="#9C9C92" />
          </marker>
          <marker
            id="arrow-exception"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 Z" fill="#C0432F" />
          </marker>
        </defs>
      </svg>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.4}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          setSelected(node.id);
          const evidenceIds = (node.data as { evidence_ids?: string[] }).evidence_ids;
          if (evidenceIds && evidenceIds.length > 0) {
            onNodeEvidenceOpen?.({
              title: String((node.data as { title?: unknown }).title ?? "Workflow step"),
              evidenceIds,
            });
            return;
          }
          const claimIds = (node.data as { claim_ids?: string[] }).claim_ids;
          if (claimIds && claimIds.length > 0) {
            openEvidence(claimIds[0]);
          }
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#E2E2DA" />
        <MiniMap
          nodeColor={(n) =>
            n.type === "decision"
              ? "#F1E2A0"
              : n.type === "wait"
                ? "#D6D6CC"
                : n.type === "end"
                  ? "#E59A85"
                  : "#1A1A1A"
          }
          maskColor="rgba(250, 250, 247, 0.7)"
          pannable
          zoomable
        />
        <Controls
          showInteractive={false}
          position="bottom-left"
          className="!bottom-6 !left-6"
        />
      </ReactFlow>

      <LayoutModeToggle className="absolute left-6 top-6" />
    </div>
  );
}

function BranchBoundsNode() {
  return <div className="size-px opacity-0" />;
}

function orientGraphTopDown(graph: ProcessGraph): ProcessGraph {
  const flowNodes = graph.nodes.filter(
    (node) => node.type !== "start" && node.type !== "end",
  );
  const layout = layoutOperatorGraph(flowNodes.length);
  const flowNodePositions = new Map(
    flowNodes.map((node, index) => [
      node.id,
      node.type === "decision"
        ? layout.decisionPosition(index)
        : layout.taskPosition(index),
    ]),
  );

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.type === "start") {
        return { ...node, position: layout.startPosition };
      }
      if (node.type === "end") {
        return { ...node, position: layout.endPosition };
      }
      return {
        ...node,
        position: flowNodePositions.get(node.id) ?? node.position,
      };
    }),
    edges: graph.edges.map((edge) => ({
      ...edge,
      waypoints: undefined,
      sourceSide: "bottom",
      targetSide: "top",
    })),
  };
}

function branchBoundsNodes(graph: ProcessGraph): Node[] {
  const nodeCenterById = new Map(
    graph.nodes.map((node) => [
      node.id,
      {
        x: node.position.x + estimatedNodeWidth(node.type) / 2,
        y: node.position.y + estimatedNodeHeight(node.type) / 2,
      },
    ]),
  );

  return graph.edges
    .filter((edge) => edge.label && !/^yes\b/i.test(edge.label))
    .flatMap((edge) => {
      const source = nodeCenterById.get(edge.source);
      const target = nodeCenterById.get(edge.target);
      if (!source || !target) return [];
      const direction = /^no\b/i.test(edge.label ?? "") ? 1 : -1;
      const laneX = source.x + direction * VERTICAL_BRANCH_LANE_OFFSET_X;
      return [
        {
          id: `${edge.id}-branch-start-bound`,
          type: BRANCH_BOUNDS_NODE_TYPE,
          position: { x: laneX, y: source.y },
          data: {},
          draggable: false,
          connectable: false,
          selectable: false,
          focusable: false,
          style: { width: 1, height: 1, opacity: 0, pointerEvents: "none" },
        },
        {
          id: `${edge.id}-branch-end-bound`,
          type: BRANCH_BOUNDS_NODE_TYPE,
          position: { x: laneX, y: target.y },
          data: {},
          draggable: false,
          connectable: false,
          selectable: false,
          focusable: false,
          style: { width: 1, height: 1, opacity: 0, pointerEvents: "none" },
        },
      ] satisfies Node[];
    });
}

function estimatedNodeWidth(type?: string) {
  if (type === "start") return 120;
  if (type === "end") return 140;
  if (type === "decision") return 180;
  return 240;
}

function estimatedNodeHeight(type?: string) {
  if (type === "start") return 120;
  if (type === "end") return 140;
  if (type === "decision") return 180;
  return 80;
}
