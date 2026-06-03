"use client";

import { Handle, Position, type NodeProps } from "reactflow";
import { cn } from "@/lib/cn";

type Data = {
  title: string;
  confidence?: number;
};

export function DecisionNode({ data, selected }: NodeProps<Data>) {
  return (
    <div className="relative size-[180px]">
      {/* Diamond shape */}
      <svg
        viewBox="0 0 180 180"
        className="absolute inset-0 size-full overflow-visible"
        aria-hidden
      >
        <polygon
          points="90,8 172,90 90,172 8,90"
          fill="#FFFBEC"
          stroke={selected ? "#1A1A1A" : "#E8D58C"}
          strokeWidth={selected ? 1.6 : 1.2}
        />
      </svg>
      {/* Cross icon top */}
      <span className="absolute left-1/2 top-4 -translate-x-1/2 text-ink-muted">
        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
          <path
            d="M2 2l8 8M10 2l-8 8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <div className="absolute inset-x-8 inset-y-10 grid place-items-center text-center">
        <span className="text-[12px] font-medium leading-tight text-ink">
          {data.title}
        </span>
      </div>

      {/* Connection handles */}
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="target" position={Position.Left} id="left" className="!opacity-0" />
      <Handle type="target" position={Position.Right} id="right" className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <Handle type="source" position={Position.Left} id="left" className="!opacity-0" />
      <Handle type="source" position={Position.Right} id="right" className="!opacity-0" />
    </div>
  );
}
