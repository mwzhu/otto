import "server-only";

import { timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/http/json";
import { getServerEnv } from "@/lib/env";

export function requireLiveKitAgentService(request: Request) {
  const expected = getServerEnv().LIVEKIT_AGENT_SERVICE_TOKEN;
  if (typeof expected !== "string" || !configuredServiceToken(expected)) {
    throw new ApiError(
      401,
      "unauthorized",
      "LiveKit agent service token is not configured.",
    );
  }
  const expectedToken = expected.trim();
  const header = request.headers.get("authorization") ?? "";
  const actual = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!constantTimeEqual(actual, expectedToken)) {
    throw new ApiError(401, "unauthorized", "Invalid service token.");
  }
}

function configuredServiceToken(value: unknown) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return false;
  const lowered = trimmed.toLowerCase();
  if (
    lowered === "..." ||
    lowered === "replace-me" ||
    lowered === "replace_with_real_value"
  ) {
    return false;
  }
  if (lowered.startsWith("replace-with")) return false;
  if (lowered.includes("your-project")) return false;
  return true;
}

function constantTimeEqual(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
