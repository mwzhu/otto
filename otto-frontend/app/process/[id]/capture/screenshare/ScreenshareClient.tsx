"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Globe, Loader2, MonitorUp } from "lucide-react";
import { ScreenSharePreview } from "@/components/capture/ScreenSharePreview";
import {
  ConversationPanel,
  type CaptureConversationMessage,
} from "@/components/capture/ConversationPanel";
import {
  appendCaptureMessage,
  captureMessageFromDataEvent,
} from "@/components/capture/operatorConversationEvents";
import { CaptureControls } from "@/components/capture/CaptureControls";
import { LanguageSelect } from "@/components/onboarding/LanguageSelect";
import { Button } from "@/components/ui/Button";

type ScreenshareSession = {
  workspaceId: string;
  processId: string;
  captureSessionId: string;
  language: string;
  mode: "operator_screenshare";
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
  mute?: () => Promise<void> | void;
  unmute?: () => Promise<void> | void;
  attach?: () => HTMLMediaElement;
  detach?: () => HTMLMediaElement[];
};

type LiveKitRoomLike = {
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => void;
  remoteParticipants?: Map<string, { identity?: string }>;
  localParticipant: {
    setMicrophoneEnabled?: (enabled: boolean) => Promise<void>;
    publishTrack?: (
      track: MediaStreamTrack | LiveKitTrack,
      options?: { name?: string; source?: string },
    ) => Promise<unknown>;
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
  Track?: { Source?: Record<string, string> };
  createLocalAudioTrack?: () => Promise<LiveKitTrack>;
};

type CaptureHealthKey =
  | "livekitConnected"
  | "micPublishing"
  | "screenTrackPublishing"
  | "keyframesSaved"
  | "agentJoined"
  | "recordingActive";

type CaptureHealth = Record<CaptureHealthKey, boolean>;

const OPERATOR_SCREENSHARE_SESSION_KEY = "otto.operatorScreenshare.session";
const SCREEN_FRAME_SAMPLE_INTERVAL_MS = 500;
const SCREEN_FRAME_DUPLICATE_DIFF_THRESHOLD = 0.08;
const SCREEN_RECORDING_VIDEO_BITS_PER_SECOND = 1_500_000;
const SCREEN_RECORDING_AUDIO_BITS_PER_SECOND = 64_000;
const DEFAULT_MEDIA_PERMISSION_TIMEOUT_MS = 20_000;
const DEFAULT_STARTUP_REQUEST_TIMEOUT_MS = 20_000;

declare global {
  interface Window {
    __OTTO_MEDIA_PERMISSION_TIMEOUT_MS__?: number;
    __OTTO_STARTUP_REQUEST_TIMEOUT_MS__?: number;
  }
}

export default function ScreenshareClient({
  workspaceId,
  processId,
  processName,
}: {
  workspaceId: string;
  processId: string;
  processName: string;
}) {
  const [paused, setPaused] = useState(false);
  const [redactToast, setRedactToast] = useState(false);
  const [language, setLanguage] = useState("en");
  const [consentGiven, setConsentGiven] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redactionError, setRedactionError] = useState<string | null>(null);
  const [session, setSession] = useState<ScreenshareSession | null>(null);
  const [messages, setMessages] = useState<CaptureConversationMessage[]>([]);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [capturedFrameCount, setCapturedFrameCount] = useState(0);
  const [captureHealth, setCaptureHealth] = useState<CaptureHealth>({
    livekitConnected: false,
    micPublishing: false,
    screenTrackPublishing: false,
    keyframesSaved: false,
    agentJoined: false,
    recordingActive: false,
  });
  const roomRef = useRef<LiveKitRoomLike | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micTrackRef = useRef<LiveKitTrack | null>(null);
  const audioElsRef = useRef<HTMLMediaElement[]>([]);
  const samplerCleanupRef = useRef<(() => void) | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaRecorderChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    if (session.liveKit?.mode !== "livekit") {
      const screenStream = screenStreamRef.current;
      if (!screenStream) return;
      startMediaRecorderFallback({
        screenStream,
        micStream: micStreamRef.current,
        mediaRecorderRef,
        mediaRecorderChunksRef,
      });
      samplerCleanupRef.current = startScreenFrameSampler({
        session,
        stream: screenStream,
        onError: (message) => {
          if (!cancelled) setError(message);
        },
        onFrameCaptured: () => {
          if (!cancelled) {
            setCapturedFrameCount((count) => count + 1);
            setCaptureHealth((current) => ({
              ...current,
              keyframesSaved: true,
            }));
          }
        },
      });
      setCaptureHealth((current) => ({
        ...current,
        screenTrackPublishing: true,
        recordingActive: Boolean(mediaRecorderRef.current),
      }));
      return () => {
        cancelled = true;
        stopMediaRecorderWithoutUpload(mediaRecorderRef);
        disconnectScreenshareRoom(
          roomRef,
          screenStreamRef,
          micStreamRef,
          micTrackRef,
          audioElsRef,
          samplerCleanupRef,
          setScreenStream,
        );
      };
    }
    void connectScreenshareRoom({
      session,
      roomRef,
      screenStreamRef,
      micStreamRef,
      micTrackRef,
      audioElsRef,
      samplerCleanupRef,
      mediaRecorderRef,
      mediaRecorderChunksRef,
      onScreenStreamChange: setScreenStream,
      onEvent: (message) => {
        if (!cancelled) {
          setMessages((current) => appendCaptureMessage(current, message));
        }
      },
      onError: (message) => {
        if (!cancelled) setError(message);
      },
      onFrameCaptured: () => {
        if (!cancelled) {
          setCapturedFrameCount((count) => count + 1);
          setCaptureHealth((current) => ({ ...current, keyframesSaved: true }));
        }
      },
      onHealthChange: (patch) => {
        if (!cancelled) {
          setCaptureHealth((current) => ({ ...current, ...patch }));
        }
      },
    });
    return () => {
      cancelled = true;
      stopMediaRecorderWithoutUpload(mediaRecorderRef);
      disconnectScreenshareRoom(
        roomRef,
        screenStreamRef,
        micStreamRef,
        micTrackRef,
        audioElsRef,
        samplerCleanupRef,
        setScreenStream,
      );
    };
  }, [session]);

  async function startCapture() {
    if (!consentGiven) {
      setError(
        "Please confirm consent before starting the screenshare interview.",
      );
      return;
    }
    setStarting(true);
    setError(null);
    let preauthorizedScreenStream: MediaStream | null = null;
    let preauthorizedMicStream: MediaStream | null = null;
    try {
      preauthorizedScreenStream = await requestScreenPermission();
      screenStreamRef.current = preauthorizedScreenStream;
      setScreenStream(preauthorizedScreenStream);
      preauthorizedMicStream = await requestMicrophonePermission();
      micStreamRef.current = preauthorizedMicStream;
      const capture = await postJson<{
        capture_session: { id: string };
      }>(
        `/api/processes/${processId}/operator-captures`,
        {
          workspace_id: workspaceId,
          mode: "screenshare",
          language,
          consent_acknowledged: true,
          consent_text_version: "operator_screenshare_v1",
        },
        `operator-screenshare-${processId}-${Date.now()}`,
      );
      const liveKit = await postJson<ScreenshareSession["liveKit"]>(
        "/api/livekit/operator-room",
        {
          workspace_id: workspaceId,
          capture_session_id: capture.capture_session.id,
        },
        `operator-screenshare-room-${capture.capture_session.id}-${Date.now()}`,
      );
      const nextSession: ScreenshareSession = {
        workspaceId,
        processId,
        captureSessionId: capture.capture_session.id,
        language,
        mode: "operator_screenshare",
        startedAt: new Date().toISOString(),
        liveKit,
      };
      window.localStorage.setItem(
        OPERATOR_SCREENSHARE_SESSION_KEY,
        JSON.stringify(nextSession),
      );
      setSession(nextSession);
      setCapturedFrameCount(0);
      setCaptureHealth({
        livekitConnected: liveKit?.mode === "livekit" ? false : true,
        micPublishing: false,
        screenTrackPublishing: false,
        keyframesSaved: false,
        agentJoined: false,
        recordingActive: liveKit?.mode === "livekit",
      });
      setMessages([
        {
          id: `capture-started-${capture.capture_session.id}`,
          speaker: "system",
          text: "Screenshare capture started. Otto is joining the room and listening for the walkthrough.",
          timestamp: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      for (const track of preauthorizedScreenStream?.getTracks() ?? [])
        track.stop();
      for (const track of preauthorizedMicStream?.getTracks() ?? [])
        track.stop();
      if (screenStreamRef.current === preauthorizedScreenStream) {
        screenStreamRef.current = null;
        setScreenStream(null);
      }
      if (micStreamRef.current === preauthorizedMicStream) {
        micStreamRef.current = null;
      }
      setError(
        err instanceof Error
          ? err.message
          : "Could not start the screenshare interview.",
      );
    } finally {
      setStarting(false);
    }
  }

  if (!session) {
    return (
      <main className="flex-1 px-8 py-10">
        <section className="mx-auto flex max-w-[660px] flex-col items-center gap-8 rounded-lg border border-subtle bg-surface px-8 py-10 shadow-card">
          <div className="grid size-16 place-items-center rounded-lg border border-subtle bg-muted text-ink">
            <MonitorUp size={28} aria-hidden />
          </div>
          <div className="space-y-2 text-center">
            <h1 className="text-[20px] font-semibold tracking-tight text-ink">
              Walk Otto through {processName}
            </h1>
            <p className="mx-auto max-w-[520px] text-[12.5px] leading-relaxed text-ink-secondary">
              Share your screen and narrate the process. Otto will use screen
              events plus voice context to ask targeted questions about hidden
              steps, exceptions, and workarounds.
            </p>
          </div>
          <div className="flex flex-col items-center gap-3">
            <div className="inline-flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
              <Globe size={12} aria-hidden /> Select interview language
            </div>
            <LanguageSelect value={language} onChange={setLanguage} />
          </div>
          <label className="flex max-w-[500px] items-start gap-2 rounded-md border border-subtle bg-canvas px-3 py-2.5 text-[12px] leading-relaxed text-ink-secondary">
            <input
              type="checkbox"
              checked={consentGiven}
              onChange={(event) => setConsentGiven(event.target.checked)}
              className="mt-0.5 size-4 accent-[var(--solid)]"
              disabled={starting}
            />
            <span>
              I consent to this screenshare interview being transcribed and
              analyzed for process mapping. I understand screen recording may
              include visible application content until I pause or redact it.
            </span>
          </label>
          {error && (
            <p className="rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-center text-[12px] text-danger">
              {error}
            </p>
          )}
          <Button
            type="button"
            onClick={startCapture}
            disabled={starting || !consentGiven}
          >
            {starting ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden />
                Starting
              </>
            ) : (
              "Start Screenshare Interview"
            )}
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto grid w-full max-w-[1400px] flex-1 grid-cols-[1.4fr_460px] gap-6 px-6 py-6">
      <section className="flex flex-col gap-4">
        <div className="rounded-md border border-subtle bg-surface px-3 py-2 text-[12px] text-ink-secondary">
          Capture session{" "}
          <span className="font-mono text-ink">{session.captureSessionId}</span>
          <span className="ml-3">
            Voice runtime{" "}
            <span className="font-mono text-ink">
              {session.liveKit?.mode ?? "pending"}
            </span>
          </span>
        </div>
        <ScreenSharePreview stream={screenStream} />
        <div className="flex items-center justify-center gap-3 text-[11.5px] text-ink-secondary">
          <span>
            Screen keyframes captured{" "}
            <span className="font-mono text-ink">{capturedFrameCount}</span>
          </span>
          {capturedFrameCount === 0 && (
            <span className="text-ink-muted">
              Keep the shared window visible and narrate the walkthrough.
            </span>
          )}
        </div>
        {error && (
          <p className="self-center rounded-md border border-danger/20 bg-danger/5 px-3 py-1.5 text-[11.5px] text-danger">
            {error}
          </p>
        )}
        <div className="grid grid-cols-3 gap-2 text-[11px] text-ink-secondary">
          {captureHealthItems(captureHealth).map((item) => (
            <div
              key={item.label}
              className="flex items-center gap-2 rounded-md border border-subtle bg-canvas px-2 py-1.5"
            >
              <span
                className={[
                  "size-1.5 rounded-full",
                  item.ready ? "bg-success" : "bg-ink-muted",
                ].join(" ")}
                aria-hidden
              />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
        <CaptureControls
          processId={processId}
          workspaceId={workspaceId}
          captureSessionId={session.captureSessionId}
          onMuteChange={async (muted) => {
            await setOperatorMicrophoneMuted(
              roomRef.current,
              micTrackRef.current,
              muted,
            );
            await sendLiveKitOperatorControl(
              roomRef.current,
              muted ? "mute" : "unmute",
              session.captureSessionId,
            );
          }}
          onPauseChange={async (nextPaused) => {
            setError(null);
            await setScreenshareCapturePaused({
              paused: nextPaused,
              session,
              room: roomRef.current,
              mediaRecorderRef,
              screenStreamRef,
              samplerCleanupRef,
              onFrameCaptured: () => {
                setCapturedFrameCount((count) => count + 1);
                setCaptureHealth((current) => ({
                  ...current,
                  keyframesSaved: true,
                }));
              },
              onError: setError,
            });
            setPaused(nextPaused);
            setCaptureHealth((current) => ({
              ...current,
              recordingActive: !nextPaused && Boolean(mediaRecorderRef.current),
            }));
          }}
          onComplete={async () => {
            setError(null);
            stopScreenFrameSampler(samplerCleanupRef);
            await stopAndUploadMediaRecorderFallback({
              mediaRecorderRef,
              mediaRecorderChunksRef,
              session,
            });
            await completeOperatorCapture({
              workspaceId,
              processId,
              captureSessionId: session.captureSessionId,
            });
            await sendLiveKitOperatorControl(
              roomRef.current,
              "end",
              session.captureSessionId,
            ).catch((error) => {
              console.warn("Failed to send operator end control", error);
            });
            disconnectScreenshareRoom(
              roomRef,
              screenStreamRef,
              micStreamRef,
              micTrackRef,
              audioElsRef,
              samplerCleanupRef,
              setScreenStream,
            );
          }}
        />
        {redactToast && (
          <div className="self-center rounded-md bg-ink px-3 py-1.5 text-[11.5px] text-canvas shadow-pop">
            Got it — redacting the last 30 seconds across the recording,
            transcript, screen events, and embeddings.
          </div>
        )}
        {redactionError && (
          <div className="self-center rounded-md border border-danger/20 bg-danger/5 px-3 py-1.5 text-[11.5px] text-danger">
            {redactionError}
          </div>
        )}
      </section>

      <aside className="flex h-[calc(100vh-130px)] flex-col overflow-hidden rounded-lg border border-subtle bg-surface shadow-card">
        <ConversationPanel
          paused={paused}
          messages={messages}
          runtimeStatus={session.liveKit?.mode ?? "pending"}
          onRedactRequested={async () => {
            setRedactionError(null);
            try {
              await redactLastWindow({
                workspaceId,
                processId,
                captureSessionId: session.captureSessionId,
              });
              setRedactToast(true);
              setTimeout(() => setRedactToast(false), 3500);
            } catch (err) {
              setRedactionError(redactionFailureMessage(err));
            }
          }}
        />
      </aside>
    </main>
  );
}

async function requestScreenPermission() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error(
      "Screen sharing is not available in this browser. Please use a browser with screen capture support.",
    );
  }
  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      }),
      mediaPermissionTimeoutMs(),
      "Screen sharing permission did not finish. Choose a window or try again.",
    );
    return stream;
  } catch (error) {
    if (isTimeoutError(error)) throw error;
    throw new Error(
      "Screen sharing permission is required for the screenshare interview.",
    );
  }
}

