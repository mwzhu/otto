"use client";

import { Handle, Position, type NodeProps } from "reactflow";

export function EndNode({ data }: NodeProps<{ title: string }>) {
  return (
    <div className="relative size-[140px]">
      <svg
        viewBox="0 0 140 140"
        className="absolute inset-0 size-full"
        aria-hidden
      >
        <circle
          cx="70"
          cy="70"
          r="64"
          fill="#FFF5F1"
          stroke="#E59A85"
          strokeWidth="1.3"
        />
      </svg>
      <div className="absolute inset-x-6 inset-y-0 grid place-items-center text-center">
        <span className="text-[12px] font-medium leading-snug text-ink">
          {data.title}
        </span>
      </div>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="target" position={Position.Left} id="left" className="!opacity-0" />
    </div>
  );
}
