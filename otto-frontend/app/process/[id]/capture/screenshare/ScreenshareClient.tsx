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

const OPERATOR_SCREENSHARE_SESSION_KEY = "otto.operatorScreenshare.session";
const SCREEN_FRAME_SAMPLE_INTERVAL_MS = 500;
const SCREEN_FRAME_DUPLICATE_DIFF_THRESHOLD = 0.08;

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
  const [capturedFrameCount, setCapturedFrameCount] = useState(0);
  const roomRef = useRef<LiveKitRoomLike | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const micTrackRef = useRef<LiveKitTrack | null>(null);
  const audioElsRef = useRef<HTMLMediaElement[]>([]);
  const samplerCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (session?.liveKit?.mode !== "livekit") return;
    let cancelled = false;
    void connectScreenshareRoom({
      session,
      roomRef,
      screenStreamRef,
      micTrackRef,
      audioElsRef,
      samplerCleanupRef,
      onEvent: (message) => {
        if (!cancelled) {
          setMessages((current) => appendCaptureMessage(current, message));
        }
      },
      onError: (message) => {
        if (!cancelled) setError(message);
      },
      onFrameCaptured: () => {
        if (!cancelled) setCapturedFrameCount((count) => count + 1);
      },
    });
    return () => {
      cancelled = true;
      disconnectScreenshareRoom(
        roomRef,
        screenStreamRef,
        micTrackRef,
        audioElsRef,
        samplerCleanupRef,
      );
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

  async function startCapture() {
    if (!consentGiven) {
      setError("Please confirm consent before starting the screenshare interview.");
      return;
    }
    setStarting(true);
    setError(null);
    let preauthorizedScreenStream: MediaStream | null = null;
    try {
      preauthorizedScreenStream = await requestScreenPermission();
      screenStreamRef.current = preauthorizedScreenStream;
      await requestMicrophonePermission();
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
      setMessages([
        {
          id: `capture-started-${capture.capture_session.id}`,
          speaker: "system",
          text: "Screenshare capture started. Otto is joining the room and listening for the walkthrough.",
          timestamp: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      for (const track of preauthorizedScreenStream?.getTracks() ?? []) track.stop();
      if (screenStreamRef.current === preauthorizedScreenStream) {
        screenStreamRef.current = null;
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
        <ScreenSharePreview stream={screenStreamRef.current} />
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
        <CaptureControls
          processId={processId}
          onMuteChange={async (muted) => {
            await setOperatorMicrophoneMuted(roomRef.current, micTrackRef.current, muted);
            await sendLiveKitOperatorControl(
              roomRef.current,
              muted ? "mute" : "unmute",
              session.captureSessionId,
            );
          }}
          onPauseChange={setPaused}
          onComplete={async () => {
            await sendLiveKitOperatorControl(
              roomRef.current,
              "end",
              session.captureSessionId,
            );
            disconnectScreenshareRoom(
              roomRef,
              screenStreamRef,
              micTrackRef,
              audioElsRef,
              samplerCleanupRef,
            );
            await completeOperatorCapture({
              workspaceId,
              processId,
              captureSessionId: session.captureSessionId,
            });
          }}
        />
        {redactToast && (
          <div className="self-center rounded-md bg-ink px-3 py-1.5 text-[11.5px] text-canvas shadow-pop">
            Got it — redacting the last 30 seconds across the recording, transcript,
            screen events, and embeddings.
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
              setRedactionError(
                err instanceof Error ? err.message : "Could not redact capture.",
              );
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
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    return stream;
  } catch {
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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch {
    throw new Error(
      "Microphone permission is required for the screenshare interview.",
    );
  }
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

async function connectScreenshareRoom(input: {
  session: ScreenshareSession;
  roomRef: MutableRefObject<LiveKitRoomLike | null>;
  screenStreamRef: MutableRefObject<MediaStream | null>;
  micTrackRef: MutableRefObject<LiveKitTrack | null>;
  audioElsRef: MutableRefObject<HTMLMediaElement[]>;
  samplerCleanupRef: MutableRefObject<(() => void) | null>;
  onEvent: (message: CaptureConversationMessage) => void;
  onError: (message: string) => void;
  onFrameCaptured: () => void;
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
    for (const track of screenStream.getVideoTracks()) {
      await room.localParticipant.publishTrack?.(track);
    }
    input.samplerCleanupRef.current = startScreenFrameSampler({
      session: input.session,
      stream: screenStream,
      onError: input.onError,
      onFrameCaptured: input.onFrameCaptured,
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
    disconnectScreenshareRoom(
      input.roomRef,
      input.screenStreamRef,
      input.micTrackRef,
      input.audioElsRef,
      input.samplerCleanupRef,
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
  if (room?.localParticipant.setMicrophoneEnabled) {
    await room.localParticipant.setMicrophoneEnabled(!muted);
    return;
  }
  if (muted) {
    await micTrack?.mute?.();
  } else {
    await micTrack?.unmute?.();
  }
}

function disconnectScreenshareRoom(
  roomRef: MutableRefObject<LiveKitRoomLike | null>,
  screenStreamRef: MutableRefObject<MediaStream | null>,
  micTrackRef: MutableRefObject<LiveKitTrack | null>,
  audioElsRef: MutableRefObject<HTMLMediaElement[]>,
  samplerCleanupRef: MutableRefObject<(() => void) | null>,
) {
  try {
    samplerCleanupRef.current?.();
    for (const track of screenStreamRef.current?.getTracks() ?? []) track.stop();
    micTrackRef.current?.stop?.();
    roomRef.current?.disconnect();
  } catch {
    // Ignore teardown races between browser permission prompts and room disconnect.
  }
  screenStreamRef.current = null;
  micTrackRef.current = null;
  roomRef.current = null;
  samplerCleanupRef.current = null;
  for (const element of audioElsRef.current) element.remove();
  audioElsRef.current = [];
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

  const sample = async () => {
    if (
      stopped ||
      uploadInFlight ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      if (!readyWarningSent && Date.now() - Date.parse(input.session.startedAt) > 4000) {
        readyWarningSent = true;
        input.onError(
          "Screen sharing is connected, but no screen frames are available yet. Try sharing a window or entire screen instead of this tab.",
        );
      }
      return;
    }
    const width = Math.max(1, video.videoWidth);
    const height = Math.max(1, video.videoHeight);
    if (width <= 1 || height <= 1) return;
    const hash = hashVideoFrame(video, hashCanvas);
    const diffScore = lastHash ? hammingDistance(hash, lastHash) / hash.length : 1;
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
      if (!upload.ok) throw new Error(`Frame upload failed (${upload.status}).`);
      await postJson(
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
      input.onFrameCaptured();
    } catch (error) {
      input.onError(
        error instanceof Error
          ? error.message
          : "Could not save a screenshare keyframe.",
      );
    } finally {
      uploadInFlight = false;
    }
  };

  void video.play().catch(() => undefined);
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
    luminance.push(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
  }
  const mean =
    luminance.reduce((sum, value) => sum + value, 0) / Math.max(1, luminance.length);
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
