from __future__ import annotations

import os
from dataclasses import dataclass


STRICT_VENDOR_PRIVACY_ACKS = [
    "OTTO_VENDOR_PRIVACY_ACK",
    "OTTO_DEEPGRAM_NO_STORE_ACK",
    "OTTO_CARTESIA_NO_RETENTION_ACK",
    "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK",
]


@dataclass(frozen=True)
class OperatorAgentConfig:
    otto_api_base_url: str
    service_token: str
    language: str
    deepgram_model: str
    cartesia_model: str
    cartesia_voice_id: str
    use_livekit_inference: bool
    livekit_agent_name: str
    voice_runtime: str = "planned_cascade"
    endpointing_mode: str = "dynamic"
    endpointing_min_delay: float = 2.2
    endpointing_max_delay: float = 8.0
    endpointing_alpha: float = 0.8
    strict_preflight: bool = False
    vendor_privacy_ack: bool = False
    deepgram_no_store_ack: bool = False
    cartesia_no_retention_ack: bool = False
    anthropic_raw_logging_off_ack: bool = False

    @classmethod
    def from_env(cls) -> "OperatorAgentConfig":
        strict_preflight = bool_env("OTTO_OPERATOR_PREFLIGHT_STRICT") or (
            os.getenv("NODE_ENV", "").strip().lower() == "production"
        )
        privacy_acks = {name: bool_env(name) for name in STRICT_VENDOR_PRIVACY_ACKS}
        missing_privacy_acks = [
            name for name, acknowledged in privacy_acks.items() if not acknowledged
        ]
        if strict_preflight and missing_privacy_acks:
            raise RuntimeError(
                "Missing "
                f"{', '.join(missing_privacy_acks)}. "
                "Strict operator voice mode requires confirming LiveKit, Deepgram, "
                "Cartesia, and Anthropic privacy controls."
            )
        if strict_preflight and not env_value("ANTHROPIC_API_KEY"):
            raise RuntimeError(
                "Missing ANTHROPIC_API_KEY. Strict operator voice mode cannot use "
                "deterministic fallback planning."
            )
        use_livekit_inference = bool_env("OTTO_USE_LIVEKIT_INFERENCE")
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
                    "Direct-provider operator voice mode requires Deepgram and "
                    "Cartesia credentials. Set OTTO_USE_LIVEKIT_INFERENCE=true "
                    "to use LiveKit Inference instead."
                )
        return cls(
            otto_api_base_url=required_env("OTTO_INTERNAL_API_BASE_URL").rstrip("/"),
            service_token=required_env("LIVEKIT_AGENT_SERVICE_TOKEN"),
            language=os.getenv("OTTO_OPERATOR_LANGUAGE", "en"),
            deepgram_model=os.getenv("DEEPGRAM_MODEL", "nova-3"),
            cartesia_model=os.getenv("CARTESIA_MODEL", "sonic-2"),
            cartesia_voice_id=os.getenv(
                "CARTESIA_VOICE_ID",
                "f786b574-daa5-4673-aa0c-cbe3e8534c02",
            ),
            use_livekit_inference=use_livekit_inference,
            livekit_agent_name=os.getenv(
                "LIVEKIT_OPERATOR_AGENT_NAME",
                os.getenv("LIVEKIT_AGENT_NAME", "otto-operator"),
            ),
            voice_runtime=voice_runtime(os.getenv("OTTO_OPERATOR_VOICE_RUNTIME")),
            endpointing_mode=os.getenv(
                "OTTO_OPERATOR_ENDPOINTING_MODE",
                os.getenv("OTTO_DIRECTOR_ENDPOINTING_MODE", "dynamic"),
            ),
            endpointing_min_delay=float_env(
                "OTTO_OPERATOR_ENDPOINTING_MIN_DELAY",
                float_env("OTTO_DIRECTOR_ENDPOINTING_MIN_DELAY", 2.2),
            ),
            endpointing_max_delay=float_env(
                "OTTO_OPERATOR_ENDPOINTING_MAX_DELAY",
                float_env("OTTO_DIRECTOR_ENDPOINTING_MAX_DELAY", 8.0),
            ),
            endpointing_alpha=float_env(
                "OTTO_OPERATOR_ENDPOINTING_ALPHA",
                float_env("OTTO_DIRECTOR_ENDPOINTING_ALPHA", 0.8),
            ),
            strict_preflight=strict_preflight,
            vendor_privacy_ack=privacy_acks["OTTO_VENDOR_PRIVACY_ACK"],
            deepgram_no_store_ack=privacy_acks["OTTO_DEEPGRAM_NO_STORE_ACK"],
            cartesia_no_retention_ack=privacy_acks["OTTO_CARTESIA_NO_RETENTION_ACK"],
            anthropic_raw_logging_off_ack=privacy_acks[
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK"
            ],
        )


def bool_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes"}


def float_env(name: str, default: float) -> float:
    value = env_value(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def voice_runtime(value: str | None) -> str:
    normalized = (value or "planned_cascade").strip().lower()
    if normalized not in {"planned_cascade", "steered_cascade"}:
        raise RuntimeError(
            "OTTO_OPERATOR_VOICE_RUNTIME must be planned_cascade or steered_cascade."
        )
    return normalized


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
