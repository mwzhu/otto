from __future__ import annotations

import asyncio
import argparse
import json
import os
from dataclasses import dataclass, replace
from typing import Mapping, Protocol

from director_agent.otto_api import OttoApiClient
from director_agent.preflight import (
    PreflightResult,
    check_environment,
    check_verification_environment,
    configured_env_value,
    configured_uuid_env_value,
    configured_uuid_value,
    env_with_file,
    missing_env_file_result,
)
from director_agent.proof_readiness import check_proof_readiness

ACCEPTANCE_GUIDANCE = {
    "all_delivery_terminal": {
        "summary": "At least one director turn is still pending or has unknown delivery.",
        "inspect": "Check the worker delivery update calls and agent_decision_log.delivery_json for director.turn rows.",
    },
    "all_terminal_delivery_has_spoken_evidence": {
        "summary": "At least one terminal director turn has inconsistent delivered-utterance or spoken-fraction evidence.",
        "inspect": "Check delivery_json.planned_utterance, delivered_utterance, delivery_status, and spoken_fraction for completed/truncated/failed_text_fallback rows.",
    },
    "all_decisions_have_ingested_transcript_evidence": {
        "summary": "At least one director decision is missing the transcript/evidence backing from ingest.",
        "inspect": "Check agent_decision_log.transcript_segment_ids, transcript_segments.turn_index, and transcript evidence rows for the same capture session.",
    },
    "all_voice_prompts_delivery_terminal": {
        "summary": "The opening prompt did not reach terminal delivery state.",
        "inspect": "Check director.opening rows in agent_decision_log.delivery_json.",
    },
    "all_voice_prompts_have_spoken_evidence": {
        "summary": "The opening prompt has inconsistent delivered-utterance or spoken-fraction evidence.",
        "inspect": "Check voice prompt delivery_json.planned_utterance, delivered_utterance, delivery_status, and spoken_fraction.",
    },
    "backend_pre_tts_p95_ok": {
        "summary": "Backend pre-TTS latency exceeded the 1.5s p95 budget or no latency was recorded.",
        "inspect": "Check delivery_json.latency_ms and Anthropic/dispatch timing in agent_decision_log.",
    },
    "backend_pre_tts_p50_ok": {
        "summary": "Backend pre-TTS latency exceeded the 1.0s p50 budget or no latency was recorded.",
        "inspect": "Check delivery_json.latency_ms and Anthropic/dispatch timing in agent_decision_log.",
    },
    "audio_retention_audit_consistent": {
        "summary": "The vendor-export audit says audio retention was enabled, but the dedicated retention audit is missing.",
        "inspect": "Check audit_log event_type='capture.director_voice.audio_retention_enabled' and the capture retention_policy metadata.",
    },
    "raw_payload_logging_audit_consistent": {
        "summary": "The vendor-export audit says raw-payload logging was enabled, but the dedicated debug-window audit is missing.",
        "inspect": "Check audit_log event_type='capture.director_voice.raw_payload_logging_enabled' and the capture retention_policy metadata.",
    },
    "total_cost_within_2x_baseline": {
        "summary": "Director interview model cost exceeded the 2x baseline alert threshold.",
        "inspect": "Check telemetry.total_cost_cents, model tiers, prompt cache hit rate, and token caps.",
    },
    "capture_session_completed": {
        "summary": "The capture session was not marked completed.",
        "inspect": "Press End again or check /api/internal/director-turns/complete and capture_sessions.completed_at.",
    },
    "has_audible_tts_delivery": {
        "summary": "No director turn has evidence of audible TTS playout.",
        "inspect": "Check worker TTS playout, barge-in handling, delivery_json.spoken_fraction, and audio_metadata provider=cartesia.",
    },
    "has_configured_tts_runtime": {
        "summary": "No director turn recorded the configured Cartesia TTS runtime metadata.",
        "inspect": "Check delivery_json.audio_metadata.model, voice_id, language, and transport from cartesia_audio_metadata(config).",
    },
    "has_privacy_configured_tts_runtime": {
        "summary": "No director turn recorded Cartesia privacy-control metadata on the delivered audio.",
        "inspect": "Check delivery_json.audio_metadata.vendor_privacy_ack and privacy_no_retention_ack from cartesia_audio_metadata(config).",
    },
    "has_candidate_processes": {
        "summary": "No candidate processes were extracted from the interview.",
        "inspect": "Check planner output tool_calls for recordProcess and candidate_processes rows.",
    },
    "no_duplicate_candidate_process_names": {
        "summary": "The interview persisted duplicate candidate process names.",
        "inspect": "Check candidate_processes for normalized proposed_name duplicates and the recordProcess advisory-lock/idempotency path.",
    },
    "has_decision_turns": {
        "summary": "No director turn decision rows were written.",
        "inspect": "Check ingest/plan/dispatch internal API calls and agent_decision_log rows.",
    },
    "has_llm_brain_turn": {
        "summary": "No non-deterministic brain model turn was recorded.",
        "inspect": "Set ANTHROPIC_API_KEY and confirm DIRECTOR_BRAIN_MODEL metadata is logged.",
    },
    "has_llm_cache_observation": {
        "summary": "Brain model cache telemetry was not observed.",
        "inspect": "Check Anthropic usage metadata and prompt-caching headers for director.turn.plan.",
    },
    "has_llm_voice_turn": {
        "summary": "No non-deterministic voice phrasing model turn was recorded.",
        "inspect": "Set ANTHROPIC_API_KEY and confirm DIRECTOR_VOICE_MODEL metadata is stored in delivery_json.voice_metadata.",
    },
    "has_streamed_voice_turn": {
        "summary": "No voice model turn used the streamed first-question phrasing path.",
        "inspect": "Check delivery_json.voice_metadata.streaming and stream_cutoff for director.turn rows.",
    },
    "has_synthesis_run_for_capture": {
        "summary": "No synthesis run was queued for the completed director capture session.",
        "inspect": "Check /api/internal/director-turns/complete, synthesis.inventory.queued audit rows, and synthesis_runs.capture_session_ids.",
    },
    "has_opening_prompt": {
        "summary": "The persisted opening voice prompt is missing.",
        "inspect": "Check /api/internal/director-turns/opening and stage_name='director.opening'.",
    },
    "has_real_asr_timing": {
        "summary": "Transcript timing came from fallback estimates instead of real ASR metrics.",
        "inspect": "Check transcript_segments.timing_source and LiveKit/Deepgram finalized-turn metadata.",
    },
    "has_configured_asr_runtime": {
        "summary": "No transcript turn recorded the configured Deepgram ASR runtime metadata.",
        "inspect": "Check transcript_segments.metadata_json.model, language, and transport from transcript_timing_from_message(..., config=...).",
    },
    "has_privacy_configured_asr_runtime": {
        "summary": "No transcript turn recorded Deepgram privacy-control metadata on the ASR segment.",
        "inspect": "Check transcript_segments.metadata_json.vendor_privacy_ack, privacy_no_store_ack, and mip_opt_out from transcript_timing_from_message(..., config=...).",
    },
    "has_transcript": {
        "summary": "No director transcript segments were persisted.",
        "inspect": "Check Deepgram ASR finalization and /api/internal/director-turns/ingest.",
    },
    "has_tts_playout_timing": {
        "summary": "No TTS playout timing was recorded for director turns.",
        "inspect": "Check session.say(...).wait_for_playout(), delivery_json.latency_ms.tts_playout_ms, and audio_metadata source=livekit_agents.",
    },
    "has_vendor_export_audit": {
        "summary": "No vendor-export audit row was recorded for the director voice session.",
        "inspect": "Check /api/livekit/director-room and audit_log event_type='capture.director_voice.vendor_export'.",
    },
    "no_duplicate_vendor_export_audits": {
        "summary": "More than one vendor-export audit row was recorded for the same director voice session.",
        "inspect": "Check LiveKit room/token refresh idempotency and audit_log rows for event_type='capture.director_voice.vendor_export'.",
    },
    "has_livekit_vendor_export_audit": {
        "summary": "The vendor-export audit did not prove a LiveKit voice room was used.",
        "inspect": "Check audit_log.metadata_json.room_mode='livekit' and vendors include livekit/deepgram/cartesia.",
    },
    "has_stable_livekit_agent_identity": {
        "summary": "The vendor-export audit did not record the stable LiveKit agent participant identity.",
        "inspect": "Check /api/livekit/director-room metadata_json.agent_participant_identity and worker accept_director_job identity otto-director-agent-{capture_session_id}.",
    },
    "has_anthropic_vendor_export_audit": {
        "summary": "The vendor-export audit did not record Anthropic as part of the production voice session.",
        "inspect": "Check ANTHROPIC_API_KEY and audit_log.metadata_json.vendors includes anthropic for capture.director_voice.vendor_export.",
    },
    "vendor_privacy_controls_acknowledged": {
        "summary": "The vendor-export audit does not show all production privacy acknowledgements.",
        "inspect": "Check OTTO_VENDOR_PRIVACY_ACK, OTTO_DEEPGRAM_NO_STORE_ACK, OTTO_CARTESIA_NO_RETENTION_ACK, and OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK.",
    },
    "has_voice_cache_observation": {
        "summary": "Voice phrasing cache telemetry was not observed.",
        "inspect": "Check Anthropic usage metadata for director.voice.phrase-intent.",
    },
    "llm_cache_hit_rate_target": {
        "summary": "Brain prompt-cache hit rate is below the 60% production target.",
        "inspect": "Check telemetry.llm_cache_hit_rate, Anthropic cache_read_input_tokens, and the static/dynamic prompt block ordering.",
    },
    "voice_cache_hit_rate_target": {
        "summary": "Voice prompt-cache hit rate is below the 60% production target.",
        "inspect": "Check telemetry.voice_cache_hit_rate, Anthropic cache_read_input_tokens, and the static/dynamic prompt block ordering.",
    },
    "no_degraded_turns": {
        "summary": "At least one turn still has unresolved fallback/degraded extraction or phrasing.",
        "inspect": "Check brain.unresolved_degraded_turns, recovered_degraded_turns, and re_extract_degraded_turns.recovered markers in agent_decision_log.",
    },
    "no_failed_text_fallback_turns": {
        "summary": "A director turn fell back to text because audio playback failed.",
        "inspect": "Check TTS provider credentials, LiveKit audio subscription, and delivery_status='failed_text_fallback'.",
    },
    "no_failed_text_fallback_voice_prompts": {
        "summary": "A non-turn voice prompt fell back to text because audio playback failed.",
        "inspect": "Check opening prompt TTS delivery and LiveKit audio playback.",
    },
    "opening_prompt_has_tts_playout": {
        "summary": "The opening prompt exists but has no TTS playout evidence.",
        "inspect": "Check the opening prompt persist-before-playback path and delivery update.",
    },
    "voice_prompts_have_configured_tts_runtime": {
        "summary": "One or more persisted voice prompts did not record configured Cartesia runtime metadata.",
        "inspect": "Check director.opening delivery_json.audio_metadata.model, voice_id, language, and transport.",
    },
    "voice_prompts_have_privacy_configured_tts_runtime": {
        "summary": "One or more persisted voice prompts did not record Cartesia privacy-control metadata.",
        "inspect": "Check director.opening delivery_json.audio_metadata.vendor_privacy_ack and privacy_no_retention_ack.",
    },
    "overview_has_evidence_linked_card": {
        "summary": "The overview does not yet have an evidence-linked process card.",
        "inspect": "Check candidate_processes.evidence_ids, process claim_evidence links, and /overview card counts after synthesis.",
    },
    "overview_ready": {
        "summary": "The overview is not ready after synthesis.",
        "inspect": "Check synthesis run status is completed/partial_synthesis and overview process card count is greater than zero.",
    },
    "priority_1_progress": {
        "summary": "Priority-1 slot coverage did not reach the acceptance threshold.",
        "inspect": "Run a longer interview or inspect slot_states for missing priority-1 fields.",
    },
    "priority_1_no_partial_or_conflicting": {
        "summary": "At least one priority-1 slot is still partial or conflicting.",
        "inspect": "Inspect slot_states for priority-1 rows with status partial or conflicting before closing the director interview.",
    },
    "synthesis_terminal_for_capture": {
        "summary": "The synthesis run for this capture session has not reached a terminal overview-ready status.",
        "inspect": "Check synthesis_runs.status for completed or partial_synthesis on the capture_session_ids array.",
    },
}


