from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
import unittest
from unittest import mock

from otto_realtime_core import (
    delivered_utterance_for_status,
    estimated_spoken_fraction,
    json_bytes,
    notice_reason,
    text_content,
)
from operator_agent.agent import OperatorWorkflowAgent
from operator_agent.config import OperatorAgentConfig
from operator_agent.otto_api import IngestedTurn, RespondedTurn
from operator_agent.worker import operator_worker_http_port


CAPTURE_SESSION_ID = "14125388-f796-4087-ae34-f18ab845e270"


class OperatorWorkerContractTests(unittest.TestCase):
    def test_operator_worker_uses_non_conflicting_default_http_port(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(operator_worker_http_port(), 8082)

    def test_operator_worker_http_port_can_be_overridden(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {"LIVEKIT_OPERATOR_WORKER_HTTP_PORT": "8092"},
            clear=True,
        ):
            self.assertEqual(operator_worker_http_port(), 8092)

    def test_operator_endpointing_defaults_leave_longer_room_for_narration(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "service-token",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
            },
            clear=True,
        ):
            config = OperatorAgentConfig.from_env()

        self.assertEqual(config.endpointing_min_delay, 2.2)
        self.assertEqual(config.endpointing_max_delay, 8.0)

    def test_shared_realtime_core_covers_operator_worker_primitives(self) -> None:
        self.assertEqual(text_content(SimpleNamespace(content=["Copy", "invoice"])), "Copy invoice")
        self.assertEqual(text_content(SimpleNamespace(text_content=lambda: "Director style")), "Director style")
        self.assertEqual(
            delivered_utterance_for_status(
                "Open Salesforce and export the CSV",
                delivery_status="truncated",
                spoken_fraction=0.5,
                truncate_on_word_boundary=True,
            ),
            "Open Salesforce and...",
        )
        self.assertIsNone(
            delivered_utterance_for_status(
                "Shown as text only",
                delivery_status="failed_text_fallback",
                spoken_fraction=0,
                failed_text_returns_none=True,
            ),
        )
        self.assertGreater(
            estimated_spoken_fraction(
                "Open Salesforce and export the CSV",
                100.0,
                101.0,
                seconds_per_word=0.4,
            ),
            0,
        )
        self.assertEqual(json_bytes({"b": 1, "a": 2}), b'{"a":2,"b":1}')
        self.assertIn("RuntimeError", notice_reason(RuntimeError("dispatch failed")))

    def test_data_channel_controls_pause_mute_resume_and_end_agent(self) -> None:
        class FakeSpeech:
            def __init__(self) -> None:
                self.interrupt_calls = []

            def interrupt(self, *, force: bool = False):
                self.interrupt_calls.append(force)

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = None
                self.handlers = {}
                self.disconnect_called = False

            def on(self, event, handler):
                self.handlers[event] = handler

            async def disconnect(self):
                self.disconnect_called = True

        class FakeApi:
            def __init__(self) -> None:
                self.completed: list[dict] = []

            async def complete_session(self, **kwargs):
                self.completed.append(kwargs)
                return {"capture_session": {"id": kwargs["capture_session_id"]}}

        class FakePacket:
            topic = "otto.operator.control"

            def __init__(
                self,
                action: str,
                *,
                event: str = "operator.control",
                source: str = "otto_browser_client",
                capture_session_id: str = CAPTURE_SESSION_ID,
            ) -> None:
                self.data = json.dumps(
                    {
                        "source": source,
                        "capture_session_id": capture_session_id,
                        "event": event,
                        "payload": {"action": action},
                    }
                ).encode("utf-8")

        async def run_case() -> OperatorWorkflowAgent:
            room = FakeRoom()
            api = FakeApi()
            agent = OperatorWorkflowAgent(
                capture_session_id=CAPTURE_SESSION_ID,
                api=api,
                room=room,
            )
            speech = FakeSpeech()
            agent._active_speech = speech

            wrong_topic = FakePacket("pause")
            wrong_topic.topic = "otto.operator"
            room.handlers["data_received"](wrong_topic)
            self.assertFalse(agent._paused)

            room.handlers["data_received"](
                FakePacket("pause", source="unexpected_source")
            )
            self.assertFalse(agent._paused)

            room.handlers["data_received"](
                FakePacket(
                    "pause",
                    capture_session_id="00000000-0000-0000-0000-000000000000",
                )
            )
            self.assertFalse(agent._paused)

            room.handlers["data_received"](FakePacket("mute"))
            await asyncio.sleep(0)
            self.assertTrue(agent._muted)
            room.handlers["data_received"](FakePacket("unmute"))
            await asyncio.sleep(0)
            self.assertFalse(agent._muted)

            room.handlers["data_received"](FakePacket("pause"))
            await asyncio.sleep(0)
            self.assertTrue(agent._paused)
            self.assertEqual(speech.interrupt_calls, [False])

            room.handlers["data_received"](FakePacket("resume"))
            await asyncio.sleep(0)
            self.assertFalse(agent._paused)

            agent._active_speech = speech
            room.handlers["data_received"](FakePacket("end"))
            await asyncio.sleep(0)
            self.assertTrue(agent._ended)
            self.assertTrue(agent._paused)
            self.assertEqual(speech.interrupt_calls, [False, False])
            await asyncio.sleep(0)
            self.assertTrue(room.disconnect_called)
            self.assertEqual(len(api.completed), 1)
            self.assertEqual(api.completed[0]["capture_session_id"], CAPTURE_SESSION_ID)
            return agent

        asyncio.run(run_case())

    def test_data_channel_controls_publish_state_updates(self) -> None:
        class FakeParticipant:
            def __init__(self) -> None:
                self.calls = []

            async def publish_data(self, payload, *, reliable, topic):
                self.calls.append((payload, reliable, topic))

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = FakeParticipant()
                self.handlers = {}

            def on(self, event, handler):
                self.handlers[event] = handler

        class FakePacket:
            topic = "otto.operator.control"

            def __init__(self, action: str) -> None:
                self.data = json.dumps(
                    {
                        "source": "otto_browser_client",
                        "capture_session_id": CAPTURE_SESSION_ID,
                        "event": "operator.control",
                        "payload": {"action": action},
                    }
                ).encode("utf-8")

        async def run_case() -> FakeRoom:
            room = FakeRoom()
            OperatorWorkflowAgent(
                capture_session_id=CAPTURE_SESSION_ID,
                api=object(),
                room=room,
            )
            room.handlers["data_received"](FakePacket("mute"))
            room.handlers["data_received"](FakePacket("pause"))
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            return room

        room = asyncio.run(run_case())
        decoded = [
            json.loads(payload.decode("utf-8"))
            for payload, reliable, topic in room.local_participant.calls
            if reliable and topic == "otto.operator"
        ]

        self.assertEqual(
            [event["event"] for event in decoded],
            ["operator.control.updated", "operator.control.updated"],
        )
        self.assertEqual(decoded[0]["payload"]["action"], "mute")
        self.assertTrue(decoded[0]["payload"]["muted"])
        self.assertFalse(decoded[0]["payload"]["paused"])
        self.assertEqual(decoded[1]["payload"]["action"], "pause")
        self.assertTrue(decoded[1]["payload"]["muted"])
        self.assertTrue(decoded[1]["payload"]["paused"])

    def test_end_control_publishes_completion_event_before_disconnect(self) -> None:
        class FakeParticipant:
            def __init__(self) -> None:
                self.calls = []

            async def publish_data(self, payload, *, reliable, topic):
                self.calls.append((payload, reliable, topic))

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = FakeParticipant()
                self.handlers = {}
                self.disconnect_called = False

            def on(self, event, handler):
                self.handlers[event] = handler

            async def disconnect(self):
                self.disconnect_called = True

        class FakeApi:
            def __init__(self) -> None:
                self.completed = 0

            async def complete_session(self, **kwargs):
                self.completed += 1
                return {"capture_session": {"id": kwargs["capture_session_id"]}}

        class FakePacket:
            topic = "otto.operator.control"

            def __init__(self) -> None:
                self.data = json.dumps(
                    {
                        "source": "otto_browser_client",
                        "capture_session_id": CAPTURE_SESSION_ID,
                        "event": "operator.control",
                        "payload": {"action": "end"},
                    }
                ).encode("utf-8")

        async def run_case() -> tuple[FakeRoom, FakeApi]:
            room = FakeRoom()
            api = FakeApi()
            OperatorWorkflowAgent(
                capture_session_id=CAPTURE_SESSION_ID,
                api=api,
                room=room,
            )
            room.handlers["data_received"](FakePacket())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            return room, api

        room, api = asyncio.run(run_case())
        decoded = [
            json.loads(payload.decode("utf-8"))
            for payload, reliable, topic in room.local_participant.calls
            if reliable and topic == "otto.operator"
        ]

        self.assertEqual(api.completed, 1)
        self.assertTrue(room.disconnect_called)
        self.assertEqual(decoded[0]["event"], "operator.control.updated")
        self.assertEqual(decoded[1]["event"], "operator.session.completed")
        self.assertEqual(decoded[1]["payload"]["next"], "synthesis")

    def test_screen_share_track_events_create_server_side_screen_events(self) -> None:
        class FakeParticipant:
            def __init__(self) -> None:
                self.calls = []

            async def publish_data(self, payload, *, reliable, topic):
                self.calls.append((payload, reliable, topic))

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = FakeParticipant()
                self.handlers = {}

            def on(self, event, handler):
                self.handlers[event] = handler

        class FakeApi:
            def __init__(self) -> None:
                self.screen_events = []

            async def create_screen_event(self, **kwargs):
                self.screen_events.append(kwargs)
                return {"screen_event": {"id": f"event-{len(self.screen_events)}"}}

        async def run_case() -> tuple[FakeApi, FakeRoom]:
            room = FakeRoom()
            api = FakeApi()
            OperatorWorkflowAgent(
                capture_session_id=CAPTURE_SESSION_ID,
                api=api,
                room=room,
            )
            track = SimpleNamespace(
                sid="TRK_SCREEN_123",
                source=SimpleNamespace(name="SCREEN_SHARE"),
                kind="video",
            )
            publication = SimpleNamespace(name="operator-screen", track_sid="TRK_SCREEN_123")
            participant = SimpleNamespace(identity="operator-browser")
            room.handlers["track_subscribed"](track, publication, participant)
            room.handlers["track_unsubscribed"](track, publication, participant)
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            return api, room

        api, room = asyncio.run(run_case())
        self.assertEqual(
            [event["event_type"] for event in api.screen_events],
            ["screen_share_track_subscribed", "screen_share_track_unsubscribed"],
        )
        self.assertEqual(api.screen_events[0]["capture_session_id"], CAPTURE_SESSION_ID)
        self.assertEqual(api.screen_events[0]["app_name"], "livekit")
        self.assertIn("livekit_screen_share", api.screen_events[0]["signal_tags"])
        self.assertEqual(
            api.screen_events[0]["metadata_json"]["source"],
            "operator_livekit_worker",
        )
        self.assertEqual(
            api.screen_events[0]["metadata_json"]["track"]["sid"],
            "trk_screen_123",
        )
        self.assertNotEqual(
            api.screen_events[0]["idempotency_key"],
            api.screen_events[1]["idempotency_key"],
        )
        decoded = [
            json.loads(payload.decode("utf-8"))
            for payload, reliable, topic in room.local_participant.calls
            if reliable and topic == "otto.operator"
        ]
        self.assertEqual(
            [event["event"] for event in decoded],
            ["operator.screen_track.observed", "operator.screen_track.observed"],
        )

    def test_steered_cascade_speaks_before_async_extract_and_check_finish(self) -> None:
        class FakeApi:
            def __init__(
                self,
                release_extract: asyncio.Event,
                release_check: asyncio.Event,
            ) -> None:
                self.release_extract = release_extract
                self.release_check = release_check
                self.extract_done = asyncio.Event()
                self.check_done = asyncio.Event()
                self.calls: list[str] = []
                self.extract_payloads: list[dict[str, object]] = []
                self.check_payloads: list[dict[str, object]] = []
                self.delivery_payloads: list[dict[str, object]] = []

            async def ingest_turn(self, **kwargs):
                self.calls.append("ingest")
                return IngestedTurn(
                    latest_utterance=kwargs["utterance"],
                    transcript_segment_ids=["segment-1"],
                    evidence_ids=["evidence-1"],
                    turn_index=7,
                    raw={},
                )

            async def respond_turn(self, **kwargs):
                self.calls.append("respond")
                callback = kwargs.get("on_planned_agent_utterance")
                if callback:
                    callback("Got it. What happens after approval?")
                return RespondedTurn(
                    plan={
                        "chosen_intent": {
                            "intent": "capture_next_step",
                            "target_slot": "steps.next_action",
                            "score": 100,
                            "reason": "Capture the next workflow step.",
                        }
                    },
                    planned_agent_utterance="Got it. What happens after approval?",
                    decision_log_id="respond-decision-1",
                    metadata={"model": "deterministic-steering"},
                    voice_metadata={"model": "voice-model"},
                    steering_context={
                        "target_slots": ["steps.next_action"],
                        "do_not_ask": [],
                    },
                    degraded_quality=False,
                    degraded_reasons=[],
                    raw={"extraction_status": "pending"},
                    local_turn_correlation_id=kwargs.get("local_turn_correlation_id"),
                )

            async def extract_turn(self, **kwargs):
                self.calls.append("extract")
                self.extract_payloads.append(kwargs)
                await self.release_extract.wait()
                self.extract_done.set()
                return {
                    "decision_log_id": "extract-decision-1",
                    "planned_agent_utterance": "Advisory only",
                    "extraction_status": "complete",
                    "extraction_latency_ms": 12,
                    "degraded_quality": False,
                    "degraded_reasons": [],
                }

            async def check_turn(self, **kwargs):
                self.calls.append("check")
                self.check_payloads.append(kwargs)
                await self.release_check.wait()
                self.check_done.set()
                return {
                    "checker_status": "complete",
                    "checker_violations": [],
                    "checker_violation_count": 0,
                    "stale_question_count": 0,
                    "metadata": {"model": "checker"},
                }

            async def update_delivery(self, **kwargs):
                self.calls.append("delivery")
                self.delivery_payloads.append(kwargs)
                return {"delivery": {"id": kwargs["decision_log_id"]}}

        class FakeSpeech:
            interrupted = False

            async def wait_for_playout(self):
                return None

        class FakeSession:
            def __init__(self) -> None:
                self.spoken: list[str] = []

            def say(self, text, *, allow_interruptions):
                del allow_interruptions
                self.spoken.append(text)
                return FakeSpeech()

        class FakeParticipant:
            def __init__(self) -> None:
                self.events: list[dict[str, object]] = []

            async def publish_data(self, payload, *, reliable, topic):
                del reliable, topic
                self.events.append(json.loads(payload.decode("utf-8")))

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = FakeParticipant()

            def on(self, event, handler):
                del event, handler
                return None

        async def run_case():
            from livekit.agents import ChatContext, ChatMessage, StopResponse

            release_extract = asyncio.Event()
            release_check = asyncio.Event()
            api = FakeApi(release_extract, release_check)
            session = FakeSession()
            room = FakeRoom()
            agent = OperatorWorkflowAgent(
                capture_session_id=CAPTURE_SESSION_ID,
                api=api,
                room=room,
                voice_runtime="steered_cascade",
            )
            agent._activity = SimpleNamespace(session=session)
            message = ChatMessage(
                role="user",
                content=["I approve the exception request."],
            )
            with mock.patch("operator_agent.agent.EXTRACTION_WINDOW_DEBOUNCE_SECONDS", 0.01):
                with self.assertRaises(StopResponse):
                    await agent.on_user_turn_completed(ChatContext.empty(), message)
                self.assertEqual(session.spoken, ["Got it. What happens after approval?"])
                self.assertIn("delivery", api.calls)
                self.assertFalse(api.extract_done.is_set())
                self.assertFalse(api.check_done.is_set())
                release_check.set()
                release_extract.set()
                await asyncio.wait_for(api.check_done.wait(), timeout=1)
                await asyncio.wait_for(api.extract_done.wait(), timeout=1)
            return api, room

        api, room = asyncio.run(run_case())
        self.assertIn("respond", api.calls)
        self.assertIn("check", api.calls)
        self.assertIn("extract", api.calls)
        self.assertEqual(api.delivery_payloads[0]["decision_log_id"], "respond-decision-1")
        self.assertEqual(
            api.extract_payloads[0]["turn"].latest_utterance,
            "I approve the exception request.",
        )
        self.assertEqual(
            api.check_payloads[0]["steering_context"]["target_slots"],
            ["steps.next_action"],
        )
        event_names = [event["event"] for event in room.local_participant.events]
        self.assertIn("operator.turn.dispatched", event_names)
        self.assertIn("operator.turn.output_checked", event_names)
        self.assertIn("operator.turn.extracted", event_names)

    def test_steered_cascade_coalesces_quick_split_finals_for_extraction(self) -> None:
        class FakeApi:
            def __init__(self, release_extract: asyncio.Event) -> None:
                self.release_extract = release_extract
                self.extract_started = asyncio.Event()
                self.extract_done = asyncio.Event()
                self.turn_index = 0
                self.extract_payloads: list[dict[str, object]] = []

            async def ingest_turn(self, **kwargs):
                self.turn_index += 1
                return IngestedTurn(
                    latest_utterance=kwargs["utterance"],
                    transcript_segment_ids=[f"segment-{self.turn_index}"],
                    evidence_ids=[f"evidence-{self.turn_index}"],
                    turn_index=self.turn_index,
                    raw={},
                )

            async def respond_turn(self, **kwargs):
                callback = kwargs.get("on_planned_agent_utterance")
                utterance = f"Fast operator response {kwargs['turn'].turn_index}?"
                if callback:
                    callback(utterance)
                return RespondedTurn(
                    plan={
                        "chosen_intent": {
                            "intent": "capture_next_step",
                            "target_slot": "step.action_object",
                            "score": 100,
                            "reason": "Capture the next workflow step.",
                        }
                    },
                    planned_agent_utterance=utterance,
                    decision_log_id=f"respond-{kwargs['turn'].turn_index}",
                    metadata={"model": "deterministic-steering"},
                    voice_metadata={"model": "voice-model"},
                    steering_context={"target_slots": ["step.action_object"]},
                    degraded_quality=False,
                    degraded_reasons=[],
                    raw={"extraction_status": "pending"},
                    local_turn_correlation_id=kwargs.get("local_turn_correlation_id"),
                )

            async def extract_turn(self, **kwargs):
                self.extract_payloads.append(kwargs)
                self.extract_started.set()
                await self.release_extract.wait()
                self.extract_done.set()
                return {
                    "decision_log_id": "extract-window-1",
                    "extraction_status": "complete",
                    "extraction_latency_ms": 8,
                    "slot_update_latency_ms": 8,
                    "degraded_quality": False,
                    "degraded_reasons": [],
                }

            async def check_turn(self, **kwargs):
                return {
                    "checker_status": "complete",
                    "checker_violations": [],
                    "checker_violation_count": 0,
                    "stale_question_count": 0,
                    "metadata": {"model": "checker"},
                }

            async def update_delivery(self, **kwargs):
                return {"delivery": {"id": kwargs["decision_log_id"]}}

        class FakeSpeech:
            interrupted = False

            async def wait_for_playout(self):
                return None

        class FakeSession:
            def __init__(self) -> None:
                self.spoken: list[str] = []

            def say(self, text, *, allow_interruptions):
                del allow_interruptions
                self.spoken.append(text)
                return FakeSpeech()

        class FakeParticipant:
            async def publish_data(self, payload, *, reliable, topic):
                del payload, reliable, topic
                return None

        class FakeRoom:
            local_participant = FakeParticipant()

            def on(self, event, handler):
                del event, handler
                return None

        async def run_case():
            from livekit.agents import ChatContext, ChatMessage, StopResponse

            release_extract = asyncio.Event()
            api = FakeApi(release_extract)
            session = FakeSession()
            agent = OperatorWorkflowAgent(
                capture_session_id=CAPTURE_SESSION_ID,
                api=api,
                room=FakeRoom(),
                voice_runtime="steered_cascade",
            )
            agent._activity = SimpleNamespace(session=session)
            with mock.patch("operator_agent.agent.EXTRACTION_WINDOW_DEBOUNCE_SECONDS", 0.05):
                for text in [
                    "I open the invoice record,",
                    "then copy the customer id into Salesforce.",
                ]:
                    with self.assertRaises(StopResponse):
                        await agent.on_user_turn_completed(
                            ChatContext.empty(),
                            ChatMessage(role="user", content=[text]),
                        )
                await asyncio.wait_for(api.extract_started.wait(), timeout=1)
                self.assertEqual(len(api.extract_payloads), 1)
                release_extract.set()
                await asyncio.wait_for(api.extract_done.wait(), timeout=1)
            return api, session

        api, session = asyncio.run(run_case())
        self.assertEqual(
            session.spoken,
            ["Fast operator response 1?", "Fast operator response 2?"],
        )
        extracted_turn = api.extract_payloads[0]["turn"]
        self.assertEqual(
            extracted_turn.latest_utterance,
            "I open the invoice record, then copy the customer id into Salesforce.",
        )
        self.assertEqual(
            extracted_turn.transcript_segment_ids,
            ["segment-1", "segment-2"],
        )
        self.assertEqual(extracted_turn.raw["window_turn_indexes"], [1, 2])


if __name__ == "__main__":
    unittest.main()
