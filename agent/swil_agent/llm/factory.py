"""The one place a `Backend` is constructed from configuration.

`llm/selection.py` decides WHICH backend; this decides how to build it. They
are separate modules because the first is pure and the second touches a
subprocess runner, an API key and an HTTP transport -- and because a test that
wants to assert "this config resolves to grok on xAI" should not have to
construct anything that could dial out.

Every act/dream/cycle path reaches a backend through `get_backend`. Nothing
below the composition root spawns `claude` or `codex` on its own; the one
sanctioned exception is `llm/neutral.py`, the model-neutral ruler, which builds
its own argv precisely so it can never be routed through backend selection
(see that module, and `tests/unit/test_architecture.py`).
"""

from __future__ import annotations

import httpx

from swil_agent.config import Settings
from swil_agent.llm.api_backend import ApiBackend
from swil_agent.llm.base import Backend, BackendConfigurationError, Runner, build_backend
from swil_agent.llm.selection import BackendChoice

# `build_backend` still speaks the roster's own spellings (`claude`, `codex`,
# `deepseek`) because it is the function 20-odd existing tests call directly and
# the one whose `*)`-default behaviour is pinned. `BackendChoice.wire_name` is
# exactly those strings for the three CLI kinds, so the bridge is one attribute
# access rather than a second mapping table that could drift from the first.
_CLI_KINDS = frozenset({"claude_cli", "codex_cli", "deepseek_cli", "cursor_cli"})


def get_backend(
    choice: BackendChoice,
    runner: Runner,
    settings: Settings,
    *,
    deepseek_api_key: str | None = None,
    transport: httpx.BaseTransport | None = None,
) -> Backend:
    """Build the backend `choice` names.

    `deepseek_api_key` and `transport` are injection seams for tests only, and
    both follow patterns this codebase already uses -- see `build_backend`'s own
    `deepseek_api_key` docstring and `cli.py`'s `_health_check` transport.

    Note what is NOT passed to the CLI backends: the resolved model. Their
    `default_model` stays as it was, and the model reaches them through
    `CompletionRequest.model`. `_diff_narrative` still passes `model=None`
    for claude/codex/deepseek (Bash's empty-model "use the CLI default").
    Cursor has no safe default (`auto` is forbidden), so that one call
    threads the persona model on the *request*, not as a backend default.
    Injecting the resolved model as `default_model` would silently promote
    every claude narrative to opus. `ApiBackend` has no CLI default, so it
    does carry the model -- the asymmetry is the point, not an oversight.
    """
    if choice.kind in _CLI_KINDS:
        return build_backend(choice.wire_name, runner, settings, deepseek_api_key=deepseek_api_key)
    if choice.kind == "api":
        if settings.swil_llm_api_key is None:
            raise BackendConfigurationError("the api backend needs a key -- set SWIL_LLM_API_KEY")
        return ApiBackend.from_choice(
            choice,
            api_key=settings.swil_llm_api_key.get_secret_value(),
            max_tokens=settings.swil_llm_max_tokens,
            transport=transport,
        )
    raise BackendConfigurationError(f"unhandled backend kind {choice.kind!r}")
