"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import dynamic from "next/dynamic";
import { TabBar } from "@/components/workspace/TabBar";
import { SummaryTab } from "@/components/workspace/tabs/SummaryTab";
import { StepsTab } from "@/components/workspace/tabs/StepsTab";
import { ImpactTab } from "@/components/workspace/tabs/ImpactTab";
import { InsightsTab } from "@/components/workspace/tabs/InsightsTab";
import { RiskTab } from "@/components/workspace/tabs/RiskTab";
import { RefineProcessChat } from "@/components/workspace/RefineProcessChat";
import { Button } from "@/components/ui/Button";
import type { ProcessGraph } from "@/lib/types";
import type { WorkspaceTab } from "@/lib/store/workspace";

const ProcessCanvas = dynamic(
  () => import("@/components/canvas/ProcessCanvas").then((m) => m.ProcessCanvas),
  { ssr: false, loading: () => <div className="size-full bg-canvas" /> },
);

export default function WorkspaceClient({
  processId,
  graph,
  initialTab,
  counts,
}: {
  processId: string;
  graph: ProcessGraph;
  initialTab: WorkspaceTab;
  counts: Partial<Record<WorkspaceTab, number>>;
}) {
  const sp = useSearchParams();
  const active = (sp.get("tab") as WorkspaceTab) ?? initialTab ?? "summary";

  useEffect(() => {
    // No-op; URL drives state.
  }, []);

  return (
    <div className="grid h-[calc(100vh-130px)] grid-cols-[minmax(0,1fr)_460px]">
      {/* Canvas pane */}
      <div className="relative h-full border-r border-subtle">
        <ProcessCanvas graph={graph} />
      </div>

      {/* Right panel */}
      <div className="relative flex h-full flex-col overflow-hidden bg-surface">
        <header className="flex items-center justify-between border-b border-subtle px-5 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">
              Current Process
            </h2>
          </div>
          <Button variant="ghost" size="sm">
            <RefreshIcon /> Refine
          </Button>
        </header>
        <TabBar counts={counts} />
        <div className="flex-1 overflow-y-auto">
          {active === "summary" && <SummaryTab processId={processId} />}
          {active === "steps" && <StepsTab processId={processId} />}
          {active === "impact" && <ImpactTab processId={processId} />}
          {active === "insights" && <InsightsTab processId={processId} />}
          {active === "risk" && <RiskTab processId={processId} />}
        </div>
      </div>

      <RefineProcessChat />
    </div>
  );
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
