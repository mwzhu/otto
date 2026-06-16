import "server-only";

import {
  AccessToken,
  AgentDispatchClient,
  EgressClient,
  EncodedFileOutput,
  JobRestartPolicy,
  RoomServiceClient,
  S3Upload,
  TrackSource,
  WebhookConfig,
  WebhookReceiver,
} from "livekit-server-sdk";
import { getServerEnv } from "@/lib/env";
import { artifactStorageKey, r2S3UploadConfig } from "@/lib/adapters/storage";

const DEFAULT_DIRECTOR_AGENT_NAME = "otto-director";
const DEFAULT_OPERATOR_AGENT_NAME = "otto-operator";
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

type LiveKitEgressDeps = {
  env?: LiveKitEnv;
  egressClientFactory?: (input: LiveKitClientInput) => EgressClientLike;
};

type EgressClientLike = {
  startTrackCompositeEgress: (
    roomName: string,
    output: unknown,
    opts: {
      audioTrackId?: string;
      videoTrackId?: string;
      webhooks?: WebhookConfig[];
    },
  ) => Promise<{ egressId?: string; status?: unknown; fileResults?: unknown[] }>;
  stopEgress: (egressId: string) => Promise<unknown>;
  listEgress: (options?: { roomName?: string; egressId?: string; active?: boolean }) => Promise<unknown[]>;
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

export type OperatorRoomToken = DirectorRoomToken & {
  captureMode: "operator_voice" | "operator_screenshare";
};

export type OperatorTrackEgressResult = {
  mode: "disabled" | "started";
  roomName: string;
  egressId: string | null;
  storageKey: string | null;
  provider: "livekit-track-composite";
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

export class OperatorVoiceConfigurationError extends Error {
  constructor(
    public readonly missing: string[],
    message = `LiveKit operator voice is not fully configured (${missing.join(", ")} missing).`,
  ) {
    super(message);
    this.name = "OperatorVoiceConfigurationError";
  }
}

export function directorVoiceReadiness(
  env: LiveKitEnv = getServerEnv(),
): DirectorVoiceReadiness {
  const strictVoiceMode = isStrictDirectorVoiceMode(env);
  const missing = requiredLiveKitVoiceEnv(env, strictVoiceMode);
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

export function operatorVoiceReadiness(
  env: LiveKitEnv = getServerEnv(),
): DirectorVoiceReadiness {
  const strictVoiceMode = isStrictOperatorVoiceMode(env);
  const missing = requiredLiveKitVoiceEnv(env, strictVoiceMode);
  if (missing.length === 0) {
    return {
      mode: "livekit",
      requiresMicrophone: true,
      missing: [],
      reason: null,
    };
  }
  if (strictVoiceMode) {
    return {
      mode: "unconfigured",
      requiresMicrophone: false,
      missing,
      reason: `Strict operator voice mode is enabled, but LiveKit voice is not fully configured (${missing.join(", ")} missing).`,
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

export async function createOperatorRoomToken(input: {
  captureSessionId: string;
  processId: string;
  captureMode: "operator_voice" | "operator_screenshare";
  participantIdentity: string;
  language: string;
}, deps: LiveKitRoomDeps = {}): Promise<OperatorRoomToken> {
  const env = deps.env ?? getServerEnv();
  const room = `operator-${input.captureSessionId}`;
  const readiness = operatorVoiceReadiness(env);
  if (readiness.mode !== "livekit") {
    if (readiness.mode === "unconfigured") {
      throw new OperatorVoiceConfigurationError(
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
      captureMode: input.captureMode,
      reason: readiness.reason ?? undefined,
    };
  }

  const agentName =
    env.LIVEKIT_OPERATOR_AGENT_NAME ??
    env.LIVEKIT_AGENT_NAME ??
    DEFAULT_OPERATOR_AGENT_NAME;
  const agentParticipantIdentity = operatorAgentParticipantIdentity(
    input.captureSessionId,
  );
  const roomMetadata = JSON.stringify({
    capture_session_id: input.captureSessionId,
    process_id: input.processId,
    capture_mode: input.captureMode,
    language: input.language,
    agent_name: agentName,
    agent_participant_identity: agentParticipantIdentity,
    audio_recording_default: "off",
    egress_recording_default: "off",
    data_channel_logging: "not_logged_by_livekit",
    screen_share_expected: input.captureMode === "operator_screenshare",
    strict_voice_mode: isStrictOperatorVoiceMode(env),
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
  const dispatchId = await ensureAgentDispatch({
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
        role: "operator",
        capture_session_id: input.captureSessionId,
        process_id: input.processId,
        capture_mode: input.captureMode,
      }),
      ttlSeconds: DIRECTOR_BROWSER_TOKEN_TTL_SECONDS,
      canPublishSources:
        input.captureMode === "operator_screenshare"
          ? [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE]
          : [TrackSource.MICROPHONE],
    }),
    tokenExpiresAt,
    agentName,
    agentParticipantIdentity,
    dispatchId,
    captureMode: input.captureMode,
  };
}

export function operatorEgressReadiness(env: LiveKitEnv = getServerEnv()) {
  const missing = requiredOperatorEgressEnv(env);
  if (env.OTTO_OPERATOR_EGRESS_ENABLED !== true) {
    return {
      mode: "disabled" as const,
      missing,
      reason: "Operator Egress is disabled.",
    };
  }
  if (missing.length > 0) {
    return {
      mode: "unconfigured" as const,
      missing,
      reason: `Operator Egress is not fully configured (${missing.join(", ")} missing).`,
    };
  }
  return { mode: "livekit" as const, missing: [], reason: null };
}

export async function startOperatorTrackEgress(input: {
  roomName: string;
  screenTrackSid: string;
  audioTrackSid?: string | null;
  captureSessionId: string;
  orgId: string;
  workspaceId: string;
  filename?: string;
}, deps: LiveKitEgressDeps = {}): Promise<OperatorTrackEgressResult> {
  const env = deps.env ?? getServerEnv();
  const readiness = operatorEgressReadiness(env);
  if (readiness.mode !== "livekit") {
    return {
      mode: "disabled",
      roomName: input.roomName,
      egressId: null,
      storageKey: null,
      provider: "livekit-track-composite",
      reason: readiness.reason ?? undefined,
    };
  }
  const artifactId = input.captureSessionId;
  const filename = input.filename ?? `operator-capture-${input.captureSessionId}.mp4`;
  const storageKey = artifactStorageKey({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    artifactId,
    filename,
  });
  const s3 = r2S3UploadConfig();
  if (!s3) {
    return {
      mode: "disabled",
      roomName: input.roomName,
      egressId: null,
      storageKey: null,
      provider: "livekit-track-composite",
      reason: "R2 storage is required for LiveKit Egress output.",
    };
  }
  const output = new EncodedFileOutput({
    filepath: storageKey,
    output: {
      case: "s3",
      value: new S3Upload(s3),
    },
  });
  const client =
    deps.egressClientFactory?.({
      liveKitUrl: env.LIVEKIT_URL!,
      apiKey: env.LIVEKIT_API_KEY!,
      apiSecret: env.LIVEKIT_API_SECRET!,
    }) ??
    new EgressClient(
      liveKitApiHost(env.LIVEKIT_URL!),
      env.LIVEKIT_API_KEY!,
      env.LIVEKIT_API_SECRET!,
      { requestTimeout: 5000 },
    );
  const egress = await client.startTrackCompositeEgress(input.roomName, output, {
    videoTrackId: input.screenTrackSid,
    audioTrackId: input.audioTrackSid ?? undefined,
    webhooks: operatorEgressWebhooks(env),
  });
  return {
    mode: "started",
    roomName: input.roomName,
    egressId: egress.egressId ?? null,
    storageKey,
    provider: "livekit-track-composite",
  };
}

function operatorEgressWebhooks(env: LiveKitEnv) {
  const baseUrl = configuredEnvValue(env.OTTO_INTERNAL_API_BASE_URL)
    ? env.OTTO_INTERNAL_API_BASE_URL!.replace(/\/$/, "")
    : null;
  if (!baseUrl || !configuredEnvValue(env.LIVEKIT_API_SECRET)) return undefined;
  return [
    new WebhookConfig({
      url: `${baseUrl}/api/internal/livekit/webhook`,
      signingKey: env.LIVEKIT_API_SECRET!,
    }),
  ];
}

export async function stopOperatorTrackEgress(
  egressId: string,
  deps: LiveKitEgressDeps = {},
) {
  const env = deps.env ?? getServerEnv();
  const client =
    deps.egressClientFactory?.({
      liveKitUrl: env.LIVEKIT_URL!,
      apiKey: env.LIVEKIT_API_KEY!,
      apiSecret: env.LIVEKIT_API_SECRET!,
    }) ??
    new EgressClient(
      liveKitApiHost(env.LIVEKIT_URL!),
      env.LIVEKIT_API_KEY!,
      env.LIVEKIT_API_SECRET!,
      { requestTimeout: 5000 },
    );
  return client.stopEgress(egressId);
}

export async function getOperatorTrackEgressStatus(
  egressId: string,
  deps: LiveKitEgressDeps = {},
) {
  const env = deps.env ?? getServerEnv();
  const client =
    deps.egressClientFactory?.({
      liveKitUrl: env.LIVEKIT_URL!,
      apiKey: env.LIVEKIT_API_KEY!,
      apiSecret: env.LIVEKIT_API_SECRET!,
    }) ??
    new EgressClient(
      liveKitApiHost(env.LIVEKIT_URL!),
      env.LIVEKIT_API_KEY!,
      env.LIVEKIT_API_SECRET!,
      { requestTimeout: 5000 },
    );
  const rows = await client.listEgress({ egressId });
  return rows[0] ?? null;
}

export async function receiveLiveKitWebhook(request: Request) {
  const env = getServerEnv();
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new Error("LiveKit webhook verification requires LiveKit API credentials.");
  }
  const body = await request.text();
  const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  return receiver.receive(
    body,
    request.headers.get("Authorization") ??
      request.headers.get("authorization") ??
      undefined,
  );
}

export function directorAgentParticipantIdentity(captureSessionId: string) {
  return `otto-director-agent-${captureSessionId}`;
}

export function operatorAgentParticipantIdentity(captureSessionId: string) {
  return `otto-operator-agent-${captureSessionId}`;
}

function requiredLiveKitVoiceEnv(
  env: ReturnType<typeof getServerEnv>,
  strictVoiceMode: boolean,
): string[] {
  const missing: string[] = [];
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

function requiredOperatorEgressEnv(env: ReturnType<typeof getServerEnv>) {
  const missing: string[] = [];
  for (const [key, value] of [
    ["LIVEKIT_URL", env.LIVEKIT_URL],
    ["LIVEKIT_API_KEY", env.LIVEKIT_API_KEY],
    ["LIVEKIT_API_SECRET", env.LIVEKIT_API_SECRET],
    ["R2_ACCOUNT_ID", env.R2_ACCOUNT_ID],
    ["R2_ACCESS_KEY_ID", env.R2_ACCESS_KEY_ID],
    ["R2_SECRET_ACCESS_KEY", env.R2_SECRET_ACCESS_KEY],
    ["R2_BUCKET", env.R2_BUCKET],
    ["R2_PUBLIC_BASE_URL", env.R2_PUBLIC_BASE_URL],
  ] as const) {
    if (!configuredEnvValue(value)) missing.push(key);
  }
  return missing;
}

function isStrictDirectorVoiceMode(env: ReturnType<typeof getServerEnv>) {
  return (
    env.OTTO_DIRECTOR_PREFLIGHT_STRICT === true ||
    env.NODE_ENV === "production"
  );
}

function isStrictOperatorVoiceMode(env: ReturnType<typeof getServerEnv>) {
  return (
    env.OTTO_OPERATOR_PREFLIGHT_STRICT === true ||
    env.NODE_ENV === "production"
  );
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
  return ensureAgentDispatch(input);
}

async function ensureAgentDispatch(input: {
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
  if (typeof value === "bigint") return value !== BigInt(0);
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
  canPublishSources?: TrackSource[];
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
    canPublishSources: input.canPublishSources ?? [TrackSource.MICROPHONE],
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
