"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Globe, Loader2, Mic } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LanguageSelect } from "@/components/onboarding/LanguageSelect";

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

export const OPERATOR_SESSION_KEY = "otto.operatorInterview.session";

export function OperatorVoicePreStartClient({
  workspaceId,
  processId,
  processName,
}: {
  workspaceId: string;
  processId: string;
  processName: string;
}) {
  const router = useRouter();
  const [language, setLanguage] = useState("en");
  const [starting, setStarting] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startInterview() {
    if (!consentGiven) {
      setError("Please confirm consent before starting the interview.");
      return;
    }
    setStarting(true);
    setError(null);
    try {
      await requestMicrophonePermission();
      const session = await postJson<{
        capture_session: { id: string };
      }>(
        `/api/processes/${processId}/operator-captures`,
        {
          workspace_id: workspaceId,
          mode: "voice",
          language,
          consent_acknowledged: true,
          consent_text_version: "operator_voice_v1",
        },
        `operator-voice-${processId}-${Date.now()}`,
      );
      const liveKit = await postJson<OperatorSession["liveKit"]>(
        "/api/livekit/operator-room",
        {
          workspace_id: workspaceId,
          capture_session_id: session.capture_session.id,
        },
        `operator-room-${session.capture_session.id}-${Date.now()}`,
      );
      const operatorSession: OperatorSession = {
        workspaceId,
        processId,
        captureSessionId: session.capture_session.id,
        language,
        mode: "operator_voice",
        startedAt: new Date().toISOString(),
        liveKit,
      };
      window.localStorage.setItem(
        OPERATOR_SESSION_KEY,
        JSON.stringify(operatorSession),
      );
      router.push(`/process/${processId}/capture/voice/live`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not start the operator interview.",
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="mx-auto flex max-w-[620px] flex-col items-center gap-8 rounded-lg border border-subtle bg-surface px-8 py-10 shadow-card">
      <div className="grid size-16 place-items-center rounded-lg border border-subtle bg-muted text-ink">
        <Mic size={28} aria-hidden />
      </div>
      <div className="space-y-2 text-center">
        <h2 className="text-[18px] font-semibold tracking-tight text-ink">
          Talk through {processName}
        </h2>
        <p className="mx-auto max-w-[500px] text-[12.5px] leading-relaxed text-ink-secondary">
          Otto will ask about exact steps, decisions, handoffs, systems,
          exceptions, and workarounds, then use the transcript as evidence for
          the process map.
        </p>
      </div>
      <div className="flex flex-col items-center gap-3">
        <div className="inline-flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
          <Globe size={12} aria-hidden /> Select interview language
        </div>
        <LanguageSelect value={language} onChange={setLanguage} />
      </div>
      <label className="flex max-w-[480px] items-start gap-2 rounded-md border border-subtle bg-canvas px-3 py-2.5 text-[12px] leading-relaxed text-ink-secondary">
        <input
          type="checkbox"
          checked={consentGiven}
          onChange={(event) => setConsentGiven(event.target.checked)}
          className="mt-0.5 size-4 accent-[var(--solid)]"
          disabled={starting}
        />
        <span>
          I consent to this operator interview being transcribed and analyzed
          for process mapping. Audio recording is off unless workspace
          retention is enabled.
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
          onClick={() => router.push(`/process/${processId}/capture`)}
          disabled={starting}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={startInterview}
          disabled={starting || !consentGiven}
        >
          {starting ? (
            <>
              <Loader2 size={14} className="animate-spin" aria-hidden />
              Starting
            </>
          ) : (
            "Start Voice Interview"
          )}
        </Button>
      </div>
    </section>
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
