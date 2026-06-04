"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useRouter } from "next/navigation";
import { Mic, Pause, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { CaptureConversationMessage } from "@/components/capture/ConversationPanel";
import {
  appendCaptureMessage,
  captureMessageFromDataEvent,
} from "@/components/capture/operatorConversationEvents";
import {
  OPERATOR_SESSION_KEY,
} from "@/app/process/[id]/capture/voice/OperatorVoicePreStartClient";

type OperatorSession = {
  workspaceId: string;
  processId: string;
  captureSessionId: string;
  language: string;
  mode: "operator_voice";
  startedAt: string;
  liveKit?: {
    mode: "simulated" | "livekit";
    room: string;
    url: string | null;
    token: string | null;
    tokenExpiresAt: string | null;
    agentParticipantIdentity?: string;
    reason?: string;
  };
};

type LiveKitTrack = MediaStreamTrack & {
  stop?: () => void;
  attach?: () => HTMLMediaElement;
  detach?: () => HTMLMediaElement[];
};

type LiveKitRoomLike = {
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => void;
  localParticipant: {
    setMicrophoneEnabled?: (enabled: boolean) => Promise<void>;
    publishTrack?: (track: MediaStreamTrack | LiveKitTrack) => Promise<unknown>;
    publishData?: (
      payload: Uint8Array,
      options?: { reliable?: boolean; topic?: string },
    ) => Promise<void>;
  };
  on: (event: string, handler: (...args: unknown[]) => void) => LiveKitRoomLike;
};

type LiveKitClientModule = {
  Room: new (options?: Record<string, unknown>) => LiveKitRoomLike;
  RoomEvent: Record<string, string>;
  createLocalAudioTrack?: () => Promise<LiveKitTrack>;
};

export function OperatorVoiceLiveClient({
  processId,
}: {
  processId: string;
}) {
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [completing, setCompleting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [turnWaitMessage, setTurnWaitMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<CaptureConversationMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const roomRef = useRef<LiveKitRoomLike | null>(null);
  const micTrackRef = useRef<LiveKitTrack | null>(null);
  const audioElsRef = useRef<HTMLMediaElement[]>([]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const raw = window.localStorage.getItem(OPERATOR_SESSION_KEY);
      if (!raw || cancelled) return;
      try {
        const parsed = JSON.parse(raw) as OperatorSession;
        if (!cancelled && parsed.processId === processId) setSession(parsed);
      } catch {
        window.localStorage.removeItem(OPERATOR_SESSION_KEY);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [processId]);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [paused]);

  useEffect(() => {
    if (session?.liveKit?.mode !== "livekit") return;
    let cancelled = false;
    void connectOperatorVoiceRoom({
      session,
      roomRef,
      micTrackRef,
      audioElsRef,
      onEvent: (message) => {
        if (!cancelled) {
          setMessages((current) => appendCaptureMessage(current, message));
        }
      },
      onError: (message) => {
        if (!cancelled) setError(message);
      },
    });
    return () => {
      cancelled = true;
      disconnectOperatorVoiceRoom(roomRef, micTrackRef, audioElsRef);
    };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    void sendLiveKitOperatorControl(
      roomRef.current,
      paused ? "pause" : "resume",
      session.captureSessionId,
    );
  }, [paused, session]);

  return (
    <main className="mx-auto flex w-full max-w-[960px] flex-1 flex-col px-8 py-10">
      <section className="rounded-lg border border-subtle bg-surface px-8 py-8 shadow-card">
        <div className="flex items-start justify-between gap-6">
          <div className="flex items-start gap-4">
            <div className="grid size-12 place-items-center rounded-lg bg-muted text-ink">
              <Mic size={22} aria-hidden />
            </div>
            <div>
              <h1 className="text-[20px] font-semibold tracking-tight text-ink">
                Operator voice interview
              </h1>
              <p className="mt-1 max-w-[540px] text-[12.5px] leading-relaxed text-ink-secondary">
                The operator capture is registered with the shared voice
                runtime. If LiveKit is not configured, this page keeps the
                typed fallback available.
              </p>
            </div>
          </div>
          <div className="font-mono text-[13px] tabular-nums text-ink-secondary">
            {formatTime(elapsed)}
          </div>
        </div>

        <div className="mt-8 rounded-md border border-subtle bg-canvas px-4 py-3 text-[12.5px] text-ink-secondary">
          {session ? (
            <div className="space-y-1">
              <div>
                Capture session{" "}
                <span className="font-mono text-ink">
                  {session.captureSessionId}
                </span>
              </div>
              <div>Language: {session.language}</div>
              <div>
                Voice runtime:{" "}
                <span className="font-mono text-ink">
                  {session.liveKit?.mode ?? "pending"}
                </span>
              </div>
              {session.liveKit?.room && <div>Room: {session.liveKit.room}</div>}
              {session.liveKit?.reason && (
                <div className="max-w-[560px] text-ink-muted">
                  {session.liveKit.reason}
                </div>
              )}
            </div>
          ) : (
            "No local operator session was found. Start from the voice capture setup screen to create a capture session."
          )}
        </div>

        <section className="mt-6 overflow-hidden rounded-lg border border-subtle bg-canvas">
          <div className="max-h-[320px] min-h-[220px] space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="grid min-h-[180px] place-items-center text-center text-[12.5px] leading-relaxed text-ink-muted">
                <div>
                  <div className="font-medium text-ink-secondary">
                    Typed fallback is ready
                  </div>
                  <div className="mt-1 max-w-[420px]">
                    Describe the operator step as if you were speaking. The
                    response will persist transcript evidence and provisional
                    steps for synthesis.
                  </div>
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    message.speaker === "operator"
                      ? "ml-auto max-w-[72%] rounded-md bg-ink px-3 py-2 text-[12.5px] leading-relaxed text-canvas"
                      : message.speaker === "agent"
                        ? "mr-auto max-w-[72%] rounded-md border border-subtle bg-surface px-3 py-2 text-[12.5px] leading-relaxed text-ink-secondary"
                        : "mx-auto max-w-[78%] rounded-md border border-subtle bg-muted px-3 py-2 text-center text-[12px] leading-relaxed text-ink-muted"
                  }
                >
                  {message.text}
                </div>
              ))
            )}
          </div>
          <form
            className="flex gap-2 border-t border-subtle bg-surface p-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!session || !draft.trim() || submitting || paused) return;
              const text = draft.trim();
              setSubmitting(true);
              setDraft("");
              setError(null);
              setTurnWaitMessage(null);
              const waitTimer = window.setTimeout(() => {
                setTurnWaitMessage(
                  "Operator notes are still updating. Your step is saved locally and Otto will continue once the turn response returns.",
                );
              }, 6000);
              setMessages((current) => [
                ...current,
                {
                  id: `operator-${Date.now()}`,
                  speaker: "operator",
                  text,
                  timestamp: new Date().toISOString(),
                },
              ]);
              try {
                const response = await postOperatorTurn(session, text);
                setMessages((current) => [
                  ...current,
                  {
                    id: `agent-${Date.now()}`,
                    speaker: "agent",
                    text: response.planned_agent_utterance,
                    timestamp: new Date().toISOString(),
                  },
                ]);
              } catch (err) {
                setError(
                  err instanceof Error
                    ? err.message
                    : "Could not submit operator turn.",
                );
              } finally {
                window.clearTimeout(waitTimer);
                setTurnWaitMessage(null);
                setSubmitting(false);
              }
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={!session || submitting || paused}
              placeholder="Type the next operator step..."
              className="min-w-0 flex-1 rounded-md border border-subtle bg-canvas px-3 py-2 text-[13px] text-ink outline-none transition placeholder:text-ink-muted focus:border-ink-muted"
            />
            <Button
              type="submit"
              size="sm"
              disabled={!session || submitting || paused || !draft.trim()}
            >
              <Send size={14} aria-hidden />
              {submitting ? "Sending" : "Send"}
            </Button>
          </form>
          {turnWaitMessage && (
            <div className="border-t border-subtle bg-muted px-4 py-2 text-[12px] leading-relaxed text-ink-muted">
              {turnWaitMessage}
            </div>
          )}
        </section>

        <div className="mt-8 flex items-center justify-end gap-2">
          {error && (
            <p className="mr-auto text-[12px] text-danger">{error}</p>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => setPaused((value) => !value)}
          >
            <Pause size={14} aria-hidden />
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button
            type="button"
            disabled={completing || !session}
            onClick={async () => {
              if (!session) return;
              setCompleting(true);
              setError(null);
              try {
                await sendLiveKitOperatorControl(
                  roomRef.current,
                  "end",
                  session.captureSessionId,
                );
                disconnectOperatorVoiceRoom(roomRef, micTrackRef, audioElsRef);
                await completeOperatorCapture(session);
                router.push(
                  `/synthesis?next=${encodeURIComponent(
                    `/process/${processId}/workspace`,
                  )}`,
                );
              } catch (err) {
                setError(
                  err instanceof Error
                    ? err.message
                    : "Could not complete the interview.",
                );
              } finally {
                setCompleting(false);
              }
            }}
          >
            <Square size={14} aria-hidden />
            {completing ? "Completing" : "Complete Interview"}
          </Button>
        </div>
      </section>
    </main>
  );
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

