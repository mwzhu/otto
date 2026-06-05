from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timezone
import inspect
import json
import os
from pathlib import Path
import stat
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from livekit.agents import ChatMessage, inference
import yaml

from director_agent.agent import (
    OPENING_PROMPT,
    DirectorConsultantAgent,
    delivery_idempotency_key,
    delivered_utterance_for_status,
    estimated_spoken_fraction,
    ingest_idempotency_key,
    transcript_timing_from_message,
)
from director_agent.otto_api import (
    IngestedTurn,
    OttoApiClient,
    RespondedTurn,
    stable_key,
)
from director_agent import worker
from director_agent.config import DirectorAgentConfig
from director_agent.models import (
    DEFAULT_DIRECTOR_BRAIN_MODEL,
    DEFAULT_DIRECTOR_VOICE_MODEL,
    DEFAULT_SYNTHESIS_PLANNER_MODEL,
    director_brain_model,
    director_voice_model,
    synthesis_planner_model,
)
from director_agent.preflight import (
    PreflightResult,
    check_environment,
    check_smoke_environment,
    check_verification_environment,
    configured_env_value,
    env_with_file,
    missing_env_file_result,
    parse_env_file,
)
from director_agent.proof_readiness import (
    check_proof_readiness,
    write_worker_env_from_app,
)
from director_agent.schema_contract import check_schema_contract
from director_agent.smoke import (
    BACKEND_PRE_TTS_BUDGET_MS,
    DEFAULT_SMOKE_UTTERANCE,
    SmokeDirectorConfig,
    run_turn_smoke,
)
from director_agent.verify import (
    VerificationConfig,
    acceptance_failure_details,
    failed_acceptance_checks,
    preflight_failure_verification,
    run_session_verify,
    session_verify_preflight,
)
from pydantic import ValidationError

from director_agent.planner import (
    DirectorPlanner,
    PlanValidationError,
    PROBE_CONTROLLER,
    anthropic_stream_event,
    deterministic_plan,
    deterministic_phrase,
    director_turn_plan_tool_schema,
    enforce_phase_gate,
    estimate_anthropic_cost_cents,
    compact_voice_context,
    compact_voice_plan,
    limit_to_single_question,
    load_probe_controller,
    merge_deterministic_extractions,
    merge_anthropic_stream_usage,
    tool_use_input,
    validate_plan,
)
from director_agent.schemas import ClaimSubjectFields, DirectorTurnPlan
from director_agent.worker import (
    cartesia_audio_metadata,
    cartesia_language,
    capture_session_id_from_room,
    control_participant_identity_from_context,
    deepgram_language,
    initial_turn_counter,
    publish_worker_startup_failure,
    should_say_opening,
    stt_provider,
    tts_provider,
)


