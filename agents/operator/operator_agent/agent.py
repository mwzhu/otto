from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, replace
from typing import Any

from livekit import rtc
from livekit.agents import Agent, ChatContext, ChatMessage, StopResponse
from otto_realtime_core import (
    delivered_utterance_for_status as core_delivered_utterance_for_status,
    elapsed_ms,
    estimated_spoken_fraction as core_estimated_spoken_fraction,
    json_bytes,
    notice_reason,
    text_content,
)

from operator_agent.otto_api import (
    IngestedTurn,
    OperatorApiClient,
    PlannedTurn,
    RespondedTurn,
    stable_key,
)


LOGGER = logging.getLogger(__name__)
MAX_TRANSCRIPT_TIMING_MS = 2_000_000_000
LIVEKIT_CARTESIA_AUDIO_METADATA = {
    "source": "livekit_agents",
    "provider": "cartesia",
    "playout": "session.say.wait_for_playout",
}
OPERATOR_DISPATCH_RETRY_DELAYS_SECONDS = (0.35, 0.75)
OPERATOR_COMPLETION_RETRY_DELAYS_SECONDS = (0.75, 1.0, 1.5)
OPERATOR_COMPLETION_EXTRACTION_WAIT_SECONDS = 60.0
EXTRACTION_WINDOW_DEBOUNCE_SECONDS = 1.0
SCREEN_TRACK_SOURCE_MARKERS = ("screen", "screenshare", "screen_share")


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


