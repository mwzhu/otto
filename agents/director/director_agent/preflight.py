from __future__ import annotations

import json
import os
import argparse
from uuid import UUID
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from director_agent.models import director_brain_model, director_voice_model


@dataclass(frozen=True)
class PreflightResult:
    ok: bool
    missing_required: list[str]
    warnings: list[str]
    mode: dict[str, str | bool | None]
    vendor_controls: dict[str, str | bool | None]

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "missing_required": self.missing_required,
            "warnings": self.warnings,
            "mode": self.mode,
            "vendor_controls": self.vendor_controls,
        }


def check_environment(env: Mapping[str, str | None] | None = None) -> PreflightResult:
    env = os.environ if env is None else env
    missing = [
        name
        for name in [
            "LIVEKIT_URL",
            "LIVEKIT_API_KEY",
            "LIVEKIT_API_SECRET",
            "OTTO_INTERNAL_API_BASE_URL",
            "LIVEKIT_AGENT_SERVICE_TOKEN",
            "DATABASE_SERVICE_URL",
        ]
        if not configured_env_value(env, name)
    ]
    use_inference = str(env.get("OTTO_USE_LIVEKIT_INFERENCE", "")).strip().lower() in {
        "1",
        "true",
        "yes",
    }
    strict = is_strict_director_voice_mode(env)
    planner_runtime = str(env.get("OTTO_DIRECTOR_PLANNER_RUNTIME", "next")).strip().lower()
    voice_runtime = voice_runtime_from_env(env)
    if not use_inference:
        for name in ["DEEPGRAM_API_KEY", "CARTESIA_API_KEY"]:
            if not configured_env_value(env, name):
                missing.append(name)

    warnings: list[str] = []
    if not configured_env_value(env, "ANTHROPIC_API_KEY"):
        if strict:
            missing.append("ANTHROPIC_API_KEY")
        else:
            warnings.append(
                "ANTHROPIC_API_KEY is missing; the worker will use deterministic fallback planning."
            )
    privacy_ack = bool_from_env(env, "OTTO_VENDOR_PRIVACY_ACK")
    deepgram_no_store_ack = bool_from_env(env, "OTTO_DEEPGRAM_NO_STORE_ACK")
    cartesia_no_retention_ack = bool_from_env(env, "OTTO_CARTESIA_NO_RETENTION_ACK")
    anthropic_raw_logging_off_ack = bool_from_env(
        env,
        "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK",
    )
    vendor_controls = vendor_privacy_controls(
        use_inference,
        privacy_ack,
        deepgram_no_store_ack,
        cartesia_no_retention_ack,
        anthropic_raw_logging_off_ack,
    )
    if strict:
        for name, acknowledged in [
            ("OTTO_VENDOR_PRIVACY_ACK", privacy_ack),
            ("OTTO_DEEPGRAM_NO_STORE_ACK", deepgram_no_store_ack),
            ("OTTO_CARTESIA_NO_RETENTION_ACK", cartesia_no_retention_ack),
            ("OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK", anthropic_raw_logging_off_ack),
        ]:
            if not acknowledged:
                missing.append(name)
    if planner_runtime == "python":
        warnings.append(
            "OTTO_DIRECTOR_PLANNER_RUNTIME=python uses the buffered Python planner; live early-utterance streaming requires the default Next.js /plan runtime."
        )
    if not use_inference:
        warnings.append(
            "Direct Deepgram mode relies on mip_opt_out=True in worker.py; verify account-level no-store settings before customer calls."
        )
        warnings.append(
            "Direct Cartesia mode has no request-level no-retention flag in this worker; verify account-level retention settings before customer calls."
        )

    return PreflightResult(
        ok=len(missing) == 0,
        missing_required=missing,
        warnings=warnings,
        mode={
            "planner_runtime": planner_runtime,
            "voice_runtime": voice_runtime,
            "use_livekit_inference": use_inference,
            "language": env.get("OTTO_DIRECTOR_LANGUAGE", "en"),
            "deepgram_model": env.get("DEEPGRAM_MODEL", "nova-3"),
            "cartesia_model": env.get("CARTESIA_MODEL", "sonic-2"),
            "brain_model": director_brain_model(env),
            "voice_model": director_voice_model(env),
            "voice_phrase_timeout_ms": int_env(env, "OTTO_VOICE_PHRASE_TIMEOUT_MS", 2500),
            "endpointing_mode": str(
                env.get("OTTO_DIRECTOR_ENDPOINTING_MODE", "dynamic")
            ).strip().lower(),
            "endpointing_min_delay": float_env(
                env,
                "OTTO_DIRECTOR_ENDPOINTING_MIN_DELAY",
                1.2,
            ),
            "endpointing_max_delay": float_env(
                env,
                "OTTO_DIRECTOR_ENDPOINTING_MAX_DELAY",
                6.0,
            ),
            "interruption_mode": str(
                env.get("OTTO_DIRECTOR_INTERRUPTION_MODE", "vad")
            ).strip().lower(),
            "interruption_min_duration": float_env(
                env,
                "OTTO_DIRECTOR_INTERRUPTION_MIN_DURATION",
                0.25,
            ),
            "livekit_agent_name": env.get("LIVEKIT_AGENT_NAME", "otto-director"),
            "audio_recording_default": "off",
            "strict": strict,
            "vendor_privacy_ack": privacy_ack,
            "deepgram_no_store_ack": deepgram_no_store_ack,
            "cartesia_no_retention_ack": cartesia_no_retention_ack,
            "anthropic_raw_logging_off_ack": anthropic_raw_logging_off_ack,
        },
        vendor_controls=vendor_controls,
    )


