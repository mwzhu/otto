import { OverviewClient } from "./OverviewClient";
import { requirePageAuth } from "@/lib/auth/session";
import {
  getWorkspaceForCaptureSession,
  getWorkspaceForUser,
} from "@/lib/workspaces/current";
import { getOverviewMetrics, getProcessCards } from "@/lib/overview/queries";
import { getDepartmentAutomationPlan } from "@/lib/overview/automation";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams?: Promise<{
    capture_session_id?: string | string[];
    workspace_id?: string | string[];
    tab?: string | string[];
  }>;
}) {
  const auth = await requirePageAuth();
  const params = await searchParams;
  const requestedWorkspaceId = singleParam(params?.workspace_id);
  const captureSessionId = singleParam(params?.capture_session_id);
  const initialTab = singleParam(params?.tab);
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
  const automationPlan = await getDepartmentAutomationPlan({
    orgId: auth.orgId,
    workspaceId: workspace.id,
    departmentName: workspace.functionName,
    processes,
    captureSessionId,
  });

  return (
    <OverviewClient
      processes={processes}
      metrics={metrics}
      automationPlan={automationPlan}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      functionName={workspace.functionName}
      captureSessionId={captureSessionId}
      initialTab={initialTab === "automation" ? "automation" : "overview"}
    />
  );
}

function singleParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
