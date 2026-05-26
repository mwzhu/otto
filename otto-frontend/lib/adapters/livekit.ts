import "server-only";

import {
  AccessToken,
  AgentDispatchClient,
  JobRestartPolicy,
  RoomServiceClient,
  TrackSource,
} from "livekit-server-sdk";
import { getServerEnv } from "@/lib/env";

const DEFAULT_DIRECTOR_AGENT_NAME = "otto-director";
const DIRECTOR_BROWSER_TOKEN_TTL_SECONDS = 60 * 60;
const STRICT_VENDOR_PRIVACY_ACKS = [
  "OTTO_VENDOR_PRIVACY_ACK",
  "OTTO_DEEPGRAM_NO_STORE_ACK",
  "OTTO_CARTESIA_NO_RETENTION_ACK",
  "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK",
] as const;

type LiveKitEnv = ReturnType<typeof getServerEnv>;

type RoomClientLike = {
  listRooms: (names?: string[]) => Promise<Array<{ metadata?: string }>>;
  createRoom: (options: {
    name: string;
    emptyTimeout: number;
    departureTimeout: number;
    maxParticipants: number;
    metadata: string;
  }) => Promise<unknown>;
  updateRoomMetadata: (room: string, metadata: string) => Promise<unknown>;
};

type DispatchClientLike = {
  listDispatch: (
    room: string,
  ) => Promise<Array<LiveKitDispatchLike>>;
  createDispatch: (
    room: string,
    agentName: string,
    options: { metadata: string; restartPolicy: JobRestartPolicy },
  ) => Promise<{ id?: string }>;
};

type LiveKitDispatchLike = {
  id?: string;
  agentName?: string;
  metadata?: string;
  state?: {
    jobs?: Array<{
      state?: {
        endedAt?: unknown;
      };
    }>;
  };
};

type LiveKitRoomDeps = {
  env?: LiveKitEnv;
  roomClientFactory?: (input: LiveKitClientInput) => RoomClientLike;
  dispatchClientFactory?: (input: LiveKitClientInput) => DispatchClientLike;
  mintToken?: typeof mintLiveKitJwt;
};

type LiveKitClientInput = {
  liveKitUrl: string;
  apiKey: string;
  apiSecret: string;
};

export type DirectorRoomToken = {
  mode: "simulated" | "livekit";
  room: string;
  url: string | null;
  token: string | null;
  tokenExpiresAt: string | null;
  agentName?: string;
  agentParticipantIdentity?: string;
  dispatchId?: string;
  reason?: string;
};

export type DirectorVoiceReadiness = {
  mode: "simulated" | "livekit" | "unconfigured";
  requiresMicrophone: boolean;
  missing: string[];
  reason: string | null;
};

export class DirectorVoiceConfigurationError extends Error {
  constructor(
    public readonly missing: string[],
    message = `LiveKit voice is not fully configured (${missing.join(", ")} missing).`,
  ) {
    super(message);
    this.name = "DirectorVoiceConfigurationError";
  }
}

export function directorVoiceReadiness(
  env: LiveKitEnv = getServerEnv(),
): DirectorVoiceReadiness {
  const missing = requiredLiveKitVoiceEnv(env);
  if (missing.length === 0) {
    return {
      mode: "livekit",
      requiresMicrophone: true,
      missing: [],
      reason: null,
    };
  }
  if (isStrictDirectorVoiceMode(env)) {
    return {
      mode: "unconfigured",
      requiresMicrophone: false,
      missing,
      reason: `Strict director voice mode is enabled, but LiveKit voice is not fully configured (${missing.join(", ")} missing).`,
    };
  }
  return {
    mode: "simulated",
    requiresMicrophone: false,
    missing,
    reason: `LiveKit voice is not fully configured (${missing.join(", ")} missing); using transcript simulation mode.`,
  };
}