async function requestMicrophonePermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Microphone permission is not available in this browser. Please use a browser with microphone support.",
    );
  }
  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ audio: true }),
      mediaPermissionTimeoutMs(),
      "Microphone permission did not finish. Allow microphone access in the browser prompt, then try again.",
    );
    return stream;
  } catch (error) {
    if (isTimeoutError(error)) throw error;
    throw new Error(
      "Microphone permission is required for the screenshare interview.",
    );
  }
}

async function postJson<T>(url: string, body: unknown, idempotencyKey: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    startupRequestTimeoutMs(),
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        "Screenshare setup timed out. Check your connection and try again.",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return payload as T;
}

function mediaPermissionTimeoutMs() {
  return windowTimeoutOverride(
    "__OTTO_MEDIA_PERMISSION_TIMEOUT_MS__",
    DEFAULT_MEDIA_PERMISSION_TIMEOUT_MS,
  );
}

function startupRequestTimeoutMs() {
  return windowTimeoutOverride(
    "__OTTO_STARTUP_REQUEST_TIMEOUT_MS__",
    DEFAULT_STARTUP_REQUEST_TIMEOUT_MS,
  );
}

function windowTimeoutOverride(
  key:
    | "__OTTO_MEDIA_PERMISSION_TIMEOUT_MS__"
    | "__OTTO_STARTUP_REQUEST_TIMEOUT_MS__",
  fallback: number,
) {
  const value = window[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => {
          const error = new Error(message);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && error.name === "TimeoutError";
}

async function completeOperatorCapture({
  workspaceId,
  processId,
  captureSessionId,
}: {
  workspaceId: string;
  processId: string;
  captureSessionId: string;
}) {
  await postJson(
    `/api/processes/${processId}/operator-captures/${captureSessionId}/complete`,
    { workspace_id: workspaceId },
    `operator-capture-complete-${captureSessionId}`,
  );
}

async function redactLastWindow({
  workspaceId,
  processId,
  captureSessionId,
}: {
  workspaceId: string;
  processId: string;
  captureSessionId: string;
}) {
  await postJson(
    `/api/processes/${processId}/operator-captures/${captureSessionId}/redactions`,
    {
      workspace_id: workspaceId,
      last_seconds: 30,
      reason: "operator_requested_last_30_seconds",
    },
    `operator-capture-redact-last-30-${captureSessionId}-${Date.now()}`,
  );
}

function redactionFailureMessage(error: unknown) {
  if (!(error instanceof Error)) return "Could not redact capture.";
  if (
    error.message === "Unexpected server error." ||
    error.message === "Request failed (500)"
  ) {
    return "Redaction failed; retry before using this capture.";
  }
  return error.message;
}

function screenFrameFailureMessage(error: unknown) {
  if (!(error instanceof Error)) return "Could not save a screenshare keyframe.";
  if (
    error.message === "Unexpected server error." ||
    error.message === "Request failed (500)"
  ) {
    return "Could not save a screenshare keyframe. Keep the shared window visible and restart the interview if the count stays at 0.";
  }
  return error.message;
}

async function connectScreenshareRoom(input: {
  session: ScreenshareSession;
  roomRef: MutableRefObject<LiveKitRoomLike | null>;
  screenStreamRef: MutableRefObject<MediaStream | null>;
  micStreamRef: MutableRefObject<MediaStream | null>;
  micTrackRef: MutableRefObject<LiveKitTrack | null>;
  audioElsRef: MutableRefObject<HTMLMediaElement[]>;
  samplerCleanupRef: MutableRefObject<(() => void) | null>;
  mediaRecorderRef: MutableRefObject<MediaRecorder | null>;
  mediaRecorderChunksRef: MutableRefObject<Blob[]>;
  onScreenStreamChange: (stream: MediaStream | null) => void;
  onEvent: (message: CaptureConversationMessage) => void;
  onError: (message: string) => void;
  onFrameCaptured: () => void;
  onHealthChange: (patch: Partial<CaptureHealth>) => void;
}) {
  const roomUrl = input.session.liveKit?.url;
  const roomToken = input.session.liveKit?.token;
  if (!roomUrl || !roomToken) return;
  try {
    const livekit = await importLiveKitClient();
    const room = new livekit.Room({ adaptiveStream: true, dynacast: true });
    const events = livekit.RoomEvent;
    const agentIdentity = input.session.liveKit?.agentParticipantIdentity;
    room.on(
      events.ParticipantConnected ?? "participantConnected",
      (participant) => {
        const identity =
          typeof participant === "object" &&
          participant &&
          "identity" in participant
            ? String(participant.identity)
            : "";
        if (!agentIdentity || identity === agentIdentity) {
          input.onHealthChange({ agentJoined: true });
        }
      },
    );
    room.on(events.LocalTrackPublished ?? "localTrackPublished", (...args) => {
      const publication = args[0] as
        | { source?: string; kind?: string }
        | undefined;
      if (
        publication?.source === "screen_share" ||
        publication?.kind === "video"
      ) {
        input.onHealthChange({ screenTrackPublishing: true });
      }
      if (
        publication?.source === "microphone" ||
        publication?.kind === "audio"
      ) {
        input.onHealthChange({ micPublishing: true });
      }
    });
    room.on(events.DataReceived ?? "dataReceived", (...args) => {
      const message = captureMessageFromDataEvent(args);
      if (message) input.onEvent(message);
      input.onHealthChange({ agentJoined: true });
    });
    room.on(events.TrackSubscribed ?? "trackSubscribed", (track) => {
      const remoteTrack = track as LiveKitTrack;
      const element = remoteTrack.attach?.();
      if (!element) return;
      element.autoplay = true;
      if (element instanceof HTMLVideoElement) element.playsInline = true;
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
    const agentAlreadyPresent = [
      ...(room.remoteParticipants?.values() ?? []),
    ].some(
      (participant) => !agentIdentity || participant.identity === agentIdentity,
    );
    input.onHealthChange({
      livekitConnected: true,
      agentJoined: agentAlreadyPresent,
    });
    input.onEvent({
      id: `room-connected-${input.session.captureSessionId}-${Date.now()}`,
      speaker: "system",
      text: "Live voice room connected.",
      timestamp: new Date().toISOString(),
    });

    const screenStream =
      input.screenStreamRef.current ??
      (await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      }));
    input.screenStreamRef.current = screenStream;
    input.onScreenStreamChange(screenStream);
    startMediaRecorderFallback({
      screenStream,
      micStream: input.micStreamRef.current,
      mediaRecorderRef: input.mediaRecorderRef,
      mediaRecorderChunksRef: input.mediaRecorderChunksRef,
    });
    input.onHealthChange({
      recordingActive: Boolean(input.mediaRecorderRef.current),
    });
    const screenShareSource =
      livekit.Track?.Source?.ScreenShare ?? "screen_share";
    for (const track of screenStream.getVideoTracks()) {
      await room.localParticipant.publishTrack?.(track, {
        name: `operator-screen-${input.session.captureSessionId}`,
        source: screenShareSource,
      });
    }
    input.onHealthChange({ screenTrackPublishing: true });
    input.samplerCleanupRef.current = startScreenFrameSampler({
      session: input.session,
      stream: screenStream,
      onError: input.onError,
      onFrameCaptured: input.onFrameCaptured,
    });
    const microphoneSource = livekit.Track?.Source?.Microphone ?? "microphone";
    const micTracks = input.micStreamRef.current?.getAudioTracks() ?? [];
    if (micTracks.length > 0) {
      for (const track of micTracks) {
        input.micTrackRef.current = track as LiveKitTrack;
        await room.localParticipant.publishTrack?.(track, {
          source: microphoneSource,
        });
      }
      input.onHealthChange({ micPublishing: true });
    } else if (room.localParticipant.setMicrophoneEnabled) {
      await room.localParticipant.setMicrophoneEnabled(true);
      input.onHealthChange({ micPublishing: true });
    } else if (livekit.createLocalAudioTrack) {
      const micTrack = await livekit.createLocalAudioTrack();
      input.micTrackRef.current = micTrack;
      await room.localParticipant.publishTrack?.(micTrack, {
        source: microphoneSource,
      });
      input.onHealthChange({ micPublishing: true });
    }
    await sendLiveKitOperatorControl(
      room,
      "resume",
      input.session.captureSessionId,
    );
  } catch (error) {
    disconnectScreenshareRoom(
      input.roomRef,
      input.screenStreamRef,
      input.micStreamRef,
      input.micTrackRef,
      input.audioElsRef,
      input.samplerCleanupRef,
      input.onScreenStreamChange,
    );
    input.onError(
      error instanceof Error
        ? error.message
        : "Could not connect the screenshare voice room.",
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

async function setOperatorMicrophoneMuted(
  room: LiveKitRoomLike | null,
  micTrack: LiveKitTrack | null,
  muted: boolean,
) {
  if (micTrack) {
    micTrack.enabled = !muted;
    if (muted) {
      await micTrack.mute?.();
    } else {
      await micTrack.unmute?.();
    }
    return;
  }
  if (room?.localParticipant.setMicrophoneEnabled) {
    await room.localParticipant.setMicrophoneEnabled(!muted);
    return;
  }
}

async function setScreenshareCapturePaused(input: {
  paused: boolean;
  session: ScreenshareSession;
  room: LiveKitRoomLike | null;
  mediaRecorderRef: MutableRefObject<MediaRecorder | null>;
  screenStreamRef: MutableRefObject<MediaStream | null>;
  samplerCleanupRef: MutableRefObject<(() => void) | null>;
  onFrameCaptured: () => void;
  onError: (message: string) => void;
}) {
  if (input.paused) {
    stopScreenFrameSampler(input.samplerCleanupRef);
    pauseMediaRecorder(input.mediaRecorderRef);
  } else {
    resumeMediaRecorder(input.mediaRecorderRef);
    const stream = input.screenStreamRef.current;
    if (stream && !input.samplerCleanupRef.current) {
      input.samplerCleanupRef.current = startScreenFrameSampler({
        session: input.session,
        stream,
        onError: input.onError,
        onFrameCaptured: input.onFrameCaptured,
      });
    }
  }
  await sendLiveKitOperatorControl(
    input.room,
    input.paused ? "pause" : "resume",
    input.session.captureSessionId,
  );
}

function stopScreenFrameSampler(
  samplerCleanupRef: MutableRefObject<(() => void) | null>,
) {
  samplerCleanupRef.current?.();
  samplerCleanupRef.current = null;
}

function disconnectScreenshareRoom(
  roomRef: MutableRefObject<LiveKitRoomLike | null>,
  screenStreamRef: MutableRefObject<MediaStream | null>,
  micStreamRef: MutableRefObject<MediaStream | null>,
  micTrackRef: MutableRefObject<LiveKitTrack | null>,
  audioElsRef: MutableRefObject<HTMLMediaElement[]>,
  samplerCleanupRef: MutableRefObject<(() => void) | null>,
  onScreenStreamChange?: (stream: MediaStream | null) => void,
) {
  try {
    stopScreenFrameSampler(samplerCleanupRef);
    for (const track of screenStreamRef.current?.getTracks() ?? [])
      track.stop();
    for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
    micTrackRef.current?.stop?.();
    roomRef.current?.disconnect();
  } catch {
    // Ignore teardown races between browser permission prompts and room disconnect.
  }
  screenStreamRef.current = null;
  micStreamRef.current = null;
  onScreenStreamChange?.(null);
  micTrackRef.current = null;
  roomRef.current = null;
  samplerCleanupRef.current = null;
  for (const element of audioElsRef.current) element.remove();
  audioElsRef.current = [];
}

function captureHealthItems(health: CaptureHealth) {
  return [
    { label: "LiveKit connected", ready: health.livekitConnected },
    { label: "Mic publishing", ready: health.micPublishing },
    { label: "Screen track publishing", ready: health.screenTrackPublishing },
    { label: "Keyframes saved", ready: health.keyframesSaved },
    { label: "Agent joined", ready: health.agentJoined },
    { label: "Browser recording buffer", ready: health.recordingActive },
  ];
}

function startMediaRecorderFallback(input: {
  screenStream: MediaStream;
  micStream: MediaStream | null;
  mediaRecorderRef: MutableRefObject<MediaRecorder | null>;
  mediaRecorderChunksRef: MutableRefObject<Blob[]>;
}) {
  if (input.mediaRecorderRef.current || typeof MediaRecorder === "undefined") {
    return;
  }
  const mimeType = preferredMediaRecorderMimeType();
  try {
    const recordingStream = new MediaStream([
      ...input.screenStream.getVideoTracks(),
      ...(input.micStream?.getAudioTracks() ?? []),
    ]);
    const recorder = new MediaRecorder(
      recordingStream,
      {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: SCREEN_RECORDING_VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: SCREEN_RECORDING_AUDIO_BITS_PER_SECOND,
      },
    );
    input.mediaRecorderChunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        input.mediaRecorderChunksRef.current.push(event.data);
      }
    };
    recorder.start(5000);
    input.mediaRecorderRef.current = recorder;
  } catch {
    input.mediaRecorderRef.current = null;
  }
}

async function stopAndUploadMediaRecorderFallback(input: {
  mediaRecorderRef: MutableRefObject<MediaRecorder | null>;
  mediaRecorderChunksRef: MutableRefObject<Blob[]>;
  session: ScreenshareSession;
}) {
  const recorder = input.mediaRecorderRef.current;
  if (!recorder) return null;
  const chunks = await stopMediaRecorder(
    recorder,
    input.mediaRecorderChunksRef,
  );
  input.mediaRecorderRef.current = null;
  if (chunks.length === 0) return null;
  const mimeType = recorder.mimeType || "video/webm";
  const blob = new Blob(chunks, { type: mimeType });
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  const filename = `operator-capture-${input.session.captureSessionId}.${extension}`;
  const presign = await postJson<{
    artifact: { id: string };
    upload_url: string;
  }>(
    `/api/workspaces/${input.session.workspaceId}/artifacts/presign`,
    {
      filename,
      mime_type: mimeType,
      size_bytes: blob.size,
      artifact_type: "video",
    },
    `operator-mediarecorder-presign-${input.session.captureSessionId}`,
  );
  const upload = await fetch(presign.upload_url, {
    method: "PUT",
    headers: { "content-type": mimeType },
    body: blob,
  });
  if (!upload.ok)
    throw new Error(`Recording upload failed (${upload.status}).`);
  return postJson(
    `/api/processes/${input.session.processId}/operator-captures/${input.session.captureSessionId}/recording`,
    {
      workspace_id: input.session.workspaceId,
      artifact_id: presign.artifact.id,
      provider: "mediarecorder-final-blob",
    },
    `operator-mediarecorder-bind-${input.session.captureSessionId}`,
  );
}

function stopMediaRecorderWithoutUpload(
  mediaRecorderRef: MutableRefObject<MediaRecorder | null>,
) {
  const recorder = mediaRecorderRef.current;
  mediaRecorderRef.current = null;
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
}

function pauseMediaRecorder(
  mediaRecorderRef: MutableRefObject<MediaRecorder | null>,
) {
  const recorder = mediaRecorderRef.current;
  if (recorder?.state === "recording") {
    recorder.requestData();
    recorder.pause();
  }
}

function resumeMediaRecorder(
  mediaRecorderRef: MutableRefObject<MediaRecorder | null>,
) {
  const recorder = mediaRecorderRef.current;
  if (recorder?.state === "paused") {
    recorder.resume();
  }
}

function stopMediaRecorder(
  recorder: MediaRecorder,
  chunksRef: MutableRefObject<Blob[]>,
) {
  return new Promise<Blob[]>((resolve) => {
    if (recorder.state === "inactive") {
      resolve(chunksRef.current);
      return;
    }
    const finalize = () => resolve(chunksRef.current);
    recorder.addEventListener("stop", finalize, { once: true });
    recorder.requestData();
    recorder.stop();
  });
}

function preferredMediaRecorderMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((candidate) =>
    MediaRecorder.isTypeSupported(candidate),
  );
}

function startScreenFrameSampler(input: {
  session: ScreenshareSession;
  stream: MediaStream;
  onError: (message: string) => void;
  onFrameCaptured: () => void;
}) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.style.position = "fixed";
  video.style.left = "-10000px";
  video.style.top = "0";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  video.setAttribute("aria-hidden", "true");
  video.srcObject = input.stream;
  document.body.appendChild(video);
  const canvas = document.createElement("canvas");
  const hashCanvas = document.createElement("canvas");
  hashCanvas.width = 16;
  hashCanvas.height = 9;
  let stopped = false;
  let timer: number | null = null;
  let lastHash: string | null = null;
  let frameIndex = 0;
  let uploadInFlight = false;
  let readyWarningSent = false;
  let firstFrameSaved = false;

  const warnIfStalled = (reason: string) => {
    if (readyWarningSent || firstFrameSaved) return;
    if (Date.now() - Date.parse(input.session.startedAt) <= 4000) return;
    readyWarningSent = true;
    const tracks = input.stream.getVideoTracks();
    const trackState = tracks
      .map((track) => `${track.readyState}${track.muted ? ":muted" : ""}`)
      .join(", ");
    input.onError(
      `Screen sharing is connected, but no screen frames are available yet (${reason}${trackState ? `; track ${trackState}` : ""}). Try sharing a window or entire screen, then restart the interview if this persists.`,
    );
  };

  const sample = async () => {
    if (stopped || uploadInFlight) {
      return;
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      warnIfStalled(`video not ready: ${video.readyState}`);
      return;
    }
    if (!input.stream.active || input.stream.getVideoTracks().length === 0) {
      warnIfStalled("screen stream is inactive");
      return;
    }
    const width = Math.max(1, video.videoWidth);
    const height = Math.max(1, video.videoHeight);
    if (width <= 1 || height <= 1) {
      warnIfStalled(
        `video dimensions unavailable: ${video.videoWidth}x${video.videoHeight}`,
      );
      return;
    }
    const hash = hashVideoFrame(video, hashCanvas);
    const diffScore = lastHash
      ? hammingDistance(hash, lastHash) / hash.length
      : 1;
    if (lastHash && diffScore < SCREEN_FRAME_DUPLICATE_DIFF_THRESHOLD) return;
    lastHash = hash;

    const scale = Math.min(1, 960 / width);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, "image/jpeg", 0.72);
    if (!blob || stopped) return;

    const currentFrame = frameIndex++;
    uploadInFlight = true;
    try {
      const filename = `screen-frame-${input.session.captureSessionId}-${currentFrame}.jpg`;
      const presign = await postJson<{
        artifact: { id: string };
        upload_url: string;
      }>(
        `/api/workspaces/${input.session.workspaceId}/artifacts/presign`,
        {
          filename,
          mime_type: "image/jpeg",
          size_bytes: blob.size,
          artifact_type: "screen_frame",
        },
        `screen-frame-presign-${input.session.captureSessionId}-${currentFrame}`,
      );
      const upload = await fetch(presign.upload_url, {
        method: "PUT",
        headers: { "content-type": "image/jpeg" },
        body: blob,
      });
      if (!upload.ok)
        throw new Error(`Frame upload failed (${upload.status}).`);
      const savedFrame = await postJson<{
        warning?: { message?: string };
      }>(
        `/api/processes/${input.session.processId}/operator-captures/${input.session.captureSessionId}/screen-frames`,
        {
          workspace_id: input.session.workspaceId,
          artifact_id: presign.artifact.id,
          ts_ms: elapsedSinceSessionStart(input.session),
          frame_index: currentFrame,
          perceptual_hash: hash,
          diff_score: Number(diffScore.toFixed(3)),
          app_name: "screenshare",
          ui_state_label: "Screenshare keyframe candidate",
          signal_tags: ["screen_frame_sampled"],
          metadata_json: {
            sampler: "browser_canvas_keyframe_sampler",
            source_dimensions: { width, height },
            sampled_dimensions: { width: canvas.width, height: canvas.height },
          },
        },
        `screen-frame-bind-${input.session.captureSessionId}-${currentFrame}`,
      );
      if (savedFrame.warning?.message) input.onError(savedFrame.warning.message);
      input.onFrameCaptured();
      firstFrameSaved = true;
    } catch (error) {
      input.onError(screenFrameFailureMessage(error));
    } finally {
      uploadInFlight = false;
    }
  };

  void video.play().catch(() => undefined);
  video.addEventListener("loadedmetadata", () => void sample());
  video.addEventListener("playing", () => void sample());
  timer = window.setInterval(
    () => void sample(),
    SCREEN_FRAME_SAMPLE_INTERVAL_MS,
  );
  void sample();

  return () => {
    stopped = true;
    if (timer !== null) window.clearInterval(timer);
    video.srcObject = null;
    video.remove();
  };
}

function hashVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "0".repeat(canvas.width * canvas.height);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const luminance: number[] = [];
  for (let index = 0; index < data.length; index += 4) {
    luminance.push(
      data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114,
    );
  }
  const mean =
    luminance.reduce((sum, value) => sum + value, 0) /
    Math.max(1, luminance.length);
  return luminance.map((value) => (value >= mean ? "1" : "0")).join("");
}

function hammingDistance(left: string, right: string) {
  const length = Math.min(left.length, right.length);
  let distance = Math.abs(left.length - right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) distance += 1;
  }
  return distance;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function elapsedSinceSessionStart(session: ScreenshareSession) {
  const started = Date.parse(session.startedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Date.now() - started);
}

async function importLiveKitClient(): Promise<LiveKitClientModule> {
  return (await import("livekit-client")) as unknown as LiveKitClientModule;
}
