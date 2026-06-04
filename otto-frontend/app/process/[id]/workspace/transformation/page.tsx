import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { requirePageAuth } from "@/lib/auth/session";
import { getCurrentProcessGraph } from "@/lib/processes/graph-queries";
import { getProcessOpportunities } from "@/lib/processes/opportunity-queries";
import { getWorkspaceForProcess } from "@/lib/workspaces/current";

export default async function TransformationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const auth = await requirePageAuth();
  const workspace = await getWorkspaceForProcess(auth, id);
  if (!workspace) notFound();

  const graph = await getCurrentProcessGraph(auth.orgId, workspace.id, id);
  if (!graph) {
    return (
      <main className="mx-auto w-full max-w-[1180px] px-6 py-6">
        <Card className="p-6">
          <h1 className="text-[18px] font-semibold tracking-tight text-ink">
            Transformation Proposal
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
            Add operator evidence to publish a current-state workflow map before
            comparing transformation options.
          </p>
        </Card>
      </main>
    );
  }

  const opportunitiesResult = await getProcessOpportunities({
    orgId: auth.orgId,
    workspaceId: workspace.id,
    processId: id,
    graph,
  });
  const opportunities = opportunitiesResult.opportunities;
  const primary = opportunities[0];

  return (
    <main className="mx-auto w-full max-w-[1180px] space-y-5 px-6 py-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Transformation Proposal
          </div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">
            Current process vs target state
          </h1>
          <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-ink-secondary">
            Otto derived this proposal from the published workflow map, keeping
            evidence-linked friction separate from open assumptions.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Pill tone={opportunitiesResult.source === "agent" ? "success" : "neutral"}>
            {opportunitiesResult.source}
          </Pill>
          <Pill tone={graph.status === "approved" ? "success" : "draft"}>
            v{graph.version_number} {graph.status}
          </Pill>
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">
              Current Process
            </h2>
            <Pill tone="neutral">{graph.nodes.length} nodes</Pill>
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
            {graph.summary ?? "The current map is available without a summary."}
          </p>
          <div className="mt-4 space-y-2">
            {opportunities.slice(0, 3).map((opportunity) => (
              <div
                key={opportunity.id}
                className="rounded-md border border-subtle bg-canvas px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12.5px] font-medium text-ink">
                    {opportunity.source_node_title}
                  </span>
                  <Pill tone={opportunity.impact === "high" ? "high" : opportunity.impact}>
                    {opportunity.impact} impact
                  </Pill>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                  {opportunity.current_state}
                </p>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">
              Transformation Proposal
            </h2>
            <Pill tone={primary?.evidence_ids.length ? "success" : "warn"}>
              {primary?.evidence_label ?? "No opportunities"}
            </Pill>
          </div>
          {primary ? (
            <>
              <p className="mt-2 text-[13px] font-medium text-ink">
                {primary.title}
              </p>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
                {primary.target_state}
              </p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <MiniMetric label="Pattern" value={primary.pattern_label} />
                <MiniMetric label="Grounding" value={primary.evidence_label} />
                <MiniMetric
                  label="Integrations"
                  value={primary.integration_requirements.join(", ")}
                />
                <MiniMetric
                  label="Dependency"
                  value={primary.dependencies[0] ?? "Owner review"}
                />
              </div>
            </>
          ) : (
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
              No transformation opportunities were found in the current graph.
            </p>
          )}
        </Card>
      </section>

      {opportunities.length > 1 && (
        <section className="space-y-2">
          <h2 className="text-[14px] font-semibold tracking-tight text-ink">
            Additional options
          </h2>
          {opportunities.slice(1, 4).map((opportunity) => (
            <Card key={opportunity.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[13px] font-medium text-ink">
                    {opportunity.title}
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                    {opportunity.proposed_solution}
                  </p>
                </div>
                <Pill tone={opportunity.evidence_ids.length ? "success" : "warn"}>
                  {opportunity.evidence_label}
                </Pill>
              </div>
            </Card>
          ))}
        </section>
      )}
    </main>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-subtle bg-canvas px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <div className="mt-1 text-[12px] font-medium leading-snug text-ink">
        {value}
      </div>
    </div>
  );
}
