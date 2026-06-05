"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { GradientMark } from "@/components/brand/GradientMark";
import { LanguageSelect } from "@/components/onboarding/LanguageSelect";

type DirectorSession = {
  workspaceId: string;
  captureSessionId: string;
  language: string;
  roomMode: "simulated" | "livekit";
  roomName: string;
  roomUrl: string | null;
  roomToken: string | null;
  roomTokenExpiresAt: string | null;
  agentName?: string;
  agentParticipantIdentity?: string;
  dispatchId?: string;
  roomReason?: string;
  startedAt: string;
};

type DirectorVoiceReadiness = {
  mode: "simulated" | "livekit" | "unconfigured";
  requiresMicrophone: boolean;
  missing: string[];
  reason: string | null;
};

type DirectorRoomResponse = {
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

export const DIRECTOR_SESSION_KEY = "otto.directorInterview.session";
const WORKSPACE_KEY = "otto.phase0.workspaceId";

export function VoicePreStartClient() {
  const router = useRouter();
  const [language, setLanguage] = useState("en");
  const [starting, setStarting] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consentCheckboxRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    window.localStorage.removeItem(DIRECTOR_SESSION_KEY);
  }, []);

  async function startInterview() {
    const consentConfirmed =
      consentGiven || consentCheckboxRef.current?.checked === true;
    if (!consentConfirmed) {
      setError("Please confirm consent before starting the interview.");
      return;
    }
    if (!consentGiven) setConsentGiven(true);
    setStarting(true);
    setError(null);
    try {
      const readiness = await getJson<DirectorVoiceReadiness>(
        "/api/livekit/director-room",
      );
      if (readiness.mode === "unconfigured") {
        throw new Error(
          readiness.reason ?? "LiveKit voice is not fully configured.",
        );
      }
      if (readiness.requiresMicrophone) {
        await requestMicrophonePermission();
      }
      const workspaceId = await ensureWorkspace();
      const session = await postJson<{
        capture_session: { id: string };
      }>(
        "/api/director-interviews",
        {
          workspace_id: workspaceId,
          language,
          consent_acknowledged: true,
          consent_text_version: "director_voice_v1",
        },
        `director-session-${workspaceId}-${Date.now()}`,
      );
      let directorSession: DirectorSession = {
        workspaceId,
        captureSessionId: session.capture_session.id,
        language,
        roomMode: readiness.mode === "livekit" ? "livekit" : "simulated",
        roomName: `director-${session.capture_session.id}`,
        roomUrl: null,
        roomToken: null,
        roomTokenExpiresAt: null,
        roomReason: readiness.reason ?? undefined,
        startedAt: new Date().toISOString(),
      };
      if (directorSession.roomMode === "livekit") {
        const room = await postJson<DirectorRoomResponse>(
          "/api/livekit/director-room",
          {
            workspace_id: workspaceId,
            capture_session_id: session.capture_session.id,
          },
          `director-room-prewarm-${session.capture_session.id}-${Date.now()}`,
        );
        directorSession = {
          ...directorSession,
          roomMode: room.mode,
          roomName: room.room,
          roomUrl: room.url,
          roomToken: room.token,
          roomTokenExpiresAt: room.tokenExpiresAt,
          agentName: room.agentName,
          agentParticipantIdentity: room.agentParticipantIdentity,
          dispatchId: room.dispatchId,
          roomReason: room.reason,
        };
      }
      window.localStorage.setItem(
        DIRECTOR_SESSION_KEY,
        JSON.stringify(directorSession),
      );
      router.push("/onboarding/voice/live");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start the interview.",
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-10">
      <header className="space-y-2 text-center">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">
          Otto starts with your perspective
        </h1>
        <p className="mx-auto max-w-[560px] text-[13px] leading-relaxed text-ink-secondary">
          Tell us about your team: who&apos;s involved, how work flows, where
          the pain points are. We&apos;ll turn it into a structured overview of
          your operations.
        </p>
      </header>

      <section className="mx-auto flex max-w-[560px] flex-col items-center gap-8 rounded-lg border border-subtle bg-surface px-8 py-10 shadow-card">
        <GradientMark variant="wave" size={140} />
        <p className="text-center text-[12.5px] leading-relaxed text-ink-secondary">
          The interview covers focused questions across key areas of your
          operations and takes about 15-20 minutes. Recording starts only after
          you enter the live room.
        </p>
        <div className="flex flex-col items-center gap-3">
          <div className="inline-flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
            <Globe size={12} aria-hidden /> Select interview language
          </div>
          <LanguageSelect value={language} onChange={setLanguage} />
        </div>
        <label className="flex max-w-[440px] items-start gap-2 rounded-md border border-subtle bg-canvas px-3 py-2.5 text-[12px] leading-relaxed text-ink-secondary">
          <input
            ref={consentCheckboxRef}
            type="checkbox"
            checked={consentGiven}
            onChange={(event) => {
              setConsentGiven(event.target.checked);
              if (event.target.checked) setError(null);
            }}
            className="mt-0.5 size-4 accent-[var(--solid)]"
            disabled={starting}
          />
          <span>
            I consent to a voice interview being transcribed and analyzed for
            this workspace. Audio recording is off unless workspace retention is
            enabled.
          </span>
        </label>
        {error && (
          <p className="rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-center text-[12px] text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            type="button"
            onClick={() => router.push("/onboarding")}
            disabled={starting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={startInterview}
            disabled={starting}
          >
            {starting ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden />
                Starting
              </>
            ) : (
              "Start Interview"
            )}
          </Button>
        </div>
      </section>
    </div>
  );
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
      "Microphone permission is required for the voice interview. Allow microphone access and try again.",
    );
  }
}

async function ensureWorkspace() {
  const existing = window.localStorage.getItem(WORKSPACE_KEY);
  if (existing) return existing;
  const created = await postJson<{
    workspace: { id: string };
  }>(
    "/api/workspaces",
    {
      name: "Commercial Operations",
      function_name: "Commercial Department",
      create_starter_process: false,
    },
    "workspace-create-voice",
  );
  window.localStorage.setItem(WORKSPACE_KEY, created.workspace.id);
  return created.workspace.id;
}

async function postJson<T>(url: string, body: unknown, idempotencyKey?: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
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

async function getJson<T>(url: string) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return payload as T;
}
