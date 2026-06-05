import { notFound } from "next/navigation";
import Link from "next/link";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { ComplexityBreakdown } from "@/components/process/ComplexityBreakdown";
import { SystemPills } from "@/components/process/SystemPills";
import { RiskCallouts } from "@/components/process/RiskCallouts";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { BRAND } from "@/lib/brand";
import { requirePageAuth } from "@/lib/auth/session";
import { getWorkspaceForProcess } from "@/lib/workspaces/current";
import { getDirectorProcessDetail, getProcessEvidence } from "@/lib/processes/queries";
import { EvidenceLink } from "@/components/common/EvidenceLink";
import { EvidenceDrawer } from "@/components/workspace/EvidenceDrawer";

export default async function ProcessDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const auth = await requirePageAuth();
  const workspace = await getWorkspaceForProcess(auth, id);
  if (!workspace) notFound();
  const [process, evidence] = await Promise.all([
    getDirectorProcessDetail(auth.orgId, workspace.id, id),
    getProcessEvidence(auth.orgId, workspace.id, id),
  ]);
  if (!process) notFound();
  const overviewHref = `/overview?workspace_id=${encodeURIComponent(workspace.id)}`;

  return (
    <div className="flex min-h-screen flex-col">
      <BreadcrumbHeader
        back={{ href: overviewHref, label: "High Level Overview" }}
        crumbs={[
          { label: process.function, href: overviewHref },
          { label: process.name },
        ]}
        right={
          <Link href={`/process/${id}/workspace`}>
            <Button size="sm" variant="secondary">
              Continue in {BRAND.name} →
            </Button>
          </Link>
        }
      />

      <main className="mx-auto w-full max-w-[1080px] flex-1 px-8 py-8">
        <header className="mb-8">
          <h1 className="text-[28px] font-semibold tracking-tight text-ink">
            {process.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Pill tone={process.complexity}>
              {process.complexity === "high"
                ? "High complexity"
                : process.complexity === "med"
                  ? "Medium complexity"
                  : "Low complexity"}
            </Pill>
            <Pill tone="neutral">{process.function}</Pill>
          <Pill tone="neutral">{process.frequency}</Pill>
        </div>
        {process.summary_paragraph && (
          <p className="mt-4 max-w-[780px] text-[13px] leading-relaxed text-ink-secondary">
            {process.summary_paragraph}
          </p>
        )}
      </header>

        <section className="space-y-3">
          <h2 className="text-[14px] font-semibold tracking-tight text-ink">
            What this process involves
          </h2>
          <p className="text-[13px] leading-relaxed text-ink-secondary">
            {process.what_it_involves}
          </p>
        </section>

        <div className="my-8">
          <ComplexityBreakdown detail={process} />
        </div>

        <div className="my-8">
          <SystemPills detail={process} />
        </div>

        <div className="my-8">
          <RiskCallouts detail={process} />
        </div>

        <section className="my-8 space-y-3">
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">
            Evidence links
          </h3>
          {evidence.claims.length === 0 ? (
            <div className="rounded-md border border-dashed border-subtle p-4 text-[12.5px] text-ink-muted">
              No active process claims have linked evidence yet.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {evidence.claims.map((claim) => (
                <div
                  key={claim.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-subtle bg-surface px-3.5 py-3"
                >
                  <div>
                    <div className="text-[12.5px] font-medium text-ink">
                      {claim.field.replace(/_/g, " ")}
                    </div>
                    <div className="text-[11px] text-ink-muted">
                      {claim.evidence_ids.length} evidence source{claim.evidence_ids.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <EvidenceLink claimId={claim.id} count={claim.evidence_ids.length} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="my-10 flex flex-col items-start gap-3 rounded-lg border border-subtle bg-surface p-5">
          <div>
            <h3 className="text-[14px] font-semibold tracking-tight text-ink">
              Ready to go deeper?
            </h3>
            <p className="mt-1 text-[12.5px] text-ink-secondary">
              Add an operator capture to extract the L4 process map — every
              step, handoff, and exception backed by evidence.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href={`/process/${id}/capture`}>
              <Button>+ Add Capture</Button>
            </Link>
            <Link href={`/process/${id}/workspace`}>
              <Button variant="secondary">View existing map</Button>
            </Link>
          </div>
        </section>
      </main>
      <EvidenceDrawer
        claims={evidence.claims}
        evidenceById={evidence.evidenceById}
        workspaceId={workspace.id}
      />
    </div>
  );
}