export async function createDirectorRoomToken(input: {
  captureSessionId: string;
  participantIdentity: string;
  language: string;
}, deps: LiveKitRoomDeps = {}): Promise<DirectorRoomToken> {
  const env = deps.env ?? getServerEnv();
  const room = `director-${input.captureSessionId}`;
  const readiness = directorVoiceReadiness(env);
  if (readiness.mode !== "livekit") {
    if (readiness.mode === "unconfigured") {
      throw new DirectorVoiceConfigurationError(
        readiness.missing,
        readiness.reason ?? undefined,
      );
    }
    return {
      mode: "simulated",
      room,
      url: null,
      token: null,
      tokenExpiresAt: null,
      reason: readiness.reason ?? undefined,
    };
  }

  const agentName = env.LIVEKIT_AGENT_NAME ?? DEFAULT_DIRECTOR_AGENT_NAME;
  const agentParticipantIdentity = directorAgentParticipantIdentity(
    input.captureSessionId,
  );
  const roomMetadata = JSON.stringify({
    capture_session_id: input.captureSessionId,
    language: input.language,
    agent_name: agentName,
    agent_participant_identity: agentParticipantIdentity,
    audio_recording_default: "off",
    egress_recording_default: "off",
    data_channel_logging: "not_logged_by_livekit",
    strict_voice_mode: isStrictDirectorVoiceMode(env),
    vendor_privacy_ack: env.OTTO_VENDOR_PRIVACY_ACK === true,
    deepgram_no_store_ack: env.OTTO_DEEPGRAM_NO_STORE_ACK === true,
    cartesia_no_retention_ack: env.OTTO_CARTESIA_NO_RETENTION_ACK === true,
    anthropic_raw_logging_off_ack:
      env.OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK === true,
  });
  await ensureLiveKitRoom({
    liveKitUrl: env.LIVEKIT_URL!,
    apiKey: env.LIVEKIT_API_KEY!,
    apiSecret: env.LIVEKIT_API_SECRET!,
    room,
    metadata: roomMetadata,
    roomClientFactory: deps.roomClientFactory,
  });
  const dispatchId = await ensureDirectorAgentDispatch({
    liveKitUrl: env.LIVEKIT_URL!,
    apiKey: env.LIVEKIT_API_KEY!,
    apiSecret: env.LIVEKIT_API_SECRET!,
    room,
    agentName,
    metadata: roomMetadata,
    dispatchClientFactory: deps.dispatchClientFactory,
  });

  const tokenExpiresAt = new Date(
    Date.now() + DIRECTOR_BROWSER_TOKEN_TTL_SECONDS * 1000,
  ).toISOString();
  return {
    mode: "livekit",
    room,
    url: env.LIVEKIT_URL!,
    token: await (deps.mintToken ?? mintLiveKitJwt)({
      apiKey: env.LIVEKIT_API_KEY!,
      apiSecret: env.LIVEKIT_API_SECRET!,
      room,
      participantIdentity: input.participantIdentity,
      metadata: JSON.stringify({
        role: "director",
        capture_session_id: input.captureSessionId,
      }),
      ttlSeconds: DIRECTOR_BROWSER_TOKEN_TTL_SECONDS,
    }),
    tokenExpiresAt,
    agentName,
    agentParticipantIdentity,
    dispatchId,
  };
}

export function directorAgentParticipantIdentity(captureSessionId: string) {
  return `otto-director-agent-${captureSessionId}`;
}

function requiredLiveKitVoiceEnv(env: ReturnType<typeof getServerEnv>): string[] {
  const missing: string[] = [];
  const strictVoiceMode = isStrictDirectorVoiceMode(env);
  for (const [key, value] of [
    ["LIVEKIT_URL", env.LIVEKIT_URL],
    ["LIVEKIT_API_KEY", env.LIVEKIT_API_KEY],
    ["LIVEKIT_API_SECRET", env.LIVEKIT_API_SECRET],
    ["LIVEKIT_AGENT_SERVICE_TOKEN", env.LIVEKIT_AGENT_SERVICE_TOKEN],
    ["OTTO_INTERNAL_API_BASE_URL", env.OTTO_INTERNAL_API_BASE_URL],
    ["DATABASE_URL", env.DATABASE_URL],
    ["DATABASE_SERVICE_URL", env.DATABASE_SERVICE_URL],
  ] as const) {
    if (!configuredEnvValue(value)) missing.push(key);
  }
  if (strictVoiceMode) {
    for (const key of STRICT_VENDOR_PRIVACY_ACKS) {
      if (env[key] !== true) missing.push(key);
    }
    if (!configuredEnvValue(env.ANTHROPIC_API_KEY)) {
      missing.push("ANTHROPIC_API_KEY");
    }
    if (normalizedPlannerRuntime(env) === "next") {
      missing.push("OTTO_DIRECTOR_PLANNER_RUNTIME=python");
    }
  }
  if (env.OTTO_USE_LIVEKIT_INFERENCE !== true) {
    for (const [key, value] of [
      ["DEEPGRAM_API_KEY", env.DEEPGRAM_API_KEY],
      ["CARTESIA_API_KEY", env.CARTESIA_API_KEY],
    ] as const) {
      if (!configuredEnvValue(value)) missing.push(key);
    }
  }
  return missing;
}

