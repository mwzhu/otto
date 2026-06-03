import type { EdgeWaypoint, GraphNode } from "@/lib/types/graph";

export type OperatorGraphLayout = {
  startPosition: GraphNode["position"];
  taskPosition: (index: number) => GraphNode["position"];
  decisionPosition: (index: number) => GraphNode["position"];
  endPosition: GraphNode["position"];
};

const FLOW_CENTER_X = 420;
const START_CENTER_Y = 140;
const FIRST_STEP_CENTER_Y = 360;
const DEFAULT_LAYER_HEIGHT = 260;
const START_DIAMETER = 120;
const TASK_CARD_WIDTH = 240;
const TASK_CARD_ESTIMATED_HEIGHT = 80;
const DECISION_DIAMETER = 180;
const END_DIAMETER = 140;

export function layoutOperatorGraph(taskCount: number): OperatorGraphLayout {
  const taskPosition = (index: number) => verticalPosition(index);
  const decisionPosition = (index: number) =>
    verticalPosition(index, DECISION_DIAMETER, DECISION_DIAMETER);
  return {
    startPosition: {
      x: FLOW_CENTER_X - START_DIAMETER / 2,
      y: START_CENTER_Y - START_DIAMETER / 2,
    },
    taskPosition,
    decisionPosition,
    endPosition:
      taskCount > 0
        ? endPositionAfterLastTask(taskCount)
        : verticalPosition(0, END_DIAMETER, END_DIAMETER),
  };
}

export function operatorEdgeWaypoints(
  source: GraphNode["position"],
  target: GraphNode["position"],
): EdgeWaypoint[] | undefined {
  if (Math.abs(source.x - target.x) < TASK_CARD_WIDTH / 2) return undefined;
  const midY = (source.y + target.y) / 2;
  return [
    { x: source.x, y: midY },
    { x: target.x, y: midY },
  ];
}

function verticalPosition(
  index: number,
  estimatedWidth = TASK_CARD_WIDTH,
  estimatedHeight = TASK_CARD_ESTIMATED_HEIGHT,
): GraphNode["position"] {
  const stepCenterY = FIRST_STEP_CENTER_Y + index * DEFAULT_LAYER_HEIGHT;
  return {
    x: FLOW_CENTER_X - estimatedWidth / 2,
    y: stepCenterY - estimatedHeight / 2,
  };
}

function endPositionAfterLastTask(taskCount: number): GraphNode["position"] {
  const endCenterY = FIRST_STEP_CENTER_Y + taskCount * DEFAULT_LAYER_HEIGHT;
  return {
    x: FLOW_CENTER_X - END_DIAMETER / 2,
    y: endCenterY - END_DIAMETER / 2,
  };
}
