"use client";

import { Handle, Position, type NodeProps } from "reactflow";

export function StartNode({ data }: NodeProps<{ title: string }>) {
  return (
    <div className="relative size-[120px]">
      <svg viewBox="0 0 120 120" className="absolute inset-0 size-full" aria-hidden>
        <circle
          cx="60"
          cy="60"
          r="54"
          fill="#F1F8EE"
          stroke="#8FC58A"
          strokeWidth="1.3"
        />
      </svg>
      <div className="absolute inset-x-4 inset-y-0 grid place-items-center text-center">
        <span className="text-[11.5px] font-medium leading-snug text-ink">
          {data.title}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <Handle type="source" position={Position.Right} id="right" className="!opacity-0" />
    </div>
  );
}