class VerificationConfigLike(Protocol):
    otto_api_base_url: str
    service_token: str
    capture_session_id: str | None


@dataclass(frozen=True)
class VerificationConfig:
    otto_api_base_url: str
    service_token: str
    capture_session_id: str | None

    @classmethod
    def from_env(cls) -> "VerificationConfig":
        return cls(
            otto_api_base_url=required_env("OTTO_INTERNAL_API_BASE_URL").rstrip("/"),
            service_token=required_env("LIVEKIT_AGENT_SERVICE_TOKEN"),
            capture_session_id=required_env("OTTO_CAPTURE_SESSION_ID"),
        )

    @classmethod
    def from_mapping(cls, env: Mapping[str, str | None]) -> "VerificationConfig":
        return cls(
            otto_api_base_url=required_mapping_env(
                env,
                "OTTO_INTERNAL_API_BASE_URL",
            ).rstrip("/"),
            service_token=required_mapping_env(env, "LIVEKIT_AGENT_SERVICE_TOKEN"),
            capture_session_id=required_mapping_env(env, "OTTO_CAPTURE_SESSION_ID"),
        )


async def run_session_verify(
    *,
    config: VerificationConfigLike | None = None,
    api: OttoApiClient | None = None,
    preflight_result: PreflightResult | None = None,
) -> dict:
    preflight = preflight_result or check_verification_environment()
    if not preflight.ok:
        raise RuntimeError(
            "Director verify preflight failed: "
            + ", ".join(preflight.missing_required)
        )
    config = config or VerificationConfig.from_env()
    validate_verification_config(config)

    owns_api = api is None
    api = api or OttoApiClient(config.otto_api_base_url, config.service_token)
    try:
        return await api.verify_session(capture_session_id=config.capture_session_id)
    finally:
        if owns_api:
            await api.aclose()


