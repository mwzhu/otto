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
import { LabeledEdge } from "./edges/LabeledEdge";
import type { ProcessGraph } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/store/workspace";
import { LayoutModeToggle } from "./LayoutModeToggle";

const nodeTypes = {
  task: TaskNode,
  decision: DecisionNode,
  wait: WaitNode,
  end: EndNode,
  start: StartNode,
  handoff: HandoffNode,
  exception: ExceptionNode,
};

const edgeTypes = {
  labeled: LabeledEdge,
};

export function ProcessCanvas({ graph }: { graph: ProcessGraph }) {
  const correctedNodeIds = useWorkspaceStore((s) => s.correctedNodeIds);
  const setSelected = useWorkspaceStore((s) => s.setSelectedNodeId);
  const openEvidence = useWorkspaceStore((s) => s.openEvidence);

  const nodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
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
    [graph.nodes, correctedNodeIds],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "labeled",
        sourceHandle:
          e.sourceSide === "left"
            ? "left"
            : e.sourceSide === "right"
              ? "right"
              : undefined,
        targetHandle:
          e.targetSide === "left"
            ? "left"
            : e.targetSide === "right"
              ? "right"
              : undefined,
        data: {
          label: e.label,
          waypoints: e.waypoints,
          is_exception_path: e.is_exception_path,
          sourceSide: e.sourceSide,
          targetSide: e.targetSide,
        },
        markerEnd: e.is_exception_path ? "url(#arrow-exception)" : "url(#arrow)",
      })),
    [graph.edges],
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
