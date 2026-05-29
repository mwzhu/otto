import { z } from "zod";
import { ensureWorkspaceRole, requireAuth } from "@/lib/auth/session";
import { apiError, apiJson } from "@/lib/http/json";
import { getProcessEvidenceRows } from "@/lib/processes/evidence-queries";

export const runtime = "nodejs";

const querySchema = z.object({
  workspace_id: z.string().uuid(),
  version_id: z.string().uuid().optional(),
  evidence_ids: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().uuid()).min(1).max(50)),
});

export async function GET(
  request: Request,
  ctx: { params: Promise<{ processId: string }> },
) {
  try {
    const { processId } = await ctx.params;
    const auth = await requireAuth(request);
    const url = new URL(request.url);
    const query = querySchema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      version_id: url.searchParams.get("version_id") ?? undefined,
      evidence_ids: url.searchParams.get("evidence_ids"),
    });
    await ensureWorkspaceRole(auth, query.workspace_id, [
      "director",
      "operator",
      "viewer",
    ]);
    const evidence = await getProcessEvidenceRows({
      orgId: auth.orgId,
      workspaceId: query.workspace_id,
      processId,
      versionId: query.version_id,
      evidenceIds: query.evidence_ids,
    });
    return apiJson({ evidence });
  } catch (error) {
    return apiError(error);
  }
}
