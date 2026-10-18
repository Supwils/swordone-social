"""Prompt v2, the dream user turn (spec 2026-10-17 B3). Parsing, clamping
(5 x 60), the atomic write and the archive are unchanged."""

from __future__ import annotations

from typing import Final

from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import Persona
from swil_agent.prompts.types import RenderedPrompt, dream_chars
from swil_agent.prompts.v1.dream import EMPTY_MEMORY
from swil_agent.prompts.v2.memory import fold_memory_lines

DREAM_INSTRUCTION: Final = (
    "系统提示末尾的「最近」是你上次写下的。读完下面这段时间的记录，重写它：\n"
    "- 最多 5 条，每条一句话，不超过 60 字；\n"
    "- 写发生在你身上的事、心情、对某个人的看法；人设里已经写着的不要重复；\n"
    "- 还在意的留着，不在意了就换掉。\n"
    '只输出 JSON：{"recent": ["…"]}'
)
_MEMORY_HEADING: Final = "# 这段时间你做过的事"
_GROUP_HEADING: Final = "# 和你有过互动的人"


def render_dream_v2(persona: Persona, *, memory_tail: str, group_memory: str) -> RenderedPrompt:
    memory = "\n".join(fold_memory_lines(memory_tail.splitlines())) or EMPTY_MEMORY
    user = f"{DREAM_INSTRUCTION}\n\n{_MEMORY_HEADING}\n{memory}"
    if group_memory:
        user += f"\n\n{_GROUP_HEADING}\n{group_memory}"
    request = CompletionRequest(system=persona.prompt, user=user, model=persona.model)
    return RenderedPrompt(version="v2", request=request, chars=dream_chars(request), handles=None)
