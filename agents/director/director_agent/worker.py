from __future__ import annotations

import os
import re
import sys
import asyncio
import json
import logging
from dataclasses import replace

from livekit.agents import (
    AgentSession,
    JobContext,
    JobRequest,
    TurnHandlingOptions,
    WorkerOptions,
    cli,
)

from director_agent.agent import DirectorConsultantAgent
from director_agent.config import DirectorAgentConfig, env_value
from director_agent.otto_api import OttoApiClient
from director_agent.planner import DirectorPlanner
from director_agent.preflight import configured_env_value, parse_env_file

LOGGER = logging.getLogger(__name__)
DEEPGRAM_AUTO_LANGUAGE = "multi"
CARTESIA_TTS_LANGUAGES = {"en", "es", "fr", "de", "pt", "zh", "ja"}


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    capture_session_id = capture_session_id_from_room(ctx.room.name)
    api: OttoApiClient | None = None
    planner = None
    job_done = asyncio.Event()

    async def mark_job_done(_reason: str = "") -> None:
        job_done.set()

    ctx.add_shutdown_callback(mark_job_done)
    try:
        config = DirectorAgentConfig.from_env()
        api = OttoApiClient(config.otto_api_base_url, config.service_token)
        context = await api.planning_context(capture_session_id=capture_session_id)
        expected_control_identity = control_participant_identity_from_context(context)
        config = replace(
            config,
            capture_session_id=capture_session_id,
            language=str(context.get("language") or config.language or "en"),
        )
        planner = DirectorPlanner(api=api, config=config)
        agent = DirectorConsultantAgent(
            capture_session_id=capture_session_id,
            api=api,
            planner=planner,
            room=ctx.room,
            should_say_opening=should_say_opening(context),
            stale_pending_delivery_decisions=context.get(
                "stale_pending_delivery_decisions"
            )
            or [],
            initial_turn_counter=initial_turn_counter(context),
            expected_control_participant_identity=expected_control_identity,
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
                endpointing={"min_delay": 1.2, "max_delay": 6.0},
                interruption={"enabled": True},
            ),
            user_away_timeout=None,
        )
        await session.start(room=ctx.room, agent=agent)
        await job_done.wait()
    except Exception as error:
        LOGGER.exception("Director worker failed to start for %s", capture_session_id)
        await publish_worker_startup_failure(ctx.room, capture_session_id, error)
        raise
    finally:
        try:
            if planner is not None:
                await planner.aclose()
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
                    "source": "otto_director_agent",
                    "capture_session_id": capture_session_id,
                    "event": "director.session.notice",
                    "payload": {
                        "notice_type": "worker_startup_failed",
                        "message": (
                            "The voice agent could not start. You can keep going with "
                            "typed answers while the voice worker is restarted. "
                            f"{error.__class__.__name__}: {error}"
                        ),
                        "error_type": error.__class__.__name__,
                        "error_message": str(error),
                    },
                }
            ).encode("utf-8"),
            reliable=True,
            topic="otto.director",
        )
        return True
    except Exception as publish_error:
        LOGGER.warning(
            "Failed to publish director worker startup failure notice: %s",
            publish_error,
        )
        return False


def stt_provider(config: DirectorAgentConfig):
    if config.use_livekit_inference:
        language = deepgram_language(config.language)
        return f"deepgram/{config.deepgram_model}:{language}"
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
        tags=["otto", "director-interview"],
    )


def tts_provider(config: DirectorAgentConfig):
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


def cartesia_audio_metadata(config: DirectorAgentConfig) -> dict[str, str | bool]:
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


def capture_session_id_from_room(room_name: str) -> str:
    match = re.fullmatch(r"director-([0-9a-fA-F-]{36})", room_name)
    if not match:
        raise RuntimeError(
            "Director worker expected room name director-{capture_session_id}; "
            f"got {room_name!r}."
        )
    return match.group(1)


def director_agent_participant_identity(capture_session_id: str) -> str:
    return f"otto-director-agent-{capture_session_id}"


async def accept_director_job(request: JobRequest) -> None:
    try:
        capture_session_id = capture_session_id_from_room(request.room.name)
    except RuntimeError:
        await request.reject(terminate=False)
        return
    await request.accept(
        name=os.getenv("LIVEKIT_AGENT_NAME", "otto-director"),
        identity=director_agent_participant_identity(capture_session_id),
        metadata=json.dumps({"capture_session_id": capture_session_id}),
    )


def should_say_opening(context: dict) -> bool:
    if context.get("has_opening_prompt") and context.get("has_terminal_opening_prompt") is False:
        return True
    return not (
        context.get("has_opening_prompt")
        or context.get("recent_turns")
        or context.get("candidate_processes")
        or context.get("prior_intent")
    )


def initial_turn_counter(context: dict) -> int:
    value = context.get("next_turn_index")
    if isinstance(value, int):
        return max(0, value)
    try:
        return max(0, int(str(value)))
    except (TypeError, ValueError):
        return 0


def control_participant_identity_from_context(context: dict) -> str:
    identity = str(context.get("director_user_id") or "").strip()
    if not identity:
        raise RuntimeError(
            "Director planning context is missing director_user_id; refusing to "
            "start voice controls without a verified browser participant identity."
        )
    return identity


def main() -> None:
    load_env_file_arg(sys.argv)
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            request_fnc=accept_director_job,
            agent_name=os.getenv("LIVEKIT_AGENT_NAME", "otto-director"),
        )
    )


def load_env_file_arg(argv: list[str]) -> None:
    if "--env-file" not in argv:
        return
    index = argv.index("--env-file")
    try:
        path = argv[index + 1]
    except IndexError as exc:
        raise SystemExit("--env-file requires a path") from exc
    existing = dict(os.environ)
    for key, value in parse_env_file(path).items():
        if not configured_env_value(existing, key):
            os.environ[key] = value
    del argv[index : index + 2]


if __name__ == "__main__":
    main()
