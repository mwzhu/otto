import { z } from "zod";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import { apiError, apiJson, readJsonWithHash, requireIdempotencyKey } from "@/lib/http/json";
import { mergeCandidateProcess } from "@/lib/candidate-processes/promotion";

export const runtime = "nodejs";

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  target_process_id: z.string().uuid(),
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ candidateProcessId: string }> },
) {
  try {
    const { candidateProcessId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director"]);
    const result = await mergeCandidateProcess(
      {
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        idempotencyKey,
      },
      candidateProcessId,
      body.target_process_id,
    );
    return apiJson(result);
  } catch (error) {
    return apiError(error);
  }
}
