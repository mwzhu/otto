"use client";

import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Send,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { AnimatedDots } from "@/components/common/AnimatedDots";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { computeCoverageSummary } from "@/lib/interview/director/coverage-meter";
import { DIRECTOR_SESSION_KEY } from "@/app/onboarding/voice/VoicePreStartClient";

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

type TranscriptMessage = {
  id: string;
  speaker: "director" | "agent";
  text: string;
  ts: string;
  turn_index?: number | null;
  stage_name?: string | null;
};

type TurnTelemetry = {
  turn_index?: number;
  latency_ms?: {
    ingest_ms?: number;
    plan_ms?: number;
    respond_ms?: number;
    dispatch_ms?: number;
    pre_tts_total_ms?: number;
    speech_pre_tts_total_ms?: number;
    ttfa_ms?: number;
    speech_latency_ms?: number;
    extraction_latency_ms?: number;
    steering_lag_ms?: number;
    steering_lag_turns?: number;
    pending_extraction_count?: number;
    checker_violation_count?: number;
    stale_question_count?: number;
    slot_update_latency_ms?: number;
  };
  planner_runtime?: string;
  extraction_status?: "pending" | "complete" | "failed";
  checker_status?: "complete" | "failed";
  checker_violation_count?: number;
  stale_question_count?: number;
  degraded_quality?: boolean;
  degraded_reasons?: string[];
};

type CoverageSlot = {
  slot_path: string;
  candidate_process_id?: string;
  label: string;
  priority: number;
  status:
    | "empty"
    | "partial"
    | "filled"
    | "asked_unknown"
    | "conflicting"
    | "pending_re_extract";
  confidence: number;
  evidence_count: number;
  value: unknown;
};

type DirectorTurnResponse = {
  next_prompt: string;
  slot_updates: Array<{
    slot_path: string;
    candidate_process_id?: string;
    status: CoverageSlot["status"];
    confidence: number;
    value?: unknown;
    evidence_ids: string[];
  }>;
  candidate_process_ids: string[];
  coverage_slots?: CoverageSlot[];
  degraded_quality: boolean;
  degraded_reasons?: string[];
};

type TranscriptHistoryResponse = {
  messages: Array<{
    id: string;
    speaker: TranscriptMessage["speaker"];
    text: string;
    ts: string;
    turn_index: number | null;
    stage_name?: string | null;
  }>;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<{
          isFinal: boolean;
          0: { transcript: string; confidence?: number };
        }>;
      }) => void)
    | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type LiveKitAudioTrack = {
  attach?: () => HTMLMediaElement;
  detach?: () => HTMLMediaElement[];
  stop?: () => void;
  mute?: () => Promise<void> | void;
};

type LiveKitParticipantLike = {
  identity?: string;
};

