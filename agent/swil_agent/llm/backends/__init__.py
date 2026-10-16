"""Backend dispatch for LLM calls.

The five roster-capable backends -- claude, codex, cursor (`cursor-agent`),
grok and deepseek (claude on DeepSeek's endpoint) -- are CLI subprocesses, not
HTTP APIs. `Runner` is the seam that makes them testable: production uses
`SubprocessRunner`, tests inject a fake.

`ApiBackend` (BYOK over HTTP, `llm/api_backend.py`) sits beside these
implementations and is off unless configured.
"""

from __future__ import annotations

from swil_agent.config import Settings
from swil_agent.llm.backends.claude import (
    ClaudeCLIBackend,
    DeepSeekCLIBackend,
    _default_deepseek_key,
)
from swil_agent.llm.backends.codex import CodexCLIBackend
from swil_agent.llm.backends.cursor import CursorCLIBackend
from swil_agent.llm.backends.grok import GrokCLIBackend
from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.protocol import Backend
from swil_agent.llm.runner import Runner


def build_backend(
    name: str,
    runner: Runner,
    settings: Settings,
    *,
    deepseek_api_key: str | None = None,
) -> Backend:
    """Map a resolved wire name (`BackendChoice.wire_name`) to a backend.

    An unknown spelling is refused before this point, by the persona loader
    and by `resolve_backend_choice`, so the claude fallthrough at the end is
    only ever reached by `claude` itself.

    `deepseek_api_key` is an injection seam, not a production concern: leave
    it unset and the real key is read from `~/.claude/.deepseek-key` (via
    `_default_deepseek_key`). It exists so
    `test_backends.py` can supply a fixed string instead of depending on a
    file outside the repository — without it, the deepseek tests would pass
    locally (if the developer happens to have the file) and fail in CI (which
    never will). A missing/empty key — injected or read from disk — still
    raises `BackendUnavailableError` rather than building a backend that
    would silently authenticate with nothing.
    """
    _ = settings  # no per-backend settings yet; kept for interface stability
    if name == "codex":
        return CodexCLIBackend(runner)
    if name == "cursor":
        return CursorCLIBackend(runner)
    if name == "grok":
        return GrokCLIBackend(runner)
    if name == "deepseek":
        api_key = deepseek_api_key if deepseek_api_key is not None else _default_deepseek_key()
        if not api_key:
            raise BackendUnavailableError("deepseek api key is empty")
        return DeepSeekCLIBackend(runner, api_key)
    return ClaudeCLIBackend(runner)
