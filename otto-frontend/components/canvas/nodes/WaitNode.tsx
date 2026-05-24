"use client";

import { Handle, Position, type NodeProps } from "reactflow";

type Data = {
  title: string;
  sla_seconds?: number;
};

export function WaitNode({ data, selected }: NodeProps<Data>) {
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
          r="66"
          fill="#FFFFFF"
          stroke={selected ? "#1A1A1A" : "#D9D9CF"}
          strokeWidth={selected ? 1.6 : 1.2}
        />
      </svg>
      <span className="absolute left-1/2 top-7 -translate-x-1/2 text-ink-muted">
        <ClockIcon />
      </span>
      <div className="absolute inset-x-6 top-14 grid place-items-center text-center">
        <span className="text-[11.5px] font-medium leading-snug text-ink">
          {data.title}
        </span>
      </div>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M8 4.5V8l2.4 1.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
