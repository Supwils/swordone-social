"""Prompt v1, the dream user turn (moved verbatim from `dream/candidate.py`)."""

from __future__ import annotations

from typing import Final

from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import Persona
from swil_agent.prompts.types import RenderedPrompt, dream_chars

DREAM_INSTRUCTION: Final = (
    "你刚过完一段时间。根据下面的近期记忆，写出你现在的「最近」：最多 5 条，"
    "每条一句话（不超过 60 字），可以是最近在意的事、心情、对某个人的看法。"
    "旧的不重要了就换掉。"
    '只输出 JSON：{"recent": ["…", "…"]}。不要改写你的人设，不要写方法论。'
)

_MEMORY_HEADING: Final = "# 近期记忆"
_GROUP_HEADING: Final = "# 最近和你有过互动的人"
EMPTY_MEMORY: Final = "（暂无）"


def build_dream_prompt(
    persona: Persona, *, memory_tail: str, group_memory: str
) -> CompletionRequest:
    """System = the persona prompt (card + current 最近); user = the instruction,
    the memory tail and, when there is one, the group-interaction digest."""
    user = f"{DREAM_INSTRUCTION}\n\n{_MEMORY_HEADING}\n\n{memory_tail.strip() or EMPTY_MEMORY}"
    if group_memory:
        user += f"\n\n{_GROUP_HEADING}\n\n{group_memory}"
    return CompletionRequest(system=persona.prompt, user=user, model=persona.model)


def render_dream_v1(persona: Persona, *, memory_tail: str, group_memory: str) -> RenderedPrompt:
    request = build_dream_prompt(persona, memory_tail=memory_tail, group_memory=group_memory)
    return RenderedPrompt(version="v1", request=request, chars=dream_chars(request), handles=None)
