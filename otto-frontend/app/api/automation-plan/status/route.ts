import { and, desc, eq, isNotNull } from "drizzle-orm";
import { ensureWorkspaceRole, requireAuth } from "@/lib/auth/session";
import { getDb, setOrgContext } from "@/lib/db/client";
import { captureSessions } from "@/lib/db/schema";
import {
  directorAutomationPlanRequestedEventName,
  inngest,
} from "@/lib/inngest/client";
import { getServerEnv } from "@/lib/env";
import { ApiError, apiError, apiJson } from "@/lib/http/json";
import { getDirectorAutomationPlanStatus } from "@/lib/synthesis/director-automation";
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
    const workspace = requestedWorkspaceId
      ? { id: requestedWorkspaceId }
      : await getCurrentWorkspace(auth);
    if (!workspace) {
      return apiJson({
        workspace_id: null,
        run_state: "none",
        has_completed_plan: false,
        updated_at: null,
      });
    }

    const status = await getDirectorAutomationPlanStatus({
      orgId: auth.orgId,
      workspaceId: workspace.id,
      captureSessionId,
    });
    return apiJson({
      workspace_id: workspace.id,
      run_state: status.run_state,
      has_completed_plan: status.has_completed_plan,
      updated_at: status.updated_at?.toISOString() ?? null,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    const searchParams = new URL(request.url).searchParams;
    const requestedWorkspaceId = searchParams.get("workspace_id");
    const requestedCaptureSessionId = searchParams.get("capture_session_id");
    if (!requestedWorkspaceId) {
      throw new ApiError(400, "bad_request", "workspace_id is required.");
    }
    if (!getServerEnv().DIRECTOR_AUTOMATION_PLAN_GENERATION_ENABLED) {
      throw new ApiError(
        409,
        "conflict",
        "Director automation plan generation is disabled.",
      );
    }
    await ensureWorkspaceRole(auth, requestedWorkspaceId);
    const captureSessionId =
      requestedCaptureSessionId ??
      (await latestCompletedDirectorInterviewId(auth.orgId, requestedWorkspaceId));
    if (!captureSessionId) {
      throw new ApiError(
        409,
        "conflict",
        "No completed director interview found to generate an automation plan from.",
      );
    }
    await inngest.send({
      name: directorAutomationPlanRequestedEventName,
      data: {
        orgId: auth.orgId,
        workspaceId: requestedWorkspaceId,
        captureSessionIds: [captureSessionId],
        userId: auth.userId,
        idempotencyKey: `manual-retry:${captureSessionId}:${Date.now()}`,
      },
    });
    return apiJson({
      workspace_id: requestedWorkspaceId,
      run_state: "pending",
      has_completed_plan: false,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    return apiError(error);
  }
}

async function latestCompletedDirectorInterviewId(
  orgId: string,
  workspaceId: string,
) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx
      .select({ id: captureSessions.id })
      .from(captureSessions)
      .where(
        and(
          eq(captureSessions.orgId, orgId),
          eq(captureSessions.workspaceId, workspaceId),
          eq(captureSessions.captureType, "director_interview"),
          isNotNull(captureSessions.completedAt),
        ),
      )
      .orderBy(desc(captureSessions.completedAt))
      .limit(1);
  });
  return rows[0]?.id ?? null;
}
