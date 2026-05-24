"use client";

import { Handle, Position, type NodeProps } from "reactflow";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";

type Data = {
  title: string;
  role?: string;
  systems?: string[];
  exception_count?: number;
  has_workaround?: boolean;
  is_corrected?: boolean;
  confidence?: number;
  claim_ids?: string[];
};

export function TaskNode({ data, selected }: NodeProps<Data>) {
  const lowConf = (data.confidence ?? 1) < 0.7;
  return (
    <div
      className={cn(
        "w-[240px] rounded-md border bg-surface px-3.5 py-3 text-left shadow-card transition",
        selected ? "border-ink" : "border-subtle",
        lowConf && "border-dashed",
        data.is_corrected && "ring-2 ring-grad-to/70 ring-offset-2 ring-offset-canvas",
      )}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="target" position={Position.Left} id="left" className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <Handle type="source" position={Position.Right} id="right" className="!opacity-0" />

      <div className="flex items-start gap-2">
        <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-muted text-ink-secondary">
          <PersonIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium leading-snug text-ink">
            {data.title}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {data.role && <Pill tone="role">{data.role}</Pill>}
          </div>
          {(data.exception_count || data.has_workaround) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {data.has_workaround && (
                <Pill tone="warn">workaround</Pill>
              )}
              {data.exception_count ? (
                <Pill tone="warn">
                  {data.exception_count} exception
                  {data.exception_count > 1 ? "s" : ""}
                </Pill>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PersonIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M8 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3 14.5a5 5 0 0110 0"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
