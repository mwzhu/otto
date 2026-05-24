import { OverviewClient } from "./OverviewClient";
import { requirePageAuth } from "@/lib/auth/session";
import { getCurrentWorkspace } from "@/lib/workspaces/current";
import { getOverviewMetrics, getProcessCards } from "@/lib/overview/queries";

export default async function OverviewPage() {
  const auth = await requirePageAuth();
  const workspace = await getCurrentWorkspace(auth);
  if (!workspace) {
    return <OverviewClient processes={[]} workspaceId="" />;
  }
  const [metrics, processes] = await Promise.all([
    getOverviewMetrics(auth.orgId, workspace.id),
    getProcessCards(auth.orgId, workspace.id),
  ]);

  return (
    <OverviewClient
      processes={processes}
      metrics={metrics}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      functionName={workspace.functionName}
    />
  );
}