async function completeOperatorCapture(session: OperatorSession) {
  await postJson(
    `/api/processes/${session.processId}/operator-captures/${session.captureSessionId}/complete`,
    { workspace_id: session.workspaceId },
    `operator-capture-complete-${session.captureSessionId}`,
  );
}

async function connectOperatorVoiceRoom(input: {
  session: OperatorSession;
  roomRef: MutableRefObject<LiveKitRoomLike | null>;
  micTrackRef: MutableRefObject<LiveKitTrack | null>;
  audioElsRef: MutableRefObject<HTMLMediaElement[]>;
  onEvent: (message: CaptureConversationMessage) => void;
  onError: (message: string) => void;
}) {
  const roomUrl = input.session.liveKit?.url;
  const roomToken = input.session.liveKit?.token;
  if (!roomUrl || !roomToken) return;
  try {
    const livekit = await importLiveKitClient();
    const room = new livekit.Room({ adaptiveStream: true, dynacast: true });
    const events = livekit.RoomEvent;
    room.on(events.DataReceived ?? "dataReceived", (...args) => {
      const message = captureMessageFromDataEvent(args);
      if (message) input.onEvent(message);
    });
    room.on(events.TrackSubscribed ?? "trackSubscribed", (track) => {
      const remoteTrack = track as LiveKitTrack;
      const element = remoteTrack.attach?.();
      if (!element) return;
      element.autoplay = true;
      element.dataset.ottoLivekitAudio = "true";
      document.body.appendChild(element);
      input.audioElsRef.current.push(element);
      void element.play().catch(() => {
        input.onError(
          "Agent audio is ready, but the browser blocked playback. Click in the page and try again.",
        );
      });
    });
    room.on(events.TrackUnsubscribed ?? "trackUnsubscribed", (track) => {
      const remoteTrack = track as LiveKitTrack;
      for (const element of remoteTrack.detach?.() ?? []) {
        element.remove();
        input.audioElsRef.current = input.audioElsRef.current.filter(
          (candidate) => candidate !== element,
        );
      }
    });
    await room.connect(roomUrl, roomToken);
    input.roomRef.current = room;
    input.onEvent({
      id: `voice-room-connected-${input.session.captureSessionId}-${Date.now()}`,
      speaker: "system",
      text: "Live voice room connected.",
      timestamp: new Date().toISOString(),
    });
    await room.localParticipant.setMicrophoneEnabled?.(true);
    if (!room.localParticipant.setMicrophoneEnabled && livekit.createLocalAudioTrack) {
      const micTrack = await livekit.createLocalAudioTrack();
      input.micTrackRef.current = micTrack;
      await room.localParticipant.publishTrack?.(micTrack);
    }
    await sendLiveKitOperatorControl(
      room,
      "resume",
      input.session.captureSessionId,
    );
  } catch (error) {
    disconnectOperatorVoiceRoom(
      input.roomRef,
      input.micTrackRef,
      input.audioElsRef,
    );
    input.onError(
      error instanceof Error
        ? error.message
        : "Could not connect the operator voice room.",
    );
  }
}

