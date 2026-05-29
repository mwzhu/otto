import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";

export type ProcessFollowUpTask = {
  id: string;
  task_type:
    | "open_question"
    | "conflicting_slot"
    | "low_confidence_claim"
    | "failed_stage"
    | "weak_merge"
    | "redaction_failure";
  title: string;
  description: string | null;
  target_type: string | null;
  target_id: string | null;
  priority: number;
  status: "open" | "in_progress" | "resolved" | "dismissed";
  capture_session_id: string | null;
  context_json: Record<string, unknown>;
  created_at: string;
};

type FollowUpRow = Omit<ProcessFollowUpTask, "priority" | "context_json"> & {
  priority: string | null;
  context_json: unknown;
};

export async function getProcessFollowUps(
  orgId: string,
  workspaceId: string,
  processId: string,
  options: { statuses?: ProcessFollowUpTask["status"][]; limit?: number } = {},
): Promise<ProcessFollowUpTask[]> {
  const statuses = options.statuses ?? ["open", "in_progress"];
  if (statuses.length === 0) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<FollowUpRow>(sql`
      SELECT
        id,
        task_type::text,
        title,
        description,
        target_type,
        target_id,
        priority::text,
        status::text,
        capture_session_id,
        context_json,
        created_at::text
      FROM follow_up_tasks
      WHERE org_id = ${orgId}
        AND workspace_id = ${workspaceId}
        AND process_id = ${processId}
        AND status = ANY(${followUpStatusArraySql(statuses)})
      ORDER BY priority DESC, created_at DESC
      LIMIT ${limit}
    `);
  });
  return result.rows.map((row) => ({
    ...row,
    priority: Number(row.priority ?? 0),
    context_json: isRecord(row.context_json) ? row.context_json : {},
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function followUpStatusArraySql(statuses: ProcessFollowUpTask["status"][]) {
  if (statuses.length === 0) return sql`ARRAY[]::follow_up_task_status[]`;
  return sql`ARRAY[${sql.join(
    statuses.map((status) => sql`${status}::follow_up_task_status`),
    sql`, `,
  )}]::follow_up_task_status[]`;
}
