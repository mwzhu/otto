from __future__ import annotations

import os
from dataclasses import dataclass
from director_agent.models import director_brain_model, director_voice_model

STRICT_VENDOR_PRIVACY_ACKS = [
    "OTTO_VENDOR_PRIVACY_ACK",
    "OTTO_DEEPGRAM_NO_STORE_ACK",
    "OTTO_CARTESIA_NO_RETENTION_ACK",
    "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK",
]


@dataclass(frozen=True)
class DirectorAgentConfig:
    otto_api_base_url: str
    service_token: str
    capture_session_id: str | None
    language: str
    planner_runtime: str
    anthropic_api_key: str | None
    brain_model: str
    voice_model: str
    deepgram_model: str
    cartesia_model: str
    cartesia_voice_id: str
    use_livekit_inference: bool
    livekit_agent_name: str
    voice_runtime: str = "planned_cascade"
    use_semantic_turn_detector: bool = False
    livekit_url: str | None = None
    livekit_api_key: str | None = None
    livekit_api_secret: str | None = None
    strict_preflight: bool = False
    vendor_privacy_ack: bool = False
    deepgram_no_store_ack: bool = False
    cartesia_no_retention_ack: bool = False
    anthropic_raw_logging_off_ack: bool = False
    voice_phrase_timeout_ms: int = 2500
    use_separate_voice_llm: bool = False
    endpointing_mode: str = "dynamic"
    endpointing_min_delay: float = 1.2
    endpointing_max_delay: float = 6.0
    endpointing_alpha: float = 0.8
    interruption_mode: str = "vad"
    interruption_min_duration: float = 0.25

    @classmethod
    def from_env(cls) -> "DirectorAgentConfig":
        strict_preflight = bool_env("OTTO_DIRECTOR_PREFLIGHT_STRICT") or (
            os.getenv("NODE_ENV", "").strip().lower() == "production"
        )
        privacy_acks = {name: bool_env(name) for name in STRICT_VENDOR_PRIVACY_ACKS}
        anthropic_api_key = env_value("ANTHROPIC_API_KEY")
        missing_privacy_acks = [
            name for name, acknowledged in privacy_acks.items() if not acknowledged
        ]
        if strict_preflight and missing_privacy_acks:
            raise RuntimeError(
                "Missing "
                f"{', '.join(missing_privacy_acks)}. "
                "Strict director voice mode requires confirming LiveKit, Deepgram, "
                "Cartesia, and Anthropic privacy controls."
            )
        if strict_preflight and not anthropic_api_key:
            raise RuntimeError(
                "Missing ANTHROPIC_API_KEY. Strict director voice mode cannot use "
                "deterministic fallback planning."
            )
        planner_runtime = os.getenv("OTTO_DIRECTOR_PLANNER_RUNTIME", "next").strip().lower()
        use_livekit_inference = bool_env("OTTO_USE_LIVEKIT_INFERENCE")
        otto_api_base_url = required_env("OTTO_INTERNAL_API_BASE_URL").rstrip("/")
        service_token = required_env("LIVEKIT_AGENT_SERVICE_TOKEN")
        livekit_url = required_env("LIVEKIT_URL")
        livekit_api_key = required_env("LIVEKIT_API_KEY")
        livekit_api_secret = required_env("LIVEKIT_API_SECRET")
        if not use_livekit_inference:
            missing_audio_provider_keys = [
                name
                for name in ["DEEPGRAM_API_KEY", "CARTESIA_API_KEY"]
                if not env_value(name)
            ]
            if missing_audio_provider_keys:
                raise RuntimeError(
                    "Missing "
                    f"{', '.join(missing_audio_provider_keys)}. "
                    "Direct-provider director voice mode requires Deepgram "
                    "and Cartesia credentials before the worker starts. Set "
                    "OTTO_USE_LIVEKIT_INFERENCE=true to use LiveKit Inference instead."
                )
        return cls(
            otto_api_base_url=otto_api_base_url,
            service_token=service_token,
            livekit_url=livekit_url,
            livekit_api_key=livekit_api_key,
            livekit_api_secret=livekit_api_secret,
            capture_session_id=env_value("OTTO_CAPTURE_SESSION_ID"),
            language=os.getenv("OTTO_DIRECTOR_LANGUAGE", "en"),
            planner_runtime=planner_runtime,
            voice_runtime=voice_runtime(os.getenv("OTTO_DIRECTOR_VOICE_RUNTIME")),
            anthropic_api_key=anthropic_api_key,
            brain_model=director_brain_model(),
            voice_model=director_voice_model(),
            deepgram_model=os.getenv("DEEPGRAM_MODEL", "nova-3"),
            cartesia_model=os.getenv("CARTESIA_MODEL", "sonic-2"),
            cartesia_voice_id=os.getenv(
                "CARTESIA_VOICE_ID",
                "f786b574-daa5-4673-aa0c-cbe3e8534c02",
            ),
            use_livekit_inference=use_livekit_inference,
            use_semantic_turn_detector=bool_env("OTTO_USE_SEMANTIC_TURN_DETECTOR"),
            livekit_agent_name=os.getenv("LIVEKIT_AGENT_NAME", "otto-director"),
            strict_preflight=strict_preflight,
            vendor_privacy_ack=privacy_acks["OTTO_VENDOR_PRIVACY_ACK"],
            deepgram_no_store_ack=privacy_acks["OTTO_DEEPGRAM_NO_STORE_ACK"],
            cartesia_no_retention_ack=privacy_acks["OTTO_CARTESIA_NO_RETENTION_ACK"],
            anthropic_raw_logging_off_ack=privacy_acks[
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK"
            ],
            voice_phrase_timeout_ms=int_env("OTTO_VOICE_PHRASE_TIMEOUT_MS", 2500),
            use_separate_voice_llm=bool_env("OTTO_DIRECTOR_USE_SEPARATE_VOICE_LLM"),
            endpointing_mode=os.getenv(
                "OTTO_DIRECTOR_ENDPOINTING_MODE",
                "dynamic",
            ).strip().lower(),
            endpointing_min_delay=float_env("OTTO_DIRECTOR_ENDPOINTING_MIN_DELAY", 1.2),
            endpointing_max_delay=float_env("OTTO_DIRECTOR_ENDPOINTING_MAX_DELAY", 6.0),
            endpointing_alpha=float_env("OTTO_DIRECTOR_ENDPOINTING_ALPHA", 0.8),
            interruption_mode=os.getenv(
                "OTTO_DIRECTOR_INTERRUPTION_MODE",
                "vad",
            ).strip().lower(),
            interruption_min_duration=float_env(
                "OTTO_DIRECTOR_INTERRUPTION_MIN_DURATION",
                0.25,
            ),
        )


def bool_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes"}


def required_env(name: str) -> str:
    value = env_value(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def env_value(name: str) -> str | None:
    value = (os.getenv(name) or "").strip()
    if not value:
        return None
    lowered = value.lower()
    if lowered in {"...", "replace-me", "replace_with_real_value"}:
        return None
    if lowered.startswith("replace-with"):
        return None
    if "your-project" in lowered:
        return None
    return value


def int_env(name: str, default: int) -> int:
    value = env_value(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def float_env(name: str, default: float) -> float:
    value = env_value(name)
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def voice_runtime(value: str | None) -> str:
    normalized = (value or "planned_cascade").strip().lower()
    if normalized in {"planned_cascade", "steered_cascade", "steered_realtime"}:
        return normalized
    return "planned_cascade"
