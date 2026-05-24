import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createDirectorRoomToken } from "@/lib/adapters/livekit";
import { getDb, setOrgContext } from "@/lib/db/client";
import { captureSessions } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import { ApiError, apiError, apiJson, readJsonWithHash } from "@/lib/http/json";

export const runtime = "nodejs";

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  capture_session_id: z.string().uuid(),
});

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    const { json } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director"]);

    const captureRows = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      return tx
        .select({ id: captureSessions.id })
        .from(captureSessions)
        .where(
          and(
            eq(captureSessions.id, body.capture_session_id),
            eq(captureSessions.orgId, auth.orgId),
            eq(captureSessions.workspaceId, body.workspace_id),
            eq(captureSessions.captureType, "director_interview"),
          ),
        )
        .limit(1);
    });
    if (!captureRows[0]) {
      throw new ApiError(404, "not_found", "Director interview not found.");
    }

    const room = await createDirectorRoomToken({
      captureSessionId: body.capture_session_id,
      participantIdentity: auth.userId,
    });
    return apiJson(room);
  } catch (error) {
    return apiError(error);
  }
}
