import { and, desc, eq } from "drizzle-orm";
import { ensureWorkspaceRole, requireAuth } from "@/lib/auth/session";
import { getDb, setOrgContext } from "@/lib/db/client";
import { synthesisRuns } from "@/lib/db/schema";
import { apiError, apiJson } from "@/lib/http/json";
import { getOverviewMetrics } from "@/lib/overview/queries";
import { getCurrentWorkspace } from "@/lib/workspaces/current";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await requireAuth(request);
    const requestedWorkspaceId = new URL(request.url).searchParams.get("workspace_id");
    if (requestedWorkspaceId) {
      await ensureWorkspaceRole(auth, requestedWorkspaceId);
    }
    const workspace =
      requestedWorkspaceId
        ? { id: requestedWorkspaceId }
        : await getCurrentWorkspace(auth);
    if (!workspace) {
      return apiJson({
        workspace_id: null,
        latest_run: null,
        overview: { process_count: 0 },
        ready_for_overview: false,
        terminal: false,
      });
    }

    const [latestRun, metrics] = await Promise.all([
      latestSynthesisRun(auth.orgId, workspace.id),
      getOverviewMetrics(auth.orgId, workspace.id),
    ]);
    const terminal =
      latestRun?.status === "completed" ||
      latestRun?.status === "partial_synthesis" ||
      latestRun?.status === "failed";
    const readyForOverview =
      metrics.processCount > 0 &&
      (latestRun?.status === "completed" ||
        latestRun?.status === "partial_synthesis");

    return apiJson({
      workspace_id: workspace.id,
      latest_run: latestRun
        ? {
            id: latestRun.id,
            run_type: latestRun.runType,
            status: latestRun.status,
            stage: latestRun.stage,
            updated_at: latestRun.updatedAt.toISOString(),
          }
        : null,
      overview: {
        process_count: metrics.processCount,
        has_partial_synthesis: metrics.hasPartialSynthesis,
      },
      ready_for_overview: readyForOverview,
      terminal,
    });
  } catch (error) {
    return apiError(error);
  }
}

async function latestSynthesisRun(orgId: string, workspaceId: string) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx
      .select()
      .from(synthesisRuns)
      .where(
        and(
          eq(synthesisRuns.orgId, orgId),
          eq(synthesisRuns.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(synthesisRuns.updatedAt), desc(synthesisRuns.createdAt))
      .limit(1);
  });
  return rows[0] ?? null;
}
