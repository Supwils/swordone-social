"""How a command turns a failure into its SKIP line and exit code.

`act`, `dream`, `cycle` and the samplers wrap composition-plus-run in ONE
broad guard each, so ANY exception -- not an enumerated list of them -- exits
75 (fix round 2, task-13-report.md). The invariant is "no setup failure may
leave the 0/66/75 contract", not "these particular exceptions":
`cycle-one.sh` and the round driver branch on those codes, and a raw
traceback/exit 1 is a code neither knows how to read. `skip_for_exception`
draws exactly one distinction inside that guard -- see its docstring.

The policy gates (`swil_agent/policy.py`) raise domain errors; the
`enforce_*` helpers here map them to the operator line and exit code each
command has always printed, byte for byte.
"""

from __future__ import annotations

import logging
import os
from typing import Final

import typer

from swil_agent.cli.app import EXIT_NO_ACTION
from swil_agent.config import Settings
from swil_agent.models import Persona
from swil_agent.persona.source import PersonaSource
from swil_agent.policy import (
    PRODUCTION_HOST,
    EraNotOpenError,
    ProductionWritesRefusedError,
    refuse_production_writes,
    require_era_start,
)

logger = logging.getLogger("swil_agent.cli")


class AccountSetupError(RuntimeError):
    """A KNOWN, remediable account/environment misconfiguration.

    Raised ONLY by the CLI's own composition helpers (`cli/compose.py`,
    `cli/stores.py`, this module; never by anything below them) at the exact
    point one of them discovers the cause -- which is also the only point
    that can produce a good remedy, since only the helper that failed knows
    what it was trying to do. Every message is already a complete "cause --
    remedy" sentence, so a command's outer guard can print it verbatim as the
    SKIP line.

    This is the single type that guard classifies as "not a bug" -- see
    `skip_for_exception` for why a curated type beats enumerating library
    exceptions one except-clause at a time.
    """


class SweepResumeRefusedError(RuntimeError):
    """`--resume` of a sweep's thread from outside that sweep (S2 §3).

    A sweep thread's data is filed under the sweep's round id, so a late
    resume -- an operator hours later, or a stale shell -- would mix a
    different moment's cycle into that round. Only the sweep itself, whose
    `SWIL_ROUND_ID` is that id, may resume it. Exit 64: the invocation is
    wrong, not the account; the remedy is a fresh manual `cycle`.
    """


# `LockBusy` left this tuple in S3 (§12.11): `FileLock` is taken only inside
# `RunLease`, which re-raises it as `LeaseBusy`, and `lease_busy_guard` turns
# that into an `AccountSetupError` with a remedy before it gets here.
_KNOWN_SETUP_FAILURES: tuple[type[Exception], ...] = (AccountSetupError,)


def skip_for_exception(name: str, exc: Exception) -> None:
    """The one classification point every reachable exception in `act`/
    `dream` funnels through once it escapes composition-plus-run (fix round
    2, task-13-report.md): prints the SKIP line and lets the caller decide
    the exit code (always 75 here; this function never raises).

    `AccountSetupError` is the KNOWN, non-buggy shape -- its own `str()` is
    already a complete message (cause and a concrete remedy) and is used
    verbatim. Anything
    else is NOT one of those, by construction: a genuine bug, logged in a
    visibly DIFFERENT form (`UNEXPECTED <Type>: <message>`) so it can never
    be misread as "this account just needs fixing" -- collapsing that
    distinction away is the exact trade `set -e` made in Bash and the
    reason exit-code masking went unnoticed for months. The traceback goes
    to the DEBUG log (recoverable, not the operator's primary output),
    never to the SKIP line itself.
    """
    if isinstance(exc, _KNOWN_SETUP_FAILURES):
        typer.echo(f"SKIP {name} -- {exc}")
    else:
        logger.debug("unexpected failure for %s", name, exc_info=exc)
        typer.echo(f"SKIP {name} -- UNEXPECTED {type(exc).__name__}: {exc}")


def load_persona_or_raise_setup_error(persona_source: PersonaSource, name: str) -> Persona:
    """`persona_source.load(name)`, converting a malformed-but-PRESENT
    persona's `ValueError` (`persona/loader.py`'s `load_persona` -- e.g.
    missing frontmatter or a card over the size limit) into
    `AccountSetupError`.

    Deliberately does NOT catch `FileNotFoundError`: that means "no such
    account" (exit 66), a different question from "this account exists but
    its personality.md won't parse" (exit 75, a setup problem) -- letting it
    propagate keeps both commands' own `except FileNotFoundError` the one
    place that distinction is made.
    """
    try:
        return persona_source.load(name)
    except ValueError as exc:
        raise AccountSetupError(
            f"{name}: personality.md exists but could not be parsed ({exc}) "
            "-- fix its YAML frontmatter, the card, or the `## 最近` list "
            "(see persona/format.py)"
        ) from exc


def env_flag(name: str) -> bool:
    """A process-env safety flag. Read from os.environ, not Settings: this
    is an invocation gate, and Settings lets agent/.env outrank the caller
    (file-wins). SWIL_REQUIRE_NON_PROD=1 on the command line must always
    win."""
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def enforce_production_guard(settings: Settings, *, i_mean_production: bool) -> None:
    """`policy.refuse_production_writes`, reported: the refusal line on
    stderr and exit 75."""
    try:
        refuse_production_writes(
            settings.swil_url,
            i_mean_production=i_mean_production,
            require_non_prod=env_flag("SWIL_REQUIRE_NON_PROD"),
        )
    except ProductionWritesRefusedError as exc:
        typer.echo(
            f"SWIL_REQUIRE_NON_PROD=1: SWIL_URL host is the production host "
            f"({PRODUCTION_HOST}). Pass --i-mean-production, or point SWIL_URL "
            "at staging.",
            err=True,
        )
        raise typer.Exit(EXIT_NO_ACTION) from exc


ERA_START_REMEDY: Final = (
    "ERA_START is unset: every Era 3 round reads since=<ERA_START>. "
    "Set ERA_START=<ISO 8601 launch instant> in agent/.env (see agent/.env.example)."
)


def enforce_era_gate(settings: Settings) -> None:
    """`policy.require_era_start`, reported: exit 75 when no era is open,
    with `ERA_START_REMEDY` on stderr."""
    try:
        require_era_start(settings.era_start)
    except EraNotOpenError as exc:
        typer.echo(ERA_START_REMEDY, err=True)
        raise typer.Exit(EXIT_NO_ACTION) from exc
