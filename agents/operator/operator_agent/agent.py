from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import replace
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
SCREEN_TRACK_SOURCE_MARKERS = ("screen", "screenshare", "screen_share")


class OperatorWorkflowAgent(Agent):
    def __init__(
        self,
        *,
        capture_session_id: str,
        api: OperatorApiClient,
        room: rtc.Room,
        initial_turn_counter: int = 0,
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
        self._tts_audio_metadata = dict(
            tts_audio_metadata or LIVEKIT_CARTESIA_AUDIO_METADATA
        )
        self._paused = False
        self._muted = False
        self._ended = False
        self._active_speech: Any | None = None
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
