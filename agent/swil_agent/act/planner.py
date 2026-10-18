"""Ask the backend for a plan and turn its reply into a `Plan`.

The prompt text lives in `swil_agent.prompts` (spec 2026-10-17 A1).
`PLATFORM_PREAMBLE` and `render_planner_prompt` are re-exported for callers
that predate the move.
"""

from __future__ import annotations

from swil_agent.llm.complete import complete_json
from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.extract import normalize_plan
from swil_agent.llm.protocol import Backend
from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import ActContext, Persona, Plan
from swil_agent.prompts.v1.act import PLATFORM_PREAMBLE as PLATFORM_PREAMBLE
from swil_agent.prompts.v1.act import render_planner_prompt as render_planner_prompt


def plan_attempt(
    backend: Backend, request: CompletionRequest, *, handle_keys: bool = False
) -> tuple[Plan | None, bool]:
    """One planner call: the plan (or `None`) and whether the backend itself
    was unavailable, which `plan_request` folds into the same `None`."""
    try:
        raw = complete_json(backend, request)
    except BackendUnavailableError:
        return None, True
    if not raw:
        return None, False
    return normalize_plan(raw, handle_keys=handle_keys), False


def plan_request(
    backend: Backend, request: CompletionRequest, *, handle_keys: bool = False
) -> Plan | None:
    """One planner call. `None` when the backend produced nothing at all (the
    caller maps that to `ActOutcome.BACKEND_UNAVAILABLE`); a `Plan` with no
    actions -- the model chose `nothing` -- is a different outcome. One attempt
    only; retry belongs to the graph layer's RetryPolicy."""
    return plan_attempt(backend, request, handle_keys=handle_keys)[0]


def plan_round(
    backend: Backend,
    persona: Persona,
    ctx: ActContext,
    *,
    rhythm_guidance: str,
) -> Plan | None:
    """The v1 planner call for a caller holding only the guidance string;
    `persona.prompt` is the system prompt."""
    return plan_request(
        backend,
        CompletionRequest(
            system=persona.prompt,
            user=render_planner_prompt(ctx, rhythm_guidance=rhythm_guidance),
            model=persona.model,
        ),
    )
