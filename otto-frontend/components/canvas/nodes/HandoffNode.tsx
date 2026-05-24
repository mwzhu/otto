"use client";

import { Handle, Position, type NodeProps } from "reactflow";

export function HandoffNode({ data }: NodeProps<{ title: string; channel?: string }>) {
  return (
    <div className="w-[220px] rounded-md border border-subtle bg-[#FAFAFE] px-3 py-2.5 shadow-card">
      <div className="flex items-center gap-2">
        <span className="grid size-5 place-items-center rounded-full bg-grad-to/30 text-ink-secondary">
          <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden>
            <path d="M4 8h8M8 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </svg>
        </span>
        <span className="text-[12px] font-medium text-ink">{data.title}</span>
      </div>
      {data.channel && (
        <div className="mt-1 pl-7 text-[10.5px] uppercase tracking-wide text-ink-muted">
          via {data.channel}
        </div>
      )}
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}
