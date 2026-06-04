from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path

from livekit.agents import (
    AgentSession,
    JobContext,
    JobRequest,
    TurnHandlingOptions,
    WorkerOptions,
    cli,
)

from operator_agent.agent import OperatorWorkflowAgent
from operator_agent.config import OperatorAgentConfig, env_value
from operator_agent.otto_api import OperatorApiClient


LOGGER = logging.getLogger(__name__)
DEEPGRAM_AUTO_LANGUAGE = "multi"
CARTESIA_TTS_LANGUAGES = {"en", "es", "fr", "de", "pt", "zh", "ja"}
DEFAULT_OPERATOR_WORKER_HTTP_PORT = 8082


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    capture_session_id = capture_session_id_from_room(ctx.room.name)
    api: OperatorApiClient | None = None
    job_done = asyncio.Event()

    async def mark_job_done(_reason: str = "") -> None:
        job_done.set()

    if hasattr(ctx, "add_shutdown_callback"):
        ctx.add_shutdown_callback(mark_job_done)
    try:
        config = OperatorAgentConfig.from_env()
        api = OperatorApiClient(config.otto_api_base_url, config.service_token)
        agent = OperatorWorkflowAgent(
            capture_session_id=capture_session_id,
            api=api,
            room=ctx.room,
            voice_runtime=config.voice_runtime,
            tts_audio_metadata=cartesia_audio_metadata(config),
        )

        from livekit.plugins import silero
        from livekit.plugins.turn_detector.multilingual import MultilingualModel

        session = AgentSession(
            stt=stt_provider(config),
            tts=tts_provider(config),
            vad=silero.VAD.load(),
            turn_handling=TurnHandlingOptions(
                turn_detection=MultilingualModel(),
                endpointing={
                    "mode": endpointing_mode(config.endpointing_mode),
                    "min_delay": config.endpointing_min_delay,
                    "max_delay": config.endpointing_max_delay,
                    "alpha": config.endpointing_alpha,
                },
                interruption={"enabled": True},
            ),
            user_away_timeout=None,
        )
        await session.start(room=ctx.room, agent=agent)
        await job_done.wait()
    except Exception as error:
        LOGGER.exception("Operator worker failed to start for %s", capture_session_id)
        await publish_worker_startup_failure(ctx.room, capture_session_id, error)
        raise
    finally:
        if api is not None:
            await api.aclose()


async def publish_worker_startup_failure(room, capture_session_id: str, error: Exception) -> bool:
    local_participant = getattr(room, "local_participant", None)
    if not local_participant:
        return False
    try:
        await local_participant.publish_data(
            json.dumps(
                {
                    "source": "otto_operator_agent",
                    "capture_session_id": capture_session_id,
                    "event": "operator.session.notice",
                    "payload": {
                        "notice_type": "worker_startup_failed",
                        "message": (
                            "The operator voice agent could not start. You can "
                            "keep going with typed answers while the worker is "
                            f"restarted. {error.__class__.__name__}: "
                            f"{safe_startup_error_message(error)}"
                        ),
                        "error_type": error.__class__.__name__,
                        "error_message": safe_startup_error_message(error),
                    },
                }
            ).encode("utf-8"),
            reliable=True,
            topic="otto.operator",
        )
        return True
    except Exception as publish_error:
        LOGGER.warning(
            "Failed to publish operator worker startup failure notice: %s",
            publish_error,
        )
        return False


def safe_startup_error_message(error: Exception) -> str:
    message = str(error)
    if re.search(r"\b[A-Z][A-Z0-9_]{2,}\b", message):
        return "required voice configuration is missing"
    return message


def stt_provider(config: OperatorAgentConfig):
    if config.use_livekit_inference:
        return f"deepgram/{config.deepgram_model}:{deepgram_language(config.language)}"
    if not env_value("DEEPGRAM_API_KEY"):
        raise RuntimeError(
            "Missing DEEPGRAM_API_KEY. Set it for direct Deepgram STT or set "
            "OTTO_USE_LIVEKIT_INFERENCE=true."
        )
    from livekit.plugins import deepgram

    return deepgram.STT(
        model=config.deepgram_model,
        language=deepgram_language(config.language),
        detect_language=config.language == "auto",
        mip_opt_out=True,
        tags=["otto", "operator-capture"],
    )


