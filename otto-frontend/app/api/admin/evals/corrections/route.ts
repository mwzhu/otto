import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureWorkspaceRole, requireAuth } from "@/lib/auth/session";
import { buildCorrectionEvalFixture } from "@/lib/admin/correction-eval-queries";
import { apiError } from "@/lib/http/json";

export const runtime = "nodejs";

const querySchema = z.object({
  workspace_id: z.string().uuid(),
  target_agent: z
    .enum(["director", "operator", "synthesis", "opportunity"])
    .optional(),
});

export async function GET(request: Request) {
  try {
    const auth = await requireAuth(request);
    const url = new URL(request.url);
    const query = querySchema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      target_agent: url.searchParams.get("target_agent") ?? undefined,
    });
    await ensureWorkspaceRole(auth, query.workspace_id, [
      "director",
      "operator",
      "viewer",
    ]);
    const payload = await buildCorrectionEvalFixture({
      orgId: auth.orgId,
      workspaceId: query.workspace_id,
      targetAgent: query.target_agent,
    });
    const suffix = query.target_agent ? `-${query.target_agent}` : "";
    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="workspace-corrections${suffix}.json"`,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
