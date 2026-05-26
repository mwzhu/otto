from __future__ import annotations

import asyncio
import argparse
import json
import os
import time
from dataclasses import dataclass
from typing import Any

from director_agent.config import DirectorAgentConfig
from director_agent.models import director_brain_model, director_voice_model
from director_agent.otto_api import OttoApiClient, stable_key
from director_agent.planner import DirectorPlanner
from director_agent.preflight import (
    PreflightResult,
    check_smoke_environment,
    configured_uuid_value,
    env_with_file,
)


DEFAULT_SMOKE_UTTERANCE = (
    "I run rev ops. We own forecasting, territory planning, quote approvals, and sales comp. "
    "Forecasting is weekly, mostly in Salesforce and Sheets. Quote approvals are painful because "
    "finance gets pulled in late."
)

BACKEND_PRE_TTS_BUDGET_MS = 1_500


@dataclass(frozen=True)
class SmokeDirectorConfig:
    otto_api_base_url: str
    service_token: str
    capture_session_id: str | None
    language: str
    planner_runtime: str
    anthropic_api_key: str | None
    brain_model: str
    voice_model: str
    voice_phrase_timeout_ms: int

    @classmethod
    def from_env(cls) -> "SmokeDirectorConfig":
        return cls(
            otto_api_base_url=required_env("OTTO_INTERNAL_API_BASE_URL").rstrip("/"),
            service_token=required_env("LIVEKIT_AGENT_SERVICE_TOKEN"),
            capture_session_id=env_value("OTTO_CAPTURE_SESSION_ID"),
            language=os.getenv("OTTO_DIRECTOR_LANGUAGE", "en"),
            planner_runtime=os.getenv("OTTO_DIRECTOR_PLANNER_RUNTIME", "python").strip().lower(),
            anthropic_api_key=env_value("ANTHROPIC_API_KEY"),
            brain_model=director_brain_model(),
            voice_model=director_voice_model(),
            voice_phrase_timeout_ms=int_env("OTTO_VOICE_PHRASE_TIMEOUT_MS", 2500),
        )


@dataclass(frozen=True)
class SmokeResult:
    ok: bool
    capture_session_id: str
    turn_index: int | None
    decision_log_id: str | None
    next_prompt: str | None
    candidate_process_ids: list[str]
    slot_updates: list[dict[str, Any]]
    degraded_quality: bool
    latency_ms: dict[str, int]
    planner_metadata: dict[str, Any]
    latency_budget: dict[str, Any]
    preflight: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "capture_session_id": self.capture_session_id,
            "turn_index": self.turn_index,
            "decision_log_id": self.decision_log_id,
            "next_prompt": self.next_prompt,
            "candidate_process_ids": self.candidate_process_ids,
            "slot_updates": self.slot_updates,
            "degraded_quality": self.degraded_quality,
            "latency_ms": self.latency_ms,
            "planner_metadata": self.planner_metadata,
            "latency_budget": self.latency_budget,
            "preflight": self.preflight,
        }


