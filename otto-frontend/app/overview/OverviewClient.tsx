"use client";

import { useState } from "react";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { MetricTile } from "@/components/overview/MetricTile";
import { ProcessCard } from "@/components/overview/ProcessCard";
import { DrilldownBanner } from "@/components/overview/DrilldownBanner";
import {
  OverviewTabStrip,
  type OverviewTab,
} from "@/components/overview/OverviewTabStrip";
import { TeamResponsibilities } from "@/components/overview/TeamResponsibilities";
import type { ProcessSummary } from "@/lib/types";
import type { OverviewMetrics } from "@/lib/overview/queries";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

export function OverviewClient({
  processes,
  metrics,
  workspaceId,
  workspaceName = "Acme Co.",
  functionName = "Commercial Department",
}: {
  processes: ProcessSummary[];
  metrics?: OverviewMetrics;
  workspaceId: string;
  workspaceName?: string;
  functionName?: string;
}) {
  const [tab, setTab] = useState<OverviewTab>("overview");

  const avgComplexity = metrics?.averageComplexity ?? average(processes.map((p) => p.complexity_score));
  const docCoverage =
    metrics?.documentationCoverage ??
    Math.round(average(processes.map((p) => p.doc_coverage)) * 100);
  const spofCount = metrics?.spofCount ?? 0;

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

            <DrilldownBanner />

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

            {metrics?.hasProcessingCaptures && (
              <section className="rounded-md border border-subtle bg-muted px-4 py-3 text-[12.5px] text-ink-secondary">
                Intake is still processing. Published cards will keep appearing here as synthesis completes.
              </section>
            )}

            {metrics?.hasPartialSynthesis && (
              <section className="rounded-md border border-[#F0DCAA] bg-[#FFF9EB] px-4 py-3 text-[12.5px] text-ink-secondary">
                Some synthesis runs are partial or failed. The visible cards are usable, and an FDE can retry the failed stages.
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
            <TeamResponsibilities />
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
