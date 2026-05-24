"use client";

import { EdgeLabelRenderer, type EdgeProps } from "reactflow";

type Data = {
  label?: string;
  waypoints?: { x: number; y: number }[];
  is_exception_path?: boolean;
  sourceSide?: "top" | "bottom" | "left" | "right";
  targetSide?: "top" | "bottom" | "left" | "right";
};

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
      : { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 };

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
            className="rounded-full border border-subtle bg-surface px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary shadow-card"
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
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
