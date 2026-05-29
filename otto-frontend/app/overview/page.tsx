import { OverviewClient } from "./OverviewClient";
import { requirePageAuth } from "@/lib/auth/session";
import {
  getWorkspaceForCaptureSession,
  getWorkspaceForUser,
} from "@/lib/workspaces/current";
import { getOverviewMetrics, getProcessCards } from "@/lib/overview/queries";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams?: Promise<{
    capture_session_id?: string | string[];
    workspace_id?: string | string[];
  }>;
}) {
  const auth = await requirePageAuth();
  const params = await searchParams;
  const requestedWorkspaceId = singleParam(params?.workspace_id);
  const captureSessionId = singleParam(params?.capture_session_id);
  const workspace = requestedWorkspaceId
    ? await getWorkspaceForUser(auth, requestedWorkspaceId)
    : (await getWorkspaceForCaptureSession(auth, captureSessionId)) ??
      (await getWorkspaceForUser(auth, null));
  if (!workspace) {
    return <OverviewClient processes={[]} workspaceId="" />;
  }
  const [metrics, processes] = await Promise.all([
    getOverviewMetrics(auth.orgId, workspace.id, { captureSessionId }),
    getProcessCards(auth.orgId, workspace.id, { captureSessionId }),
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

function singleParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
