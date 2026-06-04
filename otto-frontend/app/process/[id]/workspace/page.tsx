import { notFound } from "next/navigation";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { hasWorkspaceRole, requirePageAuth } from "@/lib/auth/session";
import { getWorkspaceForProcess } from "@/lib/workspaces/current";
import { getDirectorProcessDetail } from "@/lib/processes/queries";
import {
  getCurrentProcessGraph,
  getLatestWorkflowSemanticModelStatus,
  getProcessGraphVersion,
  getProcessGraphVersions,
} from "@/lib/processes/graph-queries";
import { getProcessFollowUps } from "@/lib/processes/follow-up-queries";
import { getProcessOpportunities } from "@/lib/processes/opportunity-queries";
import WorkspaceClient from "./WorkspaceClient";
import type { WorkspaceTab } from "@/lib/store/workspace";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; version?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const auth = await requirePageAuth();
  const workspace = await getWorkspaceForProcess(auth, id);
  if (!workspace) notFound();
  const canApproveDraft = await hasWorkspaceRole(auth, workspace.id, [
    "director",
  ]);
  const selectedVersionId = query.version;
  const [process, graph, graphVersions, followUps, semanticStatus] =
    await Promise.all([
      getDirectorProcessDetail(auth.orgId, workspace.id, id),
      selectedVersionId
        ? getProcessGraphVersion(
            auth.orgId,
            workspace.id,
            id,
            selectedVersionId,
          )
        : getCurrentProcessGraph(auth.orgId, workspace.id, id),
      getProcessGraphVersions(auth.orgId, workspace.id, id),
      getProcessFollowUps(auth.orgId, workspace.id, id),
      getLatestWorkflowSemanticModelStatus(auth.orgId, workspace.id, id),
    ]);
  if (!process) notFound();
  const semanticFollowUps = followUps.filter(isSemanticWorkflowFollowUp);
  if (graph) {
    const opportunitiesResult = await getProcessOpportunities({
      orgId: auth.orgId,
      workspaceId: workspace.id,
      processId: id,
      graph,
    });
    const counts: Partial<Record<WorkspaceTab, number>> = {
      steps: graph.nodes.filter((node) => node.type === "task").length,
      impact: opportunitiesResult.opportunities.length,
      insights: graph.summary ? 1 : graph.nodes.length > 0 ? 6 : 0,
      risk:
        graph.nodes.filter((node) => node.type === "exception").length +
        followUps.filter(isRiskFollowUp).length,
    };
    return (
      <WorkspaceClient
        workspaceId={workspace.id}
        processId={id}
        graph={graph}
        graphVersions={graphVersions}
        followUps={followUps}
        impactOpportunities={opportunitiesResult.opportunities}
        opportunitySource={opportunitiesResult.source}
        initialTab="summary"
        counts={counts}
        canApproveDraft={canApproveDraft}
      />
    );
  }

  return (
    <main className="mx-auto grid w-full max-w-[1180px] grid-cols-[minmax(0,1fr)_360px] gap-6 px-8 py-8">
      <section className="space-y-4">
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap gap-1.5">
            <Pill tone={process.complexity}>
              {process.complexity} complexity
            </Pill>
            <Pill tone="neutral">{process.frequency}</Pill>
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">
            {process.name}
          </h1>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
            {process.what_it_involves}
          </p>
        </Card>
        <Card className="p-5">
          <h2 className="text-[14px] font-semibold tracking-tight text-ink">
            Build the workflow map
          </h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
            Add operator evidence to turn this process into a versioned workflow
            diagram with steps, systems, exceptions, workarounds, and evidence.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href={`/process/${id}/capture/voice`}>
              <Button size="sm">Start Voice Interview</Button>
            </Link>
            <Link href={`/process/${id}/capture/screenshare`}>
              <Button size="sm" variant="secondary">
                Share Screen
              </Button>
            </Link>
            <Link href={`/process/${id}/capture/upload-video`}>
              <Button size="sm" variant="ghost">
                Upload Video
              </Button>
            </Link>
            <Link href={`/process/${id}/capture/upload-document`}>
              <Button size="sm" variant="ghost">
                Upload SOP
              </Button>
            </Link>
          </div>
        </Card>
        {semanticStatus && semanticStatus.diagnostics.length > 0 && (
          <Card className="p-5">
            <h2 className="text-[14px] font-semibold tracking-tight text-ink">
              Workflow extraction
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
              Latest semantic extraction used {semanticStatus.model} and ended
              with {semanticStatus.diagnostics.length} diagnostic
              {semanticStatus.diagnostics.length === 1 ? "" : "s"}.
            </p>
            <div className="mt-3 space-y-2">
              {semanticStatus.diagnostics.slice(0, 4).map((diagnostic) => (
                <div
                  key={`${diagnostic.code}-${diagnostic.message}`}
                  className="rounded-md border border-[#F0DCAA] bg-[#FFF9EB] px-3 py-2 text-[12px] leading-relaxed text-ink-secondary"
                >
                  <span className="font-medium text-ink">
                    {diagnostic.code.replaceAll("_", " ")}:
                  </span>{" "}
                  {diagnostic.message}
                </div>
              ))}
            </div>
          </Card>
        )}
        {semanticFollowUps.length > 0 && (
          <Card className="p-5">
            <h2 className="text-[14px] font-semibold tracking-tight text-ink">
              Workflow map blocked
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
              The latest capture could not publish a business workflow map yet.
              Resolve these extraction items and rerun synthesis.
            </p>
            <div className="mt-3 space-y-2">
              {semanticFollowUps.slice(0, 4).map((task) => (
                <div
                  key={task.id}
                  className="rounded-md border border-[#F0DCAA] bg-[#FFF9EB] px-3 py-2 text-[12px] leading-relaxed text-ink-secondary"
                >
                  <span className="font-medium text-ink">{task.title}</span>
                  {task.description ? (
                    <p className="mt-1">{task.description}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </Card>
        )}
        <Card className="p-5">
          <h2 className="text-[14px] font-semibold tracking-tight text-ink">
            Systems
          </h2>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {process.systems_detail.map((system) => (
              <Pill key={system.name} tone="system">
                {system.name}
              </Pill>
            ))}
            {process.systems_detail.length === 0 && (
              <span className="text-[12.5px] text-ink-muted">
                No systems linked yet.
              </span>
            )}
          </div>
        </Card>
      </section>
      <aside className="space-y-4">
        <Card className="p-5">
          <h2 className="text-[14px] font-semibold tracking-tight text-ink">
            Evidence
          </h2>
          <div className="mt-2 text-[28px] font-semibold tabular-nums text-ink">
            {process.evidence_count ?? 0}
          </div>
          <p className="mt-1 text-[12px] text-ink-muted">
            linked evidence sources
          </p>
        </Card>
        <Card className="p-5">
          <h2 className="text-[14px] font-semibold tracking-tight text-ink">
            Accountability
          </h2>
          <div className="mt-3 space-y-2">
            {process.accountability.map((item) => (
              <div
                key={`${item.role}-${item.person ?? ""}`}
                className="text-[12.5px]"
              >
                <div className="font-medium text-ink">{item.role}</div>
                <div className="text-ink-muted">{item.description}</div>
              </div>
            ))}
            {process.accountability.length === 0 && (
              <span className="text-[12.5px] text-ink-muted">
                No roles linked yet.
              </span>
            )}
          </div>
        </Card>
      </aside>
    </main>
  );
}

function isRiskFollowUp(
  followUp: Awaited<ReturnType<typeof getProcessFollowUps>>[number],
) {
  const reason = followUp.context_json.reason;
  return (
    followUp.task_type === "redaction_failure" ||
    followUp.task_type === "failed_stage" ||
    followUp.task_type === "weak_merge" ||
    (typeof reason === "string" &&
      /contradiction|gap|low_confidence|redaction/i.test(reason))
  );
}

function isSemanticWorkflowFollowUp(
  followUp: Awaited<ReturnType<typeof getProcessFollowUps>>[number],
) {
  return (
    followUp.target_type === "synthesis_run" &&
    followUp.context_json.reason === "semantic_workflow_not_publishable"
  );
}