async def run_turn_smoke(
    *,
    utterance: str = DEFAULT_SMOKE_UTTERANCE,
    complete_delivery: bool = True,
    config: DirectorAgentConfig | SmokeDirectorConfig | None = None,
    api: Any | None = None,
    planner: Any | None = None,
    preflight_result: PreflightResult | None = None,
) -> SmokeResult:
    preflight = preflight_result or check_smoke_environment()
    if not preflight.ok:
        raise RuntimeError(
            "Director smoke preflight failed: "
            + ", ".join(preflight.missing_required)
        )
    config = config or SmokeDirectorConfig.from_env()
    capture_session_id = configured_capture_session_id(config.capture_session_id)

    owns_api = api is None
    api = api or OttoApiClient(config.otto_api_base_url, config.service_token)
    owns_planner = planner is None
    planner = planner or DirectorPlanner(api=api, config=config)
    started = time.perf_counter()
    try:
        segment_start_ms = int((time.perf_counter() * 1000) % 1_000_000_000)
        segment_end_ms = segment_start_ms + max(1000, len(utterance) * 35)
        ingest = await api.ingest_turn(
            capture_session_id=capture_session_id,
            utterance=utterance,
            start_ms=segment_start_ms,
            end_ms=segment_end_ms,
            timing_source="smoke_estimate",
            idempotency_key=stable_key(
                "smoke-seg",
                capture_session_id,
                segment_start_ms,
                segment_end_ms,
            ),
        )
        ingested_at = time.perf_counter()
        planned = await planner.plan_turn(
            capture_session_id=capture_session_id,
            turn=ingest,
            idempotency_key=stable_key(
                "smoke-plan",
                capture_session_id,
                ingest.turn_index,
            ),
        )
        planned_at = time.perf_counter()
        dispatched = await api.dispatch_turn(
            capture_session_id=capture_session_id,
            turn=ingest,
            planned=planned,
            idempotency_key=stable_key(
                "smoke-turn",
                capture_session_id,
                ingest.turn_index,
            ),
        )
        dispatched_at = time.perf_counter()
        if complete_delivery:
            delivery_marker = time.perf_counter()
            await api.update_delivery(
                capture_session_id=capture_session_id,
                turn_index=ingest.turn_index,
                decision_log_id=dispatched.decision_log_id,
                delivery_status="completed",
                delivered_utterance=dispatched.next_prompt,
                spoken_fraction=1,
                latency_ms={
                    "delivery_ms": elapsed_ms(dispatched_at, delivery_marker),
                    "turn_total_ms": elapsed_ms(started, delivery_marker),
                },
                idempotency_key=stable_key(
                    "smoke-delivery",
                    capture_session_id,
                    "director.turn",
                    ingest.turn_index,
                ),
            )
        delivered_at = time.perf_counter()
        latency_ms = {
            "ingest_ms": elapsed_ms(started, ingested_at),
            "plan_ms": elapsed_ms(ingested_at, planned_at),
            "dispatch_ms": elapsed_ms(planned_at, dispatched_at),
            "delivery_ms": elapsed_ms(dispatched_at, delivered_at),
            "backend_pre_tts_ms": elapsed_ms(started, dispatched_at),
            "total_ms": elapsed_ms(started, delivered_at),
        }
        return SmokeResult(
            ok=True,
            capture_session_id=capture_session_id,
            turn_index=ingest.turn_index,
            decision_log_id=dispatched.decision_log_id,
            next_prompt=dispatched.next_prompt,
            candidate_process_ids=dispatched.raw.get("candidate_process_ids", []),
            slot_updates=dispatched.raw.get("slot_updates", []),
            degraded_quality=bool(dispatched.raw.get("degraded_quality", False)),
            latency_ms=latency_ms,
            planner_metadata={
                "brain": smoke_metadata_summary(planned.metadata),
                "voice": smoke_metadata_summary(planned.voice_metadata),
            },
            latency_budget={
                "backend_pre_tts_budget_ms": BACKEND_PRE_TTS_BUDGET_MS,
                "backend_pre_tts_ok": latency_ms["backend_pre_tts_ms"]
                <= BACKEND_PRE_TTS_BUDGET_MS,
                "note": (
                    "Smoke measures the backend ingest+plan+dispatch contract. "
                    "Full voice acceptance still needs LiveKit ASR/TTS trace timing."
                ),
            },
            preflight=preflight.to_dict(),
        )
    finally:
        if owns_planner and hasattr(planner, "aclose"):
            await planner.aclose()
        if owns_api and hasattr(api, "aclose"):
            await api.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the director turn contract without LiveKit audio.",
    )
    parser.add_argument(
        "--env-file",
        help="Optional KEY=VALUE env file to load before running the smoke turn.",
    )
    args = parser.parse_args()
    if args.env_file:
        for key, value in env_with_file(args.env_file).items():
            if value is not None:
                os.environ[key] = value
    result = asyncio.run(run_turn_smoke())
    print(json.dumps(result.to_dict(), indent=2, sort_keys=True))


def smoke_metadata_summary(metadata: dict[str, Any] | None) -> dict[str, Any]:
    if not metadata:
        return {}
    keys = [
        "model",
        "planner_runtime",
        "prompt_template_id",
        "latency_ms",
        "token_count_input",
        "token_count_output",
        "cache_hit",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "cost_cents",
        "mocked",
        "streaming",
        "stream_cutoff",
        "anthropic_attempts",
        "anthropic_retry_count",
        "voice_timeout_fallback",
        "voice_degraded",
        "voice_timeout_ms",
        "attempted_model",
    ]
    return {key: metadata[key] for key in keys if key in metadata}


def elapsed_ms(start: float, end: float) -> int:
    return max(0, int((end - start) * 1000))


def configured_capture_session_id(value: str | None) -> str:
    if configured_uuid_value(value):
        return str(value).strip()
    raise RuntimeError("Missing required environment variable: OTTO_CAPTURE_SESSION_ID")


def required_env(name: str) -> str:
    value = env_value(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def env_value(name: str) -> str | None:
    raw = os.getenv(name)
    if env_value_from_raw(raw):
        return str(raw).strip()
    return None


def int_env(name: str, default: int) -> int:
    value = env_value(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def env_value_from_raw(value: str | None) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    lowered = raw.lower()
    if lowered in {"...", "replace-me", "replace_with_real_value"}:
        return False
    if lowered.startswith("replace-with"):
        return False
    if "your-project" in lowered:
        return False
    return True


if __name__ == "__main__":
    main()
