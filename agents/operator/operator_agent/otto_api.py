from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

import httpx

from operator_agent.schemas import (
    CheckedTurnResponse,
    DeliveryUpdateResponse,
    DispatchedTurnResponse,
    ExtractionTurnResponse,
    IngestedTurnResponse,
    PlannedTurnResponse,
    RespondedTurnResponse,
)


@dataclass(frozen=True)
class IngestedTurn:
    latest_utterance: str
    transcript_segment_ids: list[str]
    evidence_ids: list[str]
    turn_index: int
    raw: dict[str, Any]


@dataclass(frozen=True)
class PlannedTurn:
    plan: dict[str, Any]
    planned_agent_utterance: str
    metadata: dict[str, Any]
    degraded_quality: bool
    raw: dict[str, Any]
    degraded_reasons: list[str] = field(default_factory=list)
    local_turn_correlation_id: str | None = None


@dataclass(frozen=True)
class RespondedTurn:
    plan: dict[str, Any]
    planned_agent_utterance: str
    decision_log_id: str
    metadata: dict[str, Any]
    voice_metadata: dict[str, Any] | None
    steering_context: dict[str, Any] | None
    degraded_quality: bool
    raw: dict[str, Any]
    degraded_reasons: list[str] = field(default_factory=list)
    local_turn_correlation_id: str | None = None


@dataclass(frozen=True)
class DispatchedTurn:
    decision_log_id: str
    planned_agent_utterance: str
    raw: dict[str, Any]


