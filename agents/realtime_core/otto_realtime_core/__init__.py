from __future__ import annotations

import json
from typing import Any


def text_content(message: Any) -> str:
    """Extract text from LiveKit ChatMessage variants used by Otto agents."""
    text_attr = getattr(message, "text_content", None)
    if callable(text_attr):
        return str(text_attr())
    if isinstance(text_attr, str) and text_attr:
        return text_attr

    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(part) for part in content if part)
    return str(content or "")


def delivered_utterance_for_status(
    utterance: str,
    *,
    delivery_status: str,
    spoken_fraction: float,
    failed_text_returns_none: bool = False,
    truncate_on_word_boundary: bool = False,
) -> str | None:
    if delivery_status == "failed_text_fallback" and failed_text_returns_none:
        return None
    if delivery_status != "truncated":
        return utterance

    trimmed = utterance.strip() if truncate_on_word_boundary else utterance
    if not trimmed:
        return trimmed
    if spoken_fraction <= 0:
        return ""

    boundary = max(1, min(len(trimmed), int(len(trimmed) * spoken_fraction)))
    if not truncate_on_word_boundary:
        return trimmed[:boundary]

    next_space = trimmed.find(" ", boundary)
    if 0 <= next_space <= boundary + 24:
        boundary = next_space
    return trimmed[:boundary].rstrip() + "..."


def estimated_spoken_fraction(
    utterance: str,
    started_at: float,
    ended_at: float,
    *,
    seconds_per_word: float = 0.4,
    minimum_duration_seconds: float = 0.75,
    minimum_fraction: float = 0.0,
    maximum_fraction: float = 1.0,
    decimals: int | None = None,
) -> float:
    trimmed = utterance.strip()
    if not trimmed:
        return 0.0
    estimated_duration = max(minimum_duration_seconds, len(trimmed.split()) * seconds_per_word)
    fraction = (ended_at - started_at) / estimated_duration
    bounded = max(minimum_fraction, min(maximum_fraction, fraction))
    return round(bounded, decimals) if decimals is not None else bounded


def elapsed_ms(started_at: float, ended_at: float) -> int:
    return max(0, int((ended_at - started_at) * 1000))


def notice_reason(error: Exception) -> str:
    reason = f"{error.__class__.__name__}: {error}".strip()
    if not reason or reason.endswith(":"):
        reason = error.__class__.__name__
    return reason[:320]


def json_bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
