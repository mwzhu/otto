"use client";

import { EdgeLabelRenderer, type EdgeProps } from "reactflow";

type Data = {
  label?: string;
  waypoints?: { x: number; y: number }[];
  is_exception_path?: boolean;
  sourceSide?: "top" | "bottom" | "left" | "right";
  targetSide?: "top" | "bottom" | "left" | "right";
};

export const VERTICAL_BRANCH_LANE_OFFSET_X = 180;

export function LabeledEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  selected,
  markerEnd,
}: EdgeProps<Data>) {
  const points: [number, number][] = [];
  points.push([sourceX, sourceY]);

  if (data?.waypoints && data.waypoints.length > 0) {
    // Use the authored waypoints directly to produce orthogonal routing.
    for (const wp of data.waypoints) points.push([wp.x, wp.y]);
    points.push([targetX, targetY]);
  } else if (data?.label && shouldRouteBranchAroundRow(sourceX, sourceY, targetX, targetY)) {
    const offsetY = branchLabelDirection(data.label) * 96;
    const sourceOffsetX = Math.min(120, Math.max(72, Math.abs(targetX - sourceX) * 0.22));
    const targetOffsetX = Math.min(120, Math.max(72, Math.abs(targetX - sourceX) * 0.22));
    points.push([sourceX + sourceOffsetX, sourceY]);
    points.push([sourceX + sourceOffsetX, sourceY + offsetY]);
    points.push([targetX - targetOffsetX, targetY + offsetY]);
    points.push([targetX - targetOffsetX, targetY]);
    points.push([targetX, targetY]);
  } else if (shouldRouteBranchAroundColumn(sourceX, sourceY, targetX, targetY, data)) {
    const direction = branchLabelDirection(data?.label);
    const offsetX = direction * VERTICAL_BRANCH_LANE_OFFSET_X;
    const verticalDirection = Math.sign(targetY - sourceY) || 1;
    const offsetY = Math.min(96, Math.max(56, Math.abs(targetY - sourceY) * 0.2));
    points.push([sourceX, sourceY + verticalDirection * offsetY]);
    points.push([sourceX + offsetX, sourceY + verticalDirection * offsetY]);
    points.push([targetX + offsetX, targetY - verticalDirection * offsetY]);
    points.push([targetX, targetY - verticalDirection * offsetY]);
    points.push([targetX, targetY]);
  } else {
    // Default orthogonal routing: vertical-first or horizontal-first depending
    // on which sides are wired up.
    const sourceSide = data?.sourceSide ?? "bottom";
    const targetSide = data?.targetSide ?? "top";

    if (
      (sourceSide === "bottom" || sourceSide === "top") &&
      (targetSide === "top" || targetSide === "bottom")
    ) {
      const midY = (sourceY + targetY) / 2;
      points.push([sourceX, midY]);
      points.push([targetX, midY]);
      points.push([targetX, targetY]);
    } else if (
      (sourceSide === "left" || sourceSide === "right") &&
      (targetSide === "left" || targetSide === "right")
    ) {
      const midX = (sourceX + targetX) / 2;
      points.push([midX, sourceY]);
      points.push([midX, targetY]);
      points.push([targetX, targetY]);
    } else if (sourceSide === "left" || sourceSide === "right") {
      // Out the side then down/up.
      points.push([targetX, sourceY]);
      points.push([targetX, targetY]);
    } else {
      // Down/up then sideways.
      points.push([sourceX, targetY]);
      points.push([targetX, targetY]);
    }
  }

  const d = roundedOrthogonalPath(points, 8);

  const labelPoint =
    data?.waypoints && data.waypoints.length > 0
      ? data.waypoints[0]
      : data?.label && shouldRouteBranchAroundRow(sourceX, sourceY, targetX, targetY)
        ? {
            x: (sourceX + targetX) / 2,
            y: sourceY + branchLabelDirection(data.label) * 96,
          }
      : shouldRouteBranchAroundColumn(sourceX, sourceY, targetX, targetY, data)
        ? {
            x:
              sourceX +
              branchLabelDirection(data?.label) * VERTICAL_BRANCH_LANE_OFFSET_X,
            y: (sourceY + targetY) / 2,
          }
      : {
          x: (sourceX + targetX) / 2,
          y:
            data?.sourceSide === "right" && data?.targetSide === "left"
              ? (sourceY + targetY) / 2 - 18
              : (sourceY + targetY) / 2,
        };

  const strokeColor = selected
    ? "#1A1A1A"
    : data?.is_exception_path
      ? "#C0432F"
      : "#C0C0B6";

  return (
    <>
      <path
        id={id}
        d={d}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.2}
        markerEnd={markerEnd}
        strokeDasharray={data?.is_exception_path ? "4 3" : undefined}
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelPoint.x}px, ${labelPoint.y}px)`,
              pointerEvents: "none",
            }}
            className="max-w-[180px] rounded-full border border-subtle bg-surface px-2 py-0.5 text-center text-[10.5px] font-medium leading-tight text-ink-secondary shadow-card"
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function shouldRouteBranchAroundRow(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
) {
  return Math.abs(sourceY - targetY) < 12 && Math.abs(targetX - sourceX) > 260;
}

function shouldRouteBranchAroundColumn(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  data?: Data,
) {
  return (
    Boolean(data?.label) &&
    !isPrimaryBranchLabel(data?.label) &&
    Math.abs(sourceX - targetX) < 16 &&
    Math.abs(targetY - sourceY) > 160
  );
}

function branchLabelDirection(label: string | undefined) {
  return /^no\b/i.test(label ?? "") ? 1 : -1;
}

function isPrimaryBranchLabel(label: string | undefined) {
  return /^yes\b/i.test(label ?? "");
}

function roundedOrthogonalPath(points: [number, number][], r: number) {
  if (points.length < 2) return "";
  let path = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const dx1 = Math.sign(cx - px);
    const dy1 = Math.sign(cy - py);
    const dx2 = Math.sign(nx - cx);
    const dy2 = Math.sign(ny - cy);
    const distIn = Math.hypot(cx - px, cy - py);
    const distOut = Math.hypot(nx - cx, ny - cy);
    const radius = Math.min(r, distIn / 2, distOut / 2);
    const endIn = [cx - dx1 * radius, cy - dy1 * radius];
    const startOut = [cx + dx2 * radius, cy + dy2 * radius];
    path += ` L ${endIn[0]} ${endIn[1]}`;
    path += ` Q ${cx} ${cy} ${startOut[0]} ${startOut[1]}`;
  }
  const [lx, ly] = points[points.length - 1];
  path += ` L ${lx} ${ly}`;
  return path;
}