class OperatorApiClient:
    def __init__(
        self,
        base_url: str,
        service_token: str,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._headers = {
            "authorization": f"Bearer {service_token}",
            "content-type": "application/json",
        }
        self._client = http_client or httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0))
        self._owns_client = http_client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def ingest_turn(
        self,
        *,
        capture_session_id: str,
        utterance: str,
        start_ms: int,
        end_ms: int,
        confidence: float | None = None,
        timing_source: str | None = None,
        metadata_json: dict[str, Any] | None = None,
        idempotency_key: str,
    ) -> IngestedTurn:
        segment: dict[str, Any] = {
            "speaker": "operator",
            "speaker_role": "operator",
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": utterance,
            "metadata_json": metadata_json or {},
        }
        if confidence is not None:
            segment["confidence"] = confidence
        if timing_source is not None:
            segment["timing_source"] = timing_source
        body = await self._post(
            "/api/internal/operator-turns/ingest",
            {
                "capture_session_id": capture_session_id,
                "transcript_segments": [segment],
            },
            idempotency_key,
        )
        parsed = IngestedTurnResponse.model_validate(body)
        return IngestedTurn(
            latest_utterance=parsed.latest_utterance,
            transcript_segment_ids=parsed.transcript_segment_ids,
            evidence_ids=parsed.evidence_ids,
            turn_index=parsed.turn_index,
            raw=body,
        )

    async def plan_turn(
        self,
        *,
        capture_session_id: str,
        turn: IngestedTurn,
        idempotency_key: str,
        on_planned_agent_utterance: Any | None = None,
        local_turn_correlation_id: str | None = None,
    ) -> PlannedTurn:
        payload = {
            "capture_session_id": capture_session_id,
            "latest_utterance": turn.latest_utterance,
            "transcript_segment_ids": turn.transcript_segment_ids,
            "evidence_ids": turn.evidence_ids,
            "turn_index": turn.turn_index,
        }
        if on_planned_agent_utterance is not None:
            return await self._stream_plan_turn(
                payload=payload,
                idempotency_key=idempotency_key,
                on_planned_agent_utterance=on_planned_agent_utterance,
                local_turn_correlation_id=local_turn_correlation_id,
            )
        body = await self._post("/api/internal/operator-turns/plan", payload, idempotency_key)
        return planned_turn_from_body(body, local_turn_correlation_id)

    async def respond_turn(
        self,
        *,
        capture_session_id: str,
        turn: IngestedTurn,
        idempotency_key: str,
        on_planned_agent_utterance: Any | None = None,
        local_turn_correlation_id: str | None = None,
        pending_extraction_turns: list[int] | None = None,
        pending_slot_paths: list[str] | None = None,
        last_spoken_intent: str | None = None,
        extraction_window_id: str | None = None,
    ) -> RespondedTurn:
        payload: dict[str, Any] = {
            "capture_session_id": capture_session_id,
            "latest_utterance": turn.latest_utterance,
            "transcript_segment_ids": turn.transcript_segment_ids,
            "evidence_ids": turn.evidence_ids,
            "turn_index": turn.turn_index,
            "pending_extraction_turns": pending_extraction_turns or [],
            "pending_slot_paths": pending_slot_paths or [],
        }
        if local_turn_correlation_id:
            payload["local_turn_correlation_id"] = local_turn_correlation_id
        if extraction_window_id:
            payload["extraction_window_id"] = extraction_window_id
        if last_spoken_intent:
            payload["last_spoken_intent"] = last_spoken_intent
        if on_planned_agent_utterance is not None:
            return await self._stream_respond_turn(
                payload=payload,
                idempotency_key=idempotency_key,
                on_planned_agent_utterance=on_planned_agent_utterance,
                local_turn_correlation_id=local_turn_correlation_id,
            )
        body = await self._post("/api/internal/operator-turns/respond", payload, idempotency_key)
        return responded_turn_from_body(body, local_turn_correlation_id)

    async def _stream_respond_turn(
        self,
        *,
        payload: dict[str, Any],
        idempotency_key: str,
        on_planned_agent_utterance: Any,
        local_turn_correlation_id: str | None,
    ) -> RespondedTurn:
        final_body: dict[str, Any] | None = None
        async with self._client.stream(
            "POST",
            f"{self._base_url}/api/internal/operator-turns/respond",
            headers={
                **self._headers,
                "accept": "text/event-stream",
                "idempotency-key": idempotency_key,
            },
            json=payload,
        ) as response:
            response.raise_for_status()
            event_name: str | None = None
            data_lines: list[str] = []
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_name = line[len("event:") :].strip()
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[len("data:") :].strip())
                    continue
                if line.strip():
                    continue
                if not event_name:
                    data_lines = []
                    continue
                data = json.loads("\n".join(data_lines) or "{}")
                if event_name == "planned_agent_utterance":
                    utterance = str(data.get("utterance") or "").strip()
                    if utterance:
                        maybe_awaitable = on_planned_agent_utterance(utterance)
                        if asyncio.iscoroutine(maybe_awaitable):
                            await maybe_awaitable
                elif event_name == "final":
                    final_body = data
                elif event_name == "error":
                    raise RuntimeError(str(data.get("message") or "Respond stream failed."))
                event_name = None
                data_lines = []
        if final_body is None:
            raise RuntimeError("Respond stream ended without a final response.")
        return responded_turn_from_body(final_body, local_turn_correlation_id)

    async def _stream_plan_turn(
        self,
        *,
        payload: dict[str, Any],
        idempotency_key: str,
        on_planned_agent_utterance: Any,
        local_turn_correlation_id: str | None,
    ) -> PlannedTurn:
        final_body: dict[str, Any] | None = None
        async with self._client.stream(
            "POST",
            f"{self._base_url}/api/internal/operator-turns/plan",
            headers={
                **self._headers,
                "accept": "text/event-stream",
                "idempotency-key": idempotency_key,
            },
            json=payload,
        ) as response:
            response.raise_for_status()
            event_name: str | None = None
            data_lines: list[str] = []
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_name = line[len("event:") :].strip()
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[len("data:") :].strip())
                    continue
                if line.strip():
                    continue
                if not event_name:
                    data_lines = []
                    continue
                data = json.loads("\n".join(data_lines) or "{}")
                if event_name == "planned_agent_utterance":
                    utterance = str(data.get("utterance") or "").strip()
                    if utterance:
                        maybe_awaitable = on_planned_agent_utterance(utterance)
                        if asyncio.iscoroutine(maybe_awaitable):
                            await maybe_awaitable
                elif event_name == "final":
                    final_body = data
                elif event_name == "error":
                    raise RuntimeError(str(data.get("message") or "Planner stream failed."))
                event_name = None
                data_lines = []
        if final_body is None:
            raise RuntimeError("Planner stream ended without a final plan.")
        return planned_turn_from_body(final_body, local_turn_correlation_id)

    async def extract_turn(
        self,
        *,
        capture_session_id: str,
        turn: IngestedTurn,
        spoken_agent_utterance: str,
        idempotency_key: str,
        local_turn_correlation_id: str | None = None,
        extraction_window_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "capture_session_id": capture_session_id,
            "latest_utterance": turn.latest_utterance,
            "transcript_segment_ids": turn.transcript_segment_ids,
            "evidence_ids": turn.evidence_ids,
            "turn_index": turn.turn_index,
            "spoken_agent_utterance": spoken_agent_utterance,
        }
        if local_turn_correlation_id:
            payload["local_turn_correlation_id"] = local_turn_correlation_id
        if extraction_window_id:
            payload["extraction_window_id"] = extraction_window_id
        window_turn_indexes = turn.raw.get("window_turn_indexes")
        if isinstance(window_turn_indexes, list):
            payload["window_turn_indexes"] = window_turn_indexes
        body = await self._post(
            "/api/internal/operator-turns/extract",
            payload,
            idempotency_key,
        )
        ExtractionTurnResponse.model_validate(body)
        return body

    async def check_turn(
        self,
        *,
        capture_session_id: str,
        turn: IngestedTurn,
        decision_log_id: str,
        spoken_agent_utterance: str,
        steering_context: dict[str, Any] | None,
        idempotency_key: str,
        local_turn_correlation_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "capture_session_id": capture_session_id,
            "decision_log_id": decision_log_id,
            "turn_index": turn.turn_index,
            "spoken_agent_utterance": spoken_agent_utterance,
            "steering_context": steering_context or {},
        }
        if local_turn_correlation_id:
            payload["local_turn_correlation_id"] = local_turn_correlation_id
        body = await self._post(
            "/api/internal/operator-turns/check",
            payload,
            idempotency_key,
        )
        CheckedTurnResponse.model_validate(body)
        return body

    async def dispatch_turn(
        self,
        *,
        capture_session_id: str,
        turn: IngestedTurn,
        planned: PlannedTurn,
        idempotency_key: str,
        local_turn_correlation_id: str | None = None,
    ) -> DispatchedTurn:
        payload: dict[str, Any] = {
            "capture_session_id": capture_session_id,
            "latest_utterance": turn.latest_utterance,
            "transcript_segment_ids": turn.transcript_segment_ids,
            "evidence_ids": turn.evidence_ids,
            "turn_index": turn.turn_index,
            "plan": planned.plan,
            "planned_agent_utterance": planned.planned_agent_utterance,
            "metadata": planned.metadata,
            "degraded_quality": planned.degraded_quality,
            "degraded_reasons": planned.degraded_reasons,
        }
        if local_turn_correlation_id:
            payload["local_turn_correlation_id"] = local_turn_correlation_id
        body = await self._post("/api/internal/operator-turns/dispatch", payload, idempotency_key)
        parsed = DispatchedTurnResponse.model_validate(body)
        return DispatchedTurn(
            decision_log_id=parsed.decision_log_id,
            planned_agent_utterance=parsed.planned_agent_utterance,
            raw=body,
        )

    async def record_notice(
        self,
        *,
        capture_session_id: str,
        stage_name: str,
        turn_index: int,
        planned_agent_utterance: str,
        local_turn_correlation_id: str,
        reason: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return await self._post(
            "/api/internal/operator-turns/notice",
            {
                "capture_session_id": capture_session_id,
                "stage_name": stage_name,
                "turn_index": turn_index,
                "planned_agent_utterance": planned_agent_utterance,
                "local_turn_correlation_id": local_turn_correlation_id,
                "reason": reason,
            },
            idempotency_key,
        )

    async def complete_session(
        self,
        *,
        capture_session_id: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return await self._post(
            "/api/internal/operator-captures/complete",
            {"capture_session_id": capture_session_id},
            idempotency_key,
        )

    async def update_delivery(
        self,
        *,
        capture_session_id: str,
        turn_index: int,
        decision_log_id: str,
        delivery_status: str,
        delivered_utterance: str | None,
        spoken_fraction: float,
        idempotency_key: str,
        latency_ms: dict[str, int] | None = None,
        audio_metadata: dict[str, Any] | None = None,
        local_turn_correlation_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "capture_session_id": capture_session_id,
            "decision_log_id": decision_log_id,
            "delivery_status": delivery_status,
            "delivered_utterance": delivered_utterance,
            "spoken_fraction": spoken_fraction,
        }
        if latency_ms is not None:
            payload["latency_ms"] = latency_ms
        if audio_metadata is not None:
            payload["audio_metadata"] = audio_metadata
        if local_turn_correlation_id is not None:
            payload["local_turn_correlation_id"] = local_turn_correlation_id
        body = await self._post(
            f"/api/internal/operator-turns/{turn_index}/delivery",
            payload,
            idempotency_key,
        )
        DeliveryUpdateResponse.model_validate(body)
        return body

    async def request_redaction(
        self,
        *,
        capture_session_id: str,
        start_ms: int,
        end_ms: int,
        reason: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return await self._post(
            "/api/internal/operator-redactions",
            {
                "capture_session_id": capture_session_id,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "reason": reason,
            },
            idempotency_key,
        )

    async def create_screen_event(
        self,
        *,
        capture_session_id: str,
        ts_ms: int,
        event_type: str,
        idempotency_key: str,
        app_name: str | None = None,
        window_title: str | None = None,
        url: str | None = None,
        ocr_text: str | None = None,
        ui_state_label: str | None = None,
        screenshot_artifact_id: str | None = None,
        signal_tags: list[str] | None = None,
        metadata_json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "capture_session_id": capture_session_id,
            "ts_ms": ts_ms,
            "event_type": event_type,
            "signal_tags": signal_tags or [],
        }
        optional = {
            "app_name": app_name,
            "window_title": window_title,
            "url": url,
            "ocr_text": ocr_text,
            "ui_state_label": ui_state_label,
            "screenshot_artifact_id": screenshot_artifact_id,
            "metadata_json": metadata_json,
        }
        payload.update({key: value for key, value in optional.items() if value is not None})
        return await self._post(
            "/api/internal/operator-screen-events",
            payload,
            idempotency_key,
        )

    async def _post(
        self,
        path: str,
        payload: dict[str, Any],
        idempotency_key: str,
    ) -> dict[str, Any]:
        content = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        response = await self._client.post(
            f"{self._base_url}{path}",
            headers={**self._headers, "idempotency-key": idempotency_key},
            content=content,
        )
        response.raise_for_status()
        return response.json()


def planned_turn_from_body(
    body: dict[str, Any],
    local_turn_correlation_id: str | None,
) -> PlannedTurn:
    parsed = PlannedTurnResponse.model_validate(body)
    return PlannedTurn(
        plan=parsed.plan,
        planned_agent_utterance=parsed.planned_agent_utterance,
        metadata=parsed.metadata,
        degraded_quality=parsed.degraded_quality,
        degraded_reasons=parsed.degraded_reasons,
        raw=body,
        local_turn_correlation_id=local_turn_correlation_id,
    )


def responded_turn_from_body(
    body: dict[str, Any],
    local_turn_correlation_id: str | None,
) -> RespondedTurn:
    parsed = RespondedTurnResponse.model_validate(body)
    return RespondedTurn(
        plan=parsed.plan,
        planned_agent_utterance=parsed.planned_agent_utterance,
        decision_log_id=parsed.decision_log_id,
        metadata=parsed.metadata,
        voice_metadata=parsed.voice_metadata,
        steering_context=parsed.steering_context,
        degraded_quality=parsed.degraded_quality,
        degraded_reasons=parsed.degraded_reasons,
        raw=body,
        local_turn_correlation_id=parsed.local_turn_correlation_id or local_turn_correlation_id,
    )


def stable_key(*parts: object) -> str:
    joined = "|".join(str(part) for part in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()
