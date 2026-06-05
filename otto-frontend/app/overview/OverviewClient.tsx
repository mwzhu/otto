"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { MetricTile } from "@/components/overview/MetricTile";
import { ProcessCard } from "@/components/overview/ProcessCard";
import {
  OverviewTabStrip,
  type OverviewTab,
} from "@/components/overview/OverviewTabStrip";
import { AutomationTab } from "@/components/overview/AutomationTab";
import type { ProcessSummary } from "@/lib/types";
import type { OverviewMetrics } from "@/lib/overview/queries";
import type { DepartmentAutomationPlan } from "@/lib/overview/automation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

export function OverviewClient({
  processes,
  metrics,
  automationPlan,
  workspaceId,
  workspaceName = "Acme Co.",
  functionName = "Commercial Department",
  captureSessionId,
  initialTab = "overview",
}: {
  processes: ProcessSummary[];
  metrics?: OverviewMetrics;
  automationPlan?: DepartmentAutomationPlan;
  workspaceId: string;
  workspaceName?: string;
  functionName?: string;
  captureSessionId?: string | null;
  initialTab?: OverviewTab;
}) {
  const [tab, setTab] = useState<OverviewTab>(initialTab);
  const router = useRouter();

  const avgComplexity = metrics?.averageComplexity ?? average(processes.map((p) => p.complexity_score));
  const docCoverage =
    metrics?.documentationCoverage ??
    Math.round(average(processes.map((p) => p.doc_coverage)) * 100);
  const spofCount = metrics?.spofCount ?? 0;

  useEffect(() => {
    const shouldPoll =
      tab === "automation" &&
      Boolean(workspaceId) &&
      (automationPlan?.planState === "pending" ||
        automationPlan?.planState === "running" ||
        automationPlan?.refreshState === "pending" ||
        automationPlan?.refreshState === "running");
    if (!shouldPoll) return;
    let cancelled = false;
    const poll = async () => {
      const params = new URLSearchParams({ workspace_id: workspaceId });
      if (captureSessionId) params.set("capture_session_id", captureSessionId);
      const response = await fetch(`/api/automation-plan/status?${params}`, {
        cache: "no-store",
      });
      if (!response.ok || cancelled) return;
      const status = (await response.json()) as {
        run_state: "none" | "pending" | "running" | "completed" | "failed";
        has_completed_plan: boolean;
      };
      const terminal =
        status.run_state === "completed" || status.run_state === "failed";
      if (terminal) router.refresh();
    };
    const interval = window.setInterval(poll, 3000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [automationPlan, captureSessionId, router, tab, workspaceId]);

  return (
    <div className="flex min-h-screen flex-col">
      <BreadcrumbHeader
        crumbs={[
          { label: workspaceName, href: "/overview" },
          { label: "High Level Overview" },
        ]}
      />
      <main className="mx-auto w-full max-w-[1320px] flex-1 px-8 py-8">
        <header className="mb-6 flex items-end justify-between gap-6">
          <div>
            <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
              {functionName}
            </div>
            <h1 className="mt-1 text-[26px] font-semibold tracking-tight text-ink">
              High Level Overview
            </h1>
          </div>
        </header>

        <OverviewTabStrip active={tab} onChange={setTab} />

        {tab === "overview" ? (
          <div className="space-y-6 pt-6">
            <section className="grid grid-cols-4 gap-3">
              <MetricTile label="Processes Captured" value={metrics?.processCount ?? processes.length} suffix="" hint="Promoted drafts plus pending candidates" />
              <MetricTile
                label="Documentation Coverage"
                value={`${docCoverage}%`}
                hint="Average across all captured processes"
              />
              <MetricTile
                label="Complexity Score"
                value={avgComplexity}
                suffix="/100"
                hint="Weighted by vulnerabilities, sprawl, dependencies"
                highlight
              />
              <MetricTile
                label="Single Points of Failure"
                value={spofCount}
                hint="Roles with no documented backup"
                highlight
              />
            </section>

            {processes.length === 0 && (
              <section className="rounded-lg border border-dashed border-subtle bg-surface p-8 text-center">
                <h2 className="text-[16px] font-semibold tracking-tight text-ink">
                  No inventory published yet
                </h2>
                <p className="mx-auto mt-2 max-w-[520px] text-[13px] leading-relaxed text-ink-secondary">
                  Start a director interview or upload a document to create evidence-backed process cards.
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  <Link href="/onboarding/voice">
                    <Button>Start voice intake</Button>
                  </Link>
                  <Link href="/onboarding/upload">
                    <Button variant="secondary">Upload documents</Button>
                  </Link>
                </div>
              </section>
            )}

            <section className="grid grid-cols-3 gap-3">
              {processes.map((p) => (
                <ProcessCard key={`${p.source ?? "process"}:${p.id}`} p={p} workspaceId={workspaceId} />
              ))}
            </section>
          </div>
        ) : (
          <div className="pt-6">
            <AutomationTab
              workspaceId={workspaceId}
              captureSessionId={captureSessionId}
              plan={
                automationPlan ?? {
                  departmentName: functionName,
                  processCount: processes.length,
                  processGraphCount: 0,
                  opportunityCount: 0,
                  source: "none",
                  planState: "none",
                  refreshState: null,
                  updatedAt: null,
                  topOpportunities: [],
                  metrics: {
                    annualNetValue: 0,
                    annualGrossValue: 0,
                    annualHoursSaved: 0,
                    annualTimeValue: 0,
                    annualErrorValue: 0,
                    annualDelayValue: 0,
                    averageConfidence: 0,
                  },
                  audit: {
                    problem:
                      "No automation-ready process maps have been published for this department yet.",
                    patterns: [],
                  },
                }
              }
            />
          </div>
        )}
      </main>
    </div>
  );
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
