"""Every persona-facing prompt, by version (spec 2026-10-17 A1).

Callers go through `act_prompt` / `dream_prompt` only. `v1` is the Era 3 text,
byte-identical to round 1; `v2` is the lean prompt, reachable at runtime only
under `PROMPT_VERSION=v2` + `PROMPT_V2_ENABLED=1` (`config.py`).
"""

from __future__ import annotations

from swil_agent.models import ActContext, Persona, PromptVersion, RhythmDecision
from swil_agent.prompts.types import RenderedPrompt
from swil_agent.prompts.v1.act import render_act_v1
from swil_agent.prompts.v1.dream import render_dream_v1
from swil_agent.prompts.v2.act import render_act_v2
from swil_agent.prompts.v2.dream import render_dream_v2

__all__ = ["RenderedPrompt", "act_prompt", "dream_prompt"]


def act_prompt(
    version: PromptVersion, persona: Persona, ctx: ActContext, rhythm: RhythmDecision
) -> RenderedPrompt:
    if version == "v1":
        return render_act_v1(persona, ctx, rhythm)
    if version == "v2":
        return render_act_v2(persona, ctx, rhythm)
    raise ValueError(f"prompt version {version!r} has no act renderer")


def dream_prompt(
    version: PromptVersion, persona: Persona, *, memory_tail: str, group_memory: str
) -> RenderedPrompt:
    if version == "v1":
        return render_dream_v1(persona, memory_tail=memory_tail, group_memory=group_memory)
    if version == "v2":
        return render_dream_v2(persona, memory_tail=memory_tail, group_memory=group_memory)
    raise ValueError(f"prompt version {version!r} has no dream renderer")
