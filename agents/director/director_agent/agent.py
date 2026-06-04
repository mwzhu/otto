from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from livekit import rtc
from livekit.agents import Agent, ChatContext, ChatMessage, StopResponse
from otto_realtime_core import (
    delivered_utterance_for_status as core_delivered_utterance_for_status,
    elapsed_ms,
    estimated_spoken_fraction as core_estimated_spoken_fraction,
    text_content as core_text_content,
)

from director_agent.otto_api import (
    IngestedTurn,
    OttoApiClient,
    RespondedTurn,
    stable_key,
)
from director_agent.planner import DirectorPlanner


LOGGER = logging.getLogger(__name__)
LIVEKIT_TURN_METRIC_KEYS = (
    "started_speaking_at",
    "stopped_speaking_at",
    "transcription_delay",
    "end_of_turn_delay",
    "on_user_turn_completed_delay",
    "llm_node_ttft",
    "tts_node_ttfb",
    "playback_latency",
    "e2e_latency",
)

OPENING_PROMPT = (
    "Hi. I'm going to build a high-level map of the processes your team owns: "
    "outcomes, people, systems, cadence, metrics, and friction. To start, what "
    "part of the business do you oversee?"
)
MAX_TRANSCRIPT_TIMING_MS = 2_000_000_000
LIVEKIT_CARTESIA_AUDIO_METADATA = {
    "source": "livekit_agents",
    "provider": "cartesia",
    "playout": "session.say.wait_for_playout",
}
COMPLETION_RETRY_DELAYS_SECONDS = tuple([1.0] * 180)
COMPLETION_DISCONNECT_GRACE_SECONDS = 0.75
COMPLETION_EXTRACTION_WAIT_SECONDS = 120.0
COMPLETION_CHECKER_WAIT_SECONDS = 15.0
EXTRACTION_WINDOW_DEBOUNCE_SECONDS = 1.0


@dataclass(frozen=True)
class TranscriptTiming:
    start_ms: int
    end_ms: int
    confidence: float | None
    source: str
    idempotency_parts: tuple[object, ...]
    metadata: dict[str, Any]


@dataclass
class PendingExtractionWindow:
    extraction_window_id: str
    local_turn_correlation_id: str
    turn_index: int
    turn_indexes: list[int]
    transcript_segment_ids: list[str]
    evidence_ids: list[str]
    utterances: list[str]
    spoken_utterances: list[str]
    target_slots: list[str]
    focus_candidate_process_id: str | None = None


