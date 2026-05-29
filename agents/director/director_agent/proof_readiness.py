from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from director_agent.preflight import (
    bool_from_env,
    configured_env_value,
    env_with_file,
    missing_env_file_result,
)


VOICE_PROVIDER_KEYS = ("DEEPGRAM_API_KEY", "CARTESIA_API_KEY")
PRIVACY_ACK_KEYS = (
    "OTTO_VENDOR_PRIVACY_ACK",
    "OTTO_DEEPGRAM_NO_STORE_ACK",
    "OTTO_CARTESIA_NO_RETENTION_ACK",
    "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK",
)
APP_REQUIRED_KEYS = (
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVEKIT_AGENT_SERVICE_TOKEN",
    "OTTO_INTERNAL_API_BASE_URL",
    "DATABASE_URL",
    "DATABASE_SERVICE_URL",
    "ANTHROPIC_API_KEY",
)
WORKER_REQUIRED_KEYS = (
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVEKIT_AGENT_SERVICE_TOKEN",
    "OTTO_INTERNAL_API_BASE_URL",
    "ANTHROPIC_API_KEY",
)
MATCHED_KEYS = (
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVEKIT_AGENT_NAME",
    "LIVEKIT_AGENT_SERVICE_TOKEN",
    "OTTO_DIRECTOR_PLANNER_RUNTIME",
    "OTTO_USE_LIVEKIT_INFERENCE",
    "OTTO_VOICE_PHRASE_TIMEOUT_MS",
)
WORKER_ENV_KEYS_FROM_APP = (
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVEKIT_AGENT_NAME",
    "OTTO_INTERNAL_API_BASE_URL",
    "LIVEKIT_AGENT_SERVICE_TOKEN",
    "DATABASE_SERVICE_URL",
    "OTTO_DIRECTOR_LANGUAGE",
    "OTTO_DIRECTOR_PLANNER_RUNTIME",
    "ANTHROPIC_API_KEY",
    "DIRECTOR_BRAIN_MODEL",
    "DIRECTOR_VOICE_MODEL",
    "OTTO_VOICE_PHRASE_TIMEOUT_MS",
    "OTTO_USE_LIVEKIT_INFERENCE",
    "DEEPGRAM_API_KEY",
    "DEEPGRAM_MODEL",
    "CARTESIA_API_KEY",
    "CARTESIA_MODEL",
    "CARTESIA_VOICE_ID",
    "OTTO_DIRECTOR_PREFLIGHT_STRICT",
    "OTTO_VENDOR_PRIVACY_ACK",
    "OTTO_DEEPGRAM_NO_STORE_ACK",
    "OTTO_CARTESIA_NO_RETENTION_ACK",
    "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK",
)


@dataclass(frozen=True)
class ProofReadinessResult:
    ok: bool
    app_env_file: str
    worker_env_file: str
    app_missing: list[str]
    worker_missing: list[str]
    mismatched: list[str]
    warnings: list[str]
    mode: dict[str, str | bool | None]

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "app_env_file": self.app_env_file,
            "worker_env_file": self.worker_env_file,
            "app_missing": self.app_missing,
            "worker_missing": self.worker_missing,
            "mismatched": self.mismatched,
            "warnings": self.warnings,
            "mode": self.mode,
        }


def check_proof_readiness(
    *,
    app_env_file: str,
    worker_env_file: str,
    base_env: Mapping[str, str | None] | None = None,
    allow_runtime_overrides: bool = False,
) -> ProofReadinessResult:
    runtime_env = base_env if allow_runtime_overrides else {}
    app_env = load_named_env(app_env_file, base_env=runtime_env)
    worker_env = load_named_env(worker_env_file, base_env=runtime_env)
    app_use_inference = bool_from_env(app_env, "OTTO_USE_LIVEKIT_INFERENCE")
    worker_use_inference = bool_from_env(worker_env, "OTTO_USE_LIVEKIT_INFERENCE")
    app_missing = missing_keys(app_env, APP_REQUIRED_KEYS)
    worker_missing = missing_keys(worker_env, WORKER_REQUIRED_KEYS)

    for key in PRIVACY_ACK_KEYS:
        if not bool_from_env(app_env, key):
            app_missing.append(key)
        if not bool_from_env(worker_env, key):
            worker_missing.append(key)

    if not app_use_inference:
        app_missing.extend(missing_keys(app_env, VOICE_PROVIDER_KEYS))
    if not worker_use_inference:
        worker_missing.extend(missing_keys(worker_env, VOICE_PROVIDER_KEYS))

    mismatched = [
        key
        for key in MATCHED_KEYS
        if configured_env_value(app_env, key)
        and configured_env_value(worker_env, key)
        and normalized_env_value(app_env.get(key)) != normalized_env_value(worker_env.get(key))
    ]
    warnings: list[str] = []
    if not configured_env_value(worker_env, "DATABASE_SERVICE_URL"):
        warnings.append(
            "DATABASE_SERVICE_URL is not required by the worker process, but it must be configured in the Next.js app for internal director endpoints."
        )
    app_missing = sorted(dict.fromkeys(app_missing))
    worker_missing = sorted(dict.fromkeys(worker_missing))
    return ProofReadinessResult(
        ok=not app_missing and not worker_missing and not mismatched,
        app_env_file=app_env_file,
        worker_env_file=worker_env_file,
        app_missing=app_missing,
        worker_missing=worker_missing,
        mismatched=mismatched,
        warnings=warnings,
        mode={
            "app_use_livekit_inference": app_use_inference,
            "worker_use_livekit_inference": worker_use_inference,
            "app_agent_name": redacted_presence(app_env.get("LIVEKIT_AGENT_NAME")),
            "worker_agent_name": redacted_presence(worker_env.get("LIVEKIT_AGENT_NAME")),
            "app_internal_api_base_url": redacted_presence(
                app_env.get("OTTO_INTERNAL_API_BASE_URL")
            ),
            "worker_internal_api_base_url": redacted_presence(
                worker_env.get("OTTO_INTERNAL_API_BASE_URL")
            ),
            "runtime_overrides": allow_runtime_overrides,
        },
    )


