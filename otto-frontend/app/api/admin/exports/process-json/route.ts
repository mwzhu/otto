import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureWorkspaceRole, requireAuth } from "@/lib/auth/session";
import { apiError } from "@/lib/http/json";
import { buildProcessJsonExport } from "@/lib/admin/export-queries";

export const runtime = "nodejs";

const querySchema = z.object({
  workspace_id: z.string().uuid(),
  process_id: z.string().uuid(),
  version_id: z.string().uuid(),
});

export async function GET(request: Request) {
  try {
    const auth = await requireAuth(request);
    const url = new URL(request.url);
    const query = querySchema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      process_id: url.searchParams.get("process_id"),
      version_id: url.searchParams.get("version_id"),
    });
    await ensureWorkspaceRole(auth, query.workspace_id, [
      "director",
      "operator",
      "viewer",
    ]);

    const payload = await buildProcessJsonExport({
      orgId: auth.orgId,
      workspaceId: query.workspace_id,
      processId: query.process_id,
      versionId: query.version_id,
    });
    const filename = safeFilename(
      `${payload.process.name}-v${payload.version.version_number}.json`,
    );

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

function safeFilename(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
}
