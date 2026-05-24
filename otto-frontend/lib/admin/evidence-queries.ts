import "server-only";

import { desc, eq } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { evidence } from "@/lib/db/schema";

export type AdminEvidenceRow = {
  id: string;
  sourceType: string;
  evidenceLabel: string;
  quote: string | null;
  summary: string | null;
  observedAt: Date | null;
  confidence: string;
};

export async function getEvidenceInventory(orgId: string, workspaceId: string) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx
      .select({
        id: evidence.id,
        sourceType: evidence.sourceType,
        evidenceLabel: evidence.evidenceLabel,
        quote: evidence.quote,
        summary: evidence.summary,
        observedAt: evidence.observedAt,
        confidence: evidence.confidence,
      })
      .from(evidence)
      .where(eq(evidence.workspaceId, workspaceId))
      .orderBy(desc(evidence.createdAt))
      .limit(200);
  });
}