type LiveKitRoomLike = {
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => void;
  localParticipant: {
    setMicrophoneEnabled?: (enabled: boolean) => Promise<void>;
    publishTrack?: (
      track: LiveKitAudioTrack,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    publishData?: (
      payload: Uint8Array,
      options?: { reliable?: boolean; topic?: string },
    ) => Promise<void>;
  };
  on: (event: string, handler: (...args: unknown[]) => void) => LiveKitRoomLike;
  off?: (event: string, handler: (...args: unknown[]) => void) => LiveKitRoomLike;
};

type LiveKitClientModule = {
  Room: new (options?: Record<string, unknown>) => LiveKitRoomLike;
  RoomEvent: Record<string, string>;
  Track?: { Kind?: { Audio?: string }; Source?: { Microphone?: string } };
  createLocalAudioTrack?: () => Promise<LiveKitAudioTrack>;
};

const DIRECTOR_SESSION_CHANGED_EVENT = "otto.directorInterview.session.changed";
const MAX_LIVEKIT_RECONNECT_ATTEMPTS = 3;

export function TranscriptChat({ nextHref }: { nextHref: string }) {
  const router = useRouter();
  const session = useSyncExternalStore(
    subscribeDirectorSession,
    readStoredDirectorSession,
    () => null,
  );
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [coverage, setCoverage] = useState<CoverageSlot[]>([]);
  const [draft, setDraft] = useState("");
  const [interim, setInterim] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [turnWaitMessage, setTurnWaitMessage] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [voiceFallback, setVoiceFallback] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(() =>
    Boolean(getSpeechRecognitionCtor()),
  );
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [, setLastTelemetry] = useState<TurnTelemetry | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const liveKitRoomRef = useRef<LiveKitRoomLike | null>(null);
  const liveKitConnectingRef = useRef<Promise<void> | null>(null);
  const liveKitConnectedSessionRef = useRef<string | null>(null);
  const liveKitMicTrackRef = useRef<LiveKitAudioTrack | null>(null);
  const liveKitAudioElsRef = useRef<HTMLMediaElement[]>([]);
  const expectedLiveKitDisconnectRef = useRef(false);
  const liveKitReconnectTimerRef = useRef<number | null>(null);
  const liveKitReconnectAttemptsRef = useRef(0);
  const hydratedSessionRef = useRef<string | null>(null);
  const liveKitDirectorTurnIndexesRef = useRef(new Set<number>());
  const liveKitAgentTurnKeysRef = useRef(new Set<string>());
  const lastFinalRef = useRef("");
  const activeCaptureSessionRef = useRef<string | null>(null);
  const statusRef = useRef({ listening: false, paused: false, muted: false });
  const completionNavigationStartedRef = useRef(false);

  useEffect(() => {
    statusRef.current = { listening, paused, muted };
  }, [listening, paused, muted]);

  const effectiveRoomMode = voiceFallback ? "simulated" : session?.roomMode;

  const hydrateTranscript = useCallback(async (activeSession: DirectorSession) => {
    const history = await refreshTranscript(activeSession);
    setMessages((current) => mergeTranscriptMessages(current, history));
    liveKitDirectorTurnIndexesRef.current = new Set(
      history
        .filter(
          (message) =>
            message.speaker === "director" &&
            typeof message.turn_index === "number",
        )
        .map((message) => message.turn_index as number),
    );
    liveKitAgentTurnKeysRef.current = new Set(
      history
        .filter(
          (message) =>
            message.speaker === "agent" &&
            typeof message.turn_index === "number",
        )
        .map((message) =>
          agentMessageKey(
            message.stage_name ?? "director.turn",
            message.turn_index as number,
          ),
        ),
    );
  }, []);

  useEffect(() => {
    if (session) {
      if (hydratedSessionRef.current !== session.captureSessionId) {
        hydratedSessionRef.current = session.captureSessionId;
        hydrateTranscript(session).catch(() => {});
      }
      refreshCoverage(session).then(setCoverage).catch(() => {});
    }
  }, [hydrateTranscript, session]);

  useEffect(() => {
    const previous = activeCaptureSessionRef.current;
    const current = session?.captureSessionId ?? null;
    if (previous && current && previous !== current) {
      expectedLiveKitDisconnectRef.current = true;
      clearLiveKitReconnectTimer(liveKitReconnectTimerRef);
      recognitionRef.current?.abort();
      disconnectLiveKitRoom(liveKitRoomRef, liveKitMicTrackRef, liveKitAudioElsRef);
      liveKitConnectedSessionRef.current = null;
      setListening(false);
      setElapsed(0);
    }
    activeCaptureSessionRef.current = current;
  }, [session?.captureSessionId]);

  useEffect(() => {
    return () => {
      expectedLiveKitDisconnectRef.current = true;
      clearLiveKitReconnectTimer(liveKitReconnectTimerRef);
      recognitionRef.current?.abort();
      disconnectLiveKitRoom(liveKitRoomRef, liveKitMicTrackRef, liveKitAudioElsRef);
      liveKitConnectedSessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!listening || paused) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [listening, paused]);

  // Weighted coverage (Task 13): partial slots carry real extracted data, so
  // they earn fractional credit instead of reading as empty. See
  // computeCoverageSummary for the weighting.
  const { filledSlots, partialSlots, totalSlots, coveragePercent } = useMemo(
    () => computeCoverageSummary(coverage),
    [coverage],
  );
  const displayMessages = useMemo(
    () =>
      listening
        ? messages
        : messages.filter((message) => !isDirectorOpeningMessage(message)),
    [listening, messages],
  );
  const waitingForFirstAgentMessage = Boolean(
    session && displayMessages.length === 0 && listening,
  );
  const showStartInterviewPrompt = Boolean(
    session && displayMessages.length === 0 && !listening && !submitting,
  );
  const visibleError =
    !listening && isLiveKitPlaybackBlockedError(error) ? null : error;

  const appendMessage = useCallback((
    speaker: TranscriptMessage["speaker"],
    text: string,
    turnIndex: number | null = null,
    stageName: string | null = null,
  ) => {
    setMessages((current) => [
      ...current,
      {
        id: `${speaker}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        speaker,
        text,
        turn_index: turnIndex,
        stage_name: stageName,
        ts: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      },
    ]);
  }, []);
  const updateAgentMessageForTurn = useCallback((
    turnIndex: number,
    stageName: string,
    text: string,
  ) => {
    setMessages((current) => {
      const index = current.findLastIndex(
        (message) =>
          message.speaker === "agent" &&
          message.turn_index === turnIndex &&
          (message.stage_name ?? "director.turn") === stageName,
      );
      if (index < 0) {
        if (!text) return current;
        return [
          ...current,
          {
            id: `agent-${stageName}-${turnIndex}`,
            speaker: "agent",
            text,
            turn_index: turnIndex,
            stage_name: stageName,
            ts: new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
          },
        ];
      }
      return current.map((message, messageIndex) =>
        messageIndex === index ? { ...message, text } : message,
      );
    });
  }, []);
  const removeAgentMessageForTurn = useCallback((turnIndex: number, stageName: string) => {
    setMessages((current) =>
      current.filter(
        (message) =>
          !(
            message.speaker === "agent" &&
            message.turn_index === turnIndex &&
            (message.stage_name ?? "director.turn") === stageName
          ),
      ),
    );
  }, []);
  const navigateToSynthesis = useCallback(async () => {
    if (!session) return;
    if (completionNavigationStartedRef.current) return;
    completionNavigationStartedRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await completeDirectorInterview(session);
    } catch (err) {
      completionNavigationStartedRef.current = false;
      setSubmitting(false);
      setError(
        err instanceof Error
          ? err.message
          : "The interview stopped, but completion did not save. Press End again to retry.",
      );
      return;
    }
    expectedLiveKitDisconnectRef.current = true;
    disconnectLiveKitRoom(liveKitRoomRef, liveKitMicTrackRef, liveKitAudioElsRef);
    liveKitConnectedSessionRef.current = null;
    clearStoredDirectorSession();
    router.push(
      `/synthesis?next=${encodeURIComponent(nextHref)}&workspace_id=${encodeURIComponent(
        session.workspaceId,
      )}&capture_session_id=${encodeURIComponent(
        session.captureSessionId,
      )}`,
    );
  }, [nextHref, router, session]);

  const navigateToSynthesisAfterWorkerComplete = useCallback(() => {
    if (!session) return;
    completionNavigationStartedRef.current = true;
    setSubmitting(true);
    setError(null);
    expectedLiveKitDisconnectRef.current = true;
    disconnectLiveKitRoom(liveKitRoomRef, liveKitMicTrackRef, liveKitAudioElsRef);
    liveKitConnectedSessionRef.current = null;
    clearStoredDirectorSession();
    router.push(
      `/synthesis?next=${encodeURIComponent(nextHref)}&workspace_id=${encodeURIComponent(
        session.workspaceId,
      )}&capture_session_id=${encodeURIComponent(
        session.captureSessionId,
      )}`,
    );
  }, [nextHref, router, session]);

  const submitTurn = useCallback(
    async (utterance: string) => {
      const text = utterance.trim();
      if (!session || !text || submitting) return;
      setSubmitting(true);
      setTurnWaitMessage(null);
      setError(null);
      appendMessage("director", text);
      setDraft("");
      setInterim("");
      const slowTurnTimer = window.setTimeout(() => {
        setTurnWaitMessage(
          "Operations Notes are still updating. Your answer is saved locally and Otto will continue once the turn response returns.",
        );
      }, 6000);

      try {
        const response = await postJson<DirectorTurnResponse>(
          `/api/director-interviews/${session.captureSessionId}/turns`,
          {
            workspace_id: session.workspaceId,
            utterance: text,
          },
          `director-turn-${session.captureSessionId}-${Date.now()}`,
        );
        appendMessage("agent", response.next_prompt);
        const nextCoverage = await coverageUpdateFromPayload(session, response);
        if (nextCoverage) setCoverage(nextCoverage);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the turn.");
      } finally {
        window.clearTimeout(slowTurnTimer);
        setTurnWaitMessage(null);
        setSubmitting(false);
      }
    },
    [appendMessage, session, submitting],
  );

  useEffect(() => {
    if (session?.roomMode !== "livekit") return;
    activeCaptureSessionRef.current = session.captureSessionId;
    expectedLiveKitDisconnectRef.current = false;
    void connectLiveKit({
      session,
      publishMicrophone: false,
      startAgent: false,
      surfaceErrors: false,
      appendMessage,
      updateAgentMessageForTurn,
      removeAgentMessageForTurn,
      setCoverage,
      setError,
      setLastTelemetry,
      setListening,
      setMuted,
      setPaused,
      onCompleted: navigateToSynthesisAfterWorkerComplete,
      roomRef: liveKitRoomRef,
      connectingRef: liveKitConnectingRef,
      connectedSessionRef: liveKitConnectedSessionRef,
      activeCaptureSessionRef,
      micTrackRef: liveKitMicTrackRef,
      audioElsRef: liveKitAudioElsRef,
      expectedDisconnectRef: expectedLiveKitDisconnectRef,
      reconnectTimerRef: liveKitReconnectTimerRef,
      reconnectAttemptsRef: liveKitReconnectAttemptsRef,
      directorTurnIndexesRef: liveKitDirectorTurnIndexesRef,
      agentTurnKeysRef: liveKitAgentTurnKeysRef,
      statusRef,
      onCompletionFailed: () => {
        completionNavigationStartedRef.current = false;
        setSubmitting(false);
      },
      enableTypedFallback: () => undefined,
      rehydrateTranscript: () => hydrateTranscript(session),
    }).catch(() => undefined);
  }, [
    appendMessage,
    hydrateTranscript,
    navigateToSynthesisAfterWorkerComplete,
    removeAgentMessageForTurn,
    session,
    updateAgentMessageForTurn,
  ]);

  const startListening = useCallback(() => {
    if (!session) return;
    activeCaptureSessionRef.current = session.captureSessionId;
    if (effectiveRoomMode === "livekit") {
      expectedLiveKitDisconnectRef.current = false;
      clearLiveKitReconnectTimer(liveKitReconnectTimerRef);
      liveKitReconnectAttemptsRef.current = 0;
      setListening(true);
      setMuted(false);
      setPaused(false);
      statusRef.current = {
        ...statusRef.current,
        listening: true,
        muted: false,
        paused: false,
      };
      void connectLiveKit({
        session,
        publishMicrophone: true,
        startAgent: true,
        surfaceErrors: true,
        appendMessage,
        updateAgentMessageForTurn,
        removeAgentMessageForTurn,
        setCoverage,
        setError,
        setLastTelemetry,
        setListening,
        setMuted,
        setPaused,
        onCompleted: navigateToSynthesisAfterWorkerComplete,
        roomRef: liveKitRoomRef,
        connectingRef: liveKitConnectingRef,
        connectedSessionRef: liveKitConnectedSessionRef,
        activeCaptureSessionRef,
        micTrackRef: liveKitMicTrackRef,
        audioElsRef: liveKitAudioElsRef,
        expectedDisconnectRef: expectedLiveKitDisconnectRef,
        reconnectTimerRef: liveKitReconnectTimerRef,
        reconnectAttemptsRef: liveKitReconnectAttemptsRef,
        directorTurnIndexesRef: liveKitDirectorTurnIndexesRef,
        agentTurnKeysRef: liveKitAgentTurnKeysRef,
        statusRef,
        onCompletionFailed: () => {
          completionNavigationStartedRef.current = false;
          setSubmitting(false);
        },
        enableTypedFallback: () => {
          expectedLiveKitDisconnectRef.current = true;
          clearLiveKitReconnectTimer(liveKitReconnectTimerRef);
          disconnectLiveKitRoom(liveKitRoomRef, liveKitMicTrackRef, liveKitAudioElsRef);
          liveKitConnectedSessionRef.current = null;
          setVoiceFallback(true);
          setListening(false);
          setMuted(false);
          setPaused(false);
          statusRef.current = {
            ...statusRef.current,
            listening: false,
            muted: false,
            paused: false,
          };
        },
        rehydrateTranscript: () => hydrateTranscript(session),
      });
      return;
    }
    const Recognition = getSpeechRecognitionCtor();
    if (!Recognition) {
      setSpeechSupported(false);
      setError("Speech recognition is not available in this browser. Type your answer below.");
      return;
    }

    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = session.language || "en";
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += text;
        else interimText += text;
      }
      if (interimText) setInterim(interimText.trim());
      const normalizedFinal = finalText.trim();
      if (normalizedFinal && normalizedFinal !== lastFinalRef.current) {
        lastFinalRef.current = normalizedFinal;
        void submitTurn(normalizedFinal);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed") {
        setError("Microphone permission was blocked. Type your answer below or allow the mic and try again.");
        setListening(false);
      }
    };
    recognition.onend = () => {
      const shouldRestart =
        statusRef.current.listening &&
        !statusRef.current.paused &&
        !statusRef.current.muted;
      if (shouldRestart) {
        window.setTimeout(() => {
          try {
            recognition.start();
          } catch {
            // Browser engines throw if recognition is already starting.
          }
        }, 150);
      }
    };
    recognitionRef.current = recognition;
    setMuted(false);
    setPaused(false);
    setListening(true);
    try {
      recognition.start();
    } catch {
      // No-op when a start is already in progress.
    }
  }, [
    appendMessage,
    effectiveRoomMode,
    hydrateTranscript,
    navigateToSynthesisAfterWorkerComplete,
    session,
    submitTurn,
    updateAgentMessageForTurn,
    removeAgentMessageForTurn,
  ]);

  const stopRecognition = useCallback((nextListening = false) => {
    statusRef.current = { ...statusRef.current, listening: nextListening };
    setListening(nextListening);
    setInterim("");
    if (effectiveRoomMode === "livekit") {
      void liveKitRoomRef.current?.localParticipant.setMicrophoneEnabled?.(nextListening);
      if (!nextListening) {
        expectedLiveKitDisconnectRef.current = true;
        clearLiveKitReconnectTimer(liveKitReconnectTimerRef);
        disconnectLiveKitRoom(liveKitRoomRef, liveKitMicTrackRef, liveKitAudioElsRef);
        liveKitConnectedSessionRef.current = null;
      }
      return;
    }
    try {
      recognitionRef.current?.stop();
    } catch {
      // Ignore browser recognition lifecycle noise.
    }
  }, [effectiveRoomMode]);

  async function completeInterview() {
    if (!session) return;
    if (completionNavigationStartedRef.current) return;
    completionNavigationStartedRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (effectiveRoomMode === "livekit") {
        expectedLiveKitDisconnectRef.current = true;
        clearLiveKitReconnectTimer(liveKitReconnectTimerRef);
        const endControlSent = await sendLiveKitControl(
          liveKitRoomRef.current,
          "end",
          session.captureSessionId,
        ).catch(() => false);
        if (!endControlSent) {
          disconnectLiveKitRoom(liveKitRoomRef, liveKitMicTrackRef, liveKitAudioElsRef);
          liveKitConnectedSessionRef.current = null;
          await completeDirectorInterview(session);
          clearStoredDirectorSession();
          router.push(
            `/synthesis?next=${encodeURIComponent(nextHref)}&workspace_id=${encodeURIComponent(
              session.workspaceId,
            )}&capture_session_id=${encodeURIComponent(
              session.captureSessionId,
            )}`,
          );
          return;
        }
        await liveKitRoomRef.current?.localParticipant
          .setMicrophoneEnabled?.(false)
          .catch(() => undefined);
        setListening(false);
        statusRef.current = { ...statusRef.current, listening: false };
        disconnectLiveKitRoom(liveKitRoomRef, liveKitMicTrackRef, liveKitAudioElsRef);
        liveKitConnectedSessionRef.current = null;
        clearStoredDirectorSession();
        router.push(
          `/synthesis?next=${encodeURIComponent(nextHref)}&workspace_id=${encodeURIComponent(
            session.workspaceId,
          )}&capture_session_id=${encodeURIComponent(
            session.captureSessionId,
          )}`,
        );
        return;
      } else {
        stopRecognition(false);
      }
      await completeDirectorInterview(session);
      clearStoredDirectorSession();
      router.push(
        `/synthesis?next=${encodeURIComponent(nextHref)}&workspace_id=${encodeURIComponent(
          session.workspaceId,
        )}&capture_session_id=${encodeURIComponent(
          session.captureSessionId,
        )}`,
      );
    } catch (err) {
      completionNavigationStartedRef.current = false;
      setError(
        err instanceof Error
          ? err.message
          : "The interview stopped, but completion did not save. Press End again to retry.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!session) {
    return <NoActiveSession onStart={() => router.push("/onboarding/voice")} />;
  }

  return (
    <div className="mx-auto grid w-full max-w-[1040px] gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="flex min-h-[620px] flex-col rounded-lg border border-subtle bg-surface shadow-card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex size-2.5 rounded-full",
                listening && !paused && !muted
                  ? "animate-pulse bg-success"
                  : "bg-ink-muted",
              )}
            />
            <div>
              <p className="text-[12px] font-semibold text-ink">
                Director interview
              </p>
              <p className="text-[11px] text-ink-muted">
                {formatTime(elapsed)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => {
                if (muted) {
                  setMuted(false);
                  statusRef.current = { ...statusRef.current, muted: false };
                  if (effectiveRoomMode === "livekit") {
                    void liveKitRoomRef.current?.localParticipant.setMicrophoneEnabled?.(
                      !paused,
                    )?.catch(() => undefined);
                    void sendLiveKitControl(
                      liveKitRoomRef.current,
                      "unmute",
                      session.captureSessionId,
                    ).catch(() => undefined);
                  } else if (listening && !paused) {
                    startListening();
                  }
                } else {
                  setMuted(true);
                  statusRef.current = { ...statusRef.current, muted: true };
                  if (effectiveRoomMode === "livekit") {
                    void liveKitRoomRef.current?.localParticipant.setMicrophoneEnabled?.(
                      false,
                    )?.catch(() => undefined);
                    void sendLiveKitControl(
                      liveKitRoomRef.current,
                      "mute",
                      session.captureSessionId,
                    ).catch(() => undefined);
                  } else {
                    stopRecognition(true);
                  }
                }
              }}
              disabled={effectiveRoomMode !== "livekit" && !speechSupported}
              title={muted ? "Unmute microphone" : "Mute microphone"}
            >
              {muted ? <MicOff size={14} aria-hidden /> : <Mic size={14} aria-hidden />}
              {muted ? "Unmute" : "Mute"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => {
                setPaused((value) => {
                  const next = !value;
                  statusRef.current = { ...statusRef.current, paused: next };
                  if (effectiveRoomMode === "livekit") {
                    void liveKitRoomRef.current?.localParticipant.setMicrophoneEnabled?.(
                      !next && !muted,
                    )?.catch(() => undefined);
                    void sendLiveKitControl(
                      liveKitRoomRef.current,
                      next ? "pause" : "resume",
                      session.captureSessionId,
                    ).catch(() => undefined);
                  } else if (next) {
                    stopRecognition(true);
                  } else if (listening && !muted) {
                    startListening();
                  }
                  return next;
                });
              }}
              disabled={!listening}
              title={paused ? "Resume interview" : "Pause interview"}
            >
              {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              size="sm"
              type="button"
              onClick={completeInterview}
              disabled={submitting}
              title="End interview"
            >
              <Square size={13} aria-hidden />
              End
            </Button>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
          {showStartInterviewPrompt ? (
            <div className="flex min-h-full flex-col items-center justify-center text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-solid text-canvas shadow-[0_12px_30px_rgba(24,24,27,0.18)]">
                <Mic size={18} aria-hidden />
              </div>
              <h2 className="mt-4 text-[17px] font-semibold tracking-tight text-ink">
                Start Interview
              </h2>
              <p className="mt-2 max-w-[360px] text-[12.5px] leading-relaxed text-ink-secondary">
                Otto will begin speaking after you start the mic.
              </p>
              <Button
                type="button"
                size="lg"
                className="mt-5 min-w-[190px] shadow-[0_16px_34px_rgba(24,24,27,0.22)] ring-4 ring-solid/10"
                onClick={startListening}
                disabled={(effectiveRoomMode !== "livekit" && !speechSupported) || submitting}
              >
                <Mic size={15} aria-hidden />
                Start mic
              </Button>
            </div>
          ) : null}
          {waitingForFirstAgentMessage ? (
            <div className="flex min-h-full flex-col items-center justify-center text-center">
              <div className="rounded-lg border border-subtle bg-muted px-3.5 py-3">
                <AnimatedDots />
              </div>
              <p className="mt-3 text-[12.5px] text-ink-secondary">
                Otto is about to start speaking.
              </p>
            </div>
          ) : null}
          {displayMessages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "flex",
                message.speaker === "director" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[78%] rounded-lg px-3.5 py-3 text-[13px] leading-relaxed",
                  message.speaker === "director"
                    ? "bg-solid text-canvas"
                    : "border border-subtle bg-muted text-ink",
                )}
              >
                <div className="mb-1 flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-wide opacity-70">
                  <span>{message.speaker === "director" ? "You" : BRAND.name}</span>
                  <span>{message.ts}</span>
                </div>
                <p>{message.text}</p>
              </div>
            </div>
          ))}
          {submitting && (
            <div className="flex justify-start">
              <div className="rounded-lg border border-subtle bg-muted px-3.5 py-3">
                <AnimatedDots />
              </div>
            </div>
          )}
        </div>

        <footer className="space-y-3 border-t border-subtle px-4 py-4">
          {interim && (
            <p className="rounded-md bg-muted px-3 py-2 text-[12.5px] text-ink-secondary">
              {interim}
            </p>
          )}
          {visibleError && (
            <p className="rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-[12px] text-danger">
              {visibleError}
            </p>
          )}
          {turnWaitMessage && (
            <p className="rounded-md border border-subtle bg-muted px-3 py-2 text-[12px] text-ink-secondary">
              {turnWaitMessage}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant={listening ? "secondary" : "primary"}
              onClick={() => {
                if (listening) {
                  if (effectiveRoomMode === "livekit") {
                    void sendLiveKitControl(
                      liveKitRoomRef.current,
                      "pause",
                      session.captureSessionId,
                    ).catch(() => undefined);
                  }
                  stopRecognition(false);
                } else {
                  startListening();
                }
              }}
              disabled={(effectiveRoomMode !== "livekit" && !speechSupported) || submitting}
              className="sm:w-[150px]"
            >
              {listening ? <MicOff size={14} aria-hidden /> : <Mic size={14} aria-hidden />}
              {listening ? "Stop mic" : "Start mic"}
            </Button>
            <form
              className="flex min-w-0 flex-1 gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitTurn(draft);
              }}
            >
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Type an answer or correction..."
                className="min-w-0 flex-1 rounded-md border border-subtle bg-canvas px-3 text-[13px] text-ink outline-none transition placeholder:text-ink-muted focus:border-ink-muted"
                disabled={submitting}
              />
              <Button type="submit" disabled={!draft.trim() || submitting}>
                {submitting ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden />
                ) : (
                  <Send size={14} aria-hidden />
                )}
                Send
              </Button>
            </form>
          </div>
          {session.roomReason && (
            <p className="text-[11.5px] text-ink-muted">{session.roomReason}</p>
          )}
        </footer>
      </section>

      <aside className="rounded-lg border border-subtle bg-surface shadow-card">
        <header className="border-b border-subtle px-4 py-3">
          <p className="text-[12px] font-semibold text-ink">Operations Notes</p>
          <p className="mt-1 text-[11.5px] text-ink-muted">
            {filledSlots} filled
            {partialSlots > 0 ? ` · ${partialSlots} partial` : ""} of{" "}
            {totalSlots} slots · {coveragePercent}%
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-solid transition-[width]"
              style={{ width: `${coveragePercent}%` }}
            />
          </div>
        </header>
        <div className="max-h-[548px] overflow-y-auto p-3">
          {coverage.length === 0 ? (
            <div className="rounded-md border border-dashed border-subtle px-3 py-8 text-center text-[12.5px] leading-relaxed text-ink-secondary">
              Notes will fill in as the interview captures process names,
              owners, systems, frequency, pain points, and risk.
            </div>
          ) : (
            <ul className="space-y-2">
              {coverage.map((slot) => (
                <li
                  key={`${slot.candidate_process_id ?? "global"}:${slot.slot_path}`}
                  className="rounded-md border border-subtle bg-canvas px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[12px] font-medium leading-snug text-ink">
                      {slot.label}
                    </p>
                    <StatusPill status={slot.status} />
                  </div>
                  <p className="mt-1 text-[11.5px] text-ink-muted">
                    {slot.evidence_count} evidence link
                    {slot.evidence_count === 1 ? "" : "s"}
                  </p>
                  {slot.value ? (
                    <p className="mt-2 line-clamp-2 text-[11.5px] leading-relaxed text-ink-secondary">
                      {summarizeSlotValue(slot.value)}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function NoActiveSession({ onStart }: { onStart: () => void }) {
  return (
    <div className="mx-auto max-w-[680px] rounded-lg border border-subtle bg-surface px-6 py-12 text-center shadow-card">
      <div className="mx-auto grid size-10 place-items-center rounded-full bg-muted text-[13px] font-semibold text-ink">
        {BRAND.name.slice(0, 1)}
      </div>
      <h2 className="mt-4 text-[15px] font-semibold tracking-tight text-ink">
        Start a director interview session
      </h2>
      <p className="mx-auto mt-2 max-w-[440px] text-[12.5px] leading-relaxed text-ink-secondary">
        The live room needs a capture session before it can persist transcript
        turns and Operations Notes.
      </p>
      <Button type="button" className="mt-5" onClick={onStart}>
        Start from pre-check
      </Button>
    </div>
  );
}

function mergeTranscriptMessages(
  current: TranscriptMessage[],
  history: TranscriptMessage[],
) {
  if (current.length === 0) return history;
  if (history.length === 0) return current;
  const seen = new Set(history.map(transcriptMessageIdentity));
  const optimistic = current.filter(
    (message) => !seen.has(transcriptMessageIdentity(message)),
  );
  return [...history, ...optimistic];
}

function isDirectorOpeningMessage(message: TranscriptMessage) {
  return message.speaker === "agent" && message.stage_name === "director.opening";
}

function isLiveKitPlaybackBlockedError(error: string | null) {
  return (
    error ===
    "Agent audio is ready, but the browser blocked playback. Press Start mic again."
  );
}

function transcriptMessageIdentity(message: TranscriptMessage) {
  if (typeof message.turn_index === "number") {
    return [
      message.speaker,
      message.turn_index,
      message.stage_name ?? "director.turn",
      message.text,
    ].join(":");
  }
  return [message.speaker, message.stage_name ?? "", message.text].join(":");
}

function StatusPill({ status }: { status: CoverageSlot["status"] }) {
  const tone =
    status === "filled" || status === "asked_unknown"
      ? "success"
      : status === "conflicting" || status === "pending_re_extract"
        ? "warn"
        : "neutral";
  return (
    <Pill tone={tone} className="shrink-0">
      {status.replaceAll("_", " ")}
    </Pill>
  );
}

async function refreshCoverage(
  session: DirectorSession,
  fallbackUpdates: DirectorTurnResponse["slot_updates"] = [],
): Promise<CoverageSlot[]> {
  try {
    const response = await fetch(
      `/api/director-interviews/${session.captureSessionId}/coverage?workspace_id=${session.workspaceId}`,
    );
    if (!response.ok) throw new Error("coverage unavailable");
    const payload = (await response.json()) as { slots: CoverageSlot[] };
    return payload.slots;
  } catch {
    if (fallbackUpdates.length > 0) {
      return fallbackUpdates.map((slot) => ({
        slot_path: slot.slot_path,
        label: labelForSlot(slot.slot_path),
        priority: 0,
        status: slot.status,
        confidence: slot.confidence,
        evidence_count: slot.evidence_ids.length,
        value: slot.value ?? null,
      }));
    }
    return [];
  }
}

async function refreshTranscript(
  session: DirectorSession,
): Promise<TranscriptMessage[]> {
  const response = await fetch(
    `/api/director-interviews/${session.captureSessionId}/turns?workspace_id=${session.workspaceId}`,
  );
  if (!response.ok) throw new Error("transcript unavailable");
  const payload = (await response.json()) as TranscriptHistoryResponse;
  return payload.messages.map((message) => ({
    id: message.id,
    speaker: message.speaker,
    text: message.text,
    turn_index: message.turn_index,
    stage_name: message.stage_name,
    ts: new Date(message.ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
  }));
}

function readStoredDirectorSession() {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(DIRECTOR_SESSION_KEY);
  if (!stored) {
    cachedSessionRaw = null;
    cachedSessionParsed = null;
    return null;
  }
  if (stored === cachedSessionRaw) return cachedSessionParsed;
  try {
    cachedSessionRaw = stored;
    cachedSessionParsed = JSON.parse(stored) as DirectorSession;
    return cachedSessionParsed;
  } catch {
    window.localStorage.removeItem(DIRECTOR_SESSION_KEY);
    cachedSessionRaw = null;
    cachedSessionParsed = null;
    return null;
  }
}

let cachedSessionRaw: string | null = null;
let cachedSessionParsed: DirectorSession | null = null;

function subscribeDirectorSession(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(DIRECTOR_SESSION_CHANGED_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(DIRECTOR_SESSION_CHANGED_EVENT, onStoreChange);
  };
}

function writeStoredDirectorSession(session: DirectorSession) {
  const raw = JSON.stringify(session);
  window.localStorage.setItem(DIRECTOR_SESSION_KEY, raw);
  cachedSessionRaw = raw;
  cachedSessionParsed = session;
  window.dispatchEvent(new Event(DIRECTOR_SESSION_CHANGED_EVENT));
}

function clearStoredDirectorSession() {
  window.localStorage.removeItem(DIRECTOR_SESSION_KEY);
  cachedSessionRaw = null;
  cachedSessionParsed = null;
  window.dispatchEvent(new Event(DIRECTOR_SESSION_CHANGED_EVENT));
}

type LiveKitConnectInput = {
  session: DirectorSession;
  publishMicrophone: boolean;
  startAgent: boolean;
  surfaceErrors: boolean;
  appendMessage: (
    speaker: TranscriptMessage["speaker"],
    text: string,
    turnIndex?: number | null,
    stageName?: string | null,
  ) => void;
  updateAgentMessageForTurn: (
    turnIndex: number,
    stageName: string,
    text: string,
  ) => void;
  removeAgentMessageForTurn: (turnIndex: number, stageName: string) => void;
  setCoverage: (coverage: CoverageSlot[]) => void;
  setError: (error: string | null) => void;
  setLastTelemetry: (telemetry: TurnTelemetry | null) => void;
  setListening: (listening: boolean) => void;
  setMuted: (muted: boolean) => void;
  setPaused: (paused: boolean) => void;
  onCompleted: () => void | Promise<void>;
  onCompletionFailed: () => void;
  roomRef: MutableRefObject<LiveKitRoomLike | null>;
  connectingRef: MutableRefObject<Promise<void> | null>;
  connectedSessionRef: MutableRefObject<string | null>;
  activeCaptureSessionRef: MutableRefObject<string | null>;
  micTrackRef: MutableRefObject<LiveKitAudioTrack | null>;
  audioElsRef: MutableRefObject<HTMLMediaElement[]>;
  expectedDisconnectRef: MutableRefObject<boolean>;
  reconnectTimerRef: MutableRefObject<number | null>;
  reconnectAttemptsRef: MutableRefObject<number>;
  directorTurnIndexesRef: MutableRefObject<Set<number>>;
  agentTurnKeysRef: MutableRefObject<Set<string>>;
  statusRef: MutableRefObject<{ listening: boolean; paused: boolean; muted: boolean }>;
  enableTypedFallback: () => void;
  rehydrateTranscript: () => Promise<void>;
};

async function connectLiveKit(input: LiveKitConnectInput) {
  if (input.connectingRef.current) {
    const pendingConnection = input.connectingRef.current;
    await pendingConnection.catch(() => undefined);
    if (
      liveKitConnectStillCurrent(input) &&
      input.roomRef.current &&
      input.connectedSessionRef.current === input.session.captureSessionId
    ) {
      input.expectedDisconnectRef.current = false;
      clearLiveKitReconnectTimer(input.reconnectTimerRef);
      input.reconnectAttemptsRef.current = 0;
      if (input.publishMicrophone) {
        const livekit = (await importLiveKitClient()) as LiveKitClientModule;
        await publishLiveKitMicrophone(input.roomRef.current, input.micTrackRef, livekit);
        await syncLiveKitControlState(
          input.roomRef.current,
          input.statusRef.current,
          input.session.captureSessionId,
        );
        if (input.startAgent) {
          await sendLiveKitControl(
            input.roomRef.current,
            "start",
            input.session.captureSessionId,
          ).catch(() => undefined);
        }
        await playLiveKitAudioElements(
          input.audioElsRef,
          input.statusRef,
          input.setError,
        );
      }
      await input.rehydrateTranscript().catch(() => undefined);
      if (input.publishMicrophone) input.setListening(true);
      return;
    }
    if (
      !liveKitConnectStillCurrent(input) ||
      (input.publishMicrophone && !input.statusRef.current.listening)
    ) {
      return;
    }
  }

  const connection = connectLiveKitOnce(input);
  input.connectingRef.current = connection;
  try {
    await connection;
  } finally {
    if (input.connectingRef.current === connection) {
      input.connectingRef.current = null;
    }
  }
}

async function connectLiveKitOnce(input: LiveKitConnectInput) {
  if (!liveKitConnectStillCurrent(input)) return;
  if (input.roomRef.current) {
    if (input.connectedSessionRef.current !== input.session.captureSessionId) {
      disconnectLiveKitRoom(input.roomRef, input.micTrackRef, input.audioElsRef);
      input.connectedSessionRef.current = null;
    } else {
      input.expectedDisconnectRef.current = false;
      clearLiveKitReconnectTimer(input.reconnectTimerRef);
      input.reconnectAttemptsRef.current = 0;
      if (input.publishMicrophone) {
        const livekit = (await importLiveKitClient()) as LiveKitClientModule;
        await publishLiveKitMicrophone(input.roomRef.current, input.micTrackRef, livekit);
        await syncLiveKitControlState(
          input.roomRef.current,
          input.statusRef.current,
          input.session.captureSessionId,
        );
        if (input.startAgent) {
          await sendLiveKitControl(
            input.roomRef.current,
            "start",
            input.session.captureSessionId,
          ).catch(() => undefined);
        }
      }
      await input.rehydrateTranscript().catch(() => undefined);
      if (input.publishMicrophone) input.setListening(true);
      return;
    }
  }
  const activeSession = hasUsableLiveKitCredentials(input.session)
    ? input.session
    : await refreshLiveKitSession(input.session, () =>
        liveKitConnectStillCurrent(input),
      ).catch((error) => {
        if (hasUsableLiveKitCredentials(input.session)) return input.session;
        throw error;
      });
  if (!liveKitConnectStillCurrent(input)) return;
  if (!activeSession.roomUrl || !activeSession.roomToken) {
    if (input.surfaceErrors) {
      input.setError("LiveKit is missing a room URL or token. Using typed fallback.");
      input.enableTypedFallback();
    }
    return;
  }

  let pendingRoom: LiveKitRoomLike | null = null;
  let localAudioTrackError: unknown = null;
  let localAudioTrackPromise: Promise<LiveKitAudioTrack | null> =
    Promise.resolve(null);
  try {
    const livekit = (await importLiveKitClient()) as LiveKitClientModule;
    const room = new livekit.Room({ adaptiveStream: true, dynacast: true });
    pendingRoom = room;
    const events = livekit.RoomEvent;
    room.on(events.TrackSubscribed ?? "trackSubscribed", (track) => {
      if (!liveKitRoomEventStillCurrent(input, room, activeSession.captureSessionId)) {
        return;
      }
      const audioTrack = track as LiveKitAudioTrack;
      const element = audioTrack.attach?.();
      if (element) {
        element.autoplay = true;
        if (element instanceof HTMLVideoElement) {
          element.playsInline = true;
        }
        element.dataset.ottoLivekitAudio = "true";
        document.body.appendChild(element);
        input.audioElsRef.current.push(element);
        if (input.statusRef.current.listening) {
          void element.play().catch(() => {
            if (input.statusRef.current.listening) {
              input.setError("Agent audio is ready, but the browser blocked playback. Press Start mic again.");
            }
          });
        }
      }
    });
    room.on(events.TrackUnsubscribed ?? "trackUnsubscribed", (track) => {
      if (!liveKitRoomEventStillCurrent(input, room, activeSession.captureSessionId)) {
        return;
      }
      const audioTrack = track as LiveKitAudioTrack;
      for (const element of audioTrack.detach?.() ?? []) {
        removeLiveKitAudioElement(input.audioElsRef, element);
      }
    });
    room.on(
      events.DataReceived ?? "dataReceived",
      (payload, participant, _kind, topic) => {
        if (topic !== "otto.director") return;
        if (!liveKitRoomEventStillCurrent(input, room, activeSession.captureSessionId)) {
          return;
        }
        const participantLike = participant as LiveKitParticipantLike | undefined;
        const participantIdentity =
          typeof participantLike?.identity === "string"
            ? participantLike.identity
            : null;
        const text =
          payload instanceof Uint8Array
            ? new TextDecoder().decode(payload)
            : typeof payload === "string"
              ? payload
              : "";
        void handleLiveKitData(
          text,
          activeSession,
          input.appendMessage,
          input.updateAgentMessageForTurn,
          input.removeAgentMessageForTurn,
          input.setCoverage,
          input.setError,
          input.setLastTelemetry,
          input.setMuted,
          input.setPaused,
          input.setListening,
          input.onCompleted,
          input.onCompletionFailed,
          input.statusRef,
          input.expectedDisconnectRef,
          input.enableTypedFallback,
          input.directorTurnIndexesRef,
          input.agentTurnKeysRef,
          participantIdentity,
        );
      },
    );
    room.on(events.Reconnecting ?? "reconnecting", () => {
      if (!liveKitRoomEventStillCurrent(input, room, activeSession.captureSessionId)) {
        return;
      }
      input.setError("Reconnecting to the voice room...");
      input.setListening(false);
    });
    room.on(events.Reconnected ?? "reconnected", () => {
      if (!liveKitRoomEventStillCurrent(input, room, activeSession.captureSessionId)) {
        return;
      }
      input.expectedDisconnectRef.current = false;
      clearLiveKitReconnectTimer(input.reconnectTimerRef);
      input.reconnectAttemptsRef.current = 0;
      input.setError(null);
      if (input.statusRef.current.listening) {
        input.setListening(true);
        input.statusRef.current = { ...input.statusRef.current, listening: true };
        void syncLiveKitControlState(
          room,
          input.statusRef.current,
          activeSession.captureSessionId,
        );
      }
      void input.rehydrateTranscript().catch(() => {
        input.setError(
          "Voice room reconnected, but transcript refresh failed. Live updates will continue.",
        );
      });
    });
    room.on(events.Disconnected ?? "disconnected", () => {
      if (
        input.roomRef.current !== room ||
        input.connectedSessionRef.current !== activeSession.captureSessionId
      ) {
        return;
      }
      input.micTrackRef.current?.stop?.();
      input.roomRef.current = null;
      if (input.connectedSessionRef.current === activeSession.captureSessionId) {
        input.connectedSessionRef.current = null;
      }
      input.micTrackRef.current = null;
      cleanupLiveKitAudioElements(input.audioElsRef);
      const shouldReconnect =
        !input.expectedDisconnectRef.current &&
        liveKitSessionStillCurrent(input, activeSession.captureSessionId) &&
        input.statusRef.current.listening;
      input.setListening(false);
      if (shouldReconnect) {
        scheduleLiveKitReconnect(input, activeSession.captureSessionId);
      }
      input.expectedDisconnectRef.current = false;
    });

    input.expectedDisconnectRef.current = false;
    clearLiveKitReconnectTimer(input.reconnectTimerRef);
    if (input.publishMicrophone) {
      localAudioTrackPromise =
        livekit.createLocalAudioTrack?.().catch((error) => {
          localAudioTrackError = error;
          return null;
        }) ?? Promise.resolve(null);
    }
    await room.connect(activeSession.roomUrl, activeSession.roomToken);
    if (
      input.expectedDisconnectRef.current ||
      (input.publishMicrophone && !input.statusRef.current.listening) ||
      !liveKitConnectStillCurrent(input)
    ) {
      await localAudioTrackPromise
        .then((track) => track?.stop?.())
        .catch(() => undefined);
      room.disconnect();
      input.setListening(false);
      return;
    }
    input.roomRef.current = room;
    input.connectedSessionRef.current = activeSession.captureSessionId;
    if (input.publishMicrophone) {
      const track = await localAudioTrackPromise;
      if (localAudioTrackError) throw localAudioTrackError;
      if (track) {
        await room.localParticipant.publishTrack?.(track, {
          source: livekit.Track?.Source?.Microphone ?? "microphone",
        });
        input.micTrackRef.current = track;
      } else {
        await room.localParticipant.setMicrophoneEnabled?.(true);
      }
    }
    if (!liveKitConnectStillCurrent(input)) {
      input.micTrackRef.current?.stop?.();
      input.micTrackRef.current = null;
      room.disconnect();
      input.setListening(false);
      return;
    }
    input.reconnectAttemptsRef.current = 0;
    if (input.publishMicrophone) {
      await syncLiveKitControlState(
        room,
        input.statusRef.current,
        activeSession.captureSessionId,
      );
      if (input.startAgent) {
        await sendLiveKitControl(
          room,
          "start",
          activeSession.captureSessionId,
        ).catch(() => undefined);
      }
      await playLiveKitAudioElements(
        input.audioElsRef,
        input.statusRef,
        input.setError,
      );
    }
    input.setError(null);
    if (input.publishMicrophone) input.setListening(true);
  } catch (error) {
    await localAudioTrackPromise
      .then((track) => track?.stop?.())
      .catch(() => undefined);
    cleanupFailedLiveKitConnection(
      input,
      pendingRoom,
      activeSession.captureSessionId,
    );
    if (!liveKitConnectStillCurrent(input)) return;
    if (input.surfaceErrors) {
      input.setError(
        error instanceof Error
          ? `LiveKit connection failed: ${error.message}`
          : "LiveKit connection failed. Use typed fallback.",
      );
      input.enableTypedFallback();
      input.setListening(false);
    }
  }
}

function liveKitConnectStillCurrent(input: LiveKitConnectInput) {
  return input.activeCaptureSessionRef.current === input.session.captureSessionId;
}

function liveKitSessionStillCurrent(
  input: LiveKitConnectInput,
  captureSessionId: string,
) {
  return input.activeCaptureSessionRef.current === captureSessionId;
}

function liveKitRoomEventStillCurrent(
  input: LiveKitConnectInput,
  room: LiveKitRoomLike,
  captureSessionId: string,
) {
  if (!liveKitSessionStillCurrent(input, captureSessionId)) return false;
  if (input.roomRef.current && input.roomRef.current !== room) return false;
  if (
    input.connectedSessionRef.current &&
    input.connectedSessionRef.current !== captureSessionId
  ) {
    return false;
  }
  return true;
}

function scheduleLiveKitReconnect(
  input: LiveKitConnectInput,
  captureSessionId: string,
) {
  clearLiveKitReconnectTimer(input.reconnectTimerRef);
  if (input.reconnectAttemptsRef.current >= MAX_LIVEKIT_RECONNECT_ATTEMPTS) {
    input.setError("Voice room disconnected. Press Start mic to reconnect.");
    input.reconnectAttemptsRef.current = 0;
    return;
  }
  input.reconnectAttemptsRef.current += 1;
  const attempt = input.reconnectAttemptsRef.current;
  const delayMs = Math.min(1000 * attempt, 5000);
  input.setError("Voice room disconnected. Reconnecting...");
  input.reconnectTimerRef.current = window.setTimeout(() => {
    input.reconnectTimerRef.current = null;
    if (
      input.expectedDisconnectRef.current ||
      !liveKitSessionStillCurrent(input, captureSessionId)
    ) {
      return;
    }
    input.statusRef.current = { ...input.statusRef.current, listening: true };
    input.setListening(true);
    void connectLiveKit(input).catch(() => undefined);
  }, delayMs);
}

function clearLiveKitReconnectTimer(
  reconnectTimerRef: MutableRefObject<number | null>,
) {
  if (reconnectTimerRef.current === null) return;
  window.clearTimeout(reconnectTimerRef.current);
  reconnectTimerRef.current = null;
}

async function importLiveKitClient() {
  return (await import("livekit-client")) as unknown as LiveKitClientModule;
}

async function publishLiveKitMicrophone(
  room: LiveKitRoomLike,
  micTrackRef: MutableRefObject<LiveKitAudioTrack | null>,
  livekit: LiveKitClientModule,
) {
  if (micTrackRef.current) {
    await room.localParticipant.setMicrophoneEnabled?.(true);
    return;
  }
  if (livekit.createLocalAudioTrack) {
    const track = await livekit.createLocalAudioTrack();
    await room.localParticipant.publishTrack?.(track, {
      source: livekit.Track?.Source?.Microphone ?? "microphone",
    });
    micTrackRef.current = track;
    return;
  }
  await room.localParticipant.setMicrophoneEnabled?.(true);
}

async function playLiveKitAudioElements(
  audioElsRef: MutableRefObject<HTMLMediaElement[]>,
  statusRef: MutableRefObject<{ listening: boolean }>,
  setError: (error: string | null) => void,
) {
  if (!statusRef.current.listening) return;
  for (const element of audioElsRef.current) {
    try {
      await element.play();
    } catch {
      if (statusRef.current.listening) {
        setError("Agent audio is ready, but the browser blocked playback. Press Start mic again.");
      }
      return;
    }
  }
}

async function refreshLiveKitSession(
  session: DirectorSession,
  shouldPersist: () => boolean = () => true,
) {
  if (session.roomMode !== "livekit") return session;
  const room = await postJson<DirectorRoomResponse>(
    "/api/livekit/director-room",
    {
      workspace_id: session.workspaceId,
      capture_session_id: session.captureSessionId,
    },
    liveKitRefreshIdempotencyKey(session.captureSessionId),
  );
  const refreshed = {
    ...session,
    roomMode: room.mode,
    roomName: room.room,
    roomUrl: room.url,
    roomToken: room.token,
    roomTokenExpiresAt: room.tokenExpiresAt,
    agentName: room.agentName,
    agentParticipantIdentity: room.agentParticipantIdentity,
    dispatchId: room.dispatchId,
    roomReason: room.reason,
  } satisfies DirectorSession;
  if (shouldPersist()) {
    writeStoredDirectorSession(refreshed);
  }
  return refreshed;
}

function liveKitRefreshIdempotencyKey(captureSessionId: string) {
  const refreshBucket = Math.floor(Date.now() / (5 * 60 * 1000));
  return `director-room-refresh-${captureSessionId}-${refreshBucket}`;
}

function hasUsableLiveKitCredentials(session: DirectorSession) {
  return Boolean(
    session.roomUrl &&
      session.roomToken &&
      liveKitTokenFresh(session.roomTokenExpiresAt),
  );
}

function liveKitTokenFresh(tokenExpiresAt: string | null) {
  if (!tokenExpiresAt) return false;
  const expiresAtMs = Date.parse(tokenExpiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > 60_000;
}

async function handleLiveKitData(
  raw: string,
  session: DirectorSession,
  appendMessage: (
    speaker: TranscriptMessage["speaker"],
    text: string,
    turnIndex?: number | null,
    stageName?: string | null,
  ) => void,
  updateAgentMessageForTurn: (
    turnIndex: number,
    stageName: string,
    text: string,
  ) => void,
  removeAgentMessageForTurn: (turnIndex: number, stageName: string) => void,
  setCoverage: (coverage: CoverageSlot[]) => void,
  setError: (error: string | null) => void,
  setLastTelemetry: (telemetry: TurnTelemetry | null) => void,
  setMuted: (muted: boolean) => void,
  setPaused: (paused: boolean) => void,
  setListening: (listening: boolean) => void,
  onCompleted: () => void | Promise<void>,
  onCompletionFailed: () => void,
  statusRef: MutableRefObject<{ listening: boolean; paused: boolean; muted: boolean }>,
  expectedDisconnectRef: MutableRefObject<boolean>,
  enableTypedFallback: () => void,
  directorTurnIndexesRef: MutableRefObject<Set<number>>,
  agentTurnKeysRef: MutableRefObject<Set<string>>,
  participantIdentity: string | null,
) {
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as {
      source?: string;
      capture_session_id?: string;
      event?: string;
      payload?: {
        transcript?: string;
        agent_utterance?: string;
        agent_utterance_delta?: string;
        delivery_status?: "completed" | "truncated" | "failed_text_fallback";
        notice_type?: string;
        message?: string;
        slot_updates?: DirectorTurnResponse["slot_updates"];
        coverage_slots?: CoverageSlot[];
        latency_ms?: TurnTelemetry["latency_ms"];
        planner_runtime?: string;
        extraction_status?: TurnTelemetry["extraction_status"];
        extraction_latency_ms?: number;
        slot_update_latency_ms?: number;
        checker_status?: TurnTelemetry["checker_status"];
        checker_violation_count?: number;
        stale_question_count?: number;
        checker_violations?: Array<{ message?: string }>;
        degraded_quality?: boolean;
        degraded_reasons?: string[];
        turn_index?: number;
        stage_name?: string;
        action?: "start" | "mute" | "unmute" | "pause" | "resume" | "end";
        paused?: boolean;
        muted?: boolean;
        ended?: boolean;
      };
    };
    if (
      parsed.source !== "otto_director_agent" ||
      parsed.capture_session_id !== session.captureSessionId ||
      !isExpectedAgentDataSender(session, participantIdentity)
    ) {
      return;
    }
    if (parsed.event === "director.turn.ingested") {
      const turnIndex = parsed.payload?.turn_index;
      if (
        typeof turnIndex === "number" &&
        parsed.payload?.transcript &&
        !directorTurnIndexesRef.current.has(turnIndex)
      ) {
        directorTurnIndexesRef.current.add(turnIndex);
        appendMessage("director", parsed.payload.transcript, turnIndex);
      }
      return;
    }
    if (parsed.event === "director.turn.agent_delta" && parsed.payload) {
      const turnIndex = parsed.payload.turn_index;
      const text = parsed.payload.agent_utterance;
      if (typeof turnIndex === "number" && typeof text === "string" && text) {
        const stageName = parsed.payload.stage_name ?? "director.turn";
        agentTurnKeysRef.current.add(agentMessageKey(stageName, turnIndex));
        updateAgentMessageForTurn(turnIndex, stageName, text);
      }
      return;
    }
    if (parsed.event === "director.turn.telemetry") {
      setLastTelemetry({
        turn_index: parsed.payload?.turn_index,
        latency_ms: parsed.payload?.latency_ms,
        planner_runtime: parsed.payload?.planner_runtime,
        extraction_status: parsed.payload?.extraction_status,
        degraded_quality: parsed.payload?.degraded_quality,
        degraded_reasons: parsed.payload?.degraded_reasons,
      });
      return;
    }
    if (parsed.event === "director.turn.extracted" && parsed.payload) {
      setLastTelemetry({
        turn_index: parsed.payload.turn_index,
        latency_ms: {
          extraction_latency_ms: parsed.payload.extraction_latency_ms,
          slot_update_latency_ms: parsed.payload.slot_update_latency_ms,
        },
        extraction_status:
          parsed.payload.extraction_status === "failed" ? "failed" : "complete",
        degraded_quality: parsed.payload.degraded_quality,
        degraded_reasons: parsed.payload.degraded_reasons,
      });
      const nextCoverage = await coverageUpdateFromPayload(session, parsed.payload);
      if (nextCoverage) setCoverage(nextCoverage);
      return;
    }
    if (parsed.event === "director.turn.output_checked" && parsed.payload) {
      const checkerViolationCount = parsed.payload.checker_violation_count ?? 0;
      const staleQuestionCount = parsed.payload.stale_question_count ?? 0;
      setLastTelemetry({
        turn_index: parsed.payload.turn_index,
        checker_status:
          parsed.payload.checker_status === "failed" ? "failed" : "complete",
        checker_violation_count: checkerViolationCount,
        stale_question_count: staleQuestionCount,
        degraded_quality:
          parsed.payload.checker_status === "failed" || checkerViolationCount > 0,
        degraded_reasons:
          parsed.payload.checker_status === "failed"
            ? ["output_checker_failed"]
            : checkerViolationCount > 0
              ? ["output_checker_violation"]
              : [],
      });
      return;
    }
    if (parsed.event === "director.control.updated") {
      if (typeof parsed.payload?.muted === "boolean") {
        setMuted(parsed.payload.muted);
        statusRef.current = { ...statusRef.current, muted: parsed.payload.muted };
      }
      if (typeof parsed.payload?.paused === "boolean") {
        setPaused(parsed.payload.paused);
        statusRef.current = { ...statusRef.current, paused: parsed.payload.paused };
      }
      if (parsed.payload?.ended === true) {
        setListening(false);
        statusRef.current = { ...statusRef.current, listening: false };
      }
      return;
    }
    if (parsed.event === "director.session.completed") {
      setListening(false);
      statusRef.current = { ...statusRef.current, listening: false };
      await onCompleted();
      return;
    }
    if (parsed.event === "director.turn.delivery_updated") {
      if (parsed.payload?.delivery_status === "failed_text_fallback") {
        setError("Audio playback failed. Otto's response is shown as text.");
      }
      if (
        parsed.payload?.delivery_status &&
        ["completed", "truncated", "failed_text_fallback"].includes(
          parsed.payload.delivery_status,
        ) &&
        typeof parsed.payload.turn_index === "number" &&
        typeof parsed.payload.agent_utterance === "string"
      ) {
        agentTurnKeysRef.current.add(
          agentMessageKey(
            parsed.payload.stage_name ?? "director.turn",
            parsed.payload.turn_index,
          ),
        );
        if (
          parsed.payload.delivery_status === "truncated" &&
          parsed.payload.agent_utterance.trim().length === 0
        ) {
          removeAgentMessageForTurn(
            parsed.payload.turn_index,
            parsed.payload.stage_name ?? "director.turn",
          );
          return;
        }
        if (parsed.payload.delivery_status === "truncated") {
          return;
        }
        updateAgentMessageForTurn(
          parsed.payload.turn_index,
          parsed.payload.stage_name ?? "director.turn",
          parsed.payload.agent_utterance,
        );
      }
      return;
    }
    if (parsed.event === "director.session.notice") {
      if (parsed.payload?.message) setError(parsed.payload.message);
      const noticeType = parsed.payload?.notice_type;
      if (noticeType === "failed_completion") {
        expectedDisconnectRef.current = false;
        onCompletionFailed();
      }
      if (noticeType === "worker_startup_failed") {
        enableTypedFallback();
        setListening(false);
        statusRef.current = { ...statusRef.current, listening: false };
      }
      if (
        typeof noticeType === "string" &&
        noticeType.endsWith("_persistence") &&
        parsed.payload?.agent_utterance
      ) {
        appendMessage("agent", parsed.payload.agent_utterance);
      }
      return;
    }
    if (parsed.event !== "director.turn.dispatched" || !parsed.payload) return;
    setError(null);
    if (parsed.payload.degraded_quality) {
      setLastTelemetry({
        turn_index: parsed.payload.turn_index,
        extraction_status: parsed.payload.extraction_status,
        degraded_quality: true,
        degraded_reasons: parsed.payload.degraded_reasons,
      });
    } else if (parsed.payload.extraction_status) {
      setLastTelemetry({
        turn_index: parsed.payload?.turn_index,
        extraction_status: parsed.payload?.extraction_status,
        degraded_quality: false,
      });
    }
    if (parsed.payload.transcript) {
      const turnIndex = parsed.payload.turn_index;
      if (
        typeof turnIndex !== "number" ||
        !directorTurnIndexesRef.current.has(turnIndex)
      ) {
        if (typeof turnIndex === "number") {
          directorTurnIndexesRef.current.add(turnIndex);
        }
        appendMessage(
          "director",
          parsed.payload.transcript,
          typeof turnIndex === "number" ? turnIndex : null,
        );
      }
    }
    if (parsed.payload.agent_utterance) {
      const turnIndex = parsed.payload.turn_index;
      const messageKey =
        typeof turnIndex === "number"
          ? agentMessageKey(parsed.payload.stage_name ?? "director.turn", turnIndex)
          : null;
      if (
        typeof turnIndex !== "number" ||
        !agentTurnKeysRef.current.has(messageKey!)
      ) {
        if (typeof turnIndex === "number") {
          agentTurnKeysRef.current.add(messageKey!);
        }
        appendMessage(
          "agent",
          parsed.payload.agent_utterance,
          typeof turnIndex === "number" ? turnIndex : null,
          parsed.payload.stage_name ?? "director.turn",
        );
      }
    }
    const nextCoverage = await coverageUpdateFromPayload(session, parsed.payload);
    if (nextCoverage) setCoverage(nextCoverage);
  } catch {
    // Ignore unrelated LiveKit data-channel messages.
  }
}

async function coverageUpdateFromPayload(
  session: DirectorSession,
  payload: {
    coverage_slots?: CoverageSlot[];
    slot_updates?: DirectorTurnResponse["slot_updates"];
  },
) {
  if (payload.coverage_slots && payload.coverage_slots.length > 0) {
    return payload.coverage_slots;
  }
  if ((payload.slot_updates?.length ?? 0) > 0) {
    return refreshCoverage(session, payload.slot_updates);
  }
  return null;
}

function agentMessageKey(stageName: string, turnIndex: number) {
  return `${stageName}:${turnIndex}`;
}

function isExpectedAgentDataSender(
  session: DirectorSession,
  participantIdentity: string | null,
) {
  if (session.roomMode !== "livekit") return true;
  const expectedAgentIdentity = session.agentParticipantIdentity?.trim();
  if (expectedAgentIdentity) {
    return participantIdentity === expectedAgentIdentity;
  }
  const expectedAgentNames = [
    session.agentName?.trim(),
    session.dispatchId?.trim(),
  ].filter((value): value is string => Boolean(value));
  if (expectedAgentNames.length === 0) return false;
  if (!participantIdentity) return false;
  return expectedAgentNames.some(
    (expected) =>
      participantIdentity === expected ||
      participantIdentity.startsWith(`${expected}-`) ||
      participantIdentity.startsWith(`agent-${expected}`),
  );
}

async function sendLiveKitControl(
  room: LiveKitRoomLike | null,
  action: "start" | "mute" | "unmute" | "pause" | "resume" | "end",
  captureSessionId: string,
) {
  if (!room?.localParticipant.publishData) return false;
  const payload = new TextEncoder().encode(
    JSON.stringify({
      source: "otto_browser_client",
      capture_session_id: captureSessionId,
      event: "director.control",
      payload: { action, sent_at: new Date().toISOString() },
    }),
  );
  await room.localParticipant.publishData(payload, {
    reliable: true,
    topic: "otto.director.control",
  });
  return true;
}

async function syncLiveKitControlState(
  room: LiveKitRoomLike | null,
  state: { paused: boolean; muted: boolean },
  captureSessionId: string,
) {
  await room?.localParticipant
    .setMicrophoneEnabled?.(!state.paused && !state.muted)
    .catch(() => undefined);
  await sendLiveKitControl(
    room,
    state.paused ? "pause" : "resume",
    captureSessionId,
  ).catch(() => undefined);
  await sendLiveKitControl(
    room,
    state.muted ? "mute" : "unmute",
    captureSessionId,
  ).catch(() => undefined);
}

function disconnectLiveKitRoom(
  roomRef: MutableRefObject<LiveKitRoomLike | null>,
  micTrackRef: MutableRefObject<LiveKitAudioTrack | null>,
  audioElsRef: MutableRefObject<HTMLMediaElement[]>,
) {
  try {
    micTrackRef.current?.stop?.();
    roomRef.current?.disconnect();
  } catch {
    // Ignore LiveKit teardown races.
  }
  micTrackRef.current = null;
  roomRef.current = null;
  cleanupLiveKitAudioElements(audioElsRef);
}

function cleanupFailedLiveKitConnection(
  input: LiveKitConnectInput,
  room: LiveKitRoomLike | null,
  captureSessionId: string,
) {
  try {
    input.micTrackRef.current?.stop?.();
    room?.disconnect();
  } catch {
    // Ignore LiveKit teardown races.
  }
  input.micTrackRef.current = null;
  if (input.roomRef.current === room) {
    input.roomRef.current = null;
  }
  if (input.connectedSessionRef.current === captureSessionId) {
    input.connectedSessionRef.current = null;
  }
  cleanupLiveKitAudioElements(input.audioElsRef);
}

function removeLiveKitAudioElement(
  audioElsRef: MutableRefObject<HTMLMediaElement[]>,
  element: HTMLMediaElement,
) {
  element.remove();
  audioElsRef.current = audioElsRef.current.filter((candidate) => candidate !== element);
}

function cleanupLiveKitAudioElements(
  audioElsRef: MutableRefObject<HTMLMediaElement[]>,
) {
  for (const element of audioElsRef.current) element.remove();
  audioElsRef.current = [];
  document
    .querySelectorAll<HTMLMediaElement>("[data-otto-livekit-audio='true']")
    .forEach((element) => element.remove());
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const browserWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return (
    browserWindow.SpeechRecognition ??
    browserWindow.webkitSpeechRecognition ??
    null
  );
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
    throw new ApiRequestError(
      payload?.error?.message ?? `Request failed (${response.status})`,
      response.status,
    );
  }
  return payload as T;
}

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function completeDirectorInterview(session: DirectorSession) {
  const idempotencyKey = `director-complete-${session.captureSessionId}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      return await postJson(
        `/api/director-interviews/${session.captureSessionId}/complete`,
        { workspace_id: session.workspaceId },
        idempotencyKey,
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableCompleteError(error) || attempt === 60) break;
      await sleep(isCompletionSettlingError(error) ? 1000 : 350 * attempt);
    }
  }
  if (lastError instanceof Error) {
    throw new Error(
      `${lastError.message} The interview stopped, but completion did not save. Press End again to retry.`,
    );
  }
  throw new Error("The interview stopped, but completion did not save. Press End again to retry.");
}

function isRetryableCompleteError(error: unknown) {
  if (!(error instanceof ApiRequestError)) return true;
  return error.status === 409 || error.status === 429 || error.status >= 500;
}

function isCompletionSettlingError(error: unknown) {
  return (
    error instanceof ApiRequestError &&
    (error.message.includes("delivery_pending") ||
      error.message.includes("extraction_pending"))
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const secs = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${secs}`;
}

// Slot values are arbitrarily nested objects/arrays (e.g. pain_points is
// {items:[{description,affected_role},...]}). A flat String() on nested entries
// renders "[object Object]", so recurse and pull a human-readable headline from
// each object instead.
const SLOT_HEADLINE_KEYS = [
  "description",
  "detail",
  "note",
  "notes",
  "summary",
  "reason",
  "signal",
  "name",
  "person",
  "title",
  "label",
  "text",
  "span",
  "maturity",
];
const SLOT_QUALIFIER_KEYS = [
  "role",
  "affected_role",
  "process",
  "system",
  "owner",
  "top_process",
];

function summarizeSlotValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => summarizeSlotValue(entry, depth + 1))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // For nested items, render a readable "headline (qualifier)" rather than a
    // key:value dump.
    if (depth > 0) {
      const headlineKey = SLOT_HEADLINE_KEYS.find(
        (key) => typeof obj[key] === "string" && obj[key],
      );
      if (headlineKey) {
        const qualifier = SLOT_QUALIFIER_KEYS.map((key) => obj[key]).find(
          (entry) => typeof entry === "string" && entry,
        );
        return qualifier
          ? `${obj[headlineKey] as string} (${qualifier as string})`
          : (obj[headlineKey] as string);
      }
    }
    return Object.entries(obj)
      .filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
      .map(([key, entry]) => `${key.replaceAll("_", " ")}: ${summarizeSlotValue(entry, depth + 1)}`)
      .filter((line) => !line.endsWith(": "))
      .join(" · ");
  }
  return String(value);
}

function labelForSlot(slotPath: string) {
  return slotPath
    .split(".")
    .at(-1)!
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
