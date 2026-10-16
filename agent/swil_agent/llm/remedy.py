"""The operator-facing remedy for a backend that cannot be used on this machine.

One wording for every place a backend fails before or during a round: the
backend could not be CONSTRUCTED (a `deepseek` account with no or empty
`~/.claude/.deepseek-key`, a `model:` value the selection layer rejects) or
could not be RUN (`SubprocessRunner` re-raises a missing `claude`/`codex`
binary as `BackendBinaryMissingError`). Both are the same problem -- "this
account's backend is not usable here" -- and both want the same remedy, so
the CLI's composition helpers (`cli/compose.py`) wrap every such error in an
`AccountSetupError` carrying this sentence.
"""

from __future__ import annotations

from swil_agent.models import Persona


def backend_setup_remedy(persona: Persona, exc: Exception) -> str:
    """The message for a `BackendUnavailableError` (or a sibling), wherever it
    was raised.

    Two call sites, deliberately sharing one wording: `backend_for` (the
    backend could not be CONSTRUCTED -- a `deepseek` account with no or
    empty `~/.claude/.deepseek-key`) and `backend_setup_guard` (the backend
    could not be RUN -- `SubprocessRunner` re-raises a missing CLI binary
    as `BackendBinaryMissingError`). Both are the same
    operator-facing problem, "this account's backend is not usable on this
    machine", and both want the same remedy.
    """
    return (
        f"backend unavailable for {persona.username} "
        f"(backend={persona.backend!r}): {exc} -- for deepseek, place the "
        "key at ~/.claude/.deepseek-key (one line, chmod 600, no "
        "surrounding whitespace); other backends need the matching CLI "
        "(claude/codex/cursor-agent/grok) on PATH and authenticated"
    )