def check_verification_environment(
    env: Mapping[str, str | None] | None = None,
) -> PreflightResult:
    env = os.environ if env is None else env
    missing = [
        name
        for name in [
            "OTTO_INTERNAL_API_BASE_URL",
            "LIVEKIT_AGENT_SERVICE_TOKEN",
        ]
        if not configured_env_value(env, name)
    ]
    if not configured_uuid_env_value(env, "OTTO_CAPTURE_SESSION_ID"):
        missing.append("OTTO_CAPTURE_SESSION_ID")
    return PreflightResult(
        ok=len(missing) == 0,
        missing_required=missing,
        warnings=[],
        mode={
            "verification_only": True,
            "capture_session_id": env.get("OTTO_CAPTURE_SESSION_ID"),
        },
        vendor_controls={},
    )


def check_smoke_environment(
    env: Mapping[str, str | None] | None = None,
) -> PreflightResult:
    env = os.environ if env is None else env
    missing = [
        name
        for name in [
            "OTTO_INTERNAL_API_BASE_URL",
            "LIVEKIT_AGENT_SERVICE_TOKEN",
        ]
        if not configured_env_value(env, name)
    ]
    if not configured_uuid_env_value(env, "OTTO_CAPTURE_SESSION_ID"):
        missing.append("OTTO_CAPTURE_SESSION_ID")
    warnings: list[str] = []
    if not configured_env_value(env, "ANTHROPIC_API_KEY"):
        warnings.append(
            "ANTHROPIC_API_KEY is missing; smoke will exercise deterministic fallback planning."
        )
    return PreflightResult(
        ok=len(missing) == 0,
        missing_required=missing,
        warnings=warnings,
        mode={
            "smoke_only": True,
            "planner_runtime": str(
                env.get("OTTO_DIRECTOR_PLANNER_RUNTIME", "next")
            ).strip().lower(),
            "voice_runtime": voice_runtime_from_env(env),
            "capture_session_id": env.get("OTTO_CAPTURE_SESSION_ID"),
            "brain_model": director_brain_model(env),
            "voice_model": director_voice_model(env),
        },
        vendor_controls={
            "audio_transport": "not_required_for_backend_smoke",
            "livekit_audio": "not_exercised",
            "deepgram": "not_exercised",
            "cartesia": "not_exercised",
        },
    )


def missing_env_file_result(path: str, *, strict: bool = False) -> PreflightResult:
    return PreflightResult(
        ok=False,
        missing_required=[f"env_file:{path}"],
        warnings=[
            "The requested env file does not exist; pass a valid --env-file path or omit the flag.",
        ],
        mode={
            "strict": strict,
            "env_file": path,
        },
        vendor_controls={},
    )


