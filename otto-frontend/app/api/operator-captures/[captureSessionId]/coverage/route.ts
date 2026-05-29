import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ensureWorkspaceRole, requireAuth } from "@/lib/auth/session";
import { getDb, setOrgContext } from "@/lib/db/client";
import { captureSessions, provisionalSteps, slotStates } from "@/lib/db/schema";
import { operatorSlotDefinitions } from "@/lib/interview/operator/schema";
import { ApiError, apiError, apiJson } from "@/lib/http/json";

export const runtime = "nodejs";

const querySchema = z.object({
  workspace_id: z.string().uuid(),
});

export async function GET(
  request: Request,
  ctx: { params: Promise<{ captureSessionId: string }> },
) {
  try {
    const { captureSessionId } = await ctx.params;
    const auth = await requireAuth(request);
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    await ensureWorkspaceRole(auth, query.workspace_id, [
      "director",
      "operator",
      "viewer",
    ]);

    const { rows, steps, counts } = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const session = (
        await tx
          .select({ id: captureSessions.id })
          .from(captureSessions)
          .where(
            and(
              eq(captureSessions.id, captureSessionId),
              eq(captureSessions.orgId, auth.orgId),
              eq(captureSessions.workspaceId, query.workspace_id),
              eq(captureSessions.captureType, "operator_interview"),
            ),
          )
          .limit(1)
      )[0];
      if (!session) {
        throw new ApiError(404, "not_found", "Operator capture not found.");
      }
      const slotRows = await tx
        .select()
        .from(slotStates)
        .where(eq(slotStates.captureSessionId, captureSessionId));
      const stepRows = await tx
        .select({
          id: provisionalSteps.id,
          actionVerb: provisionalSteps.actionVerb,
          actionObject: provisionalSteps.actionObject,
          confidence: provisionalSteps.confidence,
        })
        .from(provisionalSteps)
        .where(eq(provisionalSteps.captureSessionId, captureSessionId));
      const countRows = await tx.execute<{
        status: string;
        count: string;
      }>(sql`
        SELECT status::text, count(*)::text AS count
        FROM slot_states
        WHERE org_id = ${auth.orgId}
          AND workspace_id = ${query.workspace_id}
          AND capture_session_id = ${captureSessionId}
        GROUP BY status
      `);
      return {
        rows: slotRows,
        steps: stepRows,
        counts: Object.fromEntries(
          countRows.rows.map((row) => [row.status, Number(row.count)]),
        ),
      };
    });

    const stepTitles = new Map(
      steps.map((step) => [
        step.id,
        [step.actionVerb, step.actionObject].filter(Boolean).join(" ").trim() ||
          "Captured operator step",
      ]),
    );
    const slots = rows.map((row) => {
      const definition = operatorSlotDefinitions.find(
        (slot) => slot.path === row.slotPath,
      );
      return {
        slot_path: row.slotPath,
        provisional_step_id: row.provisionalStepId,
        provisional_step_title: row.provisionalStepId
          ? stepTitles.get(row.provisionalStepId) ?? null
          : null,
        label: definition?.label ?? row.slotPath,
        priority: definition?.priority ?? row.priority,
        status: row.status,
        confidence: Number(row.confidence ?? 0),
        evidence_count: row.evidenceIds.length,
        last_asked_at: row.lastAskedAt ?? null,
        value: row.value ?? null,
      };
    });
    const priorityDefinitions = operatorSlotDefinitions.filter(
      (slot) => slot.priority >= 90,
    );
    const coveredPriorityCount = priorityDefinitions.filter((definition) =>
      rows.some(
        (row) =>
          row.slotPath === definition.path &&
          row.status === "filled" &&
          Number(row.confidence ?? 0) >= 0.5,
      ),
    ).length;
    const priorityCoverage =
      priorityDefinitions.length === 0
        ? 1
        : coveredPriorityCount / priorityDefinitions.length;

    return apiJson({
      capture_session_id: captureSessionId,
      counts,
      priority_coverage: priorityCoverage,
      priority_slots_covered: coveredPriorityCount,
      priority_slots_total: priorityDefinitions.length,
      provisional_step_count: steps.length,
      slots,
    });
  } catch (error) {
    return apiError(error);
  }
}