def failed_acceptance_checks(verification: dict) -> list[str]:
    acceptance = verification.get("acceptance")
    if not isinstance(acceptance, dict):
        return ["acceptance"]
    return [
        key
        for key, value in sorted(acceptance.items())
        if value is not True
    ]


def acceptance_failure_details(verification: dict) -> list[dict[str, str]]:
    return [
        {
            "check": check,
            **ACCEPTANCE_GUIDANCE.get(
                check,
                {
                    "summary": "Acceptance check failed.",
                    "inspect": "Inspect the verification bundle for the related evidence counts.",
                },
            ),
        }
        for check in failed_acceptance_checks(verification)
    ]


def preflight_failure_verification(preflight: PreflightResult) -> dict:
    missing = list(preflight.missing_required)
    return {
        "ok": False,
        "verification_ready": False,
        "preflight": preflight.to_dict(),
        "acceptance": {
            "verification_environment_configured": False,
        },
        "failed_acceptance_checks": ["verification_environment_configured"],
        "failed_acceptance_details": [
            {
                "check": "verification_environment_configured",
                "summary": "The session verifier cannot reach persisted live evidence yet.",
                "inspect": (
                    "Set "
                    + ", ".join(missing)
                    + " and rerun otto-director-session-verify after a real LiveKit session."
                ),
            }
        ],
    }


