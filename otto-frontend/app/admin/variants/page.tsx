import { VariantQueue } from "@/components/admin/VariantQueue";
import { requirePageAuth } from "@/lib/auth/session";
import { getCurrentWorkspace } from "@/lib/workspaces/current";
import {
  getProcessMergeTargets,
  getVariantReviewQueue,
} from "@/lib/admin/variant-queries";

export default async function VariantsPage() {
  const auth = await requirePageAuth();
  const workspace = await getCurrentWorkspace(auth);
  const [rows, mergeTargets] = workspace
    ? await Promise.all([
        getVariantReviewQueue(auth.orgId, workspace.id),
        getProcessMergeTargets(auth.orgId, workspace.id),
      ])
    : [[], []];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          Variant review queue
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-secondary">
          Weak alignment matches (score 0.60–0.85) and significant diffs that
          need an explicit FDE decision before merging.
        </p>
      </header>
      <VariantQueue
        rows={rows}
        workspaceId={workspace?.id ?? ""}
        mergeTargets={mergeTargets}
      />
    </div>
  );
}
