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
    evidence_ids?: string[];
    claim_ids?: string[];
    inputs?: Array<{
      name: string;
      description?: string;
      evidence_ids?: string[];
    }>;
    outputs?: Array<{
      name: string;
      description?: string;
      evidence_ids?: string[];
    }>;
    exceptions?: Array<{
      label: string;
      sub_type?: string;
      trigger?: string;
      detection?: string;
      evidence_ids?: string[];
    }>;
    workarounds?: Array<{
      description: string;
      why_it_exists?: string;
      evidence_ids?: string[];
    }>;
    variants?: Array<{
      condition: string;
      alt_node_id?: string;
      evidence_ids?: string[];
    }>;
    terminal?: boolean;
    source_provisional_step_ids?: string[];
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
  evidence_ids?: string[];
  waypoints?: EdgeWaypoint[]; // authored orthogonal routing
  sourceSide?: "top" | "bottom" | "left" | "right";
  targetSide?: "top" | "bottom" | "left" | "right";
};

export type ProcessGraph = {
  version_id?: string;
  process_id: string;
  version_number: number;
  status: "draft" | "approved";
  summary?: string | null;
  warnings?: Array<{
    code: string;
    message: string;
    evidence_ids?: string[];
  }>;
  nodes: GraphNode[];
  edges: GraphEdge[];
};
