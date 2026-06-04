import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";

export type VariantReviewRow = {
  id: string;
  proposed_name: string;
  proposed_function: string | null;
  confidence: string | number | null;
  evidence_count: number;
  created_at: string;
};

export type ProcessMergeTarget = {
  id: string;
  name: string;
  status: string;
};

export async function getVariantReviewQueue(orgId: string, workspaceId: string) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<VariantReviewRow>(sql`
      SELECT
        id,
        proposed_name,
        proposed_function,
        confidence,
        cardinality(evidence_ids) AS evidence_count,
        created_at::text AS created_at
      FROM candidate_processes
      WHERE org_id = ${orgId}
        AND workspace_id = ${workspaceId}
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 100
    `);
  }).then((result) => result.rows);
}

export async function getProcessMergeTargets(orgId: string, workspaceId: string) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<ProcessMergeTarget>(sql`
      SELECT id, name, status::text
      FROM processes
      WHERE org_id = ${orgId}
        AND workspace_id = ${workspaceId}
        AND status IN ('draft', 'approved')
      ORDER BY name ASC
      LIMIT 100
    `);
  }).then((result) => result.rows);
}