def tts_provider(config: OperatorAgentConfig):
    if config.use_livekit_inference:
        return f"cartesia/{config.cartesia_model}:{config.cartesia_voice_id}"
    if not env_value("CARTESIA_API_KEY"):
        raise RuntimeError(
            "Missing CARTESIA_API_KEY. Set it for direct Cartesia TTS or set "
            "OTTO_USE_LIVEKIT_INFERENCE=true."
        )
    from livekit.plugins import cartesia

    return cartesia.TTS(
        model=config.cartesia_model,
        voice=config.cartesia_voice_id,
        language=cartesia_language(config.language),
    )


def deepgram_language(language: str) -> str:
    return DEEPGRAM_AUTO_LANGUAGE if language == "auto" else language


def cartesia_language(language: str) -> str:
    return language if language in CARTESIA_TTS_LANGUAGES else "en"


def cartesia_audio_metadata(config: OperatorAgentConfig) -> dict[str, str | bool]:
    return {
        "source": "livekit_agents",
        "provider": "cartesia",
        "model": config.cartesia_model,
        "voice_id": config.cartesia_voice_id,
        "language": cartesia_language(config.language),
        "transport": (
            "livekit_inference" if config.use_livekit_inference else "direct_plugin"
        ),
        "playout": "session.say.wait_for_playout",
        "vendor_privacy_ack": config.vendor_privacy_ack,
        "privacy_no_retention_ack": config.cartesia_no_retention_ack,
    }


def endpointing_mode(value: str) -> str:
    return value if value in {"fixed", "dynamic"} else "dynamic"


def capture_session_id_from_room(room_name: str) -> str:
    match = re.fullmatch(r"operator-([0-9a-fA-F-]{36})", room_name)
    if not match:
        raise RuntimeError(
            "Operator worker expected room name operator-{capture_session_id}; "
            f"got {room_name!r}."
        )
    return match.group(1)


def operator_agent_participant_identity(capture_session_id: str) -> str:
    return f"otto-operator-agent-{capture_session_id}"


async def accept_operator_job(request: JobRequest) -> None:
    try:
        capture_session_id = capture_session_id_from_room(request.room.name)
    except RuntimeError:
        await request.reject(terminate=False)
        return
    await request.accept(
        name=os.getenv("LIVEKIT_OPERATOR_AGENT_NAME", os.getenv("LIVEKIT_AGENT_NAME", "otto-operator")),
        identity=operator_agent_participant_identity(capture_session_id),
        metadata=json.dumps({"capture_session_id": capture_session_id}),
    )


def main() -> None:
    load_env_file_arg(sys.argv)
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            request_fnc=accept_operator_job,
            agent_name=os.getenv(
                "LIVEKIT_OPERATOR_AGENT_NAME",
                os.getenv("LIVEKIT_AGENT_NAME", "otto-operator"),
            ),
            port=operator_worker_http_port(),
        )
    )


def operator_worker_http_port() -> int:
    raw = os.getenv("LIVEKIT_OPERATOR_WORKER_HTTP_PORT", "").strip()
    if not raw:
        return DEFAULT_OPERATOR_WORKER_HTTP_PORT
    try:
        port = int(raw)
    except ValueError as exc:
        raise SystemExit("LIVEKIT_OPERATOR_WORKER_HTTP_PORT must be an integer") from exc
    if port < 0 or port > 65535:
        raise SystemExit("LIVEKIT_OPERATOR_WORKER_HTTP_PORT must be between 0 and 65535")
    return port


def load_env_file_arg(argv: list[str]) -> None:
    path: str | None = None
    if "--env-file" in argv:
        index = argv.index("--env-file")
        try:
            path = argv[index + 1]
        except IndexError as exc:
            raise SystemExit("--env-file requires a path") from exc
        del argv[index : index + 2]
    else:
        for index, value in enumerate(argv):
            if value.startswith("--env-file="):
                path = value.split("=", 1)[1]
                del argv[index]
                break
    if not path:
        return
    existing = dict(os.environ)
    for key, value in parse_env_file(path).items():
        if not env_value_from(existing, key):
            os.environ[key] = value


def parse_env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in Path(path).read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key.removeprefix("export ").strip()
        value = raw_value.strip()
        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {"'", '"'}
        ):
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def env_value_from(env: dict[str, str], name: str) -> str | None:
    value = (env.get(name) or "").strip()
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


if __name__ == "__main__":
    main()
