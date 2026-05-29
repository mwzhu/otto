import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { auditLog, processes, processVersions } from "@/lib/db/schema";
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
    workspace_id: z.string().uuid(),
  })
  .strict();

export async function POST(
  request: Request,
  ctx: { params: Promise<{ processId: string; versionId: string }> },
) {
  try {
    const { processId, versionId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director"]);
    const route = "POST /api/processes/:processId/versions/:versionId/approve";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`process.version.approve:${processId}:${versionId}`}))
      `);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return { body: cached.responseJson, statusCode: cached.statusCode };
      }

      const version = (
        await tx
          .select()
          .from(processVersions)
          .where(
            and(
              eq(processVersions.id, versionId),
              eq(processVersions.processId, processId),
              eq(processVersions.orgId, auth.orgId),
              eq(processVersions.workspaceId, body.workspace_id),
            ),
          )
          .limit(1)
      )[0];
      if (!version) {
        throw new ApiError(404, "not_found", "Process version not found.");
      }
      if (version.status !== "draft") {
        throw new ApiError(409, "conflict", "Only draft process versions can be approved.");
      }
      const visibilityRows = await tx.execute<{ can_approve: boolean }>(sql`
        SELECT (
          p.current_draft_version_id = ${versionId}
          OR EXISTS (
            SELECT 1
            FROM audit_log al
            WHERE al.org_id = ${auth.orgId}
              AND al.workspace_id = ${body.workspace_id}
              AND al.event_type = 'synthesis.operator.draft_published'
              AND al.subject_type = 'process_version'
              AND al.subject_id = ${versionId}
          )
        ) AS can_approve
        FROM processes p
        WHERE p.id = ${processId}
          AND p.org_id = ${auth.orgId}
          AND p.workspace_id = ${body.workspace_id}
        LIMIT 1
      `);
      if (!visibilityRows.rows[0]?.can_approve) {
        throw new ApiError(
          409,
          "conflict",
          "Only published draft process versions can be approved.",
        );
      }

      const approvedVersion = (
        await tx
          .update(processVersions)
          .set({
            status: "approved",
            approvedByUserId: auth.userId,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(processVersions.id, versionId))
          .returning()
      )[0];

      await tx
        .update(processes)
        .set({
          status: "approved",
          currentApprovedVersionId: versionId,
          currentDraftVersionId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(processes.id, processId),
            eq(processes.orgId, auth.orgId),
            eq(processes.workspaceId, body.workspace_id),
          ),
        );

      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        eventType: "process.version.approved",
        subjectType: "process_version",
        subjectId: versionId,
        metadataJson: {
          process_id: processId,
          version_number: approvedVersion.versionNumber,
          idempotency_key: idempotencyKey,
        },
      });

      const response = { process_version: approvedVersion };
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
