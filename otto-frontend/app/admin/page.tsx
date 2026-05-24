import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { requirePageAuth } from "@/lib/auth/session";
import { getCurrentWorkspace } from "@/lib/workspaces/current";
import { getDirectorCoverage } from "@/lib/admin/coverage-queries";
import { getVariantReviewQueue } from "@/lib/admin/variant-queries";

export default async function AdminLanding() {
  const auth = await requirePageAuth();
  const workspace = await getCurrentWorkspace(auth);
  const [coverage, variants] = workspace
    ? await Promise.all([
        getDirectorCoverage(auth.orgId, workspace.id),
        getVariantReviewQueue(auth.orgId, workspace.id),
      ])
    : [null, []];
  const lowCoverageRows =
    coverage?.slots.filter((slot) =>
      ["empty", "partial", "conflicting", "pending_re_extract"].includes(slot.status),
    ) ?? [];
  const openFollowUps =
    coverage?.slots.reduce((sum, slot) => sum + slot.openFollowUps, 0) ?? 0;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">
          FDE Admin
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-secondary">
          Cross-process coverage, variant queue, evidence inventory, hypothesis
          seeding, and export controls.
        </p>
      </header>

      <section className="grid grid-cols-3 gap-3">
        <Card className="p-5">
          <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
            Open follow-ups
          </div>
          <div className="mt-1 text-[24px] font-semibold tabular-nums text-ink">
            {openFollowUps}
          </div>
          <div className="mt-1 text-[11.5px] text-ink-muted">
            unanswered slots across all interviews
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
            Variant review backlog
          </div>
          <div className="mt-1 text-[24px] font-semibold tabular-nums text-ink">
            {variants.length}
          </div>
          <div className="mt-1 text-[11.5px] text-ink-muted">
            pending candidate processes awaiting decision
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
            Low-coverage slots
          </div>
          <div className="mt-1 text-[24px] font-semibold tabular-nums text-ink">
            {lowCoverageRows.length}
          </div>
          <div className="mt-1 text-[11.5px] text-ink-muted">
            missing, partial, conflicting, or pending re-extract
          </div>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-[14px] font-semibold tracking-tight text-ink">
          Suggested actions
        </h2>
        <div className="space-y-2">
          {lowCoverageRows.slice(0, 5).map((r) => (
            <div
              key={r.slotPath}
              className="flex items-center justify-between rounded-md border border-subtle bg-surface px-4 py-3 text-[12.5px]"
            >
              <div>
                <div className="font-medium text-ink">
                  Schedule follow-up for &ldquo;{r.label}&rdquo;
                </div>
                <div className="mt-0.5 text-ink-muted">
                  Status {r.status.replace(/_/g, " ")}, {r.openFollowUps} open follow-ups.
                </div>
              </div>
              <Pill tone="warn">low coverage</Pill>
            </div>
          ))}
          {variants.slice(0, 1).map((v) => (
            <div
              key={v.id}
              className="flex items-center justify-between rounded-md border border-subtle bg-surface px-4 py-3 text-[12.5px]"
            >
              <div>
                <div className="font-medium text-ink">
                  Review candidate process &ldquo;{v.proposed_name}&rdquo;
                </div>
                <div className="mt-0.5 text-ink-muted">
                  Confidence {(Number(v.confidence ?? 0) * 100).toFixed(0)}% · {v.evidence_count} evidence links
                </div>
              </div>
              <Link
                href="/admin/variants"
                className="text-[12px] font-medium text-ink underline-offset-2 hover:underline"
              >
                Review →
              </Link>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
