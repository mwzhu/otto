import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { requirePageAuth } from "@/lib/auth/session";
import { getCurrentWorkspace } from "@/lib/workspaces/current";
import { getDirectorProcessDetail } from "@/lib/processes/queries";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const auth = await requirePageAuth();
  const workspace = await getCurrentWorkspace(auth);
  if (!workspace) notFound();
  const process = await getDirectorProcessDetail(auth.orgId, workspace.id, id);
  if (!process) notFound();

  return (
    <main className="mx-auto grid w-full max-w-[1180px] grid-cols-[minmax(0,1fr)_360px] gap-6 px-8 py-8">
      <section className="space-y-4">
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap gap-1.5">
            <Pill tone={process.complexity}>{process.complexity} complexity</Pill>
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
              <div key={`${item.role}-${item.person ?? ""}`} className="text-[12.5px]">
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