function isStrictDirectorVoiceMode(env: ReturnType<typeof getServerEnv>) {
  return (
    env.OTTO_DIRECTOR_PREFLIGHT_STRICT === true ||
    env.NODE_ENV === "production"
  );
}

function normalizedPlannerRuntime(env: ReturnType<typeof getServerEnv>) {
  const value = env.OTTO_DIRECTOR_PLANNER_RUNTIME;
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

function configuredEnvValue(value: unknown) {
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

async function ensureLiveKitRoom(input: {
  liveKitUrl: string;
  apiKey: string;
  apiSecret: string;
  room: string;
  metadata: string;
  roomClientFactory?: LiveKitRoomDeps["roomClientFactory"];
}) {
  const client =
    input.roomClientFactory?.(input) ??
    new RoomServiceClient(
      liveKitApiHost(input.liveKitUrl),
      input.apiKey,
      input.apiSecret,
      { requestTimeout: 5000 },
    );
  const existing = await client.listRooms([input.room]);
  if (existing.length === 0) {
    await client.createRoom({
      name: input.room,
      emptyTimeout: 30 * 60,
      departureTimeout: 5 * 60,
      maxParticipants: 6,
      metadata: input.metadata,
    });
    return;
  }
  if (existing[0]?.metadata !== input.metadata) {
    await client.updateRoomMetadata(input.room, input.metadata);
  }
}

async function ensureDirectorAgentDispatch(input: {
  liveKitUrl: string;
  apiKey: string;
  apiSecret: string;
  room: string;
  agentName: string;
  metadata: string;
  dispatchClientFactory?: LiveKitRoomDeps["dispatchClientFactory"];
}) {
  const client =
    input.dispatchClientFactory?.(input) ??
    new AgentDispatchClient(
      liveKitApiHost(input.liveKitUrl),
      input.apiKey,
      input.apiSecret,
      { requestTimeout: 5000 },
    );
  const existing = await client.listDispatch(input.room);
  const active = existing.find(
    (dispatch) =>
      dispatch.id &&
      dispatchHasReusableJob(dispatch) &&
      (dispatch.agentName === input.agentName ||
        dispatchCaptureSessionId(dispatch.metadata) ===
          dispatchCaptureSessionId(input.metadata)),
  );
  if (active?.id) return active.id;
  const created = await client.createDispatch(input.room, input.agentName, {
    metadata: input.metadata,
    restartPolicy: JobRestartPolicy.JRP_ON_FAILURE,
  });
  return created.id;
}

function dispatchHasReusableJob(dispatch: LiveKitDispatchLike) {
  const jobs = dispatch.state?.jobs;
  if (!jobs?.length) return true;
  return jobs.some((job) => !hasEndedAt(job.state?.endedAt));
}

function hasEndedAt(value: unknown) {
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.trim() !== "" && value !== "0";
  return Boolean(value);
}

function dispatchCaptureSessionId(metadata: string | undefined) {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { capture_session_id?: unknown };
    return typeof parsed.capture_session_id === "string"
      ? parsed.capture_session_id
      : null;
  } catch {
    return null;
  }
}

async function mintLiveKitJwt(input: {
  apiKey: string;
  apiSecret: string;
  room: string;
  participantIdentity: string;
  metadata: string;
  ttlSeconds: number;
}) {
  const token = new AccessToken(input.apiKey, input.apiSecret, {
    identity: input.participantIdentity,
    metadata: input.metadata,
    ttl: input.ttlSeconds,
  });
  token.addGrant({
    room: input.room,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: true,
  });
  return token.toJwt();
}

export function liveKitApiHost(liveKitUrl: string) {
  if (liveKitUrl.startsWith("wss://")) return `https://${liveKitUrl.slice(6)}`;
  if (liveKitUrl.startsWith("ws://")) return `http://${liveKitUrl.slice(5)}`;
  return liveKitUrl;
}