class OperatorWorkflowAgent(Agent):
    def __init__(
        self,
        *,
        capture_session_id: str,
        api: OperatorApiClient,
        room: rtc.Room,
        initial_turn_counter: int = 0,
        voice_runtime: str = "planned_cascade",
        tts_audio_metadata: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            instructions=(
                "You are Otto, a concise workflow mapper interviewing an operator. "
                "The next spoken question is planned by Otto's operator planner. "
                "Do not improvise extra questions."
            )
        )
        self._capture_session_id = capture_session_id
        self._api = api
        self._room = room
        self._turn_counter = max(0, initial_turn_counter)
        self._voice_runtime = voice_runtime
        self._tts_audio_metadata = dict(
            tts_audio_metadata or LIVEKIT_CARTESIA_AUDIO_METADATA
        )
        self._paused = False
        self._muted = False
        self._ended = False
        self._active_speech: Any | None = None
        self._active_extraction_tasks: dict[int, asyncio.Task[Any]] = {}
        self._active_checker_tasks: dict[int, asyncio.Task[Any]] = {}
        self._pending_extraction_turns: set[int] = set()
        self._pending_slot_paths: set[str] = set()
        self._last_spoken_intent: str | None = None
        self._extraction_window_lock = asyncio.Lock()
        self._open_extraction_window: PendingExtractionWindow | None = None
        self._open_extraction_task: asyncio.Task[Any] | None = None
        self._turn_generation = 0
        self._screen_observer_started_at = time.perf_counter()
        self._screen_event_counter = 0
        self._room.on("data_received", self._on_data_received)
        self._room.on("track_subscribed", self._on_track_subscribed)
        self._room.on("track_unsubscribed", self._on_track_unsubscribed)

    async def on_enter(self) -> None:
        await self._publish_data(
            "operator.session.notice",
            {
                "notice_type": "operator_agent_ready",
                "capture_session_id": self._capture_session_id,
            },
        )

    async def on_user_turn_completed(
        self,
        turn_ctx: ChatContext,
        new_message: ChatMessage,
    ) -> None:
        del turn_ctx
        generation = self._start_turn_generation()
        utterance = text_content(new_message).strip()
        if self._paused or self._muted or self._ended or not utterance:
            raise StopResponse()
        turn_started = time.perf_counter()
        ordinal = self._turn_counter
        self._turn_counter += 1
        timing = transcript_timing_from_message(new_message, utterance, ordinal)

        ingest = await self._api.ingest_turn(
            capture_session_id=self._capture_session_id,
            utterance=utterance,
            start_ms=timing["start_ms"],
            end_ms=timing["end_ms"],
            confidence=timing.get("confidence"),
            timing_source=timing["source"],
            metadata_json=timing["metadata"],
            idempotency_key=stable_key(
                "operator-ingest",
                self._capture_session_id,
                timing["source"],
                timing["start_ms"],
                timing["end_ms"],
                utterance,
            ),
        )
        ingested_at = time.perf_counter()
        await self._publish_data(
            "operator.turn.ingested",
            {
                "turn_index": ingest.turn_index,
                "transcript": utterance,
                "transcript_segment_ids": ingest.transcript_segment_ids,
                "evidence_ids": ingest.evidence_ids,
                "asr_timing_source": timing["source"],
            },
        )
        if self._is_turn_superseded(generation):
            raise StopResponse()

        local_turn_correlation_id = stable_key(
            "operator-local-turn",
            self._capture_session_id,
            ingest.turn_index,
        )
        extraction_window_id = await self._extraction_window_id_for_ingest(ingest)
        if self._voice_runtime == "steered_cascade":
            await self._run_decoupled_user_turn(
                ingest=ingest,
                utterance=utterance,
                turn_started=turn_started,
                ingested_at=ingested_at,
                timing_source=timing["source"],
                local_turn_correlation_id=local_turn_correlation_id,
                extraction_window_id=extraction_window_id,
                generation=generation,
            )
            raise StopResponse()
        early_utterance: asyncio.Future[str] = asyncio.get_running_loop().create_future()

        def on_planned_agent_utterance(value: str) -> None:
            utterance = value.strip()
            if utterance and not early_utterance.done():
                early_utterance.set_result(utterance)

        plan_task = asyncio.create_task(
            self._api.plan_turn(
                capture_session_id=self._capture_session_id,
                turn=ingest,
                idempotency_key=stable_key(
                    "operator-plan",
                    self._capture_session_id,
                    ingest.turn_index,
                ),
                on_planned_agent_utterance=on_planned_agent_utterance,
                local_turn_correlation_id=local_turn_correlation_id,
            )
        )
        done, _pending = await asyncio.wait(
            {plan_task, early_utterance},
            return_when=asyncio.FIRST_COMPLETED,
        )
        planned: PlannedTurn | None = None
        speech = None
        speech_started_at = 0.0
        spoken_utterance: str | None = None
        if early_utterance in done and not self._is_turn_superseded(generation):
            spoken_utterance = early_utterance.result()
            speech_started_at = time.perf_counter()
            speech = self.session.say(spoken_utterance, allow_interruptions=True)
            self._active_speech = speech
        if plan_task in done:
            planned = plan_task.result()
        else:
            planned = await plan_task
        if spoken_utterance is None:
            spoken_utterance = planned.planned_agent_utterance
        superseded_before_dispatch = self._is_turn_superseded(generation)

        planned_for_dispatch = (
            replace(
                planned,
                planned_agent_utterance=spoken_utterance,
                raw={
                    **planned.raw,
                    "spoken_planned_agent_utterance": spoken_utterance,
                    "local_turn_correlation_id": local_turn_correlation_id,
                },
            )
            if planned.planned_agent_utterance != spoken_utterance
            else planned
        )
        dispatch_idempotency_key = stable_key(
            "operator-dispatch",
            self._capture_session_id,
            ingest.turn_index,
        )
        dispatch_delays = OPERATOR_DISPATCH_RETRY_DELAYS_SECONDS if speech is not None else ()
        dispatch_error: Exception | None = None
        dispatched = None
        for dispatch_attempt, delay_seconds in enumerate((0.0, *dispatch_delays)):
            if delay_seconds:
                await asyncio.sleep(delay_seconds)
            try:
                dispatched = await self._api.dispatch_turn(
                    capture_session_id=self._capture_session_id,
                    turn=ingest,
                    planned=planned_for_dispatch,
                    idempotency_key=dispatch_idempotency_key,
                    local_turn_correlation_id=local_turn_correlation_id,
                )
                if dispatch_attempt > 0:
                    LOGGER.info(
                        "Operator dispatch recovered after retry for turn %s",
                        ingest.turn_index,
                    )
                break
            except Exception as error:
                dispatch_error = error
        try:
            if dispatched is None:
                raise dispatch_error or RuntimeError("Operator dispatch failed.")
        except Exception as error:
            if speech is None:
                raise
            self._interrupt_active_speech()
            reason = notice_reason(error)
            await self._publish_data(
                "operator.session.notice",
                {
                    "notice_type": "dispatch_failed_after_tts_start",
                    "turn_index": ingest.turn_index,
                    "local_turn_correlation_id": local_turn_correlation_id,
                },
            )
            await self._api.record_notice(
                capture_session_id=self._capture_session_id,
                stage_name="operator.notice.dispatch_failed_after_tts_start",
                turn_index=ingest.turn_index,
                planned_agent_utterance=spoken_utterance,
                local_turn_correlation_id=local_turn_correlation_id,
                reason=reason,
                idempotency_key=stable_key(
                    "operator-notice",
                    self._capture_session_id,
                    ingest.turn_index,
                    "dispatch_failed_after_tts_start",
                ),
            )
            raise StopResponse()
        await self._publish_data(
            "operator.turn.dispatched",
            {
                "turn_index": ingest.turn_index,
                "agent_utterance": spoken_utterance,
                "decision_log_id": dispatched.decision_log_id,
                "degraded_quality": planned.degraded_quality,
                "degraded_reasons": planned.degraded_reasons,
                "local_turn_correlation_id": local_turn_correlation_id,
                "superseded_before_dispatch": superseded_before_dispatch,
            },
        )

        if superseded_before_dispatch:
            delivered_at = time.perf_counter()
            if speech is not None:
                try:
                    await speech.wait_for_playout()
                    delivered_at = time.perf_counter()
                except Exception:
                    LOGGER.debug("Operator speech playout ended during supersession", exc_info=True)
            spoken_fraction = (
                estimated_spoken_fraction(spoken_utterance, speech_started_at, delivered_at)
                if speech is not None and speech_started_at > 0
                else 0
            )
            delivered_utterance = delivered_utterance_for_status(
                spoken_utterance,
                delivery_status="truncated",
                spoken_fraction=spoken_fraction,
            )
            await self._api.update_delivery(
                capture_session_id=self._capture_session_id,
                turn_index=ingest.turn_index,
                decision_log_id=dispatched.decision_log_id,
                delivery_status="truncated",
                delivered_utterance=delivered_utterance,
                spoken_fraction=spoken_fraction,
                latency_ms={
                    "pre_tts_total_ms": (
                        elapsed_ms(turn_started, speech_started_at)
                        if speech is not None and speech_started_at > 0
                        else 0
                    ),
                    "turn_total_ms": elapsed_ms(turn_started, delivered_at),
                    "tts_playout_ms": (
                        elapsed_ms(speech_started_at, delivered_at)
                        if speech is not None and speech_started_at > 0
                        else 0
                    ),
                    "superseded_before_dispatch_ms": elapsed_ms(turn_started, delivered_at),
                },
                audio_metadata={
                    **self._tts_audio_metadata,
                    "superseded_before_dispatch": True,
                },
                local_turn_correlation_id=local_turn_correlation_id,
                idempotency_key=stable_key(
                    "operator-delivery",
                    self._capture_session_id,
                    ingest.turn_index,
                    dispatched.decision_log_id,
                    "truncated-before-dispatch",
                ),
            )
            await self._publish_data(
                "operator.turn.delivery_updated",
                {
                    "turn_index": ingest.turn_index,
                    "decision_log_id": dispatched.decision_log_id,
                    "delivery_status": "truncated",
                    "agent_utterance": delivered_utterance,
                    "spoken_fraction": spoken_fraction,
                    "local_turn_correlation_id": local_turn_correlation_id,
                    "superseded_before_dispatch": True,
                },
            )
            raise StopResponse()

        if speech is None:
            speech_started_at = time.perf_counter()
            speech = self.session.say(spoken_utterance, allow_interruptions=True)
            self._active_speech = speech
        await speech.wait_for_playout()
        delivered_at = time.perf_counter()
        delivery_status = "truncated" if getattr(speech, "interrupted", False) else "completed"
        spoken_fraction = (
            estimated_spoken_fraction(spoken_utterance, speech_started_at, delivered_at)
            if delivery_status == "truncated"
            else 1
        )
        await self._api.update_delivery(
            capture_session_id=self._capture_session_id,
            turn_index=ingest.turn_index,
            decision_log_id=dispatched.decision_log_id,
            delivery_status=delivery_status,
            delivered_utterance=delivered_utterance_for_status(
                spoken_utterance,
                delivery_status=delivery_status,
                spoken_fraction=spoken_fraction,
            ),
            spoken_fraction=spoken_fraction,
            latency_ms={
                "pre_tts_total_ms": elapsed_ms(turn_started, speech_started_at),
                "turn_total_ms": elapsed_ms(turn_started, delivered_at),
                "tts_playout_ms": elapsed_ms(speech_started_at, delivered_at),
            },
            audio_metadata=self._tts_audio_metadata,
            local_turn_correlation_id=local_turn_correlation_id,
            idempotency_key=stable_key(
                "operator-delivery",
                self._capture_session_id,
                ingest.turn_index,
                dispatched.decision_log_id,
                delivery_status,
            ),
        )
        await self._publish_data(
            "operator.turn.delivery_updated",
            {
                "turn_index": ingest.turn_index,
                "decision_log_id": dispatched.decision_log_id,
                "delivery_status": delivery_status,
                "agent_utterance": delivered_utterance_for_status(
                    spoken_utterance,
                    delivery_status=delivery_status,
                    spoken_fraction=spoken_fraction,
                ),
                "spoken_fraction": spoken_fraction,
                "local_turn_correlation_id": local_turn_correlation_id,
            },
        )

    async def _run_decoupled_user_turn(
        self,
        *,
        ingest: IngestedTurn,
        utterance: str,
        turn_started: float,
        ingested_at: float,
        timing_source: str,
        local_turn_correlation_id: str,
        extraction_window_id: str,
        generation: int,
    ) -> None:
        early_utterance: asyncio.Future[str] = asyncio.get_running_loop().create_future()

        def on_planned_agent_utterance(value: str) -> None:
            spoken = value.strip()
            if spoken and not early_utterance.done():
                early_utterance.set_result(spoken)

        respond_task = asyncio.create_task(
            self._api.respond_turn(
                capture_session_id=self._capture_session_id,
                turn=ingest,
                idempotency_key=stable_key(
                    "operator-respond",
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
        chosen_intent = responded.plan.get("chosen_intent")
        if isinstance(chosen_intent, dict) and chosen_intent.get("intent"):
            self._last_spoken_intent = str(chosen_intent["intent"])
        await self._queue_background_extraction(
            ingest=ingest,
            spoken_utterance=spoken_utterance,
            target_slots=target_slots,
            extraction_window_id=extraction_window_id,
            local_turn_correlation_id=local_turn_correlation_id,
        )
        await self._publish_data(
            "operator.turn.dispatched",
            {
                "turn_index": ingest.turn_index,
                "stage_name": "operator.turn",
                "transcript": utterance,
                "agent_utterance": spoken_utterance,
                "decision_log_id": responded.decision_log_id,
                "degraded_quality": responded.degraded_quality,
                "degraded_reasons": responded.degraded_reasons,
                "local_turn_correlation_id": local_turn_correlation_id,
                "extraction_status": "pending",
                "steering_lag_turns": len(self._pending_extraction_turns),
                "asr_timing_source": timing_source,
            },
        )
        await self._publish_data(
            "operator.turn.telemetry",
            {
                "turn_index": ingest.turn_index,
                "decision_log_id": responded.decision_log_id,
                "ingest_ms": elapsed_ms(turn_started, ingested_at),
                "respond_ms": elapsed_ms(ingested_at, responded_at),
                "pre_tts_total_ms": (
                    elapsed_ms(turn_started, speech_started_at)
                    if speech is not None and speech_started_at > 0
                    else elapsed_ms(turn_started, responded_at)
                ),
                "steering_lag_turns": len(self._pending_extraction_turns),
                "pending_extraction_count": len(self._pending_extraction_turns),
            },
        )
        checker_task = asyncio.create_task(
            self._run_background_output_check(
                ingest=ingest,
                decision_log_id=responded.decision_log_id,
                spoken_utterance=spoken_utterance,
                steering_context=steering_context,
                local_turn_correlation_id=local_turn_correlation_id,
            )
        )
        self._active_checker_tasks[ingest.turn_index] = checker_task
        checker_task.add_done_callback(
            lambda task, turn_index=ingest.turn_index: self._on_checker_task_done(
                turn_index,
                task,
            )
        )

        if self._is_turn_superseded(generation):
            stopped_at = time.perf_counter()
            if speech is None:
                await self._api.update_delivery(
                    capture_session_id=self._capture_session_id,
                    turn_index=ingest.turn_index,
                    decision_log_id=responded.decision_log_id,
                    delivery_status="truncated",
                    delivered_utterance="",
                    spoken_fraction=0,
                    latency_ms={
                        "turn_total_ms": elapsed_ms(turn_started, stopped_at),
                        "pre_tts_cancelled_ms": elapsed_ms(responded_at, stopped_at),
                    },
                    local_turn_correlation_id=local_turn_correlation_id,
                    idempotency_key=stable_key(
                        "operator-delivery",
                        self._capture_session_id,
                        ingest.turn_index,
                        responded.decision_log_id,
                        "truncated-before-speech",
                    ),
                )
            else:
                spoken_fraction = estimated_spoken_fraction(
                    spoken_utterance,
                    speech_started_at,
                    stopped_at,
                )
                await self._api.update_delivery(
                    capture_session_id=self._capture_session_id,
                    turn_index=ingest.turn_index,
                    decision_log_id=responded.decision_log_id,
                    delivery_status="truncated",
                    delivered_utterance=delivered_utterance_for_status(
                        spoken_utterance,
                        delivery_status="truncated",
                        spoken_fraction=spoken_fraction,
                    ),
                    spoken_fraction=spoken_fraction,
                    latency_ms={
                        "turn_total_ms": elapsed_ms(turn_started, stopped_at),
                        "tts_playout_ms": elapsed_ms(speech_started_at, stopped_at),
                    },
                    audio_metadata=self._tts_audio_metadata,
                    local_turn_correlation_id=local_turn_correlation_id,
                    idempotency_key=stable_key(
                        "operator-delivery",
                        self._capture_session_id,
                        ingest.turn_index,
                        responded.decision_log_id,
                        "truncated-after-speech",
                    ),
                )
            return

        if speech is None:
            speech_started_at = time.perf_counter()
            speech = self.session.say(spoken_utterance, allow_interruptions=True)
            self._active_speech = speech
        try:
            await speech.wait_for_playout()
        except Exception:
            failed_at = time.perf_counter()
            if self._paused or self._muted or self._ended or getattr(speech, "interrupted", False):
                delivery_status = "truncated"
                spoken_fraction = estimated_spoken_fraction(
                    spoken_utterance,
                    speech_started_at,
                    failed_at,
                )
            else:
                delivery_status = "failed_text_fallback"
                spoken_fraction = 0.0
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
                latency_ms={
                    "pre_tts_total_ms": elapsed_ms(turn_started, speech_started_at),
                    "turn_total_ms": elapsed_ms(turn_started, failed_at),
                    "tts_playout_ms": elapsed_ms(speech_started_at, failed_at),
                },
                audio_metadata=self._tts_audio_metadata,
                local_turn_correlation_id=local_turn_correlation_id,
                idempotency_key=stable_key(
                    "operator-delivery",
                    self._capture_session_id,
                    ingest.turn_index,
                    responded.decision_log_id,
                    delivery_status,
                ),
            )
            await self._publish_data(
                "operator.turn.delivery_updated",
                {
                    "turn_index": ingest.turn_index,
                    "decision_log_id": responded.decision_log_id,
                    "delivery_status": delivery_status,
                    "agent_utterance": delivered_utterance,
                    "spoken_fraction": spoken_fraction,
                    "local_turn_correlation_id": local_turn_correlation_id,
                },
            )
            return
        finally:
            self._active_speech = None

        delivered_at = time.perf_counter()
        delivery_status = (
            "truncated"
            if getattr(speech, "interrupted", False) or self._is_turn_superseded(generation)
            else "completed"
        )
        spoken_fraction = (
            estimated_spoken_fraction(spoken_utterance, speech_started_at, delivered_at)
            if delivery_status == "truncated"
            else 1
        )
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
            latency_ms={
                "pre_tts_total_ms": elapsed_ms(turn_started, speech_started_at),
                "turn_total_ms": elapsed_ms(turn_started, delivered_at),
                "tts_playout_ms": elapsed_ms(speech_started_at, delivered_at),
            },
            audio_metadata=self._tts_audio_metadata,
            local_turn_correlation_id=local_turn_correlation_id,
            idempotency_key=stable_key(
                "operator-delivery",
                self._capture_session_id,
                ingest.turn_index,
                responded.decision_log_id,
                delivery_status,
            ),
        )
        await self._publish_data(
            "operator.turn.delivery_updated",
            {
                "turn_index": ingest.turn_index,
                "decision_log_id": responded.decision_log_id,
                "delivery_status": delivery_status,
                "agent_utterance": delivered_utterance,
                "spoken_fraction": spoken_fraction,
                "local_turn_correlation_id": local_turn_correlation_id,
            },
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
        result = await self._api.extract_turn(
            capture_session_id=self._capture_session_id,
            turn=window_turn,
            spoken_agent_utterance=(
                window.spoken_utterances[-1]
                if window.spoken_utterances
                else combined_utterance
            ),
            local_turn_correlation_id=window.local_turn_correlation_id,
            extraction_window_id=window.extraction_window_id,
            idempotency_key=stable_key(
                "operator-extract",
                self._capture_session_id,
                window.extraction_window_id,
            ),
        )
        await self._publish_data(
            "operator.turn.extracted",
            {
                "turn_index": window.turn_index,
                "decision_log_id": result.get("decision_log_id"),
                "extraction_status": result.get("extraction_status", "complete"),
                "extraction_latency_ms": result.get("extraction_latency_ms"),
                "slot_update_latency_ms": result.get("slot_update_latency_ms"),
                "extraction_window_id": window.extraction_window_id,
                "degraded_quality": result.get("degraded_quality", False),
                "degraded_reasons": result.get("degraded_reasons", []),
            },
        )
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
                "operator-extraction-window",
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
                )
            window = self._open_extraction_window
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
                "Operator async extraction failed for turn %s: %s",
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
                "Operator async extraction failed for turns %s: %s",
                turn_indexes,
                error,
            )

    async def _run_background_output_check(
        self,
        *,
        ingest: IngestedTurn,
        decision_log_id: str,
        spoken_utterance: str,
        steering_context: dict[str, Any],
        local_turn_correlation_id: str,
    ) -> None:
        result = await self._api.check_turn(
            capture_session_id=self._capture_session_id,
            turn=ingest,
            decision_log_id=decision_log_id,
            spoken_agent_utterance=spoken_utterance,
            steering_context=steering_context,
            local_turn_correlation_id=local_turn_correlation_id,
            idempotency_key=stable_key(
                "operator-check",
                self._capture_session_id,
                decision_log_id,
                ingest.turn_index,
            ),
        )
        await self._publish_data(
            "operator.turn.output_checked",
            {
                "turn_index": ingest.turn_index,
                "checker_status": result.get("checker_status", "complete"),
                "checker_violations": result.get("checker_violations", []),
                "checker_violation_count": result.get("checker_violation_count", 0),
                "stale_question_count": result.get("stale_question_count", 0),
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
                "Operator async output checker failed for turn %s: %s",
                turn_index,
                error,
            )

    def _on_data_received(self, packet: rtc.DataPacket) -> None:
        if getattr(packet, "topic", None) != "otto.operator.control":
            return
        try:
            raw = packet.data.decode("utf-8")
            message = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if not isinstance(message, dict):
            return
        if message.get("source") != "otto_browser_client":
            return
        if message.get("capture_session_id") != self._capture_session_id:
            return
        payload = message.get("payload")
        if not isinstance(payload, dict):
            return
        event = message.get("event")
        action = payload.get("action")
        if event not in {"operator.control", action}:
            return
        if action == "pause":
            self._paused = True
            self._interrupt_active_speech()
            asyncio.create_task(
                self._publish_control_update(
                    "pause", self._paused, self._muted, self._ended
                )
            )
        elif action == "resume":
            self._paused = False
            asyncio.create_task(
                self._publish_control_update(
                    "resume", self._paused, self._muted, self._ended
                )
            )
        elif action == "mute":
            self._muted = True
            asyncio.create_task(
                self._publish_control_update(
                    "mute", self._paused, self._muted, self._ended
                )
            )
        elif action == "unmute":
            self._muted = False
            asyncio.create_task(
                self._publish_control_update(
                    "unmute", self._paused, self._muted, self._ended
                )
            )
        elif action == "end":
            self._ended = True
            self._paused = True
            self._interrupt_active_speech()
            asyncio.create_task(
                self._publish_control_update(
                    "end", self._paused, self._muted, self._ended
                )
            )
            asyncio.create_task(self._complete_session_and_disconnect())

    def _on_track_subscribed(self, *args: Any) -> None:
        self._handle_screen_track_event("screen_share_track_subscribed", args)

    def _on_track_unsubscribed(self, *args: Any) -> None:
        self._handle_screen_track_event("screen_share_track_unsubscribed", args)

    def _handle_screen_track_event(self, event_type: str, args: tuple[Any, ...]) -> None:
        if not any(is_screen_share_object(arg) for arg in args):
            return
        metadata = screen_track_event_metadata(args)
        self._screen_event_counter += 1
        ts_ms = elapsed_ms(self._screen_observer_started_at, time.perf_counter())
        asyncio.create_task(
            self._record_screen_track_event(
                event_type=event_type,
                ts_ms=ts_ms,
                metadata_json=metadata,
                ordinal=self._screen_event_counter,
            )
        )

    async def _record_screen_track_event(
        self,
        *,
        event_type: str,
        ts_ms: int,
        metadata_json: dict[str, Any],
        ordinal: int,
    ) -> None:
        track_id = first_metadata_value(metadata_json, "sid", "track_sid", "name")
        try:
            await self._api.create_screen_event(
                capture_session_id=self._capture_session_id,
                ts_ms=ts_ms,
                event_type=event_type,
                app_name="livekit",
                ui_state_label=(
                    "Operator screen share started"
                    if event_type == "screen_share_track_subscribed"
                    else "Operator screen share stopped"
                ),
                signal_tags=[
                    "screen_track_observed",
                    "livekit_screen_share",
                    event_type,
                ],
                metadata_json={
                    "source": "operator_livekit_worker",
                    "observer": "track_subscription",
                    "ordinal": ordinal,
                    **metadata_json,
                },
                idempotency_key=stable_key(
                    "operator-screen-track",
                    self._capture_session_id,
                    event_type,
                    track_id or ordinal,
                ),
            )
            await self._publish_data(
                "operator.screen_track.observed",
                {
                    "event_type": event_type,
                    "ts_ms": ts_ms,
                    "track_id": track_id,
                },
            )
        except Exception:
            LOGGER.debug("Failed to record operator screen track event", exc_info=True)

    async def _complete_session_and_disconnect(self) -> None:
        completed = False
        try:
            await self._complete_session_with_retry()
            completed = True
        except Exception as error:
            LOGGER.warning("Failed to complete operator session on end control: %s", error)
            await self._publish_data(
                "operator.session.notice",
                {
                    "notice_type": "failed_completion",
                    "message": "The capture stopped, but completion did not save. Press Complete again to retry.",
                },
            )
        finally:
            if completed:
                disconnect = getattr(self._room, "disconnect", None)
                if callable(disconnect):
                    result = disconnect()
                    if asyncio.iscoroutine(result):
                        await result

    async def _complete_session_with_retry(self) -> None:
        await self._flush_open_extraction_window_for_completion()
        extraction_tasks = [
            task for task in set(self._active_extraction_tasks.values()) if not task.done()
        ]
        if extraction_tasks:
            done, pending = await asyncio.wait(
                extraction_tasks,
                timeout=OPERATOR_COMPLETION_EXTRACTION_WAIT_SECONDS,
            )
            for task in done:
                if task.cancelled():
                    continue
                error = task.exception()
                if error is not None:
                    LOGGER.warning(
                        "Operator completion waited on failed extraction: %s",
                        error,
                    )
            if pending:
                LOGGER.warning(
                    "Operator completion continuing with %s extraction task(s) pending",
                    len(pending),
                )
        idempotency_key = stable_key(
            "operator-complete",
            self._capture_session_id,
            "livekit_end",
        )
        last_error: Exception | None = None
        for attempt in range(len(OPERATOR_COMPLETION_RETRY_DELAYS_SECONDS) + 1):
            try:
                await self._api.complete_session(
                    capture_session_id=self._capture_session_id,
                    idempotency_key=idempotency_key,
                )
                await self._publish_data(
                    "operator.session.completed",
                    {
                        "capture_session_id": self._capture_session_id,
                        "next": "synthesis",
                    },
                )
                return
            except Exception as error:
                last_error = error
                if attempt >= len(OPERATOR_COMPLETION_RETRY_DELAYS_SECONDS):
                    raise
                await asyncio.sleep(OPERATOR_COMPLETION_RETRY_DELAYS_SECONDS[attempt])
        if last_error is not None:
            raise last_error

    async def _publish_control_update(
        self,
        action: str,
        paused: bool,
        muted: bool,
        ended: bool,
    ) -> None:
        await self._publish_data(
            "operator.control.updated",
            {
                "action": action,
                "paused": paused,
                "muted": muted,
                "ended": ended,
            },
        )

    async def _publish_data(self, event: str, payload: dict[str, Any]) -> None:
        local_participant = getattr(self._room, "local_participant", None)
        if not local_participant:
            return
        await local_participant.publish_data(
            json_bytes(
                {
                    "source": "otto_operator_agent",
                    "capture_session_id": self._capture_session_id,
                    "event": event,
                    "payload": payload,
                }
            ),
            reliable=True,
            topic="otto.operator",
        )

    def _start_turn_generation(self) -> int:
        self._turn_generation += 1
        self._interrupt_active_speech()
        return self._turn_generation

    def _is_turn_superseded(self, generation: int) -> bool:
        return (
            generation != self._turn_generation
            or self._paused
            or self._muted
            or self._ended
        )

    def _interrupt_active_speech(self) -> None:
        speech = self._active_speech
        if speech is None:
            return
        interrupt = getattr(speech, "interrupt", None)
        if callable(interrupt):
            try:
                interrupt()
            except Exception:
                LOGGER.debug("Failed to interrupt active operator speech", exc_info=True)


def transcript_timing_from_message(
    message: ChatMessage,
    utterance: str,
    ordinal: int,
) -> dict[str, Any]:
    metadata = {
        "source": "livekit_agents",
        "ordinal": ordinal,
        "message_type": message.__class__.__name__,
    }
    start_ms = ordinal * 10_000
    duration_ms = max(1_000, min(60_000, len(utterance) * 45))
    return {
        "start_ms": min(start_ms, MAX_TRANSCRIPT_TIMING_MS),
        "end_ms": min(start_ms + duration_ms, MAX_TRANSCRIPT_TIMING_MS),
        "confidence": None,
        "source": "livekit_agents_estimated",
        "metadata": metadata,
    }


def delivered_utterance_for_status(
    utterance: str,
    *,
    delivery_status: str,
    spoken_fraction: float,
) -> str | None:
    return core_delivered_utterance_for_status(
        utterance,
        delivery_status=delivery_status,
        spoken_fraction=spoken_fraction,
        failed_text_returns_none=True,
    )


def estimated_spoken_fraction(utterance: str, started_at: float, ended_at: float) -> float:
    return core_estimated_spoken_fraction(
        utterance,
        started_at,
        ended_at,
        seconds_per_word=0.4,
        minimum_duration_seconds=0.75,
    )


def is_screen_share_object(value: Any) -> bool:
    for attribute in (
        "source",
        "track_source",
        "kind",
        "name",
        "sid",
        "track_sid",
        "identity",
    ):
        marker = metadata_text(getattr(value, attribute, None))
        if any(candidate in marker for candidate in SCREEN_TRACK_SOURCE_MARKERS):
            return True
    return False


def screen_track_event_metadata(args: tuple[Any, ...]) -> dict[str, Any]:
    labels = ("track", "publication", "participant")
    metadata: dict[str, Any] = {"argument_count": len(args)}
    for index, value in enumerate(args):
        label = labels[index] if index < len(labels) else f"argument_{index}"
        metadata[label] = public_object_metadata(value)
    return metadata


def public_object_metadata(value: Any) -> dict[str, Any]:
    fields = (
        "sid",
        "track_sid",
        "name",
        "kind",
        "source",
        "track_source",
        "identity",
    )
    metadata = {
        field: metadata_text(getattr(value, field, None))
        for field in fields
        if getattr(value, field, None) is not None
    }
    return {key: val for key, val in metadata.items() if val}


def first_metadata_value(metadata: dict[str, Any], *keys: str) -> str | None:
    for value in metadata.values():
        if isinstance(value, dict):
            for key in keys:
                candidate = value.get(key)
                if isinstance(candidate, str) and candidate:
                    return candidate
    return None


def metadata_text(value: Any) -> str:
    if value is None:
        return ""
    name = getattr(value, "name", None)
    if isinstance(name, str) and name:
        return name.lower()
    return str(value).lower()


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
