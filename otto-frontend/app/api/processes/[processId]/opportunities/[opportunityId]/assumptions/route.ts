import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { auditLog, opportunityAssumptionOverrides } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import {
  ApiError,
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import { isOpportunitySetKeyReadable } from "@/lib/processes/opportunity-queries";

export const runtime = "nodejs";

const assumptionsSchema = z
  .object({
    annual_volume: z.number().nonnegative().optional(),
    minutes_saved_per_case: z.number().nonnegative().optional(),
    error_rate: z.number().min(0).max(1).optional(),
    exception_rate: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    effort_penalty: z.number().min(1).optional(),
  })
  .strict();

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
    version_id: z.string().uuid(),
    opportunity_set_key: z.string().min(1),
    assumptions: assumptionsSchema,
  })
  .strict();

export async function POST(
  request: Request,
  ctx: { params: Promise<{ processId: string; opportunityId: string }> },
) {
  try {
    const { processId, opportunityId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director", "operator"]);
    const readable = await isOpportunitySetKeyReadable({
      orgId: auth.orgId,
      workspaceId: body.workspace_id,
      processId,
      versionId: body.version_id,
      opportunitySetKey: body.opportunity_set_key,
    });
    if (!readable) {
      throw new ApiError(404, "not_found", "Opportunity set not found.");
    }

    const route =
      "POST /api/processes/:processId/opportunities/:opportunityId/assumptions";
    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return { body: cached.responseJson, statusCode: cached.statusCode };
      }
      const row = (
        await tx
          .insert(opportunityAssumptionOverrides)
          .values({
            orgId: auth.orgId,
            workspaceId: body.workspace_id,
            versionId: body.version_id,
            opportunitySetKey: body.opportunity_set_key,
            opportunityId,
            assumptionsJson: body.assumptions,
            editedByUserId: auth.userId,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              opportunityAssumptionOverrides.versionId,
              opportunityAssumptionOverrides.opportunitySetKey,
              opportunityAssumptionOverrides.opportunityId,
            ],
            set: {
              assumptionsJson: body.assumptions,
              editedByUserId: auth.userId,
              updatedAt: new Date(),
            },
          })
          .returning()
      )[0];
      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        eventType: "opportunity.assumptions.updated",
        subjectType: "automation_opportunity",
        subjectId: opportunityId,
        metadataJson: {
          process_id: processId,
          version_id: body.version_id,
          opportunity_set_key: body.opportunity_set_key,
          idempotency_key: idempotencyKey,
        },
      });
      const response = { override: row };
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 200,
      });
      return { body: response, statusCode: 200 };
    });
    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}