class WorkerContractTests(unittest.TestCase):
    def test_python_model_defaults_mirror_frontend_role_keys(self) -> None:
        self.assertEqual(DEFAULT_DIRECTOR_BRAIN_MODEL, "claude-sonnet-4-6")
        self.assertEqual(DEFAULT_DIRECTOR_VOICE_MODEL, "claude-haiku-4-5-20251001")
        self.assertEqual(DEFAULT_SYNTHESIS_PLANNER_MODEL, "claude-opus-4-7")
        self.assertEqual(director_brain_model({}), DEFAULT_DIRECTOR_BRAIN_MODEL)
        self.assertEqual(director_voice_model({}), DEFAULT_DIRECTOR_VOICE_MODEL)
        self.assertEqual(synthesis_planner_model({}), DEFAULT_SYNTHESIS_PLANNER_MODEL)
        self.assertEqual(
            director_brain_model({"ANTHROPIC_MODEL": "shared-model"}),
            "shared-model",
        )
        self.assertEqual(
            director_voice_model({"ANTHROPIC_MODEL": "shared-model"}),
            DEFAULT_DIRECTOR_VOICE_MODEL,
        )
        self.assertEqual(
            synthesis_planner_model({"ANTHROPIC_MODEL": "shared-model"}),
            "shared-model",
        )
        self.assertEqual(
            director_brain_model(
                {
                    "ANTHROPIC_MODEL": "shared-model",
                    "DIRECTOR_BRAIN_MODEL": "brain-model",
                }
            ),
            "brain-model",
        )
        self.assertEqual(
            director_voice_model(
                {
                    "ANTHROPIC_MODEL": "shared-model",
                    "DIRECTOR_VOICE_MODEL": "voice-model",
                }
            ),
            "voice-model",
        )

    def test_worker_readme_documents_current_realtime_contract(self) -> None:
        readme = (Path(__file__).resolve().parents[1] / "README.md").read_text()

        for endpoint in [
            "/api/internal/director-turns/opening",
            "/api/internal/director-turns/ingest",
            "/api/internal/director-turns/context",
            "/api/internal/director-turns/respond",
            "/api/internal/director-turns/extract",
            "/api/internal/director-turns/check",
            "/api/internal/director-turns/:turnIndex/delivery",
            "/api/internal/director-turns/complete",
        ]:
            self.assertIn(endpoint, readme)
        for phrase in [
            "otto.director.control",
            "mute",
            "unmute",
            "pause",
            "resume",
            "end",
            "director.opening",
            "persist before playback",
            "voice-prompt delivery counts",
            "--strict-voice-env",
            "Full production proof",
            "OTTO_CAPTURE_SESSION_ID=<completed-director-capture-session-id>",
        ]:
            self.assertIn(phrase, readme)
        self.assertIn("otto-director-preflight --env-file .env --strict", readme)
        self.assertIn("otto-director-agent start --env-file .env", readme)

    def test_preflight_can_load_env_file_and_force_strict_mode(self) -> None:
        env_file = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-director-preflight.env"
        env_file.write_text(
            "\n".join(
                [
                    'LIVEKIT_URL="wss://otto.livekit.cloud"',
                    "LIVEKIT_API_KEY=key",
                    "LIVEKIT_API_SECRET=secret",
                    "OTTO_INTERNAL_API_BASE_URL=http://localhost:3000",
                    "LIVEKIT_AGENT_SERVICE_TOKEN=service-token",
                    "DATABASE_SERVICE_URL=postgres://service:service@localhost:5432/otto",
                    "OTTO_USE_LIVEKIT_INFERENCE=true",
                    "ANTHROPIC_API_KEY=anthropic",
                    "OTTO_VENDOR_PRIVACY_ACK=true",
                    "OTTO_DEEPGRAM_NO_STORE_ACK=true",
                    "OTTO_CARTESIA_NO_RETENTION_ACK=true",
                    "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK=true",
                ]
            )
        )
        try:
            parsed = parse_env_file(str(env_file))
            self.assertEqual(parsed["LIVEKIT_URL"], "wss://otto.livekit.cloud")
            merged = env_with_file(str(env_file), base_env={}, strict=True)
            result = check_environment(merged)
        finally:
            env_file.unlink(missing_ok=True)

        self.assertTrue(result.ok)
        self.assertTrue(result.mode["strict"])

    def test_preflight_trims_livekit_inference_boolean(self) -> None:
        env = {
            "LIVEKIT_URL": "wss://otto.livekit.cloud",
            "LIVEKIT_API_KEY": "key",
            "LIVEKIT_API_SECRET": "secret",
            "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
            "LIVEKIT_AGENT_SERVICE_TOKEN": "service-token",
            "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
            "OTTO_USE_LIVEKIT_INFERENCE": " true ",
        }

        result = check_environment(env)

        self.assertTrue(result.ok)
        self.assertTrue(result.mode["use_livekit_inference"])
        self.assertNotIn("DEEPGRAM_API_KEY", result.missing_required)
        self.assertNotIn("CARTESIA_API_KEY", result.missing_required)
        self.assertEqual(
            result.vendor_controls["deepgram_transport"],
            "livekit_inference",
        )

    def test_env_file_does_not_override_explicit_runtime_env(self) -> None:
        env_file = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-director-runtime.env"
        env_file.write_text(
            "\n".join(
                [
                    'OTTO_CAPTURE_SESSION_ID=""',
                    'OTTO_DIRECTOR_PREFLIGHT_STRICT="false"',
                ]
            )
        )
        try:
            merged = env_with_file(
                str(env_file),
                base_env={
                    "OTTO_CAPTURE_SESSION_ID": "14125388-f796-4087-ae34-f18ab845e270",
                    "OTTO_DIRECTOR_PREFLIGHT_STRICT": " yes ",
                    "EMPTY_SHOULD_NOT_OVERRIDE_FILE": "",
                },
            )
        finally:
            env_file.unlink(missing_ok=True)

        self.assertEqual(
            merged["OTTO_CAPTURE_SESSION_ID"],
            "14125388-f796-4087-ae34-f18ab845e270",
        )
        self.assertEqual(merged["OTTO_DIRECTOR_PREFLIGHT_STRICT"], " yes ")
        self.assertTrue(check_environment(merged).mode["strict"])

    def test_worker_cli_can_load_env_file_without_leaking_flag_to_livekit_cli(self) -> None:
        env_file = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-director-worker.env"
        env_file.write_text(
            "\n".join(
                [
                    'LIVEKIT_AGENT_NAME="otto-director-file"',
                    'OTTO_CAPTURE_SESSION_ID="from-file"',
                ]
            )
        )
        argv = ["otto-director-agent", "start", "--env-file", str(env_file)]
        try:
            with patch.dict(
                os.environ,
                {
                    "LIVEKIT_AGENT_NAME": "otto-director-runtime",
                    "OTTO_CAPTURE_SESSION_ID": "",
                },
                clear=True,
            ):
                worker.load_env_file_arg(argv)
                self.assertEqual(os.environ["LIVEKIT_AGENT_NAME"], "otto-director-runtime")
                self.assertEqual(os.environ["OTTO_CAPTURE_SESSION_ID"], "from-file")
        finally:
            env_file.unlink(missing_ok=True)

        self.assertEqual(argv, ["otto-director-agent", "start"])

    def test_preflight_treats_template_placeholders_as_missing(self) -> None:
        env = {
            "LIVEKIT_URL": "wss://your-project.livekit.cloud",
            "LIVEKIT_API_KEY": "...",
            "LIVEKIT_API_SECRET": "replace-with-secret",
            "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
            "LIVEKIT_AGENT_SERVICE_TOKEN": "replace-with-same-token-as-next",
            "DATABASE_SERVICE_URL": "replace-with-service-database-url",
            "DEEPGRAM_API_KEY": "...",
            "CARTESIA_API_KEY": "...",
        }
        result = check_environment(env)

        self.assertFalse(configured_env_value(env, "LIVEKIT_URL"))
        self.assertIn("LIVEKIT_URL", result.missing_required)
        self.assertIn("LIVEKIT_API_KEY", result.missing_required)
        self.assertIn("LIVEKIT_API_SECRET", result.missing_required)
        self.assertIn("LIVEKIT_AGENT_SERVICE_TOKEN", result.missing_required)
        self.assertIn("DATABASE_SERVICE_URL", result.missing_required)
        self.assertIn("DEEPGRAM_API_KEY", result.missing_required)
        self.assertIn("CARTESIA_API_KEY", result.missing_required)

    def test_preflight_reports_missing_env_file_without_traceback(self) -> None:
        result = missing_env_file_result("missing.env", strict=True)

        self.assertFalse(result.ok)
        self.assertEqual(result.missing_required, ["env_file:missing.env"])
        self.assertTrue(result.mode["strict"])
        self.assertEqual(result.mode["env_file"], "missing.env")
        self.assertIn("env file does not exist", result.warnings[0])

    def test_proof_readiness_checks_app_and_worker_env_together(self) -> None:
        app_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-app-proof.env"
        worker_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-worker-proof.env"
        shared = [
            "LIVEKIT_URL=wss://otto.livekit.cloud",
            "LIVEKIT_API_KEY=key",
            "LIVEKIT_API_SECRET=secret",
            "LIVEKIT_AGENT_NAME=otto-director",
            "LIVEKIT_AGENT_SERVICE_TOKEN=service-token",
            "OTTO_INTERNAL_API_BASE_URL=http://localhost:3000",
            "OTTO_DIRECTOR_PLANNER_RUNTIME=python",
            "OTTO_USE_LIVEKIT_INFERENCE=true",
            "OTTO_VOICE_PHRASE_TIMEOUT_MS=2500",
            "ANTHROPIC_API_KEY=anthropic",
            "OTTO_VENDOR_PRIVACY_ACK=true",
            "OTTO_DEEPGRAM_NO_STORE_ACK=true",
            "OTTO_CARTESIA_NO_RETENTION_ACK=true",
            "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK=true",
        ]
        app_env.write_text(
            "\n".join(
                [
                    *shared,
                    "DATABASE_URL=postgres://app:app@localhost/otto",
                    "DATABASE_SERVICE_URL=postgres://service:service@localhost/otto",
                ]
            )
        )
        worker_env.write_text("\n".join(shared))
        try:
            result = check_proof_readiness(
                app_env_file=str(app_env),
                worker_env_file=str(worker_env),
                base_env={},
            )
        finally:
            app_env.unlink(missing_ok=True)
            worker_env.unlink(missing_ok=True)

        self.assertTrue(result.ok)
        self.assertEqual(result.app_missing, [])
        self.assertEqual(result.worker_missing, [])
        self.assertEqual(result.mismatched, [])
        self.assertEqual(result.mode["app_agent_name"], "configured")
        self.assertNotIn("service-token", json.dumps(result.to_dict()))

    def test_proof_readiness_reports_mismatched_service_token(self) -> None:
        app_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-app-proof-bad.env"
        worker_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-worker-proof-bad.env"
        common = [
            "LIVEKIT_URL=wss://otto.livekit.cloud",
            "LIVEKIT_API_KEY=key",
            "LIVEKIT_API_SECRET=secret",
            "LIVEKIT_AGENT_NAME=otto-director",
            "OTTO_INTERNAL_API_BASE_URL=http://localhost:3000",
            "OTTO_DIRECTOR_PLANNER_RUNTIME=python",
            "OTTO_USE_LIVEKIT_INFERENCE=true",
            "ANTHROPIC_API_KEY=anthropic",
            "OTTO_VENDOR_PRIVACY_ACK=true",
            "OTTO_DEEPGRAM_NO_STORE_ACK=true",
            "OTTO_CARTESIA_NO_RETENTION_ACK=true",
            "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK=true",
        ]
        app_env.write_text(
            "\n".join(
                [
                    *common,
                    "LIVEKIT_AGENT_SERVICE_TOKEN=app-token",
                    "DATABASE_URL=postgres://app:app@localhost/otto",
                    "DATABASE_SERVICE_URL=postgres://service:service@localhost/otto",
                ]
            )
        )
        worker_env.write_text("\n".join([*common, "LIVEKIT_AGENT_SERVICE_TOKEN=worker-token"]))
        try:
            result = check_proof_readiness(
                app_env_file=str(app_env),
                worker_env_file=str(worker_env),
                base_env={},
            )
        finally:
            app_env.unlink(missing_ok=True)
            worker_env.unlink(missing_ok=True)

        self.assertFalse(result.ok)
        self.assertEqual(result.mismatched, ["LIVEKIT_AGENT_SERVICE_TOKEN"])

    def test_proof_readiness_reports_mismatched_voice_timeout(self) -> None:
        app_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-app-proof-timeout.env"
        worker_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-worker-proof-timeout.env"
        common = [
            "LIVEKIT_URL=wss://otto.livekit.cloud",
            "LIVEKIT_API_KEY=key",
            "LIVEKIT_API_SECRET=secret",
            "LIVEKIT_AGENT_NAME=otto-director",
            "LIVEKIT_AGENT_SERVICE_TOKEN=service-token",
            "OTTO_INTERNAL_API_BASE_URL=http://localhost:3000",
            "OTTO_DIRECTOR_PLANNER_RUNTIME=python",
            "OTTO_USE_LIVEKIT_INFERENCE=true",
            "ANTHROPIC_API_KEY=anthropic",
            "OTTO_VENDOR_PRIVACY_ACK=true",
            "OTTO_DEEPGRAM_NO_STORE_ACK=true",
            "OTTO_CARTESIA_NO_RETENTION_ACK=true",
            "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK=true",
        ]
        app_env.write_text(
            "\n".join(
                [
                    *common,
                    "OTTO_VOICE_PHRASE_TIMEOUT_MS=2500",
                    "DATABASE_URL=postgres://app:app@localhost/otto",
                    "DATABASE_SERVICE_URL=postgres://service:service@localhost/otto",
                ]
            )
        )
        worker_env.write_text(
            "\n".join([*common, "OTTO_VOICE_PHRASE_TIMEOUT_MS=1000"])
        )
        try:
            result = check_proof_readiness(
                app_env_file=str(app_env),
                worker_env_file=str(worker_env),
                base_env={},
            )
        finally:
            app_env.unlink(missing_ok=True)
            worker_env.unlink(missing_ok=True)

        self.assertFalse(result.ok)
        self.assertEqual(result.mismatched, ["OTTO_VOICE_PHRASE_TIMEOUT_MS"])

    def test_proof_readiness_requires_app_database_url(self) -> None:
        app_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-app-proof-db.env"
        worker_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-worker-proof-db.env"
        shared = [
            "LIVEKIT_URL=wss://otto.livekit.cloud",
            "LIVEKIT_API_KEY=key",
            "LIVEKIT_API_SECRET=secret",
            "LIVEKIT_AGENT_NAME=otto-director",
            "LIVEKIT_AGENT_SERVICE_TOKEN=service-token",
            "OTTO_INTERNAL_API_BASE_URL=http://localhost:3000",
            "OTTO_DIRECTOR_PLANNER_RUNTIME=python",
            "OTTO_USE_LIVEKIT_INFERENCE=true",
            "ANTHROPIC_API_KEY=anthropic",
            "OTTO_VENDOR_PRIVACY_ACK=true",
            "OTTO_DEEPGRAM_NO_STORE_ACK=true",
            "OTTO_CARTESIA_NO_RETENTION_ACK=true",
            "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK=true",
        ]
        app_env.write_text(
            "\n".join(
                [
                    *shared,
                    "DATABASE_SERVICE_URL=postgres://service:service@localhost/otto",
                ]
            )
        )
        worker_env.write_text("\n".join(shared))
        try:
            result = check_proof_readiness(
                app_env_file=str(app_env),
                worker_env_file=str(worker_env),
                base_env={},
            )
        finally:
            app_env.unlink(missing_ok=True)
            worker_env.unlink(missing_ok=True)

        self.assertFalse(result.ok)
        self.assertIn("DATABASE_URL", result.app_missing)
        self.assertNotIn("DATABASE_URL", result.worker_missing)

    def test_proof_readiness_does_not_hide_file_mismatch_with_runtime_env(self) -> None:
        app_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-app-proof-runtime.env"
        worker_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-worker-proof-runtime.env"
        common = [
            "LIVEKIT_URL=wss://otto.livekit.cloud",
            "LIVEKIT_API_KEY=key",
            "LIVEKIT_API_SECRET=secret",
            "LIVEKIT_AGENT_NAME=otto-director",
            "OTTO_INTERNAL_API_BASE_URL=http://localhost:3000",
            "OTTO_DIRECTOR_PLANNER_RUNTIME=python",
            "OTTO_USE_LIVEKIT_INFERENCE=true",
            "ANTHROPIC_API_KEY=anthropic",
            "OTTO_VENDOR_PRIVACY_ACK=true",
            "OTTO_DEEPGRAM_NO_STORE_ACK=true",
            "OTTO_CARTESIA_NO_RETENTION_ACK=true",
            "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK=true",
        ]
        app_env.write_text(
            "\n".join(
                [
                    *common,
                    "LIVEKIT_AGENT_SERVICE_TOKEN=app-token",
                    "DATABASE_URL=postgres://app:app@localhost/otto",
                    "DATABASE_SERVICE_URL=postgres://service:service@localhost/otto",
                ]
            )
        )
        worker_env.write_text("\n".join([*common, "LIVEKIT_AGENT_SERVICE_TOKEN=worker-token"]))
        try:
            result = check_proof_readiness(
                app_env_file=str(app_env),
                worker_env_file=str(worker_env),
                base_env={"LIVEKIT_AGENT_SERVICE_TOKEN": "runtime-token"},
            )
            overridden = check_proof_readiness(
                app_env_file=str(app_env),
                worker_env_file=str(worker_env),
                base_env={"LIVEKIT_AGENT_SERVICE_TOKEN": "runtime-token"},
                allow_runtime_overrides=True,
            )
        finally:
            app_env.unlink(missing_ok=True)
            worker_env.unlink(missing_ok=True)

        self.assertEqual(result.mismatched, ["LIVEKIT_AGENT_SERVICE_TOKEN"])
        self.assertFalse(result.mode["runtime_overrides"])
        self.assertEqual(overridden.mismatched, [])
        self.assertTrue(overridden.mode["runtime_overrides"])

    def test_proof_readiness_can_generate_gitignored_worker_env_from_app_env(self) -> None:
        root = Path(__file__).resolve().parents[1]
        self.assertIn(".env*", (root / ".gitignore").read_text())
        app_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-app-generate.env"
        worker_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-worker-generated.env"
        app_env.write_text(
            "\n".join(
                [
                    "LIVEKIT_URL=wss://otto.livekit.cloud",
                    "LIVEKIT_API_KEY=key",
                    "LIVEKIT_API_SECRET=secret",
                    "LIVEKIT_AGENT_NAME=otto-director",
                    "LIVEKIT_AGENT_SERVICE_TOKEN=service-token",
                    "OTTO_INTERNAL_API_BASE_URL=http://localhost:3000",
                    "DATABASE_URL=postgres://app:app@localhost/otto",
                    "DATABASE_SERVICE_URL=postgres://service:service@localhost/otto",
                    "OTTO_DIRECTOR_PLANNER_RUNTIME=python",
                    "OTTO_USE_LIVEKIT_INFERENCE=true",
                    "OTTO_VOICE_PHRASE_TIMEOUT_MS=2500",
                    "ANTHROPIC_API_KEY=anthropic",
                    "OTTO_VENDOR_PRIVACY_ACK=true",
                    "OTTO_DEEPGRAM_NO_STORE_ACK=true",
                    "OTTO_CARTESIA_NO_RETENTION_ACK=true",
                    "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK=true",
                ]
            )
        )
        try:
            result = write_worker_env_from_app(
                app_env_file=str(app_env),
                worker_env_file=str(worker_env),
            )
            refused = write_worker_env_from_app(
                app_env_file=str(app_env),
                worker_env_file=str(worker_env),
            )
            readiness = check_proof_readiness(
                app_env_file=str(app_env),
                worker_env_file=str(worker_env),
                base_env={},
            )
            generated = worker_env.read_text()
            generated_mode = stat.S_IMODE(worker_env.stat().st_mode)
        finally:
            app_env.unlink(missing_ok=True)
            worker_env.unlink(missing_ok=True)

        self.assertTrue(result["ok"])
        self.assertTrue(result["written"])
        self.assertTrue(result["values_redacted"])
        self.assertIn("LIVEKIT_AGENT_SERVICE_TOKEN", result["keys_written"])
        self.assertIn("OTTO_VOICE_PHRASE_TIMEOUT_MS", result["keys_written"])
        self.assertNotIn("service-token", json.dumps(result))
        self.assertFalse(refused["ok"])
        self.assertIn("already exists", str(refused["error"]))
        self.assertEqual(generated_mode, 0o600)
        self.assertIn('LIVEKIT_AGENT_SERVICE_TOKEN="service-token"', generated)
        self.assertIn('OTTO_VOICE_PHRASE_TIMEOUT_MS="2500"', generated)
        self.assertTrue(readiness.ok)

    def test_worker_container_artifact_runs_production_livekit_worker(self) -> None:
        root = Path(__file__).resolve().parents[1]
        repo_root = root.parents[1]
        dockerfile = (root / "Dockerfile").read_text()
        dockerignore = (root / ".dockerignore").read_text()
        root_dockerignore = (repo_root / ".dockerignore").read_text()
        readme = (root / "README.md").read_text()

        self.assertIn("ghcr.io/astral-sh/uv:python3.11-bookworm-slim", dockerfile)
        self.assertIn("COPY prompts ./prompts", dockerfile)
        self.assertIn("COPY probes ./probes", dockerfile)
        self.assertIn("COPY schemas ./schemas", dockerfile)
        self.assertIn("WORKDIR /app/agents/director", dockerfile)
        self.assertIn("uv sync --locked --no-dev", dockerfile)
        self.assertIn("uv run --no-sync python -m director_agent.schema_contract", dockerfile)
        self.assertIn("uv run --no-sync python -m livekit.agents download-files", dockerfile)
        self.assertIn('CMD ["uv", "run", "--no-sync", "otto-director-agent", "start"]', dockerfile)
        self.assertIn(".venv/", dockerignore)
        self.assertIn("otto-frontend/node_modules/", root_dockerignore)
        self.assertIn("docker build -f agents/director/Dockerfile -t otto-director-agent .", readme)
        self.assertIn("npm --prefix otto-frontend run eval:director:container", readme)
        self.assertIn("prompts/", readme)
        self.assertIn("schemas/", readme)
        self.assertIn("probes/", readme)
        self.assertIn("uv run --no-sync otto-director-agent start", readme)
        self.assertIn("uv run --no-sync python -m director_agent.schema_contract", readme)
        self.assertIn("uv run --no-sync python -m livekit.agents download-files", readme)
        self.assertIn("avoids stale local entry points", readme)
        self.assertIn("LIVEKIT_AGENT_NAME", readme)

    def test_director_voice_smoke_eval_is_ci_wired_and_portable(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        package_json = json.loads((repo_root / "otto-frontend" / "package.json").read_text())
        workflow = (repo_root / ".github" / "workflows" / "director-voice.yml").read_text()

        smoke_script = package_json["scripts"]["eval:director:smoke"]
        self.assertIn("python -m director_agent.schema_contract", smoke_script)
        self.assertIn("python -m unittest discover -s tests", smoke_script)
        self.assertIn("UV_CACHE_DIR=${UV_CACHE_DIR:-/tmp/otto-uv-cache}", smoke_script)
        self.assertNotIn("/private/tmp", smoke_script)
        self.assertIn("npm exec tsc -- --noEmit", workflow)
        self.assertIn("OTTO_DEV_AUTH_BYPASS=false npm run build", workflow)
        self.assertIn("tests/phase0/db.integration.test.ts", workflow)
        self.assertIn("tests/phase1/db.integration.test.ts", workflow)
        self.assertIn("npm run eval:director:smoke", workflow)
        self.assertIn("npm run eval:director:container", workflow)
        self.assertIn("uv sync --locked --no-dev", workflow)

    def test_worker_declares_yaml_parser_as_direct_dependency(self) -> None:
        root = Path(__file__).resolve().parents[1]
        pyproject = (root / "pyproject.toml").read_text()
        lock = (root / "uv.lock").read_text()

        self.assertIn('"pyyaml>=6.0"', pyproject)
        self.assertIn('{ name = "pyyaml", specifier = ">=6.0" }', lock)

    def test_worker_defers_heavy_audio_plugin_imports_until_runtime(self) -> None:
        source = inspect.getsource(worker)
        top_level = source.split("DEEPGRAM_AUTO_LANGUAGE", 1)[0]

        self.assertNotIn("from livekit.plugins import cartesia, deepgram, silero", top_level)
        self.assertNotIn(
            "from livekit.plugins.turn_detector.multilingual import MultilingualModel",
            top_level,
        )
        self.assertIn("from livekit.plugins import silero", source)
        self.assertIn("from livekit.plugins import deepgram", source)
        self.assertIn("from livekit.plugins import cartesia", source)

    def test_semantic_turn_detector_is_opt_in_without_inference_executor(self) -> None:
        source = inspect.getsource(worker.entrypoint)

        self.assertIn("turn_detection = None", source)
        self.assertIn("if config.use_semantic_turn_detector:", source)
        self.assertIn("turn_detection=turn_detection", source)

    def test_capture_session_id_from_livekit_room(self) -> None:
        self.assertEqual(
            capture_session_id_from_room("director-14125388-f796-4087-ae34-f18ab845e270"),
            "14125388-f796-4087-ae34-f18ab845e270",
        )

    def test_worker_uses_room_capture_session_not_env_override(self) -> None:
        source = inspect.getsource(worker.entrypoint)
        self.assertIn("capture_session_id = capture_session_id_from_room(ctx.room.name)", source)
        self.assertNotIn("config.capture_session_id or capture_session_id_from_room", source)

    def test_worker_requires_control_participant_identity_from_context(self) -> None:
        self.assertEqual(
            control_participant_identity_from_context({"director_user_id": "user-1"}),
            "user-1",
        )
        with self.assertRaisesRegex(RuntimeError, "director_user_id"):
            control_participant_identity_from_context({})

    def test_worker_entrypoint_publishes_startup_failure_notice(self) -> None:
        source = inspect.getsource(worker.entrypoint)
        self.assertIn("except Exception as error:", source)
        self.assertIn("await publish_worker_startup_failure(ctx.room, capture_session_id, error)", source)

    def test_worker_entrypoint_reports_config_failures_after_room_connect(self) -> None:
        class FakeParticipant:
            def __init__(self) -> None:
                self.calls = []

            async def publish_data(self, payload, *, reliable, topic):
                self.calls.append((payload, reliable, topic))

        class FakeRoom:
            def __init__(self) -> None:
                self.name = "director-14125388-f796-4087-ae34-f18ab845e270"
                self.local_participant = FakeParticipant()

        class FakeContext:
            def __init__(self) -> None:
                self.room = FakeRoom()
                self.connected = False

            async def connect(self) -> None:
                self.connected = True

        async def run_case() -> FakeContext:
            ctx = FakeContext()
            with patch.object(
                worker.DirectorAgentConfig,
                "from_env",
                side_effect=RuntimeError("Missing DEEPGRAM_API_KEY"),
            ):
                with self.assertRaises(RuntimeError):
                    await worker.entrypoint(ctx)
            return ctx

        ctx = asyncio.run(run_case())
        self.assertTrue(ctx.connected)
        payload, reliable, topic = ctx.room.local_participant.calls[0]
        decoded = json.loads(payload.decode("utf-8"))

        self.assertTrue(reliable)
        self.assertEqual(topic, "otto.director")
        self.assertEqual(decoded["capture_session_id"], "14125388-f796-4087-ae34-f18ab845e270")
        self.assertEqual(decoded["payload"]["notice_type"], "worker_startup_failed")

    def test_worker_startup_failure_notice_uses_data_channel(self) -> None:
        class FakeParticipant:
            def __init__(self) -> None:
                self.calls = []

            async def publish_data(self, payload, *, reliable, topic):
                self.calls.append((payload, reliable, topic))

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = FakeParticipant()

        async def run_case() -> FakeRoom:
            room = FakeRoom()
            published = await publish_worker_startup_failure(
                room,
                "14125388-f796-4087-ae34-f18ab845e270",
                RuntimeError("DEEPGRAM_API_KEY is missing"),
            )
            self.assertTrue(published)
            return room

        room = asyncio.run(run_case())
        payload, reliable, topic = room.local_participant.calls[0]
        decoded = json.loads(payload.decode("utf-8"))

        self.assertTrue(reliable)
        self.assertEqual(topic, "otto.director")
        self.assertEqual(decoded["event"], "director.session.notice")
        self.assertEqual(decoded["payload"]["notice_type"], "worker_startup_failed")
        self.assertEqual(decoded["payload"]["error_type"], "RuntimeError")
        self.assertNotIn("DEEPGRAM_API_KEY", decoded["payload"]["message"])

    def test_rejects_unexpected_room_name(self) -> None:
        with self.assertRaises(RuntimeError):
            capture_session_id_from_room("random-room")

    def test_worker_skips_opening_prompt_when_resuming_existing_session(self) -> None:
        self.assertTrue(should_say_opening({"recent_turns": [], "candidate_processes": []}))
        self.assertFalse(should_say_opening({"has_opening_prompt": True}))
        self.assertFalse(
            should_say_opening(
                {
                    "has_opening_prompt": True,
                    "has_terminal_opening_prompt": True,
                }
            )
        )
        self.assertTrue(
            should_say_opening(
                {
                    "has_opening_prompt": True,
                    "has_terminal_opening_prompt": False,
                    "recent_turns": ["hello"],
                    "candidate_processes": [{"proposed_name": "Forecasting"}],
                }
            )
        )
        self.assertFalse(should_say_opening({"recent_turns": ["hello"]}))
        self.assertFalse(should_say_opening({"candidate_processes": [{"proposed_name": "Forecasting"}]}))
        self.assertFalse(should_say_opening({"prior_intent": "discover_processes"}))

    def test_worker_seeds_fallback_turn_counter_from_persisted_context(self) -> None:
        self.assertEqual(initial_turn_counter({"next_turn_index": 7}), 7)
        self.assertEqual(initial_turn_counter({"next_turn_index": "8"}), 8)
        self.assertEqual(initial_turn_counter({"next_turn_index": -1}), 0)
        self.assertEqual(initial_turn_counter({}), 0)

        class FakeRoom:
            local_participant = None

            def on(self, event, handler):
                return None

        agent = DirectorConsultantAgent(
            capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
            api=object(),
            planner=object(),
            room=FakeRoom(),
            initial_turn_counter=7,
        )
        message = ChatMessage(
            role="user",
            content=["Fallback timing after restart."],
            created_at=2_000.0,
        )
        timing = transcript_timing_from_message(
            message,
            "Fallback timing after restart.",
            agent._turn_counter,
        )

        self.assertEqual(timing.source, "created_at_estimate")
        self.assertEqual(timing.idempotency_parts[0], 7)

    def test_stable_idempotency_keys_are_order_independent(self) -> None:
        self.assertEqual(
            stable_key("turn", {"b": 1, "a": 2}),
            stable_key("turn", {"a": 2, "b": 1}),
        )

    def test_internal_api_client_retries_transient_failures_with_same_key(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(502, text="temporary gateway failure")
            return httpx.Response(
                200,
                json={
                    "latest_utterance": "Forecasting is weekly.",
                    "transcript_segment_ids": ["segment-1"],
                    "evidence_ids": ["evidence-1"],
                    "turn_index": 2,
                },
            )

        async def run_case() -> None:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            api = OttoApiClient(
                "https://otto.example.com",
                "service-token",
                http_client=client,
                max_attempts=2,
            )
            try:
                result = await api.ingest_turn(
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    utterance="Forecasting is weekly.",
                    start_ms=1000,
                    end_ms=3000,
                    confidence=0.9,
                    timing_source="asr_metrics",
                    metadata_json={
                        "source": "livekit_agents",
                        "provider": "deepgram",
                    },
                    idempotency_key="seg-key",
                )
            finally:
                await client.aclose()

            self.assertEqual(result.turn_index, 2)

        asyncio.run(run_case())

        self.assertEqual(len(requests), 2)
        self.assertEqual(
            [request.headers.get("idempotency-key") for request in requests],
            ["seg-key", "seg-key"],
        )
        self.assertEqual(
            [request.url.path for request in requests],
            ["/api/internal/director-turns/ingest", "/api/internal/director-turns/ingest"],
        )
        payload = json.loads(requests[0].content.decode("utf-8"))
        self.assertEqual(
            payload["transcript_segments"][0]["timing_source"],
            "asr_metrics",
        )
        self.assertEqual(
            payload["transcript_segments"][0]["metadata_json"]["provider"],
            "deepgram",
        )

    def test_internal_api_client_allows_long_planner_streams(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "director_agent/otto_api.py").read_text()

        self.assertIn("INTERNAL_API_TIMEOUT_SECONDS = 120.0", source)
        self.assertIn("httpx.Timeout(", source)
        self.assertIn("INTERNAL_API_TIMEOUT_SECONDS", source)

    def test_internal_api_client_omits_null_optional_ingest_fields(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                json={
                    "latest_utterance": "Forecasting is weekly.",
                    "transcript_segment_ids": ["segment-1"],
                    "evidence_ids": ["evidence-1"],
                    "turn_index": 2,
                },
            )

        async def run_case() -> None:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            api = OttoApiClient(
                "https://otto.example.com",
                "service-token",
                http_client=client,
            )
            try:
                await api.ingest_turn(
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    utterance="Forecasting is weekly.",
                    start_ms=1000,
                    end_ms=3000,
                    confidence=None,
                    timing_source=None,
                    metadata_json=None,
                    idempotency_key="seg-key",
                )
            finally:
                await client.aclose()

        asyncio.run(run_case())

        payload = json.loads(requests[0].content.decode("utf-8"))
        segment = payload["transcript_segments"][0]
        self.assertNotIn("confidence", segment)
        self.assertNotIn("timing_source", segment)
        self.assertEqual(segment["metadata_json"], {})

    def test_internal_api_client_retries_rate_limit_with_same_key(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(
                    429,
                    json={"error": {"code": "rate_limited", "message": "Try again."}},
                )
            return httpx.Response(
                200,
                json={
                    "latest_utterance": "Quote approvals need finance.",
                    "transcript_segment_ids": ["segment-1"],
                    "evidence_ids": ["evidence-1"],
                    "turn_index": 3,
                },
            )

        async def run_case() -> None:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            api = OttoApiClient(
                "https://otto.example.com",
                "service-token",
                http_client=client,
                max_attempts=2,
            )
            try:
                result = await api.ingest_turn(
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    utterance="Quote approvals need finance.",
                    start_ms=1000,
                    end_ms=3000,
                    confidence=0.9,
                    timing_source="asr_metrics",
                    idempotency_key="seg-rate-limit-key",
                )
            finally:
                await client.aclose()

            self.assertEqual(result.turn_index, 3)

        with patch("director_agent.otto_api.INTERNAL_API_RETRY_DELAYS_SECONDS", (0.0, 0.0)):
            asyncio.run(run_case())

        self.assertEqual(len(requests), 2)
        self.assertEqual(
            [request.headers.get("idempotency-key") for request in requests],
            ["seg-rate-limit-key", "seg-rate-limit-key"],
        )

    def test_internal_api_client_does_not_retry_non_transient_client_error(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                400,
                json={"error": {"code": "bad_request", "message": "Bad turn."}},
            )

        async def run_case() -> None:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            api = OttoApiClient(
                "https://otto.example.com",
                "service-token",
                http_client=client,
                max_attempts=3,
            )
            try:
                with self.assertRaises(RuntimeError):
                    await api.ingest_turn(
                        capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                        utterance="Bad request.",
                        start_ms=1000,
                        end_ms=3000,
                        confidence=0.9,
                        timing_source="asr_metrics",
                        idempotency_key="seg-bad-request-key",
                    )
            finally:
                await client.aclose()

        asyncio.run(run_case())

        self.assertEqual(len(requests), 1)

    def test_internal_api_client_rejects_delivery_without_decision_log_id(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("invalid delivery updates should fail before HTTP")

        async def run_case() -> None:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            api = OttoApiClient(
                "https://otto.example.com",
                "service-token",
                http_client=client,
                max_attempts=1,
            )
            try:
                await api.update_delivery(
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    turn_index=3,
                    decision_log_id="",
                    delivery_status="completed",
                    delivered_utterance="Let's map that.",
                    spoken_fraction=1,
                    idempotency_key="delivery-key",
                )
            finally:
                await client.aclose()

        with self.assertRaisesRegex(ValueError, "persisted decision_log_id"):
            asyncio.run(run_case())

    def test_internal_api_client_retries_in_progress_idempotency_conflicts(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(
                    409,
                    json={
                        "error": {
                            "code": "conflict",
                            "message": "A request with this Idempotency-Key is already in progress.",
                        }
                    },
                )
            return httpx.Response(
                200,
                json={
                    "latest_utterance": "Forecasting is weekly.",
                    "transcript_segment_ids": ["segment-1"],
                    "evidence_ids": ["evidence-1"],
                    "turn_index": 2,
                },
            )

        async def run_case() -> None:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            api = OttoApiClient(
                "https://otto.example.com",
                "service-token",
                http_client=client,
                max_attempts=2,
            )
            try:
                result = await api.ingest_turn(
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    utterance="Forecasting is weekly.",
                    start_ms=1000,
                    end_ms=3000,
                    confidence=0.9,
                    timing_source="asr_metrics",
                    idempotency_key="seg-key",
                )
            finally:
                await client.aclose()

            self.assertEqual(result.turn_index, 2)

        asyncio.run(run_case())

        self.assertEqual(len(requests), 2)
        self.assertEqual(
            [request.headers.get("idempotency-key") for request in requests],
            ["seg-key", "seg-key"],
        )

    def test_internal_api_client_does_not_retry_body_mismatch_idempotency_conflict(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                409,
                json={
                    "error": {
                        "code": "conflict",
                        "message": "Idempotency-Key was reused with a different request body.",
                    }
                },
            )

        async def run_case() -> None:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            api = OttoApiClient(
                "https://otto.example.com",
                "service-token",
                http_client=client,
                max_attempts=3,
            )
            try:
                with self.assertRaises(RuntimeError):
                    await api.ingest_turn(
                        capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                        utterance="Forecasting is weekly.",
                        start_ms=1000,
                        end_ms=3000,
                        confidence=0.9,
                        timing_source="asr_metrics",
                        idempotency_key="seg-key",
                    )
            finally:
                await client.aclose()

        asyncio.run(run_case())

        self.assertEqual(len(requests), 1)

    def test_read_endpoint_idempotency_keys_are_fresh_per_call(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(502, text="temporary gateway failure")
            return httpx.Response(
                200,
                json={
                    "context": {
                        "current_phase": "orient",
                        "recent_turns": [],
                        "candidate_processes": [],
                    }
                },
            )

        async def run_case() -> None:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            api = OttoApiClient(
                "https://otto.example.com",
                "service-token",
                http_client=client,
                max_attempts=2,
            )
            try:
                await api.planning_context(
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270"
                )
                await api.planning_context(
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270"
                )
            finally:
                await client.aclose()

        asyncio.run(run_case())

        keys = [request.headers.get("idempotency-key") for request in requests]
        self.assertEqual(len(keys), 3)
        self.assertEqual(keys[0], keys[1])
        self.assertNotEqual(keys[1], keys[2])
        self.assertTrue(all(key and key.startswith("context:") for key in keys))
        self.assertEqual(
            [request.url.path for request in requests],
            [
                "/api/internal/director-turns/context",
                "/api/internal/director-turns/context",
                "/api/internal/director-turns/context",
            ],
        )

    def test_delivery_update_omits_absent_latency_payload(self) -> None:
        captured_payloads: list[dict] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            captured_payloads.append(json.loads(request.content.decode("utf-8")))
            return httpx.Response(
                200,
                json={
                    "delivery": {
                        "id": "decision-1",
                        "deliveryJson": {"delivery_status": "completed"},
                    }
                },
            )

        async def run_case() -> None:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            api = OttoApiClient(
                "https://otto.example.com",
                "service-token",
                http_client=client,
                max_attempts=1,
            )
            try:
                await api.update_delivery(
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    turn_index=4,
                    decision_log_id="11111111-1111-5111-8111-111111111111",
                    delivery_status="completed",
                    delivered_utterance="Let's zoom into quote approvals.",
                    spoken_fraction=1,
                    audio_metadata={
                        "source": "livekit_agents",
                        "provider": "cartesia",
                    },
                    idempotency_key="delivery-key",
                )
            finally:
                await client.aclose()

        asyncio.run(run_case())

        self.assertEqual(len(captured_payloads), 1)
        self.assertEqual(captured_payloads[0]["audio_metadata"]["provider"], "cartesia")
        self.assertNotIn("latency_ms", captured_payloads[0])

    def test_session_verify_calls_internal_acceptance_endpoint(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                json={
                    "verification": {
                        "capture_session_id": "14125388-f796-4087-ae34-f18ab845e270",
                        "decision_turns": 2,
                        "delivery": {"pending_delivery_turns": 0},
                        "acceptance": {
                            "has_transcript": True,
                            "all_delivery_terminal": True,
                        },
                    }
                },
            )

        async def run_case() -> dict:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            api = OttoApiClient(
                "https://otto.example.com",
                "service-token",
                http_client=client,
            )
            try:
                return await api.verify_session(
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270"
                )
            finally:
                await client.aclose()

        verification = asyncio.run(run_case())

        self.assertEqual(verification["decision_turns"], 2)
        self.assertTrue(verification["acceptance"]["all_delivery_terminal"])
        self.assertEqual(
            requests[0].url.path,
            "/api/internal/director-turns/verify",
        )
        self.assertEqual(requests[0].headers.get("authorization"), "Bearer service-token")

    def test_session_verify_cli_returns_acceptance_summary(self) -> None:
        class FakeApi:
            async def verify_session(self, *, capture_session_id: str):
                return {
                    "capture_session_id": capture_session_id,
                    "acceptance": {"all_delivery_terminal": True},
                }

            async def aclose(self):
                raise AssertionError("Injected API clients are owned by the test.")

        result = asyncio.run(
            run_session_verify(
                config=DirectorAgentConfig(
                    otto_api_base_url="http://localhost:3000",
                    service_token="token",
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    language="en",
                    planner_runtime="python",
                    anthropic_api_key=None,
                    brain_model="claude-haiku-4-5",
                    voice_model="claude-sonnet-4-6",
                    deepgram_model="nova-3",
                    cartesia_model="sonic-2",
                    cartesia_voice_id="voice-id",
                    use_livekit_inference=True,
                    livekit_agent_name="otto-director",
                ),
                api=FakeApi(),
                preflight_result=PreflightResult(
                    ok=True,
                    missing_required=[],
                    warnings=[],
                    mode={
                        "planner_runtime": "python",
                        "use_livekit_inference": True,
                    },
                    vendor_controls={
                        "deepgram_transport": "livekit_inference",
                        "cartesia_no_retention": "enterprise_account_level_required",
                    },
                ),
            )
        )

        self.assertEqual(
            result["capture_session_id"],
            "14125388-f796-4087-ae34-f18ab845e270",
        )
        self.assertTrue(result["acceptance"]["all_delivery_terminal"])

    def test_session_verify_env_config_ignores_strict_voice_requirements(self) -> None:
        with patch.dict(
            os.environ,
            {
                "OTTO_INTERNAL_API_BASE_URL": "https://otto.example.com",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "OTTO_CAPTURE_SESSION_ID": "14125388-f796-4087-ae34-f18ab845e270",
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": "true",
            },
            clear=True,
        ):
            config = VerificationConfig.from_env()

        self.assertEqual(config.otto_api_base_url, "https://otto.example.com")
        self.assertEqual(config.service_token, "token")
        self.assertEqual(
            config.capture_session_id,
            "14125388-f796-4087-ae34-f18ab845e270",
        )

    def test_session_verify_strict_voice_env_requires_production_voice_config(self) -> None:
        result = session_verify_preflight(
            {
                "OTTO_INTERNAL_API_BASE_URL": "https://otto.example.com",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "OTTO_CAPTURE_SESSION_ID": "14125388-f796-4087-ae34-f18ab845e270",
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": "true",
            },
            strict_voice_env=True,
        )

        self.assertFalse(result.ok)
        for missing in [
            "LIVEKIT_URL",
            "LIVEKIT_API_KEY",
            "LIVEKIT_API_SECRET",
            "DATABASE_SERVICE_URL",
            "DEEPGRAM_API_KEY",
            "CARTESIA_API_KEY",
            "ANTHROPIC_API_KEY",
            "OTTO_VENDOR_PRIVACY_ACK",
            "OTTO_DEEPGRAM_NO_STORE_ACK",
            "OTTO_CARTESIA_NO_RETENTION_ACK",
            "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK",
        ]:
            self.assertIn(missing, result.missing_required)
        self.assertTrue(result.mode["verification_strict_voice_env"])

    def test_session_verify_strict_voice_env_can_cross_check_app_env_file(self) -> None:
        app_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-verify-app.env"
        worker_env = Path(os.environ.get("TMPDIR", "/tmp")) / "otto-verify-worker.env"
        shared = [
            "LIVEKIT_URL=wss://otto.livekit.cloud",
            "LIVEKIT_API_KEY=key",
            "LIVEKIT_API_SECRET=secret",
            "LIVEKIT_AGENT_NAME=otto-director",
            "LIVEKIT_AGENT_SERVICE_TOKEN=service-token",
            "OTTO_INTERNAL_API_BASE_URL=https://otto.example.com",
            "OTTO_DIRECTOR_PLANNER_RUNTIME=python",
            "OTTO_USE_LIVEKIT_INFERENCE=true",
            "ANTHROPIC_API_KEY=anthropic",
            "OTTO_VENDOR_PRIVACY_ACK=true",
            "OTTO_DEEPGRAM_NO_STORE_ACK=true",
            "OTTO_CARTESIA_NO_RETENTION_ACK=true",
            "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK=true",
        ]
        app_env.write_text(
            "\n".join(
                [
                    *shared,
                    "DATABASE_SERVICE_URL=postgres://service:service@localhost:5432/otto",
                ]
            )
        )
        worker_env.write_text(
            "\n".join(
                [
                    *shared,
                    "DATABASE_SERVICE_URL=postgres://service:service@localhost:5432/otto",
                ]
            )
        )
        try:
            result = session_verify_preflight(
                {
                    "LIVEKIT_URL": "wss://otto.livekit.cloud",
                    "LIVEKIT_API_KEY": "key",
                    "LIVEKIT_API_SECRET": "secret",
                    "LIVEKIT_AGENT_SERVICE_TOKEN": "service-token",
                    "OTTO_INTERNAL_API_BASE_URL": "https://otto.example.com",
                    "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                    "OTTO_USE_LIVEKIT_INFERENCE": "true",
                    "ANTHROPIC_API_KEY": "anthropic",
                    "OTTO_VENDOR_PRIVACY_ACK": "true",
                    "OTTO_DEEPGRAM_NO_STORE_ACK": "true",
                    "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                    "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
                    "OTTO_CAPTURE_SESSION_ID": "14125388-f796-4087-ae34-f18ab845e270",
                },
                strict_voice_env=True,
                app_env_file=str(app_env),
                worker_env_file=str(worker_env),
            )
        finally:
            app_env.unlink(missing_ok=True)
            worker_env.unlink(missing_ok=True)

        self.assertFalse(result.ok)
        self.assertIn("DATABASE_URL", result.missing_required)
        self.assertTrue(result.mode["proof_readiness_checked"])

    def test_session_verify_cli_strict_mode_requires_app_env_file(self) -> None:
        result = session_verify_preflight(
            {
                "LIVEKIT_URL": "wss://otto.livekit.cloud",
                "LIVEKIT_API_KEY": "key",
                "LIVEKIT_API_SECRET": "secret",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "service-token",
                "OTTO_INTERNAL_API_BASE_URL": "https://otto.example.com",
                "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "ANTHROPIC_API_KEY": "anthropic",
                "OTTO_VENDOR_PRIVACY_ACK": "true",
                "OTTO_DEEPGRAM_NO_STORE_ACK": "true",
                "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
                "OTTO_CAPTURE_SESSION_ID": "14125388-f796-4087-ae34-f18ab845e270",
            },
            strict_voice_env=True,
            worker_env_file=".env",
            require_app_env_file=True,
        )

        self.assertFalse(result.ok)
        self.assertIn("app_env_file", result.missing_required)
        self.assertIn("--app-env-file", result.warnings[0])

    def test_session_verify_strict_voice_env_keeps_capture_session_requirement(self) -> None:
        result = session_verify_preflight(
            {
                "LIVEKIT_URL": "wss://otto.livekit.cloud",
                "LIVEKIT_API_KEY": "key",
                "LIVEKIT_API_SECRET": "secret",
                "OTTO_INTERNAL_API_BASE_URL": "https://otto.example.com",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "ANTHROPIC_API_KEY": "anthropic",
                "OTTO_VENDOR_PRIVACY_ACK": "true",
                "OTTO_DEEPGRAM_NO_STORE_ACK": "true",
                "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
            },
            strict_voice_env=True,
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.missing_required, ["OTTO_CAPTURE_SESSION_ID"])

    def test_session_verify_rejects_non_uuid_capture_session_id(self) -> None:
        result = check_verification_environment(
            {
                "OTTO_INTERNAL_API_BASE_URL": "https://otto.example.com",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "OTTO_CAPTURE_SESSION_ID": "capture-1",
            },
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.missing_required, ["OTTO_CAPTURE_SESSION_ID"])

    def test_session_verify_rejects_template_placeholder_config(self) -> None:
        with patch.dict(
            os.environ,
            {
                "OTTO_INTERNAL_API_BASE_URL": "https://your-project.example.com",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "OTTO_CAPTURE_SESSION_ID": "capture-1",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "OTTO_INTERNAL_API_BASE_URL"):
                VerificationConfig.from_env()

        with patch.dict(
            os.environ,
            {
                "OTTO_INTERNAL_API_BASE_URL": "https://otto.example.com",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "replace-with-service-token",
                "OTTO_CAPTURE_SESSION_ID": "capture-1",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "LIVEKIT_AGENT_SERVICE_TOKEN"):
                VerificationConfig.from_env()

        with patch.dict(
            os.environ,
            {
                "OTTO_INTERNAL_API_BASE_URL": "https://otto.example.com",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "OTTO_CAPTURE_SESSION_ID": "...",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "OTTO_CAPTURE_SESSION_ID"):
                VerificationConfig.from_env()

    def test_session_verify_rejects_injected_placeholder_config(self) -> None:
        class FakeApi:
            async def verify_session(self, *, capture_session_id: str):
                raise AssertionError("Placeholder config must fail before API calls.")

        with self.assertRaisesRegex(RuntimeError, "OTTO_CAPTURE_SESSION_ID"):
            asyncio.run(
                run_session_verify(
                    config=VerificationConfig(
                        otto_api_base_url="https://otto.example.com",
                        service_token="token",
                        capture_session_id="replace-with-capture-session-id",
                    ),
                    api=FakeApi(),
                    preflight_result=PreflightResult(
                        ok=True,
                        missing_required=[],
                        warnings=[],
                        mode={"verification_only": True},
                        vendor_controls={},
                    ),
                )
            )

    def test_session_verify_allow_incomplete_reports_preflight_blockers(self) -> None:
        result = preflight_failure_verification(
            PreflightResult(
                ok=False,
                missing_required=[
                    "OTTO_INTERNAL_API_BASE_URL",
                    "LIVEKIT_AGENT_SERVICE_TOKEN",
                    "OTTO_CAPTURE_SESSION_ID",
                ],
                warnings=[],
                mode={"verification_only": True},
                vendor_controls={},
            )
        )

        self.assertFalse(result["verification_ready"])
        self.assertEqual(
            result["failed_acceptance_checks"],
            ["verification_environment_configured"],
        )
        self.assertIn(
            "OTTO_CAPTURE_SESSION_ID",
            result["failed_acceptance_details"][0]["inspect"],
        )

    def test_session_verify_reports_failed_acceptance_checks(self) -> None:
        self.assertEqual(
            failed_acceptance_checks(
                {
                    "acceptance": {
                        "all_decisions_have_ingested_transcript_evidence": False,
                        "all_delivery_terminal": False,
                        "all_terminal_delivery_has_spoken_evidence": False,
                        "all_voice_prompts_have_spoken_evidence": False,
                        "backend_pre_tts_p50_ok": True,
                        "backend_pre_tts_p95_ok": True,
                        "capture_session_completed": False,
                        "has_candidate_processes": False,
                        "has_configured_tts_runtime": False,
                        "no_duplicate_candidate_process_names": False,
                        "has_llm_cache_observation": False,
                        "has_llm_brain_turn": False,
                        "has_llm_voice_turn": False,
                        "has_streamed_voice_turn": False,
                        "has_synthesis_run_for_capture": False,
                        "has_vendor_export_audit": False,
                        "no_duplicate_vendor_export_audits": False,
                        "has_livekit_vendor_export_audit": False,
                        "has_stable_livekit_agent_identity": False,
                        "has_anthropic_vendor_export_audit": False,
                        "vendor_privacy_controls_acknowledged": False,
                        "has_voice_cache_observation": False,
                        "no_failed_text_fallback_turns": False,
                        "no_degraded_turns": False,
                        "overview_has_evidence_linked_card": False,
                        "overview_ready": False,
                        "priority_1_no_partial_or_conflicting": False,
                        "synthesis_terminal_for_capture": False,
                        "total_cost_within_2x_baseline": True,
                    }
                }
            ),
            [
                "all_decisions_have_ingested_transcript_evidence",
                "all_delivery_terminal",
                "all_terminal_delivery_has_spoken_evidence",
                "all_voice_prompts_have_spoken_evidence",
                "capture_session_completed",
                "has_anthropic_vendor_export_audit",
                "has_candidate_processes",
                "has_configured_tts_runtime",
                "has_livekit_vendor_export_audit",
                "has_llm_brain_turn",
                "has_llm_cache_observation",
                "has_llm_voice_turn",
                "has_stable_livekit_agent_identity",
                "has_streamed_voice_turn",
                "has_synthesis_run_for_capture",
                "has_vendor_export_audit",
                "has_voice_cache_observation",
                "no_degraded_turns",
                "no_duplicate_candidate_process_names",
                "no_duplicate_vendor_export_audits",
                "no_failed_text_fallback_turns",
                "overview_has_evidence_linked_card",
                "overview_ready",
                "priority_1_no_partial_or_conflicting",
                "synthesis_terminal_for_capture",
                "vendor_privacy_controls_acknowledged",
            ],
        )
        self.assertEqual(
            failed_acceptance_checks({"acceptance": {"has_transcript": True}}),
            [],
        )
        self.assertEqual(failed_acceptance_checks({}), ["acceptance"])

    def test_session_verify_explains_failed_acceptance_checks(self) -> None:
        details = acceptance_failure_details(
            {
                "acceptance": {
                    "has_real_asr_timing": False,
                    "has_llm_brain_turn": False,
                    "priority_1_progress": False,
                }
            }
        )

        self.assertEqual(
            [detail["check"] for detail in details],
            ["has_llm_brain_turn", "has_real_asr_timing", "priority_1_progress"],
        )
        self.assertIn("ANTHROPIC_API_KEY", details[0]["inspect"])
        self.assertIn("timing_source", details[1]["inspect"])
        self.assertIn("slot_states", details[2]["inspect"])
        latency_detail = acceptance_failure_details(
            {"acceptance": {"backend_pre_tts_p50_ok": False}}
        )[0]
        self.assertIn("1.0s p50", latency_detail["summary"])
        self.assertIn("delivery_json.latency_ms", latency_detail["inspect"])
        configured_asr_detail = acceptance_failure_details(
            {"acceptance": {"has_configured_asr_runtime": False}}
        )[0]
        self.assertIn("Deepgram ASR runtime metadata", configured_asr_detail["summary"])
        self.assertIn("metadata_json.model", configured_asr_detail["inspect"])
        privacy_asr_detail = acceptance_failure_details(
            {"acceptance": {"has_privacy_configured_asr_runtime": False}}
        )[0]
        self.assertIn("Deepgram privacy-control metadata", privacy_asr_detail["summary"])
        self.assertIn("privacy_no_store_ack", privacy_asr_detail["inspect"])
        cache_target_detail = acceptance_failure_details(
            {"acceptance": {"llm_cache_hit_rate_target": False}}
        )[0]
        self.assertIn("60% production target", cache_target_detail["summary"])
        self.assertIn("telemetry.llm_cache_hit_rate", cache_target_detail["inspect"])
        voice_cache_target_detail = acceptance_failure_details(
            {"acceptance": {"voice_cache_hit_rate_target": False}}
        )[0]
        self.assertIn("60% production target", voice_cache_target_detail["summary"])
        self.assertIn(
            "telemetry.voice_cache_hit_rate",
            voice_cache_target_detail["inspect"],
        )
        cost_detail = acceptance_failure_details(
            {"acceptance": {"total_cost_within_2x_baseline": False}}
        )[0]
        self.assertIn("2x baseline", cost_detail["summary"])
        self.assertIn("telemetry.total_cost_cents", cost_detail["inspect"])
        raw_logging_detail = acceptance_failure_details(
            {"acceptance": {"raw_payload_logging_audit_consistent": False}}
        )[0]
        self.assertIn("raw-payload logging", raw_logging_detail["summary"])
        self.assertIn(
            "capture.director_voice.raw_payload_logging_enabled",
            raw_logging_detail["inspect"],
        )
        audio_retention_detail = acceptance_failure_details(
            {"acceptance": {"audio_retention_audit_consistent": False}}
        )[0]
        self.assertIn("audio retention", audio_retention_detail["summary"])
        self.assertIn(
            "capture.director_voice.audio_retention_enabled",
            audio_retention_detail["inspect"],
        )
        priority_status_detail = acceptance_failure_details(
            {"acceptance": {"priority_1_no_partial_or_conflicting": False}}
        )[0]
        self.assertIn("partial or conflicting", priority_status_detail["inspect"])
        self.assertIn("slot_states", priority_status_detail["inspect"])
        degraded_detail = acceptance_failure_details(
            {"acceptance": {"no_degraded_turns": False}}
        )[0]
        self.assertIn("unresolved_degraded_turns", degraded_detail["inspect"])
        self.assertIn("re_extract_degraded_turns.recovered", degraded_detail["inspect"])
        streamed_detail = acceptance_failure_details(
            {"acceptance": {"has_streamed_voice_turn": False}}
        )[0]
        self.assertIn("stream_cutoff", streamed_detail["inspect"])
        tts_runtime_detail = acceptance_failure_details(
            {"acceptance": {"has_configured_tts_runtime": False}}
        )[0]
        self.assertIn("audio_metadata.model", tts_runtime_detail["inspect"])
        self.assertIn("voice_id", tts_runtime_detail["inspect"])
        privacy_tts_detail = acceptance_failure_details(
            {"acceptance": {"has_privacy_configured_tts_runtime": False}}
        )[0]
        self.assertIn("Cartesia privacy-control metadata", privacy_tts_detail["summary"])
        self.assertIn("privacy_no_retention_ack", privacy_tts_detail["inspect"])
        prompt_tts_runtime_detail = acceptance_failure_details(
            {"acceptance": {"voice_prompts_have_configured_tts_runtime": False}}
        )[0]
        self.assertIn("persisted voice prompts", prompt_tts_runtime_detail["summary"])
        self.assertIn("audio_metadata.model", prompt_tts_runtime_detail["inspect"])
        prompt_privacy_tts_detail = acceptance_failure_details(
            {"acceptance": {"voice_prompts_have_privacy_configured_tts_runtime": False}}
        )[0]
        self.assertIn("persisted voice prompts", prompt_privacy_tts_detail["summary"])
        self.assertIn("privacy_no_retention_ack", prompt_privacy_tts_detail["inspect"])
        vendor_detail = acceptance_failure_details(
            {"acceptance": {"vendor_privacy_controls_acknowledged": False}}
        )[0]
        self.assertIn("OTTO_VENDOR_PRIVACY_ACK", vendor_detail["inspect"])
        self.assertIn("OTTO_CARTESIA_NO_RETENTION_ACK", vendor_detail["inspect"])
        anthropic_vendor_detail = acceptance_failure_details(
            {"acceptance": {"has_anthropic_vendor_export_audit": False}}
        )[0]
        self.assertIn("ANTHROPIC_API_KEY", anthropic_vendor_detail["inspect"])
        self.assertIn("vendors includes anthropic", anthropic_vendor_detail["inspect"])
        duplicate_vendor_detail = acceptance_failure_details(
            {"acceptance": {"no_duplicate_vendor_export_audits": False}}
        )[0]
        self.assertIn("token refresh idempotency", duplicate_vendor_detail["inspect"])
        self.assertIn("capture.director_voice.vendor_export", duplicate_vendor_detail["inspect"])
        stable_agent_detail = acceptance_failure_details(
            {"acceptance": {"has_stable_livekit_agent_identity": False}}
        )[0]
        self.assertIn("agent_participant_identity", stable_agent_detail["inspect"])
        self.assertIn("accept_director_job", stable_agent_detail["inspect"])
        synthesis_detail = acceptance_failure_details(
            {"acceptance": {"has_synthesis_run_for_capture": False}}
        )[0]
        self.assertIn("synthesis_runs.capture_session_ids", synthesis_detail["inspect"])
        overview_detail = acceptance_failure_details(
            {"acceptance": {"overview_has_evidence_linked_card": False}}
        )[0]
        self.assertIn("candidate_processes.evidence_ids", overview_detail["inspect"])
        turn_contract_detail = acceptance_failure_details(
            {"acceptance": {"all_decisions_have_ingested_transcript_evidence": False}}
        )[0]
        self.assertIn("agent_decision_log.transcript_segment_ids", turn_contract_detail["inspect"])
        self.assertIn("transcript_segments.turn_index", turn_contract_detail["inspect"])
        delivery_fidelity_detail = acceptance_failure_details(
            {"acceptance": {"all_terminal_delivery_has_spoken_evidence": False}}
        )[0]
        self.assertIn("delivered_utterance", delivery_fidelity_detail["inspect"])
        self.assertIn("spoken_fraction", delivery_fidelity_detail["inspect"])
        voice_prompt_fidelity_detail = acceptance_failure_details(
            {"acceptance": {"all_voice_prompts_have_spoken_evidence": False}}
        )[0]
        self.assertIn("voice prompt delivery_json", voice_prompt_fidelity_detail["inspect"])
        self.assertIn("spoken_fraction", voice_prompt_fidelity_detail["inspect"])
        duplicate_candidate_detail = acceptance_failure_details(
            {"acceptance": {"no_duplicate_candidate_process_names": False}}
        )[0]
        self.assertIn("normalized proposed_name duplicates", duplicate_candidate_detail["inspect"])
        self.assertIn("advisory-lock", duplicate_candidate_detail["inspect"])

    def test_livekit_inference_provider_strings_are_configured(self) -> None:
        config = DirectorAgentConfig(
            otto_api_base_url="http://localhost:3000",
            service_token="token",
            capture_session_id=None,
            language="en",
            planner_runtime="python",
            anthropic_api_key=None,
            brain_model="claude-haiku-4-5",
            voice_model="claude-sonnet-4-6",
            deepgram_model="nova-3",
            cartesia_model="sonic-2",
            cartesia_voice_id="voice-id",
            use_livekit_inference=True,
            livekit_agent_name="otto-director",
            vendor_privacy_ack=True,
            cartesia_no_retention_ack=True,
        )

        self.assertEqual(stt_provider(config), "deepgram/nova-3:en")
        self.assertEqual(tts_provider(config), "cartesia/sonic-2:voice-id")
        custom_config = replace(config, deepgram_model="nova-3-meeting")
        self.assertEqual(stt_provider(custom_config), "deepgram/nova-3-meeting:en")
        auto_config = replace(config, language="auto")
        self.assertEqual(stt_provider(auto_config), "deepgram/nova-3:multi")
        with patch.dict(
            os.environ,
            {"LIVEKIT_API_KEY": "livekit-key", "LIVEKIT_API_SECRET": "livekit-secret"},
            clear=False,
        ):
            parsed_stt = inference.STT.from_model_string(stt_provider(config))
            parsed_tts = inference.TTS.from_model_string(tts_provider(config))
        self.assertEqual(parsed_stt._opts.model, "deepgram/nova-3")
        self.assertEqual(parsed_stt._opts.language, "en")
        self.assertEqual(parsed_tts._opts.model, "cartesia/sonic-2")
        self.assertEqual(parsed_tts._opts.voice, "voice-id")

    def test_voice_provider_language_normalization_matches_cartesia_support(self) -> None:
        self.assertEqual(deepgram_language("auto"), "multi")
        self.assertEqual(deepgram_language("pl"), "pl")
        self.assertEqual(cartesia_language("es"), "es")
        self.assertEqual(cartesia_language("ja"), "ja")
        self.assertEqual(cartesia_language("pl"), "en")
        self.assertEqual(cartesia_language("auto"), "en")

    def test_direct_provider_mode_requires_vendor_keys(self) -> None:
        config = DirectorAgentConfig(
            otto_api_base_url="http://localhost:3000",
            service_token="token",
            capture_session_id=None,
            language="en",
            planner_runtime="python",
            anthropic_api_key=None,
            brain_model="claude-haiku-4-5",
            voice_model="claude-sonnet-4-6",
            deepgram_model="nova-3",
            cartesia_model="sonic-2",
            cartesia_voice_id="voice-id",
            use_livekit_inference=False,
            livekit_agent_name="otto-director",
        )

        env_without_provider_keys = {
            key: value
            for key, value in os.environ.items()
            if key not in {"DEEPGRAM_API_KEY", "CARTESIA_API_KEY"}
        }
        with patch.dict(os.environ, env_without_provider_keys, clear=True):
            with self.assertRaisesRegex(RuntimeError, "DEEPGRAM_API_KEY"):
                stt_provider(config)
            with self.assertRaisesRegex(RuntimeError, "CARTESIA_API_KEY"):
                tts_provider(config)

    def test_direct_deepgram_provider_sets_request_level_privacy_controls(self) -> None:
        config = DirectorAgentConfig(
            otto_api_base_url="http://localhost:3000",
            service_token="token",
            capture_session_id=None,
            language="en",
            planner_runtime="python",
            anthropic_api_key=None,
            brain_model="claude-haiku-4-5",
            voice_model="claude-sonnet-4-6",
            deepgram_model="nova-3",
            cartesia_model="sonic-2",
            cartesia_voice_id="voice-id",
            use_livekit_inference=False,
            livekit_agent_name="otto-director",
        )

        with patch.dict(os.environ, {"DEEPGRAM_API_KEY": "deepgram"}, clear=False):
            provider = stt_provider(config)

        self.assertTrue(provider._opts.mip_opt_out)
        self.assertEqual(provider._opts.tags, ["otto", "director-interview"])

    def test_delivery_audio_metadata_carries_configured_cartesia_runtime(self) -> None:
        config = DirectorAgentConfig(
            otto_api_base_url="http://localhost:3000",
            service_token="token",
            capture_session_id=None,
            language="ja",
            planner_runtime="python",
            anthropic_api_key=None,
            brain_model="claude-haiku-4-5",
            voice_model="claude-sonnet-4-6",
            deepgram_model="nova-3",
            cartesia_model="sonic-2",
            cartesia_voice_id="voice-id",
            use_livekit_inference=True,
            livekit_agent_name="otto-director",
            vendor_privacy_ack=True,
            cartesia_no_retention_ack=True,
        )

        metadata = cartesia_audio_metadata(config)

        self.assertEqual(metadata["source"], "livekit_agents")
        self.assertEqual(metadata["provider"], "cartesia")
        self.assertEqual(metadata["model"], "sonic-2")
        self.assertEqual(metadata["voice_id"], "voice-id")
        self.assertEqual(metadata["language"], "ja")
        self.assertEqual(metadata["transport"], "livekit_inference")
        self.assertEqual(metadata["playout"], "session.say.wait_for_playout")
        self.assertTrue(metadata["vendor_privacy_ack"])
        self.assertTrue(metadata["privacy_no_retention_ack"])

    def test_direct_deepgram_provider_enables_language_detection_for_auto(self) -> None:
        config = DirectorAgentConfig(
            otto_api_base_url="http://localhost:3000",
            service_token="token",
            capture_session_id=None,
            language="auto",
            planner_runtime="python",
            anthropic_api_key=None,
            brain_model="claude-haiku-4-5",
            voice_model="claude-sonnet-4-6",
            deepgram_model="nova-3",
            cartesia_model="sonic-2",
            cartesia_voice_id="voice-id",
            use_livekit_inference=False,
            livekit_agent_name="otto-director",
        )

        with patch.dict(os.environ, {"DEEPGRAM_API_KEY": "deepgram"}, clear=False):
            provider = stt_provider(config)

        self.assertEqual(provider._opts.language, "multi")
        self.assertTrue(provider._opts.detect_language)

    def test_direct_cartesia_provider_falls_back_to_supported_tts_language(self) -> None:
        config = DirectorAgentConfig(
            otto_api_base_url="http://localhost:3000",
            service_token="token",
            capture_session_id=None,
            language="pl",
            planner_runtime="python",
            anthropic_api_key=None,
            brain_model="claude-haiku-4-5",
            voice_model="claude-sonnet-4-6",
            deepgram_model="nova-3",
            cartesia_model="sonic-2",
            cartesia_voice_id="voice-id",
            use_livekit_inference=False,
            livekit_agent_name="otto-director",
        )

        with patch.dict(os.environ, {"CARTESIA_API_KEY": "cartesia"}, clear=False):
            provider = tts_provider(config)

        self.assertEqual(provider._opts.language, "en")

    def test_claim_subject_fields_contract_is_shared_with_worker(self) -> None:
        schema_path = Path(__file__).resolve().parents[3] / "schemas" / "claim-subject-fields.json"
        parsed = ClaimSubjectFields.model_validate_json(schema_path.read_text())

        self.assertTrue(parsed.allows("candidate_process", "kpi"))
        self.assertTrue(parsed.allows("system", "used_in_process"))
        self.assertFalse(parsed.allows("candidate_process", "unreviewed_field"))

    def test_python_planner_handles_revops_acceptance_fallback(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "I run rev ops. We own forecasting, territory planning, quote approvals, and sales comp. "
                "Forecasting is weekly, mostly in Salesforce and Sheets. Quote approvals are painful because finance gets pulled in late.",
                ["00000000-0000-0000-0000-000000000001"],
                {"current_phase": "orient", "candidate_processes": []},
            )
        )

        processes = [
            call["arguments"]["name"]
            for call in plan["tool_calls"]
            if call["name"] == "recordProcess"
        ]
        systems = [
            call["arguments"]["name"]
            for call in plan["tool_calls"]
            if call["name"] == "recordSystem"
        ]
        pain_tool = next(
            call
            for call in plan["tool_calls"]
            if call["name"] == "recordPainPoint"
        )
        dependency_claim_tool = next(
            call
            for call in plan["tool_calls"]
            if call["name"] == "recordCandidateProcessClaim"
            and call["arguments"]["field"] == "upstream_dependency"
        )
        slots = [slot["slot_path"] for slot in plan["slot_updates"]]
        phrase = deterministic_phrase(plan).lower()

        self.assertEqual(processes, ["Forecasting", "Territory Planning", "Quote Approvals", "Sales Comp"])
        self.assertIn("Salesforce", systems)
        self.assertIn("Google Sheets", systems)
        self.assertEqual(pain_tool["arguments"]["targetProcess"], "Quote Approvals")
        self.assertEqual(dependency_claim_tool["arguments"]["targetProcess"], "Quote Approvals")
        self.assertEqual(dependency_claim_tool["arguments"]["value"], {"name": "finance"})
        self.assertIn("frequency.volume", slots)
        self.assertIn("handoffs.dependencies", slots)
        self.assertIn("friction.pain_points", slots)
        self.assertIn("quote approvals", phrase)

    def test_python_planner_matches_shared_conversational_eval_fixture(self) -> None:
        fixture_path = (
            Path(__file__).resolve().parents[3]
            / "evals"
            / "director"
            / "conversational-smoke.json"
        )
        fixture = json.loads(fixture_path.read_text())
        evidence_ids = ["00000000-0000-0000-0000-000000000001"]

        for case in fixture["cases"]:
            with self.subTest(case=case["id"]):
                expected = case["expected"]
                context = {
                    "current_phase": case.get("current_phase"),
                    "prior_intent": case.get("prior_intent"),
                    "low_info_turn_count": case.get("low_info_turn_count"),
                    "last_new_slot_turn_index": case.get("last_new_slot_turn_index"),
                    "turn_index": case.get("turn_index"),
                    "slots": [
                        {"slot_path": slot_path, **slot}
                        for slot_path, slot in (case.get("current_slots") or {}).items()
                    ],
                    "candidate_processes": [
                        {"proposed_name": name}
                        for name in case.get("candidate_process_names") or []
                    ],
                }
                plan = validate_plan(
                    deterministic_plan(case["utterance"], evidence_ids, context)
                )
                phrase = deterministic_phrase(plan).lower()

                if expected.get("utterance_type"):
                    self.assertEqual(plan["utterance_type"], expected["utterance_type"])
                if expected.get("chosen_intent"):
                    self.assertEqual(
                        plan["chosen_intent"]["intent"],
                        expected["chosen_intent"],
                    )
                if expected.get("proposed_next_phase"):
                    self.assertEqual(
                        plan["proposed_next_phase"],
                        expected["proposed_next_phase"],
                    )

                processes = [
                    tool["arguments"].get("name")
                    for tool in plan["tool_calls"]
                    if tool["name"] == "recordProcess"
                ]
                for process in expected.get("required_processes") or []:
                    self.assertIn(process, processes)

                slot_paths = [slot["slot_path"] for slot in plan["slot_updates"]]
                for slot_path in expected.get("required_slot_updates") or []:
                    self.assertIn(slot_path, slot_paths)
                for slot_path, status in (
                    expected.get("required_slot_statuses") or {}
                ).items():
                    matching_slot = next(
                        (
                            slot
                            for slot in plan["slot_updates"]
                            if slot["slot_path"] == slot_path
                        ),
                        None,
                    )
                    self.assertIsNotNone(matching_slot)
                    self.assertEqual(matching_slot["status"], status)

                claim_fields = [
                    tool["arguments"].get("field")
                    for tool in plan["tool_calls"]
                    if tool["name"] == "recordCandidateProcessClaim"
                ]
                for field in expected.get("required_claim_fields") or []:
                    self.assertIn(field, claim_fields)

                systems = [
                    tool["arguments"].get("name")
                    for tool in plan["tool_calls"]
                    if tool["name"] == "recordSystem"
                ]
                for system in expected.get("required_systems") or []:
                    self.assertIn(system, systems)

                ranked_intents = [
                    intent["intent"] for intent in plan["ranked_intents"]
                ]
                for forbidden_intent in expected.get("forbidden_intents") or []:
                    self.assertNotIn(forbidden_intent, ranked_intents)
                for fragment in expected.get("required_phrase_fragments") or []:
                    self.assertIn(fragment.lower(), phrase)
                if expected.get("required_contradiction_signal"):
                    self.assertIn(
                        expected["required_contradiction_signal"].lower(),
                        "\n".join(plan["contradiction_signals"]).lower(),
                    )
                for fragment in expected.get("forbidden_phrase_fragments") or []:
                    self.assertNotIn(fragment.lower(), phrase)

    def test_python_planner_preserves_deterministic_facts_when_llm_is_sparse(self) -> None:
        evidence_ids = ["00000000-0000-0000-0000-000000000001"]
        context = {"current_phase": "orient", "candidate_processes": []}
        deterministic = validate_plan(
            deterministic_plan(
                "I run rev ops. We own forecasting in Salesforce and Sheets.",
                evidence_ids,
                context,
            )
        )
        sparse_llm_plan = validate_plan(
            deterministic_plan("I run rev ops.", evidence_ids, context)
        )
        sparse_llm_plan["slot_updates"] = [
            slot
            for slot in sparse_llm_plan["slot_updates"]
            if slot["slot_path"] == "function.name"
        ]
        sparse_llm_plan["tool_calls"] = []

        merged = merge_deterministic_extractions(sparse_llm_plan, deterministic)
        processes = [
            call["arguments"]["name"]
            for call in merged["tool_calls"]
            if call["name"] == "recordProcess"
        ]
        systems = [
            call["arguments"]["name"]
            for call in merged["tool_calls"]
            if call["name"] == "recordSystem"
        ]
        slots = [slot["slot_path"] for slot in merged["slot_updates"]]

        self.assertIn("Forecasting", processes)
        self.assertIn("Salesforce", systems)
        self.assertIn("Google Sheets", systems)
        self.assertIn("process.inventory", slots)
        self.assertIn("systems.systems_of_record", slots)

    def test_python_planner_classifies_consultant_repair_turns(self) -> None:
        evidence_ids = ["00000000-0000-0000-0000-000000000001"]

        audio_check = validate_plan(
            deterministic_plan(
                "Can you hear me?",
                evidence_ids,
                {"current_phase": "orient", "candidate_processes": []},
            )
        )
        self.assertEqual(audio_check["utterance_type"], "meta_question")
        self.assertEqual(audio_check["chosen_intent"]["intent"], "discover_function")
        self.assertEqual(audio_check["tool_calls"], [])

        mid_interview_meta = validate_plan(
            deterministic_plan(
                "How long is this going to take?",
                evidence_ids,
                {
                    "current_phase": "expand",
                    "candidate_processes": [{"proposed_name": "Quote Approvals"}],
                    "slots": [
                        {
                            "slot_path": "function.name",
                            "status": "filled",
                            "confidence": 0.8,
                        },
                        {
                            "slot_path": "process.inventory",
                            "status": "filled",
                            "confidence": 0.8,
                        },
                    ],
                },
            )
        )
        self.assertEqual(mid_interview_meta["utterance_type"], "meta_question")
        self.assertEqual(mid_interview_meta["chosen_intent"]["intent"], "define_process_boundary")
        self.assertEqual(
            mid_interview_meta["chosen_intent"]["target_process"],
            "Quote Approvals",
        )
        self.assertIn(
            "where does the process begin and end",
            deterministic_phrase(mid_interview_meta).lower(),
        )

        mid_interview_meta_after_boundaries = validate_plan(
            deterministic_plan(
                "How long is this going to take?",
                evidence_ids,
                {
                    "current_phase": "expand",
                    "candidate_processes": [{"proposed_name": "Quote Approvals"}],
                    "slots": [
                        {
                            "slot_path": "function.name",
                            "status": "filled",
                            "confidence": 0.8,
                        },
                        {
                            "slot_path": "process.inventory",
                            "status": "filled",
                            "confidence": 0.8,
                        },
                        {
                            "slot_path": "scope.boundaries",
                            "status": "filled",
                            "confidence": 0.8,
                        },
                    ],
                },
            )
        )
        self.assertEqual(
            mid_interview_meta_after_boundaries["chosen_intent"]["intent"],
            "capture_owner_roles",
        )
        self.assertEqual(
            mid_interview_meta_after_boundaries["chosen_intent"]["target_slot"],
            "ownership.roles",
        )
        self.assertIn(
            "who is accountable",
            deterministic_phrase(mid_interview_meta_after_boundaries).lower(),
        )

        focused_meta = validate_plan(
            deterministic_plan(
                "How long is this going to take?",
                evidence_ids,
                {
                    "current_phase": "expand",
                    "focus_candidate_process_id": "22222222-2222-4222-8222-222222222222",
                    "candidate_processes": [
                        {
                            "id": "11111111-1111-4111-8111-111111111111",
                            "proposed_name": "Forecasting",
                        },
                        {
                            "id": "22222222-2222-4222-8222-222222222222",
                            "proposed_name": "Quote Approvals",
                        },
                    ],
                    "slots": [
                        {
                            "slot_path": "function.name",
                            "status": "filled",
                            "confidence": 0.8,
                        },
                        {
                            "slot_path": "process.inventory",
                            "status": "filled",
                            "confidence": 0.8,
                        },
                    ],
                },
            )
        )
        self.assertEqual(
            focused_meta["chosen_intent"]["target_process"],
            "Quote Approvals",
        )
        self.assertIn("quote approvals", deterministic_phrase(focused_meta).lower())

        short_filler = validate_plan(
            deterministic_plan(
                "just testing",
                evidence_ids,
                {"current_phase": "orient", "candidate_processes": []},
            )
        )
        self.assertEqual(short_filler["utterance_type"], "non_answer")
        self.assertEqual(short_filler["chosen_intent"]["intent"], "discover_processes")
        self.assertEqual(short_filler["tool_calls"], [])

        clarification = validate_plan(
            deterministic_plan(
                "What do you mean by systems of record?",
                evidence_ids,
                {
                    "current_phase": "enrich",
                    "candidate_processes": [{"proposed_name": "Quote Approvals"}],
                },
            )
        )
        self.assertEqual(clarification["utterance_type"], "clarification_request")
        self.assertEqual(clarification["chosen_intent"]["intent"], "clarify_previous_question")
        self.assertIn("source of truth", deterministic_phrase(clarification).lower())

        off_topic = validate_plan(
            deterministic_plan(
                "By the way do you know a good lunch place?",
                evidence_ids,
                {"current_phase": "inventory", "candidate_processes": []},
            )
        )
        self.assertEqual(off_topic["utterance_type"], "off_topic")
        self.assertEqual(off_topic["chosen_intent"]["intent"], "discover_processes")
        self.assertIn("come back to that later", deterministic_phrase(off_topic).lower())

        correction = validate_plan(
            deterministic_plan(
                "Actually scratch that, quote approvals are owned by finance, not rev ops.",
                evidence_ids,
                {
                    "current_phase": "expand",
                    "candidate_processes": [{"proposed_name": "Quote Approvals"}],
                },
            )
        )
        self.assertEqual(correction["utterance_type"], "correction")
        self.assertEqual(correction["chosen_intent"]["intent"], "capture_owner_roles")
        self.assertIn("ownership.roles", [slot["slot_path"] for slot in correction["slot_updates"]])
        self.assertIn("corrected prior context", "\n".join(correction["contradiction_signals"]).lower())
        self.assertIn("correction for quote approvals", deterministic_phrase(correction).lower())

        contradiction = validate_plan(
            deterministic_plan(
                "That's wrong, forecasting is not weekly, it's monthly.",
                evidence_ids,
                {
                    "current_phase": "expand",
                    "candidate_processes": [{"proposed_name": "Forecasting"}],
                },
            )
        )
        self.assertEqual(contradiction["utterance_type"], "contradiction")
        self.assertEqual(contradiction["chosen_intent"]["intent"], "reconcile_conflict")
        self.assertEqual(contradiction["chosen_intent"]["target_slot"], "frequency.volume")
        slot_by_path = {slot["slot_path"]: slot for slot in contradiction["slot_updates"]}
        self.assertEqual(slot_by_path["frequency.volume"]["status"], "conflicting")
        self.assertEqual(
            slot_by_path["frequency.volume"]["value"]["source"],
            "director_contradiction",
        )
        self.assertIn("contradicted prior context", "\n".join(contradiction["contradiction_signals"]).lower())
        self.assertIn("which version should i trust", deterministic_phrase(contradiction).lower())

    def test_python_planner_extracts_named_process_from_single_process_answer(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "The process is quote approvals.",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "inventory",
                    "slots": [
                        {
                            "slot_path": "function.name",
                            "status": "filled",
                            "confidence": 0.8,
                        }
                    ],
                    "candidate_processes": [],
                },
            )
        )

        processes = [
            call["arguments"]["name"]
            for call in plan["tool_calls"]
            if call["name"] == "recordProcess"
        ]
        self.assertEqual(processes, ["Quote Approvals"])
        self.assertEqual(plan["chosen_intent"]["intent"], "select_process_to_expand")

    def test_python_planner_marks_dont_know_target_slot_asked_unknown(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "I don't know",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "inventory",
                    "prior_intent": "discover_processes",
                    "slots": [
                        {
                            "slot_path": "function.name",
                            "status": "filled",
                            "confidence": 0.8,
                        }
                    ],
                    "candidate_processes": [],
                },
            )
        )

        slot_by_path = {slot["slot_path"]: slot for slot in plan["slot_updates"]}
        self.assertEqual(plan["utterance_type"], "dont_know")
        self.assertEqual(slot_by_path["process.inventory"]["status"], "asked_unknown")
        self.assertEqual(plan["chosen_intent"]["intent"], "discover_function")
        self.assertIn("three recurring things", deterministic_phrase(plan).lower())

    def test_python_planner_forces_closeout_after_repeated_low_info_turns(self) -> None:
        broadened = validate_plan(
            deterministic_plan(
                "yeah",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "inventory",
                    "low_info_turn_count": 1,
                    "slots": [
                        {"slot_path": "function.name", "status": "filled"},
                    ],
                    "candidate_processes": [],
                },
            )
        )

        self.assertEqual(broadened["utterance_type"], "non_answer")
        self.assertIn("broaden_low_info", broadened["chosen_intent"]["style_hint"])
        self.assertIn(
            "normal week",
            deterministic_phrase(broadened).lower(),
        )

        plan = validate_plan(
            deterministic_plan(
                "yeah",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "enrich",
                    "low_info_turn_count": 2,
                    "turn_index": 8,
                    "last_new_slot_turn_index": 5,
                    "slots": [
                        {"slot_path": "function.name", "status": "filled"},
                        {"slot_path": "process.inventory", "status": "filled"},
                        {"slot_path": "scope.boundaries", "status": "filled"},
                        {"slot_path": "ownership.roles", "status": "filled"},
                        {"slot_path": "systems.systems_of_record", "status": "filled"},
                    ],
                    "candidate_processes": [{"proposed_name": "Quote Approvals"}],
                },
            )
        )

        self.assertEqual(plan["proposed_next_phase"], "closeout")
        self.assertEqual(plan["chosen_intent"]["intent"], "open_questions_closeout")
        self.assertEqual(plan["chosen_intent"]["style_hint"], "forced_closeout")
        followup_slots = [
            call["arguments"].get("targetSlot")
            for call in plan["tool_calls"]
            if call["name"] == "createFollowUpTask"
        ]
        self.assertEqual(
            followup_slots,
            ["outcomes.business_outcomes", "people.key_people"],
        )
        self.assertIn("before we wrap", deterministic_phrase(plan).lower())

    def test_python_planner_forces_closeout_when_duplicate_slot_updates_do_not_add_coverage(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "I run revenue operations.",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "inventory",
                    "low_info_turn_count": 0,
                    "turn_index": 8,
                    "last_new_slot_turn_index": 5,
                    "slots": [
                        {"slot_path": "function.name", "status": "filled"},
                    ],
                    "candidate_processes": [],
                },
            )
        )

        self.assertEqual(plan["proposed_next_phase"], "closeout")
        self.assertEqual(plan["chosen_intent"]["intent"], "open_questions_closeout")
        self.assertEqual(plan["chosen_intent"]["style_hint"], "forced_closeout")
        self.assertIn("without new slot coverage", plan["chosen_intent"]["reason"])

    def test_python_planner_marks_exhausted_probe_asked_unknown(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "yeah",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "inventory",
                    "slots": [],
                    "candidate_processes": [],
                    "probe_firings": [
                        {
                            "probe_id": "discover_processes",
                            "target_slot": "process.inventory",
                            "turn_index": 1,
                            "fired_at": "2026-05-24T00:00:00+00:00",
                        },
                        {
                            "probe_id": "discover_processes",
                            "target_slot": "process.inventory",
                            "turn_index": 2,
                            "fired_at": "2026-05-24T00:02:00+00:00",
                        },
                        {
                            "probe_id": "discover_processes",
                            "target_slot": "process.inventory",
                            "turn_index": 3,
                            "fired_at": "2026-05-24T00:04:00+00:00",
                        },
                    ],
                },
            )
        )

        slot_by_path = {slot["slot_path"]: slot for slot in plan["slot_updates"]}
        follow_ups = [
            call for call in plan["tool_calls"] if call["name"] == "createFollowUpTask"
        ]
        self.assertEqual(slot_by_path["process.inventory"]["status"], "asked_unknown")
        self.assertEqual(
            slot_by_path["process.inventory"]["value"]["source"],
            "probe_max_fires",
        )
        self.assertEqual(
            slot_by_path["process.inventory"]["evidence_ids"],
            ["00000000-0000-0000-0000-000000000001"],
        )
        self.assertEqual(follow_ups[0]["arguments"]["targetSlot"], "process.inventory")

    def test_python_fallback_extracts_enrichment_claims(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "For quote approvals, legal approval is required for enterprise deals, exceptions go through a manual override, and the CFO says this is a top priority this quarter.",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "enrich",
                    "slots": [
                        {"slot_path": "function.name", "status": "filled"},
                        {"slot_path": "process.inventory", "status": "filled"},
                    ],
                    "candidate_processes": [
                        {
                            "id": "00000000-0000-0000-0000-000000000111",
                            "proposed_name": "Quote Approvals",
                        }
                    ],
                },
            )
        )

        slot_paths = {slot["slot_path"] for slot in plan["slot_updates"]}
        claim_fields = {
            call["arguments"]["field"]
            for call in plan["tool_calls"]
            if call["name"] == "recordCandidateProcessClaim"
        }
        self.assertIn("controls.compliance", slot_paths)
        self.assertIn("variants.exceptions", slot_paths)
        self.assertIn("priority.executive_priority", slot_paths)
        self.assertIn("control", claim_fields)
        self.assertIn("variant", claim_fields)
        self.assertIn("exec_priority", claim_fields)

    def test_python_fallback_extracts_risk_and_documentation(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "Quote approvals depend on one person and most exception rules are tribal knowledge, not documented in a runbook.",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "enrich",
                    "slots": [
                        {"slot_path": "function.name", "status": "filled"},
                        {"slot_path": "process.inventory", "status": "filled"},
                    ],
                    "candidate_processes": [
                        {
                            "id": "00000000-0000-0000-0000-000000000111",
                            "proposed_name": "Quote Approvals",
                        }
                    ],
                },
            )
        )

        slot_paths = {slot["slot_path"] for slot in plan["slot_updates"]}
        tool_names = {call["name"] for call in plan["tool_calls"]}
        self.assertIn("risk.spofs", slot_paths)
        self.assertIn("documentation.maturity", slot_paths)
        self.assertIn("recordSpof", tool_names)

    def test_python_fallback_extracts_volunteered_process_boundary(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "Quote approvals start when sales submits a discount request and end when finance approves it.",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "expand",
                    "slots": [
                        {"slot_path": "function.name", "status": "filled"},
                        {"slot_path": "process.inventory", "status": "filled"},
                    ],
                    "candidate_processes": [
                        {
                            "id": "00000000-0000-0000-0000-000000000111",
                            "proposed_name": "Quote Approvals",
                        }
                    ],
                },
            )
        )

        boundary = next(
            slot
            for slot in plan["slot_updates"]
            if slot["slot_path"] == "scope.boundaries"
        )
        self.assertEqual(boundary["status"], "filled")
        self.assertEqual(boundary["value"]["process_names"], ["Quote Approvals"])
        self.assertIn("discount request", boundary["value"]["boundary_statement"])

    def test_python_fallback_extracts_named_people(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "Quote approvals are owned by Pat, and ask Priya for exceptions.",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "enrich",
                    "slots": [
                        {"slot_path": "function.name", "status": "filled"},
                        {"slot_path": "process.inventory", "status": "filled"},
                    ],
                    "candidate_processes": [
                        {
                            "id": "00000000-0000-0000-0000-000000000111",
                            "proposed_name": "Quote Approvals",
                        }
                    ],
                },
            )
        )

        people = next(
            slot
            for slot in plan["slot_updates"]
            if slot["slot_path"] == "people.key_people"
        )
        record_person = next(
            call
            for call in plan["tool_calls"]
            if call["name"] == "recordPerson"
        )
        self.assertEqual(people["value"]["person"], "Pat")
        self.assertEqual(record_person["arguments"]["name"], "Pat")

    def test_python_fallback_extracts_process_relationships(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "Forecasting feeds territory planning because the regional forecast sets the capacity assumptions.",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "enrich",
                    "slots": [
                        {"slot_path": "function.name", "status": "filled"},
                        {"slot_path": "process.inventory", "status": "filled"},
                    ],
                    "candidate_processes": [
                        {
                            "id": "00000000-0000-0000-0000-000000000111",
                            "proposed_name": "Forecasting",
                        },
                        {
                            "id": "00000000-0000-0000-0000-000000000222",
                            "proposed_name": "Territory Planning",
                        },
                    ],
                },
            )
        )

        relationship_slot = next(
            slot
            for slot in plan["slot_updates"]
            if slot["slot_path"] == "handoffs.dependencies"
        )
        relationship_claim = next(
            call
            for call in plan["tool_calls"]
            if call["name"] == "recordCandidateProcessClaim"
            and call["arguments"]["field"] == "process_relationship"
        )
        self.assertEqual(
            relationship_slot["value"]["relationship"]["source_process"],
            "Forecasting",
        )
        self.assertEqual(
            relationship_slot["value"]["relationship"]["target_process"],
            "Territory Planning",
        )
        self.assertEqual(relationship_claim["arguments"]["targetProcess"], "Forecasting")

    def test_python_fallback_extracts_transaction_volume(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "Quote approvals happen weekly, about 200 approval requests per month.",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "expand",
                    "slots": [
                        {"slot_path": "function.name", "status": "filled"},
                        {"slot_path": "process.inventory", "status": "filled"},
                    ],
                    "candidate_processes": [
                        {
                            "id": "00000000-0000-0000-0000-000000000111",
                            "proposed_name": "Quote Approvals",
                        }
                    ],
                },
            )
        )

        frequency = next(
            slot
            for slot in plan["slot_updates"]
            if slot["slot_path"] == "frequency.volume"
        )
        volume_claim = next(
            call
            for call in plan["tool_calls"]
            if call["name"] == "recordCandidateProcessClaim"
            and call["arguments"]["field"] == "volume"
        )
        self.assertEqual(frequency["value"]["frequency"], "weekly")
        self.assertEqual(frequency["value"]["volume"]["count"], 200)
        self.assertEqual(frequency["value"]["volume"]["unit"], "approval requests")
        self.assertEqual(volume_claim["arguments"]["targetProcess"], "Quote Approvals")

    def test_python_probe_controller_loads_shared_yaml_policy(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        probe_document = yaml.safe_load((repo_root / "probes/director.yaml").read_text())
        expected = {
            str(probe["intent"]): {
                "target_slot": str(probe["target_slots"][0]),
                "cooldown_seconds": int(probe["cooldown_seconds"]),
                "max_fires": int(probe["max_fires"]),
                "base_priority": int(probe["base_priority"]),
            }
            for probe in probe_document["probes"]
        }

        self.assertEqual(load_probe_controller(), expected)
        self.assertEqual(PROBE_CONTROLLER, expected)
        self.assertEqual(PROBE_CONTROLLER["discover_processes"]["max_fires"], 3)
        self.assertEqual(PROBE_CONTROLLER["capture_dependencies"]["cooldown_seconds"], 90)

    def test_python_voice_honors_last_attempt_style_hint(self) -> None:
        phrase = deterministic_phrase(
            {
                "utterance_type": "substantive_answer",
                "proposed_next_phase": "expand",
                "chosen_intent": {
                    "intent": "define_process_boundary",
                    "target_slot": "scope.boundaries",
                    "score": 100,
                    "reason": "Boundary is unresolved.",
                    "style_hint": "last_attempt",
                },
            }
        ).lower()

        self.assertIn("last try", phrase)
        self.assertIn("mark it as unknown", phrase)

    def test_python_voice_clamps_bundled_questions_to_one_spoken_ask(self) -> None:
        self.assertEqual(
            limit_to_single_question(
                "Got it. For quote approvals, what outcome is that process responsible for, and where does it start? Who signs off?"
            ),
            "Got it. For quote approvals, what outcome is that process responsible for?",
        )

        phrase = deterministic_phrase(
            {
                "utterance_type": "substantive_answer",
                "proposed_next_phase": "expand",
                "chosen_intent": {
                    "intent": "select_process_to_expand",
                    "target_slot": "scope.boundaries",
                    "target_process": "quote approvals",
                    "score": 100,
                    "reason": "Boundary is unresolved.",
                },
            }
        )

        self.assertEqual(phrase, "Let's zoom into quote approvals. Where does it start?")
        self.assertEqual(phrase.count("?"), 1)

    def test_python_voice_fallback_targets_core_director_intents(self) -> None:
        cases = {
            "capture_outcome": "What business outcome should quote approvals produce?",
            "capture_owner_roles": "Who is accountable for quote approvals?",
            "capture_systems": "Which systems of record, spreadsheets, or shadow tools does the team use for quote approvals?",
            "quantify_frequency_volume": "How often does the team run quote approvals?",
            "capture_metrics": "How do you measure success for quote approvals?",
            "capture_friction": "Where does the team see quote approvals slow down or require manual cleanup today?",
            "capture_dependencies": "What upstream inputs does quote approvals depend on?",
            "capture_risk_spof": "Is any part of quote approvals dependent on one person, tribal knowledge, or a fragile workaround?",
            "capture_controls": "What controls or approvals govern quote approvals?",
            "capture_exec_priority": "How important is quote approvals to the executive team right now?",
            "capture_variants": "What variants or exceptions come up in quote approvals?",
        }

        for intent_name, expected in cases.items():
            with self.subTest(intent=intent_name):
                phrase = deterministic_phrase(
                    {
                        "utterance_type": "substantive_answer",
                        "proposed_next_phase": "enrich",
                        "chosen_intent": {
                            "intent": intent_name,
                            "target_slot": "metrics.kpis",
                            "target_process": "quote approvals",
                            "score": 100,
                            "reason": "Targeted fallback phrasing.",
                        },
                    }
                )

                self.assertEqual(phrase, expected)
                self.assertEqual(phrase.count("?"), 1)

    def test_python_phase_gate_blocks_premature_model_jumps(self) -> None:
        base_plan = {
            "utterance_type": "substantive_answer",
            "slot_updates": [],
            "claims": [],
            "tool_calls": [],
            "contradiction_signals": [],
            "current_phase": "orient",
            "proposed_next_phase": "closeout",
            "phase_transition_ready": True,
            "ranked_intents": [
                {
                    "intent": "playback_summary",
                    "score": 100,
                    "reason": "Model tried to close early.",
                }
            ],
            "chosen_intent": {
                "intent": "playback_summary",
                "score": 100,
                "reason": "Model tried to close early.",
            },
            "planned_agent_utterance": "Great, let's close this out.",
        }

        orient_plan = enforce_phase_gate(base_plan, {"slots": []})
        self.assertEqual(orient_plan["proposed_next_phase"], "orient")
        self.assertEqual(orient_plan["chosen_intent"]["intent"], "discover_function")
        self.assertNotEqual(
            orient_plan["planned_agent_utterance"],
            "Great, let's close this out.",
        )
        self.assertEqual(
            (
                inventory_plan := enforce_phase_gate(
                    base_plan,
                    {
                        "slots": [
                            {
                                "slot_path": "function.name",
                                "status": "partial",
                                "confidence": 0.7,
                            }
                        ]
                    },
                )
            )["proposed_next_phase"],
            "inventory",
        )
        self.assertEqual(inventory_plan["chosen_intent"]["intent"], "discover_processes")
        self.assertEqual(
            (
                expand_plan := enforce_phase_gate(
                    base_plan,
                    {
                        "slots": [
                            {"slot_path": "function.name", "status": "filled"},
                            {"slot_path": "process.inventory", "status": "filled"},
                        ],
                        "candidate_processes": [{"proposed_name": "Forecasting"}],
                    },
                )
            )["proposed_next_phase"],
            "expand",
        )
        self.assertEqual(expand_plan["chosen_intent"]["intent"], "define_process_boundary")
        self.assertEqual(
            enforce_phase_gate(
                base_plan,
                {
                    "slots": [
                        {"slot_path": "function.name", "status": "filled"},
                        {"slot_path": "process.inventory", "status": "filled"},
                        {"slot_path": "scope.boundaries", "status": "asked_unknown"},
                        {"slot_path": "ownership.roles", "status": "filled"},
                        {
                            "slot_path": "systems.systems_of_record",
                            "status": "filled",
                        },
                    ],
                    "candidate_processes": [{"proposed_name": "Forecasting"}],
                },
            )["proposed_next_phase"],
            "closeout",
        )
        forced_closeout = enforce_phase_gate(
            {
                **base_plan,
                "utterance_type": "non_answer",
                "current_phase": "expand",
            },
            {
                "low_info_turn_count": 2,
                "turn_index": 8,
                "last_new_slot_turn_index": 5,
                "slots": [
                    {"slot_path": "function.name", "status": "filled"},
                    {"slot_path": "process.inventory", "status": "filled"},
                ],
                "candidate_processes": [{"proposed_name": "Forecasting"}],
            },
        )
        self.assertEqual(forced_closeout["proposed_next_phase"], "closeout")
        self.assertEqual(
            forced_closeout["chosen_intent"]["intent"],
            "open_questions_closeout",
        )
        self.assertNotEqual(
            forced_closeout["planned_agent_utterance"],
            "Great, let's close this out.",
        )

    def test_python_fallback_applies_probe_cooldown_from_context(self) -> None:
        plan = validate_plan(
            deterministic_plan(
                "yeah",
                ["00000000-0000-0000-0000-000000000001"],
                {
                    "current_phase": "inventory",
                    "candidate_processes": [],
                    "probe_firings": [
                        {
                            "probe_id": "discover_processes",
                            "target_slot": "process.inventory",
                            "turn_index": 1,
                            "fired_at": datetime.now(timezone.utc).isoformat(),
                        }
                    ],
                },
            )
        )

        self.assertNotEqual(plan["chosen_intent"]["intent"], "discover_processes")
        self.assertEqual(plan["chosen_intent"]["intent"], "clarify_previous_question")
        self.assertIn("broaden_low_info", plan["chosen_intent"]["style_hint"])
        self.assertIn("normal week", deterministic_phrase(plan).lower())

    def test_python_llm_phase_gate_applies_probe_cooldown_from_context(self) -> None:
        plan = enforce_phase_gate(
            {
                "utterance_type": "non_answer",
                "slot_updates": [],
                "claims": [],
                "tool_calls": [],
                "contradiction_signals": [],
                "current_phase": "inventory",
                "proposed_next_phase": "inventory",
                "phase_transition_ready": False,
                "ranked_intents": [
                    {
                        "intent": "discover_processes",
                        "target_slot": "process.inventory",
                        "score": 1200,
                        "reason": "The director did not answer the inventory prompt.",
                    }
                ],
                "chosen_intent": {
                    "intent": "discover_processes",
                    "target_slot": "process.inventory",
                    "score": 1200,
                    "reason": "The director did not answer the inventory prompt.",
                },
            },
            {
                "current_phase": "inventory",
                "slots": [
                    {"slot_path": "function.name", "status": "filled"},
                ],
                "candidate_processes": [],
                "probe_firings": [
                    {
                        "probe_id": "discover_processes",
                        "target_slot": "process.inventory",
                        "turn_index": 1,
                        "fired_at": datetime.now(timezone.utc).isoformat(),
                    }
                ],
            },
        )

        self.assertEqual(plan["chosen_intent"]["intent"], "clarify_previous_question")
        self.assertIn("broaden_low_info", plan["chosen_intent"]["style_hint"])
        self.assertNotEqual(plan["chosen_intent"].get("target_slot"), "process.inventory")

    def test_python_planner_validates_director_turn_plan_schema(self) -> None:
        valid_plan = {
                "utterance_type": "greeting",
                "slot_updates": [],
                "claims": [],
                "tool_calls": [],
                "contradiction_signals": [],
                "current_phase": "orient",
                "proposed_next_phase": "orient",
                "phase_transition_ready": False,
                "ranked_intents": [
                    {
                        "intent": "discover_function",
                        "target_slot": "function.name",
                        "score": 100,
                        "reason": "Start with remit.",
                    }
                ],
                "chosen_intent": {
                    "intent": "discover_function",
                    "target_slot": "function.name",
                    "score": 100,
                    "reason": "Start with remit.",
                },
            }
        valid = validate_plan(valid_plan)
        self.assertEqual(valid["chosen_intent"]["intent"], "discover_function")
        with self.assertRaises(ValidationError):
            DirectorTurnPlan.model_validate({"utterance_type": "made_up"})
        minimal_missing_required_arrays = {
            "utterance_type": "greeting",
            "current_phase": "orient",
            "proposed_next_phase": "orient",
            "chosen_intent": {
                "intent": "discover_function",
                "target_slot": "function.name",
                "score": 100,
                "reason": "Start with remit.",
            },
        }
        with self.assertRaises(ValidationError):
            DirectorTurnPlan.model_validate(minimal_missing_required_arrays)
        normalized_minimal = validate_plan(minimal_missing_required_arrays)
        self.assertEqual(normalized_minimal["slot_updates"], [])
        self.assertEqual(normalized_minimal["claims"], [])
        self.assertEqual(normalized_minimal["tool_calls"], [])
        self.assertEqual(normalized_minimal["contradiction_signals"], [])
        self.assertEqual(normalized_minimal["ranked_intents"], [])
        self.assertFalse(normalized_minimal["phase_transition_ready"])
        repaired_choice = validate_plan(
            {
                **minimal_missing_required_arrays,
                "chosen_intent": None,
                "ranked_intents": [
                    {
                        "intent": "capture_metrics",
                        "score": 42,
                        "reason": "Metric gap is highest value.",
                    }
                ],
            }
        )
        self.assertEqual(repaired_choice["chosen_intent"]["intent"], "capture_metrics")
        with self.assertRaises(ValidationError):
            DirectorTurnPlan.model_validate(
                {
                    **valid_plan,
                    "tool_calls": [{"name": "recordProcess"}],
                }
            )
        with self.assertRaises(ValidationError):
            DirectorTurnPlan.model_validate(
                {
                    **valid_plan,
                    "tool_calls": [
                        {
                            "name": "recordProcess",
                            "arguments": {"name": "Forecasting"},
                            "uncontracted_field": True,
                        }
                    ],
                }
            )
        with self.assertRaises(ValidationError):
            DirectorTurnPlan.model_validate(
                {
                    **valid_plan,
                    "slot_updates": [
                        {
                            "slot_path": "function.name",
                            "status": "filled",
                            "confidence": 0.8,
                            "priority": 100,
                        }
                    ],
                }
            )
        with self.assertRaises(ValidationError):
            DirectorTurnPlan.model_validate(
                {
                    **valid_plan,
                    "focus_candidate_process_id": "not-a-uuid",
                }
            )
        with self.assertRaises(ValidationError):
            DirectorTurnPlan.model_validate(
                {
                    **valid_plan,
                    "claims": [
                        {
                            "subject_type": "candidate_process",
                            "subject_id": "not-a-uuid",
                            "field": "kpi",
                            "value": {"name": "forecast accuracy"},
                            "confidence": 0.8,
                            "evidence_ids": ["00000000-0000-0000-0000-000000000002"],
                        }
                    ],
                }
            )
        invalid_claim = {
            **valid_plan,
            "claims": [
                {
                    "subject_type": "candidate_process",
                    "subject_id": "00000000-0000-0000-0000-000000000001",
                    "field": "unreviewed_field",
                    "value": "nope",
                    "confidence": 0.8,
                    "evidence_ids": ["00000000-0000-0000-0000-000000000002"],
                }
            ],
        }
        with self.assertRaises(PlanValidationError):
            validate_plan(invalid_claim)
        invalid_shape = {
            **valid_plan,
            "claims": [
                {
                    "subject_type": "system",
                    "subject_id": "00000000-0000-0000-0000-000000000001",
                    "field": "used_in_process",
                    "value": {"system_name": "Salesforce"},
                    "confidence": 0.8,
                    "evidence_ids": ["00000000-0000-0000-0000-000000000002"],
                }
            ],
        }
        with self.assertRaises(PlanValidationError):
            validate_plan(invalid_shape)
        canonical_claim = {
            **valid_plan,
            "claims": [
                {
                    "subject_type": "process",
                    "subject_id": "00000000-0000-0000-0000-000000000001",
                    "field": "kpi",
                    "value": {"name": "forecast accuracy"},
                    "confidence": 0.8,
                    "evidence_ids": ["00000000-0000-0000-0000-000000000002"],
                }
            ],
        }
        with self.assertRaisesRegex(PlanValidationError, "candidate_process subjects"):
            validate_plan(canonical_claim)

    def test_python_plan_validation_rejects_non_current_turn_evidence(self) -> None:
        current_evidence = "00000000-0000-0000-0000-000000000001"
        stale_evidence = "00000000-0000-0000-0000-000000000099"
        plan = deterministic_plan(
            "I run rev ops. We own forecasting in Salesforce.",
            [current_evidence],
            {"current_phase": "orient", "candidate_processes": []},
        )

        stale_slot_plan = {
            **plan,
            "slot_updates": [
                {
                    **plan["slot_updates"][0],
                    "evidence_ids": [stale_evidence],
                }
            ],
            "claims": [],
        }
        with self.assertRaisesRegex(PlanValidationError, "outside the current turn"):
            validate_plan(
                stale_slot_plan,
                current_evidence_ids=[current_evidence],
            )

        missing_claim_plan = {
            **plan,
            "slot_updates": [],
            "claims": [
                {
                    "subject_type": "candidate_process",
                    "subject_id": "00000000-0000-0000-0000-000000000101",
                    "field": "kpi",
                    "value": {"name": "forecast accuracy"},
                    "confidence": 0.8,
                    "evidence_ids": [],
                }
            ],
        }
        with self.assertRaisesRegex(PlanValidationError, "current turn"):
            validate_plan(
                missing_claim_plan,
                current_evidence_ids=[current_evidence],
            )

    def test_python_director_turn_plan_schema_matches_json_artifact(self) -> None:
        schema_path = Path(__file__).resolve().parents[3] / "schemas" / "director-turn-plan.schema.json"
        artifact = json.loads(schema_path.read_text())
        python_schema = DirectorTurnPlan.model_json_schema()

        self.assertEqual(
            python_schema["required"],
            artifact["required"],
        )
        self.assertEqual(
            python_schema["properties"]["utterance_type"]["enum"],
            artifact["properties"]["utterance_type"]["enum"],
        )
        self.assertEqual(
            python_schema["properties"]["current_phase"]["enum"],
            artifact["properties"]["current_phase"]["enum"],
        )
        self.assertEqual(
            python_schema["properties"]["proposed_next_phase"]["enum"],
            artifact["properties"]["proposed_next_phase"]["enum"],
        )
        self.assertFalse(python_schema["additionalProperties"])
        self.assertFalse(
            python_schema["$defs"]["ToolCall"]["additionalProperties"]
        )
        self.assertFalse(
            python_schema["$defs"]["DirectorIntent"]["additionalProperties"]
        )

    def test_python_schema_contract_check_catches_cross_runtime_drift(self) -> None:
        result = check_schema_contract()
        self.assertTrue(result["ok"], result["errors"])
        self.assertEqual(result["errors"], [])
        self.assertIn("director_turn_plan_json_schema", result["checked"])
        self.assertIn("evidence_json_schema", result["checked"])
        self.assertIn("director_process_inventory_json_schema", result["checked"])
        self.assertIn("python_model", result["checked"])
        self.assertIn("python_evidence_model", result["checked"])
        self.assertIn("python_director_process_inventory_model", result["checked"])
        self.assertIn("anthropic_tool_schema", result["checked"])

    def test_anthropic_brain_uses_tool_schema_from_json_artifact(self) -> None:
        class FakeResponse:
            def __init__(self, body: dict) -> None:
                self._body = body

            def raise_for_status(self) -> None:
                return None

            def json(self) -> dict:
                return self._body

        class FakeClient:
            def __init__(self) -> None:
                self.payload = None

            async def post(self, url, *, headers, json):
                self.payload = json
                return FakeResponse(
                    {
                        "content": [
                            {
                                "type": "tool_use",
                                "name": "emit_director_turn_plan",
                                "input": {
                                    "utterance_type": "greeting",
                                    "slot_updates": [],
                                    "claims": [],
                                    "tool_calls": [],
                                    "contradiction_signals": [],
                                    "current_phase": "orient",
                                    "proposed_next_phase": "orient",
                                    "phase_transition_ready": False,
                                    "ranked_intents": [
                                        {
                                            "intent": "discover_function",
                                            "target_slot": "function.name",
                                            "score": 100,
                                            "reason": "Start with remit.",
                                        }
                                    ],
                                    "chosen_intent": {
                                        "intent": "discover_function",
                                        "target_slot": "function.name",
                                        "score": 100,
                                        "reason": "Start with remit.",
                                    },
                                },
                            }
                        ],
                        "usage": {
                            "input_tokens": 120,
                            "output_tokens": 40,
                            "cache_read_input_tokens": 100,
                        },
                    }
                )

            async def aclose(self):
                return None

        async def run_case() -> tuple[dict, dict]:
            planner = DirectorPlanner(
                api=object(),
                config=DirectorAgentConfig(
                    otto_api_base_url="http://localhost:3000",
                    service_token="token",
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    language="en",
                    planner_runtime="python",
                    anthropic_api_key="anthropic",
                    brain_model="claude-haiku-4-5",
                    voice_model="claude-sonnet-4-6",
                    deepgram_model="nova-3",
                    cartesia_model="sonic-2",
                    cartesia_voice_id="voice-id",
                    use_livekit_inference=True,
                    livekit_agent_name="otto-director",
                ),
            )
            fake_client = FakeClient()
            planner._client = fake_client
            try:
                result = await planner._anthropic_json(
                    model="claude-haiku-4-5",
                    prompt_template_id="director.turn.plan",
                    max_tokens=500,
                    static_input="static",
                    dynamic_input="dynamic",
                )
            finally:
                await planner.aclose()
            return fake_client.payload, result

        payload, result = asyncio.run(run_case())
        tool = payload["tools"][0]

        self.assertEqual(tool["name"], "emit_director_turn_plan")
        self.assertEqual(
            payload["tool_choice"],
            {"type": "tool", "name": "emit_director_turn_plan"},
        )
        self.assertEqual(tool["input_schema"], director_turn_plan_tool_schema())
        self.assertNotIn("$ref", json.dumps(tool["input_schema"]))
        schema_text = json.dumps(tool["input_schema"])
        self.assertIn("function.name", schema_text)
        self.assertIn("process.inventory", schema_text)
        self.assertIn("select_process_to_expand", schema_text)
        self.assertEqual(result["value"]["utterance_type"], "greeting")
        self.assertTrue(result["metadata"]["cache_hit"])
        self.assertEqual(result["metadata"]["cache_read_input_tokens"], 100)
        self.assertEqual(result["metadata"]["cache_creation_input_tokens"], 0)

    def test_anthropic_brain_retries_transient_http_errors(self) -> None:
        class FakeResponse:
            def __init__(self, body: dict | None = None, *, status_code: int = 200) -> None:
                self._body = body or {}
                self._status_code = status_code

            def raise_for_status(self) -> None:
                if self._status_code < 400:
                    return None
                request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
                response = httpx.Response(self._status_code, request=request)
                raise httpx.HTTPStatusError(
                    "transient upstream failure",
                    request=request,
                    response=response,
                )

            def json(self) -> dict:
                return self._body

        class FakeClient:
            def __init__(self) -> None:
                self.calls = 0

            async def post(self, url, *, headers, json):
                del url, headers, json
                self.calls += 1
                if self.calls == 1:
                    return FakeResponse(status_code=529)
                return FakeResponse(
                    {
                        "content": [
                            {
                                "type": "tool_use",
                                "name": "emit_director_turn_plan",
                                "input": {
                                    "utterance_type": "greeting",
                                    "slot_updates": [],
                                    "claims": [],
                                    "tool_calls": [],
                                    "contradiction_signals": [],
                                    "current_phase": "orient",
                                    "proposed_next_phase": "orient",
                                    "phase_transition_ready": False,
                                    "ranked_intents": [
                                        {
                                            "intent": "discover_function",
                                            "target_slot": "function.name",
                                            "score": 100,
                                            "reason": "Start with remit.",
                                        }
                                    ],
                                    "chosen_intent": {
                                        "intent": "discover_function",
                                        "target_slot": "function.name",
                                        "score": 100,
                                        "reason": "Start with remit.",
                                    },
                                },
                            }
                        ],
                        "usage": {"input_tokens": 120, "output_tokens": 40},
                    }
                )

            async def aclose(self):
                return None

        async def run_case() -> tuple[dict, FakeClient]:
            planner = DirectorPlanner(
                api=object(),
                config=DirectorAgentConfig(
                    otto_api_base_url="http://localhost:3000",
                    service_token="token",
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    language="en",
                    planner_runtime="python",
                    anthropic_api_key="anthropic",
                    brain_model="claude-haiku-4-5",
                    voice_model="claude-sonnet-4-6",
                    deepgram_model="nova-3",
                    cartesia_model="sonic-2",
                    cartesia_voice_id="voice-id",
                    use_livekit_inference=True,
                    livekit_agent_name="otto-director",
                ),
            )
            fake_client = FakeClient()
            planner._client = fake_client
            try:
                result = await planner._anthropic_json(
                    model="claude-haiku-4-5",
                    prompt_template_id="director.turn.plan",
                    max_tokens=500,
                    static_input="static",
                    dynamic_input="dynamic",
                )
            finally:
                await planner.aclose()
            return result, fake_client

        with patch("director_agent.planner.ANTHROPIC_RETRY_DELAYS_SECONDS", (0.0, 0.0)):
            result, fake_client = asyncio.run(run_case())

        self.assertEqual(fake_client.calls, 2)
        self.assertEqual(result["value"]["chosen_intent"]["intent"], "discover_function")
        self.assertEqual(result["metadata"]["anthropic_attempts"], 2)
        self.assertEqual(result["metadata"]["anthropic_retry_count"], 1)

    def test_anthropic_voice_streams_until_first_question(self) -> None:
        class FakeStreamResponse:
            def __init__(self, lines: list[str]) -> None:
                self.lines = lines
                self.yielded = 0

            def raise_for_status(self) -> None:
                return None

            async def aiter_lines(self):
                for line in self.lines:
                    self.yielded += 1
                    yield line

        class FakeStreamContext:
            def __init__(self, response: FakeStreamResponse) -> None:
                self.response = response

            async def __aenter__(self) -> FakeStreamResponse:
                return self.response

            async def __aexit__(self, exc_type, exc, tb) -> None:
                return None

        class FakeClient:
            def __init__(self) -> None:
                self.payload = None
                self.response = FakeStreamResponse(
                    [
                        "event: message_start",
                        'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":80}}}',
                        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Got it. "}}',
                        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"What metric matters most?"}}',
                        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" Who owns it?"}}',
                    ]
                )

            def stream(self, method, url, *, headers, json):
                del method, url, headers
                self.payload = json
                return FakeStreamContext(self.response)

            async def aclose(self):
                return None

        async def run_case() -> tuple[dict, FakeClient]:
            planner = DirectorPlanner(
                api=object(),
                config=DirectorAgentConfig(
                    otto_api_base_url="http://localhost:3000",
                    service_token="token",
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    language="en",
                    planner_runtime="python",
                    anthropic_api_key="anthropic",
                    brain_model="claude-haiku-4-5",
                    voice_model="claude-sonnet-4-6",
                    deepgram_model="nova-3",
                    cartesia_model="sonic-2",
                    cartesia_voice_id="voice-id",
                    use_livekit_inference=True,
                    livekit_agent_name="otto-director",
                ),
            )
            fake_client = FakeClient()
            planner._client = fake_client
            try:
                result = await planner._anthropic_text(
                    model="claude-sonnet-4-6",
                    prompt_template_id="director.voice.phrase-intent",
                    max_tokens=200,
                    static_input="static",
                    dynamic_input="dynamic",
                )
            finally:
                await planner.aclose()
            return result, fake_client

        result, fake_client = asyncio.run(run_case())

        self.assertTrue(fake_client.payload["stream"])
        self.assertEqual(result["text"], "Got it. What metric matters most?")
        self.assertEqual(result["metadata"]["stream_cutoff"], "first_question")
        self.assertTrue(result["metadata"]["streaming"])
        self.assertTrue(result["metadata"]["cache_hit"])
        self.assertEqual(result["metadata"]["cache_read_input_tokens"], 80)
        self.assertLess(fake_client.response.yielded, len(fake_client.response.lines))

    def test_anthropic_voice_retries_transient_stream_errors(self) -> None:
        class FakeStreamResponse:
            def __init__(self, lines: list[str], *, status_code: int = 200) -> None:
                self.lines = lines
                self.status_code = status_code

            def raise_for_status(self) -> None:
                if self.status_code < 400:
                    return None
                request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
                response = httpx.Response(self.status_code, request=request)
                raise httpx.HTTPStatusError(
                    "transient upstream failure",
                    request=request,
                    response=response,
                )

            async def aiter_lines(self):
                for line in self.lines:
                    yield line

        class FakeStreamContext:
            def __init__(self, response: FakeStreamResponse) -> None:
                self.response = response

            async def __aenter__(self) -> FakeStreamResponse:
                return self.response

            async def __aexit__(self, exc_type, exc, tb) -> None:
                return None

        class FakeClient:
            def __init__(self) -> None:
                self.calls = 0

            def stream(self, method, url, *, headers, json):
                del method, url, headers, json
                self.calls += 1
                if self.calls == 1:
                    return FakeStreamContext(FakeStreamResponse([], status_code=429))
                return FakeStreamContext(
                    FakeStreamResponse(
                        [
                            'data: {"type":"message_start","message":{"usage":{"input_tokens":80}}}',
                            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Thanks. "}}',
                            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Which process should we map first?"}}',
                        ]
                    )
                )

            async def aclose(self):
                return None

        async def run_case() -> tuple[dict, FakeClient]:
            planner = DirectorPlanner(
                api=object(),
                config=DirectorAgentConfig(
                    otto_api_base_url="http://localhost:3000",
                    service_token="token",
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    language="en",
                    planner_runtime="python",
                    anthropic_api_key="anthropic",
                    brain_model="claude-haiku-4-5",
                    voice_model="claude-sonnet-4-6",
                    deepgram_model="nova-3",
                    cartesia_model="sonic-2",
                    cartesia_voice_id="voice-id",
                    use_livekit_inference=True,
                    livekit_agent_name="otto-director",
                ),
            )
            fake_client = FakeClient()
            planner._client = fake_client
            try:
                result = await planner._anthropic_text(
                    model="claude-sonnet-4-6",
                    prompt_template_id="director.voice.phrase-intent",
                    max_tokens=200,
                    static_input="static",
                    dynamic_input="dynamic",
                )
            finally:
                await planner.aclose()
            return result, fake_client

        with patch("director_agent.planner.ANTHROPIC_RETRY_DELAYS_SECONDS", (0.0, 0.0)):
            result, fake_client = asyncio.run(run_case())

        self.assertEqual(fake_client.calls, 2)
        self.assertEqual(result["text"], "Thanks. Which process should we map first?")
        self.assertEqual(result["metadata"]["anthropic_attempts"], 2)
        self.assertEqual(result["metadata"]["anthropic_retry_count"], 1)

    def test_tool_use_input_falls_back_to_text_json_for_repair_paths(self) -> None:
        value = tool_use_input(
            {
                "content": [
                    {
                        "type": "text",
                        "text": '{"utterance_type":"greeting"}',
                    }
                ]
            },
            "emit_director_turn_plan",
        )

        self.assertEqual(value, {"utterance_type": "greeting"})

    def test_anthropic_plan_validation_retries_once(self) -> None:
        class FakePlanner(DirectorPlanner):
            def __init__(self) -> None:
                self.calls = 0

            async def _anthropic_json(self, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    return {
                        "value": {"utterance_type": "made_up"},
                        "metadata": {"attempt": 1},
                    }
                return {
                    "value": {
                        "utterance_type": "greeting",
                        "slot_updates": [],
                        "claims": [],
                        "tool_calls": [],
                        "contradiction_signals": [],
                        "current_phase": "orient",
                        "proposed_next_phase": "orient",
                        "phase_transition_ready": False,
                        "ranked_intents": [
                            {
                                "intent": "discover_function",
                                "target_slot": "function.name",
                                "score": 100,
                                "reason": "Start with remit.",
                            }
                        ],
                        "chosen_intent": {
                            "intent": "discover_function",
                            "target_slot": "function.name",
                            "score": 100,
                            "reason": "Start with remit.",
                        },
                    },
                    "metadata": {"attempt": 2},
                }

        async def run_case():
            planner = FakePlanner()
            result = await planner._anthropic_validated_plan(
                model="model",
                prompt_template_id="director.turn.plan",
                max_tokens=500,
                static_input="static",
                dynamic_input="dynamic",
            )
            self.assertEqual(planner.calls, 2)
            self.assertEqual(result["metadata"], {"attempt": 2})
            self.assertEqual(result["value"]["chosen_intent"]["intent"], "discover_function")

        asyncio.run(run_case())

    def test_anthropic_plan_validation_retries_stale_evidence(self) -> None:
        current_evidence = "00000000-0000-0000-0000-000000000001"
        stale_evidence = "00000000-0000-0000-0000-000000000099"

        class FakePlanner(DirectorPlanner):
            def __init__(self) -> None:
                self.calls = 0

            async def _anthropic_json(self, **kwargs):
                self.calls += 1
                evidence_ids = [stale_evidence] if self.calls == 1 else [current_evidence]
                return {
                    "value": {
                        "utterance_type": "substantive_answer",
                        "slot_updates": [
                            {
                                "slot_path": "metrics.kpis",
                                "status": "filled",
                                "confidence": 0.8,
                                "evidence_ids": evidence_ids,
                                "priority": 80,
                                "value": {"metrics": ["forecast accuracy"]},
                            }
                        ],
                        "claims": [],
                        "tool_calls": [],
                        "contradiction_signals": [],
                        "current_phase": "expand",
                        "proposed_next_phase": "enrich",
                        "phase_transition_ready": True,
                        "ranked_intents": [
                            {
                                "intent": "capture_metrics",
                                "target_slot": "metrics.kpis",
                                "score": 100,
                                "reason": "Metric was supplied.",
                            }
                        ],
                        "chosen_intent": {
                            "intent": "capture_metrics",
                            "target_slot": "metrics.kpis",
                            "score": 100,
                            "reason": "Metric was supplied.",
                        },
                    },
                    "metadata": {"attempt": self.calls},
                }

        async def run_case():
            planner = FakePlanner()
            result = await planner._anthropic_validated_plan(
                model="model",
                prompt_template_id="director.turn.plan",
                max_tokens=500,
                static_input="static",
                dynamic_input="dynamic",
                current_evidence_ids=[current_evidence],
            )
            self.assertEqual(planner.calls, 2)
            self.assertEqual(result["metadata"], {"attempt": 2})
            self.assertEqual(
                result["value"]["slot_updates"][0]["evidence_ids"],
                [current_evidence],
            )

        asyncio.run(run_case())

    def test_anthropic_cost_metadata_is_estimated(self) -> None:
        cents = estimate_anthropic_cost_cents(
            "claude-sonnet-4-6",
            {"cache_read_input_tokens": 200, "cache_creation_input_tokens": 100},
            input_tokens=1000,
            output_tokens=100,
        )
        self.assertGreater(cents, 0)

    def test_stream_usage_merges_message_delta_cache_creation(self) -> None:
        usage: dict[str, object] = {}
        for line in [
            'data: {"type":"message_start","message":{"usage":{"input_tokens":120}}}',
            'data: {"type":"message_delta","usage":{"output_tokens":14,"cache_creation_input_tokens":80}}',
            'data: {"type":"message_delta","usage":{"output_tokens":24,"cache_read_input_tokens":40}}',
        ]:
            event = anthropic_stream_event(line)
            self.assertIsNotNone(event)
            usage = merge_anthropic_stream_usage(usage, event or {})

        self.assertEqual(usage["input_tokens"], 120)
        self.assertEqual(usage["output_tokens"], 24)
        self.assertEqual(usage["cache_creation_input_tokens"], 80)
        self.assertEqual(usage["cache_read_input_tokens"], 40)

    def test_worker_constructs_python_planner_before_agent(self) -> None:
        source = inspect.getsource(worker.entrypoint)
        self.assertIn("planner = None", source)
        self.assertIn("context = await api.planning_context", source)
        self.assertIn("language=str(context.get(\"language\")", source)
        self.assertIn("planner = DirectorPlanner(api=api, config=config)", source)
        self.assertIn("planner=planner", source)
        self.assertIn("stale_pending_delivery_decisions=context.get", source)
        self.assertIn("if planner is not None:", source)
        self.assertIn("await planner.aclose()", source)
        self.assertIn(
            'agent_name=os.getenv("LIVEKIT_AGENT_NAME", "otto-director")',
            inspect.getsource(worker.main),
        )
        self.assertEqual(DirectorPlanner.__name__, "DirectorPlanner")

    def test_worker_accepts_director_jobs_with_stable_agent_identity(self) -> None:
        class FakeRoom:
            name = "director-14125388-f796-4087-ae34-f18ab845e270"

        class FakeRequest:
            room = FakeRoom()

            def __init__(self) -> None:
                self.accepted = None
                self.rejected = None

            async def accept(self, **kwargs):
                self.accepted = kwargs

            async def reject(self, **kwargs):
                self.rejected = kwargs

        request = FakeRequest()

        asyncio.run(worker.accept_director_job(request))

        self.assertIsNone(request.rejected)
        self.assertEqual(
            request.accepted["identity"],
            "otto-director-agent-14125388-f796-4087-ae34-f18ab845e270",
        )
        self.assertEqual(request.accepted["name"], "otto-director")
        self.assertEqual(
            json.loads(request.accepted["metadata"]),
            {"capture_session_id": "14125388-f796-4087-ae34-f18ab845e270"},
        )

    def test_worker_rejects_non_director_room_jobs(self) -> None:
        class FakeRoom:
            name = "general-room"

        class FakeRequest:
            room = FakeRoom()

            def __init__(self) -> None:
                self.accepted = None
                self.rejected = None

            async def accept(self, **kwargs):
                self.accepted = kwargs

            async def reject(self, **kwargs):
                self.rejected = kwargs

        request = FakeRequest()

        asyncio.run(worker.accept_director_job(request))

        self.assertIsNone(request.accepted)
        self.assertEqual(request.rejected, {"terminate": False})

    def test_worker_options_use_stable_request_acceptance(self) -> None:
        self.assertIn("request_fnc=accept_director_job", inspect.getsource(worker.main))

    def test_preflight_checks_full_voice_provider_configuration(self) -> None:
        missing = check_environment({})
        self.assertFalse(missing.ok)
        self.assertIn("LIVEKIT_URL", missing.missing_required)
        self.assertIn("DATABASE_SERVICE_URL", missing.missing_required)
        self.assertIn("DEEPGRAM_API_KEY", missing.missing_required)
        self.assertIn("CARTESIA_API_KEY", missing.missing_required)

        configured = check_environment(
            {
                "LIVEKIT_URL": "wss://example.livekit.cloud",
                "LIVEKIT_API_KEY": "key",
                "LIVEKIT_API_SECRET": "secret",
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "ANTHROPIC_API_KEY": "anthropic",
            }
        )
        self.assertTrue(configured.ok)
        self.assertEqual(configured.mode["planner_runtime"], "next")
        self.assertEqual(configured.mode["voice_model"], DEFAULT_DIRECTOR_VOICE_MODEL)
        self.assertEqual(configured.mode["cartesia_model"], "sonic-2")
        self.assertEqual(configured.mode["livekit_agent_name"], "otto-director")
        self.assertFalse(configured.mode["vendor_privacy_ack"])
        self.assertFalse(configured.mode["deepgram_no_store_ack"])
        self.assertFalse(configured.mode["cartesia_no_retention_ack"])
        self.assertFalse(configured.mode["anthropic_raw_logging_off_ack"])
        self.assertEqual(
            configured.vendor_controls["livekit_audio_recording_default"],
            "off",
        )
        self.assertEqual(
            configured.vendor_controls["livekit_egress_recording_default"],
            "off",
        )
        self.assertEqual(
            configured.vendor_controls["livekit_data_channel_logging"],
            "not_logged_by_livekit",
        )
        self.assertEqual(
            configured.vendor_controls["deepgram_transport"],
            "livekit_inference",
        )
        self.assertEqual(
            configured.vendor_controls["deepgram_no_store"],
            "livekit_inference_vendor_ack_required",
        )
        self.assertEqual(
            configured.vendor_controls["deepgram_content_retention"],
            "livekit_inference_vendor_ack_required",
        )
        self.assertFalse(configured.vendor_controls["deepgram_no_store_ack"])
        self.assertFalse(configured.vendor_controls["cartesia_no_retention_ack"])
        self.assertFalse(
            configured.vendor_controls["anthropic_raw_logging_off_ack"],
        )
        self.assertEqual(
            configured.vendor_controls["anthropic_raw_payload_logging"],
            "off_by_default",
        )

    def test_strict_preflight_requires_anthropic_for_production_voice(self) -> None:
        strict = check_environment(
            {
                "LIVEKIT_URL": "wss://example.livekit.cloud",
                "LIVEKIT_API_KEY": "key",
                "LIVEKIT_API_SECRET": "secret",
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": "true",
            }
        )

        self.assertFalse(strict.ok)
        self.assertIn("ANTHROPIC_API_KEY", strict.missing_required)
        self.assertIn("OTTO_VENDOR_PRIVACY_ACK", strict.missing_required)
        self.assertIn("OTTO_DEEPGRAM_NO_STORE_ACK", strict.missing_required)
        self.assertIn("OTTO_CARTESIA_NO_RETENTION_ACK", strict.missing_required)
        self.assertIn("OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK", strict.missing_required)
        self.assertTrue(strict.mode["strict"])

        production_ready = check_environment(
            {
                "LIVEKIT_URL": "wss://example.livekit.cloud",
                "LIVEKIT_API_KEY": "key",
                "LIVEKIT_API_SECRET": "secret",
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": "true",
                "OTTO_VENDOR_PRIVACY_ACK": "true",
                "OTTO_DEEPGRAM_NO_STORE_ACK": "true",
                "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
                "ANTHROPIC_API_KEY": "anthropic",
            }
        )
        self.assertTrue(production_ready.ok)
        self.assertTrue(production_ready.mode["vendor_privacy_ack"])
        self.assertTrue(production_ready.mode["deepgram_no_store_ack"])
        self.assertTrue(production_ready.mode["cartesia_no_retention_ack"])
        self.assertTrue(production_ready.mode["anthropic_raw_logging_off_ack"])
        self.assertTrue(production_ready.vendor_controls["vendor_privacy_ack"])
        self.assertTrue(production_ready.vendor_controls["deepgram_no_store_ack"])
        self.assertTrue(production_ready.vendor_controls["cartesia_no_retention_ack"])
        self.assertTrue(
            production_ready.vendor_controls["anthropic_raw_logging_off_ack"],
        )

    def test_strict_preflight_allows_streamed_next_planner_runtime(self) -> None:
        result = check_environment(
            {
                "LIVEKIT_URL": "wss://example.livekit.cloud",
                "LIVEKIT_API_KEY": "key",
                "LIVEKIT_API_SECRET": "secret",
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": "true",
                "OTTO_DIRECTOR_PLANNER_RUNTIME": "next",
                "OTTO_VENDOR_PRIVACY_ACK": "true",
                "OTTO_DEEPGRAM_NO_STORE_ACK": "true",
                "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
                "ANTHROPIC_API_KEY": "anthropic",
            }
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.mode["planner_runtime"], "next")
        self.assertNotIn("OTTO_DIRECTOR_PLANNER_RUNTIME=python", result.missing_required)

    def test_node_production_forces_strict_director_voice_preflight(self) -> None:
        production = check_environment(
            {
                "NODE_ENV": "production",
                "LIVEKIT_URL": "wss://example.livekit.cloud",
                "LIVEKIT_API_KEY": "key",
                "LIVEKIT_API_SECRET": "secret",
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
            }
        )

        self.assertFalse(production.ok)
        self.assertIn("ANTHROPIC_API_KEY", production.missing_required)
        self.assertIn("OTTO_VENDOR_PRIVACY_ACK", production.missing_required)
        self.assertIn("OTTO_DEEPGRAM_NO_STORE_ACK", production.missing_required)
        self.assertIn("OTTO_CARTESIA_NO_RETENTION_ACK", production.missing_required)
        self.assertIn(
            "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK",
            production.missing_required,
        )
        self.assertTrue(production.mode["strict"])

    def test_direct_provider_preflight_reports_request_and_account_privacy_controls(self) -> None:
        result = check_environment(
            {
                "LIVEKIT_URL": "wss://example.livekit.cloud",
                "LIVEKIT_API_KEY": "key",
                "LIVEKIT_API_SECRET": "secret",
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                "DEEPGRAM_API_KEY": "deepgram",
                "CARTESIA_API_KEY": "cartesia",
                "ANTHROPIC_API_KEY": "anthropic",
            }
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.vendor_controls["deepgram_transport"], "direct_plugin")
        self.assertTrue(result.vendor_controls["deepgram_mip_opt_out"])
        self.assertEqual(
            result.vendor_controls["deepgram_content_retention"],
            "mip_opt_out_request_retained_only_for_processing",
        )
        self.assertEqual(
            result.vendor_controls["deepgram_no_store"],
            "covered_by_mip_opt_out_request_flag",
        )
        self.assertEqual(result.vendor_controls["cartesia_transport"], "direct_plugin")
        self.assertEqual(
            result.vendor_controls["cartesia_no_retention"],
            "enterprise_account_level_required",
        )

    def test_verification_preflight_only_requires_evidence_api_access(self) -> None:
        result = check_verification_environment(
            {
                "OTTO_INTERNAL_API_BASE_URL": "https://otto.example.com",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "OTTO_CAPTURE_SESSION_ID": "14125388-f796-4087-ae34-f18ab845e270",
            }
        )

        self.assertTrue(result.ok)
        self.assertTrue(result.mode["verification_only"])

        missing = check_verification_environment({})
        self.assertFalse(missing.ok)
        self.assertIn("OTTO_CAPTURE_SESSION_ID", missing.missing_required)
        self.assertNotIn("DEEPGRAM_API_KEY", missing.missing_required)
        self.assertNotIn("CARTESIA_API_KEY", missing.missing_required)

    def test_turn_smoke_preflight_only_requires_backend_access(self) -> None:
        result = check_smoke_environment(
            {
                "OTTO_INTERNAL_API_BASE_URL": "https://otto.example.com",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "OTTO_CAPTURE_SESSION_ID": "14125388-f796-4087-ae34-f18ab845e270",
            }
        )

        self.assertTrue(result.ok)
        self.assertTrue(result.mode["smoke_only"])
        self.assertEqual(
            result.vendor_controls["audio_transport"],
            "not_required_for_backend_smoke",
        )
        self.assertNotIn("LIVEKIT_URL", result.missing_required)
        self.assertNotIn("DEEPGRAM_API_KEY", result.missing_required)
        self.assertNotIn("CARTESIA_API_KEY", result.missing_required)
        self.assertIn("deterministic fallback planning", result.warnings[0])

        missing = check_smoke_environment({})
        self.assertFalse(missing.ok)
        self.assertIn("OTTO_CAPTURE_SESSION_ID", missing.missing_required)
        self.assertNotIn("LIVEKIT_URL", missing.missing_required)
        self.assertNotIn("DEEPGRAM_API_KEY", missing.missing_required)
        self.assertNotIn("CARTESIA_API_KEY", missing.missing_required)

    def test_worker_config_enforces_strict_privacy_and_anthropic_requirements(self) -> None:
        base_env = {
            "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
            "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
            "LIVEKIT_URL": "wss://otto.livekit.cloud",
            "LIVEKIT_API_KEY": "livekit-key",
            "LIVEKIT_API_SECRET": "livekit-secret",
        }
        with patch.dict(
            os.environ,
            {
                **base_env,
                "NODE_ENV": "production",
                "OTTO_VENDOR_PRIVACY_ACK": "",
                "OTTO_DEEPGRAM_NO_STORE_ACK": "true",
                "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
                "ANTHROPIC_API_KEY": "anthropic",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "OTTO_VENDOR_PRIVACY_ACK"):
                DirectorAgentConfig.from_env()

        with patch.dict(
            os.environ,
            {
                **base_env,
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": "true",
                "OTTO_VENDOR_PRIVACY_ACK": "true",
                "OTTO_DEEPGRAM_NO_STORE_ACK": "",
                "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
                "ANTHROPIC_API_KEY": "anthropic",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "OTTO_DEEPGRAM_NO_STORE_ACK"):
                DirectorAgentConfig.from_env()

        with patch.dict(
            os.environ,
            {
                **base_env,
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": "true",
                "OTTO_VENDOR_PRIVACY_ACK": "true",
                "OTTO_DEEPGRAM_NO_STORE_ACK": "true",
                "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "ANTHROPIC_API_KEY"):
                DirectorAgentConfig.from_env()

        with patch.dict(
            os.environ,
            {
                **base_env,
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": "true",
                "OTTO_VENDOR_PRIVACY_ACK": "true",
                "OTTO_DEEPGRAM_NO_STORE_ACK": "true",
                "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
                "ANTHROPIC_API_KEY": "anthropic",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "DEEPGRAM_API_KEY"):
                DirectorAgentConfig.from_env()

        with patch.dict(
            os.environ,
            {
                **base_env,
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": "true",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "OTTO_DIRECTOR_PLANNER_RUNTIME": " next ",
                "OTTO_DIRECTOR_VOICE_RUNTIME": " steered_cascade ",
                "OTTO_VENDOR_PRIVACY_ACK": "true",
                "OTTO_DEEPGRAM_NO_STORE_ACK": "true",
                "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
                "ANTHROPIC_API_KEY": "anthropic",
            },
            clear=True,
        ):
            config = DirectorAgentConfig.from_env()
            self.assertEqual(config.planner_runtime, "next")
            self.assertEqual(config.voice_runtime, "steered_cascade")

        with patch.dict(
            os.environ,
            {
                **base_env,
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": " yes ",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "OTTO_VENDOR_PRIVACY_ACK": " true ",
                "OTTO_DEEPGRAM_NO_STORE_ACK": " yes ",
                "OTTO_CARTESIA_NO_RETENTION_ACK": " 1 ",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": " true ",
                "ANTHROPIC_API_KEY": "anthropic",
            },
            clear=True,
        ):
            config = DirectorAgentConfig.from_env()

        self.assertTrue(config.strict_preflight)
        self.assertTrue(config.vendor_privacy_ack)
        self.assertTrue(config.deepgram_no_store_ack)
        self.assertTrue(config.cartesia_no_retention_ack)
        self.assertTrue(config.anthropic_raw_logging_off_ack)
        self.assertEqual(config.anthropic_api_key, "anthropic")

    def test_preflight_reports_director_voice_runtime(self) -> None:
        result = check_environment(
            {
                "LIVEKIT_URL": "wss://example.livekit.cloud",
                "LIVEKIT_API_KEY": "key",
                "LIVEKIT_API_SECRET": "secret",
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "OTTO_DIRECTOR_VOICE_RUNTIME": "steered_cascade",
                "ANTHROPIC_API_KEY": "anthropic",
            }
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.mode["voice_runtime"], "steered_cascade")

        fallback = check_environment(
            {
                "LIVEKIT_URL": "wss://example.livekit.cloud",
                "LIVEKIT_API_KEY": "key",
                "LIVEKIT_API_SECRET": "secret",
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "DATABASE_SERVICE_URL": "postgres://service:service@localhost:5432/otto",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "OTTO_DIRECTOR_VOICE_RUNTIME": "surprise_me",
                "ANTHROPIC_API_KEY": "anthropic",
            }
        )

        self.assertEqual(fallback.mode["voice_runtime"], "invalid")

    def test_worker_config_requires_direct_provider_keys_before_room_connect(self) -> None:
        base_env = {
            "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
            "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
            "LIVEKIT_URL": "wss://otto.livekit.cloud",
            "LIVEKIT_API_KEY": "livekit-key",
            "LIVEKIT_API_SECRET": "livekit-secret",
        }
        with patch.dict(os.environ, base_env, clear=True):
            with self.assertRaisesRegex(RuntimeError, "DEEPGRAM_API_KEY"):
                DirectorAgentConfig.from_env()

        with patch.dict(
            os.environ,
            {
                **base_env,
                "DEEPGRAM_API_KEY": "deepgram",
                "CARTESIA_API_KEY": "cartesia",
            },
            clear=True,
        ):
            config = DirectorAgentConfig.from_env()

        self.assertFalse(config.use_livekit_inference)

    def test_worker_config_treats_template_placeholders_as_missing(self) -> None:
        with patch.dict(
            os.environ,
            {
                "OTTO_INTERNAL_API_BASE_URL": "https://your-project.example.com",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "LIVEKIT_URL": "wss://otto.livekit.cloud",
                "LIVEKIT_API_KEY": "livekit-key",
                "LIVEKIT_API_SECRET": "livekit-secret",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "OTTO_INTERNAL_API_BASE_URL"):
                DirectorAgentConfig.from_env()

        with patch.dict(
            os.environ,
            {
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "replace-with-service-token",
                "LIVEKIT_URL": "wss://otto.livekit.cloud",
                "LIVEKIT_API_KEY": "livekit-key",
                "LIVEKIT_API_SECRET": "livekit-secret",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "LIVEKIT_AGENT_SERVICE_TOKEN"):
                DirectorAgentConfig.from_env()

        with patch.dict(
            os.environ,
            {
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "LIVEKIT_URL": "wss://your-project.livekit.cloud",
                "LIVEKIT_API_KEY": "livekit-key",
                "LIVEKIT_API_SECRET": "livekit-secret",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "LIVEKIT_URL"):
                DirectorAgentConfig.from_env()

        with patch.dict(
            os.environ,
            {
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "LIVEKIT_URL": "wss://otto.livekit.cloud",
                "LIVEKIT_API_KEY": "...",
                "LIVEKIT_API_SECRET": "replace-with-livekit-secret",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "LIVEKIT_API_KEY"):
                DirectorAgentConfig.from_env()

        with patch.dict(
            os.environ,
            {
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "LIVEKIT_URL": "wss://otto.livekit.cloud",
                "LIVEKIT_API_KEY": "livekit-key",
                "LIVEKIT_API_SECRET": "livekit-secret",
                "OTTO_DIRECTOR_PREFLIGHT_STRICT": "true",
                "OTTO_USE_LIVEKIT_INFERENCE": "true",
                "OTTO_VENDOR_PRIVACY_ACK": "true",
                "OTTO_DEEPGRAM_NO_STORE_ACK": "true",
                "OTTO_CARTESIA_NO_RETENTION_ACK": "true",
                "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK": "true",
                "ANTHROPIC_API_KEY": "...",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "ANTHROPIC_API_KEY"):
                DirectorAgentConfig.from_env()

    def test_direct_provider_startup_rejects_template_placeholders(self) -> None:
        config = DirectorAgentConfig(
            otto_api_base_url="http://localhost:3000",
            service_token="token",
            capture_session_id=None,
            language="en",
            planner_runtime="python",
            anthropic_api_key=None,
            brain_model="claude-haiku-4-5",
            voice_model="claude-sonnet-4-6",
            deepgram_model="nova-3",
            cartesia_model="sonic-2",
            cartesia_voice_id="voice",
            use_livekit_inference=False,
            livekit_agent_name="otto-director",
        )
        with patch.dict(os.environ, {"DEEPGRAM_API_KEY": "..."}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "DEEPGRAM_API_KEY"):
                stt_provider(config)
        with patch.dict(os.environ, {"CARTESIA_API_KEY": "replace-me"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "CARTESIA_API_KEY"):
                tts_provider(config)

    def test_turn_smoke_exercises_steered_cascade_runtime(self) -> None:
        class FakeApi:
            def __init__(self) -> None:
                self.calls: list[str] = []

            async def ingest_turn(self, **kwargs):
                self.calls.append("ingest")
                return IngestedTurn(
                    latest_utterance=kwargs["utterance"],
                    transcript_segment_ids=["segment-1"],
                    evidence_ids=["evidence-1"],
                    turn_index=4,
                    raw={},
                )

            async def update_delivery(self, **kwargs):
                self.calls.append("delivery")
                assert kwargs["decision_log_id"] == "respond-decision-1"
                assert "ttfa_ms" in kwargs["latency_ms"]
                return {"id": "respond-decision-1"}

            async def check_turn(self, **kwargs):
                self.calls.append("check")
                assert kwargs["spoken_agent_utterance"] == "Which system owns payroll?"
                return {
                    "checker_status": "complete",
                    "checker_violations": [],
                    "checker_violation_count": 0,
                    "stale_question_count": 0,
                    "metadata": {"model": "checker"},
                }

            async def extract_turn(self, **kwargs):
                self.calls.append("extract")
                assert kwargs["turn"].latest_utterance == DEFAULT_SMOKE_UTTERANCE
                return {
                    "decision_log_id": "extract-decision-1",
                    "candidate_process_ids": ["process-1"],
                    "slot_updates": [{"slot_path": "process.inventory"}],
                    "degraded_quality": False,
                }

        class FakePlanner:
            async def respond_turn(self, **kwargs):
                return RespondedTurn(
                    plan={
                        "chosen_intent": {
                            "intent": "capture_systems",
                            "target_slot": "systems.systems_of_record",
                            "score": 100,
                            "reason": "Capture payroll system.",
                        }
                    },
                    planned_agent_utterance="Which system owns payroll?",
                    decision_log_id="respond-decision-1",
                    metadata={"model": "deterministic-steering"},
                    voice_metadata={"model": "voice-model"},
                    steering_context={"target_slots": ["systems.systems_of_record"]},
                    degraded_quality=False,
                    degraded_reasons=[],
                    raw={},
                )

        result = asyncio.run(
            run_turn_smoke(
                config=DirectorAgentConfig(
                    otto_api_base_url="http://localhost:3000",
                    service_token="token",
                    capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                    language="en",
                    planner_runtime="next",
                    anthropic_api_key=None,
                    brain_model="claude-sonnet-4-6",
                    voice_model="claude-sonnet-4-6",
                    deepgram_model="nova-3",
                    cartesia_model="sonic-2",
                    cartesia_voice_id="voice-id",
                    use_livekit_inference=True,
                    livekit_agent_name="otto-director",
                    voice_runtime="steered_cascade",
                ),
                api=FakeApi(),
                planner=FakePlanner(),
                preflight_result=PreflightResult(
                    ok=True,
                    missing_required=[],
                    warnings=[],
                    mode={
                        "planner_runtime": "next",
                        "voice_runtime": "steered_cascade",
                    },
                    vendor_controls={},
                ),
            )
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.decision_log_id, "respond-decision-1")
        self.assertEqual(result.next_prompt, "Which system owns payroll?")
        self.assertEqual(result.candidate_process_ids, ["process-1"])
        self.assertIn("respond_ms", result.latency_ms)
        self.assertIn("extraction_latency_ms", result.latency_ms)
        self.assertTrue(result.latency_budget["backend_pre_tts_ok"])
        self.assertEqual(
            result.preflight["mode"]["voice_runtime"],
            "steered_cascade",
        )

    def test_turn_smoke_rejects_non_uuid_capture_session_id(self) -> None:
        result = check_smoke_environment(
            {
                "OTTO_INTERNAL_API_BASE_URL": "http://localhost:3000",
                "LIVEKIT_AGENT_SERVICE_TOKEN": "token",
                "OTTO_CAPTURE_SESSION_ID": "capture-1",
            },
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.missing_required, ["OTTO_CAPTURE_SESSION_ID"])

    def test_turn_smoke_rejects_template_capture_session_config(self) -> None:
        class FakeApi:
            async def ingest_turn(self, **kwargs):
                raise AssertionError("Smoke must fail before calling the API.")

        with self.assertRaisesRegex(RuntimeError, "OTTO_CAPTURE_SESSION_ID"):
            asyncio.run(
                run_turn_smoke(
                    config=DirectorAgentConfig(
                        otto_api_base_url="http://localhost:3000",
                        service_token="token",
                        capture_session_id="replace-with-capture-session-id",
                        language="en",
                        planner_runtime="python",
                        anthropic_api_key=None,
                        brain_model="claude-haiku-4-5",
                        voice_model="claude-sonnet-4-6",
                        deepgram_model="nova-3",
                        cartesia_model="sonic-2",
                        cartesia_voice_id="voice-id",
                        use_livekit_inference=True,
                        livekit_agent_name="otto-director",
                    ),
                    api=FakeApi(),
                    planner=object(),
                    preflight_result=PreflightResult(
                        ok=True,
                        missing_required=[],
                        warnings=[],
                        mode={
                            "planner_runtime": "python",
                            "use_livekit_inference": True,
                        },
                        vendor_controls={},
                    ),
                )
            )

    def test_opening_prompt_waits_on_livekit_speech_handle(self) -> None:
        source = inspect.getsource(DirectorConsultantAgent.on_enter)
        self.assertIn("if not self._should_say_opening", source)
        self.assertIn("resumed_existing_session", source)
        self.assertIn("speech = self.session.say", source)
        self.assertIn("self._active_speech = speech", source)
        self.assertIn("OPENING_PROMPT", source)
        self.assertIn("record_opening(", source)
        self.assertIn('"director.opening"', source)
        self.assertIn('"stage_name": "director.opening"', source)
        self.assertIn("update_delivery(", source)
        self.assertIn("_publish_delivery_update(", source)
        self.assertIn("await speech.wait_for_playout()", source)
        self.assertIn('"director.session.notice"', source)
        self.assertIn("failed_opening_audio", source)
        self.assertIn("failed_opening_persistence", source)
        self.assertIn("outcomes, people, systems, cadence, metrics, and friction", OPENING_PROMPT)

    def test_opening_prompt_is_not_spoken_when_persistence_fails(self) -> None:
        class FakeSession:
            def __init__(self) -> None:
                self.say_calls = []

            def say(self, text, *, allow_interruptions):
                self.say_calls.append((text, allow_interruptions))
                raise AssertionError("opening should not be spoken before persistence")

        class FakeParticipant:
            def __init__(self) -> None:
                self.calls = []

            async def publish_data(self, payload, *, reliable, topic):
                self.calls.append((payload, reliable, topic))

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = FakeParticipant()

            def on(self, event, handler):
                return None

        class FakeApi:
            async def record_opening(self, **kwargs):
                raise RuntimeError("db unavailable")

        async def run_case() -> tuple[FakeSession, FakeRoom]:
            room = FakeRoom()
            session = FakeSession()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=FakeApi(),
                planner=object(),
                room=room,
            )
            agent._activity = SimpleNamespace(session=session)
            await agent.on_enter()
            return session, room

        with self.assertLogs("director_agent.agent", level="WARNING") as logs:
            session, room = asyncio.run(run_case())
        decoded = json.loads(room.local_participant.calls[0][0].decode("utf-8"))

        self.assertIn("Failed to persist director opening prompt", logs.output[0])
        self.assertEqual(session.say_calls, [])
        self.assertEqual(decoded["event"], "director.session.notice")
        self.assertEqual(decoded["payload"]["notice_type"], "failed_opening_persistence")
        self.assertEqual(decoded["payload"]["agent_utterance"], OPENING_PROMPT)

    def test_worker_startup_recovers_stale_pending_deliveries(self) -> None:
        class FakeApi:
            def __init__(self) -> None:
                self.delivery_calls = []

            async def update_delivery(self, **kwargs):
                self.delivery_calls.append(kwargs)
                return {
                    "delivery": {
                        "id": kwargs["decision_log_id"],
                        "deliveryJson": {
                            "delivery_status": kwargs["delivery_status"],
                        },
                    }
                }

        class FakeParticipant:
            def __init__(self) -> None:
                self.calls = []

            async def publish_data(self, payload, *, reliable, topic):
                self.calls.append((payload, reliable, topic))

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = FakeParticipant()

            def on(self, event, handler):
                return None

        async def run_case() -> tuple[FakeApi, FakeRoom]:
            api = FakeApi()
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=api,
                planner=object(),
                room=room,
                should_say_opening=False,
                stale_pending_delivery_decisions=[
                    {
                        "decision_log_id": "11111111-1111-5111-8111-111111111111",
                        "turn_index": 7,
                        "stage_name": "director.turn",
                        "planned_utterance": "Let's map quote approvals.",
                    }
                ],
            )
            await agent.on_enter()
            return api, room

        api, room = asyncio.run(run_case())

        self.assertEqual(len(api.delivery_calls), 1)
        delivery = api.delivery_calls[0]
        self.assertEqual(delivery["delivery_status"], "failed_text_fallback")
        self.assertEqual(delivery["spoken_fraction"], 0)
        self.assertEqual(delivery["turn_index"], 7)
        self.assertEqual(delivery["delivered_utterance"], "Let's map quote approvals.")
        self.assertTrue(delivery["idempotency_key"].startswith("delivery:"))
        decoded_events = [
            json.loads(call[0].decode("utf-8"))
            for call in room.local_participant.calls
        ]
        delivery_event = next(
            event
            for event in decoded_events
            if event["event"] == "director.turn.delivery_updated"
        )
        self.assertEqual(
            delivery_event["payload"]["delivery_status"],
            "failed_text_fallback",
        )
        self.assertEqual(
            delivery_event["payload"]["agent_utterance"],
            "Let's map quote approvals.",
        )
        self.assertEqual(delivery_event["payload"]["spoken_fraction"], 0)

    def test_muted_agent_ignores_finalized_user_turns(self) -> None:
        class FakeApi:
            async def ingest_turn(self, **kwargs):
                raise AssertionError("muted sessions should not ingest finalized ASR")

        class FakeRoom:
            local_participant = None

            def on(self, event, handler):
                return None

        async def run_case() -> None:
            from livekit.agents import ChatContext, StopResponse

            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=FakeApi(),
                planner=object(),
                room=FakeRoom(),
            )
            agent._muted = True
            message = ChatMessage(role="user", content=["This arrived after mute."])
            with self.assertRaises(StopResponse):
                await agent.on_user_turn_completed(ChatContext.empty(), message)

        asyncio.run(run_case())

    def test_worker_allows_indefinite_user_silence(self) -> None:
        source = inspect.getsource(worker.entrypoint)

        self.assertIn("turn_handling=TurnHandlingOptions(", source)
        self.assertIn("turn_detection = None", source)
        self.assertIn("turn_detection=turn_detection", source)
        self.assertIn('"mode": endpointing_mode(config.endpointing_mode)', source)
        self.assertIn('"min_delay": config.endpointing_min_delay', source)
        self.assertIn('"max_delay": config.endpointing_max_delay', source)
        self.assertIn('"mode": interruption_mode(config.interruption_mode)', source)
        self.assertIn('"min_duration": config.interruption_min_duration', source)
        self.assertNotIn("user_turn_limit", source)
        self.assertIn("user_away_timeout=None", source)

    def test_transcript_timing_prefers_livekit_asr_metrics(self) -> None:
        message = ChatMessage(
            role="user",
            content=["Forecasting is weekly."],
            transcript_confidence=0.91,
        )
        message.metrics = {
            "started_speaking_at": 1_000.25,
            "stopped_speaking_at": 1_003.75,
            "transcription_delay": 0.18,
            "end_of_turn_delay": 0.22,
            "stt_metadata": {"provider": "deepgram", "model": "nova-3"},
        }

        timing = transcript_timing_from_message(
            message,
            "Forecasting is weekly.",
            7,
            config=SimpleNamespace(
                deepgram_model="nova-3",
                language="auto",
                use_livekit_inference=True,
                vendor_privacy_ack=True,
                deepgram_no_store_ack=True,
            ),
        )

        self.assertEqual(timing.start_ms, 1_000_250)
        self.assertEqual(timing.end_ms, 1_003_750)
        self.assertEqual(timing.confidence, 0.91)
        self.assertEqual(timing.source, "asr_metrics")
        self.assertEqual(timing.idempotency_parts, (1_000_250, 1_003_750))
        self.assertEqual(timing.metadata["source"], "livekit_agents")
        self.assertEqual(timing.metadata["provider"], "deepgram")
        self.assertEqual(timing.metadata["model"], "nova-3")
        self.assertEqual(timing.metadata["language"], "multi")
        self.assertEqual(timing.metadata["transport"], "livekit_inference")
        self.assertEqual(timing.metadata["mip_opt_out"], "managed_by_livekit_inference")
        self.assertTrue(timing.metadata["vendor_privacy_ack"])
        self.assertTrue(timing.metadata["privacy_no_store_ack"])
        self.assertEqual(timing.metadata["timing"], "started_stopped_speaking_at")
        self.assertEqual(timing.metadata["metrics"]["transcription_delay"], 0.18)
        self.assertEqual(timing.metadata["metrics"]["end_of_turn_delay"], 0.22)
        self.assertEqual(
            timing.metadata["metrics"]["stt_metadata"],
            {"provider": "deepgram", "model": "nova-3"},
        )

    def test_transcript_timing_accepts_attribute_style_asr_metrics(self) -> None:
        message = ChatMessage(
            role="user",
            content=["Forecasting is weekly."],
            transcript_confidence=0.91,
        )
        message.metrics = SimpleNamespace(
            started_speaking_at=datetime.fromtimestamp(1_000.25, timezone.utc),
            stopped_speaking_at=datetime.fromtimestamp(1_003.75, timezone.utc),
        )

        timing = transcript_timing_from_message(message, "Forecasting is weekly.", 7)

        self.assertEqual(timing.start_ms, 1_000_250)
        self.assertEqual(timing.end_ms, 1_003_750)
        self.assertEqual(timing.source, "asr_metrics")
        self.assertEqual(timing.metadata["provider"], "deepgram")
        self.assertEqual(
            timing.metadata["metrics"]["started_speaking_at"],
            1_000.25,
        )

    def test_ingest_idempotency_key_is_stable_for_segment_timing(self) -> None:
        first = ChatMessage(role="user", content=["forecasting is weekly"])
        first.metrics = {
            "started_speaking_at": 10.0,
            "stopped_speaking_at": 12.0,
        }
        second = ChatMessage(role="user", content=["Forecasting is weekly."])
        second.metrics = {
            "started_speaking_at": 10.0,
            "stopped_speaking_at": 12.0,
        }

        first_timing = transcript_timing_from_message(first, "forecasting is weekly", 1)
        second_timing = transcript_timing_from_message(second, "Forecasting is weekly.", 1)

        self.assertEqual(
            ingest_idempotency_key("14125388-f796-4087-ae34-f18ab845e270", first_timing),
            ingest_idempotency_key("14125388-f796-4087-ae34-f18ab845e270", second_timing),
        )
        self.assertNotIn(
            "Forecasting",
            ingest_idempotency_key("14125388-f796-4087-ae34-f18ab845e270", first_timing),
        )

    def test_transcript_timing_falls_back_to_monotonic_ordinal(self) -> None:
        message = ChatMessage(
            role="user",
            content=["hello"],
            transcript_confidence=None,
            created_at=2_000.0,
        )

        timing = transcript_timing_from_message(message, "hello", 4)

        self.assertEqual(timing.source, "created_at_estimate")
        self.assertEqual(timing.end_ms, 2_000_000)
        self.assertEqual(timing.start_ms, 1_999_000)
        self.assertEqual(timing.idempotency_parts, (4, 1_999_000, 2_000_000))
        self.assertEqual(timing.metadata["model"], "nova-3")
        self.assertEqual(timing.metadata["language"], "en")
        self.assertEqual(timing.metadata["transport"], "direct_plugin")
        self.assertEqual(timing.metadata["created_at"], 2_000.0)
        self.assertEqual(timing.metadata["estimated_duration_ms"], 1000)

    def test_transcript_timing_normalizes_epoch_milliseconds_for_storage(self) -> None:
        message = ChatMessage(
            role="user",
            content=["hello"],
            transcript_confidence=None,
            created_at=1_779_806_930.256,
        )

        timing = transcript_timing_from_message(message, "hello", 4)

        self.assertEqual(timing.source, "created_at_estimate")
        self.assertEqual(timing.start_ms, 240_000)
        self.assertEqual(timing.end_ms, 241_000)
        self.assertEqual(
            timing.idempotency_parts,
            (4, 1_779_806_929_256, 1_779_806_930_256),
        )
        self.assertTrue(timing.metadata["timing_normalized"])
        self.assertEqual(timing.metadata["raw_end_ms"], 1_779_806_930_256)

    def test_transcript_timing_normalizes_epoch_asr_metrics_for_storage(self) -> None:
        message = ChatMessage(role="user", content=["Forecasting is weekly."])
        message.metrics = {
            "started_speaking_at": 1_779_806_930.25,
            "stopped_speaking_at": 1_779_806_933.75,
        }

        timing = transcript_timing_from_message(message, "Forecasting is weekly.", 7)

        self.assertEqual(timing.source, "asr_metrics")
        self.assertEqual(timing.start_ms, 420_000)
        self.assertEqual(timing.end_ms, 423_500)
        self.assertEqual(
            timing.idempotency_parts,
            (1_779_806_930_250, 1_779_806_933_750),
        )
        self.assertTrue(timing.metadata["timing_normalized"])
        self.assertEqual(timing.metadata["raw_start_ms"], 1_779_806_930_250)

    def test_voice_context_is_compact_for_realtime_phrase_call(self) -> None:
        context = {
            "current_phase": "expand",
            "focus_candidate_process_id": "candidate-1",
            "prior_intent": "capture_systems",
            "low_info_turn_count": 1,
            "recent_turns": [f"turn {i}" for i in range(10)],
            "slots": [
                {
                    "slot_path": f"slot.{i}",
                    "status": "filled",
                    "value": {"large": "value", "i": i},
                    "confidence": 0.8,
                    "evidence_ids": ["evidence"],
                    "candidates": ["extra"],
                }
                for i in range(20)
            ],
            "candidate_processes": [
                {
                    "id": f"candidate-{i}",
                    "proposed_name": f"Process {i}",
                    "proposed_function": "Rev Ops",
                    "frequency": "weekly",
                    "complexity_hint": "medium",
                    "confidence": 0.8,
                }
                for i in range(12)
            ],
            "probe_firings": [{"probe_id": "omit-me"}],
            "stale_pending_delivery_decisions": [{"decision_log_id": "omit-me"}],
        }

        compact = compact_voice_context(context)

        self.assertEqual(compact["recent_turns"], ["turn 6", "turn 7", "turn 8", "turn 9"])
        self.assertEqual(len(compact["slots"]), 16)
        self.assertEqual(len(compact["candidate_processes"]), 8)
        self.assertNotIn("probe_firings", compact)
        self.assertNotIn("stale_pending_delivery_decisions", compact)
        self.assertNotIn("evidence_ids", compact["slots"][0])
        self.assertNotIn("proposed_function", compact["candidate_processes"][0])

    def test_voice_plan_omits_dispatch_payload_for_realtime_phrase_call(self) -> None:
        plan = {
            "utterance_type": "substantive_answer",
            "current_phase": "expand",
            "proposed_next_phase": "enrich",
            "phase_transition_ready": True,
            "chosen_intent": {
                "intent": "capture_metrics",
                "target_slot": "metrics.kpis",
                "score": 88,
                "reason": "Metrics are missing.",
                "style_hint": "Ask for a recent dashboard.",
            },
            "focus_candidate_process_id": "candidate-1",
            "ranked_intents": [
                {
                    "intent": f"intent-{i}",
                    "target_slot": f"slot-{i}",
                    "score": 100 - i,
                    "reason": f"reason-{i}",
                    "style_hint": f"style-{i}",
                }
                for i in range(5)
            ],
            "slot_updates": [
                {
                    "slot_path": f"slot.{i}",
                    "status": "filled",
                    "confidence": 0.8,
                    "value": {"i": i},
                    "evidence_ids": ["evidence"],
                }
                for i in range(12)
            ],
            "claims": [
                {
                    "subject_type": "candidate_process",
                    "field": f"field_{i}",
                    "value": {"verbose": "payload"},
                    "confidence": 0.7,
                    "evidence_ids": ["evidence"],
                }
                for i in range(8)
            ],
            "tool_calls": [{"name": "recordProcess", "arguments": {"large": "payload"}}],
            "contradiction_signals": ["a", "b", "c", "d"],
        }

        compact = compact_voice_plan(plan)

        self.assertEqual(compact["chosen_intent"]["intent"], "capture_metrics")
        self.assertEqual(len(compact["ranked_intents"]), 3)
        self.assertEqual(len(compact["slot_updates"]), 8)
        self.assertEqual(len(compact["claim_fields"]), 6)
        self.assertEqual(compact["contradiction_signals"], ["a", "b", "c"])
        self.assertNotIn("tool_calls", compact)
        self.assertNotIn("claims", compact)
        self.assertNotIn("evidence_ids", compact["slot_updates"][0])
        self.assertNotIn("value", compact["claim_fields"][0])

    def test_data_channel_publish_uses_joined_room(self) -> None:
        class FakeParticipant:
            def __init__(self) -> None:
                self.calls = []

            async def publish_data(self, payload, *, reliable, topic):
                self.calls.append((payload, reliable, topic))

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = FakeParticipant()

            def on(self, event, handler):
                return None

        room = FakeRoom()
        agent = DirectorConsultantAgent(
            capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
            api=object(),
            planner=object(),
            room=room,
        )

        published = asyncio.run(
            agent._publish_data("director.turn.dispatched", {"turn_index": 1})
        )

        self.assertTrue(published)
        self.assertEqual(len(room.local_participant.calls), 1)
        payload, reliable, topic = room.local_participant.calls[0]
        self.assertTrue(reliable)
        self.assertEqual(topic, "otto.director")
        decoded = json.loads(payload.decode("utf-8"))
        self.assertEqual(decoded["source"], "otto_director_agent")
        self.assertEqual(
            decoded["capture_session_id"],
            "14125388-f796-4087-ae34-f18ab845e270",
        )
        self.assertEqual(decoded["event"], "director.turn.dispatched")
        self.assertEqual(decoded["payload"]["turn_index"], 1)

    def test_real_turn_dispatch_payload_carries_stage_name_for_browser_dedupe(self) -> None:
        source = inspect.getsource(DirectorConsultantAgent._run_decoupled_user_turn)
        dispatch_start = source.index('"director.turn.dispatched"')
        dispatch_end = source.index("await self._publish_turn_telemetry", dispatch_start)
        dispatch_block = source[dispatch_start:dispatch_end]
        self.assertIn('"stage_name": "director.turn"', dispatch_block)
        self.assertIn('"coverage_slots"', dispatch_block)
        self.assertIn("audio_metadata=self._tts_audio_metadata", source)

    def test_data_channel_publish_failure_does_not_break_turn_contract(self) -> None:
        class FakeParticipant:
            async def publish_data(self, payload, *, reliable, topic):
                raise RuntimeError("room data channel unavailable")

        class FakeRoom:
            local_participant = FakeParticipant()

            def on(self, event, handler):
                return None

        agent = DirectorConsultantAgent(
            capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
            api=object(),
            planner=object(),
            room=FakeRoom(),
        )

        with self.assertLogs("director_agent.agent", level="WARNING") as logs:
            published = asyncio.run(
                agent._publish_data("director.turn.dispatched", {"turn_index": 1})
            )

        self.assertFalse(published)
        self.assertIn("Failed to publish LiveKit data event", logs.output[0])

    def test_tts_failure_degrades_to_text_fallback_without_reraising(self) -> None:
        source = inspect.getsource(DirectorConsultantAgent._run_decoupled_user_turn)
        self.assertIn('delivery_status="failed_text_fallback"', source)
        self.assertIn("delivered_utterance=spoken_utterance", source)
        self.assertIn("latency_ms=failed_latency", source)
        self.assertIn("delivery_idempotency_key(", source)
        self.assertIn("_mark_delivery_interrupted_after_tts", source)
        self.assertIn("_publish_delivery_update", source)
        self.assertIn("return", source)

    def test_delivery_idempotency_key_is_stable_across_terminal_statuses(self) -> None:
        session_id = "14125388-f796-4087-ae34-f18ab845e270"
        completed = delivery_idempotency_key(session_id, 4)
        truncated = delivery_idempotency_key(session_id, 4)

        self.assertEqual(completed, truncated)
        self.assertEqual(completed, stable_key("delivery", session_id, "director.turn", 4))
        self.assertNotEqual(
            completed,
            delivery_idempotency_key(session_id, 4, "director.opening"),
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
                self.extract_started = asyncio.Event()
                self.extract_done = asyncio.Event()
                self.check_started = asyncio.Event()
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
                    turn_index=3,
                    raw={},
                )

            async def extract_turn(self, **kwargs):
                self.calls.append("extract")
                self.extract_payloads.append(kwargs)
                self.extract_started.set()
                await self.release_extract.wait()
                self.extract_done.set()
                return {
                    "decision_log_id": "extract-decision-1",
                    "extraction_status": "complete",
                    "extraction_latency_ms": 12,
                    "slot_updates": [],
                    "coverage_slots": [],
                    "degraded_quality": False,
                    "degraded_reasons": [],
                }

            async def check_turn(self, **kwargs):
                self.calls.append("check")
                self.check_payloads.append(kwargs)
                self.check_started.set()
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
                return {
                    "id": kwargs["decision_log_id"],
                    "deliveryJson": {"delivery_status": kwargs["delivery_status"]},
                }

        class FakePlanner:
            config = SimpleNamespace(voice_runtime="steered_cascade")

            async def respond_turn(self, **kwargs):
                callback = kwargs.get("on_planned_agent_utterance")
                if callback:
                    callback("Got it. What system owns payroll?")
                return RespondedTurn(
                    plan={
                        "chosen_intent": {
                            "intent": "capture_systems",
                            "target_slot": "systems.systems_of_record",
                            "score": 100,
                            "reason": "Payroll has been mentioned; capture the system of record.",
                        }
                    },
                    planned_agent_utterance="Got it. What system owns payroll?",
                    decision_log_id="respond-decision-1",
                    metadata={"model": "deterministic-steering"},
                    voice_metadata={"model": "voice-model"},
                    steering_context={
                        "target_slots": ["systems.systems_of_record"],
                        "do_not_ask": [],
                    },
                    degraded_quality=False,
                    degraded_reasons=[],
                    raw={
                        "extraction_status": "pending",
                        "local_turn_correlation_id": kwargs.get(
                            "local_turn_correlation_id",
                        ),
                    },
                    local_turn_correlation_id=kwargs.get("local_turn_correlation_id"),
                )

        class FakeSpeech:
            interrupted = False

            async def wait_for_playout(self):
                return None

        class FakeSession:
            def __init__(self) -> None:
                self.spoken: list[str] = []

            def say(self, text, *, allow_interruptions):
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
                return None

        async def run_case():
            release_extract = asyncio.Event()
            release_check = asyncio.Event()
            api = FakeApi(release_extract, release_check)
            session = FakeSession()
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=api,
                planner=FakePlanner(),
                room=room,
            )
            agent._activity = SimpleNamespace(session=session)
            message = ChatMessage(
                role="user",
                content=["I own finance and payroll."],
            )
            with patch("director_agent.agent.EXTRACTION_WINDOW_DEBOUNCE_SECONDS", 0.01):
                with self.assertRaises(StopResponse):
                    await agent.on_user_turn_completed(ChatContext.empty(), message)

                self.assertEqual(session.spoken, ["Got it. What system owns payroll?"])
                self.assertIn("delivery", api.calls)
                self.assertFalse(api.extract_done.is_set())
                self.assertFalse(api.check_done.is_set())
                release_check.set()
                release_extract.set()
                await asyncio.wait_for(api.check_done.wait(), timeout=1)
                await asyncio.wait_for(api.extract_done.wait(), timeout=1)
            return api, room

        from livekit.agents import ChatContext, StopResponse

        api, room = asyncio.run(run_case())
        self.assertIn("check", api.calls)
        self.assertIn("extract", api.calls)
        self.assertEqual(api.delivery_payloads[0]["decision_log_id"], "respond-decision-1")
        self.assertEqual(
            api.extract_payloads[0]["turn"].latest_utterance,
            "I own finance and payroll.",
        )
        self.assertEqual(
            api.check_payloads[0]["steering_context"]["target_slots"],
            ["systems.systems_of_record"],
        )
        event_names = [event["event"] for event in room.local_participant.events]
        self.assertIn("director.turn.dispatched", event_names)
        self.assertIn("director.turn.output_checked", event_names)
        self.assertIn("director.turn.extracted", event_names)

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

            async def extract_turn(self, **kwargs):
                self.extract_payloads.append(kwargs)
                self.extract_started.set()
                await self.release_extract.wait()
                self.extract_done.set()
                return {
                    "decision_log_id": "extract-window-1",
                    "extraction_status": "complete",
                    "extraction_latency_ms": 8,
                    "slot_updates": [],
                    "coverage_slots": [],
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
                return {
                    "id": kwargs["decision_log_id"],
                    "deliveryJson": {"delivery_status": kwargs["delivery_status"]},
                }

        class FakePlanner:
            config = SimpleNamespace(voice_runtime="steered_cascade")

            async def respond_turn(self, **kwargs):
                callback = kwargs.get("on_planned_agent_utterance")
                utterance = f"Fast response {kwargs['turn'].turn_index}?"
                if callback:
                    callback(utterance)
                return RespondedTurn(
                    plan={
                        "chosen_intent": {
                            "intent": "discover_processes",
                            "target_slot": "process.inventory",
                            "score": 100,
                            "reason": "Capture process inventory.",
                        }
                    },
                    planned_agent_utterance=utterance,
                    decision_log_id=f"respond-{kwargs['turn'].turn_index}",
                    metadata={"model": "deterministic-steering"},
                    voice_metadata={"model": "voice-model"},
                    steering_context={"target_slots": ["process.inventory"]},
                    degraded_quality=False,
                    degraded_reasons=[],
                    raw={"extraction_status": "pending"},
                    local_turn_correlation_id=kwargs.get("local_turn_correlation_id"),
                )

        class FakeSpeech:
            interrupted = False

            async def wait_for_playout(self):
                return None

        class FakeSession:
            def __init__(self) -> None:
                self.spoken: list[str] = []

            def say(self, text, *, allow_interruptions):
                self.spoken.append(text)
                return FakeSpeech()

        class FakeParticipant:
            async def publish_data(self, payload, *, reliable, topic):
                return None

        class FakeRoom:
            local_participant = FakeParticipant()

            def on(self, event, handler):
                return None

        async def run_case():
            release_extract = asyncio.Event()
            api = FakeApi(release_extract)
            session = FakeSession()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=api,
                planner=FakePlanner(),
                room=FakeRoom(),
            )
            agent._activity = SimpleNamespace(session=session)
            with patch("director_agent.agent.EXTRACTION_WINDOW_DEBOUNCE_SECONDS", 0.05):
                for text in [
                    "We handle payroll management,",
                    "cost optimization and closing books.",
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

        from livekit.agents import ChatContext, StopResponse

        api, session = asyncio.run(run_case())
        self.assertEqual(session.spoken, ["Fast response 1?", "Fast response 2?"])
        extracted_turn = api.extract_payloads[0]["turn"]
        self.assertEqual(
            extracted_turn.latest_utterance,
            "We handle payroll management, cost optimization and closing books.",
        )
        self.assertEqual(
            extracted_turn.transcript_segment_ids,
            ["segment-1", "segment-2"],
        )
        self.assertEqual(
            extracted_turn.raw["window_turn_indexes"],
            [1, 2],
        )

    def test_barge_in_path_has_no_prior_delivery_timeout_serializer(self) -> None:
        source = inspect.getsource(DirectorConsultantAgent)

        self.assertNotIn("_interrupt_and_wait_for_prior_delivery", source)
        self.assertNotIn("prior_delivery_timeout", source)
        self.assertIn("_supersede_active_turn", source)

    def test_delivery_update_data_channel_includes_terminal_statuses(self) -> None:
        class FakeParticipant:
            def __init__(self) -> None:
                self.calls = []

            async def publish_data(self, payload, *, reliable, topic):
                self.calls.append((payload, reliable, topic))

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = FakeParticipant()

            def on(self, event, handler):
                return None

        async def run_case() -> None:
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=object(),
                planner=object(),
                room=room,
            )
            await agent._publish_delivery_update(
                turn_index=4,
                decision_log_id="decision-1",
                delivery_status="truncated",
                agent_utterance="Let's zoom into quote approvals.",
                spoken_fraction=0.5,
                latency_ms={"tts_playout_ms": 400, "turn_total_ms": 1200},
            )

            payload, reliable, topic = room.local_participant.calls[0]
            decoded = json.loads(payload.decode("utf-8"))
            self.assertTrue(reliable)
            self.assertEqual(topic, "otto.director")
            self.assertEqual(decoded["event"], "director.turn.delivery_updated")
            self.assertEqual(decoded["payload"]["turn_index"], 4)
            self.assertEqual(decoded["payload"]["stage_name"], "director.turn")
            self.assertEqual(decoded["payload"]["decision_log_id"], "decision-1")
            self.assertEqual(decoded["payload"]["delivery_status"], "truncated")
            self.assertEqual(decoded["payload"]["spoken_fraction"], 0.5)
            self.assertEqual(decoded["payload"]["latency_ms"]["tts_playout_ms"], 400)
            self.assertEqual(
                decoded["payload"]["agent_utterance"],
                "Let's zoom into quote approvals.",
            )

        asyncio.run(run_case())

    def test_pause_after_dispatch_marks_delivery_terminal_without_tts(self) -> None:
        class FakeApi:
            def __init__(self) -> None:
                self.delivery_calls = []

            async def update_delivery(self, **kwargs):
                self.delivery_calls.append(kwargs)
                return {"id": "decision-1", "deliveryJson": {"delivery_status": "truncated"}}

        class FakeParticipant:
            def __init__(self) -> None:
                self.calls = []

            async def publish_data(self, payload, *, reliable, topic):
                self.calls.append((payload, reliable, topic))

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = FakeParticipant()

            def on(self, event, handler):
                return None

        async def run_case() -> tuple[FakeApi, FakeRoom]:
            api = FakeApi()
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=api,
                planner=object(),
                room=room,
            )
            now = time.perf_counter()
            await agent._mark_delivery_not_spoken(
                turn_index=5,
                decision_log_id="decision-1",
                turn_started=now - 1,
                dispatched_at=now,
            )
            return api, room

        api, room = asyncio.run(run_case())

        self.assertEqual(len(api.delivery_calls), 1)
        delivery = api.delivery_calls[0]
        self.assertEqual(delivery["delivery_status"], "truncated")
        self.assertEqual(delivery["delivered_utterance"], "")
        self.assertEqual(delivery["spoken_fraction"], 0)
        self.assertEqual(delivery["latency_ms"]["tts_playout_ms"], 0)
        self.assertNotIn("audio_metadata", delivery)
        self.assertNotIn("audio_metadata", delivery)
        decoded = json.loads(room.local_participant.calls[0][0].decode("utf-8"))
        self.assertEqual(decoded["event"], "director.turn.delivery_updated")
        self.assertEqual(decoded["payload"]["stage_name"], "director.turn")
        self.assertEqual(decoded["payload"]["agent_utterance"], "")
        self.assertEqual(decoded["payload"]["spoken_fraction"], 0)

    def test_truncated_delivery_keeps_full_text_for_transcript_display(self) -> None:
        utterance = "Let's zoom into quote approvals and start with where finance signs off."

        delivered = delivered_utterance_for_status(
            utterance,
            delivery_status="truncated",
            spoken_fraction=0.5,
        )

        self.assertEqual(delivered, utterance)
        self.assertEqual(
            delivered_utterance_for_status(
                utterance,
                delivery_status="completed",
                spoken_fraction=1,
            ),
            utterance,
        )
        self.assertEqual(
            delivered_utterance_for_status(
                utterance,
                delivery_status="truncated",
                spoken_fraction=0,
            ),
            "",
        )

    def test_interrupted_delivery_estimates_spoken_fraction_from_playout_time(self) -> None:
        utterance = "Let's zoom into quote approvals and start with where finance signs off."

        early = estimated_spoken_fraction(utterance, 100.0, 100.2)
        mid = estimated_spoken_fraction(utterance, 100.0, 102.0)
        late = estimated_spoken_fraction(utterance, 100.0, 110.0)

        self.assertGreater(mid, early)
        self.assertGreater(late, mid)
        self.assertGreaterEqual(early, 0.05)
        self.assertLessEqual(late, 0.95)

    def test_turn_telemetry_is_published_before_tts(self) -> None:
        source = inspect.getsource(DirectorConsultantAgent._run_decoupled_user_turn)
        wrapper_source = inspect.getsource(DirectorConsultantAgent._run_user_turn_completed)
        self.assertIn('"director.turn.ingested"', wrapper_source)
        self.assertLess(
            wrapper_source.index('"director.turn.ingested"'),
            wrapper_source.index("_run_decoupled_user_turn"),
        )
        self.assertIn("_publish_turn_telemetry", source)
        self.assertIn("speech_pre_tts_total_ms\": elapsed_ms(turn_started, speech_started_at)", source)
        telemetry_source = inspect.getsource(DirectorConsultantAgent._publish_turn_telemetry)
        self.assertIn('"director.turn.telemetry"', telemetry_source)
        self.assertIn('"speech_pre_tts_total_ms"', source)
        self.assertIn('"asr_timing_source"', telemetry_source)

    def test_data_channel_controls_pause_resume_and_end_agent(self) -> None:
        class FakeApi:
            def __init__(self) -> None:
                self.completed: list[dict] = []

            async def complete_session(self, **kwargs):
                self.completed.append(kwargs)
                return {"capture_session": {"id": kwargs["capture_session_id"]}}

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

        class FakePacket:
            topic = "otto.director.control"

            def __init__(
                self,
                action: str,
                *,
                participant_identity: str | None = "director-user",
                source: str = "otto_browser_client",
                capture_session_id: str = "14125388-f796-4087-ae34-f18ab845e270",
            ) -> None:
                self.participant = (
                    None
                    if participant_identity is None
                    else SimpleNamespace(identity=participant_identity)
                )
                self.data = json.dumps(
                    {
                        "source": source,
                        "capture_session_id": capture_session_id,
                        "event": "director.control",
                        "payload": {"action": action},
                    }
                ).encode("utf-8")

        async def run_case() -> None:
            room = FakeRoom()
            api = FakeApi()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=api,
                planner=object(),
                room=room,
                expected_control_participant_identity="director-user",
            )
            speech = FakeSpeech()
            agent._active_speech = speech
            room.handlers["data_received"](FakePacket("mute"))
            self.assertTrue(agent._muted)
            fake_ui_packet = FakePacket("pause")
            fake_ui_packet.topic = "otto.director"
            room.handlers["data_received"](fake_ui_packet)
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
            room.handlers["data_received"](FakePacket("unmute"))
            self.assertFalse(agent._muted)
            room.handlers["data_received"](FakePacket("pause"))
            self.assertTrue(agent._paused)
            self.assertEqual(speech.interrupt_calls, [True])
            room.handlers["data_received"](FakePacket("resume"))
            self.assertFalse(agent._paused)
            agent._active_speech = speech
            with patch("director_agent.agent.COMPLETION_DISCONNECT_GRACE_SECONDS", 0):
                room.handlers["data_received"](FakePacket("end"))
                await asyncio.sleep(0)
                await asyncio.sleep(0)
            self.assertTrue(agent._ended)
            self.assertTrue(room.disconnect_called)
            self.assertEqual(len(api.completed), 1)
            self.assertEqual(
                api.completed[0]["capture_session_id"],
                "14125388-f796-4087-ae34-f18ab845e270",
            )
            self.assertTrue(api.completed[0]["idempotency_key"].startswith("complete:"))
            self.assertEqual(speech.interrupt_calls, [True, True])

        asyncio.run(run_case())

    def test_data_channel_controls_require_expected_participant_identity(self) -> None:
        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = None
                self.handlers = {}

            def on(self, event, handler):
                self.handlers[event] = handler

        class FakeParticipant:
            def __init__(self, identity: str) -> None:
                self.identity = identity

        class FakePacket:
            topic = "otto.director.control"

            def __init__(self, participant_identity: str | None) -> None:
                self.participant = (
                    None
                    if participant_identity is None
                    else FakeParticipant(participant_identity)
                )
                self.data = json.dumps(
                    {
                        "source": "otto_browser_client",
                        "capture_session_id": "14125388-f796-4087-ae34-f18ab845e270",
                        "event": "director.control",
                        "payload": {"action": "pause"},
                    }
                ).encode("utf-8")

        async def run_case() -> DirectorConsultantAgent:
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=object(),
                planner=object(),
                room=room,
                expected_control_participant_identity="director-user",
            )

            room.handlers["data_received"](FakePacket(None))
            self.assertFalse(agent._paused)
            room.handlers["data_received"](FakePacket("other-user"))
            self.assertFalse(agent._paused)
            room.handlers["data_received"](FakePacket("director-user"))
            await asyncio.sleep(0)
            self.assertTrue(agent._paused)
            return agent

        asyncio.run(run_case())

    def test_data_channel_controls_fail_closed_without_expected_identity(self) -> None:
        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = None
                self.handlers = {}

            def on(self, event, handler):
                self.handlers[event] = handler

        class FakePacket:
            topic = "otto.director.control"
            participant = SimpleNamespace(identity="director-user")
            data = json.dumps(
                {
                    "source": "otto_browser_client",
                    "capture_session_id": "14125388-f796-4087-ae34-f18ab845e270",
                    "event": "director.control",
                    "payload": {"action": "pause"},
                }
            ).encode("utf-8")

        room = FakeRoom()
        agent = DirectorConsultantAgent(
            capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
            api=object(),
            planner=object(),
            room=room,
        )

        room.handlers["data_received"](FakePacket())
        self.assertFalse(agent._paused)

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
            topic = "otto.director.control"

            def __init__(self, action: str) -> None:
                self.participant = SimpleNamespace(identity="director-user")
                self.data = json.dumps(
                    {
                        "source": "otto_browser_client",
                        "capture_session_id": "14125388-f796-4087-ae34-f18ab845e270",
                        "event": "director.control",
                        "payload": {"action": action},
                    }
                ).encode("utf-8")

        async def run_case() -> FakeRoom:
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=object(),
                planner=object(),
                room=room,
                expected_control_participant_identity="director-user",
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
            if reliable and topic == "otto.director"
        ]

        self.assertEqual([event["event"] for event in decoded], ["director.control.updated", "director.control.updated"])
        self.assertEqual(decoded[0]["payload"]["action"], "mute")
        self.assertTrue(decoded[0]["payload"]["muted"])
        self.assertFalse(decoded[0]["payload"]["paused"])
        self.assertEqual(decoded[1]["payload"]["action"], "pause")
        self.assertTrue(decoded[1]["payload"]["muted"])
        self.assertTrue(decoded[1]["payload"]["paused"])

    def test_end_control_waits_for_active_turn_delivery_before_completion(self) -> None:
        class FakeApi:
            def __init__(self) -> None:
                self.completed = False

            async def complete_session(self, **kwargs):
                self.completed = True
                return {"capture_session": {"id": kwargs["capture_session_id"]}}

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = None
                self.handlers = {}
                self.disconnect_called = False

            def on(self, event, handler):
                self.handlers[event] = handler

            async def disconnect(self):
                self.disconnect_called = True

        class FakePacket:
            topic = "otto.director.control"
            participant = SimpleNamespace(identity="director-user")
            data = json.dumps(
                {
                    "source": "otto_browser_client",
                    "capture_session_id": "14125388-f796-4087-ae34-f18ab845e270",
                    "event": "director.control",
                    "payload": {"action": "end"},
                }
            ).encode("utf-8")

        async def run_case() -> tuple[FakeApi, FakeRoom]:
            api = FakeApi()
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=api,
                planner=object(),
                room=room,
                expected_control_participant_identity="director-user",
            )
            active_turn_done = asyncio.Event()
            agent._active_turn_done = active_turn_done
            with patch("director_agent.agent.COMPLETION_DISCONNECT_GRACE_SECONDS", 0):
                room.handlers["data_received"](FakePacket())
                await asyncio.sleep(0)
                self.assertFalse(api.completed)
                self.assertFalse(room.disconnect_called)
                active_turn_done.set()
                await asyncio.sleep(0)
            return api, room

        api, room = asyncio.run(run_case())
        self.assertTrue(api.completed)
        self.assertTrue(room.disconnect_called)

    def test_end_control_waits_for_active_voice_prompt_delivery_before_completion(self) -> None:
        class FakeApi:
            def __init__(self) -> None:
                self.completed = False

            async def complete_session(self, **kwargs):
                self.completed = True
                return {"capture_session": {"id": kwargs["capture_session_id"]}}

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = None
                self.handlers = {}
                self.disconnect_called = False

            def on(self, event, handler):
                self.handlers[event] = handler

            async def disconnect(self):
                self.disconnect_called = True

        class FakePacket:
            topic = "otto.director.control"
            participant = SimpleNamespace(identity="director-user")
            data = json.dumps(
                {
                    "source": "otto_browser_client",
                    "capture_session_id": "14125388-f796-4087-ae34-f18ab845e270",
                    "event": "director.control",
                    "payload": {"action": "end"},
                }
            ).encode("utf-8")

        async def run_case() -> tuple[FakeApi, FakeRoom]:
            api = FakeApi()
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=api,
                planner=object(),
                room=room,
                expected_control_participant_identity="director-user",
            )
            active_delivery_done = agent._begin_active_delivery()
            with patch("director_agent.agent.COMPLETION_DISCONNECT_GRACE_SECONDS", 0):
                room.handlers["data_received"](FakePacket())
                await asyncio.sleep(0)
                self.assertFalse(api.completed)
                self.assertFalse(room.disconnect_called)
                agent._finish_active_delivery(active_delivery_done)
                await asyncio.sleep(0)
            return api, room

        api, room = asyncio.run(run_case())
        self.assertTrue(api.completed)
        self.assertTrue(room.disconnect_called)

    def test_end_control_retries_delivery_pending_completion_before_disconnect(self) -> None:
        class FakeApi:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def complete_session(self, **kwargs):
                self.calls.append(kwargs)
                if len(self.calls) < 3:
                    raise RuntimeError("delivery_pending")
                return {"capture_session": {"id": kwargs["capture_session_id"]}}

        class FakeRoom:
            def __init__(self) -> None:
                self.local_participant = None
                self.handlers = {}
                self.disconnect_called = False

            def on(self, event, handler):
                self.handlers[event] = handler

            async def disconnect(self):
                self.disconnect_called = True

        class FakePacket:
            topic = "otto.director.control"
            participant = SimpleNamespace(identity="director-user")
            data = json.dumps(
                {
                    "source": "otto_browser_client",
                    "capture_session_id": "14125388-f796-4087-ae34-f18ab845e270",
                    "event": "director.control",
                    "payload": {"action": "end"},
                }
            ).encode("utf-8")

        async def run_case() -> tuple[FakeApi, FakeRoom]:
            api = FakeApi()
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=api,
                planner=object(),
                room=room,
                expected_control_participant_identity="director-user",
            )
            with (
                patch("director_agent.agent.COMPLETION_RETRY_DELAYS_SECONDS", (0, 0)),
                patch("director_agent.agent.COMPLETION_DISCONNECT_GRACE_SECONDS", 0),
            ):
                room.handlers["data_received"](FakePacket())
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                await asyncio.sleep(0)
            return api, room

        api, room = asyncio.run(run_case())
        self.assertEqual(len(api.calls), 3)
        self.assertTrue(room.disconnect_called)
        self.assertEqual(
            len(
                {
                    call["idempotency_key"]
                    for call in api.calls
                }
            ),
            1,
        )

    def test_end_control_publishes_completion_event_before_disconnect(self) -> None:
        class FakeApi:
            async def complete_session(self, **kwargs):
                return {"capture_session": {"id": kwargs["capture_session_id"]}}

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

        class FakePacket:
            topic = "otto.director.control"
            participant = SimpleNamespace(identity="director-user")
            data = json.dumps(
                {
                    "source": "otto_browser_client",
                    "capture_session_id": "14125388-f796-4087-ae34-f18ab845e270",
                    "event": "director.control",
                    "payload": {"action": "end"},
                }
            ).encode("utf-8")

        async def run_case() -> FakeRoom:
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=FakeApi(),
                planner=object(),
                room=room,
                expected_control_participant_identity="director-user",
            )
            with patch("director_agent.agent.COMPLETION_DISCONNECT_GRACE_SECONDS", 0):
                room.handlers["data_received"](FakePacket())
                await asyncio.sleep(0)
                await asyncio.sleep(0)
            return room

        room = asyncio.run(run_case())
        self.assertTrue(room.disconnect_called)
        decoded = [
            json.loads(payload.decode("utf-8"))
            for payload, reliable, topic in room.local_participant.calls
            if reliable and topic == "otto.director"
        ]
        self.assertEqual(
            [event["event"] for event in decoded],
            ["director.control.updated", "director.session.completed"],
        )
        self.assertEqual(decoded[1]["payload"]["next"], "synthesis")
        self.assertEqual(
            decoded[1]["payload"]["capture_session_id"],
            "14125388-f796-4087-ae34-f18ab845e270",
        )

    def test_end_control_publishes_notice_when_completion_fails(self) -> None:
        class FakeApi:
            async def complete_session(self, **kwargs):
                raise RuntimeError("delivery_pending")

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

        class FakePacket:
            topic = "otto.director.control"
            participant = SimpleNamespace(identity="director-user")
            data = json.dumps(
                {
                    "source": "otto_browser_client",
                    "capture_session_id": "14125388-f796-4087-ae34-f18ab845e270",
                    "event": "director.control",
                    "payload": {"action": "end"},
                }
            ).encode("utf-8")

        async def run_case() -> FakeRoom:
            room = FakeRoom()
            agent = DirectorConsultantAgent(
                capture_session_id="14125388-f796-4087-ae34-f18ab845e270",
                api=FakeApi(),
                planner=object(),
                room=room,
                expected_control_participant_identity="director-user",
            )
            with patch("director_agent.agent.COMPLETION_RETRY_DELAYS_SECONDS", (0,)):
                room.handlers["data_received"](FakePacket())
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                await asyncio.sleep(0)
            return room

        room = asyncio.run(run_case())
        self.assertFalse(room.disconnect_called)
        decoded = [
            json.loads(payload.decode("utf-8"))
            for payload, reliable, topic in room.local_participant.calls
            if reliable and topic == "otto.director"
        ]
        self.assertEqual(
            [event["event"] for event in decoded],
            ["director.control.updated", "director.session.notice"],
        )
        self.assertEqual(decoded[0]["payload"]["action"], "end")
        self.assertTrue(decoded[0]["payload"]["paused"])
        self.assertTrue(decoded[0]["payload"]["ended"])
        self.assertEqual(decoded[1]["payload"]["notice_type"], "failed_completion")
        self.assertIn("completion did not save", decoded[1]["payload"]["message"])


if __name__ == "__main__":
    unittest.main()
