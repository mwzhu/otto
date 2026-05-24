import "server-only";

import { createHmac } from "node:crypto";
import { getServerEnv } from "@/lib/env";

export type DirectorRoomToken = {
  mode: "simulated" | "livekit";
  room: string;
  token: string | null;
  reason?: string;
};

export async function createDirectorRoomToken(input: {
  captureSessionId: string;
  participantIdentity: string;
}): Promise<DirectorRoomToken> {
  const env = getServerEnv();
  const room = `director-${input.captureSessionId}`;
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return {
      mode: "simulated",
      room,
      token: null,
      reason: "LiveKit is not configured; using transcript simulation mode.",
    };
  }

  return {
    mode: "livekit",
    room,
    token: mintLiveKitJwt({
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      room,
      participantIdentity: input.participantIdentity,
    }),
  };
}

function mintLiveKitJwt(input: {
  apiKey: string;
  apiSecret: string;
  room: string;
  participantIdentity: string;
}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: input.apiKey,
    sub: input.participantIdentity,
    nbf: nowSeconds - 10,
    exp: nowSeconds + 60 * 60,
    video: {
      room: input.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  };
  const body = `${base64url(header)}.${base64url(payload)}`;
  const signature = createHmac("sha256", input.apiSecret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function base64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
