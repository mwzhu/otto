import { NextResponse } from "next/server";
import { getWorkOS } from "@/lib/auth/session";
import { apiError } from "@/lib/http/json";
import { requireEnv } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  try {
    const workos = getWorkOS();
    const url = workos.userManagement.getAuthorizationUrl({
      clientId: requireEnv("WORKOS_CLIENT_ID"),
      redirectUri: requireEnv("WORKOS_REDIRECT_URI"),
      provider: "authkit",
    });
    return NextResponse.redirect(url);
  } catch (error) {
    return apiError(error);
  }
}

