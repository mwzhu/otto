import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { WorkOS } from "@workos-inc/node";
import { and, eq } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  organizations,
  users,
  workspaceMemberships,
  type orgRoleEnum,
  type workspaceRoleEnum,
} from "@/lib/db/schema";
import { ApiError } from "@/lib/http/json";
import {
  assertSafeRuntimeEnv,
  getServerEnv,
  requireEnv,
} from "@/lib/env";
import { stableUuid } from "@/lib/auth/stable-id";

export type OrgRole = (typeof orgRoleEnum.enumValues)[number];
export type WorkspaceRole = (typeof workspaceRoleEnum.enumValues)[number];

export type AuthContext = {
  orgId: string;
  userId: string;
  email: string;
  name: string | null;
  orgRole: OrgRole | null;
  workosUserId: string;
  workosOrganizationId: string;
};

const SESSION_COOKIE = "otto_session";

type SessionPayload = {
  orgId: string;
  userId: string;
  email: string;
  name: string | null;
  orgRole: OrgRole | null;
  workosUserId: string;
  workosOrganizationId: string;
};

export function getWorkOS() {
  return new WorkOS(requireEnv("WORKOS_API_KEY"));
}

export async function requireAuth(request: Request): Promise<AuthContext> {
  assertSafeRuntimeEnv();
  const env = getServerEnv();
  if (env.OTTO_DEV_AUTH_BYPASS) {
    return ensureDevPrincipal();
  }

  const cookie = parseCookie(request.headers.get("cookie") ?? "")[
    SESSION_COOKIE
  ];
  if (!cookie) {
    throw new ApiError(401, "unauthorized", "Authentication required.");
  }
  const payload = verifySessionCookie(cookie);
  if (!payload) {
    throw new ApiError(401, "unauthorized", "Invalid session.");
  }
  return payload;
}

export async function requirePageAuth(): Promise<AuthContext> {
  assertSafeRuntimeEnv();
  const env = getServerEnv();
  if (env.OTTO_DEV_AUTH_BYPASS) {
    return ensureDevPrincipal();
  }

  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) {
    throw new ApiError(401, "unauthorized", "Authentication required.");
  }
  const payload = verifySessionCookie(cookie);
  if (!payload) {
    throw new ApiError(401, "unauthorized", "Invalid session.");
  }
  return payload;
}

export async function ensureWorkspaceRole(
  auth: AuthContext,
  workspaceId: string,
  allowed: WorkspaceRole[] = ["director", "operator", "viewer"],
) {
  if (await hasWorkspaceRole(auth, workspaceId, allowed)) return;
  throw new ApiError(403, "forbidden", "Workspace access denied.");
}

export async function hasWorkspaceRole(
  auth: AuthContext,
  workspaceId: string,
  allowed: WorkspaceRole[] = ["director", "operator", "viewer"],
) {
  if (auth.orgRole === "org_admin" || auth.orgRole === "fde") {
    return true;
  }
  const db = getDb();
  const rows = await db.transaction(async (tx) => {
    await setOrgContext(tx, auth.orgId);
    return tx
      .select({ role: workspaceMemberships.workspaceRole })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.orgId, auth.orgId),
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.userId, auth.userId),
        ),
      )
      .limit(1);
  });
  const role = rows[0]?.role;
  return Boolean(role && allowed.includes(role));
}

export function signSessionCookie(payload: SessionPayload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", requireEnv("WORKOS_COOKIE_PASSWORD"))
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

export function sessionCookieHeader(payload: SessionPayload) {
  const value = signSessionCookie(payload);
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}

function verifySessionCookie(cookie: string): SessionPayload | null {
  const [body, signature] = cookie.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", requireEnv("WORKOS_COOKIE_PASSWORD"))
    .update(body)
    .digest("base64url");
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

function parseCookie(header: string) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, ...value] = part.split("=");
        return [key, decodeURIComponent(value.join("="))];
      }),
  );
}

async function ensureDevPrincipal(): Promise<AuthContext> {
  const db = getDb();
  const workosOrganizationId = "dev_org";
  const workosUserId = "dev_user";
  const orgId = stableUuid("workos_org", workosOrganizationId);
  const { org, user } = await db.transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    const org = (
      await tx
        .insert(organizations)
        .values({
          id: orgId,
          workosOrganizationId,
          name: "Development Org",
        })
        .onConflictDoUpdate({
          target: organizations.workosOrganizationId,
          set: { name: "Development Org", updatedAt: new Date() },
        })
        .returning()
    )[0];
    const user = (
      await tx
        .insert(users)
        .values({
          orgId: org.id,
          workosUserId,
          email: "dev@otto.local",
          name: "Dev User",
          orgRole: "org_admin",
        })
        .onConflictDoUpdate({
          target: users.workosUserId,
          set: { name: "Dev User", orgRole: "org_admin", updatedAt: new Date() },
        })
        .returning()
    )[0];
    return { org, user };
  });
  return {
    orgId: org.id,
    userId: user.id,
    email: user.email,
    name: user.name,
    orgRole: user.orgRole,
    workosUserId,
    workosOrganizationId,
  };
}
