import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  workspaceMemberships,
  workspaces,
  type workspaceRoleEnum,
} from "@/lib/db/schema";
import { type AuthContext, ensureWorkspaceRole } from "@/lib/auth/session";

export type WorkspaceRole = (typeof workspaceRoleEnum.enumValues)[number];

export async function getFirstWorkspaceForUser(auth: AuthContext) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, auth.orgId);
    if (auth.orgRole === "org_admin" || auth.orgRole === "fde") {
      return tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.orgId, auth.orgId))
        .orderBy(desc(workspaces.updatedAt), desc(workspaces.createdAt))
        .limit(1);
    }
    return tx
      .select({
        id: workspaces.id,
        orgId: workspaces.orgId,
        name: workspaces.name,
        functionName: workspaces.functionName,
        dataTier: workspaces.dataTier,
        status: workspaces.status,
        createdByUserId: workspaces.createdByUserId,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMemberships,
        and(
          eq(workspaceMemberships.workspaceId, workspaces.id),
          eq(workspaceMemberships.userId, auth.userId),
        ),
      )
      .where(eq(workspaces.orgId, auth.orgId))
      .orderBy(desc(workspaces.updatedAt), desc(workspaces.createdAt))
      .limit(1);
  });
  return rows[0] ?? null;
}

export async function getCurrentWorkspace(auth: AuthContext) {
  return getFirstWorkspaceForUser(auth);
}

export async function requireWorkspaceAccess(
  auth: AuthContext,
  workspaceId: string,
  allowed: WorkspaceRole[] = ["director", "operator", "viewer"],
) {
  await ensureWorkspaceRole(auth, workspaceId, allowed);
}
