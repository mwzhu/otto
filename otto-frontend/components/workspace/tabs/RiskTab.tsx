"use client";

import type { ProcessFollowUpTask } from "@/lib/processes/follow-up-queries";

export function RiskTab({
  processId: _processId,
  followUps = [],
}: {
  processId?: string;
  followUps?: ProcessFollowUpTask[];
}) {
  const riskFollowUps = followUps.filter(isRiskFollowUp);
  if (riskFollowUps.length === 0) {
    return (
      <div className="px-5 py-5 text-[13px] text-ink-secondary">
        No open risk follow-ups are currently linked to this process map.
      </div>
    );
  }

  return (
    <div className="space-y-3 px-5 py-5 text-[13px] text-ink-secondary">
      <div>
        <h3 className="text-[14px] font-semibold tracking-tight text-ink">
          Risk follow-ups
        </h3>
        <p className="mt-1 text-[12px] text-ink-muted">
          Evidence gaps, contradictions, and redaction issues that need reviewer
          attention.
        </p>
      </div>
      <div className="space-y-2">
        {riskFollowUps.map((task) => (
          <RiskFollowUpItem key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}

function RiskFollowUpItem({ task }: { task: ProcessFollowUpTask }) {
  const reason = typeof task.context_json.reason === "string"
    ? task.context_json.reason.replaceAll("_", " ")
    : task.task_type.replaceAll("_", " ");
  return (
    <article className="rounded-md border border-subtle bg-canvas p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-ink">{task.title}</div>
          {task.description && (
            <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
              {task.description}
            </p>
          )}
        </div>
        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium leading-5 text-ink-secondary">
          p{task.priority.toFixed(2)}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="rounded-full bg-surface px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">
          {reason}
        </span>
        {task.target_type && (
          <span className="rounded-full bg-surface px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">
            {task.target_type.replaceAll("_", " ")}
          </span>
        )}
        <span className="rounded-full bg-surface px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">
          {task.status.replace("_", " ")}
        </span>
      </div>
    </article>
  );
}

function isRiskFollowUp(task: ProcessFollowUpTask) {
  const reason = task.context_json.reason;
  return (
    task.task_type === "redaction_failure" ||
    task.task_type === "failed_stage" ||
    task.task_type === "weak_merge" ||
    (typeof reason === "string" &&
      /contradiction|gap|low_confidence|redaction/i.test(reason))
  );
}
