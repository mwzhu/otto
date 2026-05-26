import { afterEach, describe, expect, test, vi } from "vitest";
import { requireLiveKitAgentService } from "@/lib/auth/service";

describe("LiveKit agent service auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("accepts the configured bearer token", () => {
    vi.stubEnv("LIVEKIT_AGENT_SERVICE_TOKEN", "service-token");

    expect(() =>
      requireLiveKitAgentService(
        new Request("http://localhost/internal", {
          headers: { authorization: "Bearer service-token" },
        }),
      ),
    ).not.toThrow();
  });

  test("rejects invalid bearer tokens", () => {
    vi.stubEnv("LIVEKIT_AGENT_SERVICE_TOKEN", "service-token");

    expect(() =>
      requireLiveKitAgentService(
        new Request("http://localhost/internal", {
          headers: { authorization: "Bearer wrong-token" },
        }),
      ),
    ).toThrow("Invalid service token.");
  });

  test("rejects template placeholder service tokens as unconfigured", () => {
    vi.stubEnv("LIVEKIT_AGENT_SERVICE_TOKEN", "replace-with-service-token");

    expect(() =>
      requireLiveKitAgentService(
        new Request("http://localhost/internal", {
          headers: { authorization: "Bearer replace-with-service-token" },
        }),
      ),
    ).toThrow("LiveKit agent service token is not configured.");
  });
});
