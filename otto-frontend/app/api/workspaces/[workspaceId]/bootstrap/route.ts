import { and, eq } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  artifacts,
  claimEvidence,
  claims,
  evidence,
  processVersions,
  processes,
  workspaces,
} from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import { apiError, apiJson } from "@/lib/http/json";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await ctx.params;
    const auth = await requireAuth(request);
    await ensureWorkspaceRole(auth, workspaceId);
    const data = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const workspace = (
        await tx
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, auth.orgId)))
        .limit(1)
      )[0];
      if (!workspace) return null;
      const [artifactRows, processRows, versionRows, evidenceRows, claimRows, claimEvidenceRows] =
        await Promise.all([
          tx
            .select()
            .from(artifacts)
            .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.orgId, auth.orgId))),
          tx
            .select()
            .from(processes)
            .where(and(eq(processes.workspaceId, workspaceId), eq(processes.orgId, auth.orgId))),
          tx
            .select()
            .from(processVersions)
            .where(and(eq(processVersions.workspaceId, workspaceId), eq(processVersions.orgId, auth.orgId))),
          tx
            .select()
            .from(evidence)
            .where(and(eq(evidence.workspaceId, workspaceId), eq(evidence.orgId, auth.orgId))),
          tx
            .select()
            .from(claims)
            .where(and(eq(claims.workspaceId, workspaceId), eq(claims.orgId, auth.orgId))),
          tx.select().from(claimEvidence),
        ]);
      return {
        workspace,
        artifacts: artifactRows,
        processes: processRows,
        process_versions: versionRows,
        evidence: evidenceRows,
        claims: claimRows,
        claim_evidence: claimEvidenceRows,
      };
    });
    const workspace = data?.workspace;
    if (!workspace) {
      return apiJson({ error: { code: "not_found", message: "Workspace not found." } }, { status: 404 });
    }
    return apiJson({
      ...data,
      phase_0_only: true,
    });
  } catch (error) {
    return apiError(error);
  }
}
