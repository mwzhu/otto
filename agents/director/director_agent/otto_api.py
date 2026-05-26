from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any

import httpx

from director_agent.schemas import (
    DeliveryUpdateResponse,
    DispatchedTurnResponse,
    IngestedTurnResponse,
    OpeningTurnResponse,
    PlannedTurnResponse,
    PlanningContextResponse,
    VerificationResponse,
)


INTERNAL_API_RETRY_DELAYS_SECONDS = (0.1, 0.2)
INTERNAL_API_TRANSIENT_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}


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
    metadata: dict[str, Any] | None
    voice_metadata: dict[str, Any] | None
    degraded_quality: bool
    raw: dict[str, Any]


@dataclass(frozen=True)
class DispatchedTurn:
    next_prompt: str
    decision_log_id: str
    raw: dict[str, Any]


class OttoApiClient:
    def __init__(
        self,
        base_url: str,
        service_token: str,
        *,
        http_client: httpx.AsyncClient | None = None,
        max_attempts: int = 3,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._headers = {
            "authorization": f"Bearer {service_token}",
            "content-type": "application/json",
        }
        self._client = http_client or httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0))
        self._owns_client = http_client is None
        self._max_attempts = max(1, max_attempts)

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
            "speaker": "director",
            "speaker_role": "director",
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": utterance,
            "metadata_json": metadata_json or {},
        }
        if confidence is not None:
            segment["confidence"] = confidence
        if timing_source is not None:
            segment["timing_source"] = timing_source
        payload = {
            "capture_session_id": capture_session_id,
            "transcript_segments": [segment],
        }
        body = await self._post("/api/internal/director-turns/ingest", payload, idempotency_key)
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
    ) -> PlannedTurn:
        payload = {
            "capture_session_id": capture_session_id,
            "latest_utterance": turn.latest_utterance,
            "transcript_segment_ids": turn.transcript_segment_ids,
            "evidence_ids": turn.evidence_ids,
            "turn_index": turn.turn_index,
        }
        body = await self._post("/api/internal/director-turns/plan", payload, idempotency_key)
        parsed = PlannedTurnResponse.model_validate(body)
        return PlannedTurn(
            plan=parsed.plan,
            planned_agent_utterance=parsed.planned_agent_utterance,
            metadata=parsed.metadata,
            voice_metadata=parsed.voice_metadata,
            degraded_quality=parsed.degraded_quality,
            raw=body,
        )

    async def planning_context(
        self,
        *,
        capture_session_id: str,
    ) -> dict[str, Any]:
        body = await self._post(
            "/api/internal/director-turns/context",
            {"capture_session_id": capture_session_id},
            transient_key("context", capture_session_id),
        )
        parsed = PlanningContextResponse.model_validate(body)
        return parsed.context

    async def verify_session(
        self,
        *,
        capture_session_id: str,
    ) -> dict[str, Any]:
        body = await self._post(
            "/api/internal/director-turns/verify",
            {"capture_session_id": capture_session_id},
            transient_key("verify", capture_session_id),
        )
        parsed = VerificationResponse.model_validate(body)
        return parsed.verification

    async def record_opening(
        self,
        *,
        capture_session_id: str,
        planned_agent_utterance: str,
        idempotency_key: str,
    ) -> DispatchedTurn:
        body = await self._post(
            "/api/internal/director-turns/opening",
            {
                "capture_session_id": capture_session_id,
                "planned_agent_utterance": planned_agent_utterance,
            },
            idempotency_key,
        )
        parsed = OpeningTurnResponse.model_validate(body)
        return DispatchedTurn(
            next_prompt=parsed.next_prompt,
            decision_log_id=parsed.decision_log_id,
            raw=body,
        )

    async def complete_session(
        self,
        *,
        capture_session_id: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return await self._post(
            "/api/internal/director-turns/complete",
            {"capture_session_id": capture_session_id},
            idempotency_key,
        )

    async def dispatch_turn(
        self,
        *,
        capture_session_id: str,
        turn: IngestedTurn,
        planned: PlannedTurn,
        idempotency_key: str,
    ) -> DispatchedTurn:
        payload = {
            "capture_session_id": capture_session_id,
            "latest_utterance": turn.latest_utterance,
            "transcript_segment_ids": turn.transcript_segment_ids,
            "evidence_ids": turn.evidence_ids,
            "turn_index": turn.turn_index,
            "plan": planned.plan,
            "planned_agent_utterance": planned.planned_agent_utterance,
            "metadata": planned.metadata,
            "voice_metadata": planned.voice_metadata or planned.raw.get("voice_metadata"),
            "degraded_quality": planned.degraded_quality,
        }
        body = await self._post("/api/internal/director-turns/dispatch", payload, idempotency_key)
        parsed = DispatchedTurnResponse.model_validate(body)
        return DispatchedTurn(
            next_prompt=parsed.next_prompt,
            decision_log_id=parsed.decision_log_id,
            raw=body,
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
    ) -> dict[str, Any]:
        if not decision_log_id:
            raise ValueError("delivery updates require a persisted decision_log_id")
        payload = {
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
        body = await self._post(
            f"/api/internal/director-turns/{turn_index}/delivery",
            payload,
            idempotency_key,
        )
        DeliveryUpdateResponse.model_validate(body)
        return body

    async def _post(
        self,
        path: str,
        payload: dict[str, Any],
        idempotency_key: str,
    ) -> dict[str, Any]:
        content = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        last_error: Exception | None = None
        response: httpx.Response | None = None
        for attempt in range(self._max_attempts):
            try:
                response = await self._client.post(
                    f"{self._base_url}{path}",
                    headers={**self._headers, "idempotency-key": idempotency_key},
                    content=content,
                )
            except (httpx.TimeoutException, httpx.TransportError) as error:
                last_error = error
                if attempt < self._max_attempts - 1:
                    await asyncio.sleep(0.1 * (attempt + 1))
                    continue
                raise RuntimeError(
                    f"Otto internal API failed on {path}: {error}"
                ) from error
            if (
                response.status_code == 409
                and idempotency_in_progress(response)
                and attempt < self._max_attempts - 1
            ):
                await asyncio.sleep(0.1 * (attempt + 1))
                continue
            if not is_transient_internal_api_status(response.status_code):
                break
            if attempt < self._max_attempts - 1:
                await asyncio.sleep(internal_api_retry_delay(attempt))
                continue
        if response is None:
            raise RuntimeError(f"Otto internal API failed on {path}: {last_error}")
        if response.status_code >= 400:
            raise RuntimeError(
                f"Otto internal API failed {response.status_code} on {path}: {response.text}"
            )
        return response.json()


def stable_key(prefix: str, *parts: object) -> str:
    raw = json.dumps(parts, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


def transient_key(prefix: str, *parts: object) -> str:
    return stable_key(prefix, *parts, time.time_ns())


def idempotency_in_progress(response: httpx.Response) -> bool:
    try:
        body = response.json()
    except ValueError:
        return False
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return False
    return (
        response.status_code == 409
        and error.get("code") == "conflict"
        and "already in progress" in str(error.get("message", "")).lower()
    )


def is_transient_internal_api_status(status_code: int) -> bool:
    return status_code in INTERNAL_API_TRANSIENT_STATUS_CODES


def internal_api_retry_delay(attempt: int) -> float:
    return INTERNAL_API_RETRY_DELAYS_SECONDS[
        min(attempt, len(INTERNAL_API_RETRY_DELAYS_SECONDS) - 1)
    ]
