"""Backend error types, split out of the former `base.py`."""


class BackendUnavailableError(RuntimeError):
    """The backend produced no output, or could not be constructed at all.

    Distinct from a bad/garbled response, which is the caller's problem.
    """


class BackendBinaryMissingError(RuntimeError):
    """argv[0] is not on PATH -- the CLI this backend shells out to is not
    installed on this machine.

    DELIBERATELY NOT a subclass of `BackendUnavailableError`, and that is the
    whole point of it existing. Every "the LLM said nothing" call site --
    `act/planner.py`'s `plan_round`, `dream/round.py`'s `dream_step` -- catches
    `BackendUnavailableError` and degrades to `None`/`""`, exactly as Bash's
    `llm_text` returns empty for a dead model. That degradation is right for
    a model that answered with nothing and WRONG for a binary that does not
    exist: it turns "codex is not installed" into "codex had nothing to say",
    which is how a whole round can silently drop every account on one backend
    with no loud error (CLAUDE.md's own DeepSeek-key note, and the "no
    response from codex" incidents).

    As a sibling type it passes straight through all of those handlers to the
    composition root, which is the only layer that knows the account name and
    the remedy -- `backend_setup_guard` (defined in `cli/compose_backend.py`,
    re-bound as `cli/compose.py`'s seam) turns it into an `AccountSetupError`
    and exits 75 with both.
    """


class BackendConfigurationError(RuntimeError):
    """The configuration cannot produce a usable backend, or the provider
    refused the credentials it was given.

    The third sibling of `BackendUnavailableError` and
    `BackendBinaryMissingError`, and deliberately not a subclass of either,
    for the reason spelled out at length on `BackendBinaryMissingError`: every
    "the LLM said nothing" call site catches `BackendUnavailableError` and
    degrades to `None`/`""`. That degradation is right for a model that
    answered with nothing, and wrong for an unknown provider, a missing key,
    or a 401 -- which would otherwise be reported as "the model had nothing to
    say" and cost the same misdirected debugging session the codex and
    DeepSeek incidents already cost this project.

    As a sibling it passes through those handlers untouched to
    `backend_setup_guard` (`cli/compose_backend.py`, reached as
    `compose.backend_setup_guard`), which is the only layer that knows the account
    name and the remedy.
    """