def vendor_privacy_controls(
    use_livekit_inference: bool,
    privacy_ack: bool,
    deepgram_no_store_ack: bool,
    cartesia_no_retention_ack: bool,
    anthropic_raw_logging_off_ack: bool,
) -> dict[str, str | bool | None]:
    return {
        "livekit_audio_recording_default": "off",
        "livekit_egress_recording_default": "off",
        "livekit_data_channel_logging": "not_logged_by_livekit",
        "deepgram_transport": (
            "livekit_inference" if use_livekit_inference else "direct_plugin"
        ),
        "deepgram_mip_opt_out": (
            "managed_by_livekit_inference" if use_livekit_inference else True
        ),
        "deepgram_content_retention": (
            "livekit_inference_vendor_ack_required"
            if use_livekit_inference
            else "mip_opt_out_request_retained_only_for_processing"
        ),
        "deepgram_no_store": (
            "livekit_inference_vendor_ack_required"
            if use_livekit_inference
            else "covered_by_mip_opt_out_request_flag"
        ),
        "deepgram_no_store_ack": deepgram_no_store_ack,
        "cartesia_transport": (
            "livekit_inference" if use_livekit_inference else "direct_plugin"
        ),
        "cartesia_no_retention": "enterprise_account_level_required",
        "cartesia_no_retention_ack": cartesia_no_retention_ack,
        "anthropic_raw_payload_logging": "off_by_default",
        "anthropic_raw_logging_off_ack": anthropic_raw_logging_off_ack,
        "vendor_privacy_ack": privacy_ack,
    }


def is_strict_director_voice_mode(env: Mapping[str, str | None]) -> bool:
    explicit_strict = bool_from_env(env, "OTTO_DIRECTOR_PREFLIGHT_STRICT")
    return explicit_strict or str(env.get("NODE_ENV", "")).strip().lower() == "production"


def bool_from_env(env: Mapping[str, str | None], name: str) -> bool:
    return str(env.get(name, "")).strip().lower() in {"1", "true", "yes"}


def voice_runtime_from_env(env: Mapping[str, str | None]) -> str:
    value = str(env.get("OTTO_DIRECTOR_VOICE_RUNTIME", "planned_cascade")).strip().lower()
    if value in {"planned_cascade", "steered_cascade", "steered_realtime"}:
        return value
    return "planned_cascade"


def int_env(env: Mapping[str, str | None], name: str, default: int) -> int:
    raw_value = str(env.get(name) or "").strip()
    if not configured_value(raw_value):
        return default
    try:
        parsed = int(raw_value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def float_env(env: Mapping[str, str | None], name: str, default: float) -> float:
    raw_value = str(env.get(name) or "").strip()
    if not configured_value(raw_value):
        return default
    try:
        parsed = float(raw_value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def configured_env_value(env: Mapping[str, str | None], name: str) -> bool:
    value = str(env.get(name) or "").strip()
    return configured_value(value)


def configured_uuid_env_value(env: Mapping[str, str | None], name: str) -> bool:
    return configured_uuid_value(env.get(name))


def configured_uuid_value(value: str | None) -> bool:
    if not configured_value(value):
        return False
    try:
        UUID(str(value or "").strip())
    except ValueError:
        return False
    return True


def configured_value(value: str | None) -> bool:
    value = str(value or "").strip()
    if not value:
        return False
    lowered = value.lower()
    if lowered in {"...", "replace-me", "replace_with_real_value"}:
        return False
    if lowered.startswith("replace-with"):
        return False
    if "your-project" in lowered:
        return False
    return True


def env_with_file(
    env_file: str | None,
    *,
    base_env: Mapping[str, str | None] | None = None,
    strict: bool = False,
) -> dict[str, str | None]:
    base = dict(base_env or os.environ)
    merged: dict[str, str | None] = {}
    if env_file:
        merged.update(parse_env_file(env_file))
    for key, value in base.items():
        if configured_env_value(base, key):
            merged[key] = value
    if strict:
        merged["OTTO_DIRECTOR_PREFLIGHT_STRICT"] = "true"
    return merged


def parse_env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in Path(path).read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        value = raw_value.strip()
        if not key or key.startswith("export "):
            key = key.removeprefix("export ").strip()
        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {"'", '"'}
        ):
            value = value[1:-1]
        values[key] = value
    return values


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Check Otto director LiveKit worker readiness.",
    )
    parser.add_argument(
        "--env-file",
        help="Optional KEY=VALUE env file to load before checking readiness.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Require full production voice/provider/privacy configuration.",
    )
    args = parser.parse_args()
    try:
        env = env_with_file(args.env_file, strict=args.strict)
    except FileNotFoundError:
        if not args.env_file:
            raise
        result = missing_env_file_result(args.env_file, strict=args.strict)
    else:
        result = check_environment(env)
    print(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    raise SystemExit(0 if result.ok else 1)


if __name__ == "__main__":
    main()
