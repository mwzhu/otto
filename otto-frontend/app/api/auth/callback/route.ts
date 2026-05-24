import { NextResponse } from "next/server";
import { getDb, setOrgContext } from "@/lib/db/client";
import { organizations, users } from "@/lib/db/schema";
import {
  getWorkOS,
  sessionCookieHeader,
  type OrgRole,
} from "@/lib/auth/session";
import { stableUuid } from "@/lib/auth/stable-id";
import { apiError } from "@/lib/http/json";
import { requireEnv } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    if (!code) {
      return NextResponse.json(
        { error: { code: "bad_request", message: "Missing code." } },
        { status: 400 },
      );
    }

    const workos = getWorkOS();
    const auth = await workos.userManagement.authenticateWithCode({
      clientId: requireEnv("WORKOS_CLIENT_ID"),
      code,
    });
    const workosUser = auth.user;
    const workosOrganizationId = auth.organizationId ?? `solo_user_${workosUser.id}`;
    const orgId = auth.organizationId
      ? stableUuid("workos_org", workosOrganizationId)
      : stableUuid("workos_user_solo", workosUser.id);
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      await setOrgContext(tx, orgId);
      const org = (
        await tx
          .insert(organizations)
          .values({
            id: orgId,
            workosOrganizationId,
            name: workosOrganizationId,
          })
          .onConflictDoUpdate({
            target: organizations.workosOrganizationId,
            set: { updatedAt: new Date() },
          })
          .returning()
      )[0];
      const user = (
        await tx
          .insert(users)
          .values({
            orgId: org.id,
            workosUserId: workosUser.id,
            email: workosUser.email,
            name:
              [workosUser.firstName, workosUser.lastName]
                .filter(Boolean)
                .join(" ") || workosUser.email,
            orgRole: "org_admin",
          })
          .onConflictDoUpdate({
            target: users.workosUserId,
            set: { email: workosUser.email, updatedAt: new Date() },
          })
          .returning()
      )[0];
      return { org, user };
    });

    const response = NextResponse.redirect(new URL("/onboarding", request.url));
    response.headers.append(
      "set-cookie",
      sessionCookieHeader({
        orgId: result.org.id,
        userId: result.user.id,
        email: result.user.email,
        name: result.user.name,
        orgRole: result.user.orgRole as OrgRole | null,
        workosUserId: result.user.workosUserId,
        workosOrganizationId,
      }),
    );
    return response;
  } catch (error) {
    return apiError(error);
  }
}