class DirectorConsultantAgent(Agent):
    def __init__(
        self,
        *,
        capture_session_id: str,
        api: OttoApiClient,
        planner: DirectorPlanner,
        room: rtc.Room,
        should_say_opening: bool = True,
        stale_pending_delivery_decisions: list[dict[str, Any]] | None = None,
        initial_turn_counter: int = 0,
        expected_control_participant_identity: str | None = None,
        tts_audio_metadata: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            instructions=(
                "You are Otto, a concise operations consultant interviewing a director. "
                "The actual next question is planned by Otto's director planner. "
                "Do not improvise extra questions."
            )
        )
        self._capture_session_id = capture_session_id
        self._api = api
        self._planner = planner
        self._room = room
        self._should_say_opening = should_say_opening
        self._stale_pending_delivery_decisions = (
            stale_pending_delivery_decisions or []
        )
        self._expected_control_participant_identity = (
            expected_control_participant_identity or None
        )
        self._tts_audio_metadata = dict(
            tts_audio_metadata or LIVEKIT_CARTESIA_AUDIO_METADATA
        )
        self._turn_counter = max(0, initial_turn_counter)
        self._paused = False
        self._muted = False
        self._ended = False
        self._active_speech: Any | None = None
        self._active_turn_done: asyncio.Event | None = None
        self._turn_generation = 0
        self._active_turn_generation: int | None = None
        self._active_user_utterance: str | None = None
        self._realtime_turn_handlers_installed = False
        self._active_delivery_events: set[asyncio.Event] = set()
        self._active_extraction_tasks: dict[int, asyncio.Task[Any]] = {}
        self._active_checker_tasks: dict[int, asyncio.Task[Any]] = {}
        self._pending_extraction_turns: set[int] = set()
        self._pending_slot_paths: set[str] = set()
        self._last_spoken_intent: str | None = None
        self._extraction_window_lock = asyncio.Lock()
        self._open_extraction_window: PendingExtractionWindow | None = None
        self._open_extraction_task: asyncio.Task[Any] | None = None
        self._room.on("data_received", self._on_data_received)

    async def on_enter(self) -> None:
        self._install_realtime_turn_handlers()
        await self._recover_stale_pending_deliveries()
        if not self._should_say_opening:
            await self._publish_data(
                "director.session.notice",
                {
                    "notice_type": "resumed_existing_session",
                    "message": None,
                },
            )
            return
        opening_decision_log_id: str | None = None
        opening_started = time.perf_counter()
        try:
            opening = await self._api.record_opening(
                capture_session_id=self._capture_session_id,
                planned_agent_utterance=OPENING_PROMPT,
                idempotency_key=stable_key(
                    "opening",
                    self._capture_session_id,
                    "director.opening",
                ),
            )
            opening_decision_log_id = opening.decision_log_id
            await self._publish_data(
                "director.turn.dispatched",
                {
                    "turn_index": 0,
                    "stage_name": "director.opening",
                    "agent_utterance": OPENING_PROMPT,
                    "decision_log_id": opening_decision_log_id,
                    "candidate_process_ids": [],
                    "slot_updates": [],
                    "degraded_quality": False,
                },
            )
        except Exception as error:
            LOGGER.warning("Failed to persist director opening prompt: %s", error)
            await self._publish_data(
                "director.session.notice",
                {
                    "notice_type": "failed_opening_persistence",
                    "message": "Otto could not save the opening prompt, so voice playback was not started. The opening prompt is shown as text.",
                    "agent_utterance": OPENING_PROMPT,
                },
            )
            return
        delivery_done = self._begin_active_delivery()
        speech = None
        try:
            speech = self.session.say(OPENING_PROMPT, allow_interruptions=True)
            self._active_speech = speech
            await speech.wait_for_playout()
            if opening_decision_log_id is not None:
                delivered_at = time.perf_counter()
                delivery_status = "truncated" if speech.interrupted else "completed"
                spoken_fraction = (
                    estimated_spoken_fraction(OPENING_PROMPT, opening_started, delivered_at)
                    if speech.interrupted
                    else 1
                )
                delivered_utterance = delivered_utterance_for_status(
                    OPENING_PROMPT,
                    delivery_status=delivery_status,
                    spoken_fraction=spoken_fraction,
                )
                await self._api.update_delivery(
                    capture_session_id=self._capture_session_id,
                    turn_index=0,
                    decision_log_id=opening_decision_log_id,
                    delivery_status=delivery_status,
                    delivered_utterance=delivered_utterance,
                    spoken_fraction=spoken_fraction,
                    latency_ms={
                        "tts_playout_ms": elapsed_ms(opening_started, delivered_at),
                        "turn_total_ms": elapsed_ms(opening_started, delivered_at),
                    },
                    audio_metadata=self._tts_audio_metadata,
                    idempotency_key=delivery_idempotency_key(
                        self._capture_session_id,
                        0,
                        "director.opening",
                    ),
                )
                await self._publish_delivery_update(
                    turn_index=0,
                    stage_name="director.opening",
                    decision_log_id=opening_decision_log_id,
                    delivery_status=delivery_status,
                    agent_utterance=delivered_utterance,
                    spoken_fraction=spoken_fraction,
                    latency_ms={
                        "tts_playout_ms": elapsed_ms(opening_started, delivered_at),
                        "turn_total_ms": elapsed_ms(opening_started, delivered_at),
                    },
                )
        except Exception:
            failed_at = time.perf_counter()
            if opening_decision_log_id is not None:
                delivery_status = (
                    "truncated"
                    if getattr(speech, "interrupted", False)
                    else "failed_text_fallback"
                )
                spoken_fraction = (
                    estimated_spoken_fraction(OPENING_PROMPT, opening_started, failed_at)
                    if delivery_status == "truncated"
                    else 0
                )
                await self._api.update_delivery(
                    capture_session_id=self._capture_session_id,
                    turn_index=0,
                    decision_log_id=opening_decision_log_id,
                    delivery_status=delivery_status,
                    delivered_utterance=delivered_utterance_for_status(
                        OPENING_PROMPT,
                        delivery_status=delivery_status,
                        spoken_fraction=spoken_fraction,
                    ),
                    spoken_fraction=spoken_fraction,
                    latency_ms={
                        "tts_playout_ms": elapsed_ms(opening_started, failed_at),
                        "turn_total_ms": elapsed_ms(opening_started, failed_at),
                    },
                    audio_metadata=self._tts_audio_metadata,
                    idempotency_key=delivery_idempotency_key(
                        self._capture_session_id,
                        0,
                        "director.opening",
                    ),
                )
                await self._publish_delivery_update(
                    turn_index=0,
                    stage_name="director.opening",
                    decision_log_id=opening_decision_log_id,
                    delivery_status=delivery_status,
                    agent_utterance=delivered_utterance_for_status(
                        OPENING_PROMPT,
                        delivery_status=delivery_status,
                        spoken_fraction=spoken_fraction,
                    ),
                    spoken_fraction=spoken_fraction,
                    latency_ms={
                        "tts_playout_ms": elapsed_ms(opening_started, failed_at),
                        "turn_total_ms": elapsed_ms(opening_started, failed_at),
                    },
                )
            await self._publish_data(
                "director.session.notice",
                {
                    "notice_type": "failed_opening_audio",
                    "message": "Audio playback failed. Otto's opening prompt is shown as text.",
                    "agent_utterance": OPENING_PROMPT,
                },
            )
        finally:
            self._active_speech = None
            self._finish_active_delivery(delivery_done)

    async def _recover_stale_pending_deliveries(self) -> None:
        for pending in self._stale_pending_delivery_decisions:
            turn_index_raw = pending.get("turn_index")
            if not isinstance(turn_index_raw, int):
                continue
            turn_index = turn_index_raw
            stage_name = str(pending.get("stage_name") or "director.turn")
            decision_log_id = str(pending.get("decision_log_id") or "")
            planned_utterance = str(pending.get("planned_utterance") or "").strip()
            if not decision_log_id or not planned_utterance:
                continue
            try:
                await self._api.update_delivery(
                    capture_session_id=self._capture_session_id,
                    turn_index=turn_index,
                    decision_log_id=decision_log_id,
                    delivery_status="failed_text_fallback",
                    delivered_utterance=planned_utterance,
                    spoken_fraction=0,
                    latency_ms={
                        "tts_playout_ms": 0,
                        "turn_total_ms": 0,
                        "worker_recovery_ms": 0,
                    },
                    idempotency_key=delivery_idempotency_key(
                        self._capture_session_id,
                        turn_index,
                        stage_name,
                    ),
                )
                await self._publish_delivery_update(
                    turn_index=turn_index,
                    stage_name=stage_name,
                    decision_log_id=decision_log_id,
                    delivery_status="failed_text_fallback",
                    agent_utterance=planned_utterance,
                    spoken_fraction=0,
                    latency_ms={
                        "tts_playout_ms": 0,
                        "turn_total_ms": 0,
                        "worker_recovery_ms": 0,
                    },
                )
            except Exception as error:
                LOGGER.warning(
                    "Failed to recover stale pending director delivery %s/%s: %s",
                    stage_name,
                    turn_index,
                    error,
                )

    async def on_user_turn_completed(
        self,
        turn_ctx: ChatContext,
        new_message: ChatMessage,
    ) -> None:
        generation = self._start_turn_generation()
        turn_done = asyncio.Event()
        self._active_turn_done = turn_done
        self._active_delivery_events.add(turn_done)
        try:
            await self._run_user_turn_completed(
                turn_ctx,
                new_message,
                current_delivery_event=turn_done,
                generation=generation,
            )
        finally:
            turn_done.set()
            self._active_delivery_events.discard(turn_done)
            if self._active_turn_done is turn_done:
                self._active_turn_done = None
            if self._active_turn_generation == generation:
                self._active_turn_generation = None
                self._active_user_utterance = None

    async def _run_user_turn_completed(
        self,
        turn_ctx: ChatContext,
        new_message: ChatMessage,
        *,
        current_delivery_event: asyncio.Event | None = None,
        generation: int,
    ) -> None:
        del turn_ctx
        del current_delivery_event
        utterance = text_content(new_message).strip()
        if self._paused or self._muted or self._ended or not utterance:
            raise StopResponse()
        if self._is_turn_superseded(generation):
            raise StopResponse()
        self._active_user_utterance = utterance

        turn_started = time.perf_counter()
        ordinal = self._turn_counter
        self._turn_counter += 1
        timing = transcript_timing_from_message(
            new_message,
            utterance,
            ordinal,
            config=getattr(self._planner, "config", None),
        )

        ingest = await self._api.ingest_turn(
            capture_session_id=self._capture_session_id,
            utterance=utterance,
            start_ms=timing.start_ms,
            end_ms=timing.end_ms,
            confidence=timing.confidence,
            timing_source=timing.source,
            metadata_json=timing.metadata,
            idempotency_key=ingest_idempotency_key(self._capture_session_id, timing),
        )
        ingested_at = time.perf_counter()
        if self._is_turn_superseded(generation):
            raise StopResponse()
        await self._publish_data(
            "director.turn.ingested",
            {
                "turn_index": ingest.turn_index,
                "stage_name": "director.turn",
                "transcript": utterance,
                "transcript_segment_ids": ingest.transcript_segment_ids,
                "evidence_ids": ingest.evidence_ids,
                "asr_timing_source": timing.source,
            },
        )
        local_turn_correlation_id = stable_key(
            "local-turn",
            self._capture_session_id,
            ingest.turn_index,
        )
        extraction_window_id = await self._extraction_window_id_for_ingest(ingest)
        await self._run_decoupled_user_turn(
            ingest=ingest,
            utterance=utterance,
            turn_started=turn_started,
            ingested_at=ingested_at,
            timing_source=timing.source,
            local_turn_correlation_id=local_turn_correlation_id,
            extraction_window_id=extraction_window_id,
            generation=generation,
        )
        raise StopResponse()

    async def _run_decoupled_user_turn(
        self,
        *,
        ingest: Any,
        utterance: str,
        turn_started: float,
        ingested_at: float,
        timing_source: str,
        local_turn_correlation_id: str,
        extraction_window_id: str,
        generation: int,
    ) -> None:
        early_utterance: asyncio.Future[str] = asyncio.get_running_loop().create_future()

        def on_planned_agent_utterance(utterance: str) -> None:
            if not early_utterance.done() and utterance.strip():
                early_utterance.set_result(utterance.strip())

        respond_task = asyncio.create_task(
            self._planner.respond_turn(
                capture_session_id=self._capture_session_id,
                turn=ingest,
                idempotency_key=stable_key(
                    "respond",
                    self._capture_session_id,
                    ingest.turn_index,
                ),
                on_planned_agent_utterance=on_planned_agent_utterance,
                local_turn_correlation_id=local_turn_correlation_id,
                extraction_window_id=extraction_window_id,
                pending_extraction_turns=sorted(self._pending_extraction_turns),
                pending_slot_paths=sorted(self._pending_slot_paths),
                last_spoken_intent=self._last_spoken_intent,
            )
        )
        done, _pending = await asyncio.wait(
            {respond_task, early_utterance},
            return_when=asyncio.FIRST_COMPLETED,
        )
        responded: RespondedTurn | None = None
        speech = None
        speech_started_at = 0.0
        spoken_utterance: str | None = None
        if early_utterance in done and not self._is_turn_superseded(generation):
            spoken_utterance = early_utterance.result()
            speech_started_at = time.perf_counter()
            speech = self.session.say(spoken_utterance, allow_interruptions=True)
            self._active_speech = speech
        if respond_task in done:
            responded = respond_task.result()
        else:
            responded = await respond_task
        responded_at = time.perf_counter()
        if spoken_utterance is None:
            spoken_utterance = responded.planned_agent_utterance
        steering_context = responded.steering_context or {}
        target_slots = [
            str(slot)
            for slot in steering_context.get("target_slots", [])
            if str(slot).strip()
        ]
        self._pending_extraction_turns.add(ingest.turn_index)
        self._pending_slot_paths.update(target_slots)
        self._last_spoken_intent = (
            responded.plan.get("chosen_intent", {}).get("intent")
            if isinstance(responded.plan.get("chosen_intent"), dict)
            else self._last_spoken_intent
        )
        await self._queue_background_extraction(
            ingest=ingest,
            spoken_utterance=spoken_utterance,
            target_slots=target_slots,
            extraction_window_id=extraction_window_id,
            local_turn_correlation_id=local_turn_correlation_id,
            focus_candidate_process_id=(
                str(steering_context.get("focus_candidate_process_id"))
                if steering_context.get("focus_candidate_process_id")
                else None
            ),
        )
        if self._is_turn_superseded(generation):
            if speech is None:
                await self._mark_delivery_not_spoken(
                    turn_index=ingest.turn_index,
                    decision_log_id=responded.decision_log_id,
                    turn_started=turn_started,
                    dispatched_at=responded_at,
                    local_turn_correlation_id=local_turn_correlation_id,
                )
            else:
                await self._mark_delivery_interrupted_after_tts(
                    turn_index=ingest.turn_index,
                    decision_log_id=responded.decision_log_id,
                    utterance=spoken_utterance,
                    turn_started=turn_started,
                    dispatched_at=responded_at,
                    speech_started_at=speech_started_at,
                    interrupted_at=time.perf_counter(),
                    local_turn_correlation_id=local_turn_correlation_id,
                )
            return
        if speech is None:
            speech_started_at = time.perf_counter()
            speech = self.session.say(spoken_utterance, allow_interruptions=True)
            self._active_speech = speech
        checker_task = asyncio.create_task(
            self._run_background_output_check(
                ingest=ingest,
                spoken_utterance=spoken_utterance,
                steering_context=steering_context,
                local_turn_correlation_id=local_turn_correlation_id,
                extraction_window_id=extraction_window_id,
            )
        )
        self._active_checker_tasks[ingest.turn_index] = checker_task
        checker_task.add_done_callback(
            lambda task, turn_index=ingest.turn_index: self._on_checker_task_done(
                turn_index,
                task,
            )
        )

        await self._publish_data(
            "director.turn.dispatched",
            {
                "turn_index": ingest.turn_index,
                "stage_name": "director.turn",
                "transcript": utterance,
                "agent_utterance": spoken_utterance,
                "decision_log_id": responded.decision_log_id,
                "local_turn_correlation_id": local_turn_correlation_id,
                "slot_updates": [],
                "coverage_slots": [],
                "degraded_quality": responded.degraded_quality,
                "degraded_reasons": responded.degraded_reasons,
                "extraction_status": "pending",
            },
        )
        await self._publish_turn_telemetry(
            ingest_turn_index=ingest.turn_index,
            decision_log_id=responded.decision_log_id,
            planned=responded,
            timing={
                "ingest_ms": elapsed_ms(turn_started, ingested_at),
                "respond_ms": elapsed_ms(ingested_at, responded_at),
                "speech_pre_tts_total_ms": elapsed_ms(turn_started, speech_started_at),
                "ttfa_ms": elapsed_ms(turn_started, speech_started_at),
                "pending_extraction_count": len(self._pending_extraction_turns),
                "steering_lag_turns": len(self._pending_extraction_turns),
                "steering_lag_ms": 0,
            },
            asr_timing_source=timing_source,
        )

        try:
            await speech.wait_for_playout()
        except Exception:
            failed_at = time.perf_counter()
            if self._paused or self._muted or self._ended or getattr(speech, "interrupted", False):
                await self._mark_delivery_interrupted_after_tts(
                    turn_index=ingest.turn_index,
                    decision_log_id=responded.decision_log_id,
                    utterance=spoken_utterance,
                    turn_started=turn_started,
                    dispatched_at=responded_at,
                    speech_started_at=speech_started_at,
                    interrupted_at=failed_at,
                    local_turn_correlation_id=local_turn_correlation_id,
                )
                return
            failed_latency = {
                "tts_playout_ms": elapsed_ms(responded_at, failed_at),
                "speech_latency_ms": elapsed_ms(speech_started_at, failed_at),
                "turn_total_ms": elapsed_ms(turn_started, failed_at),
            }
            await self._api.update_delivery(
                capture_session_id=self._capture_session_id,
                turn_index=ingest.turn_index,
                decision_log_id=responded.decision_log_id,
                delivery_status="failed_text_fallback",
                delivered_utterance=spoken_utterance,
                spoken_fraction=0,
                latency_ms=failed_latency,
                audio_metadata=self._tts_audio_metadata,
                local_turn_correlation_id=local_turn_correlation_id,
                idempotency_key=delivery_idempotency_key(
                    self._capture_session_id,
                    ingest.turn_index,
                ),
            )
            await self._publish_delivery_update(
                turn_index=ingest.turn_index,
                decision_log_id=responded.decision_log_id,
                delivery_status="failed_text_fallback",
                agent_utterance=spoken_utterance,
                spoken_fraction=0,
                latency_ms=failed_latency,
            )
            return
        finally:
            self._active_speech = None

        delivered_at = time.perf_counter()
        delivery_status = (
            "truncated"
            if speech.interrupted or self._is_turn_superseded(generation)
            else "completed"
        )
        spoken_fraction = (
            estimated_spoken_fraction(spoken_utterance, speech_started_at, delivered_at)
            if speech.interrupted
            else 1
        )
        delivery_latency = {
            "tts_playout_ms": elapsed_ms(responded_at, delivered_at),
            "speech_latency_ms": elapsed_ms(speech_started_at, delivered_at),
            "turn_total_ms": elapsed_ms(turn_started, delivered_at),
        }
        delivered_utterance = delivered_utterance_for_status(
            spoken_utterance,
            delivery_status=delivery_status,
            spoken_fraction=spoken_fraction,
        )
        await self._api.update_delivery(
            capture_session_id=self._capture_session_id,
            turn_index=ingest.turn_index,
            decision_log_id=responded.decision_log_id,
            delivery_status=delivery_status,
            delivered_utterance=delivered_utterance,
            spoken_fraction=spoken_fraction,
            latency_ms=delivery_latency,
            audio_metadata=self._tts_audio_metadata,
            local_turn_correlation_id=local_turn_correlation_id,
            idempotency_key=delivery_idempotency_key(
                self._capture_session_id,
                ingest.turn_index,
            ),
        )
        await self._publish_delivery_update(
            turn_index=ingest.turn_index,
            decision_log_id=responded.decision_log_id,
            delivery_status=delivery_status,
            agent_utterance=delivered_utterance,
            spoken_fraction=spoken_fraction,
            latency_ms=delivery_latency,
        )

    async def _run_background_extraction(
        self,
        *,
        window: PendingExtractionWindow,
    ) -> None:
        combined_utterance = " ".join(window.utterances).strip()
        window_turn = IngestedTurn(
            latest_utterance=combined_utterance,
            transcript_segment_ids=unique_preserve_order(window.transcript_segment_ids),
            evidence_ids=unique_preserve_order(window.evidence_ids),
            turn_index=window.turn_index,
            raw={
                "extraction_window_id": window.extraction_window_id,
                "windowed_turn_count": len(window.utterances),
                "window_turn_indexes": unique_ints_preserve_order(window.turn_indexes),
            },
        )
        try:
            result = await self._api.extract_turn(
                capture_session_id=self._capture_session_id,
                turn=window_turn,
                spoken_agent_utterance=window.spoken_utterances[-1]
                if window.spoken_utterances
                else combined_utterance,
                local_turn_correlation_id=window.local_turn_correlation_id,
                extraction_window_id=window.extraction_window_id,
                focus_candidate_process_id=window.focus_candidate_process_id,
                idempotency_key=stable_key(
                    "extract",
                    self._capture_session_id,
                    window.extraction_window_id,
                ),
            )
            await self._publish_data(
                "director.turn.extracted",
                {
                    "turn_index": window.turn_index,
                    "decision_log_id": result.get("decision_log_id"),
                    "extraction_status": result.get("extraction_status", "complete"),
                    "extraction_latency_ms": result.get("extraction_latency_ms"),
                    "slot_update_latency_ms": result.get("slot_update_latency_ms"),
                    "extraction_window_id": window.extraction_window_id,
                    "slot_updates": result.get("slot_updates", []),
                    "coverage_slots": result.get("coverage_slots", []),
                    "degraded_quality": result.get("degraded_quality", False),
                    "degraded_reasons": result.get("degraded_reasons", []),
                },
            )
        except Exception:
            raise
        else:
            for turn_index in window.turn_indexes:
                self._pending_extraction_turns.discard(turn_index)
            for slot_path in window.target_slots:
                self._pending_slot_paths.discard(slot_path)

    async def _extraction_window_id_for_ingest(self, ingest: IngestedTurn) -> str:
        async with self._extraction_window_lock:
            if (
                self._open_extraction_window is not None
                and self._open_extraction_task is not None
                and not self._open_extraction_task.done()
            ):
                return self._open_extraction_window.extraction_window_id
            return stable_key(
                "extraction-window",
                self._capture_session_id,
                "from-turn",
                ingest.turn_index,
            )

    async def _queue_background_extraction(
        self,
        *,
        ingest: IngestedTurn,
        spoken_utterance: str,
        target_slots: list[str],
        extraction_window_id: str,
        local_turn_correlation_id: str,
        focus_candidate_process_id: str | None,
    ) -> None:
        async with self._extraction_window_lock:
            if (
                self._open_extraction_window is None
                or self._open_extraction_window.extraction_window_id != extraction_window_id
            ):
                self._open_extraction_window = PendingExtractionWindow(
                    extraction_window_id=extraction_window_id,
                    local_turn_correlation_id=local_turn_correlation_id,
                    turn_index=ingest.turn_index,
                    turn_indexes=[],
                    transcript_segment_ids=[],
                    evidence_ids=[],
                    utterances=[],
                    spoken_utterances=[],
                    target_slots=[],
                    focus_candidate_process_id=focus_candidate_process_id,
                )
            window = self._open_extraction_window
            if window.focus_candidate_process_id is None:
                window.focus_candidate_process_id = focus_candidate_process_id
            window.transcript_segment_ids.extend(ingest.transcript_segment_ids)
            window.evidence_ids.extend(ingest.evidence_ids)
            window.turn_indexes.append(ingest.turn_index)
            window.utterances.append(ingest.latest_utterance)
            window.spoken_utterances.append(spoken_utterance)
            window.target_slots.extend(target_slots)
            self._pending_extraction_turns.add(ingest.turn_index)
            self._pending_slot_paths.update(target_slots)
            if self._open_extraction_task is not None and not self._open_extraction_task.done():
                self._open_extraction_task.cancel()
            task = asyncio.create_task(
                self._run_debounced_background_extraction(extraction_window_id)
            )
            self._open_extraction_task = task
            self._active_extraction_tasks[ingest.turn_index] = task
            task.add_done_callback(
                lambda task, turn_index=ingest.turn_index: self._on_extraction_task_done(
                    turn_index,
                    task,
                )
            )

    async def _run_debounced_background_extraction(
        self,
        extraction_window_id: str,
    ) -> None:
        await asyncio.sleep(EXTRACTION_WINDOW_DEBOUNCE_SECONDS)
        async with self._extraction_window_lock:
            if (
                self._open_extraction_window is None
                or self._open_extraction_window.extraction_window_id != extraction_window_id
            ):
                return
            window = self._open_extraction_window
            self._open_extraction_window = None
            self._open_extraction_task = None
        await self._run_background_extraction(window=window)

    def _on_extraction_task_done(
        self,
        turn_index: int,
        task: asyncio.Task[Any],
    ) -> None:
        self._active_extraction_tasks.pop(turn_index, None)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            LOGGER.warning(
                "Director async extraction failed for turn %s: %s",
                turn_index,
                error,
            )

    async def _flush_open_extraction_window_for_completion(self) -> None:
        async with self._extraction_window_lock:
            if self._open_extraction_window is None:
                return
            window = self._open_extraction_window
            debounce_task = self._open_extraction_task
            self._open_extraction_window = None
            self._open_extraction_task = None
            if debounce_task is not None and not debounce_task.done():
                debounce_task.cancel()

            task = asyncio.create_task(self._run_background_extraction(window=window))
            for turn_index in window.turn_indexes:
                self._active_extraction_tasks[turn_index] = task
            task.add_done_callback(
                lambda task, turn_indexes=list(window.turn_indexes): self._on_window_extraction_task_done(
                    turn_indexes,
                    task,
                )
            )

    def _on_window_extraction_task_done(
        self,
        turn_indexes: list[int],
        task: asyncio.Task[Any],
    ) -> None:
        for turn_index in turn_indexes:
            self._active_extraction_tasks.pop(turn_index, None)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            LOGGER.warning(
                "Director async extraction failed for turns %s: %s",
                turn_indexes,
                error,
            )

    async def _run_background_output_check(
        self,
        *,
        ingest: Any,
        spoken_utterance: str,
        steering_context: dict[str, Any],
        local_turn_correlation_id: str,
        extraction_window_id: str,
    ) -> None:
        result = await self._api.check_turn(
            capture_session_id=self._capture_session_id,
            turn=ingest,
            spoken_agent_utterance=spoken_utterance,
            steering_context=steering_context,
            local_turn_correlation_id=local_turn_correlation_id,
            extraction_window_id=extraction_window_id,
            idempotency_key=stable_key(
                "check",
                self._capture_session_id,
                extraction_window_id,
                ingest.turn_index,
            ),
        )
        await self._publish_data(
            "director.turn.output_checked",
            {
                "turn_index": ingest.turn_index,
                "checker_status": result.get("checker_status", "complete"),
                "checker_violations": result.get("checker_violations", []),
                "checker_violation_count": result.get("checker_violation_count", 0),
                "stale_question_count": result.get("stale_question_count", 0),
                "extraction_window_id": extraction_window_id,
                "local_turn_correlation_id": local_turn_correlation_id,
            },
        )

    def _on_checker_task_done(
        self,
        turn_index: int,
        task: asyncio.Task[Any],
    ) -> None:
        self._active_checker_tasks.pop(turn_index, None)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            LOGGER.warning(
                "Director async output checker failed for turn %s: %s",
                turn_index,
                error,
            )

    async def _mark_delivery_not_spoken(
        self,
        *,
        turn_index: int,
        decision_log_id: str,
        turn_started: float,
        dispatched_at: float,
        local_turn_correlation_id: str | None = None,
    ) -> None:
        stopped_at = time.perf_counter()
        latency = {
            "tts_playout_ms": 0,
            "turn_total_ms": elapsed_ms(turn_started, stopped_at),
        }
        await self._api.update_delivery(
            capture_session_id=self._capture_session_id,
            turn_index=turn_index,
            decision_log_id=decision_log_id,
            delivery_status="truncated",
            delivered_utterance="",
            spoken_fraction=0,
            latency_ms=latency,
            local_turn_correlation_id=local_turn_correlation_id,
            idempotency_key=delivery_idempotency_key(
                self._capture_session_id,
                turn_index,
            ),
        )
        await self._publish_delivery_update(
            turn_index=turn_index,
            decision_log_id=decision_log_id,
            delivery_status="truncated",
            agent_utterance="",
            spoken_fraction=0,
            latency_ms={
                **latency,
                "pre_tts_cancelled_ms": elapsed_ms(dispatched_at, stopped_at),
            },
        )

    async def _mark_delivery_interrupted_after_tts(
        self,
        *,
        turn_index: int,
        decision_log_id: str,
        utterance: str,
        turn_started: float,
        dispatched_at: float,
        speech_started_at: float,
        interrupted_at: float,
        local_turn_correlation_id: str | None = None,
    ) -> None:
        spoken_fraction = estimated_spoken_fraction(
            utterance,
            speech_started_at,
            interrupted_at,
        )
        delivered_utterance = delivered_utterance_for_status(
            utterance,
            delivery_status="truncated",
            spoken_fraction=spoken_fraction,
        )
        latency = {
            "tts_playout_ms": elapsed_ms(dispatched_at, interrupted_at),
            "turn_total_ms": elapsed_ms(turn_started, interrupted_at),
        }
        await self._api.update_delivery(
            capture_session_id=self._capture_session_id,
            turn_index=turn_index,
            decision_log_id=decision_log_id,
            delivery_status="truncated",
            delivered_utterance=delivered_utterance,
            spoken_fraction=spoken_fraction,
            latency_ms=latency,
            audio_metadata=self._tts_audio_metadata,
            local_turn_correlation_id=local_turn_correlation_id,
            idempotency_key=delivery_idempotency_key(
                self._capture_session_id,
                turn_index,
            ),
        )
        await self._publish_delivery_update(
            turn_index=turn_index,
            decision_log_id=decision_log_id,
            delivery_status="truncated",
            agent_utterance=delivered_utterance,
            spoken_fraction=spoken_fraction,
            latency_ms=latency,
        )

    async def _publish_data(self, event: str, payload: dict[str, Any]) -> bool:
        local_participant = getattr(self._room, "local_participant", None)
        if not local_participant:
            return False
        try:
            await local_participant.publish_data(
                json.dumps(
                    {
                        "source": "otto_director_agent",
                        "capture_session_id": self._capture_session_id,
                        "event": event,
                        "payload": payload,
                    }
                ).encode("utf-8"),
                reliable=True,
                topic="otto.director",
            )
        except Exception as error:
            LOGGER.warning("Failed to publish LiveKit data event %s: %s", event, error)
            return False
        return True

    async def _publish_turn_telemetry(
        self,
        *,
        ingest_turn_index: int,
        decision_log_id: str | None,
        planned: Any,
        timing: dict[str, int],
        asr_timing_source: str,
    ) -> None:
        raw = getattr(planned, "raw", {})
        await self._publish_data(
            "director.turn.telemetry",
            {
                "turn_index": ingest_turn_index,
                "decision_log_id": decision_log_id,
                "latency_ms": timing,
                "asr_timing_source": asr_timing_source,
                "planner_runtime": raw.get("planner_runtime"),
                "extraction_status": raw.get("extraction_status"),
                "brain": raw.get("metadata") or getattr(planned, "metadata", None),
                "voice": raw.get("voice_metadata") or getattr(planned, "voice_metadata", None),
                "degraded_quality": getattr(planned, "degraded_quality", False),
                "degraded_reasons": getattr(planned, "degraded_reasons", []),
                "local_turn_correlation_id": raw.get("local_turn_correlation_id")
                or getattr(planned, "local_turn_correlation_id", None),
            },
        )

    async def _publish_delivery_update(
        self,
        *,
        turn_index: int,
        decision_log_id: str | None,
        delivery_status: str,
        agent_utterance: str,
        spoken_fraction: float,
        stage_name: str = "director.turn",
        latency_ms: dict[str, int] | None = None,
        local_turn_correlation_id: str | None = None,
    ) -> None:
        await self._publish_data(
            "director.turn.delivery_updated",
            {
                "turn_index": turn_index,
                "stage_name": stage_name,
                "decision_log_id": decision_log_id,
                "delivery_status": delivery_status,
                "agent_utterance": agent_utterance,
                "spoken_fraction": spoken_fraction,
                "latency_ms": latency_ms or {},
                "local_turn_correlation_id": local_turn_correlation_id,
            },
        )

    def _on_data_received(self, packet: rtc.DataPacket) -> None:
        if packet.topic != "otto.director.control":
            return
        if not self._control_participant_allowed(packet):
            return
        try:
            raw = packet.data.decode("utf-8")
            message = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if message.get("source") != "otto_browser_client":
            return
        if message.get("capture_session_id") != self._capture_session_id:
            return
        if message.get("event") != "director.control":
            return
        payload = message.get("payload")
        if not isinstance(payload, dict):
            return
        action = payload.get("action")
        if action == "pause":
            self._paused = True
            self._interrupt_active_speech()
            asyncio.create_task(
                self._publish_control_update(
                    "pause",
                    self._paused,
                    self._muted,
                    self._ended,
                )
            )
            return
        if action == "resume":
            self._paused = False
            asyncio.create_task(
                self._publish_control_update(
                    "resume",
                    self._paused,
                    self._muted,
                    self._ended,
                )
            )
            return
        if action == "mute":
            self._muted = True
            asyncio.create_task(
                self._publish_control_update(
                    "mute",
                    self._paused,
                    self._muted,
                    self._ended,
                )
            )
            return
        if action == "unmute":
            self._muted = False
            asyncio.create_task(
                self._publish_control_update(
                    "unmute",
                    self._paused,
                    self._muted,
                    self._ended,
                )
            )
            return
        if action == "end":
            self._ended = True
            self._paused = True
            self._interrupt_active_speech()
            asyncio.create_task(
                self._publish_control_update(
                    "end",
                    self._paused,
                    self._muted,
                    self._ended,
                )
            )
            asyncio.create_task(self._complete_session_and_disconnect())

    def _control_participant_allowed(self, packet: rtc.DataPacket) -> bool:
        expected = self._expected_control_participant_identity
        if not expected:
            return False
        participant = getattr(packet, "participant", None)
        identity = getattr(participant, "identity", None)
        return identity == expected

    def _install_realtime_turn_handlers(self) -> None:
        if self._realtime_turn_handlers_installed:
            return
        self._realtime_turn_handlers_installed = True
        try:
            session = self.session
        except RuntimeError:
            return
        if not hasattr(session, "on"):
            return
        try:
            session.on("user_state_changed", self._on_user_state_changed)
            session.on("user_input_transcribed", self._on_user_input_transcribed)
        except Exception as error:
            LOGGER.warning("Failed to install realtime turn handlers: %s", error)

    def _on_user_state_changed(self, event: Any) -> None:
        if state_name(getattr(event, "new_state", "")) == "speaking":
            self._supersede_active_turn()

    def _on_user_input_transcribed(self, event: Any) -> None:
        transcript = str(getattr(event, "transcript", "") or "").strip()
        if not transcript:
            return
        is_final = bool(getattr(event, "is_final", False))
        if not is_final:
            self._supersede_active_turn()
            return
        if self._active_turn_generation is None and self._active_speech is None:
            return
        active_utterance = normalize_transcript_for_supersede(
            self._active_user_utterance or ""
        )
        if active_utterance and normalize_transcript_for_supersede(transcript) == active_utterance:
            return
        self._supersede_active_turn()

    def _start_turn_generation(self) -> int:
        self._turn_generation += 1
        self._active_turn_generation = self._turn_generation
        self._interrupt_active_speech()
        return self._turn_generation

    def _supersede_active_turn(self) -> None:
        if self._active_turn_generation is None and self._active_speech is None:
            return
        self._turn_generation += 1
        self._interrupt_active_speech()

    def _is_turn_superseded(self, generation: int) -> bool:
        return (
            generation != self._turn_generation
            or self._paused
            or self._muted
            or self._ended
        )

    async def _publish_control_update(
        self,
        action: str,
        paused: bool,
        muted: bool,
        ended: bool,
    ) -> None:
        await self._publish_data(
            "director.control.updated",
            {
                "action": action,
                "paused": paused,
                "muted": muted,
                "ended": ended,
            },
        )

    async def _complete_session_and_disconnect(self) -> None:
        completed = False
        try:
            active_turn_done = self._active_turn_done
            if active_turn_done is not None and not active_turn_done.is_set():
                try:
                    await asyncio.wait_for(active_turn_done.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    LOGGER.warning(
                        "Timed out waiting for active turn delivery before completion."
                    )
            active_delivery_events = [
                event for event in self._active_delivery_events if not event.is_set()
            ]
            if active_delivery_events:
                try:
                    await asyncio.wait_for(
                        asyncio.gather(
                            *(event.wait() for event in active_delivery_events)
                        ),
                        timeout=5.0,
                    )
                except asyncio.TimeoutError:
                    LOGGER.warning(
                        "Timed out waiting for active voice delivery before completion."
                    )
            await self._flush_open_extraction_window_for_completion()
            active_extractions = [
                task for task in set(self._active_extraction_tasks.values()) if not task.done()
            ]
            if active_extractions:
                try:
                    await asyncio.wait_for(
                        asyncio.shield(
                            asyncio.gather(*active_extractions, return_exceptions=True)
                        ),
                        timeout=COMPLETION_EXTRACTION_WAIT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    LOGGER.warning(
                        "Timed out waiting for async director extraction before completion."
                    )
            active_checkers = [
                task for task in set(self._active_checker_tasks.values()) if not task.done()
            ]
            if active_checkers:
                try:
                    await asyncio.wait_for(
                        asyncio.shield(
                            asyncio.gather(*active_checkers, return_exceptions=True)
                        ),
                        timeout=COMPLETION_CHECKER_WAIT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    LOGGER.warning(
                        "Timed out waiting for async director output checker before completion."
                    )
            await self._complete_session_with_retry()
            completed = True
        except Exception as error:
            LOGGER.warning("Failed to complete director session on end control: %s", error)
            await self._publish_data(
                "director.session.notice",
                {
                    "notice_type": "failed_completion",
                    "message": "The interview stopped, but completion did not save. Press End again to retry.",
                },
            )
        finally:
            if completed:
                await asyncio.sleep(COMPLETION_DISCONNECT_GRACE_SECONDS)
                await self._room.disconnect()

    async def _complete_session_with_retry(self) -> None:
        idempotency_key = stable_key(
            "complete",
            self._capture_session_id,
            "livekit_end",
        )
        last_error: Exception | None = None
        for attempt in range(len(COMPLETION_RETRY_DELAYS_SECONDS) + 1):
            try:
                await self._api.complete_session(
                    capture_session_id=self._capture_session_id,
                    idempotency_key=idempotency_key,
                )
                await self._publish_data(
                    "director.session.completed",
                    {
                        "capture_session_id": self._capture_session_id,
                        "next": "synthesis",
                    },
                )
                return
            except Exception as error:
                last_error = error
                if (
                    not is_retryable_completion_settling_error(error)
                    or attempt >= len(COMPLETION_RETRY_DELAYS_SECONDS)
                ):
                    raise
                await asyncio.sleep(COMPLETION_RETRY_DELAYS_SECONDS[attempt])
        if last_error is not None:
            raise last_error

    def _interrupt_active_speech(self) -> None:
        speech = self._active_speech
        if speech is None:
            return
        interrupt = getattr(speech, "interrupt", None)
        if not callable(interrupt):
            return
        try:
            interrupt(force=True)
        except Exception:
            return

    def _begin_active_delivery(self) -> asyncio.Event:
        delivery_done = asyncio.Event()
        self._active_delivery_events.add(delivery_done)
        return delivery_done

    def _finish_active_delivery(self, delivery_done: asyncio.Event) -> None:
        delivery_done.set()
        self._active_delivery_events.discard(delivery_done)

def text_content(message: ChatMessage) -> str:
    return core_text_content(message)


def normalize_transcript_for_supersede(value: str) -> str:
    return " ".join(value.casefold().split())


def transcript_timing_from_message(
    message: ChatMessage,
    utterance: str,
    ordinal: int,
    *,
    config: Any | None = None,
) -> TranscriptTiming:
    metrics = getattr(message, "metrics", {}) or {}
    started = number_from_mapping(metrics, "started_speaking_at")
    stopped = number_from_mapping(metrics, "stopped_speaking_at")
    confidence = optional_float(getattr(message, "transcript_confidence", None))
    provider_metadata = deepgram_transcript_metadata(config)
    if started is not None and stopped is not None and stopped > started:
        raw_start_ms = int(started * 1000)
        raw_end_ms = max(int(stopped * 1000), raw_start_ms + 1)
        start_ms, end_ms, normalized_metadata = normalized_transcript_timing(
            raw_start_ms,
            raw_end_ms,
            ordinal,
        )
        return TranscriptTiming(
            start_ms=start_ms,
            end_ms=end_ms,
            confidence=confidence,
            source="asr_metrics",
            idempotency_parts=(raw_start_ms, raw_end_ms),
            metadata={
                **provider_metadata,
                "source": "livekit_agents",
                "provider": "deepgram",
                "timing": "started_stopped_speaking_at",
                "metrics": metrics_report_metadata(metrics),
                **normalized_metadata,
            },
        )

    created_at = optional_float(getattr(message, "created_at", None)) or time.time()
    estimated_duration_ms = max(1000, len(utterance) * 35)
    raw_end_ms = int(created_at * 1000)
    raw_start_ms = max(0, raw_end_ms - estimated_duration_ms)
    start_ms, end_ms, normalized_metadata = normalized_transcript_timing(
        raw_start_ms,
        max(raw_end_ms, raw_start_ms + 1),
        ordinal,
    )
    return TranscriptTiming(
        start_ms=start_ms,
        end_ms=end_ms,
        confidence=confidence,
        source="created_at_estimate",
        idempotency_parts=(ordinal, raw_start_ms, max(raw_end_ms, raw_start_ms + 1)),
        metadata={
            **provider_metadata,
            "source": "livekit_agents",
            "provider": "deepgram",
            "timing": "created_at_estimate",
            "created_at": created_at,
            "estimated_duration_ms": estimated_duration_ms,
            **normalized_metadata,
        },
    )


def normalized_transcript_timing(
    raw_start_ms: int,
    raw_end_ms: int,
    ordinal: int,
) -> tuple[int, int, dict[str, int | bool]]:
    end_ms = max(raw_end_ms, raw_start_ms + 1)
    if 0 <= raw_start_ms <= MAX_TRANSCRIPT_TIMING_MS and end_ms <= MAX_TRANSCRIPT_TIMING_MS:
        return raw_start_ms, end_ms, {}
    duration_ms = max(1, min(end_ms - raw_start_ms, 15 * 60 * 1000))
    normalized_start_ms = max(0, min(ordinal * 60_000, MAX_TRANSCRIPT_TIMING_MS - duration_ms))
    normalized_end_ms = normalized_start_ms + duration_ms
    return (
        normalized_start_ms,
        normalized_end_ms,
        {
            "timing_normalized": True,
            "raw_start_ms": raw_start_ms,
            "raw_end_ms": end_ms,
        },
    )


def deepgram_transcript_metadata(config: Any | None = None) -> dict[str, str | bool]:
    language = str(getattr(config, "language", None) or "en")
    use_livekit_inference = bool(getattr(config, "use_livekit_inference", False))
    return {
        "model": str(getattr(config, "deepgram_model", None) or "nova-3"),
        "language": "multi" if language == "auto" else language,
        "transport": (
            "livekit_inference"
            if use_livekit_inference
            else "direct_plugin"
        ),
        "mip_opt_out": "managed_by_livekit_inference" if use_livekit_inference else True,
        "vendor_privacy_ack": bool(getattr(config, "vendor_privacy_ack", False)),
        "privacy_no_store_ack": bool(getattr(config, "deepgram_no_store_ack", False)),
    }


def ingest_idempotency_key(capture_session_id: str, timing: TranscriptTiming) -> str:
    return stable_key("seg", capture_session_id, *timing.idempotency_parts)


def delivery_idempotency_key(
    capture_session_id: str,
    turn_index: int,
    stage_name: str = "director.turn",
) -> str:
    return stable_key("delivery", capture_session_id, stage_name, turn_index)


def is_retryable_completion_settling_error(error: Exception) -> bool:
    message = str(error)
    return "delivery_pending" in message or "extraction_pending" in message


def unique_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        unique.append(value)
    return unique


def unique_ints_preserve_order(values: list[int]) -> list[int]:
    seen: set[int] = set()
    unique: list[int] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        unique.append(value)
    return unique


def delivered_utterance_for_status(
    utterance: str,
    *,
    delivery_status: str,
    spoken_fraction: float,
) -> str:
    delivered = core_delivered_utterance_for_status(
        utterance,
        delivery_status=delivery_status,
        spoken_fraction=spoken_fraction,
        truncate_on_word_boundary=True,
    )
    return delivered or ""


def estimated_spoken_fraction(
    utterance: str,
    speech_started_at: float,
    delivered_at: float,
) -> float:
    return core_estimated_spoken_fraction(
        utterance,
        speech_started_at,
        delivered_at,
        seconds_per_word=0.36,
        minimum_duration_seconds=0.7,
        minimum_fraction=0.05,
        maximum_fraction=0.95,
        decimals=2,
    )


def number_from_mapping(mapping: Any, key: str) -> float | None:
    if isinstance(mapping, dict):
        return optional_float(mapping.get(key))
    return optional_float(getattr(mapping, key, None))


def value_from_mapping(mapping: Any, key: str) -> Any:
    if isinstance(mapping, dict):
        return mapping.get(key)
    return getattr(mapping, key, None)


def metrics_report_metadata(metrics: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in LIVEKIT_TURN_METRIC_KEYS:
        value = number_from_mapping(metrics, key)
        if value is not None:
            result[key] = round(value, 6)
    for key in ("stt_metadata", "llm_metadata", "tts_metadata"):
        value = serializable_metadata(value_from_mapping(metrics, key))
        if value is not None:
            result[key] = value
    return result


def serializable_metadata(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {
            str(key): serializable
            for key, nested in value.items()
            if (serializable := serializable_metadata(nested)) is not None
        }
    if isinstance(value, (list, tuple)):
        return [
            serializable
            for nested in value
            if (serializable := serializable_metadata(nested)) is not None
        ]
    if hasattr(value, "model_dump"):
        return serializable_metadata(value.model_dump(mode="json"))
    if hasattr(value, "__dict__"):
        return serializable_metadata(vars(value))
    return str(value)


def optional_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.timestamp()
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def state_name(state: Any) -> str:
    return str(getattr(state, "value", state)).lower()
