from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class OttoApiModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class StrictApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class IngestedTurnResponse(OttoApiModel):
    latest_utterance: str
    transcript_segment_ids: list[str]
    evidence_ids: list[str]
    turn_index: int


class OperatorIntent(StrictApiModel):
    intent: str = Field(min_length=1)
    target_slot: str | None = None
    target_step_title: str | None = None
    score: float
    reason: str = Field(min_length=1)
    style_hint: str | None = None


class OperatorStepUpdate(StrictApiModel):
    title: str = Field(min_length=1)
    action_verb: str | None = None
    action_object: str | None = None
    ts_start_ms: int | None = Field(default=None, ge=0)
    ts_end_ms: int | None = Field(default=None, ge=0)
    confidence: float = Field(ge=0, le=1)
    evidence_ids: list[UUID] = Field(default_factory=list)


class OperatorSlotUpdate(StrictApiModel):
    slot_path: str = Field(min_length=1)
    provisional_step_id: UUID | None = None
    value: Any | None = None
    status: Literal[
        "empty",
        "partial",
        "filled",
        "asked_unknown",
        "conflicting",
        "pending_re_extract",
    ]
    confidence: float = Field(ge=0, le=1)
    evidence_ids: list[UUID] = Field(default_factory=list)
    candidates: list[Any] | None = None


class PlanClaim(StrictApiModel):
    subject_type: str
    subject_id: UUID
    field: str
    value: Any
    confidence: float = Field(ge=0, le=1)
    evidence_ids: list[UUID]
    metadata: dict[str, Any] | None = None


class ToolCall(StrictApiModel):
    name: str
    arguments: dict[str, Any]


class OperatorTurnPlan(StrictApiModel):
    utterance_type: Literal[
        "substantive_answer",
        "partial_answer",
        "dont_know",
        "correction",
        "contradiction",
        "meta_question",
        "off_topic",
    ]
    chosen_intent: OperatorIntent
    planned_agent_utterance: str | None = None
    step_updates: list[OperatorStepUpdate]
    slot_updates: list[OperatorSlotUpdate]
    claims: list[PlanClaim]
    tool_calls: list[ToolCall]
    contradiction_signals: list[str]
    current_phase: Literal[
        "orient",
        "happy_path",
        "hard_case",
        "exception_sweep",
        "playback",
        "closeout",
    ] = "orient"
    proposed_next_phase: Literal[
        "orient",
        "happy_path",
        "hard_case",
        "exception_sweep",
        "playback",
        "closeout",
    ] = "happy_path"
    phase_transition_ready: bool = False
    ranked_intents: list[OperatorIntent]


class PlannedTurnResponse(OttoApiModel):
    plan: dict[str, Any]
    planned_agent_utterance: str
    metadata: dict[str, Any]
    degraded_quality: bool = False
    degraded_reasons: list[str] = Field(default_factory=list)

    @field_validator("plan")
    @classmethod
    def validate_plan_contract(cls, value: dict[str, Any]) -> dict[str, Any]:
        validated = OperatorTurnPlan.model_validate(value)
        return validated.model_dump(mode="json", exclude_none=True)


class DispatchedTurnResponse(OttoApiModel):
    decision_log_id: str
    planned_agent_utterance: str


class DeliveryUpdateResponse(OttoApiModel):
    delivery: dict[str, Any]
