import { CoverageScorecard } from "@/components/admin/CoverageScorecard";
import { requirePageAuth } from "@/lib/auth/session";
import { getDirectorCoverage } from "@/lib/admin/coverage-queries";
import { getCurrentWorkspace } from "@/lib/workspaces/current";

export default async function CoveragePage() {
  const auth = await requirePageAuth();
  const workspace = await getCurrentWorkspace(auth);
  const coverage = workspace
    ? await getDirectorCoverage(auth.orgId, workspace.id)
    : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          Coverage scorecard
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-secondary">
          Per-slot coverage matrix surfaced to the FDE running discovery (not
          the interviewee). Drives the decision to keep probing, schedule
          another operator, or accept the map.
        </p>
      </header>
      {coverage ? (
        <CoverageScorecard coverage={coverage} />
      ) : (
        <div className="rounded-lg border border-subtle bg-surface p-5 text-[13px] text-ink-secondary">
          Create or enter a workspace to populate director coverage.
        </div>
      )}
    </div>
  );
}
