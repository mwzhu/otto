import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { workspaceRoiPrices } from "@/lib/db/schema";
import { ROI_PRICE_DEFAULTS } from "@/lib/processes/opportunity-heuristics";
import type { OpportunityPriceConstants } from "@/lib/processes/opportunity-schema";

export { ROI_PRICE_DEFAULTS };

export type WorkspaceRoiPrices = OpportunityPriceConstants & {
  currency: string;
};

export async function getWorkspaceRoiPrices(
  orgId: string,
  workspaceId: string,
): Promise<WorkspaceRoiPrices> {
  const row = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return (
      await tx
        .select()
        .from(workspaceRoiPrices)
        .where(
          and(
            eq(workspaceRoiPrices.orgId, orgId),
            eq(workspaceRoiPrices.workspaceId, workspaceId),
          ),
        )
        .limit(1)
    )[0];
  });
  if (!row) {
    return {
      ...ROI_PRICE_DEFAULTS,
      currency: "USD",
    };
  }
  return {
    loaded_hourly_cost: Number(row.loadedHourlyCost),
    cost_per_error: Number(row.costPerError),
    delay_cost: Number(row.delayCost),
    currency: row.currency,
  };
}

export async function upsertWorkspaceRoiPrices(input: {
  orgId: string;
  workspaceId: string;
  loadedHourlyCost: number;
  costPerError: number;
  delayCost: number;
  currency?: string;
  editedByUserId?: string | null;
}) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return (
      await tx
        .insert(workspaceRoiPrices)
        .values({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          loadedHourlyCost: String(input.loadedHourlyCost),
          costPerError: String(input.costPerError),
          delayCost: String(input.delayCost),
          currency: input.currency ?? "USD",
          editedByUserId: input.editedByUserId ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: workspaceRoiPrices.workspaceId,
          set: {
            loadedHourlyCost: String(input.loadedHourlyCost),
            costPerError: String(input.costPerError),
            delayCost: String(input.delayCost),
            currency: input.currency ?? "USD",
            editedByUserId: input.editedByUserId ?? null,
            updatedAt: new Date(),
          },
        })
        .returning()
    )[0];
  });
}
