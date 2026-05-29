import { describe, expect, test, vi } from "vitest";
import {
  createDirectorRoomToken,
  directorVoiceReadiness,
  liveKitApiHost,
} from "@/lib/adapters/livekit";

describe("LiveKit director room adapter", () => {
  test("reports whether the pre-start flow needs microphone permission before dispatch", () => {
    expect(
      directorVoiceReadiness({ LIVEKIT_URL: "wss://otto.livekit.cloud" } as never),
    ).toMatchObject({
      mode: "simulated",
      requiresMicrophone: false,
      missing: expect.arrayContaining(["LIVEKIT_API_KEY"]),
    });
    expect(
      directorVoiceReadiness({
        NODE_ENV: "production",
        LIVEKIT_URL: "wss://otto.livekit.cloud",
      } as never),
    ).toMatchObject({
      mode: "unconfigured",
      requiresMicrophone: false,
      missing: expect.arrayContaining([
        "LIVEKIT_API_KEY",
        "DATABASE_URL",
        "DATABASE_SERVICE_URL",
        "ANTHROPIC_API_KEY",
        "OTTO_VENDOR_PRIVACY_ACK",
      ]),
    });
    expect(
      directorVoiceReadiness({
        LIVEKIT_URL: "wss://otto.livekit.cloud",
        LIVEKIT_API_KEY: "key",
        LIVEKIT_API_SECRET: "secret",
        LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
        OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
        DATABASE_URL: "postgres://app:app@localhost:5432/otto",
        DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
        DEEPGRAM_API_KEY: "deepgram",
        CARTESIA_API_KEY: "cartesia",
      } as never),
    ).toMatchObject({
      mode: "livekit",
      requiresMicrophone: true,
      missing: [],
    });
    expect(
      directorVoiceReadiness({
        LIVEKIT_URL: "wss://otto.livekit.cloud",
        LIVEKIT_API_KEY: "key",
        LIVEKIT_API_SECRET: "secret",
        LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
        OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
        DATABASE_URL: "postgres://app:app@localhost:5432/otto",
        DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
        OTTO_USE_LIVEKIT_INFERENCE: true,
      } as never),
    ).toMatchObject({
      mode: "livekit",
      requiresMicrophone: true,
      missing: [],
    });
  });

  test("falls back to simulated mode when production voice env is incomplete", async () => {
    const room = await createDirectorRoomToken(
      {
        captureSessionId: "11111111-1111-5111-8111-111111111111",
        participantIdentity: "user-1",
        language: "en",
      },
      { env: { LIVEKIT_URL: "wss://otto.livekit.cloud" } as never },
    );

    expect(room.mode).toBe("simulated");
    expect(room.room).toBe("director-11111111-1111-5111-8111-111111111111");
    expect(room.token).toBeNull();
    expect(room.tokenExpiresAt).toBeNull();
    expect(room.reason).toContain("LiveKit voice is not fully configured");
  });

  test("treats placeholder production voice env values as missing", async () => {
    const roomClientFactory = vi.fn();
    const dispatchClientFactory = vi.fn();
    const mintToken = vi.fn();
    const room = await createDirectorRoomToken(
      {
        captureSessionId: "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
        participantIdentity: "user-placeholder",
        language: "en",
      },
      {
        env: {
          LIVEKIT_URL: "wss://your-project.livekit.cloud",
          LIVEKIT_API_KEY: "...",
          LIVEKIT_API_SECRET: "replace-with-secret",
          LIVEKIT_AGENT_SERVICE_TOKEN: "replace-with-service-token",
          OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
          DATABASE_URL: "replace-with-app-database-url",
          DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
        } as never,
        roomClientFactory,
        dispatchClientFactory,
        mintToken,
      },
    );

    expect(room.mode).toBe("simulated");
    expect(room.reason).toContain("LIVEKIT_URL");
    expect(room.reason).toContain("LIVEKIT_API_KEY");
    expect(room.reason).toContain("LIVEKIT_API_SECRET");
    expect(room.reason).toContain("LIVEKIT_AGENT_SERVICE_TOKEN");
    expect(room.reason).toContain("DATABASE_URL");
    expect(room.reason).toContain("DEEPGRAM_API_KEY");
    expect(room.reason).toContain("CARTESIA_API_KEY");
    expect(roomClientFactory).not.toHaveBeenCalled();
    expect(dispatchClientFactory).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
  });

  test("does not create a LiveKit room when direct audio provider secrets are missing", async () => {
    const roomClientFactory = vi.fn();
    const dispatchClientFactory = vi.fn();
    const mintToken = vi.fn();
    const room = await createDirectorRoomToken(
      {
        captureSessionId: "55555555-5555-5555-8555-555555555555",
        participantIdentity: "user-5",
        language: "en",
      },
      {
        env: {
          LIVEKIT_URL: "wss://otto.livekit.cloud",
          LIVEKIT_API_KEY: "key",
          LIVEKIT_API_SECRET: "secret",
          LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
          OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
          DATABASE_URL: "postgres://app:app@localhost:5432/otto",
          DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
        } as never,
        roomClientFactory,
        dispatchClientFactory,
        mintToken,
      },
    );

    expect(room.mode).toBe("simulated");
    expect(room.reason).toContain("DEEPGRAM_API_KEY");
    expect(room.reason).toContain("CARTESIA_API_KEY");
    expect(roomClientFactory).not.toHaveBeenCalled();
    expect(dispatchClientFactory).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
  });

  test("creates a LiveKit room without direct provider secrets when LiveKit Inference is enabled", async () => {
    const room = await createDirectorRoomToken(
      {
        captureSessionId: "55555555-5555-5555-8555-555555555555",
        participantIdentity: "user-5",
        language: "en",
      },
      {
        env: {
          LIVEKIT_URL: "wss://otto.livekit.cloud",
          LIVEKIT_API_KEY: "key",
          LIVEKIT_API_SECRET: "secret",
          LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
          OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
          DATABASE_URL: "postgres://app:app@localhost:5432/otto",
          DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
          OTTO_USE_LIVEKIT_INFERENCE: true,
        } as never,
        roomClientFactory: () => ({
          listRooms: vi.fn(async () => []),
          createRoom: vi.fn(async () => ({})),
          updateRoomMetadata: vi.fn(async () => ({})),
        }),
        dispatchClientFactory: () => ({
          listDispatch: vi.fn(async () => []),
          createDispatch: vi.fn(async () => ({ id: "dispatch-5" })),
        }),
        mintToken: vi.fn(async () => "join-token"),
      },
    );

    expect(room).toMatchObject({
      mode: "livekit",
      room: "director-55555555-5555-5555-8555-555555555555",
      token: "join-token",
      dispatchId: "dispatch-5",
    });
  });

  test("strict production voice mode requires granular vendor privacy acknowledgements", async () => {
    await expect(
      createDirectorRoomToken(
        {
          captureSessionId: "66666666-6666-5666-8666-666666666666",
          participantIdentity: "user-6",
          language: "en",
        },
        {
          env: {
            LIVEKIT_URL: "wss://otto.livekit.cloud",
            LIVEKIT_API_KEY: "key",
            LIVEKIT_API_SECRET: "secret",
            LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
            OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
            DATABASE_URL: "postgres://app:app@localhost:5432/otto",
            DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
            OTTO_USE_LIVEKIT_INFERENCE: true,
            OTTO_DIRECTOR_PREFLIGHT_STRICT: true,
            ANTHROPIC_API_KEY: "anthropic",
          } as never,
        },
      ),
    ).rejects.toThrow("OTTO_VENDOR_PRIVACY_ACK");
    await expect(
      createDirectorRoomToken(
        {
          captureSessionId: "66666666-6666-5666-8666-666666666666",
          participantIdentity: "user-6",
          language: "en",
        },
        {
          env: {
            LIVEKIT_URL: "wss://otto.livekit.cloud",
            LIVEKIT_API_KEY: "key",
            LIVEKIT_API_SECRET: "secret",
            LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
            OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
            DATABASE_URL: "postgres://app:app@localhost:5432/otto",
            DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
            OTTO_USE_LIVEKIT_INFERENCE: true,
            OTTO_DIRECTOR_PREFLIGHT_STRICT: true,
            OTTO_VENDOR_PRIVACY_ACK: true,
            ANTHROPIC_API_KEY: "anthropic",
          } as never,
        },
      ),
    ).rejects.toThrow("OTTO_DEEPGRAM_NO_STORE_ACK");
  });

  test("node production forces strict voice privacy requirements even without explicit strict flag", async () => {
    await expect(
      createDirectorRoomToken(
        {
          captureSessionId: "99999999-9999-5999-8999-999999999999",
          participantIdentity: "user-9",
          language: "en",
        },
        {
          env: {
            NODE_ENV: "production",
            LIVEKIT_URL: "wss://otto.livekit.cloud",
            LIVEKIT_API_KEY: "key",
            LIVEKIT_API_SECRET: "secret",
            LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
            OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
            DATABASE_URL: "postgres://app:app@localhost:5432/otto",
            DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
            OTTO_USE_LIVEKIT_INFERENCE: true,
          } as never,
        },
      ),
    ).rejects.toThrow("OTTO_VENDOR_PRIVACY_ACK");
  });

  test("strict app room creation requires worker brain and direct audio provider credentials", async () => {
    await expect(
      createDirectorRoomToken(
        {
          captureSessionId: "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb",
          participantIdentity: "user-placeholder-strict",
          language: "en",
        },
        {
          env: {
            LIVEKIT_URL: "wss://otto.livekit.cloud",
            LIVEKIT_API_KEY: "key",
            LIVEKIT_API_SECRET: "secret",
            LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
            OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
            DATABASE_URL: "postgres://app:app@localhost:5432/otto",
            DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
            OTTO_USE_LIVEKIT_INFERENCE: false,
            OTTO_DIRECTOR_PREFLIGHT_STRICT: true,
            OTTO_VENDOR_PRIVACY_ACK: true,
            OTTO_DEEPGRAM_NO_STORE_ACK: true,
            OTTO_CARTESIA_NO_RETENTION_ACK: true,
            OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK: true,
            ANTHROPIC_API_KEY: "...",
          } as never,
          roomClientFactory: () => ({
            listRooms: vi.fn(async () => []),
            createRoom: vi.fn(async () => ({})),
            updateRoomMetadata: vi.fn(async () => ({})),
          }),
          dispatchClientFactory: () => ({
            listDispatch: vi.fn(async () => []),
            createDispatch: vi.fn(async () => ({ id: "dispatch-strict" })),
          }),
          mintToken: vi.fn(async () => "join-token"),
        },
      ),
    ).rejects.toThrow("ANTHROPIC_API_KEY");

    await expect(
      createDirectorRoomToken(
        {
          captureSessionId: "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb",
          participantIdentity: "user-placeholder-strict",
          language: "en",
        },
        {
          env: {
            LIVEKIT_URL: "wss://otto.livekit.cloud",
            LIVEKIT_API_KEY: "key",
            LIVEKIT_API_SECRET: "secret",
            LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
            OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
            DATABASE_URL: "postgres://app:app@localhost:5432/otto",
            DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
            OTTO_USE_LIVEKIT_INFERENCE: false,
            OTTO_DIRECTOR_PREFLIGHT_STRICT: true,
            OTTO_VENDOR_PRIVACY_ACK: true,
            OTTO_DEEPGRAM_NO_STORE_ACK: true,
            OTTO_CARTESIA_NO_RETENTION_ACK: true,
            OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK: true,
            ANTHROPIC_API_KEY: "anthropic",
          } as never,
          roomClientFactory: () => ({
            listRooms: vi.fn(async () => []),
            createRoom: vi.fn(async () => ({})),
            updateRoomMetadata: vi.fn(async () => ({})),
          }),
          dispatchClientFactory: () => ({
            listDispatch: vi.fn(async () => []),
            createDispatch: vi.fn(async () => ({ id: "dispatch-strict" })),
          }),
          mintToken: vi.fn(async () => "join-token"),
        },
      ),
    ).rejects.toThrow("DEEPGRAM_API_KEY");

    const room = await createDirectorRoomToken(
      {
        captureSessionId: "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb",
        participantIdentity: "user-placeholder-strict",
        language: "en",
      },
      {
        env: {
          LIVEKIT_URL: "wss://otto.livekit.cloud",
          LIVEKIT_API_KEY: "key",
          LIVEKIT_API_SECRET: "secret",
          LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
          OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
          DATABASE_URL: "postgres://app:app@localhost:5432/otto",
          DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
          OTTO_USE_LIVEKIT_INFERENCE: true,
          OTTO_DIRECTOR_PREFLIGHT_STRICT: true,
          OTTO_VENDOR_PRIVACY_ACK: true,
          OTTO_DEEPGRAM_NO_STORE_ACK: true,
          OTTO_CARTESIA_NO_RETENTION_ACK: true,
          OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK: true,
          ANTHROPIC_API_KEY: "anthropic",
        } as never,
        roomClientFactory: () => ({
          listRooms: vi.fn(async () => []),
          createRoom: vi.fn(async () => ({})),
          updateRoomMetadata: vi.fn(async () => ({})),
        }),
        dispatchClientFactory: () => ({
          listDispatch: vi.fn(async () => []),
          createDispatch: vi.fn(async () => ({ id: "dispatch-strict" })),
        }),
        mintToken: vi.fn(async () => "join-token"),
      },
    );

    expect(room.mode).toBe("livekit");
    expect(room.dispatchId).toBe("dispatch-strict");
  });

  test("creates room metadata, dispatches the configured agent, and returns a browser token", async () => {
    const createRoom = vi.fn(async () => ({}));
    const updateRoomMetadata = vi.fn(async () => ({}));
    const createDispatch = vi.fn(async () => ({ id: "dispatch-1" }));
    const mintToken = vi.fn(async () => "join-token");
    const room = await createDirectorRoomToken(
      {
        captureSessionId: "22222222-2222-5222-8222-222222222222",
        participantIdentity: "user-2",
        language: "es",
      },
      {
        env: {
          LIVEKIT_URL: "wss://otto.livekit.cloud",
          LIVEKIT_API_KEY: "key",
          LIVEKIT_API_SECRET: "secret",
          LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
          LIVEKIT_AGENT_NAME: "director-agent",
          OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
          DATABASE_URL: "postgres://app:app@localhost:5432/otto",
          DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
          OTTO_USE_LIVEKIT_INFERENCE: true,
        } as never,
        roomClientFactory: ({ liveKitUrl }) => {
          expect(liveKitUrl).toBe("wss://otto.livekit.cloud");
          return {
            listRooms: vi.fn(async () => []),
            createRoom,
            updateRoomMetadata,
          };
        },
        dispatchClientFactory: ({ liveKitUrl }) => {
          expect(liveKitUrl).toBe("wss://otto.livekit.cloud");
          return {
            listDispatch: vi.fn(async () => []),
            createDispatch,
          };
        },
        mintToken,
      },
    );

    const metadata = JSON.stringify({
      capture_session_id: "22222222-2222-5222-8222-222222222222",
      language: "es",
      agent_name: "director-agent",
      agent_participant_identity:
        "otto-director-agent-22222222-2222-5222-8222-222222222222",
      audio_recording_default: "off",
      egress_recording_default: "off",
      data_channel_logging: "not_logged_by_livekit",
      strict_voice_mode: false,
      vendor_privacy_ack: false,
      deepgram_no_store_ack: false,
      cartesia_no_retention_ack: false,
      anthropic_raw_logging_off_ack: false,
    });

    expect(room).toMatchObject({
      mode: "livekit",
      room: "director-22222222-2222-5222-8222-222222222222",
      url: "wss://otto.livekit.cloud",
      token: "join-token",
      tokenExpiresAt: expect.any(String),
      agentName: "director-agent",
      agentParticipantIdentity:
        "otto-director-agent-22222222-2222-5222-8222-222222222222",
      dispatchId: "dispatch-1",
    });
    expect(Date.parse(room.tokenExpiresAt ?? "")).toBeGreaterThan(Date.now());
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "director-22222222-2222-5222-8222-222222222222",
        metadata,
        emptyTimeout: 1800,
        departureTimeout: 300,
      }),
    );
    expect(updateRoomMetadata).not.toHaveBeenCalled();
    expect(createDispatch).toHaveBeenCalledWith(
      "director-22222222-2222-5222-8222-222222222222",
      "director-agent",
      expect.objectContaining({ metadata }),
    );
    expect(mintToken).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 60 * 60 }),
    );
  });

  test("browser token can only publish microphone audio and data", async () => {
    const room = await createDirectorRoomToken(
      {
        captureSessionId: "77777777-7777-5777-8777-777777777777",
        participantIdentity: "user-7",
        language: "en",
      },
      {
        env: {
          LIVEKIT_URL: "wss://otto.livekit.cloud",
          LIVEKIT_API_KEY: "key",
          LIVEKIT_API_SECRET: "secret",
          LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
          OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
          DATABASE_URL: "postgres://app:app@localhost:5432/otto",
          DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
          OTTO_USE_LIVEKIT_INFERENCE: true,
        } as never,
        roomClientFactory: () => ({
          listRooms: vi.fn(async () => []),
          createRoom: vi.fn(async () => ({})),
          updateRoomMetadata: vi.fn(async () => ({})),
        }),
        dispatchClientFactory: () => ({
          listDispatch: vi.fn(async () => []),
          createDispatch: vi.fn(async () => ({ id: "dispatch-7" })),
        }),
      },
    );

    const payload = decodeJwtPayload(room.token ?? "");

    expect(payload.video).toMatchObject({
      room: "director-77777777-7777-5777-8777-777777777777",
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    expect(payload.video.canPublishSources).toEqual(["microphone"]);
    expect(payload.video.canPublishSources).not.toContain("camera");
    expect(payload.video.canPublishSources).not.toContain("screen_share");
    expect(payload.video.canPublishSources).not.toContain("screen_share_audio");
    expect(Date.parse(room.tokenExpiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  test("updates stale room metadata and reuses an existing matching dispatch", async () => {
    const createRoom = vi.fn(async () => ({}));
    const updateRoomMetadata = vi.fn(async () => ({}));
    const createDispatch = vi.fn(async () => ({ id: "dispatch-new" }));
    const room = await createDirectorRoomToken(
      {
        captureSessionId: "33333333-3333-5333-8333-333333333333",
        participantIdentity: "user-3",
        language: "fr",
      },
      {
        env: {
          LIVEKIT_URL: "https://otto.livekit.cloud",
          LIVEKIT_API_KEY: "key",
          LIVEKIT_API_SECRET: "secret",
          LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
          OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
          DATABASE_URL: "postgres://app:app@localhost:5432/otto",
          DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
          OTTO_USE_LIVEKIT_INFERENCE: true,
        } as never,
        roomClientFactory: () => ({
          listRooms: vi.fn(async () => [{ metadata: "stale" }]),
          createRoom,
          updateRoomMetadata,
        }),
        dispatchClientFactory: () => ({
          listDispatch: vi.fn(async () => [
            {
              id: "dispatch-existing",
              agentName: "otto-director",
              metadata: JSON.stringify({
                capture_session_id: "33333333-3333-5333-8333-333333333333",
                language: "fr",
                agent_name: "otto-director",
                agent_participant_identity:
                  "otto-director-agent-33333333-3333-5333-8333-333333333333",
                audio_recording_default: "off",
                egress_recording_default: "off",
                data_channel_logging: "not_logged_by_livekit",
                strict_voice_mode: false,
                vendor_privacy_ack: false,
                deepgram_no_store_ack: false,
                cartesia_no_retention_ack: false,
                anthropic_raw_logging_off_ack: false,
              }),
            },
          ]),
          createDispatch,
        }),
        mintToken: vi.fn(async () => "join-token"),
      },
    );

    expect(room.dispatchId).toBe("dispatch-existing");
    expect(createRoom).not.toHaveBeenCalled();
    expect(updateRoomMetadata).toHaveBeenCalledOnce();
    expect(createDispatch).not.toHaveBeenCalled();
  });

  test("reuses an existing agent dispatch even when metadata is stale", async () => {
    const createDispatch = vi.fn(async () => ({ id: "dispatch-new" }));
    const room = await createDirectorRoomToken(
      {
        captureSessionId: "44444444-4444-5444-8444-444444444444",
        participantIdentity: "user-4",
        language: "en",
      },
      {
        env: {
          LIVEKIT_URL: "wss://otto.livekit.cloud",
          LIVEKIT_API_KEY: "key",
          LIVEKIT_API_SECRET: "secret",
          LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
          LIVEKIT_AGENT_NAME: "director-agent",
          OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
          DATABASE_URL: "postgres://app:app@localhost:5432/otto",
          DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
          OTTO_USE_LIVEKIT_INFERENCE: true,
        } as never,
        roomClientFactory: () => ({
          listRooms: vi.fn(async () => [{ metadata: "stale" }]),
          createRoom: vi.fn(async () => ({})),
          updateRoomMetadata: vi.fn(async () => ({})),
        }),
        dispatchClientFactory: () => ({
          listDispatch: vi.fn(async () => [
            {
              id: "dispatch-existing-stale",
              agentName: "director-agent",
              metadata: JSON.stringify({
                capture_session_id: "44444444-4444-5444-8444-444444444444",
                language: "fr",
                audio_recording_default: "off",
                egress_recording_default: "off",
                data_channel_logging: "not_logged_by_livekit",
                strict_voice_mode: false,
                vendor_privacy_ack: false,
                deepgram_no_store_ack: false,
                cartesia_no_retention_ack: false,
                anthropic_raw_logging_off_ack: false,
              }),
            },
          ]),
          createDispatch,
        }),
        mintToken: vi.fn(async () => "join-token"),
      },
    );

    expect(room.dispatchId).toBe("dispatch-existing-stale");
    expect(createDispatch).not.toHaveBeenCalled();
  });

  test("reuses existing director dispatch when agent name changes but capture matches", async () => {
    const createDispatch = vi.fn(async () => ({ id: "dispatch-new" }));
    const room = await createDirectorRoomToken(
      {
        captureSessionId: "55555555-5555-5555-8555-555555555555",
        participantIdentity: "user-5",
        language: "en",
      },
      {
        env: {
          LIVEKIT_URL: "wss://otto.livekit.cloud",
          LIVEKIT_API_KEY: "key",
          LIVEKIT_API_SECRET: "secret",
          LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
          LIVEKIT_AGENT_NAME: "renamed-director-agent",
          OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
          DATABASE_URL: "postgres://app:app@localhost:5432/otto",
          DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
          OTTO_USE_LIVEKIT_INFERENCE: true,
        } as never,
        roomClientFactory: () => ({
          listRooms: vi.fn(async () => [{ metadata: "stale" }]),
          createRoom: vi.fn(async () => ({})),
          updateRoomMetadata: vi.fn(async () => ({})),
        }),
        dispatchClientFactory: () => ({
          listDispatch: vi.fn(async () => [
            {
              id: "dispatch-existing-renamed",
              agentName: "otto-director",
              metadata: JSON.stringify({
                capture_session_id: "55555555-5555-5555-8555-555555555555",
                language: "en",
              }),
            },
          ]),
          createDispatch,
        }),
        mintToken: vi.fn(async () => "join-token"),
      },
    );

    expect(room.dispatchId).toBe("dispatch-existing-renamed");
    expect(createDispatch).not.toHaveBeenCalled();
  });

  test("creates a fresh dispatch when the matching agent job has already ended", async () => {
    const createDispatch = vi.fn(async () => ({ id: "dispatch-retry" }));
    const room = await createDirectorRoomToken(
      {
        captureSessionId: "66666666-6666-5666-8666-666666666666",
        participantIdentity: "user-6",
        language: "en",
      },
      {
        env: {
          LIVEKIT_URL: "wss://otto.livekit.cloud",
          LIVEKIT_API_KEY: "key",
          LIVEKIT_API_SECRET: "secret",
          LIVEKIT_AGENT_SERVICE_TOKEN: "service-token",
          LIVEKIT_AGENT_NAME: "director-agent",
          OTTO_INTERNAL_API_BASE_URL: "https://otto.example.com",
          DATABASE_URL: "postgres://app:app@localhost:5432/otto",
          DATABASE_SERVICE_URL: "postgres://service:service@localhost:5432/otto",
          OTTO_USE_LIVEKIT_INFERENCE: true,
        } as never,
        roomClientFactory: () => ({
          listRooms: vi.fn(async () => [{ metadata: "current" }]),
          createRoom: vi.fn(async () => ({})),
          updateRoomMetadata: vi.fn(async () => ({})),
        }),
        dispatchClientFactory: () => ({
          listDispatch: vi.fn(async () => [
            {
              id: "dispatch-ended",
              agentName: "director-agent",
              metadata: JSON.stringify({
                capture_session_id: "66666666-6666-5666-8666-666666666666",
              }),
              state: {
                jobs: [
                  {
                    state: {
                      endedAt: BigInt("1779824761946936964"),
                    },
                  },
                ],
              },
            },
          ]),
          createDispatch,
        }),
        mintToken: vi.fn(async () => "join-token"),
      },
    );

    expect(room.dispatchId).toBe("dispatch-retry");
    expect(createDispatch).toHaveBeenCalledOnce();
  });

  test("normalizes websocket URLs to LiveKit API hosts", () => {
    expect(liveKitApiHost("wss://otto.livekit.cloud")).toBe(
      "https://otto.livekit.cloud",
    );
    expect(liveKitApiHost("ws://localhost:7880")).toBe("http://localhost:7880");
    expect(liveKitApiHost("https://otto.livekit.cloud")).toBe(
      "https://otto.livekit.cloud",
    );
  });
});

function decodeJwtPayload(token: string) {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}