def session_verify_preflight(
    env: Mapping[str, str | None] | None = None,
    *,
    strict_voice_env: bool = False,
    app_env_file: str | None = None,
    worker_env_file: str | None = None,
    require_app_env_file: bool = False,
) -> PreflightResult:
    env = os.environ if env is None else env
    if not strict_voice_env:
        return check_verification_environment(env)

    voice_preflight = check_environment(env)
    missing = list(dict.fromkeys(voice_preflight.missing_required))
    warnings = list(voice_preflight.warnings)
    mode = dict(voice_preflight.mode)
    if require_app_env_file and not app_env_file:
        missing.append("app_env_file")
        warnings.append(
            "--strict-voice-env final proof requires --app-env-file so the Next.js room/token path is checked with the worker env."
        )
    if require_app_env_file and not worker_env_file:
        missing.append("worker_env_file")
        warnings.append(
            "--strict-voice-env final proof requires --env-file so the worker env can be compared with the app env."
        )
    if app_env_file and worker_env_file:
        try:
            proof = check_proof_readiness(
                app_env_file=app_env_file,
                worker_env_file=worker_env_file,
                base_env=env,
            )
        except FileNotFoundError as error:
            missing.extend(str(error).split(", "))
        else:
            missing.extend(proof.app_missing)
            missing.extend(proof.worker_missing)
            missing.extend([f"mismatch:{key}" for key in proof.mismatched])
            warnings.extend(proof.warnings)
            mode.update(
                {
                    "proof_readiness_app_env_file": proof.app_env_file,
                    "proof_readiness_worker_env_file": proof.worker_env_file,
                    "proof_readiness_checked": True,
                    "proof_readiness_mismatched": proof.mismatched,
                }
            )
    if not configured_uuid_env_value(env, "OTTO_CAPTURE_SESSION_ID"):
        missing.append("OTTO_CAPTURE_SESSION_ID")
    missing = list(dict.fromkeys(missing))
    return replace(
        voice_preflight,
        ok=len(missing) == 0,
        missing_required=missing,
        warnings=warnings,
        mode={
            **mode,
            "verification_strict_voice_env": True,
            "capture_session_id": env.get("OTTO_CAPTURE_SESSION_ID"),
        },
    )


