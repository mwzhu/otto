import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { ROIAssumptionEditor } from "@/components/workspace/ROIAssumptionEditor";
import { requirePageAuth } from "@/lib/auth/session";
import { getCurrentProcessGraph } from "@/lib/processes/graph-queries";
import { getProcessOpportunities } from "@/lib/processes/opportunity-queries";
import { fmtUSD } from "@/lib/roi";
import { getWorkspaceForProcess } from "@/lib/workspaces/current";

export default async function AutomationPage({
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
            Automation Opportunities
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
            Publish a current-state workflow map before ranking automation
            opportunities.
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

  return (
    <main className="mx-auto w-full max-w-[1180px] space-y-5 px-6 py-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Automation
          </div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">
            Ranked automation opportunities
          </h1>
          <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-ink-secondary">
            Scores use deterministic assumptions until finance, volume, and
            exception-rate evidence is attached.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Pill tone={opportunitiesResult.source === "agent" ? "success" : "neutral"}>
            {opportunitiesResult.source}
          </Pill>
          <Pill tone="neutral">
            {opportunities.length} ranked option{opportunities.length === 1 ? "" : "s"}
          </Pill>
        </div>
      </header>

      {opportunities.length === 0 ? (
        <Card className="p-6">
          <p className="text-[13px] leading-relaxed text-ink-secondary">
            No automation candidates were found in this workflow graph.
          </p>
        </Card>
      ) : (
        <>
          <section className="grid gap-3 md:grid-cols-3">
            <ScoreCard label="Top net score" value={fmtUSD(opportunities[0].net_score ?? 0)} />
            <ScoreCard
              label="Grounding"
              value={opportunities[0].evidence_label}
            />
            <ScoreCard
              label="Primary pattern"
              value={opportunities[0].pattern_label}
            />
          </section>

          <section className="space-y-3">
            {opportunities.map((opportunity, index) => (
              <div key={opportunity.id} className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  Rank #{index + 1}
                </div>
                <ROIAssumptionEditor
                  opportunity={opportunity}
                  processId={id}
                  workspaceId={workspace.id}
                  versionId={graph.version_id}
                  opportunitySetKey={opportunitiesResult.opportunitySetKey}
                />
              </div>
            ))}
          </section>
        </>
      )}
    </main>
  );
}

function ScoreCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <div className="mt-1 text-[16px] font-semibold tracking-tight text-ink">
        {value}
      </div>
    </Card>
  );
}
