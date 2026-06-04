import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { auditLog, workspaceRoiPrices } from "@/lib/db/schema";
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

export const runtime = "nodejs";

const bodySchema = z
  .object({
    loaded_hourly_cost: z.number().positive(),
    cost_per_error: z.number().nonnegative(),
    delay_cost: z.number().nonnegative(),
    currency: z.string().min(3).max(3).default("USD"),
  })
  .strict();

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await ctx.params;
    const auth = await requireAuth(request);
    if (auth.orgRole !== "org_admin" && auth.orgRole !== "fde") {
      throw new ApiError(403, "forbidden", "Workspace finance settings require admin access.");
    }
    await ensureWorkspaceRole(auth, workspaceId, ["director"]);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const route = "PUT /api/workspaces/:workspaceId/roi-prices";

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
      const prices = (
        await tx
          .insert(workspaceRoiPrices)
          .values({
            orgId: auth.orgId,
            workspaceId,
            loadedHourlyCost: String(body.loaded_hourly_cost),
            costPerError: String(body.cost_per_error),
            delayCost: String(body.delay_cost),
            currency: body.currency,
            editedByUserId: auth.userId,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: workspaceRoiPrices.workspaceId,
            set: {
              loadedHourlyCost: String(body.loaded_hourly_cost),
              costPerError: String(body.cost_per_error),
              delayCost: String(body.delay_cost),
              currency: body.currency,
              editedByUserId: auth.userId,
              updatedAt: new Date(),
            },
          })
          .returning()
      )[0];
      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId,
        userId: auth.userId,
        eventType: "workspace.roi_prices.updated",
        subjectType: "workspace",
        subjectId: workspaceId,
        metadataJson: {
          loaded_hourly_cost: body.loaded_hourly_cost,
          cost_per_error: body.cost_per_error,
          delay_cost: body.delay_cost,
          currency: body.currency,
          idempotency_key: idempotencyKey,
        },
      });
      const response = { prices };
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
