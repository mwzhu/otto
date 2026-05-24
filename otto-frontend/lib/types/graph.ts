export type NodeType =
  | "start"
  | "task"
  | "decision"
  | "wait"
  | "handoff"
  | "exception"
  | "end";

export type EdgeType = "seq" | "conditional" | "handoff" | "parallel";

export type GraphNode = {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: {
    title: string;
    description?: string;
    role?: string;
    systems?: string[];
    sla_seconds?: number;
    est_minutes?: number;
    confidence?: number;
    exception_count?: number;
    has_workaround?: boolean;
    is_corrected?: boolean;
    claim_ids?: string[];
  };
  parent_node_id?: string;
};

export type EdgeWaypoint = { x: number; y: number };

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  edge_type: EdgeType;
  label?: string;
  condition?: string;
  is_exception_path?: boolean;
  waypoints?: EdgeWaypoint[]; // authored orthogonal routing
  sourceSide?: "top" | "bottom" | "left" | "right";
  targetSide?: "top" | "bottom" | "left" | "right";
};

export type ProcessGraph = {
  process_id: string;
  version_number: number;
  status: "draft" | "approved";
  nodes: GraphNode[];
  edges: GraphEdge[];
};
