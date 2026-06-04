"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { TabBar } from "@/components/workspace/TabBar";
import { SummaryTab } from "@/components/workspace/tabs/SummaryTab";
import { NodeEvidenceDrawer, StepsTab } from "@/components/workspace/tabs/StepsTab";
import { ImpactTab } from "@/components/workspace/tabs/ImpactTab";
import { InsightsTab } from "@/components/workspace/tabs/InsightsTab";
import { RiskTab } from "@/components/workspace/tabs/RiskTab";
import { RefineProcessChat } from "@/components/workspace/RefineProcessChat";
import { Button } from "@/components/ui/Button";
import type { ProcessGraph } from "@/lib/types";
import type { ProcessFollowUpTask } from "@/lib/processes/follow-up-queries";
import type { ProcessGraphVersionSummary } from "@/lib/processes/graph-queries";
import type { WorkspaceTab } from "@/lib/store/workspace";
import type { ImpactOpportunity } from "@/components/workspace/tabs/ImpactTab";

const ProcessCanvas = dynamic(
  () => import("@/components/canvas/ProcessCanvas").then((m) => m.ProcessCanvas),
  { ssr: false, loading: () => <div className="size-full bg-canvas" /> },
);

export default function WorkspaceClient({
  workspaceId,
  processId,
  graph,
  graphVersions,
  followUps = [],
  impactOpportunities = [],
  opportunitySource,
  initialTab,
  counts,
  canApproveDraft,
}: {
  workspaceId: string;
  processId: string;
  graph: ProcessGraph;
  graphVersions?: ProcessGraphVersionSummary[];
  followUps?: ProcessFollowUpTask[];
  impactOpportunities?: ImpactOpportunity[];
  opportunitySource?: "agent" | "heuristic";
  initialTab: WorkspaceTab;
  counts: Partial<Record<WorkspaceTab, number>>;
  canApproveDraft: boolean;
}) {
  const sp = useSearchParams();
  const active = (sp.get("tab") as WorkspaceTab) ?? initialTab ?? "summary";
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [canvasEvidence, setCanvasEvidence] = useState<{
    stepTitle: string;
    evidenceIds: string[];
  } | null>(null);

  useEffect(() => {
    // No-op; URL drives state.
  }, []);

  return (
    <div className="grid h-[calc(100vh-130px)] grid-cols-[minmax(0,1fr)_460px]">
      {/* Canvas pane */}
      <div className="relative h-full border-r border-subtle">
        <ProcessCanvas
          graph={graph}
          onNodeEvidenceOpen={({ title, evidenceIds }) =>
            setCanvasEvidence({ stepTitle: title, evidenceIds })
          }
        />
      </div>

      {/* Right panel */}
      <div className="relative flex h-full flex-col overflow-hidden bg-surface">
        <header className="flex items-center justify-between border-b border-subtle px-5 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">
              Current Process
            </h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-muted">
              {graph.status}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {graphVersions && graphVersions.length > 1 && (
              <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                Version
                <select
                  className="h-8 rounded-md border border-subtle bg-surface px-2 text-[12px] text-ink outline-none focus:border-ink-muted"
                  value={graph.version_id ?? ""}
                  onChange={(event) => {
                    const versionId = event.target.value;
                    const tab = active ? `&tab=${active}` : "";
                    window.location.href = `/process/${processId}/workspace?version=${versionId}${tab}`;
                  }}
                >
                  {graphVersions.map((version) => (
                    <option key={version.version_id} value={version.version_id}>
                      v{version.version_number} {version.status}
                      {version.is_current_draft
                        ? " current draft"
                        : version.is_current_approved
                          ? " approved"
                          : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {approvalError && (
              <span className="max-w-[180px] text-right text-[11px] text-danger">
                {approvalError}
              </span>
            )}
            {canApproveDraft && graph.status === "draft" && graph.version_id && (
              <Button
                type="button"
                size="sm"
                onClick={async () => {
                  setApproving(true);
                  setApprovalError(null);
                  try {
                    await approveDraft({
                      workspaceId,
                      processId,
                      versionId: graph.version_id as string,
                    });
                    window.location.reload();
                  } catch (error) {
                    setApprovalError(
                      error instanceof Error
                        ? error.message
                        : "Could not approve draft.",
                    );
                  } finally {
                    setApproving(false);
                  }
                }}
                disabled={approving}
              >
                {approving ? "Approving" : "Approve Draft"}
              </Button>
            )}
            <Button variant="ghost" size="sm">
              <RefreshIcon /> Refine
            </Button>
          </div>
        </header>
        <TabBar counts={counts} />
        <div className="flex-1 overflow-y-auto">
          {active === "summary" && (
            <SummaryTab processId={processId} graph={graph} followUps={followUps} />
          )}
          {active === "steps" && (
            <StepsTab workspaceId={workspaceId} processId={processId} graph={graph} />
          )}
          {active === "impact" && (
            <ImpactTab
              processId={processId}
              opportunities={impactOpportunities}
              source={opportunitySource}
            />
          )}
          {active === "insights" && (
            <InsightsTab
              processId={processId}
              graph={graph}
              followUps={followUps}
            />
          )}
          {active === "risk" && (
            <RiskTab processId={processId} followUps={followUps} />
          )}
        </div>
      </div>

      <NodeEvidenceDrawer
        open={Boolean(canvasEvidence)}
        workspaceId={workspaceId}
        processId={processId}
        versionId={graph.version_id}
        stepTitle={canvasEvidence?.stepTitle}
        evidenceIds={canvasEvidence?.evidenceIds ?? []}
        onClose={() => setCanvasEvidence(null)}
      />
      <RefineProcessChat />
    </div>
  );
}

async function approveDraft({
  workspaceId,
  processId,
  versionId,
}: {
  workspaceId: string;
  processId: string;
  versionId: string;
}) {
  const response = await fetch(
    `/api/processes/${processId}/versions/${versionId}/approve`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `approve-process-version-${versionId}`,
      },
      body: JSON.stringify({ workspace_id: workspaceId }),
    },
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ?? `Approval failed (${response.status})`,
    );
  }
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M3 7a5 5 0 019-3l1 1M13 9a5 5 0 01-9 3l-1-1M13 2v3h-3M3 14v-3h3"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
