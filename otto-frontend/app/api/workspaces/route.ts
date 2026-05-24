import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  auditLog,
  processVersions,
  processes,
  workspaceMemberships,
  workspaces,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth/session";
import {
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

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
  function_name: z.string().min(1),
  starter_process_name: z.string().min(1).optional(),
  create_starter_process: z.boolean().default(true),
});

export async function GET(request: Request) {
  try {
    const auth = await requireAuth(request);
    const rows = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      return tx.select().from(workspaces).where(eq(workspaces.orgId, auth.orgId));
    });
    return apiJson({ workspaces: rows });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = createWorkspaceSchema.parse(json);
    const route = "POST /api/workspaces";
    const db = getDb();

    const result = await db.transaction(async (tx) => {
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

      const workspace = (
        await tx
          .insert(workspaces)
          .values({
            orgId: auth.orgId,
            name: body.name,
            functionName: body.function_name,
            createdByUserId: auth.userId,
          })
          .returning()
      )[0];

      await tx.insert(workspaceMemberships).values({
        orgId: auth.orgId,
        workspaceId: workspace.id,
        userId: auth.userId,
        workspaceRole: "director",
      });

      let process = null;
      let version = null;
      if (body.create_starter_process) {
        process = (
          await tx
            .insert(processes)
            .values({
              orgId: auth.orgId,
              workspaceId: workspace.id,
              name: body.starter_process_name ?? "Untitled Process",
              description: "Phase 0 starter process for evidence-backed claims.",
              status: "draft",
            })
            .returning()
        )[0];
        version = (
          await tx
            .insert(processVersions)
            .values({
              orgId: auth.orgId,
              workspaceId: workspace.id,
              processId: process.id,
              versionNumber: 1,
              status: "draft",
              summary: "Initial draft shell.",
            })
            .returning()
        )[0];
        await tx
          .update(processes)
          .set({ currentDraftVersionId: version.id, updatedAt: new Date() })
          .where(eq(processes.id, process.id));
      }
      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: workspace.id,
        userId: auth.userId,
        eventType: "workspace.create",
        subjectType: "workspace",
        subjectId: workspace.id,
        metadataJson: { idempotency_key: idempotencyKey },
      });

      const response = { workspace, starter_process: process, starter_version: version };
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      return { body: response, statusCode: 201 };
    });

    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}