async function sendLiveKitOperatorControl(
  room: LiveKitRoomLike | null,
  action: "pause" | "resume" | "mute" | "unmute" | "end",
  captureSessionId: string,
) {
  if (!room?.localParticipant.publishData) return false;
  const payload = new TextEncoder().encode(
    JSON.stringify({
      source: "otto_browser_client",
      capture_session_id: captureSessionId,
      event: "operator.control",
      payload: { action, sent_at: new Date().toISOString() },
    }),
  );
  await room.localParticipant.publishData(payload, {
    reliable: true,
    topic: "otto.operator.control",
  });
  return true;
}

function disconnectOperatorVoiceRoom(
  roomRef: MutableRefObject<LiveKitRoomLike | null>,
  micTrackRef: MutableRefObject<LiveKitTrack | null>,
  audioElsRef: MutableRefObject<HTMLMediaElement[]>,
) {
  try {
    micTrackRef.current?.stop?.();
    roomRef.current?.disconnect();
  } catch {
    // Ignore teardown races between browser permission prompts and room disconnect.
  }
  micTrackRef.current = null;
  roomRef.current = null;
  for (const element of audioElsRef.current) element.remove();
  audioElsRef.current = [];
}

async function postOperatorTurn(session: OperatorSession, utterance: string) {
  return postJson<{
    planned_agent_utterance: string;
  }>(
    `/api/operator-captures/${session.captureSessionId}/turns`,
    {
      workspace_id: session.workspaceId,
      utterance,
    },
    `operator-turn-${session.captureSessionId}-${Date.now()}`,
  );
}

async function importLiveKitClient(): Promise<LiveKitClientModule> {
  return (await import("livekit-client")) as unknown as LiveKitClientModule;
}

async function postJson<T>(url: string, body: unknown, idempotencyKey: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return payload as T;
}
