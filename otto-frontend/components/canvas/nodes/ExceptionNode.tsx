"use client";

import { Handle, Position, type NodeProps } from "reactflow";

export function ExceptionNode({
  data,
}: NodeProps<{ title: string; trigger?: string }>) {
  return (
    <div className="w-[220px] rounded-md border border-[#F1C9B6] bg-[#FFF6F1] px-3 py-2.5 shadow-card">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[#9F4626]">
        Exception
      </div>
      <div className="mt-1 text-[12px] font-medium leading-snug text-ink">
        {data.title}
      </div>
      {data.trigger && (
        <div className="mt-1 text-[11px] leading-snug text-ink-secondary">
          {data.trigger}
        </div>
      )}
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}
