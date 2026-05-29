import type { EdgeWaypoint, GraphNode } from "@/lib/types/graph";

export type OperatorGraphLayout = {
  startPosition: GraphNode["position"];
  taskPosition: (index: number) => GraphNode["position"];
  endPosition: GraphNode["position"];
};

const START_POSITION: GraphNode["position"] = { x: 80, y: 120 };
const FIRST_TASK_X = 320;
const FIRST_TASK_Y = 120;
const DEFAULT_COLUMNS = 8;
const DEFAULT_COLUMN_WIDTH = 260;
const DEFAULT_ROW_HEIGHT = 190;
const EDGE_MIDPOINT_OFFSET_X = 150;

export function layoutOperatorGraph(taskCount: number): OperatorGraphLayout {
  const columns = DEFAULT_COLUMNS;
  const taskPosition = (index: number) => gridPosition(index, columns);
  return {
    startPosition: START_POSITION,
    taskPosition,
    endPosition: taskCount > 0 ? gridPosition(taskCount, columns) : gridPosition(0, columns),
  };
}

export function operatorEdgeWaypoints(
  source: GraphNode["position"],
  target: GraphNode["position"],
): EdgeWaypoint[] | undefined {
  if (source.y === target.y) return undefined;
  const midX = source.x + EDGE_MIDPOINT_OFFSET_X;
  return [
    { x: midX, y: source.y },
    { x: midX, y: target.y },
  ];
}

function gridPosition(index: number, columns: number): GraphNode["position"] {
  return {
    x: FIRST_TASK_X + (index % columns) * DEFAULT_COLUMN_WIDTH,
    y: FIRST_TASK_Y + Math.floor(index / columns) * DEFAULT_ROW_HEIGHT,
  };
}
