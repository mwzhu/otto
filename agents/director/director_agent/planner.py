from __future__ import annotations

import asyncio
import json
import re
import time
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from pydantic import ValidationError

from director_agent.config import DirectorAgentConfig
from director_agent.otto_api import IngestedTurn, OttoApiClient, RespondedTurn
from director_agent.schemas import ClaimSubjectFields, DirectorTurnPlan

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover - fallback exists for minimal environments.
    yaml = None


class PlanValidationError(ValueError):
    pass


ANTHROPIC_MAX_ATTEMPTS = 3
ANTHROPIC_RETRY_DELAYS_SECONDS = (0.2, 0.5)
ANTHROPIC_TRANSIENT_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504, 529}
DIRECTOR_TURN_PLAN_MAX_TOKENS = 8000
DIRECTOR_VOICE_PHRASE_MAX_TOKENS = 200
DIRECTOR_SLOT_PATHS = [
    "function.name",
    "process.inventory",
    "scope.boundaries",
    "outcomes.business_outcomes",
    "ownership.roles",
    "people.key_people",
    "systems.systems_of_record",
    "frequency.volume",
    "handoffs.dependencies",
    "metrics.kpis",
    "friction.pain_points",
    "risk.spofs",
    "controls.compliance",
    "documentation.maturity",
    "priority.executive_priority",
    "variants.exceptions",
]
DIRECTOR_INTENT_NAMES = [
    "orient_interview",
    "discover_function",
    "discover_processes",
    "select_process_to_expand",
    "define_process_boundary",
    "capture_outcome",
    "capture_owner_roles",
    "capture_systems",
    "quantify_frequency_volume",
    "capture_dependencies",
    "capture_handoffs",
    "capture_metrics",
    "capture_friction",
    "capture_risk_spof",
    "capture_variants",
    "capture_controls",
    "capture_exec_priority",
    "capture_priority",
    "capture_documentation",
    "reconcile_conflict",
    "clarify_previous_question",
    "playback_summary",
    "open_questions_closeout",
]


