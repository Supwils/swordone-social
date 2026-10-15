"""The backend builders behind `cli/compose.py`'s backend seams.

Split out of `compose.py` to keep both files under the 600-line cap (S3 §9).
These are LEAVES -- nothing here calls another seam -- and `compose.py`
re-binds each one under the same name, so `compose.backend_for` is the name
every caller looks up and every test replaces. The one name a test patches
HERE is `get_backend`, which `backend_for` and `api_backend_for` look up in
this module at call time (S3 §12.15).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from swil_agent.cli.errors import AccountSetupError
from swil_agent.config import Settings
from swil_agent.llm.errors import (
    BackendBinaryMissingError,
    BackendConfigurationError,
    BackendUnavailableError,
)
from swil_agent.llm.factory import get_backend
from swil_agent.llm.protocol import Backend
from swil_agent.llm.remedy import backend_setup_remedy
from swil_agent.llm.runner import SubprocessRunner
from swil_agent.llm.selection import BackendChoice, cli_choice_for
from swil_agent.models import Persona


def api_backend_for(persona: Persona, choice: BackendChoice, settings: Settings) -> Backend:
    try:
        return get_backend(choice, SubprocessRunner(), settings)
    except (BackendConfigurationError, BackendUnavailableError) as exc:
        raise AccountSetupError(backend_setup_remedy(persona, exc)) from exc


def backend_for(persona: Persona, settings: Settings) -> Backend:
    """Wraps `build_backend`'s `BackendUnavailableError` (`llm/errors.py` --
    raised for a `deepseek` account with no or empty
    `~/.claude/.deepseek-key`) into `AccountSetupError`: a dead backend key
    is a known, remediable setup problem, not a bug, and a missing
    `~/.claude/.deepseek-key` silently dropping every DeepSeek account from
    a round is already in this project's operational history (CLAUDE.md).

    **The signature is frozen at `(persona, settings)`.** Roughly eighteen
    tests in `test_cli.py` replace this exact name with a two-argument lambda,
    and that substitution is what stops a unit test from spawning a real
    `claude`/`codex` process. An extra parameter here -- even a defaulted one
    -- makes every one of those stubs raise TypeError; on the act path the
    round would then build a REAL backend and dial out. Anything the builder
    needs beyond the persona has to arrive on the persona (see
    `llm/selection.py`'s `apply_choice`) or through `settings`.
    """
    try:
        return get_backend(cli_choice_for(persona), SubprocessRunner(), settings)
    except (BackendConfigurationError, BackendUnavailableError) as exc:
        raise AccountSetupError(backend_setup_remedy(persona, exc)) from exc


@contextmanager
def backend_setup_guard(persona: Persona) -> Iterator[None]:
    """Turn a `BackendUnavailableError` raised DURING the round into the same
    `AccountSetupError` `backend_for` raises when construction fails.

    Needed because a missing backend binary is not discoverable at
    construction time: `build_backend` only picks a class, and the CLI is not
    invoked until the first `complete()` call, deep inside the phase graph.
    `SubprocessRunner` re-raises `subprocess`'s
    `FileNotFoundError` as `BackendBinaryMissingError` -- a SIBLING of
    `BackendUnavailableError`, so it survives every "the LLM said nothing"
    handler between there and here -- precisely so this guard can attach the
    account name and the remedy at the composition root, keeping ruling R17's
    invariant that `AccountSetupError` is raised only by the CLI, at the
    point that knows both the cause and the fix.

    `BackendUnavailableError` is caught here too, for the narrow window where
    one escapes a step that does not degrade on it.

    Scoped to the round call alone, not the whole command body, for the same
    reason `resources_for`'s `RuntimeError` catch is scoped to `login()`:
    a wider bracket would start swallowing exceptions this guard has no
    business classifying.
    """
    try:
        yield
    except (
        BackendBinaryMissingError,
        BackendConfigurationError,
        BackendUnavailableError,
    ) as exc:
        raise AccountSetupError(backend_setup_remedy(persona, exc)) from exc
