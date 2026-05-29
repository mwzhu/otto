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


if __name__ == "__main__":
    unittest.main()