def required_env(name: str) -> str:
    if not configured_env_value(os.environ, name):
        raise RuntimeError(f"Missing required environment variable: {name}")
    return str(os.getenv(name) or "").strip()


def required_mapping_env(env: Mapping[str, str | None], name: str) -> str:
    if not configured_env_value(env, name):
        raise RuntimeError(f"Missing required environment variable: {name}")
    return str(env.get(name) or "").strip()


def validate_verification_config(config: VerificationConfigLike) -> None:
    for name, value in [
        ("OTTO_INTERNAL_API_BASE_URL", config.otto_api_base_url),
        ("LIVEKIT_AGENT_SERVICE_TOKEN", config.service_token),
        ("OTTO_CAPTURE_SESSION_ID", config.capture_session_id),
    ]:
        if not configured_value(value):
            raise RuntimeError(f"Missing required environment variable: {name}")
    if not configured_uuid_value(config.capture_session_id):
        raise RuntimeError("Missing required environment variable: OTTO_CAPTURE_SESSION_ID")


def configured_value(value: str | None) -> bool:
    trimmed = str(value or "").strip()
    if not trimmed:
        return False
    lowered = trimmed.lower()
    if lowered in {"...", "replace-me", "replace_with_real_value"}:
        return False
    if lowered.startswith("replace-with"):
        return False
    if "your-project" in lowered:
        return False
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify persisted evidence for a completed director voice session."
    )
    parser.add_argument(
        "--allow-incomplete",
        action="store_true",
        help="Print the verification bundle without failing on unmet acceptance checks.",
    )
    parser.add_argument(
        "--strict-voice-env",
        action="store_true",
        help="Also require full LiveKit/provider/privacy production env before verifying persisted evidence.",
    )
    parser.add_argument(
        "--env-file",
        help="Optional KEY=VALUE env file to load before verification.",
    )
    parser.add_argument(
        "--app-env-file",
        help=(
            "Next.js app env file to cross-check in --strict-voice-env mode. "
            "Required for the final production proof and requires --env-file."
        ),
    )
    args = parser.parse_args()
    try:
        env = env_with_file(args.env_file, strict=args.strict_voice_env)
    except FileNotFoundError:
        if not args.env_file:
            raise
        preflight = missing_env_file_result(
            args.env_file,
            strict=args.strict_voice_env,
        )
        env = os.environ
    else:
        preflight = session_verify_preflight(
            env,
            strict_voice_env=args.strict_voice_env,
            app_env_file=args.app_env_file,
            worker_env_file=args.env_file,
            require_app_env_file=args.strict_voice_env,
        )
    if not preflight.ok and args.allow_incomplete:
        print(json.dumps(preflight_failure_verification(preflight), indent=2, sort_keys=True))
        return
    if not preflight.ok:
        raise SystemExit(
            "Director verify preflight failed: "
            + ", ".join(preflight.missing_required)
        )
    verification = asyncio.run(
        run_session_verify(
            config=VerificationConfig.from_mapping(env),
            preflight_result=preflight,
        )
    )
    failed = failed_acceptance_checks(verification)
    output = {
        **verification,
        "failed_acceptance_details": acceptance_failure_details(verification),
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    if failed and not args.allow_incomplete:
        raise SystemExit(
            "Director session verification failed acceptance checks: "
            + ", ".join(failed)
        )


if __name__ == "__main__":
    main()
