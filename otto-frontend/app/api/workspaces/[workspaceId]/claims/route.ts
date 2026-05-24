import { z } from "zod";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import { writeClaim } from "@/lib/db/write-claim";

export const runtime = "nodejs";

const bodySchema = z.object({
  subject: z.discriminatedUnion("type", [
    z.object({ type: z.literal("process"), id: z.string().uuid() }),
    z.object({ type: z.literal("process_version"), id: z.string().uuid() }),
    z.object({ type: z.literal("candidate_process"), id: z.string().uuid() }),
    z.object({ type: z.literal("system"), id: z.string().uuid() }),
    z.object({ type: z.literal("role"), id: z.string().uuid() }),
    z.object({ type: z.literal("person"), id: z.string().uuid() }),
  ]),
  field: z.string().min(1),
  value: z.unknown(),
  evidence_ids: z.array(z.string().uuid()).default([]),
  confidence: z.number().min(0).max(1).default(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await ctx.params;
    const auth = await requireAuth(request);
    await ensureWorkspaceRole(auth, workspaceId, ["director", "operator"]);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const result = await writeClaim({
      orgId: auth.orgId,
      workspaceId,
      userId: auth.userId,
      subject: body.subject,
      field: body.field,
      value: body.value,
      evidenceIds: body.evidence_ids,
      confidence: body.confidence,
      idempotencyKey,
      requestHash: hash,
      route: "POST /api/workspaces/:workspaceId/claims",
      metadata: body.metadata,
    });
    return apiJson(result.body, {
      status: result.statusCode,
      headers: result.idempotent ? { "x-idempotent-replay": "true" } : undefined,
    });
  } catch (error) {
    return apiError(error);
  }
}
