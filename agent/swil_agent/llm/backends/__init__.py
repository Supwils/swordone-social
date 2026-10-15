"""Backend dispatch for LLM calls.

All three current backends are CLI subprocesses, not HTTP APIs — `codex` has no
API at all. `Runner` is the seam that makes them testable: production uses
`SubprocessRunner`, tests inject a fake.

An `ApiBackend` for BYOK (owner-supplied keys against real HTTP APIs) will sit
beside these implementations; it is Plan 2+ and deliberately absent here.

Ports `agent/scripts/llm.sh:80-124` (`_llm_raw`, `llm_text`, `llm_json`).
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
    """Map a personality's `AI Backend` bullet to a backend.

    Unknown names fall back to the claude path, matching the `*)` default
    branch in `llm.sh`. `mangniu` records `haiku`, which must not raise.

    `deepseek_api_key` is an injection seam, not a production concern: leave
    it unset and the real key is read from `~/.claude/.deepseek-key` (via
    `_default_deepseek_key`), exactly like the Bash runtime. It exists so
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
