import { NextResponse } from "next/server";
import { getWorkOS } from "@/lib/auth/session";
import { apiError } from "@/lib/http/json";
import { requireEnv } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const returnTo = safeReturnPath(requestUrl.searchParams.get("return_to"));
    const workos = getWorkOS();
    const url = workos.userManagement.getAuthorizationUrl({
      clientId: requireEnv("WORKOS_CLIENT_ID"),
      redirectUri: requireEnv("WORKOS_REDIRECT_URI"),
      provider: "authkit",
      ...(returnTo ? { state: returnTo } : {}),
    });
    return NextResponse.redirect(url);
  } catch (error) {
    return apiError(error);
  }
}

function safeReturnPath(value: string | null) {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("://")) return null;
  return value;
}
