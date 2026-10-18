"""What every prompt version returns, and how a prompt's size is counted.

`chars` is the cycle_run card's prompt size (spec 2026-10-17 A3), counted in
code points per part. `total` is system + user; the user-prompt parts sum to
`len(user)`.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final, NamedTuple

from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import HandleMap, PromptVersion

ACT_PROMPT_PARTS: Final = (
    "system",
    "preamble",
    "context",
    "feeds",
    "news",
    "threads",
    "memory",
    "social",
    "tail",
    "total",
)
DREAM_PROMPT_PARTS: Final = ("system", "user")
_USER_PARTS: Final = frozenset(ACT_PROMPT_PARTS[1:-1])


class RenderedPrompt(NamedTuple):
    """One rendered persona prompt. `handles` is v2's handle map (act only);
    `None` means ids in the reply are taken as written."""

    version: PromptVersion
    request: CompletionRequest
    chars: dict[str, int]
    handles: HandleMap | None


def act_chars(
    system: str, segments: Sequence[tuple[str, str]], *, news_inside_context: int = 0
) -> dict[str, int]:
    """Per-part sizes of an act prompt rendered as `(part, text)` segments.

    `news_inside_context` moves that many chars from `context` to `news`: v1
    inlines the news digest inside its now-context block.
    """
    chars = dict.fromkeys(ACT_PROMPT_PARTS, 0)
    for part, text in segments:
        if part not in _USER_PARTS:
            raise ValueError(f"unknown act prompt part {part!r}")
        chars[part] += len(text)
    chars["context"] -= news_inside_context
    chars["news"] += news_inside_context
    chars["system"] = len(system)
    chars["total"] = len(system) + sum(len(text) for _, text in segments)
    return chars


def dream_chars(request: CompletionRequest) -> dict[str, int]:
    return {"system": len(request.system), "user": len(request.user)}
