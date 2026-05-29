"use client";

import type { ProcessFollowUpTask } from "@/lib/processes/follow-up-queries";
import type { ProcessGraph } from "@/lib/types";

export function InsightsTab({
  processId: _processId,
  graph,
  followUps = [],
}: {
  processId?: string;
  graph?: ProcessGraph;
  followUps?: ProcessFollowUpTask[];
}) {
  const insights = graph ? buildInsights(graph, followUps) : [];
  if (!graph || insights.length === 0) {
    return (
      <div className="px-5 py-5 text-[13px] text-ink-secondary">
        No graph-backed insights have been generated for this process yet.
      </div>
    );
  }

  return (
    <div className="space-y-3 px-5 py-5 text-[13px] text-ink-secondary">
      {graph.summary && (
        <section className="rounded-md border border-subtle bg-canvas p-3">
          <h3 className="text-[12.5px] font-semibold text-ink">
            Generated narrative
          </h3>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
            {graph.summary}
          </p>
        </section>
      )}
      <div className="grid grid-cols-2 gap-2">
        {insights.map((insight) => (
          <InsightCard key={insight.label} {...insight} />
        ))}
      </div>
    </div>
  );
}

type Insight = {
  label: string;
  value: string;
  detail: string;
};

function buildInsights(
  graph: ProcessGraph,
  followUps: ProcessFollowUpTask[],
): Insight[] {
  const taskNodes = graph.nodes.filter((node) => node.type === "task");
  const systemNames = new Set(
    graph.nodes.flatMap((node) => node.data.systems ?? []).filter(Boolean),
  );
  const workaroundCount = graph.nodes.reduce(
    (count, node) => count + (node.data.workarounds?.length ?? 0),
    0,
  );
  const exceptionCount =
    graph.nodes.filter((node) => node.type === "exception").length +
    graph.nodes.reduce(
      (count, node) => count + (node.data.exceptions?.length ?? 0),
      0,
    );
  const handoffCount =
    graph.nodes.filter((node) => node.type === "handoff").length +
    graph.edges.filter((edge) => edge.edge_type === "handoff").length;
  const evidenceCount = new Set(
    graph.nodes.flatMap((node) => node.data.evidence_ids ?? []),
  ).size;
  const openQuestionCount = followUps.filter(
    (task) => task.task_type === "open_question",
  ).length;

  return [
    {
      label: "Operator steps",
      value: String(taskNodes.length),
      detail: `${graph.edges.length} flow connection${graph.edges.length === 1 ? "" : "s"} mapped`,
    },
    {
      label: "Systems touched",
      value: String(systemNames.size),
      detail:
        systemNames.size > 0
          ? [...systemNames].slice(0, 3).join(", ")
          : "No systems captured yet",
    },
    {
      label: "Exceptions",
      value: String(exceptionCount),
      detail: "Exception nodes and step-level exception details",
    },
    {
      label: "Workarounds",
      value: String(workaroundCount),
      detail: "Manual bypasses or unofficial paths observed",
    },
    {
      label: "Handoffs",
      value: String(handoffCount),
      detail: "Role or system ownership transitions",
    },
    {
      label: "Evidence",
      value: String(evidenceCount),
      detail: `${openQuestionCount} open validation question${openQuestionCount === 1 ? "" : "s"}`,
    },
  ];
}

function InsightCard({ label, value, detail }: Insight) {
  return (
    <article className="rounded-md border border-subtle bg-canvas px-3 py-2">
      <div className="text-[18px] font-semibold leading-none text-ink">
        {value}
      </div>
      <div className="mt-1 text-[11.5px] font-medium text-ink">{label}</div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-muted">
        {detail}
      </p>
    </article>
  );
}
