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

from director_agent.otto_api import OttoApiClient, stable_key
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
COMPLETION_RETRY_DELAYS_SECONDS = (0.75, 0.75, 1.0, 1.5, 2.0)


@dataclass(frozen=True)
class TranscriptTiming:
    start_ms: int
    end_ms: int
    confidence: float | None
    source: str
    idempotency_parts: tuple[object, ...]
    metadata: dict[str, Any]


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
        self._realtime_turn_handlers_installed = False
        self._active_delivery_events: set[asyncio.Event] = set()
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
        planned = await self._planner.plan_turn(
            capture_session_id=self._capture_session_id,
            turn=ingest,
            idempotency_key=stable_key("plan", self._capture_session_id, ingest.turn_index),
        )
        planned_at = time.perf_counter()
        if self._is_turn_superseded(generation):
            raise StopResponse()
        dispatched = await self._api.dispatch_turn(
            capture_session_id=self._capture_session_id,
            turn=ingest,
            planned=planned,
            idempotency_key=stable_key("turn", self._capture_session_id, ingest.turn_index),
        )
        dispatched_at = time.perf_counter()
        if self._is_turn_superseded(generation):
            await self._mark_delivery_not_spoken(
                turn_index=ingest.turn_index,
                decision_log_id=dispatched.decision_log_id,
                turn_started=turn_started,
                dispatched_at=dispatched_at,
            )
            raise StopResponse()
        await self._publish_data(
            "director.turn.dispatched",
            {
                "turn_index": ingest.turn_index,
                "stage_name": "director.turn",
                "transcript": utterance,
                "agent_utterance": dispatched.next_prompt,
                "decision_log_id": dispatched.decision_log_id,
                "candidate_process_ids": dispatched.raw.get("candidate_process_ids", []),
                "slot_updates": dispatched.raw.get("slot_updates", []),
                "coverage_slots": dispatched.raw.get("coverage_slots", []),
                "degraded_quality": dispatched.raw.get("degraded_quality", False),
            },
        )
        await self._publish_turn_telemetry(
            ingest_turn_index=ingest.turn_index,
            decision_log_id=dispatched.decision_log_id,
            planned=planned,
            timing={
                "ingest_ms": elapsed_ms(turn_started, ingested_at),
                "plan_ms": elapsed_ms(ingested_at, planned_at),
                "dispatch_ms": elapsed_ms(planned_at, dispatched_at),
                "pre_tts_total_ms": elapsed_ms(turn_started, dispatched_at),
            },
            asr_timing_source=timing.source,
        )
        if self._is_turn_superseded(generation):
            await self._mark_delivery_not_spoken(
                turn_index=ingest.turn_index,
                decision_log_id=dispatched.decision_log_id,
                turn_started=turn_started,
                dispatched_at=dispatched_at,
            )
            raise StopResponse()

        speech = None
        speech_started_at = 0.0
        try:
            speech_started_at = time.perf_counter()
            speech = self.session.say(dispatched.next_prompt, allow_interruptions=True)
            self._active_speech = speech
            await speech.wait_for_playout()
        except Exception:
            failed_at = time.perf_counter()
            if self._paused or self._muted or self._ended or getattr(speech, "interrupted", False):
                await self._mark_delivery_interrupted_after_tts(
                    turn_index=ingest.turn_index,
                    decision_log_id=dispatched.decision_log_id,
                    utterance=dispatched.next_prompt,
                    turn_started=turn_started,
                    dispatched_at=dispatched_at,
                    speech_started_at=speech_started_at,
                    interrupted_at=failed_at,
                )
                raise StopResponse()
            failed_latency = {
                "tts_playout_ms": elapsed_ms(dispatched_at, failed_at),
                "turn_total_ms": elapsed_ms(turn_started, failed_at),
            }
            await self._api.update_delivery(
                capture_session_id=self._capture_session_id,
                turn_index=ingest.turn_index,
                decision_log_id=dispatched.decision_log_id,
                delivery_status="failed_text_fallback",
                delivered_utterance=dispatched.next_prompt,
                spoken_fraction=0,
                latency_ms=failed_latency,
                audio_metadata=self._tts_audio_metadata,
                idempotency_key=delivery_idempotency_key(
                    self._capture_session_id,
                    ingest.turn_index,
                ),
            )
            await self._publish_delivery_update(
                turn_index=ingest.turn_index,
                decision_log_id=dispatched.decision_log_id,
                delivery_status="failed_text_fallback",
                agent_utterance=dispatched.next_prompt,
                spoken_fraction=0,
                latency_ms=failed_latency,
            )
            raise StopResponse()
        finally:
            self._active_speech = None

        delivered_at = time.perf_counter()
        delivery_status = (
            "truncated"
            if speech.interrupted or self._is_turn_superseded(generation)
            else "completed"
        )
        spoken_fraction = (
            estimated_spoken_fraction(dispatched.next_prompt, speech_started_at, delivered_at)
            if speech.interrupted
            else 1
        )
        delivery_latency = {
            "tts_playout_ms": elapsed_ms(dispatched_at, delivered_at),
            "turn_total_ms": elapsed_ms(turn_started, delivered_at),
        }
        delivered_utterance = delivered_utterance_for_status(
            dispatched.next_prompt,
            delivery_status=delivery_status,
            spoken_fraction=spoken_fraction,
        )
        await self._api.update_delivery(
            capture_session_id=self._capture_session_id,
            turn_index=ingest.turn_index,
            decision_log_id=dispatched.decision_log_id,
            delivery_status=delivery_status,
            delivered_utterance=delivered_utterance,
            spoken_fraction=spoken_fraction,
            latency_ms=delivery_latency,
            audio_metadata=self._tts_audio_metadata,
            idempotency_key=delivery_idempotency_key(
                self._capture_session_id,
                ingest.turn_index,
            ),
        )
        await self._publish_delivery_update(
            turn_index=ingest.turn_index,
            decision_log_id=dispatched.decision_log_id,
            delivery_status=delivery_status,
            agent_utterance=delivered_utterance,
            spoken_fraction=spoken_fraction,
            latency_ms=delivery_latency,
        )
        raise StopResponse()

    async def _mark_delivery_not_spoken(
        self,
        *,
        turn_index: int,
        decision_log_id: str,
        turn_started: float,
        dispatched_at: float,
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
                "brain": raw.get("metadata") or getattr(planned, "metadata", None),
                "voice": raw.get("voice_metadata") or getattr(planned, "voice_metadata", None),
                "degraded_quality": getattr(planned, "degraded_quality", False),
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
            self.session.on("user_state_changed", self._on_user_state_changed)
            self.session.on("user_input_transcribed", self._on_user_input_transcribed)
        except Exception as error:
            LOGGER.warning("Failed to install realtime turn handlers: %s", error)

    def _on_user_state_changed(self, event: Any) -> None:
        if state_name(getattr(event, "new_state", "")) == "speaking":
            self._supersede_active_turn()

    def _on_user_input_transcribed(self, event: Any) -> None:
        transcript = str(getattr(event, "transcript", "") or "").strip()
        if transcript and not bool(getattr(event, "is_final", False)):
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
                    not is_delivery_pending_completion_error(error)
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
    content = getattr(message, "text_content", "")
    if callable(content):
        return str(content())
    return str(content or "")


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


def is_delivery_pending_completion_error(error: Exception) -> bool:
    return "delivery_pending" in str(error)


def delivered_utterance_for_status(
    utterance: str,
    *,
    delivery_status: str,
    spoken_fraction: float,
) -> str:
    if delivery_status != "truncated":
        return utterance
    trimmed = utterance.strip()
    if not trimmed:
        return trimmed
    if spoken_fraction <= 0:
        return ""
    boundary = max(1, min(len(trimmed), int(len(trimmed) * spoken_fraction)))
    next_space = trimmed.find(" ", boundary)
    if 0 <= next_space <= boundary + 24:
        boundary = next_space
    return trimmed[:boundary].rstrip() + "..."


def estimated_spoken_fraction(
    utterance: str,
    speech_started_at: float,
    delivered_at: float,
) -> float:
    trimmed = utterance.strip()
    if not trimmed:
        return 0
    playout_ms = elapsed_ms(speech_started_at, delivered_at)
    estimated_total_ms = estimated_tts_duration_ms(trimmed)
    fraction = playout_ms / estimated_total_ms
    return round(max(0.05, min(0.95, fraction)), 2)


def estimated_tts_duration_ms(utterance: str) -> int:
    word_count = max(1, len(utterance.split()))
    return max(700, word_count * 360)


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


def elapsed_ms(start: float, end: float) -> int:
    return max(0, int((end - start) * 1000))


def state_name(state: Any) -> str:
    return str(getattr(state, "value", state)).lower()
