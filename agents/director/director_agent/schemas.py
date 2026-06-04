from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class OttoApiModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class IngestedTurnResponse(OttoApiModel):
    latest_utterance: str
    transcript_segment_ids: list[str]
    evidence_ids: list[str]
    turn_index: int


class RespondedTurnResponse(OttoApiModel):
    plan: dict[str, Any]
    planned_agent_utterance: str
    decision_log_id: str
    metadata: dict[str, Any] | None = None
    voice_metadata: dict[str, Any] | None = None
    steering_context: dict[str, Any] | None = None
    degraded_quality: bool = False
    degraded_reasons: list[str] = Field(default_factory=list)
    local_turn_correlation_id: str | None = None

    @field_validator("plan")
    @classmethod
    def validate_plan_contract(cls, value: dict[str, Any]) -> dict[str, Any]:
        validated = DirectorTurnPlan.model_validate(value)
        return validated.model_dump(mode="json", exclude_none=True)


class ExtractionTurnResponse(OttoApiModel):
    next_prompt: str
    decision_log_id: str
    extraction_status: str = "complete"
    extraction_latency_ms: int | None = None


class CheckedTurnResponse(OttoApiModel):
    checker_status: str = "complete"
    checker_violations: list[dict[str, Any]] = Field(default_factory=list)
    checker_violation_count: int = 0
    stale_question_count: int = 0
    metadata: dict[str, Any] | None = None


class PlanningContextResponse(OttoApiModel):
    context: dict[str, Any]


class VerificationResponse(OttoApiModel):
    verification: dict[str, Any]


class OpeningTurnResponse(OttoApiModel):
    next_prompt: str
    decision_log_id: str


class NoticeTurnResponse(OttoApiModel):
    next_prompt: str
    decision_log_id: str


class DeliveryUpdateResult(OttoApiModel):
    id: str
    delivery_json: dict[str, Any] | None = Field(default=None, alias="deliveryJson")


class DeliveryUpdateResponse(OttoApiModel):
    delivery: DeliveryUpdateResult


class ClaimValueSchema(BaseModel):
    type: str | list[str]
    required: list[str] | None = None

    @field_validator("type")
    @classmethod
    def validate_type(cls, value: str | list[str]) -> str | list[str]:
        allowed = {"array", "boolean", "number", "object", "string"}
        values = value if isinstance(value, list) else [value]
        unsupported = [item for item in values if item not in allowed]
        if unsupported:
            raise ValueError(f"Unsupported claim value types: {', '.join(unsupported)}")
        return value


class ClaimFieldSpec(BaseModel):
    field: str
    value_schema: ClaimValueSchema


class ClaimSubjectSpec(BaseModel):
    subject_type: str
    fields: list[ClaimFieldSpec]


class ClaimSubjectFields(BaseModel):
    version: int
    allowed: list[ClaimSubjectSpec]

    def allows(self, subject_type: str, field: str) -> bool:
        return any(
            subject.subject_type == subject_type
            and any(spec.field == field for spec in subject.fields)
            for subject in self.allowed
        )


class StrictApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Evidence(StrictApiModel):
    source_type: Literal[
        "transcript_segment",
        "screen_event",
        "document_chunk",
        "user_correction",
        "agent_inference",
    ]
    source_id: UUID | None = None
    evidence_label: Literal[
        "observed",
        "stated_operator",
        "stated_director",
        "documented",
        "inferred",
        "confirmed",
        "corrected",
    ]
    span_start: int | None = Field(default=None, ge=0)
    span_end: int | None = Field(default=None, ge=0)
    quote: str | None = None
    summary: str | None = None
    confidence: float = Field(ge=0, le=1)


class CandidateProcessInventoryItem(StrictApiModel):
    proposed_name: str = Field(min_length=1)
    proposed_function: str | None = None
    frequency: str | None = None
    complexity_hint: str | None = None
    confidence: float = Field(ge=0, le=1)
    evidence_ids: list[UUID]


class DirectorProcessInventory(StrictApiModel):
    candidate_processes: list[CandidateProcessInventoryItem]


class SlotUpdate(StrictApiModel):
    slot_path: str
    candidate_process_id: UUID | None = None
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
    evidence_ids: list[UUID]
    last_asked_at: datetime | None = None
    priority: int = Field(ge=0)
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


class DirectorIntent(StrictApiModel):
    intent: str
    target_slot: str | None = None
    target_process: str | None = None
    score: float
    info_gain: float | None = None
    conversational_fit: float | None = None
    priority: float | None = None
    recency: float | None = None
    reason: str
    style_hint: str | None = None


class DirectorTurnPlan(StrictApiModel):
    utterance_type: Literal[
        "greeting",
        "meta_question",
        "clarification_request",
        "substantive_answer",
        "partial_answer",
        "non_answer",
        "dont_know",
        "correction",
        "contradiction",
        "off_topic",
    ]
    chosen_intent: DirectorIntent
    planned_agent_utterance: str | None = None
    current_phase: Literal["orient", "inventory", "expand", "enrich", "closeout"]
    proposed_next_phase: Literal["orient", "inventory", "expand", "enrich", "closeout"]
    phase_transition_ready: bool
    slot_updates: list[SlotUpdate]
    claims: list[PlanClaim]
    tool_calls: list[ToolCall]
    contradiction_signals: list[str]
    ranked_intents: list[DirectorIntent]
    focus_candidate_process_id: UUID | None = None