class DirectorPlanner:
    def __init__(self, *, api: OttoApiClient, config: DirectorAgentConfig) -> None:
        self._api = api
        self._config = config
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0))

    @property
    def config(self) -> DirectorAgentConfig:
        return self._config

    async def aclose(self) -> None:
        await self._client.aclose()

    async def respond_turn(
        self,
        *,
        capture_session_id: str,
        turn: IngestedTurn,
        idempotency_key: str,
        on_planned_agent_utterance: Any | None = None,
        local_turn_correlation_id: str | None = None,
        pending_extraction_turns: list[int] | None = None,
        pending_slot_paths: list[str] | None = None,
        last_spoken_intent: str | None = None,
        extraction_window_id: str | None = None,
    ) -> RespondedTurn:
        return await self._api.respond_turn(
            capture_session_id=capture_session_id,
            turn=turn,
            idempotency_key=idempotency_key,
            on_planned_agent_utterance=on_planned_agent_utterance,
            local_turn_correlation_id=local_turn_correlation_id,
            pending_extraction_turns=pending_extraction_turns,
            pending_slot_paths=pending_slot_paths,
            last_spoken_intent=last_spoken_intent,
            extraction_window_id=extraction_window_id,
        )

    async def _anthropic_validated_plan(
        self,
        *,
        model: str,
        prompt_template_id: str,
        max_tokens: int,
        static_input: str,
        dynamic_input: str,
        current_evidence_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(2):
            repair_suffix = ""
            if last_error:
                repair_suffix = (
                    "\n\nThe previous response failed validation. "
                    f"Validation error: {last_error}. Call emit_director_turn_plan "
                    "again with corrected arguments only."
                )
            result = await self._anthropic_json(
                model=model,
                prompt_template_id=prompt_template_id,
                max_tokens=max_tokens,
                static_input=static_input,
                dynamic_input=dynamic_input + repair_suffix,
            )
            try:
                return {
                    **result,
                    "value": validate_plan(
                        result["value"],
                        current_evidence_ids=current_evidence_ids,
                    ),
                }
            except (PlanValidationError, ValidationError) as error:
                last_error = error
        if last_error:
            raise last_error
        raise PlanValidationError("Director planner returned no structured response.")

    async def _anthropic_json(
        self,
        *,
        model: str,
        prompt_template_id: str,
        max_tokens: int,
        static_input: str,
        dynamic_input: str,
    ) -> dict[str, Any]:
        started = time.time()
        for attempt in range(ANTHROPIC_MAX_ATTEMPTS):
            try:
                result = await self._anthropic_json_once(
                    model=model,
                    prompt_template_id=prompt_template_id,
                    max_tokens=max_tokens,
                    static_input=static_input,
                    dynamic_input=dynamic_input,
                    started=started,
                )
                result["metadata"]["anthropic_attempts"] = attempt + 1
                result["metadata"]["anthropic_retry_count"] = attempt
                return result
            except httpx.HTTPError as error:
                if not should_retry_anthropic_error(error, attempt=attempt):
                    raise
                await asyncio.sleep(anthropic_retry_delay(attempt))
        raise PlanValidationError("Anthropic planner retry loop exited without a response.")

    async def _anthropic_json_once(
        self,
        *,
        model: str,
        prompt_template_id: str,
        max_tokens: int,
        static_input: str,
        dynamic_input: str,
        started: float,
    ) -> dict[str, Any]:
        response = await self._client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "content-type": "application/json",
                "x-api-key": self._config.anthropic_api_key or "",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "prompt-caching-2024-07-31",
            },
            json={
                "model": model,
                "max_tokens": max_tokens,
                "tools": [
                    {
                        "name": "emit_director_turn_plan",
                        "description": "Return the complete DirectorTurnPlan for this director interview turn.",
                        "input_schema": director_turn_plan_tool_schema(),
                    }
                ],
                "tool_choice": {
                    "type": "tool",
                    "name": "emit_director_turn_plan",
                },
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": static_input,
                                "cache_control": {"type": "ephemeral"},
                            },
                            {
                                "type": "text",
                                "text": dynamic_input
                                + "\nCall emit_director_turn_plan with arguments matching the DirectorTurnPlan schema.",
                            },
                        ],
                    }
                ],
            },
        )
        response.raise_for_status()
        body = response.json()
        if body.get("stop_reason") == "max_tokens":
            raise PlanValidationError(
                f"Anthropic planner output was truncated at max_tokens={max_tokens}."
            )
        value = tool_use_input(body, "emit_director_turn_plan")
        usage = body.get("usage", {})
        serialized_value = json.dumps(value, sort_keys=True)
        input_tokens = int(
            usage.get("input_tokens", estimate_tokens(static_input + dynamic_input))
        )
        output_tokens = int(usage.get("output_tokens", estimate_tokens(serialized_value)))
        return {
            "text": serialized_value,
            "value": value,
            "metadata": anthropic_metadata(
                model=model,
                prompt_template_id=prompt_template_id,
                started=started,
                usage=usage,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            ),
        }

    async def _anthropic_text(
        self,
        *,
        model: str,
        prompt_template_id: str,
        max_tokens: int,
        static_input: str,
        dynamic_input: str,
    ) -> dict[str, Any]:
        started = time.time()
        for attempt in range(ANTHROPIC_MAX_ATTEMPTS):
            try:
                result = await self._anthropic_text_once(
                    model=model,
                    prompt_template_id=prompt_template_id,
                    max_tokens=max_tokens,
                    static_input=static_input,
                    dynamic_input=dynamic_input,
                    started=started,
                )
                result["metadata"]["anthropic_attempts"] = attempt + 1
                result["metadata"]["anthropic_retry_count"] = attempt
                return result
            except httpx.HTTPError as error:
                if not should_retry_anthropic_error(error, attempt=attempt):
                    raise
                await asyncio.sleep(anthropic_retry_delay(attempt))
        raise PlanValidationError("Anthropic voice retry loop exited without a response.")

    async def _anthropic_text_once(
        self,
        *,
        model: str,
        prompt_template_id: str,
        max_tokens: int,
        static_input: str,
        dynamic_input: str,
        started: float,
    ) -> dict[str, Any]:
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "stream": True,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": static_input,
                            "cache_control": {"type": "ephemeral"},
                        },
                        {"type": "text", "text": dynamic_input},
                    ],
                }
            ],
        }
        text_parts: list[str] = []
        usage: dict[str, Any] = {}
        cutoff = False
        async with self._client.stream(
            "POST",
            "https://api.anthropic.com/v1/messages",
            headers={
                "content-type": "application/json",
                "x-api-key": self._config.anthropic_api_key or "",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "prompt-caching-2024-07-31",
            },
            json=payload,
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                event = anthropic_stream_event(line)
                if event is None:
                    continue
                usage = merge_anthropic_stream_usage(usage, event)
                delta = event.get("delta") if isinstance(event, dict) else None
                if not isinstance(delta, dict) or delta.get("type") != "text_delta":
                    continue
                text_parts.append(str(delta.get("text") or ""))
                first_question = first_complete_question("".join(text_parts))
                if first_question:
                    text = first_question
                    cutoff = True
                    break
            else:
                text = limit_to_single_question("".join(text_parts).strip())
        input_tokens = int(usage.get("input_tokens", estimate_tokens(static_input + dynamic_input)))
        output_tokens = int(usage.get("output_tokens", estimate_tokens(text)))
        metadata = anthropic_metadata(
            model=model,
            prompt_template_id=prompt_template_id,
            started=started,
            usage=usage,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
        metadata["streaming"] = True
        metadata["stream_cutoff"] = "first_question" if cutoff else "message_stop"
        return {
            "text": text,
            "metadata": metadata,
        }


def should_retry_anthropic_error(error: httpx.HTTPError, *, attempt: int) -> bool:
    if attempt >= ANTHROPIC_MAX_ATTEMPTS - 1:
        return False
    if isinstance(error, httpx.HTTPStatusError):
        response = error.response
        return response is not None and response.status_code in ANTHROPIC_TRANSIENT_STATUS_CODES
    return isinstance(error, (httpx.TimeoutException, httpx.TransportError))


def anthropic_retry_delay(attempt: int) -> float:
    return ANTHROPIC_RETRY_DELAYS_SECONDS[
        min(attempt, len(ANTHROPIC_RETRY_DELAYS_SECONDS) - 1)
    ]


def configured_voice_phrase_timeout_ms(config: Any) -> int:
    value = getattr(config, "voice_phrase_timeout_ms", 2500)
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 2500
    return parsed if parsed > 0 else 2500


def validate_plan(
    value: Any,
    *,
    current_evidence_ids: list[str] | None = None,
) -> dict[str, Any]:
    plan = DirectorTurnPlan.model_validate(normalized_plan_value(value))
    validate_plan_claims(plan)
    dumped = plan.model_dump(
        mode="json",
        exclude_none=True,
    )
    if current_evidence_ids is not None:
        validate_plan_evidence(dumped, current_evidence_ids)
    return dumped


def normalized_plan_value(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    normalized = dict(value)
    for key in ("slot_updates", "claims", "tool_calls", "contradiction_signals", "ranked_intents"):
        if key not in normalized or normalized.get(key) is None:
            normalized[key] = []
    if "phase_transition_ready" not in normalized or normalized.get("phase_transition_ready") is None:
        normalized["phase_transition_ready"] = False
    if "chosen_intent" not in normalized or normalized.get("chosen_intent") is None:
        ranked = normalized.get("ranked_intents") or []
        if ranked:
            normalized["chosen_intent"] = ranked[0]
        else:
            normalized["chosen_intent"] = {
                "intent": "discover_processes",
                "score": 0.5,
                "reason": "Fallback intent added because the structured planner omitted chosen_intent.",
            }
    if not isinstance(normalized.get("planned_agent_utterance"), str) or not normalized.get(
        "planned_agent_utterance",
        "",
    ).strip():
        normalized["planned_agent_utterance"] = deterministic_phrase(normalized)
    return normalized


def compact_voice_context(context: dict[str, Any]) -> dict[str, Any]:
    return {
        "current_phase": context.get("current_phase") or "orient",
        "focus_candidate_process_id": context.get("focus_candidate_process_id"),
        "prior_intent": context.get("prior_intent"),
        "low_info_turn_count": context.get("low_info_turn_count") or 0,
        "recent_turns": list(context.get("recent_turns") or [])[-4:],
        "slots": [
            {
                "slot_path": slot.get("slot_path"),
                "status": slot.get("status"),
                "value": slot.get("value"),
                "confidence": slot.get("confidence"),
            }
            for slot in list(context.get("slots") or [])[:16]
        ],
        "candidate_processes": [
            {
                "id": candidate.get("id"),
                "proposed_name": candidate.get("proposed_name"),
                "frequency": candidate.get("frequency"),
                "complexity_hint": candidate.get("complexity_hint"),
            }
            for candidate in list(context.get("candidate_processes") or [])[:8]
        ],
    }


def compact_voice_plan(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "utterance_type": plan.get("utterance_type"),
        "current_phase": plan.get("current_phase"),
        "proposed_next_phase": plan.get("proposed_next_phase"),
        "phase_transition_ready": plan.get("phase_transition_ready"),
        "chosen_intent": plan.get("chosen_intent"),
        "focus_candidate_process_id": plan.get("focus_candidate_process_id"),
        "ranked_intents": [
            {
                "intent": intent.get("intent"),
                "target_slot": intent.get("target_slot"),
                "target_process": intent.get("target_process"),
                "score": intent.get("score"),
                "reason": intent.get("reason"),
                "style_hint": intent.get("style_hint"),
            }
            for intent in list(plan.get("ranked_intents") or [])[:3]
        ],
        "slot_updates": [
            {
                "slot_path": slot.get("slot_path"),
                "status": slot.get("status"),
                "confidence": slot.get("confidence"),
                "value": slot.get("value"),
            }
            for slot in list(plan.get("slot_updates") or [])[:8]
        ],
        "contradiction_signals": list(plan.get("contradiction_signals") or [])[:3],
        "claim_fields": [
            {
                "subject_type": claim.get("subject_type"),
                "field": claim.get("field"),
                "confidence": claim.get("confidence"),
            }
            for claim in list(plan.get("claims") or [])[:6]
        ],
    }


def validate_plan_evidence(plan: dict[str, Any], current_evidence_ids: list[str]) -> None:
    allowed = {str(evidence_id) for evidence_id in current_evidence_ids}
    for slot_update in plan.get("slot_updates") or []:
        evidence_ids = [str(evidence_id) for evidence_id in slot_update.get("evidence_ids") or []]
        reason = evidence_discipline_failure(evidence_ids, allowed)
        if reason:
            raise PlanValidationError(
                f"Director slot update {slot_update.get('slot_path')} has invalid evidence: {reason}"
            )
    for claim in plan.get("claims") or []:
        evidence_ids = [str(evidence_id) for evidence_id in claim.get("evidence_ids") or []]
        reason = evidence_discipline_failure(evidence_ids, allowed)
        if reason:
            raise PlanValidationError(
                "Director claim "
                f"{claim.get('subject_type')}.{claim.get('field')} has invalid evidence: {reason}"
            )


def evidence_discipline_failure(evidence_ids: list[str], allowed: set[str]) -> str | None:
    if not evidence_ids:
        return "assertions must cite evidence ids from the current turn"
    stale = [evidence_id for evidence_id in evidence_ids if evidence_id not in allowed]
    if stale:
        return f"assertion cited evidence outside the current turn: {', '.join(stale)}"
    return None


def merge_deterministic_extractions(
    plan: dict[str, Any],
    deterministic_facts: dict[str, Any],
) -> dict[str, Any]:
    merged = deepcopy(plan)
    merged["slot_updates"] = merge_by_identity(
        list(merged.get("slot_updates") or []),
        list(deterministic_facts.get("slot_updates") or []),
        lambda item: str(item.get("slot_path") or ""),
    )
    merged["tool_calls"] = merge_by_identity(
        list(merged.get("tool_calls") or []),
        list(deterministic_facts.get("tool_calls") or []),
        tool_call_identity,
    )
    merged["claims"] = merge_by_identity(
        list(merged.get("claims") or []),
        list(deterministic_facts.get("claims") or []),
        claim_identity,
    )
    return validate_plan(merged)


def merge_by_identity(
    primary: list[dict[str, Any]],
    fallback: list[dict[str, Any]],
    identity: Any,
) -> list[dict[str, Any]]:
    merged = [deepcopy(item) for item in primary]
    seen = {identity(item) for item in merged}
    for item in fallback:
        key = identity(item)
        if key and key not in seen:
            merged.append(deepcopy(item))
            seen.add(key)
    return merged


def tool_call_identity(tool_call: dict[str, Any]) -> str:
    return json.dumps(
        {
            "name": tool_call.get("name"),
            "arguments": tool_call.get("arguments") or {},
        },
        sort_keys=True,
        default=str,
    )


def claim_identity(claim: dict[str, Any]) -> str:
    return json.dumps(
        {
            "subject_type": claim.get("subject_type"),
            "subject_id": claim.get("subject_id"),
            "field": claim.get("field"),
            "value": claim.get("value"),
        },
        sort_keys=True,
        default=str,
    )


def enforce_phase_gate(plan: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    slots = {
        slot.get("slot_path"): slot.get("status")
        for slot in context.get("slots", [])
        if isinstance(slot, dict) and slot.get("slot_path")
    }
    slot_updates = [
        update
        for update in plan.get("slot_updates", [])
        if isinstance(update, dict)
    ]
    candidate_processes = context.get("candidate_processes") or []
    tool_calls = [
        call
        for call in plan.get("tool_calls", [])
        if isinstance(call, dict)
    ]
    raw_ranked_intents = [
        candidate
        for candidate in plan.get("ranked_intents", [])
        if isinstance(candidate, dict)
    ]
    exhausted = exhausted_probe_escalation(
        raw_ranked_intents,
        context.get("probe_firings") or [],
        slots,
        plan_evidence_ids(plan),
    )
    if exhausted["slot_updates"]:
        slot_updates = [*slot_updates, *exhausted["slot_updates"]]
    if exhausted["tool_calls"]:
        tool_calls = [*tool_calls, *exhausted["tool_calls"]]
    force_closeout = should_force_closeout(
        str(plan.get("utterance_type") or ""),
        context,
        slot_updates,
    )
    if force_closeout:
        gated_phase = "closeout"
    elif not slot_covered_for_phase("function.name", slots, slot_updates, allow_partial=True):
        gated_phase = "orient"
    elif not (
        candidate_processes
        or any(call.get("name") == "recordProcess" for call in tool_calls)
        or slot_covered_for_phase("process.inventory", slots, slot_updates, allow_partial=True)
    ):
        gated_phase = "inventory"
    elif not all(
        slot_covered_for_phase(slot_path, slots, slot_updates)
        for slot_path in [
            "scope.boundaries",
            "ownership.roles",
            "systems.systems_of_record",
        ]
    ):
        gated_phase = "expand"
    else:
        gated_phase = plan.get("proposed_next_phase") or plan.get("current_phase") or "orient"

    result = dict(plan)
    result["slot_updates"] = slot_updates
    result["tool_calls"] = tool_calls
    result["proposed_next_phase"] = gated_phase
    result["phase_transition_ready"] = gated_phase != result.get("current_phase")
    ranked_intents = apply_probe_controls(
        raw_ranked_intents,
        context.get("probe_firings") or [],
    )
    no_eligible_probe = len(ranked_intents) == 0 and len(raw_ranked_intents) > 0
    if force_closeout:
        closeout_intent = intent(
            "open_questions_closeout",
            None,
            1400,
            force_closeout,
            first_candidate_process_name(candidate_processes),
        )
        closeout_intent["style_hint"] = "forced_closeout"
        result["tool_calls"] = tool_calls + unresolved_priority_closeout_followups(
            slots,
            slot_updates,
            tool_calls,
        )
        result["chosen_intent"] = closeout_intent
        result["ranked_intents"] = ensure_intent_ranked(closeout_intent, ranked_intents)
        return validate_plan(with_controller_planned_utterance(plan, result))
    chosen_intent = result.get("chosen_intent")
    requested_intent = (
        cooldown_bridge_intent(gated_phase, chosen_intent, candidate_processes)
        if no_eligible_probe
        else chosen_intent if isinstance(chosen_intent, dict) else None
    )
    repaired = select_phase_gated_intent(
        gated_phase,
        slots,
        slot_updates,
        candidate_processes,
        ranked_intents,
        requested_intent,
    )
    result["chosen_intent"] = repaired["chosen_intent"]
    result["ranked_intents"] = repaired["ranked_intents"]
    return validate_plan(with_controller_planned_utterance(plan, result))


def with_controller_planned_utterance(
    original: dict[str, Any],
    controlled: dict[str, Any],
) -> dict[str, Any]:
    if not controller_changed_next_ask(original, controlled):
        return controlled
    result = dict(controlled)
    result["planned_agent_utterance"] = deterministic_phrase(result)
    return result


def controller_changed_next_ask(
    original: dict[str, Any],
    controlled: dict[str, Any],
) -> bool:
    original_intent = original.get("chosen_intent") or {}
    controlled_intent = controlled.get("chosen_intent") or {}
    return (
        original.get("proposed_next_phase") != controlled.get("proposed_next_phase")
        or original_intent.get("intent") != controlled_intent.get("intent")
        or original_intent.get("target_slot") != controlled_intent.get("target_slot")
        or original_intent.get("target_process") != controlled_intent.get("target_process")
    )


def slot_covered_for_phase(
    slot_path: str,
    current_slots: dict[str, Any],
    slot_updates: list[dict[str, Any]],
    *,
    allow_partial: bool = False,
) -> bool:
    status = current_slots.get(slot_path)
    for update in reversed(slot_updates):
        if update.get("slot_path") == slot_path:
            status = update.get("status")
            break
    return status in {"filled", "asked_unknown"} or (
        allow_partial and status == "partial"
    )


def select_phase_gated_intent(
    phase: str,
    current_slots: dict[str, Any],
    slot_updates: list[dict[str, Any]],
    candidate_processes: list[Any],
    ranked_intents: list[dict[str, Any]],
    requested_intent: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fallback_intent = requested_intent or (
        ranked_intents[0]
        if ranked_intents
        else phase_repair_intent(phase, current_slots, slot_updates, candidate_processes)
    )
    if phase_allows_intent(phase, fallback_intent):
        ranked = ranked_intents or [fallback_intent]
        return {
            "chosen_intent": fallback_intent,
            "ranked_intents": ensure_intent_ranked(fallback_intent, ranked),
        }
    repaired_intent = phase_repair_intent(
        phase,
        current_slots,
        slot_updates,
        candidate_processes,
    )
    existing_intent = next(
        (
            candidate
            for candidate in ranked_intents
            if candidate.get("intent") == repaired_intent.get("intent")
            and candidate.get("target_slot") == repaired_intent.get("target_slot")
        ),
        None,
    )
    if existing_intent:
        chosen_intent = {
            **existing_intent,
            "score": max(float(existing_intent.get("score", 0)), float(repaired_intent["score"])),
            "reason": repaired_intent["reason"],
        }
        if "target_process" not in chosen_intent and repaired_intent.get("target_process"):
            chosen_intent["target_process"] = repaired_intent["target_process"]
    else:
        chosen_intent = repaired_intent
    return {
        "chosen_intent": chosen_intent,
        "ranked_intents": ensure_intent_ranked(chosen_intent, ranked_intents),
    }


def phase_allows_intent(phase: str, candidate: dict[str, Any]) -> bool:
    allowed = {
        "orient": {
            "orient_interview",
            "discover_function",
            "discover_processes",
            "clarify_previous_question",
        },
        "inventory": {"discover_processes", "clarify_previous_question"},
        "expand": {
            "select_process_to_expand",
            "define_process_boundary",
            "capture_outcome",
            "capture_owner_roles",
            "capture_systems",
            "quantify_frequency_volume",
            "reconcile_conflict",
            "clarify_previous_question",
        },
        "enrich": {
            "capture_dependencies",
            "capture_handoffs",
            "capture_metrics",
            "capture_friction",
            "capture_risk_spof",
            "capture_variants",
            "capture_controls",
            "capture_exec_priority",
            "capture_priority",
            "capture_documentation",
            "reconcile_conflict",
            "clarify_previous_question",
        },
        "closeout": {"playback_summary", "open_questions_closeout", "reconcile_conflict"},
    }
    return candidate.get("intent") in allowed.get(phase, set())


def cooldown_bridge_intent(
    phase: str,
    blocked_intent: dict[str, Any] | None,
    candidate_processes: list[Any],
) -> dict[str, Any]:
    if phase == "closeout":
        return intent(
            "playback_summary",
            None,
            100,
            "No closeout probe is currently eligible; summarize instead of repeating.",
            first_candidate_process_name(candidate_processes),
            "cooldown_bridge",
        )
    return intent(
        "clarify_previous_question",
        None,
        650,
        "All matching probes are in cooldown or exhausted; broaden instead of repeating the prior question.",
        (
            blocked_intent.get("target_process")
            if isinstance(blocked_intent, dict)
            else None
        )
        or first_candidate_process_name(candidate_processes),
        append_style_hint(
            str(blocked_intent.get("style_hint") or "")
            if isinstance(blocked_intent, dict)
            else "",
            "broaden_low_info",
        ),
    )


def phase_repair_intent(
    phase: str,
    current_slots: dict[str, Any],
    slot_updates: list[dict[str, Any]],
    candidate_processes: list[Any],
) -> dict[str, Any]:
    target_process = first_candidate_process_name(candidate_processes)
    if phase == "orient":
        return intent(
            "discover_function",
            "function.name",
            1300,
            "Phase gate requires the director remit before process drilldown.",
        )
    if phase == "inventory":
        return intent(
            "discover_processes",
            "process.inventory",
            1300,
            "Phase gate requires a process inventory before selecting one to expand.",
        )
    if phase == "expand":
        core_slots = [
            "scope.boundaries",
            "ownership.roles",
            "systems.systems_of_record",
        ]
        missing_core_slot = next(
            (
                slot_path
                for slot_path in core_slots
                if not slot_covered_for_phase(slot_path, current_slots, slot_updates)
            ),
            None,
        )
        if missing_core_slot:
            return intent(
                intent_name_for_slot(missing_core_slot),
                missing_core_slot,
                1300,
                "Phase gate requires core process coverage before enrichment or closeout.",
                target_process,
            )
        return intent(
            "select_process_to_expand",
            "scope.boundaries",
            1250,
            "Phase gate requires choosing a process to expand.",
            target_process,
        )
    if phase == "enrich":
        enrich_slots = [
            "handoffs.dependencies",
            "metrics.kpis",
            "friction.pain_points",
            "risk.spofs",
            "priority.executive_priority",
        ]
        missing_enrich_slot = next(
            (
                slot_path
                for slot_path in enrich_slots
                if not slot_covered_for_phase(slot_path, current_slots, slot_updates)
            ),
            None,
        )
        target_slot = missing_enrich_slot or "metrics.kpis"
        return intent(
            intent_name_for_slot(target_slot),
            target_slot,
            1200,
            "Phase gate keeps the interview in enrichment until high-value operating context is covered.",
            target_process,
        )
    return intent(
        "playback_summary",
        None,
        1100,
        "Required coverage is present; summarize and close the interview.",
    )


def first_candidate_process_name(candidate_processes: list[Any]) -> str | None:
    if not candidate_processes:
        return None
    first = candidate_processes[0]
    if isinstance(first, dict):
        return first.get("proposed_name") or first.get("proposedName")
    return None


def intent_name_for_slot(slot_path: str) -> str:
    return {
        "function.name": "discover_function",
        "process.inventory": "discover_processes",
        "scope.boundaries": "define_process_boundary",
        "outcomes.business_outcomes": "capture_outcome",
        "ownership.roles": "capture_owner_roles",
        "people.key_people": "capture_owner_roles",
        "systems.systems_of_record": "capture_systems",
        "frequency.volume": "quantify_frequency_volume",
        "handoffs.dependencies": "capture_dependencies",
        "metrics.kpis": "capture_metrics",
        "friction.pain_points": "capture_friction",
        "risk.spofs": "capture_risk_spof",
        "controls.compliance": "capture_controls",
        "documentation.maturity": "capture_documentation",
        "priority.executive_priority": "capture_priority",
        "variants.exceptions": "capture_variants",
    }.get(slot_path, "open_questions_closeout")


def ensure_intent_ranked(
    chosen_intent: dict[str, Any],
    ranked_intents: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rest = [
        candidate
        for candidate in ranked_intents
        if candidate.get("intent") != chosen_intent.get("intent")
        or candidate.get("target_slot") != chosen_intent.get("target_slot")
    ]
    return [chosen_intent, *rest]


def validate_plan_claims(plan: DirectorTurnPlan) -> None:
    allowlist = load_claim_allowlist()
    by_subject = {
        subject.subject_type: {field.field: field for field in subject.fields}
        for subject in allowlist.allowed
    }
    for claim in plan.claims:
        if claim.subject_type in {"process", "process_version"}:
            raise PlanValidationError(
                "Director Phase 1 claims must target candidate_process subjects until promotion."
            )
        field = by_subject.get(claim.subject_type, {}).get(claim.field)
        if field is None:
            raise PlanValidationError(
                f"Unsupported claim field: {claim.subject_type}.{claim.field}"
            )
        allowed_types = field.value_schema.type
        allowed = set(allowed_types if isinstance(allowed_types, list) else [allowed_types])
        actual = claim_value_type(claim.value)
        if actual not in allowed:
            raise PlanValidationError(
                f"Invalid value type for {claim.subject_type}.{claim.field}: "
                f"expected {'|'.join(sorted(allowed))}, got {actual}"
            )
        if field.value_schema.required and actual == "object":
            missing = [
                key
                for key in field.value_schema.required
                if not isinstance(claim.value, dict) or claim.value.get(key) is None
            ]
            if missing:
                raise PlanValidationError(
                    f"Missing required keys for {claim.subject_type}.{claim.field}: "
                    f"{', '.join(missing)}"
                )


_claim_allowlist: ClaimSubjectFields | None = None


def load_claim_allowlist() -> ClaimSubjectFields:
    global _claim_allowlist
    if _claim_allowlist is None:
        _claim_allowlist = ClaimSubjectFields.model_validate_json(
            read_repo_file("schemas/claim-subject-fields.json")
        )
    return _claim_allowlist


def claim_value_type(value: Any) -> str:
    if isinstance(value, list):
        return "array"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "number"
    if isinstance(value, str):
        return "string"
    return "object"


def deterministic_plan(
    utterance: str,
    evidence_ids: list[str],
    context: dict[str, Any],
) -> dict[str, Any]:
    text = utterance.strip()
    lower = text.lower()
    utterance_type = classify_utterance(text)
    current_phase = context.get("current_phase") or "orient"
    candidates = context.get("candidate_processes") or []
    known_processes = [candidate.get("proposed_name") for candidate in candidates if candidate.get("proposed_name")]
    focus_candidate_process_name = focus_process_name_from_context(
        candidates,
        context.get("focus_candidate_process_id"),
    )
    current_slots = current_slot_statuses(context)
    function_name = extract_function_name(text)
    process_names = extract_process_names(text)
    systems = extract_systems(text)
    frequency = extract_frequency(text)
    volume = extract_volume(text)
    outcome = extract_outcome(text)
    metric = extract_metric(text)
    dependency = extract_dependency(text)
    process_relationship = extract_process_relationship(text, [*process_names, *known_processes])
    control = extract_control(text)
    executive_priority = extract_executive_priority(text)
    variant = extract_variant(text)
    role_name = extract_role(text)
    person_name = extract_person(text)
    pain = bool(re.search(r"\b(manual|slow|delay|bottleneck|rework|cleanup|pain|painful|break|stuck)\b", lower))
    spof = extract_spof_risk(text)
    documentation_maturity = extract_documentation_maturity(text)
    focus_process = choose_focus_process(
        process_names,
        known_processes,
        text,
        focus_candidate_process_name,
    )

    slot_updates: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    if function_name:
        slot_updates.append(slot_update("function.name", {"function_name": function_name}, evidence_ids, 0.78))
    if process_names:
        slot_updates.append(slot_update("process.inventory", {"processes": process_names}, evidence_ids, 0.82))
    for process_name in process_names:
        tool_calls.append(
            {
                "name": "recordProcess",
                "arguments": {
                    "name": process_name,
                    "proposedFunction": function_name,
                    "frequency": frequency,
                    "confidence": 0.78,
                },
            }
        )
    if focus_process and (len(process_names) == 1 or has_boundary_signal(text)):
        slot_updates.append(
            slot_update(
                "scope.boundaries",
                process_boundary_value([focus_process], text),
                evidence_ids,
                0.82,
            )
        )
    if (frequency or volume) and utterance_type != "contradiction":
        frequency_value: dict[str, Any] = {}
        if frequency:
            frequency_value["frequency"] = frequency
        if volume:
            frequency_value["volume"] = volume
        slot_updates.append(slot_update("frequency.volume", frequency_value, evidence_ids, 0.78))
        if volume and focus_process:
            tool_calls.append(
                {
                    "name": "recordCandidateProcessClaim",
                    "arguments": {
                        "targetProcess": focus_process,
                        "field": "volume",
                        "value": volume,
                        "confidence": 0.74,
                    },
                }
            )
    if outcome:
        slot_updates.append(slot_update("outcomes.business_outcomes", {"outcome": outcome}, evidence_ids, 0.72))
        if focus_process:
            tool_calls.append(
                {
                    "name": "recordCandidateProcessClaim",
                    "arguments": {
                        "targetProcess": focus_process,
                        "field": "business_outcome",
                        "value": {"outcome": outcome},
                        "confidence": 0.72,
                    },
                }
            )
    if systems:
        for system in systems:
            tool_calls.append({"name": "recordSystem", "arguments": {"name": system}})
        slot_updates.append(slot_update("systems.systems_of_record", {"systems": systems}, evidence_ids, 0.8))
    if metric:
        slot_updates.append(slot_update("metrics.kpis", {"metric": metric}, evidence_ids, 0.7))
        if focus_process:
            tool_calls.append(
                {
                    "name": "recordCandidateProcessClaim",
                    "arguments": {
                        "targetProcess": focus_process,
                        "field": "kpi",
                        "value": {"name": metric},
                        "confidence": 0.7,
                    },
                }
            )
    if dependency:
        slot_updates.append(slot_update("handoffs.dependencies", {"dependency": dependency}, evidence_ids, 0.7))
        if focus_process:
            tool_calls.append(
                {
                    "name": "recordCandidateProcessClaim",
                    "arguments": {
                        "targetProcess": focus_process,
                        "field": "upstream_dependency",
                        "value": {"name": dependency},
                        "confidence": 0.7,
                    },
                }
            )
    if process_relationship:
        slot_updates.append(
            slot_update(
                "handoffs.dependencies",
                {"relationship": process_relationship},
                evidence_ids,
                0.72,
            )
        )
        tool_calls.append(
            {
                "name": "recordCandidateProcessClaim",
                "arguments": {
                    "targetProcess": process_relationship.get("source_process") or focus_process,
                    "field": "process_relationship",
                    "value": process_relationship,
                    "confidence": 0.72,
                },
            }
        )
    if role_name:
        slot_updates.append(slot_update("ownership.roles", {"roles": [{"name": role_name}]}, evidence_ids, 0.72))
    if person_name:
        tool_calls.append(
            {
                "name": "recordPerson",
                "arguments": {"name": person_name, "roleName": role_name},
            }
        )
        slot_updates.append(slot_update("people.key_people", {"person": person_name}, evidence_ids, 0.7))
    if pain:
        tool_calls.append(
            {
                "name": "recordPainPoint",
                "arguments": {"text": text, "targetProcess": focus_process},
            }
        )
        slot_updates.append(slot_update("friction.pain_points", {"pain_point": text}, evidence_ids, 0.78))
    if spof:
        tool_calls.append(
            {
                "name": "recordSpof",
                "arguments": {"text": spof, "targetProcess": focus_process},
            }
        )
        slot_updates.append(slot_update("risk.spofs", {"spof": spof}, evidence_ids, 0.76))
    if documentation_maturity:
        slot_updates.append(
            slot_update(
                "documentation.maturity",
                {"maturity_signal": documentation_maturity},
                evidence_ids,
                0.72,
            )
        )
    if control:
        slot_updates.append(slot_update("controls.compliance", {"control": control}, evidence_ids, 0.72))
        if focus_process:
            tool_calls.append(
                {
                    "name": "recordCandidateProcessClaim",
                    "arguments": {
                        "targetProcess": focus_process,
                        "field": "control",
                        "value": {"control": control},
                        "confidence": 0.72,
                    },
                }
            )
    if executive_priority:
        slot_updates.append(slot_update("priority.executive_priority", {"priority": executive_priority}, evidence_ids, 0.72))
        if focus_process:
            tool_calls.append(
                {
                    "name": "recordCandidateProcessClaim",
                    "arguments": {
                        "targetProcess": focus_process,
                        "field": "exec_priority",
                        "value": {"priority": executive_priority},
                        "confidence": 0.72,
                    },
                }
            )
    if variant:
        slot_updates.append(slot_update("variants.exceptions", {"variant": variant}, evidence_ids, 0.72))
        if focus_process:
            tool_calls.append(
                {
                    "name": "recordCandidateProcessClaim",
                    "arguments": {
                        "targetProcess": focus_process,
                        "field": "variant",
                        "value": {"variant": variant},
                        "confidence": 0.72,
                    },
                }
            )
    conflicting_slot = (
        contradiction_target_slot(text, context.get("prior_intent"))
        if utterance_type == "contradiction"
        else None
    )
    if conflicting_slot:
        slot_updates.append(
            slot_update(
                conflicting_slot,
                {"conflict": text, "source": "director_contradiction"},
                evidence_ids,
                0.5,
                "conflicting",
            )
        )
    unknown_slot = (
        slot_for_unknown_response(context.get("prior_intent"), current_phase)
        if utterance_type == "dont_know"
        else None
    )
    if unknown_slot and should_mark_slot_asked_unknown(current_slots, slot_updates, unknown_slot):
        slot_updates.append(
            slot_update(
                unknown_slot,
                {"response": "unknown", "source": "director_dont_know"},
                evidence_ids,
                1,
                "asked_unknown",
            )
        )

    proposed_next_phase = next_phase(current_phase, utterance_type, function_name, process_names, known_processes)
    chosen_intent = choose_intent(
        utterance_type,
        process_names,
        known_processes,
        focus_process,
        function_name,
        unknown_slot,
        current_phase,
        conflicting_slot,
        current_slots,
    )
    if (
        utterance_type in {"non_answer", "dont_know"}
        and int(context.get("low_info_turn_count") or 0) >= 1
    ):
        chosen_intent = {
            **chosen_intent,
            "style_hint": append_style_hint(
                str(chosen_intent.get("style_hint") or ""),
                "broaden_low_info",
            ),
        }
    ranked = [chosen_intent]
    if chosen_intent["intent"] != "discover_processes":
        ranked.append(intent("discover_processes", "process.inventory", 800, "Process inventory remains valuable."))
    exhausted = exhausted_probe_escalation(
        ranked,
        context.get("probe_firings") or [],
        current_slots,
        evidence_ids,
    )
    slot_updates.extend(exhausted["slot_updates"])
    tool_calls.extend(exhausted["tool_calls"])
    ranked = apply_probe_controls(ranked, context.get("probe_firings") or [])
    force_closeout = should_force_closeout(utterance_type, context, slot_updates)
    if force_closeout:
        proposed_next_phase = "closeout"
        chosen_intent = intent(
            "open_questions_closeout",
            None,
            1400,
            force_closeout,
            focus_process,
        )
        chosen_intent["style_hint"] = "forced_closeout"
        tool_calls.extend(
            unresolved_priority_closeout_followups(
                current_slots,
                slot_updates,
                tool_calls,
            )
        )
        ranked = ensure_intent_ranked(chosen_intent, ranked)
    elif ranked:
        chosen_intent = next(
            (candidate for candidate in ranked if candidate["intent"] == chosen_intent["intent"]),
            ranked[0],
        )
    else:
        chosen_intent = cooldown_bridge_intent(
            proposed_next_phase,
            chosen_intent,
            context.get("candidate_processes") or [],
        )
        ranked = [chosen_intent]

    plan = {
        "utterance_type": utterance_type,
        "slot_updates": slot_updates,
        "claims": [],
        "tool_calls": tool_calls,
        "contradiction_signals": contradiction_signals(utterance_type, text),
        "current_phase": current_phase,
        "proposed_next_phase": proposed_next_phase,
        "phase_transition_ready": proposed_next_phase != current_phase,
        "ranked_intents": ranked,
        "chosen_intent": chosen_intent,
    }
    plan["planned_agent_utterance"] = deterministic_phrase(plan)
    return plan


def should_force_closeout(
    utterance_type: str,
    context: dict[str, Any],
    slot_updates: list[dict[str, Any]],
) -> str | None:
    projected_low_info_turns = int(context.get("low_info_turn_count") or 0) + (
        1 if utterance_type in {"greeting", "meta_question", "non_answer", "dont_know", "off_topic", "clarification_request"} else 0
    )
    if projected_low_info_turns >= 3:
        return "Forced closeout after three low-information director turns; surface unresolved gaps instead of repeating probes."
    turn_index = context.get("turn_index")
    last_new_slot_turn_index = context.get("last_new_slot_turn_index")
    if (
        isinstance(turn_index, int)
        and isinstance(last_new_slot_turn_index, int)
        and not has_meaningful_new_slot_coverage(
            current_slot_statuses(context),
            slot_updates,
        )
        and turn_index - last_new_slot_turn_index >= 3
    ):
        return "Forced closeout after three turns without new slot coverage; surface unresolved gaps before ending."
    return None


def current_slot_statuses(context: dict[str, Any]) -> dict[str, Any]:
    focus_candidate_process_id = context.get("focus_candidate_process_id")
    statuses: dict[str, Any] = {}
    slots = [slot for slot in context.get("slots", []) if isinstance(slot, dict)]
    for scope in (None, focus_candidate_process_id):
        for slot in slots:
            if not slot.get("slot_path") or slot.get("candidate_process_id") != scope:
                continue
            statuses[str(slot.get("slot_path"))] = slot.get("status")
    return statuses


def plan_evidence_ids(plan: dict[str, Any]) -> list[str]:
    evidence_ids: set[str] = set()
    for update in plan.get("slot_updates", []):
        if not isinstance(update, dict):
            continue
        for evidence_id in update.get("evidence_ids", []) or []:
            if isinstance(evidence_id, str):
                evidence_ids.add(evidence_id)
    for claim in plan.get("claims", []):
        if not isinstance(claim, dict):
            continue
        for evidence_id in claim.get("evidence_ids", []) or []:
            if isinstance(evidence_id, str):
                evidence_ids.add(evidence_id)
    return sorted(evidence_ids)


def has_meaningful_new_slot_coverage(
    current_slots: dict[str, Any],
    slot_updates: list[dict[str, Any]],
) -> bool:
    return any(
        slot_coverage_progress_rank(update.get("status"))
        > slot_coverage_progress_rank(current_slots.get(str(update.get("slot_path"))))
        for update in slot_updates
        if isinstance(update, dict)
    )


def slot_coverage_progress_rank(status: Any) -> int:
    if status == "filled":
        return 3
    if status == "asked_unknown":
        return 2
    if status in {"partial", "conflicting"}:
        return 1
    return 0


PRIORITY_CLOSEOUT_SLOTS = [
    ("function.name", "Director remit and business function", 110),
    ("process.inventory", "High-level process inventory", 105),
    ("scope.boundaries", "Scope and boundaries", 100),
    ("outcomes.business_outcomes", "Business outcomes", 98),
    ("ownership.roles", "Ownership and participating roles", 95),
    ("people.key_people", "People", 90),
]


def unresolved_priority_closeout_followups(
    current_slots: dict[str, Any],
    slot_updates: list[dict[str, Any]],
    existing_tool_calls: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    existing_titles = {
        str((call.get("arguments") or {}).get("title"))
        for call in existing_tool_calls
        if call.get("name") == "createFollowUpTask"
        and (call.get("arguments") or {}).get("title")
    }
    followups: list[dict[str, Any]] = []
    for slot_path, label, priority in PRIORITY_CLOSEOUT_SLOTS:
        updated_status = next(
            (
                update.get("status")
                for update in reversed(slot_updates)
                if update.get("slot_path") == slot_path
            ),
            None,
        )
        status = updated_status or current_slots.get(slot_path) or "empty"
        if status in {"filled", "asked_unknown"}:
            continue
        title = f"Resolve director interview gap: {label}"
        if title in existing_titles:
            continue
        existing_titles.add(title)
        followups.append(
            {
                "name": "createFollowUpTask",
                "arguments": {
                    "taskType": "open_question",
                    "title": title,
                    "description": (
                        "The director interview reached forced closeout before "
                        f'"{label}" was covered. Capture this before relying on the process map.'
                    ),
                    "targetType": "director_slot",
                    "priority": priority / 100,
                    "targetSlot": slot_path,
                    "source": "forced_closeout",
                },
            }
        )
    return followups


DEFAULT_PROBE_CONTROLLER = {
    "discover_function": {"target_slot": "function.name", "cooldown_seconds": 45, "max_fires": 3},
    "discover_processes": {"target_slot": "process.inventory", "cooldown_seconds": 60, "max_fires": 3},
    "define_process_boundary": {"target_slot": "scope.boundaries", "cooldown_seconds": 75, "max_fires": 2},
    "capture_owner_roles": {"target_slot": "ownership.roles", "cooldown_seconds": 75, "max_fires": 2},
    "capture_systems": {"target_slot": "systems.systems_of_record", "cooldown_seconds": 75, "max_fires": 2},
    "capture_outcome": {"target_slot": "outcomes.business_outcomes", "cooldown_seconds": 75, "max_fires": 2},
    "quantify_frequency_volume": {"target_slot": "frequency.volume", "cooldown_seconds": 75, "max_fires": 2},
    "capture_dependencies": {"target_slot": "handoffs.dependencies", "cooldown_seconds": 90, "max_fires": 2},
    "capture_metrics": {"target_slot": "metrics.kpis", "cooldown_seconds": 90, "max_fires": 2},
    "capture_friction": {"target_slot": "friction.pain_points", "cooldown_seconds": 90, "max_fires": 2},
    "capture_risk_spof": {"target_slot": "risk.spofs", "cooldown_seconds": 120, "max_fires": 2},
    "capture_documentation": {"target_slot": "documentation.maturity", "cooldown_seconds": 120, "max_fires": 2},
}


def load_probe_controller(relative_path: str = "probes/director.yaml") -> dict[str, dict[str, Any]]:
    if yaml is None:
        return deepcopy(DEFAULT_PROBE_CONTROLLER)
    try:
        raw = (Path(__file__).resolve().parents[3] / relative_path).read_text()
        document = yaml.safe_load(raw) or {}
    except Exception:
        return deepcopy(DEFAULT_PROBE_CONTROLLER)

    controller: dict[str, dict[str, Any]] = {}
    for probe in document.get("probes") or []:
        if not isinstance(probe, dict):
            continue
        probe_intent = probe.get("intent")
        target_slots = probe.get("target_slots") or []
        if not probe_intent or not target_slots:
            continue
        controller[str(probe_intent)] = {
            "target_slot": str(target_slots[0]),
            "cooldown_seconds": int(probe.get("cooldown_seconds", 90)),
            "max_fires": int(probe.get("max_fires", 2)),
            "base_priority": int(probe.get("base_priority", 0)),
        }
    return controller or deepcopy(DEFAULT_PROBE_CONTROLLER)


PROBE_CONTROLLER = load_probe_controller()


def apply_probe_controls(
    intents: list[dict[str, Any]],
    probe_firings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    summaries = probe_summaries(probe_firings)
    now = time.time()
    ranked: list[dict[str, Any]] = []
    for candidate in intents:
        if candidate.get("intent") in {"orient_interview", "clarify_previous_question", "playback_summary", "open_questions_closeout", "reconcile_conflict"}:
            ranked.append(candidate)
            continue
        config = PROBE_CONTROLLER.get(str(candidate.get("intent")), {})
        target_slot = candidate.get("target_slot") or config.get("target_slot")
        max_fires = int(config.get("max_fires", 2))
        cooldown_seconds = int(config.get("cooldown_seconds", 90))
        intent_summary = summaries.get(f"intent:{candidate.get('intent')}", {"count": 0})
        slot_summary = summaries.get(f"slot:{target_slot}", {"count": 0}) if target_slot else {"count": 0}
        count = max(int(intent_summary.get("count", 0)), int(slot_summary.get("count", 0)))
        last_fired_at = latest_timestamp(intent_summary.get("last"), slot_summary.get("last"))
        if count >= max_fires:
            continue
        if last_fired_at is not None and now - last_fired_at < cooldown_seconds:
            continue
        adjusted = dict(candidate)
        if count == max_fires - 1:
            adjusted["score"] = float(adjusted.get("score", 0)) * 0.5
            adjusted["style_hint"] = append_style_hint(str(adjusted.get("style_hint") or ""), "last_attempt")
        ranked.append(adjusted)
    return sorted(ranked, key=lambda item: float(item.get("score", 0)), reverse=True)


def exhausted_probe_escalation(
    intents: list[dict[str, Any]],
    probe_firings: list[dict[str, Any]],
    current_slots: dict[str, Any],
    evidence_ids: list[str],
) -> dict[str, list[dict[str, Any]]]:
    summaries = probe_summaries(probe_firings)
    slot_updates: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    seen_slots: set[str] = set()
    for candidate in intents:
        if candidate.get("intent") in {"orient_interview", "clarify_previous_question", "playback_summary", "open_questions_closeout", "reconcile_conflict"}:
            continue
        config = PROBE_CONTROLLER.get(str(candidate.get("intent")), {})
        target_slot = candidate.get("target_slot") or config.get("target_slot")
        if not target_slot or target_slot in seen_slots:
            continue
        if current_slots.get(str(target_slot)) in {"filled", "asked_unknown"}:
            continue
        max_fires = int(config.get("max_fires", 2))
        intent_summary = summaries.get(f"intent:{candidate.get('intent')}", {"count": 0})
        slot_summary = summaries.get(f"slot:{target_slot}", {"count": 0})
        count = max(int(intent_summary.get("count", 0)), int(slot_summary.get("count", 0)))
        if count < max_fires:
            continue
        seen_slots.add(str(target_slot))
        slot_updates.append(
            slot_update(
                str(target_slot),
                {
                    "response": "unknown",
                    "source": "probe_max_fires",
                    "exhausted_intent": candidate.get("intent"),
                },
                evidence_ids,
                1,
                "asked_unknown",
            )
        )
        tool_calls.append(
            {
                "name": "createFollowUpTask",
                "arguments": {
                    "taskType": "open_question",
                    "title": f"Resolve unanswered director slot: {target_slot}",
                    "description": (
                        f"The {candidate.get('intent')} probe reached max_fires without "
                        "enough coverage. Capture this later before relying on the process map."
                    ),
                    "targetType": "director_slot",
                    "priority": 2,
                    "targetSlot": target_slot,
                },
            }
        )
    return {"slot_updates": slot_updates, "tool_calls": tool_calls}


def probe_summaries(probe_firings: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    summaries: dict[str, dict[str, Any]] = {}
    for firing in probe_firings:
        fired_at = parse_time(firing.get("fired_at"))
        bump_summary(summaries, f"intent:{firing.get('probe_id')}", fired_at)
        if firing.get("target_slot"):
            bump_summary(summaries, f"slot:{firing.get('target_slot')}", fired_at)
    return summaries


def bump_summary(summaries: dict[str, dict[str, Any]], key: str, fired_at: float | None) -> None:
    if key.endswith(":None") or key == "intent:":
        return
    summary = summaries.setdefault(key, {"count": 0, "last": None})
    summary["count"] = int(summary["count"]) + 1
    summary["last"] = latest_timestamp(summary.get("last"), fired_at)


def parse_time(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def latest_timestamp(a: Any, b: Any) -> float | None:
    values = [value for value in [a, b] if isinstance(value, (int, float))]
    return max(values) if values else None


def append_style_hint(style_hint: str, hint: str) -> str:
    if not style_hint:
        return hint
    if hint in style_hint:
        return style_hint
    return f"{style_hint},{hint}"


def deterministic_phrase(plan: dict[str, Any]) -> str:
    return limit_to_single_question(_deterministic_phrase(plan))


def planned_utterance_from_plan(plan: dict[str, Any]) -> str | None:
    value = plan.get("planned_agent_utterance")
    if not isinstance(value, str) or not value.strip():
        return None
    return limit_to_single_question(value)


def brain_planned_voice_metadata(
    started: float,
    plan: dict[str, Any],
    output_text: str,
    brain_metadata: dict[str, Any],
) -> dict[str, Any]:
    metadata = metadata_for(
        prompt_template_id="director.voice.phrase-intent",
        model=str(brain_metadata.get("model") or "brain-planned-voice"),
        started=started,
        input_text=json.dumps(
            {
                "chosen_intent": plan.get("chosen_intent"),
                "planned_agent_utterance": plan.get("planned_agent_utterance"),
            },
            sort_keys=True,
        ),
        output_text=output_text,
    )
    return {
        **metadata,
        "source": "brain_planned_utterance",
        "utterance_source": "brain_planned_utterance",
        "llm_call_elided": True,
        "brain_model": brain_metadata.get("model"),
    }


def limit_to_single_question(utterance: str) -> str:
    normalized = re.sub(r"\s+", " ", utterance).strip()
    first_question = normalized.find("?")
    if first_question == -1:
        return normalized
    first_question_only = normalized[: first_question + 1]
    return re.sub(
        r"(?:,\s+|\s+)and\s+(?:what|who|which|where|how|when|why|is|are|does|do|can|could|would|should)\b[^?]*\?$",
        "?",
        first_question_only,
        flags=re.I,
    )


def first_complete_question(text: str) -> str | None:
    normalized = re.sub(r"\s+", " ", text).strip()
    if "?" not in normalized:
        return None
    return limit_to_single_question(normalized)


def _deterministic_phrase(plan: dict[str, Any]) -> str:
    utterance_type = plan.get("utterance_type")
    chosen = plan.get("chosen_intent") or {}
    target = chosen.get("target_process")
    if chosen.get("intent") in {"open_questions_closeout", "playback_summary"}:
        return intent_phrase(plan, target)
    if utterance_type == "greeting":
        return "Hi. I'm going to build a high-level map of the processes you own. To start, what part of the business do you oversee?"
    if utterance_type == "meta_question":
        return (
            "We're mapping how your function operates so Otto can turn it into "
            f"evidence-backed process cards. {intent_phrase(plan, target)}"
        )
    if utterance_type in {"non_answer", "dont_know"}:
        if "broaden_low_info" in str(chosen.get("style_hint") or ""):
            return maybe_last_attempt(
                plan,
                "Let's make this easier: what are the three things your team is asked to do most often in a normal week?",
            )
        return maybe_last_attempt(
            plan,
            "No worries. What are the three recurring things your team gets asked to handle most often?",
        )
    if utterance_type == "clarification_request":
        if chosen.get("target_slot") == "systems.systems_of_record":
            if target:
                return f"By systems of record, I mean the tools people trust as the source of truth, like Salesforce, NetSuite, or Sheets. Which systems does {target} rely on?"
            return "By systems of record, I mean the tools people trust as the source of truth, like Salesforce, NetSuite, or Sheets. Which systems does this work rely on?"
        return "I mean the recurring work your team owns: who is involved, the systems it runs through, and the outcome it produces. What part should we start with?"
    if utterance_type == "off_topic":
        return "Happy to come back to that later. For now, what recurring process should we map next?"
    if utterance_type == "correction":
        if target:
            return f"Got it, I'll treat that as a correction for {target}. What should the ownership or process detail be instead?"
        return "Got it, I'll treat that as a correction. What should I update in the process map?"
    if utterance_type == "contradiction":
        if target:
            return f"That sounds different from what I had for {target}. Which version should I trust for the process map?"
        return "That sounds different from what I had earlier. Which version should I trust for the process map?"
    return maybe_last_attempt(plan, intent_phrase(plan, target))


def intent_phrase(plan: dict[str, Any], target: str | None = None) -> str:
    chosen = plan.get("chosen_intent") or {}
    intent_name = chosen.get("intent")
    if intent_name in {"discover_function", "orient_interview"}:
        return "What part of the business do you oversee?"
    if intent_name == "discover_processes":
        return "What are the main recurring processes your team owns? A rough list is fine."
    if intent_name == "select_process_to_expand":
        if target:
            return f"Let's zoom into {target}. Where does it start?"
        return "Which of those processes is most important or most painful to zoom into first?"
    if intent_name == "define_process_boundary":
        if target:
            return f"For {target}, where does the process begin and end?"
        return "Where does that process begin and end?"
    if intent_name == "capture_outcome":
        if target:
            return f"What business outcome should {target} produce?"
        return "What outcome is this process supposed to produce for the business?"
    if intent_name == "capture_owner_roles":
        if target:
            return f"Who is accountable for {target}?"
        return "Who is accountable for that process?"
    if intent_name == "capture_systems":
        if target:
            return f"Which systems of record, spreadsheets, or shadow tools does the team use for {target}?"
        return "Which systems of record, spreadsheets, or shadow tools does the team use for this?"
    if intent_name == "quantify_frequency_volume":
        if target:
            return f"How often does the team run {target}?"
        return "How often does this happen?"
    if intent_name == "capture_metrics":
        if target:
            return f"How do you measure success for {target}?"
        return "How do you measure whether this process is working well?"
    if intent_name == "capture_friction":
        if target:
            return f"Where does the team see {target} slow down or require manual cleanup today?"
        return "Where does this work slow down, break, or require manual cleanup today?"
    if intent_name in {"capture_dependencies", "capture_handoffs"}:
        if target:
            return f"What upstream inputs does {target} depend on?"
        return "What upstream inputs does this depend on?"
    if intent_name == "capture_risk_spof":
        if target:
            return f"Is any part of {target} dependent on one person, tribal knowledge, or a fragile workaround?"
        return "Is any part of this dependent on one person, tribal knowledge, or a fragile workaround?"
    if intent_name == "capture_controls":
        if target:
            return f"What controls or approvals govern {target}?"
        return "What controls or approvals govern this work?"
    if intent_name == "capture_exec_priority":
        if target:
            return f"How important is {target} to the executive team right now?"
        return "How important is this work to the executive team right now?"
    if intent_name == "capture_variants":
        if target:
            return f"What variants or exceptions come up in {target}?"
        return "What variants or exceptions come up in this work?"
    if intent_name == "playback_summary":
        return "Let me play back what I have so far, then you can tell me what I missed."
    if intent_name == "open_questions_closeout":
        return "Before we wrap, I still have a few gaps. Can we quickly cover the biggest one?"
    return phase_fallback(plan.get("proposed_next_phase"))


def phase_fallback(phase: Any) -> str:
    if phase == "orient":
        return "What part of the business do you oversee?"
    if phase == "inventory":
        return "What are the main recurring processes your team owns?"
    if phase == "expand":
        return "Which process should we zoom into first?"
    if phase == "enrich":
        return "Where does that process connect to other teams, systems, or metrics?"
    if phase == "closeout":
        return "Let me summarize what I have and check what I missed."
    return "Got it. What should I understand next about how that work actually runs?"


def maybe_last_attempt(plan: dict[str, Any], phrase: str) -> str:
    chosen = plan.get("chosen_intent") or {}
    if "last_attempt" not in str(chosen.get("style_hint") or ""):
        return phrase
    return f"Last try on this one before I mark it as unknown: {lowercase_first(phrase)}"


def lowercase_first(value: str) -> str:
    return value[:1].lower() + value[1:] if value else value


def classify_utterance(text: str) -> str:
    compact = text.strip().lower()
    if not compact:
        return "non_answer"
    if re.fullmatch(r"(hi|hello|hey|good (morning|afternoon|evening))[\s!.]*", compact):
        return "greeting"
    if re.search(
        r"what are we doing|what is this|how does this work|why are you asking|what are we going to do|how long|can you hear me|are you there|is this (thing )?working",
        text,
        re.I,
    ):
        return "meta_question"
    if re.search(r"\b(i don'?t know|not sure|no idea|hard to say|depends)\b", text, re.I):
        return "dont_know"
    if re.search(r"\b(actually|correction|not exactly|scratch that|i meant)\b", text, re.I):
        return "correction"
    if re.search(r"\b(that'?s wrong|that is wrong|not true|isn'?t true|not the case|contradicts?|opposite)\b", text, re.I):
        return "contradiction"
    if re.search(r"\b(what do you mean|can you clarify|could you clarify|can you be more specific|could you be more specific|be more specific|what does .* mean|define|do you mean|what are systems of record|what is a system of record)\b", text, re.I):
        return "clarification_request"
    if re.search(r"\b(unrelated|off topic|by the way|quick question)\b", text, re.I) and not has_business_signal(text):
        return "off_topic"
    if re.search(r"\b(lunch|restaurant|weather|sports|movie|weekend)\b", text, re.I) and not has_business_signal(text):
        return "off_topic"
    if re.fullmatch(r"(yeah|yep|yes|ok|okay|sure|right|uh|um|so|so this is|mm-hmm)[\s!.]*", compact):
        return "non_answer"
    if len(text.split()) < 5 and not has_business_signal(text):
        return "non_answer"
    if len(text.split()) < 10 and has_business_signal(text):
        return "partial_answer"
    return "substantive_answer"


def extract_function_name(text: str) -> str | None:
    match = re.search(
        r"\b(?:i run|i lead|i oversee|i manage|i own|responsible for|my team owns|we own|we run|we lead|we oversee)\s+([^,.]+)",
        text,
        re.I,
    )
    if not match:
        return None
    value = clean_phrase(match.group(1))
    if looks_like_process_list(value):
        return None
    return title_case(value)


def extract_process_names(text: str) -> list[str]:
    fragments = []
    names = extract_ordinal_process_names(text)
    for pattern in [
        r"\b(?:processes are|processes include|main processes are|we own|we handle|we manage|we run)\s+([^.;]+)",
        r"\b(?:responsible for|responsible for the following|responsible for these|responsible for those)\s+([^.;]+)",
        r"\b(?:including|like)\s+([^.;]+)",
        r"\b(?:process is|process called|process:|workflow is|workflow called)\s+([^,.]+)",
    ]:
        match = re.search(pattern, text, re.I)
        if match:
            fragments.append(match.group(1))
    for fragment in fragments:
        names.extend(split_process_list(fragment))
    blocked = {
        "sales",
        "rev ops",
        "revenue operations",
        "commercial operations",
        "business operations",
        "sales operations",
        "marketing",
        "finance",
        "support",
    }
    return unique([title_case(name) for name in names if name.lower() not in blocked])


def extract_ordinal_process_names(text: str) -> list[str]:
    pattern = (
        r"\b(?:the\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)"
        r"(?:\s+one)?\s+(?:being|is|was|would be|as)\s+([^,.;]+)"
    )
    return [clean_phrase(match.group(1)) for match in re.finditer(pattern, text, re.I)]


def split_process_list(value: str) -> list[str]:
    process_fragment = re.split(
        r"\b(?:mostly\s+)?(?:in|using|through)\s+",
        value,
        maxsplit=1,
        flags=re.I,
    )[0]
    process_fragment = re.sub(
        r"^(?:three|two|four|five|six|seven|eight|nine|ten|\d+)\s+things[:\s-]*",
        "",
        process_fragment,
        flags=re.I,
    )
    return [
        clean_phrase(item)
        for item in re.sub(r"\band\b", ",", process_fragment, flags=re.I).split(",")
        if clean_phrase(item)
    ]


def extract_systems(text: str) -> list[str]:
    systems = [
        system
        for system in [
            "Salesforce",
            "NetSuite",
            "Workday",
            "ServiceNow",
            "Slack",
            "Excel",
            "Google Sheets",
            "Zendesk",
            "Jira",
            "Asana",
            "HubSpot",
        ]
        if re.search(rf"\b{re.escape(system)}\b", text, re.I)
    ]
    if re.search(r"\bsheets\b", text, re.I) and "Google Sheets" not in systems:
        systems.append("Google Sheets")
    return systems


def extract_frequency(text: str) -> str | None:
    match = re.search(
        r"\b(daily|weekly|monthly|quarterly|annually|every [^,.]+|\d+\s*(?:times|x)\s*(?:a|per)\s*(?:day|week|month|quarter|year))\b",
        text,
        re.I,
    )
    return match.group(1) if match else None


def extract_volume(text: str) -> dict[str, Any] | None:
    count_unit_period = re.search(
        r"\b(?:about|around|roughly|approximately|~)?\s*(\d[\d,]*)\s+([A-Za-z][A-Za-z -]{2,30}?)\s+(?:per|a|each)\s+(day|week|month|quarter|year)\b",
        text,
        re.I,
    )
    if count_unit_period:
        return {
            "count": int(count_unit_period.group(1).replace(",", "")),
            "unit": clean_phrase(count_unit_period.group(2).lower()),
            "period": count_unit_period.group(3).lower(),
            "statement": text.strip(),
        }
    per_period = re.search(
        r"\b(?:volume is|volume runs|handle|handles|process|processes|review|reviews)\s+(?:about|around|roughly|approximately|~)?\s*(\d[\d,]*)\s+(?:per|a|each)\s+(day|week|month|quarter|year)\b",
        text,
        re.I,
    )
    if per_period:
        return {
            "count": int(per_period.group(1).replace(",", "")),
            "period": per_period.group(2).lower(),
            "statement": text.strip(),
        }
    return None


def extract_outcome(text: str) -> str | None:
    match = re.search(r"\b(?:outcome is|responsible for|so that|goal is|produces?)\s+([^,.]+)", text, re.I)
    return clean_phrase(match.group(1)) if match else None


def extract_metric(text: str) -> str | None:
    match = re.search(r"\b(?:measure|metric|kpi|tracked by|target is)\s+([^,.]+)", text, re.I)
    return clean_phrase(match.group(1)) if match else None


def extract_dependency(text: str) -> str | None:
    match = re.search(r"\b(?:depends on|input from|handoff from|handoff to|downstream to|upstream from)\s+([^,.]+)", text, re.I)
    if match:
        return clean_phrase(match.group(1))
    match = re.search(r"(?:^|[.;,]|\bbecause\b|\bwhen\b|\band\b)\s*([A-Za-z][A-Za-z &-]{1,40}?)\s+gets?\s+pulled\s+in\b", text, re.I)
    return clean_phrase(match.group(1)) if match else None


def extract_process_relationship(text: str, process_names: list[str]) -> dict[str, Any] | None:
    canonical_processes = list(dict.fromkeys([process for process in process_names if process]))
    for source_process in canonical_processes:
        for target_process in canonical_processes:
            if source_process == target_process:
                continue
            source = re.escape(source_process)
            target = re.escape(target_process)
            ordered = re.search(
                rf"\b{source}\b[^.]{{0,80}}?\b(feeds|drives|informs|triggers|rolls into|flows into|hands off to)\b[^.]{{0,80}}?\b{target}\b",
                text,
                re.I,
            )
            if ordered:
                return {
                    "source_process": source_process,
                    "target_process": target_process,
                    "relationship": ordered.group(1).lower(),
                    "statement": text.strip(),
                }
            dependency = re.search(
                rf"\b{target}\b[^.]{{0,80}}?\b(depends on|uses input from|takes input from)\b[^.]{{0,80}}?\b{source}\b",
                text,
                re.I,
            )
            if dependency:
                return {
                    "source_process": source_process,
                    "target_process": target_process,
                    "relationship": dependency.group(1).lower(),
                    "statement": text.strip(),
                }
    return None


def has_boundary_signal(text: str) -> bool:
    return bool(
        re.search(
            r"\b(starts?|begins?|ends?|complete|finished|from .* to |boundary|handoff)\b",
            text,
            re.I,
        )
    )


def process_boundary_value(process_names: list[str], text: str) -> dict[str, Any]:
    value: dict[str, Any] = {"process_names": unique(process_names)}
    if has_boundary_signal(text):
        value["boundary_statement"] = text.strip()
    return value


def extract_control(text: str) -> str | None:
    if re.search(
        r"\b(control|compliance|audit|sox|approval from|approval is required|approved by|sign[- ]?off|requires? approval|required approval|must be approved|governed by)\b",
        text,
        re.I,
    ):
        return text.strip()
    return None


def extract_executive_priority(text: str) -> str | None:
    if re.search(
        r"\b(top priority|high priority|medium priority|low priority|executive priority|exec priority|strategic priority|board priority|ceo|cfo|cro|this quarter|this year)\b",
        text,
        re.I,
    ):
        return text.strip()
    return None


def extract_variant(text: str) -> str | None:
    if re.search(
        r"\b(exception|exceptions|variant|variants|edge case|edge cases|special case|manual override|override|enterprise deal|enterprise deals)\b",
        text,
        re.I,
    ):
        return text.strip()
    return None


def extract_spof_risk(text: str) -> str | None:
    if re.search(
        r"\b(only|single point|one person|depends on|tribal knowledge|if .* out|fragile workaround|bus factor)\b",
        text,
        re.I,
    ):
        return text.strip()
    return None


def extract_documentation_maturity(text: str) -> str | None:
    if re.search(
        r"\b(documented|not documented|undocumented|sop|runbook|wiki|tribal knowledge)\b",
        text,
        re.I,
    ):
        return text.strip()
    return None


def extract_role(text: str) -> str | None:
    match = re.search(r"\b(?:owned by|owner is|accountable owner is|team is|handled by)\s+([^,.]+)", text, re.I)
    if match:
        return title_case(clean_phrase(match.group(1)))
    match = re.search(r"\b([A-Za-z][A-Za-z &-]{1,40})\s+owns?\b", text, re.I)
    if match:
        return title_case(clean_phrase(match.group(1)))
    match = re.search(r"\b([A-Za-z][A-Za-z &-]{1,40})-owned\b", text, re.I)
    return title_case(clean_phrase(match.group(1))) if match else None


def extract_person(text: str) -> str | None:
    match = re.search(r"\b(?:by|owner is|ask)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b", text)
    return match.group(1) if match else None


def contradiction_signals(utterance_type: str, text: str) -> list[str]:
    if utterance_type == "contradiction":
        return [f"Director contradicted prior context: {text}"]
    if utterance_type == "correction":
        return [f"Director corrected prior context: {text}"]
    return []


def focus_process_name_from_context(
    candidates: list[Any],
    focus_candidate_process_id: Any,
) -> str | None:
    if not isinstance(focus_candidate_process_id, str) or not focus_candidate_process_id:
        return None
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        if candidate.get("id") == focus_candidate_process_id:
            name = candidate.get("proposed_name") or candidate.get("proposedName")
            return str(name) if name else None
    return None


def choose_focus_process(
    extracted: list[str],
    known: list[str],
    text: str,
    prior_focus: str | None = None,
) -> str | None:
    for process_name in [*extracted, *known]:
        if re.search(rf"{re.escape(process_name)}[^.]*\b(manual|slow|delay|bottleneck|pain|painful|break|stuck|cleanup)\b", text, re.I):
            return process_name
    if prior_focus:
        return prior_focus
    return extracted[0] if extracted else (known[0] if known else None)


def next_phase(current_phase: str, utterance_type: str, function_name: str | None, processes: list[str], known: list[str]) -> str:
    if utterance_type in {"greeting", "meta_question", "non_answer", "dont_know", "off_topic", "clarification_request"}:
        return current_phase
    if not function_name and current_phase == "orient":
        return "orient"
    if not processes and not known:
        return "inventory"
    if current_phase in {"orient", "inventory"}:
        return "expand"
    return current_phase


def choose_intent(
    utterance_type: str,
    processes: list[str],
    known: list[str],
    focus_process: str | None,
    function_name: str | None,
    unknown_slot: str | None = None,
    current_phase: str = "orient",
    conflicting_slot: str | None = None,
    current_slots: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if utterance_type == "greeting":
        return intent("discover_function", "function.name", 1200, "Orient the director before process drilldown.")
    if utterance_type == "meta_question":
        return meta_continuation_intent(
            current_phase,
            focus_process,
            known,
            current_slots or {},
        )
    if utterance_type in {"non_answer", "dont_know"}:
        if utterance_type == "dont_know" and unknown_slot:
            return adjacent_intent_after_unknown(unknown_slot, current_phase)
        return intent("discover_processes", "process.inventory", 1100, "Low-information turn; ask for an easier process list.")
    if utterance_type == "clarification_request":
        return intent("clarify_previous_question", "systems.systems_of_record", 1250, "Answer clarification briefly and re-ask the active probe.", focus_process)
    if utterance_type == "off_topic":
        return intent("discover_processes", "process.inventory", 1200, "Acknowledge briefly, then steer back to the interview.")
    if utterance_type == "contradiction":
        return intent(
            "reconcile_conflict",
            conflicting_slot,
            1400,
            "The director contradicted prior context; resolve the trusted version before moving on.",
            focus_process,
        )
    if utterance_type == "correction":
        if focus_process:
            return intent("capture_owner_roles", "ownership.roles", 1300, "Capture the corrected process fact before moving on.", focus_process)
        return intent("capture_correction", None, 1300, "Capture the corrected fact before moving on.")
    if processes:
        return intent("select_process_to_expand", "scope.boundaries", 1200, "The director named processes; choose one to drill into.", focus_process)
    if not function_name:
        return intent("discover_function", "function.name", 1150, "Director remit is not known yet.")
    if not known:
        return intent("discover_processes", "process.inventory", 1125, "No process inventory is captured yet.")
    return intent("define_process_boundary", "scope.boundaries", 1000, "A focus process needs boundaries.", focus_process)


def meta_continuation_intent(
    current_phase: str,
    focus_process: str | None,
    known_processes: list[str],
    current_slots: dict[str, Any],
) -> dict[str, Any]:
    target = focus_process or (known_processes[0] if known_processes else None)
    if current_phase == "inventory":
        return intent(
            "discover_processes",
            "process.inventory",
            1200,
            "Answer the meta-question, then continue the process inventory.",
            target,
            "meta_continue",
        )
    if current_phase == "expand":
        core_slots = [
            "scope.boundaries",
            "ownership.roles",
            "systems.systems_of_record",
        ]
        missing_core_slot = next(
            (
                slot_path
                for slot_path in core_slots
                if current_slots.get(slot_path) not in {"filled", "asked_unknown"}
            ),
            "scope.boundaries",
        )
        return intent(
            intent_name_for_slot(missing_core_slot) if target else "select_process_to_expand",
            missing_core_slot if target else "scope.boundaries",
            1200,
            "Answer the meta-question, then continue the current process drilldown.",
            target,
            "meta_continue",
        )
    if current_phase == "enrich":
        return intent(
            "capture_metrics",
            "metrics.kpis",
            1200,
            "Answer the meta-question, then continue enrichment for the focus process.",
            target,
            "meta_continue",
        )
    if current_phase == "closeout":
        return intent(
            "playback_summary",
            None,
            1200,
            "Answer the meta-question, then continue closeout.",
            target,
            "meta_continue",
        )
    return intent(
        "discover_function",
        "function.name",
        1200,
        "Answer the meta-question, then orient the director before process drilldown.",
        target,
        "meta_continue",
    )


def contradiction_target_slot(text: str, prior_intent: Any) -> str:
    if re.search(r"\b(daily|weekly|monthly|quarterly|annually|frequency|cadence|volume|how often)\b", text, re.I):
        return "frequency.volume"
    if re.search(r"\b(system|salesforce|netsuite|workday|sheets?|spreadsheet|tool)\b", text, re.I):
        return "systems.systems_of_record"
    if re.search(r"\b(owner|owned by|accountable|finance|rev ops|role|team)\b", text, re.I):
        return "ownership.roles"
    if re.search(r"\b(start|begin|end|complete|boundary|handoff)\b", text, re.I):
        return "scope.boundaries"
    if re.search(r"\b(metric|kpi|measure|target)\b", text, re.I):
        return "metrics.kpis"
    return slot_for_unknown_response(prior_intent, "expand") or "scope.boundaries"


def slot_for_unknown_response(prior_intent: Any, current_phase: str) -> str | None:
    by_intent = {
        "discover_function": "function.name",
        "orient_interview": "function.name",
        "discover_processes": "process.inventory",
        "select_process_to_expand": "scope.boundaries",
        "define_process_boundary": "scope.boundaries",
        "capture_outcome": "outcomes.business_outcomes",
        "capture_owner_roles": "ownership.roles",
        "capture_systems": "systems.systems_of_record",
        "quantify_frequency_volume": "frequency.volume",
        "capture_dependencies": "handoffs.dependencies",
        "capture_handoffs": "handoffs.dependencies",
        "capture_metrics": "metrics.kpis",
        "capture_friction": "friction.pain_points",
        "capture_risk_spof": "risk.spofs",
        "capture_controls": "controls.compliance",
        "capture_documentation": "documentation.maturity",
        "capture_priority": "priority.executive_priority",
        "capture_exec_priority": "priority.executive_priority",
        "capture_variants": "variants.exceptions",
    }
    if isinstance(prior_intent, str) and prior_intent in by_intent:
        return by_intent[prior_intent]
    return {
        "orient": "function.name",
        "inventory": "process.inventory",
        "expand": "scope.boundaries",
        "enrich": "metrics.kpis",
    }.get(current_phase)


def should_mark_slot_asked_unknown(
    current_slots: dict[str, Any],
    slot_updates: list[dict[str, Any]],
    slot_path: str,
) -> bool:
    if current_slots.get(slot_path) in {"filled", "asked_unknown"}:
        return False
    return not any(
        update.get("slot_path") == slot_path
        and update.get("status") in {"filled", "asked_unknown"}
        for update in slot_updates
    )


def adjacent_intent_after_unknown(unknown_slot: str, current_phase: str) -> dict[str, Any]:
    if unknown_slot == "function.name":
        return intent(
            "discover_processes",
            "process.inventory",
            1125,
            "Director does not know the remit framing; ask for recurring work instead.",
        )
    if unknown_slot == "process.inventory":
        return intent(
            "discover_function",
            "function.name",
            1125,
            "Director does not know the process inventory; recover with remit/outcome context.",
        )
    if unknown_slot == "scope.boundaries":
        return intent(
            "capture_outcome",
            "outcomes.business_outcomes",
            1125,
            "Director does not know boundaries; ask for business outcome instead.",
        )
    if unknown_slot == "ownership.roles":
        return intent(
            "capture_systems",
            "systems.systems_of_record",
            1125,
            "Director does not know ownership; ask for systems context instead.",
        )
    if unknown_slot == "systems.systems_of_record":
        return intent(
            "capture_owner_roles",
            "ownership.roles",
            1125,
            "Director does not know systems; ask who is involved instead.",
        )
    if current_phase == "enrich":
        return intent(
            "capture_friction",
            "friction.pain_points",
            1125,
            "Director does not know the prior slot; pivot to an adjacent high-signal area.",
        )
    return intent(
        "discover_processes",
        "process.inventory",
        1125,
        "Director does not know the prior slot; pivot to an adjacent high-signal area.",
    )


def intent(
    name: str,
    target_slot: str | None,
    score: float,
    reason: str,
    target_process: str | None = None,
    style_hint: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {"intent": name, "score": score, "reason": reason}
    if target_slot:
        result["target_slot"] = target_slot
    if target_process:
        result["target_process"] = target_process
    if style_hint:
        result["style_hint"] = style_hint
    return result


def slot_update(
    slot_path: str,
    value: Any,
    evidence_ids: list[str],
    confidence: float,
    status: str = "filled",
) -> dict[str, Any]:
    return {
        "slot_path": slot_path,
        "value": value,
        "status": status,
        "confidence": confidence,
        "evidence_ids": evidence_ids,
        "priority": 100,
    }


def read_repo_file(relative_path: str) -> str:
    return (Path(__file__).resolve().parents[3] / relative_path).read_text()


def director_turn_plan_tool_schema() -> dict[str, Any]:
    schema = json.loads(read_repo_file("schemas/director-turn-plan.schema.json"))
    refs = {
        "slot-state.schema.json": json.loads(read_repo_file("schemas/slot-state.schema.json")),
        "claim.schema.json": json.loads(read_repo_file("schemas/claim.schema.json")),
    }
    return constrain_director_turn_plan_tool_schema(inline_schema_refs(schema, refs))


def constrain_director_turn_plan_tool_schema(schema: dict[str, Any]) -> dict[str, Any]:
    properties = schema.setdefault("properties", {})
    constrain_director_intent_schema(properties.setdefault("chosen_intent", {}))
    ranked_intent_schema = (
        properties
        .setdefault("ranked_intents", {})
        .setdefault("items", {})
    )
    constrain_director_intent_schema(ranked_intent_schema)
    slot_path_schema = (
        properties
        .setdefault("slot_updates", {})
        .setdefault("items", {})
        .setdefault("properties", {})
        .setdefault("slot_path", {})
    )
    slot_path_schema["enum"] = DIRECTOR_SLOT_PATHS
    return schema


def constrain_director_intent_schema(schema: dict[str, Any]) -> None:
    properties = schema.setdefault("properties", {})
    properties.setdefault("intent", {})["enum"] = DIRECTOR_INTENT_NAMES
    properties.setdefault("target_slot", {})["enum"] = DIRECTOR_SLOT_PATHS


def inline_schema_refs(schema: Any, refs: dict[str, Any]) -> Any:
    if isinstance(schema, list):
        return [inline_schema_refs(item, refs) for item in schema]
    if not isinstance(schema, dict):
        return schema
    if set(schema.keys()) == {"$ref"}:
        ref = schema["$ref"]
        if ref in refs:
            return inline_schema_refs(deepcopy(refs[ref]), refs)
    return {
        key: inline_schema_refs(value, refs)
        for key, value in schema.items()
        if key not in {"$schema", "$id"}
    }


def tool_use_input(body: dict[str, Any], tool_name: str) -> dict[str, Any]:
    for block in body.get("content", []):
        if (
            isinstance(block, dict)
            and block.get("type") == "tool_use"
            and block.get("name") == tool_name
            and isinstance(block.get("input"), dict)
        ):
            return block["input"]
    text = next(
        (
            block.get("text", "")
            for block in body.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        ),
        "",
    ).strip()
    if text:
        return parse_json(text)
    raise PlanValidationError(f"Anthropic response did not include {tool_name} tool input.")


def anthropic_stream_event(line: str) -> dict[str, Any] | None:
    if not line.startswith("data:"):
        return None
    data = line.removeprefix("data:").strip()
    if not data or data == "[DONE]":
        return None
    try:
        event = json.loads(data)
    except json.JSONDecodeError:
        return None
    return event if isinstance(event, dict) else None


def merge_anthropic_stream_usage(
    usage: dict[str, Any],
    event: dict[str, Any],
) -> dict[str, Any]:
    next_usage = dict(usage)
    candidates = [
        event.get("usage"),
        (event.get("message") or {}).get("usage")
        if isinstance(event.get("message"), dict)
        else None,
        (event.get("delta") or {}).get("usage")
        if isinstance(event.get("delta"), dict)
        else None,
    ]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        for key, value in candidate.items():
            try:
                numeric = int(value)
            except (TypeError, ValueError):
                continue
            next_usage[key] = max(int(next_usage.get(key, 0)), numeric)
    return next_usage


def parse_json(text: str) -> Any:
    match = re.search(r"```json\s*(.*?)```", text, re.I | re.S)
    return json.loads(match.group(1) if match else text)


def anthropic_metadata(
    *,
    model: str,
    prompt_template_id: str,
    started: float,
    usage: dict[str, Any],
    input_tokens: int,
    output_tokens: int,
) -> dict[str, Any]:
    return {
        "model": model,
        "prompt_template_id": prompt_template_id,
        "prompt_template_version": "1",
        "token_count_input": input_tokens,
        "token_count_output": output_tokens,
        "cache_read_input_tokens": int(usage.get("cache_read_input_tokens", 0)),
        "cache_creation_input_tokens": int(
            usage.get("cache_creation_input_tokens", 0)
        ),
        "cost_cents": estimate_anthropic_cost_cents(
            model,
            usage,
            input_tokens,
            output_tokens,
        ),
        "latency_ms": max(1, int((time.time() - started) * 1000)),
        "cache_hit": int(usage.get("cache_read_input_tokens", 0)) > 0,
    }


def metadata_for(prompt_template_id: str, model: str, started: float, input_text: str, output_text: str) -> dict[str, Any]:
    return {
        "model": model,
        "prompt_template_id": prompt_template_id,
        "prompt_template_version": "1",
        "token_count_input": estimate_tokens(input_text),
        "token_count_output": estimate_tokens(output_text),
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cost_cents": 0,
        "latency_ms": max(1, int((time.time() - started) * 1000)),
        "cache_hit": False,
    }


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def estimate_anthropic_cost_cents(
    model: str,
    usage: dict[str, Any],
    input_tokens: int,
    output_tokens: int,
) -> float:
    lower_model = model.lower()
    if "haiku" in lower_model:
        input_cents_per_mtok = 80
        output_cents_per_mtok = 400
        cache_write_cents_per_mtok = 100
        cache_read_cents_per_mtok = 8
    elif "opus" in lower_model:
        input_cents_per_mtok = 1500
        output_cents_per_mtok = 7500
        cache_write_cents_per_mtok = 1875
        cache_read_cents_per_mtok = 150
    else:
        input_cents_per_mtok = 300
        output_cents_per_mtok = 1500
        cache_write_cents_per_mtok = 375
        cache_read_cents_per_mtok = 30

    cache_read_tokens = int(usage.get("cache_read_input_tokens", 0))
    cache_creation_tokens = int(usage.get("cache_creation_input_tokens", 0))
    billable_input_tokens = max(0, input_tokens - cache_read_tokens)
    cents = (
        billable_input_tokens / 1_000_000 * input_cents_per_mtok
        + cache_creation_tokens / 1_000_000 * cache_write_cents_per_mtok
        + cache_read_tokens / 1_000_000 * cache_read_cents_per_mtok
        + output_tokens / 1_000_000 * output_cents_per_mtok
    )
    return round(cents, 4)


def has_business_signal(text: str) -> bool:
    return bool(re.search(r"process|workflow|team|own|run|manage|system|salesforce|netsuite|workday|metric|kpi|weekly|monthly|approval|forecast|territory|quote|customer|handoff|manual", text, re.I))


def looks_like_process_list(text: str) -> bool:
    return bool(re.search(r",|\band\b|\b(processes|workflows|cadences)\b", text, re.I))


def clean_phrase(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\b(today|for us|right now|mostly|usually)\b", "", value, flags=re.I)).strip()


def title_case(value: str) -> str:
    return " ".join(word[:1].upper() + word[1:].lower() for word in value.split())


def unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))
