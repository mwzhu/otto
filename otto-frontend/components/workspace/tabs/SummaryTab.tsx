"use client";

import type { ProcessGraph } from "@/lib/types";
import type { ProcessFollowUpTask } from "@/lib/processes/follow-up-queries";

export function SummaryTab({
  processId,
  graph,
  followUps = [],
}: {
  processId: string;
  graph?: ProcessGraph;
  followUps?: ProcessFollowUpTask[];
}) {
  const stepCount = graph?.nodes.filter((node) => node.type === "task").length ?? 0;
  const decisionCount =
    graph?.nodes.filter((node) => node.type === "decision").length ?? 0;
  const evidenceCount =
    graph?.nodes.reduce(
      (count, node) => count + (node.data.evidence_ids?.length ?? 0),
      0,
    ) ?? 0;

  const visibleFollowUps = followUps.slice(0, 4);

  return (
    <div className="space-y-4 px-5 py-5 text-[13px] leading-relaxed text-ink-secondary">
      <p>
        Process map <span className="font-mono">{processId}</span> is currently
        represented as version {graph?.version_number ?? "n/a"} with{" "}
        {stepCount} operator step{stepCount === 1 ? "" : "s"}.
      </p>
      {graph?.summary && (
        <p className="rounded-md border border-subtle bg-canvas px-3 py-2 text-[12.5px] leading-relaxed text-ink-secondary">
          {graph.summary}
        </p>
      )}
      {graph?.warnings && graph.warnings.length > 0 && (
        <section className="rounded-md border border-[#F0DCAA] bg-[#FFF9EB] p-3">
          <h3 className="text-[12.5px] font-semibold text-ink">
            Draft warnings
          </h3>
          <div className="mt-2 space-y-2">
            {graph.warnings.map((warning) => (
              <div key={`${warning.code}-${warning.message}`} className="text-[12px] leading-relaxed text-ink-secondary">
                <span className="font-medium text-ink">
                  {warning.code.replaceAll("_", " ")}:
                </span>{" "}
                {warning.message}
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="grid grid-cols-3 gap-2">
        <SummaryMetric label="Steps" value={stepCount} />
        <SummaryMetric label="Decisions" value={decisionCount} />
        <SummaryMetric label="Evidence" value={evidenceCount} />
      </div>
      {visibleFollowUps.length > 0 && (
        <section className="rounded-md border border-subtle bg-surface p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[12.5px] font-semibold text-ink">
              Open follow-ups
            </h3>
            <span className="text-[11px] text-ink-muted">
              {followUps.length} active
            </span>
          </div>
          <div className="mt-3 space-y-2">
            {visibleFollowUps.map((task) => (
              <FollowUpSummaryItem key={task.id} task={task} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-subtle bg-canvas px-3 py-2">
      <div className="text-[18px] font-semibold leading-none text-ink">
        {value}
      </div>
      <div className="mt-1 text-[11px] text-ink-muted">{label}</div>
    </div>
  );
}

function FollowUpSummaryItem({ task }: { task: ProcessFollowUpTask }) {
  return (
    <div className="rounded-md border border-subtle bg-canvas px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-medium text-ink">
            {task.title}
          </div>
          {task.description && (
            <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-ink-muted">
              {task.description}
            </p>
          )}
        </div>
        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium leading-5 text-ink-secondary">
          {task.status.replace("_", " ")}
        </span>
      </div>
    </div>
  );
}
