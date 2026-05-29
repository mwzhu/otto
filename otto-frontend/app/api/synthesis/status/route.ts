import { and, desc, eq, sql } from "drizzle-orm";
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
    const searchParams = new URL(request.url).searchParams;
    const requestedWorkspaceId = searchParams.get("workspace_id");
    const captureSessionId = searchParams.get("capture_session_id");
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

    const [latestRun, metrics, captureInventoryCount] = await Promise.all([
      latestSynthesisRun(auth.orgId, workspace.id, captureSessionId),
      getOverviewMetrics(auth.orgId, workspace.id),
      captureSessionId
        ? getCaptureInventoryCount(auth.orgId, workspace.id, captureSessionId)
        : Promise.resolve(null),
    ]);
    const terminal =
      latestRun?.status === "completed" || latestRun?.status === "failed";
    const readyForOverview =
      latestRun?.status === "completed" &&
      (captureInventoryCount === null ? metrics.processCount > 0 : captureInventoryCount > 0);

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
        capture_process_count: captureInventoryCount,
        has_partial_synthesis: metrics.hasPartialSynthesis,
      },
      ready_for_overview: readyForOverview,
      terminal,
    });
  } catch (error) {
    return apiError(error);
  }
}

async function latestSynthesisRun(
  orgId: string,
  workspaceId: string,
  captureSessionId: string | null,
) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx
      .select()
      .from(synthesisRuns)
      .where(
        and(
          eq(synthesisRuns.orgId, orgId),
          eq(synthesisRuns.workspaceId, workspaceId),
          captureSessionId
            ? sql`${synthesisRuns.captureSessionIds} @> ARRAY[${captureSessionId}]::uuid[]`
            : undefined,
        ),
      )
      .orderBy(desc(synthesisRuns.updatedAt), desc(synthesisRuns.createdAt))
      .limit(1);
  });
  return rows[0] ?? null;
}

async function getCaptureInventoryCount(
  orgId: string,
  workspaceId: string,
  captureSessionId: string,
) {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
      FROM candidate_processes
      WHERE org_id = ${orgId}
        AND workspace_id = ${workspaceId}
        AND capture_session_id = ${captureSessionId}
        AND status = 'pending'
        AND lower(proposed_name) NOT IN (
          'a couple different things',
          'couple different things',
          'different things',
          'a few things',
          'several things',
          'some things',
          'multiple things',
          'things'
        )
    `);
  });
  return Number(result.rows[0]?.count ?? 0);
}
