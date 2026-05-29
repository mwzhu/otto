import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { captureSessions, interviewState, slotStates } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import { ApiError, apiError, apiJson } from "@/lib/http/json";
import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";

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
    await ensureWorkspaceRole(auth, query.workspace_id, ["director", "viewer"]);

    const { rows, focusCandidateProcessId } = await getDb().transaction(async (tx) => {
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
            ),
          )
          .limit(1)
      )[0];
      if (!session) {
        throw new ApiError(404, "not_found", "Director interview not found.");
      }
      const state = (
        await tx
          .select({ focusCandidateProcessId: interviewState.focusCandidateProcessId })
          .from(interviewState)
          .where(eq(interviewState.captureSessionId, captureSessionId))
          .limit(1)
      )[0];
      const slotRows = await tx
        .select()
        .from(slotStates)
        .where(eq(slotStates.captureSessionId, captureSessionId));
      return {
        rows: slotRows,
        focusCandidateProcessId: state?.focusCandidateProcessId ?? null,
      };
    });

    const byPath = new Map(
      rows
        .filter(
          (row) =>
            row.candidateProcessId === null ||
            row.candidateProcessId === focusCandidateProcessId,
        )
        .map((row) => [row.slotPath, row]),
    );
    const slots = directorSlotDefinitions.map((definition) => {
      const row = byPath.get(definition.path);
      return {
        slot_path: definition.path,
        ...(row?.candidateProcessId ? { candidate_process_id: row.candidateProcessId } : {}),
        label: definition.label,
        priority: definition.priority,
        status: row?.status ?? "empty",
        confidence: Number(row?.confidence ?? 0),
        evidence_count: row?.evidenceIds.length ?? 0,
        last_asked_at: row?.lastAskedAt ?? null,
        value: row?.value ?? null,
      };
    });
    const counts = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const result = await tx.execute<{
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
      return Object.fromEntries(
        result.rows.map((row) => [row.status, Number(row.count)]),
      );
    });

    return apiJson({ capture_session_id: captureSessionId, counts, slots });
  } catch (error) {
    return apiError(error);
  }
}