def load_named_env(
    env_file: str,
    *,
    base_env: Mapping[str, str | None] | None,
) -> dict[str, str | None]:
    if not Path(env_file).exists():
        result = missing_env_file_result(env_file, strict=True)
        raise FileNotFoundError(", ".join(result.missing_required))
    return env_with_file(env_file, base_env=base_env, strict=True)


def missing_keys(env: Mapping[str, str | None], keys: tuple[str, ...]) -> list[str]:
    return [key for key in keys if not configured_env_value(env, key)]


def normalized_env_value(value: str | None) -> str:
    return str(value or "").strip()


def redacted_presence(value: str | None) -> str | None:
    if not value:
        return None
    if not normalized_env_value(value):
        return None
    return "configured"


def write_worker_env_from_app(
    *,
    app_env_file: str,
    worker_env_file: str,
    overwrite: bool = False,
) -> dict[str, object]:
    target = Path(worker_env_file)
    if target.exists() and not overwrite:
        return {
            "ok": False,
            "worker_env_file": worker_env_file,
            "written": False,
            "error": (
                "worker env file already exists; pass --overwrite-worker-env to replace it"
            ),
        }
    app_env = env_with_file(app_env_file, base_env={}, strict=False)
    values = {
        key: str(value)
        for key in WORKER_ENV_KEYS_FROM_APP
        if (value := app_env.get(key)) is not None
    }
    write_secret_text(target, render_worker_env(values))
    return {
        "ok": True,
        "worker_env_file": worker_env_file,
        "written": True,
        "keys_written": sorted(values),
        "values_redacted": True,
    }


def render_worker_env(values: Mapping[str, str]) -> str:
    lines = [
        "# Generated from the Next.js app env for the director voice worker.",
        "# Values are local secrets; this file should remain gitignored.",
    ]
    for key in WORKER_ENV_KEYS_FROM_APP:
        if key in values:
            lines.append(f'{key}="{escape_env_value(values[key])}"')
    lines.append("")
    return "\n".join(lines)


def write_secret_text(target: Path, text: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(target, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(target, 0o600)


def escape_env_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Check app + worker environment readiness for a real director voice proof.",
    )
    parser.add_argument(
        "--app-env-file",
        default="../../otto-frontend/.env.local",
        help="Next.js app env file. Defaults to ../../otto-frontend/.env.local from agents/director.",
    )
    parser.add_argument(
        "--worker-env-file",
        default=".env",
        help="Python worker env file. Defaults to .env from agents/director.",
    )
    parser.add_argument(
        "--allow-runtime-overrides",
        action="store_true",
        help="Let configured shell environment values override both env files before checking.",
    )
    parser.add_argument(
        "--write-worker-env-from-app",
        action="store_true",
        help="Create the worker env file by copying relevant keys from the app env file, then exit.",
    )
    parser.add_argument(
        "--overwrite-worker-env",
        action="store_true",
        help="Allow --write-worker-env-from-app to replace an existing worker env file.",
    )
    args = parser.parse_args()
    if args.write_worker_env_from_app:
        try:
            output = write_worker_env_from_app(
                app_env_file=args.app_env_file,
                worker_env_file=args.worker_env_file,
                overwrite=args.overwrite_worker_env,
            )
        except FileNotFoundError as error:
            output = {
                "ok": False,
                "missing_required": str(error).split(", "),
                "app_env_file": args.app_env_file,
                "worker_env_file": args.worker_env_file,
            }
        print(json.dumps(output, indent=2, sort_keys=True))
        raise SystemExit(0 if output.get("ok") else 1)
    try:
        result = check_proof_readiness(
            app_env_file=args.app_env_file,
            worker_env_file=args.worker_env_file,
            base_env=os.environ,
            allow_runtime_overrides=args.allow_runtime_overrides,
        )
    except FileNotFoundError as error:
        output = {
            "ok": False,
            "missing_required": str(error).split(", "),
            "app_env_file": args.app_env_file,
            "worker_env_file": args.worker_env_file,
        }
        print(json.dumps(output, indent=2, sort_keys=True))
        raise SystemExit(1)

    print(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    raise SystemExit(0 if result.ok else 1)


if __name__ == "__main__":
    main()
