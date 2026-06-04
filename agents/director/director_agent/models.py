from __future__ import annotations

import os
from typing import Mapping

DEFAULT_DIRECTOR_BRAIN_MODEL = "claude-sonnet-4-6"
DEFAULT_DIRECTOR_VOICE_MODEL = "claude-haiku-4-5-20251001"
DEFAULT_SYNTHESIS_PLANNER_MODEL = "claude-opus-4-7"


def director_brain_model(env: Mapping[str, str | None] | None = None) -> str:
    values = os.environ if env is None else env
    return (
        configured_model_value(values, "DIRECTOR_BRAIN_MODEL")
        or configured_model_value(values, "ANTHROPIC_MODEL")
        or DEFAULT_DIRECTOR_BRAIN_MODEL
    )


def director_voice_model(env: Mapping[str, str | None] | None = None) -> str:
    values = os.environ if env is None else env
    return (
        configured_model_value(values, "DIRECTOR_VOICE_MODEL")
        or DEFAULT_DIRECTOR_VOICE_MODEL
    )


def synthesis_planner_model(env: Mapping[str, str | None] | None = None) -> str:
    values = os.environ if env is None else env
    return (
        configured_model_value(values, "SYNTHESIS_PLANNER_MODEL")
        or configured_model_value(values, "ANTHROPIC_MODEL")
        or DEFAULT_SYNTHESIS_PLANNER_MODEL
    )


def configured_model_value(
    env: Mapping[str, str | None],
    name: str,
) -> str | None:
    value = str(env.get(name) or "").strip()
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
