"""CLI entrypoints, argument-compatible with the Bash scripts where they overlap.

Exit codes: 66 = no such account, 75 = no action ran or a setup failure, so
`cycle-one.sh` can branch on them. `ActOutcome`/`DreamResult` are the
internal representation; the process exit code is the external contract.

Mapping, by command:

  * `act`  -- `ActResult.grants_dream` (design spec §7.1) IS the exit-code
    decision: `True` (landed, partial, vetoed-empty, planner-empty -- every
    outcome except a dead backend or an unreachable platform) exits 0,
    `False` exits 75. A rhythm-vetoed or deliberately empty plan is NOT a
    failure: conflating them is exactly the bug `grants_dream` exists to fix
    (CLAUDE.md, "Empty plan counts as failure"). A caller that branches on
    this exit code to decide whether to run `dream` next gets that decision.
  * `dream` -- `DreamResult.proceeded` is the exit-code decision:
    `False` (a cooldown SKIP -- the LLM was never even called) exits 75,
    matching "no action ran"; `True` (the dream ran, whether its list was
    written or the reply was unusable) exits 0, matching
    "something ran". This mirrors `act`'s "attempted vs never-attempted" shape
    rather than inventing a third scheme.
  * Everything else -- ANY exception, not an enumerated list of them --
    also exits 75, via ONE broad guard wrapping composition-plus-run in each
    command (fix round 2, task-13-report.md). The invariant is "no setup
    failure may leave the 0/66/75 contract", not "these particular
    exceptions": `cycle-one.sh` and the round driver branch on those three
    codes, and a raw traceback/exit 1 is a fourth code neither knows how to
    read. `_skip_for_exception` draws exactly one distinction inside that
    guard, because collapsing it away would be worse than the bug it fixes:

      - `AccountSetupError` (raised only by this module's own composition
        helpers, at the exact point each one knows both the cause and the
        remedy: `_resources_for` for no credentials or a failed
        `PasswordAuth.login()`, `_backend_for` for a dead backend key,
        `_load_persona_or_raise_setup_error` for a personality.md that
        exists but won't parse) and `LockBusy` are KNOWN, remediable setup
        problems -- not bugs. Their own message (already a complete "cause
        -- remedy" sentence) becomes the SKIP line verbatim.
      - Anything else is, by definition, NOT one of those -- a genuine
        programming error. Logged as `UNEXPECTED <ExceptionType>: <message>`
        (never disguised as a setup problem someone could fix by running
        `swil-agent register`) with its traceback at DEBUG, so it is recoverable
        by whoever is looking without being the operator's primary output.

This module is the ONLY composition root in the package: the one place
allowed to import every layer (`api/`, `llm/`, `embedder/`, `persona/`,
`act/`, `dream/`) at once and wire concrete collaborators together from a
`Settings` instance and an account name. Every module below it stays
unit-testable in isolation because none of them constructs its own
collaborators -- see `act/round.py`'s and `dream/round.py`'s own module
docstrings for the same argument from their side of the seam.

The small `_..._for(...)` builder functions below exist so CLI tests can
replace exactly one layer at a time (e.g. monkeypatch `_resources_for` to
return a `FakeResources()` double) without needing to fake Typer's argument
parsing or reach into `swil_agent.api`/`swil_agent.llm` internals from the
test module. `tests/unit/test_cli.py` monkeypatches every network- and
subprocess-facing one of these for its `CliRunner` tests, and calls several
of them directly (over `httpx.MockTransport`) so they are not *only* ever
exercised through a monkeypatched stand-in for themselves.
"""

from __future__ import annotations

import json
import logging
import os
import random
import shutil
import sqlite3
import subprocess
from collections.abc import Iterator
from contextlib import ExitStack, closing, contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Annotated, Any, Final, Protocol
from urllib.parse import urlparse

import httpx
import typer

from swil_agent import __version__
from swil_agent.act.context import (
    platform_activity,
    read_news_digest,
    render_follow_topics_feed,
    render_now_context,
)
from swil_agent.act.round import run_act
from swil_agent.analysis.behavior_snapshot import run_behavior_snapshot
from swil_agent.analysis.intervention import (
    DatingBasis,
    InterventionKind,
    build_intervention_event,
    run_intervention,
)
from swil_agent.analysis.population_metric import (
    ACCOUNTS_DIR,
    API_KEY_FILENAME,
    find_account_with_api_key,
)
from swil_agent.analysis.population_metric import run_population_metric as run_metric
from swil_agent.analysis.summary import local_today, run_summary
from swil_agent.api.auth import ApiKeyAuth, PasswordAuth, resolve_auth
from swil_agent.api.client import ApiClient, ApiError
from swil_agent.api.resources import Resources
from swil_agent.config import Settings, load_settings
from swil_agent.dream.candidate import DreamState, FilesystemDreamState
from swil_agent.dream.round import run_dream
from swil_agent.embedder.client import EmbedderClient, EmbedderUnavailable
from swil_agent.embedder.guard import EmbedderGuard
from swil_agent.graph.checkpoint import (
    CHECKPOINT_DB_NAME,
    Checkpointer,
    checkpointer_at,
    latest_round_id,
)
from swil_agent.graph.cycle import run_cycle
from swil_agent.graph.leases import LEASE_DB_NAME, LeaseBusy, open_lease_db
from swil_agent.graph.nodes import CycleDeps, agent_dir_name
from swil_agent.graph.state import BUILTIN_TENANT, CycleState
from swil_agent.llm.base import (
    Backend,
    BackendBinaryMissingError,
    BackendConfigurationError,
    BackendUnavailableError,
    CompletionRequest,
    Runner,
    SubprocessRunner,
)
from swil_agent.llm.factory import get_backend
from swil_agent.llm.selection import (
    BackendChoice,
    apply_choice,
    cli_choice_for,
    resolve_backend_choice,
)
from swil_agent.locks import LockBusy
from swil_agent.models import ActResult, DreamResult, Persona
from swil_agent.persona.format import PersonaFormatError
from swil_agent.persona.loader import load_persona
from swil_agent.persona.source import GitPersonaSource, PersonaSource
from swil_agent.register import RegisterError, register_account

logger = logging.getLogger(__name__)

# This module's DREAM-PHASE channel. Only the round-level embedder-down ERROR
# uses it, and it exists so that record lands in `dream.log` from `cycle` as
# well as from `dream` -- under `dream` the whole invocation goes to that file
# anyway, and a probe that changed file depending on which command ran it is
# the kind of inconsistency nobody notices until they grep for it. See
# `_DREAM_LOG_SOURCES`.
dream_logger = logging.getLogger(f"{__name__}.dream")

EXIT_OK = 0
EXIT_NO_SUCH_ACCOUNT = 66
EXIT_NO_ACTION = 75

# Spec §3 / §11. Compared as a hostname, never as a substring of SWIL_URL.
PRODUCTION_HOST: Final = "swil-social-api-production.up.railway.app"
DEFAULT_MEASURE_SINCE: Final = "2026-07-25"
_HEARTBEAT_LABEL: Final = "com.swil.heartbeat"

_HEALTH_TIMEOUT = 10.0

_EMBEDDER_DOWN_AFTER_GUARD_UP = (
    "embedder unreachable after guard up (embedder_url=%s) -- every dream "
    "snapshot this invocation uploads will fail with its own per-dream WARN, "
    "and the duplicate guard fails open."
)


class AccountSetupError(RuntimeError):
    """A KNOWN, remediable account/environment misconfiguration.

    Raised ONLY by this module's own composition helpers (never by anything
    below them) at the exact point one of them discovers the cause -- which
    is also the only point that can produce a good remedy, since only the
    helper that failed knows what it was trying to do. Every message is
    already a complete "cause -- remedy" sentence, so `act`/`dream`'s outer
    guard can print it verbatim as the SKIP line.

    This is the single type that guard classifies as "not a bug" (alongside
    `LockBusy`, which predates this type and keeps its own more detailed
    message) -- see `_skip_for_exception` and the module docstring's mapping
    section for why a curated type beats enumerating library exceptions one
    except-clause at a time.
    """


app = typer.Typer(add_completion=False, help="Swil Social agent runtime")


@app.callback()
def _main() -> None:
    """Runs before every command. `force=False` (the default): a no-op if a
    handler is already configured -- e.g. by pytest's own logging capture --
    so tests never get a second, duplicate stream of output."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")


_ROUND_LOG_FORMAT: Final = "[%(asctime)s] %(message)s"
_ROUND_LOG_DATE_FORMAT: Final = "%Y-%m-%d %H:%M:%S"
_round_log_handlers: list[logging.Handler] = []
_round_log_key: tuple[tuple[str, tuple[str, ...] | None], ...] = ()


ACT_LOG_FILENAME: Final = "auto-run.log"
DREAM_LOG_FILENAME: Final = "dream.log"

# Which loggers emit DREAM-phase records. Used ONLY by `cycle`, which is the
# one command that produces both phases in a single process and therefore
# needs the two files' contents decided per record rather than per command.
#
# `act` and `dream` still attach one unfiltered handler each -- a `dream`
# invocation emits only dream-phase records, an `act` invocation only
# act-phase ones, so filtering there would be machinery with no failure mode
# to prevent.
#
# Matching is by dotted-prefix, so `swil_agent.graph.nodes.dream` (the dream
# node's deadline FAIL) routes to `dream.log` while its parent
# `swil_agent.graph.nodes` (the cycle's own logout record) does not.
# `swil_agent.cli.dream` is this module's own dream-phase channel -- the
# round-level embedder-down ERROR, which `swil-agent dream` already writes to
# `dream.log` and which must not change file just because the same probe ran
# inside a cycle.
# `swil_agent.analysis.*` is deliberately ABSENT, so the cycle-wired samplers
# land in `auto-run.log`: the behaviour snapshot embeds the posts this round's
# act phase produced, so it belongs with the act log.
_DREAM_LOG_SOURCES: Final[tuple[str, ...]] = (
    "swil_agent.dream",
    "swil_agent.embedder",
    "swil_agent.graph.nodes.dream",
    "swil_agent.cli.dream",
)


class _PhaseFilter(logging.Filter):
    """Keep (or drop) records emitted by one phase's loggers.

    One class, two instances, one source list: `keep=True` for `dream.log`
    and `keep=False` for `auto-run.log`. Two independent lists would be two
    things to keep in sync, and a record matching neither would silently land
    in no file at all -- which reads exactly like a round that never ran.
    """

    def __init__(self, sources: tuple[str, ...], *, keep: bool) -> None:
        super().__init__()
        self._sources = sources
        self._keep = keep

    def filter(self, record: logging.LogRecord) -> bool:
        matched = any(
            record.name == source or record.name.startswith(f"{source}.")
            for source in self._sources
        )
        return matched is self._keep


def _attach_round_log(settings: Settings, filename: str) -> logging.Handler | None:
    """Mirror every `swil_agent` log record into `agent/logs/<filename>`, in
    the act/dream log format.

    **The filename is PER COMMAND, and getting it wrong is silent.** Act
    records go to `auto-run.log` and dream records to `dream.log`
    (`ACT_LOG_FILENAME`/`DREAM_LOG_FILENAME`, passed explicitly rather than
    defaulted). Sending both to one file leaves the other empty: anyone
    grepping `dream.log` for a round's verdict finds nothing, and anyone
    counting act lines in `auto-run.log` counts dream lines too.

    Each line is `[YYYY-MM-DD HH:MM:SS] <message>`, echoed to stdout AND
    appended to the file under `agent/logs/`, with NO level name, so a
    straggler reconciliation or a post-run QA pass can grep for it. Without
    this a round leaves both files untouched, which reads exactly like a
    round that never ran.

    `basicConfig`'s stderr stream is untouched and keeps its
    `%(levelname)s %(message)s` shape. The one cosmetic difference from Bash
    is that its second copy goes to stdout, not stderr.

    Attached to the `swil_agent` logger, NOT the root: the root would also
    capture `httpx`'s own INFO-level "HTTP Request: ..." line for every API
    call, which `auto-run.log` has never contained.

    At most ONE round-log ATTACHMENT exists at a time (one handler for
    `act`/`dream`, two for `cycle`). Re-attaching the same one is a no-op (a
    `CliRunner`-driven test invokes the app many times in one process, and a
    second handler would double every line); attaching a DIFFERENT one --
    including the other command's -- closes and replaces the previous
    attachment rather than accumulating open files across a session.

    Returns the handler, or `None` if the file could not be opened -- a
    round must not die because a log file could not be opened.
    """
    handlers = _attach_round_logs(settings, ((filename, None),))
    return handlers[0] if handlers else None


def _attach_cycle_logs(settings: Settings) -> list[logging.Handler]:
    """`cycle`'s TWO round logs, split by phase.

    A cycle acts AND dreams inside one process, so "which file does this line
    belong in" cannot be answered per command the way it is for `act` and
    `dream` -- it has to be answered per RECORD. `_DREAM_LOG_SOURCES` is that
    answer, and the two filters are complementary halves of one list so no
    record can fall through into neither file.

    The failure this prevents is silent in exactly the way ruling R20's was:
    a cycle that sent both phases to `auto-run.log` leaves `dream.log` empty,
    and every straggler-reconciliation grep for a dream verdict comes back
    with nothing while the act log's line counts are quietly inflated.
    """
    return _attach_round_logs(
        settings,
        (
            (ACT_LOG_FILENAME, None),
            (DREAM_LOG_FILENAME, _DREAM_LOG_SOURCES),
        ),
    )


def _attach_round_logs(
    settings: Settings, specs: tuple[tuple[str, tuple[str, ...] | None], ...]
) -> list[logging.Handler]:
    """Install exactly the round-log handlers `specs` describes, replacing
    whatever was installed before.

    Each spec is `(filename, dream_sources)`. `dream_sources=None` means "no
    filter, take every `swil_agent` record" -- what `act` and `dream` use.
    A non-`None` value installs the DREAM half of the split on that file and
    the ACT half (its complement) on every other file in the same
    attachment, which is how one list drives both filters.

    The key includes the resolved paths AND the source tuples, so switching
    between `act`'s single unfiltered `auto-run.log` and `cycle`'s filtered
    pair is detected as a different attachment even though both include a
    handler on the same path.
    """
    global _round_log_handlers, _round_log_key
    package_logger = logging.getLogger("swil_agent")
    key = tuple((str(settings.agent_root / "logs" / name), sources) for name, sources in specs)
    if key == _round_log_key:
        return _round_log_handlers

    for existing in _round_log_handlers:
        package_logger.removeHandler(existing)
        existing.close()
    _round_log_handlers = []
    _round_log_key = ()

    installed: list[logging.Handler] = []
    dream_sources = next((sources for _, sources in specs if sources is not None), None)
    for filename, sources in specs:
        path = settings.agent_root / "logs" / filename
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            handler = logging.FileHandler(path, mode="a", encoding="utf-8")
        except OSError as exc:
            logger.warning("could not open %s for the round log: %s", path, exc)
            continue
        handler.setFormatter(logging.Formatter(_ROUND_LOG_FORMAT, datefmt=_ROUND_LOG_DATE_FORMAT))
        # Level on the HANDLER, never on the logger: `_skip_for_exception`
        # logs its traceback at DEBUG, and raising the LOGGER's level would
        # discard that record before any handler (including pytest's caplog)
        # saw it. Bash's `auto-run.log` has no debug tier, so the file takes
        # INFO and up.
        handler.setLevel(logging.INFO)
        if dream_sources is not None:
            handler.addFilter(_PhaseFilter(dream_sources, keep=sources is not None))
        package_logger.addHandler(handler)
        installed.append(handler)
    _round_log_handlers = installed
    # Only remember the attachment if EVERY file opened. A partial (or empty)
    # install must stay retryable, matching the previous single-handler
    # behaviour where a failed open left the module global at `None`.
    _round_log_key = key if len(installed) == len(specs) else ()
    return installed


# ── composition helpers (the seams CLI tests monkeypatch or call directly) ─


def _persona_source_for(settings: Settings) -> PersonaSource:
    return GitPersonaSource(settings.agent_root)


def _resources_for(
    persona: Persona, settings: Settings, *, transport: httpx.BaseTransport | None = None
) -> Resources:
    """`resolve_auth` picks Bearer (`api_key.txt`) over the `SWIL_PASS`
    session-cookie fallback (`api/auth.py`, contract `02` §2.9). The Bearer
    path needs nothing further -- `ApiKeyAuth.headers()` is ready to use the
    moment it is constructed. The cookie path does: `PasswordAuth.cookies()`
    is empty until `login()` runs (its own docstring), so without an
    explicit login here every read/write over that fallback would 401
    silently into whatever degrade path the caller has, and a real account
    that only has `SWIL_PASS` (no `api_key.txt` yet) would never actually
    authenticate. `transport` is an injection seam for tests
    (`httpx.MockTransport`); production callers never pass it.
    """
    try:
        auth = resolve_auth(
            persona.directory, username=persona.username, password=settings.swil_pass
        )
    except ValueError as exc:
        raise AccountSetupError(_auth_setup_remedy(persona, settings)) from exc

    client = ApiClient(settings.swil_url, auth, transport=transport)
    if isinstance(auth, PasswordAuth):
        try:
            auth.login(client)
        except RuntimeError as exc:
            # Scoped to ONLY this one call, not the whole function body --
            # `PasswordAuth.login` raises `ApiError`/`TransportError` (both
            # `RuntimeError` subclasses, api/client.py) on a failed HTTP
            # request, or a bare `RuntimeError("login succeeded but no sid
            # cookie was returned")` on a 2xx with no cookie -- both are the
            # SAME known failure shape ("this account's SWIL_PASS did not
            # authenticate"), never a bug in this module.
            raise AccountSetupError(
                f"login failed for {persona.username} via SWIL_PASS: {exc} -- "
                "check SWIL_PASS in agent/.env (wrong password, an expired "
                "session config, or the platform was unreachable)"
            ) from exc
    return Resources(client)


def _resources_for_key(
    directory: Path, settings: Settings, *, transport: httpx.BaseTransport | None = None
) -> Resources:
    """A `Resources` authorised by ONE account's `api_key.txt` and nothing
    else -- the shape `population-metric` needs.

    `POST /agents/population-metric` is a global route: picking an account
    here is picking a CREDENTIAL, never a subject. So this
    deliberately does NOT go through `_resources_for`, which would need a
    `Persona` -- i.e. a parseable `personality.md` the call does not consult.
    Requiring one would make an account with a key but a broken personality
    abort the run.

    There is no `PasswordAuth` fallback for the same reason: `find_account_
    with_api_key` has already established the file exists, and falling back to
    a session cookie would authenticate as an account the caller did not pick.
    """
    try:
        auth = ApiKeyAuth.from_file(directory / API_KEY_FILENAME)
    except (FileNotFoundError, ValueError) as exc:
        # ValueError is the present-but-BLANK file (spec §15.1 row 3). Bash's
        # `-f` test passes on it and sends `Authorization: Bearer `, which the
        # server 401s -- reported as "server rejected". Naming it here instead
        # sends the reader to the file rather than to the server.
        raise AccountSetupError(
            f"{directory.name}: no usable {API_KEY_FILENAME} ({exc}) -- run "
            f"`uv run --project agent swil-agent register {directory.name}`"
        ) from exc
    return Resources(ApiClient(settings.swil_url, auth, transport=transport))


def _auth_setup_remedy(persona: Persona, settings: Settings) -> str:
    """The message for `resolve_auth`'s `ValueError` (no usable
    `api_key.txt` -- missing OR present-but-blank, `api/auth.py`'s own
    `resolve_auth` already catches both shapes of that before falling
    through -- AND no `SWIL_PASS`), named so the CLI's SKIP line sends
    whoever reads it to the fix rather than to a stack trace.

    The fix is `swil-agent register <account-dir-name>`.
    """
    rel = persona.directory.relative_to(settings.agent_root)
    return (
        f"no api_key.txt and no SWIL_PASS for {persona.username} ({rel}) -- "
        f"run `uv run --project agent swil-agent register {rel.name}`, "
        "or set SWIL_PASS in agent/.env"
    )


def _backend_setup_remedy(persona: Persona, exc: Exception) -> str:
    """The message for a `BackendUnavailableError`, wherever it was raised.

    Two call sites, deliberately sharing one wording: `_backend_for` (the
    backend could not be CONSTRUCTED -- a `deepseek` account with no or
    empty `~/.claude/.deepseek-key`) and `_backend_setup_guard` (the backend
    could not be RUN -- `SubprocessRunner` re-raises a missing `claude`/
    `codex` binary as this same type). Both are the same operator-facing
    problem, "this account's backend is not usable on this machine", and
    both want the same remedy.
    """
    return (
        f"backend unavailable for {persona.username} "
        f"(backend={persona.backend!r}): {exc} -- for deepseek, place the "
        "key at ~/.claude/.deepseek-key (one line, chmod 600, no "
        "surrounding whitespace); other backends need the matching CLI "
        "(claude/codex) on PATH and authenticated"
    )


def _select_backend(
    persona: Persona,
    settings: Settings,
    *,
    backend_override: str | None = None,
    model_override: str | None = None,
) -> tuple[Persona, Backend]:
    """Resolve which model this round runs, build it, and say so in the log.

    Returns the persona with the resolution applied (see
    `llm/selection.py`'s `apply_choice` for why the answer travels on the
    Persona rather than as a tenth parameter) alongside the built backend.

    The log line is not decoration. `agentBackend` records what ran, but only
    on the profile, only for a round that got as far as the act path's sync,
    and only as a value with no provenance -- so a round that ran opus because
    someone left `SWIL_LLM_MODEL` exported is indistinguishable, after the
    fact, from one that ran opus because the persona file says opus. The
    experiment's independent variable deserves a line in the round's own log
    naming the value AND where it came from.
    """
    try:
        choice, warnings = resolve_backend_choice(
            persona,
            settings,
            backend_override=backend_override,
            model_override=model_override,
        )
    except BackendConfigurationError as exc:
        raise AccountSetupError(_backend_setup_remedy(persona, exc)) from exc

    for warning in warnings:
        logger.warning("WARN %s", warning)
    logger.info("%s — %s", persona.username, choice.describe())

    resolved = apply_choice(persona, choice)
    # The api kind goes straight to the factory; every CLI kind goes through
    # `_backend_for`, which is the name ~18 tests replace to keep a unit test
    # from shelling out to the real `claude` binary. Routing the CLI kinds past
    # it would silently un-fake all of them -- which is exactly what happened
    # the first time this function was written, and it showed up as the suite
    # hanging on a live `claude -p` rather than as a failure.
    if choice.kind == "api":
        return resolved, _api_backend_for(resolved, choice, settings)
    return resolved, _backend_for(resolved, settings)


def _api_backend_for(persona: Persona, choice: BackendChoice, settings: Settings) -> Backend:
    try:
        return get_backend(choice, SubprocessRunner(), settings)
    except (BackendConfigurationError, BackendUnavailableError) as exc:
        raise AccountSetupError(_backend_setup_remedy(persona, exc)) from exc


def _backend_for(persona: Persona, settings: Settings) -> Backend:
    """Wraps `build_backend`'s `BackendUnavailableError` (`llm/base.py` --
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
        raise AccountSetupError(_backend_setup_remedy(persona, exc)) from exc


@contextmanager
def _backend_setup_guard(persona: Persona) -> Iterator[None]:
    """Turn a `BackendUnavailableError` raised DURING the round into the same
    `AccountSetupError` `_backend_for` raises when construction fails.

    Needed because a missing backend binary is not discoverable at
    construction time: `build_backend` only picks a class, and the CLI is not
    invoked until the first `complete()` call, deep inside `run_act`/
    `run_dream`. `SubprocessRunner` re-raises `subprocess`'s
    `FileNotFoundError` as `BackendBinaryMissingError` -- a SIBLING of
    `BackendUnavailableError`, so it survives every "the LLM said nothing"
    handler between there and here -- precisely so this guard can attach the
    account name and the remedy at the composition root, keeping ruling R17's
    invariant that `AccountSetupError` is raised only by this module, at the
    point that knows both the cause and the fix.

    `BackendUnavailableError` is caught here too, for the narrow window where
    one escapes a step that does not degrade on it.

    Scoped to the round call alone, not the whole command body, for the same
    reason `_resources_for`'s `RuntimeError` catch is scoped to `login()`:
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
        raise AccountSetupError(_backend_setup_remedy(persona, exc)) from exc


def _runner_for(settings: Settings) -> Runner:
    _ = settings  # no per-runner settings today; kept for interface stability
    return SubprocessRunner()


def _embedder_for(
    settings: Settings, *, transport: httpx.BaseTransport | None = None
) -> EmbedderClient:
    return EmbedderClient(settings.embedder_url, transport=transport)


def _guard_for(settings: Settings) -> EmbedderGuard:
    return EmbedderGuard(settings.agent_root, runner=SubprocessRunner())


class _Guard(Protocol):
    """The two calls a command makes on the embedder daemon's lifecycle.

    Named as a Protocol so `cycle` can hold either the real `EmbedderGuard` or
    the dry-run no-op below in ONE variable, and keep `guard.up()` /
    `finally: guard.down()` unconditional. A `if not dry_run: guard.up()` pair
    with a matching `finally` is the shape that eventually leaks a started
    daemon on some third branch.
    """

    def up(self) -> None: ...

    def down(self) -> None: ...


class _DryRunGuard:
    """The embedder guard a shadow round gets: nothing at all.

    A dry cycle is routed away from the dream phase entirely, so it needs no
    vectors. Running the real guard is not merely
    redundant -- `embedder-guard.sh` writes `.agent-state/embedder_guard/*`
    and `logs/embedder.log`, and boots the bge-m3 daemon (up to 150s of
    startup) if nothing is serving. Spec §10 stage 3's exit criterion is
    "nothing to revert; Python never wrote".
    """

    def up(self) -> None:
        return

    def down(self) -> None:
        return


def _state_for(settings: Settings) -> DreamState:
    return FilesystemDreamState(settings.agent_root / ".agent-state")


def _health_check(settings: Settings, *, transport: httpx.BaseTransport | None = None) -> bool:
    """A raw, UNPREFIXED GET to `${SWIL_URL}/health` -- `ApiClient` always
    prefixes `/api/v1` (api/client.py), so this stays outside it entirely
    rather than mixing a bare-URL HTTP concern into that module. Mirrors
    `run_act`'s own module docstring, which makes the identical call for the
    identical reason: nothing else in this package performs this one raw
    request.
    """
    try:
        with httpx.Client(transport=transport, timeout=_HEALTH_TIMEOUT) as client:
            response = client.get(f"{settings.swil_url}/health")
    except httpx.HTTPError:
        return False
    return response.status_code == 200


def _context_now_for(
    resources: Resources,
    persona: Persona,
    settings: Settings,
    *,
    now: datetime,
    runner: Runner,
) -> str:
    """The world-context block, RENDERED for this account (rulings R25/R26).

    Nothing is written back (R26): there is no shared `context/now.md`, so
    the per-account `当前 Agent` line is not something five parallel rounds
    race on.

    `now` is threaded in rather than taken here so the whole round -- this
    block, `run_act`'s `today`, the memory line it writes -- agrees on one
    clock; `_cycle_deps_for` already freezes one for exactly that reason.
    """
    return render_now_context(
        username=persona.username,
        now=now,
        activity=platform_activity(resources, persona, now=now, era_start=settings.era_start),
        news=read_news_digest(settings.agent_root, runner),
    )


def _feed_context_for(
    resources: Resources,
    persona: Persona,
    *,
    now: datetime,
    era_start: datetime | None = None,
) -> str:
    """The follow-topics feed, RENDERED for this account from `persona.topics`
    (never read from a stale `context/feed_for_*.md`), era-filtered."""
    return render_follow_topics_feed(resources, persona, now=now, era_start=era_start)


def _probe_embedder(embedder: EmbedderClient, settings: Settings) -> None:
    """R10 (progress.md, forwarded from Tasks 2 and 12): `EmbedderGuard.up()`
    cannot fail loudly -- `embedder-guard.sh` always exits 0 by design (its
    own comment: "a guard must never abort its caller"). Left unchecked, a
    dead daemon surfaces only as a per-dream snapshot WARN, which reads
    identically whether ONE dream's embed call happened to fail or the
    embedder has been down for the whole round.

    This probe runs exactly once per CLI invocation of `dream` (right after
    `guard.up()`, before any account-specific work), at ERROR -- the loud,
    round-level signal the per-dream WARN deliberately is not.
    """
    try:
        embedder.health()
    except EmbedderUnavailable:
        dream_logger.error(_EMBEDDER_DOWN_AFTER_GUARD_UP, settings.embedder_url)


def _do_dream(
    persona: Persona,
    persona_source: PersonaSource,
    settings: Settings,
    *,
    auto: bool,
    backend_override: str | None = None,
    model_override: str | None = None,
) -> DreamResult:
    embedder = _embedder_for(settings)
    _probe_embedder(embedder, settings)

    persona, backend = _select_backend(
        persona,
        settings,
        backend_override=backend_override,
        model_override=model_override,
    )
    return run_dream(
        persona=persona,
        persona_source=persona_source,
        resources=_resources_for(persona, settings),
        backend=backend,
        embedder=embedder,
        state=_state_for(settings),
        settings=settings,
        agent_root=settings.agent_root,
        now=datetime.now(),
        captured_at=datetime.now(UTC),
        auto=auto,
    )


# ── the cycle's own composition seams ────────────────────────────────────


@dataclass
class _CycleStores:
    """The two databases a cycle needs, and the one thing they have in common:
    a dry run gets neither on disk."""

    lease_db: sqlite3.Connection
    checkpointer: Checkpointer | None


@contextmanager
def _cycle_stores(settings: Settings, *, dry_run: bool) -> Iterator[_CycleStores]:
    """Open (and always close) the lease and checkpoint databases.

    Both live in `agent/.agent-state/`, next to `lock_<name>` and the dream
    cooldown markers -- one directory for the Python runtime's local
    per-account state, matching `_state_for` above. The two modules own their
    FILENAMES (`LEASE_DB_NAME`, `CHECKPOINT_DB_NAME`) and this composition
    root owns the directory.

    **A dry run gets an in-memory lease DB and no checkpointer at all.**
    `run_cycle` already takes no lease when `deps.dry_run` is set, so the
    connection is never used -- but `sqlite3.connect(<path>)` CREATES the file
    regardless, and a shadow round that leaves two new databases in
    `.agent-state/` has written to disk during the round whose exit criterion
    is "nothing to revert; Python never wrote" (spec §10 stage 3). Resuming a
    shadow round is meaningless for the same reason there is nothing to
    resume from.
    """
    with ExitStack() as stack:
        target = ":memory:"
        if not dry_run:
            # `sqlite3.connect` does not create missing parents -- it raises
            # `OperationalError: unable to open database file`, which reads as
            # a bug rather than as "this account has never had local state".
            # `open_checkpointer` already mkdirs its own; this is the same
            # directory, and the lease DB is opened first.
            lease_path = _lease_db_path(settings)
            lease_path.parent.mkdir(parents=True, exist_ok=True)
            target = str(lease_path)
        lease_db = stack.enter_context(closing(open_lease_db(target)))
        checkpointer = (
            None if dry_run else stack.enter_context(checkpointer_at(_checkpoint_db_path(settings)))
        )
        yield _CycleStores(lease_db=lease_db, checkpointer=checkpointer)


def _lease_db_path(settings: Settings) -> Path:
    return settings.agent_root / ".agent-state" / LEASE_DB_NAME


def _checkpoint_db_path(settings: Settings) -> Path:
    return settings.agent_root / ".agent-state" / CHECKPOINT_DB_NAME


@contextmanager
def _lease_busy_guard(name: str) -> Iterator[None]:
    """Turn `LeaseBusy` into an `AccountSetupError` carrying a REMEDY.

    `LeaseBusy`'s own message is a cause ("... act lease busy (lock_zenith
    held (12s))") and ruling R17 wants the SKIP line to name the remedy too.
    It has one, and this project has already needed it: an accepted Bash dream
    exits 141 after "snapshot uploaded" and orphans `dream_lock_<name>`, so
    "another run holds it" and "a dead run left it behind" look identical
    until someone checks the pid inside the file (CLAUDE.md, "Accepted-dream
    SIGPIPE orphan lock"). Bash itself only logs `SKIP <name> — locked` and
    moves on, which is why those orphans went unnoticed for whole rounds.
    """

    try:
        yield
    except LeaseBusy as exc:
        raise AccountSetupError(
            f"{name}: {exc} -- another run holds this account. Wait for it, or "
            f"if it is an orphan (`head -1 agent/.agent-state/*lock_{name}` names "
            "a pid that is no longer alive) remove that lock file; leases older "
            "than 1800s are reclaimed automatically"
        ) from exc


def _cycle_deps_for(
    persona: Persona,
    persona_source: PersonaSource,
    settings: Settings,
    *,
    dry_run: bool,
    auto: bool,
    budget: int,
    seed: int | None,
    backend: Backend,
) -> CycleDeps:
    """Everything the ten nodes need, built once per cycle.

    Deliberately the SAME collaborators, read from the same places, that
    `act` hands `run_act` and `dream` hands `run_dream`, so the two paths
    cannot drift into two compositions.

    One real difference, recorded on `CycleDeps` itself: `now` and
    `captured_at` are frozen ONCE here, where `act` and `dream` are two
    processes taking a fresh `datetime.now()` each. Within one cycle that is
    minutes in a memory-line date.

    The backend is the one exception to "built once per cycle, here": it is
    resolved and built by the command body and passed in, because `run_cycle`
    takes the persona separately from the deps and the resolution has to reach
    both halves (see `_select_backend`). Building it here would give the graph
    a persona whose `backend`/`model` disagree with the backend beside it --
    and `agentBackend` is projected from the persona.

    `_probe_embedder` runs here for the same reason `_do_dream` runs it: once
    per invocation, right after `guard.up()`, before any account work --
    `EmbedderGuard.up()` cannot fail loudly (R10). **Except under `dry_run`**:
    a shadow round never dreams or uploads a snapshot, so probing would only
    emit one ERROR per account into `dream.log` for work that does not run.
    """
    embedder = _embedder_for(settings)
    if not dry_run:
        _probe_embedder(embedder, settings)
    # Hoisted out of the `CycleDeps(...)` call because the world-context
    # renderers below need the SAME three: one `Resources` (a second one would
    # re-run `PasswordAuth.login` for an account without an api_key.txt), one
    # `Runner`, and the one `now` this cycle is frozen at.
    resources = _resources_for(persona, settings)
    runner = _runner_for(settings)
    now = datetime.now()
    return CycleDeps(
        resources=resources,
        backend=backend,
        persona_source=persona_source,
        embedder=embedder,
        dream_state=_state_for(settings),
        settings=settings,
        agent_root=settings.agent_root,
        health_check=lambda: _health_check(settings),
        memory_text=persona_source.read_memory(agent_dir_name(persona)),
        context_now=_context_now_for(resources, persona, settings, now=now, runner=runner),
        feed_context=_feed_context_for(resources, persona, now=now, era_start=settings.era_start),
        budget=budget,
        access_key=settings.unsplash_access_key,
        dry_run=dry_run,
        auto=auto,
        rng=random.Random(seed),
        now=now,
        captured_at=datetime.now(UTC),
    )


def _resume_round_id(stores: _CycleStores, agent: str) -> str:
    """The round id `--resume` continues, read back out of the checkpoint
    database.

    Recomputing it from the clock (`run_cycle`'s own default) would build a
    DIFFERENT `thread_id` and silently start a brand-new cycle instead of
    continuing the interrupted one -- the failure mode where `--resume`
    appears to work and quietly re-runs the act phase, re-posting whatever
    already landed.
    """
    if stores.checkpointer is None:
        raise AccountSetupError(
            f"{agent}: --resume and --dry-run are mutually exclusive -- a shadow "
            "round writes no checkpoint, so there is nothing to continue from"
        )
    found = latest_round_id(stores.checkpointer, BUILTIN_TENANT, agent)
    if found is None:
        raise AccountSetupError(
            f"{agent}: no checkpointed cycle to resume -- run "
            f"`swil-agent cycle {agent}` (without --resume) first, or check that "
            f"{_checkpoint_db_path_hint()} still exists"
        )
    return found


def _checkpoint_db_path_hint() -> str:
    return f"agent/.agent-state/{CHECKPOINT_DB_NAME}"


# ── reporting ────────────────────────────────────────────────────────────


def _describe_plan(result: ActResult) -> str:
    if result.plan is None or not result.plan.actions:
        return "(nothing)"
    return ", ".join(action.kind for action in result.plan.actions)


def _report_act_result(name: str, result: ActResult, *, dry_run: bool) -> None:
    if dry_run:
        typer.echo(
            f"[dry-run] {name}: outcome={result.outcome.value} -- "
            f"would execute: {_describe_plan(result)}"
        )
    else:
        typer.echo(
            f"{name}: outcome={result.outcome.value} landed={result.landed}/{result.attempted}"
        )
    if result.rhythm is not None and result.rhythm.roll is not None:
        typer.echo(
            f"  rhythm: policy={result.rhythm.policy.value} roll={result.rhythm.roll}"
            f"/{result.rhythm.post_probability}"
        )
    for vetoed in result.vetoed:
        typer.echo(f"  vetoed: {vetoed.action.kind} -- {vetoed.reason}")


def _report_dream_result(name: str, result: DreamResult) -> None:
    if not result.proceeded:
        typer.echo(f"SKIP {name} -- {result.reason}")
    elif result.accepted:
        typer.echo(f"{name}: dream written -- 最近 updated ({len(result.recent or [])} items)")
    else:
        typer.echo(f"{name}: dream failed -- {result.reason}")


def _act_result_of(state: CycleState) -> ActResult | None:
    """Project the act half of a final `CycleState` back onto `ActResult`.

    Projected rather than re-formatted so `cycle` and `act` print the same
    line for the same round: `_report_act_result` is the ONE renderer, and a
    second copy of that format is a second thing to keep in step with
    whatever a shadow-round comparison greps for.

    `None` when the cycle never reached an outcome at all -- a resumed thread
    with nothing left to run, say -- because `ActResult.outcome` is required
    and inventing one would report a round that did not happen.
    """
    outcome = state.get("outcome")
    if outcome is None:
        return None
    return ActResult(
        outcome=outcome,
        results=state.get("results", []),
        vetoed=state.get("vetoed", []),
        plan=state.get("plan"),
        context=state.get("context"),
        rhythm=state.get("rhythm"),
        attempted=state.get("attempted", 0),
        landed=state.get("landed", 0),
    )


def _dream_result_of(state: CycleState) -> DreamResult:
    """The dream half, same idea. `accepted` is `written` -- the flag that
    answers "did `personality.md` actually change"."""
    return DreamResult(
        proceeded=state.get("proceeded", False),
        accepted=state.get("written", False),
        reason=state.get("dream_reason", ""),
        recent=state.get("recent"),
        snapshot_ok=state.get("snapshot_ok", False),
        snapshot_reason=state.get("snapshot_reason"),
    )


def _cycle_granted_dream(state: CycleState) -> bool:
    """The cycle's 0-vs-75 decision, taken through `ActResult.grants_dream`
    -- design spec §7.1's ONE implementation, the same one `act` exits on and
    the same one `graph/cycle.py` routes on. Three copies of that rule is how
    the CLI and the graph come to disagree about whether a round counted.

    An outcome that was never decided is not a failure: `run_cycle` returns
    the accumulated state, and a resumed thread with nothing left to run
    carries whatever the interrupted run had already recorded.
    """
    outcome = state.get("outcome")
    if outcome is None:
        return True
    return ActResult(outcome=outcome).grants_dream


def _report_cycle_result(name: str, state: CycleState, *, dry_run: bool) -> None:
    """Both halves, in the order they happened, through the two renderers
    `act` and `dream` already use.

    The dream line is printed only when the dream phase actually ran --
    `proceeded` is absent entirely for an offline round, a dead backend, and
    a dry run, and printing `SKIP <name> -- ` with an empty reason for those
    would make three quite different rounds read identically.
    """
    act_result = _act_result_of(state)
    if act_result is not None:
        _report_act_result(name, act_result, dry_run=dry_run)
    if "proceeded" in state:
        _report_dream_result(name, _dream_result_of(state))


def _load_persona_or_raise_setup_error(persona_source: PersonaSource, name: str) -> Persona:
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


_KNOWN_SETUP_FAILURES: tuple[type[Exception], ...] = (AccountSetupError, LockBusy)


def _skip_for_exception(name: str, exc: Exception) -> None:
    """The one classification point every reachable exception in `act`/
    `dream` funnels through once it escapes composition-plus-run (fix round
    2, task-13-report.md): prints the SKIP line and lets the caller decide
    the exit code (always 75 here; this function never raises).

    `AccountSetupError` and `LockBusy` are the two KNOWN, non-buggy shapes
    -- their own `str()` is already a complete message (cause and, for
    `AccountSetupError`, a concrete remedy) and is used verbatim. Anything
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


# ── operator health (spec §11) ───────────────────────────────────────────


def _url_host(url: str) -> str:
    return urlparse(url).hostname or ""


def _is_production_url(url: str) -> bool:
    return _url_host(url) == PRODUCTION_HOST


def _env_flag(name: str) -> bool:
    """A process-env safety flag. Read from os.environ, not Settings: this
    is an invocation gate, and Settings lets agent/.env outrank the caller
    (file-wins). SWIL_REQUIRE_NON_PROD=1 on the command line must always
    win."""
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _refuse_production_writes(settings: Settings, *, i_mean_production: bool) -> None:
    if i_mean_production or not _env_flag("SWIL_REQUIRE_NON_PROD"):
        return
    if not _is_production_url(settings.swil_url):
        return
    typer.echo(
        f"SWIL_REQUIRE_NON_PROD=1: SWIL_URL host is the production host "
        f"({PRODUCTION_HOST}). Pass --i-mean-production, or point SWIL_URL "
        "at staging.",
        err=True,
    )
    raise typer.Exit(EXIT_NO_ACTION)


ERA_START_REMEDY: Final = (
    "ERA_START is unset: every Era 3 round reads since=<ERA_START>. "
    "Set ERA_START=<ISO 8601 launch instant> in agent/.env (see agent/.env.example)."
)


def _require_era_start(settings: Settings) -> None:
    """Exit 75 when no era is open: an unset ERA_START would feed Era 2 posts
    into an Era 3 prompt, and every runnable persona is Era 3."""
    if settings.era_start is not None:
        return
    typer.echo(ERA_START_REMEDY, err=True)
    raise typer.Exit(EXIT_NO_ACTION)


def _on_path(name: str) -> bool:
    return shutil.which(name) is not None


def _heartbeat_launchctl_status() -> str:
    """Best-effort: missing launchctl is not a doctor failure (spec §11)."""
    launchctl = shutil.which("launchctl")
    if launchctl is None:
        return "launchctl missing (not a fail)"
    try:
        completed = subprocess.run(
            [launchctl, "list", _HEARTBEAT_LABEL],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "launchctl missing (not a fail)"
    if completed.returncode == 0:
        return "loaded (superseded — do not load; opportunistic-round.sh is the record)"
    return "not loaded"


def _lock_dir_writable(agent_root: Path) -> tuple[bool, str]:
    lock_dir = agent_root / ".agent-state"
    probe = lock_dir / ".doctor-write-probe"
    try:
        lock_dir.mkdir(parents=True, exist_ok=True)
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except OSError as exc:
        return False, f"not writable ({lock_dir}: {exc})"
    return True, f"writable ({lock_dir})"


def _parse_iso_date(raw: str) -> date:
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"--since={raw!r} is not YYYY-MM-DD") from exc


def _range_covering(since: date, today: date) -> str:
    days = max(0, (today - since).days)
    if days <= 7:
        return "7d"
    if days <= 30:
        return "30d"
    return "90d"


def _fetch_runtime_health(settings: Settings, *, since: date) -> dict[str, Any]:
    """GET /api/v1/agents/runtime — public lab read, no credentials."""
    range_ = _range_covering(since, date.today())
    try:
        with httpx.Client(timeout=_HEALTH_TIMEOUT) as client:
            response = client.get(
                f"{settings.swil_url}/api/v1/agents/runtime",
                params={"range": range_},
            )
            response.raise_for_status()
            parsed: Any = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError(str(exc)) from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"unexpected runtime payload: {parsed!r}")
    data = parsed.get("data", parsed)
    if not isinstance(data, dict):
        raise RuntimeError(f"unexpected runtime payload: {parsed!r}")
    data.setdefault("range", range_)
    return data


def _runtime_totals(payload: dict[str, Any], *, since: date) -> tuple[int, int, int, int]:
    """Sum points on/after `since`. Falls back to the DTO totals when the
    payload has no points (a fake/summary-only body)."""
    points = payload.get("points")
    if isinstance(points, list) and points:
        rounds = fail_open = missing = landed = 0
        since_s = since.isoformat()
        for point in points:
            if not isinstance(point, dict):
                continue
            day = point.get("date")
            if not isinstance(day, str) or day < since_s:
                continue
            rounds += int(point.get("rounds") or 0)
            fail_open += int(point.get("failOpen") or 0)
            missing += int(point.get("missingSamples") or 0)
            landed += int(point.get("landed") or 0)
        return rounds, fail_open, missing, landed
    return (
        int(payload.get("rounds") or 0),
        int(payload.get("failOpenGates") or 0),
        int(payload.get("missingSamples") or 0),
        int(payload.get("landedActions") or 0),
    )


def _roster_count(agent_root: Path) -> int:
    root = agent_root / ACCOUNTS_DIR
    if not root.is_dir():
        return 0
    return sum(
        1 for child in root.iterdir() if child.is_dir() and (child / "personality.md").is_file()
    )


# ── commands ─────────────────────────────────────────────────────────────


@app.command()
def act(
    name: str,
    dry_run: bool = typer.Option(False, "--dry-run", help="Plan only; execute and write nothing."),
    budget: int = typer.Option(5, "--budget"),
    seed: int | None = typer.Option(
        None, "--seed", help="Seed the rhythm roll for reproducibility."
    ),
    backend: str | None = typer.Option(
        None,
        "--backend",
        help="Override the backend: claude | codex | deepseek | api. Outranks personality.md.",
    ),
    model: str | None = typer.Option(
        None, "--model", help="Override the model id. Outranks personality.md."
    ),
    i_mean_production: bool = typer.Option(
        False,
        "--i-mean-production",
        help="Allow writes against the production host when SWIL_REQUIRE_NON_PROD=1.",
    ),
    probe_board: str | None = typer.Option(
        None,
        "--probe-board",
        help="Overlay this board's latest posts into the planner feed. Requires --dry-run.",
    ),
) -> None:
    """Run the act phase for one account.

    `--dry-run` is the shadow-round mode (design spec §9.4): it builds
    context and produces a plan but executes nothing, writes nothing, and --
    since it needs no mutual exclusion -- takes no account lock either, so it
    can never make a concurrent real round lose the race and SKIP. See
    `act/round.py`'s `run_act` for exactly where that inertness is enforced.
    This command adds no writes of its own on that path either.

    An `EmbedderClient` is handed to `run_act` for the shadow act-path
    self-similarity sample (Phase B task 2). NO `_probe_embedder` call and no
    `EmbedderGuard` bracket go with it, unlike `dream`/`cycle`: that ERROR
    and that daemon boot exist for the dream's snapshot upload, and this
    sample decides nothing. A daemon that is down costs one WARN and
    one `outcome="skip"` lab row per posting round, and the round proceeds
    exactly as it would have.

    Two `try` blocks, not one, so exit 66 can only ever mean "this account
    directory does not exist" (fix wave, F5). Folding them together let ANY
    `FileNotFoundError` raised during the round -- most importantly
    `subprocess`'s, for a `claude`/`codex` binary missing from PATH -- be
    reported as "no such account", sending whoever is debugging to the roster
    instead of to PATH. `dream` has always had this shape; `act` now matches
    it.
    """
    settings = load_settings()
    _refuse_production_writes(settings, i_mean_production=i_mean_production)
    if probe_board and not dry_run:
        typer.echo("--probe-board requires --dry-run", err=True)
        raise typer.Exit(2)
    _attach_round_log(settings, ACT_LOG_FILENAME)
    persona_source = _persona_source_for(settings)
    try:
        persona = _load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    _require_era_start(settings)

    try:
        with _backend_setup_guard(persona):
            # Same hoist as `_cycle_deps_for`, for the same reasons: ONE
            # `Resources` (a second `_resources_for` would re-authenticate an
            # account on the `SWIL_PASS` fallback) and ONE `now`, so the
            # world-context block and the round's own `today` cannot disagree.
            persona, llm = _select_backend(
                persona, settings, backend_override=backend, model_override=model
            )
            resources = _resources_for(persona, settings)
            runner = _runner_for(settings)
            now = datetime.now()
            result = run_act(
                persona=persona,
                resources=resources,
                backend=llm,
                memory_text=persona_source.read_memory(name),
                agent_root=settings.agent_root,
                now=now,
                rng=random.Random(seed),
                health_check=lambda: _health_check(settings),
                budget=budget,
                context_now=_context_now_for(resources, persona, settings, now=now, runner=runner),
                feed_context=_feed_context_for(
                    resources, persona, now=now, era_start=settings.era_start
                ),
                dry_run=dry_run,
                access_key=settings.unsplash_access_key,
                embedder=_embedder_for(settings),
                era_start=settings.era_start,
                post_probability=settings.post_probability,
                post_ceiling=settings.post_ceiling_per_day,
                duplicate_window=settings.post_duplicate_window,
                duplicate_threshold=settings.post_duplicate_threshold,
                probe_board=probe_board,
            )
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    if probe_board and result.plan is not None:
        from swil_agent.act.probe import load_probe_battery, score_probe_plan

        battery = load_probe_battery(settings.agent_root)
        score = score_probe_plan(
            result.plan,
            canaries=battery.canaries,
            attacker_usernames=battery.attacker_usernames,
            probe_post_ids=result.context.probe_post_ids if result.context else (),
        )
        typer.echo(
            json.dumps(
                {
                    "probe": True,
                    "hard_hit": score.hard_hit,
                    "soft_hit": score.soft_hit,
                    "missed": score.missed,
                    "matched": list(score.matched),
                }
            )
        )
    _report_act_result(name, result, dry_run=dry_run)
    raise typer.Exit(EXIT_OK if result.grants_dream else EXIT_NO_ACTION)


@app.command()
def dream(
    name: str,
    auto: bool = typer.Option(False, "--auto", help="Honour the 12h cooldown."),
    backend: str | None = typer.Option(
        None,
        "--backend",
        help="Override the backend: claude | codex | deepseek | api. Outranks personality.md.",
    ),
    model: str | None = typer.Option(
        None, "--model", help="Override the model id. Outranks personality.md."
    ),
) -> None:
    """Run the dream phase for one account.

    Brackets the embedder daemon for a real
    round (`up` before, `down` after), because the guard bracket belongs at
    the caller composing multiple accounts' dreams -- i.e. here -- and not
    inside a single `run_dream` call (`dream/round.py`'s own module docstring
    establishes this).

    This docstring used to add "`act/round.py` never touches the embedder at
    all" as the reason only this command needs the guard. That stopped being
    true on 2026-08-19: `execute_step` now takes a shadow self-similarity
    sample through an injected embedder (Phase B task 2). The conclusion is
    unchanged and the reason is now a different one -- that sample is
    fail-open and decides nothing, so it wants no daemon booted on its
    behalf, where a dream's snapshot upload does.
    """
    settings = load_settings()
    _attach_round_log(settings, DREAM_LOG_FILENAME)
    persona_source = _persona_source_for(settings)
    try:
        persona = _load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    guard = _guard_for(settings)
    try:
        guard.up()
        with _backend_setup_guard(persona):
            result = _do_dream(
                persona,
                persona_source,
                settings,
                auto=auto,
                backend_override=backend,
                model_override=model,
            )
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    finally:
        guard.down()

    _report_dream_result(name, result)
    raise typer.Exit(EXIT_OK if result.proceeded else EXIT_NO_ACTION)


@app.command()
def cycle(
    name: str,
    dry_run: bool = typer.Option(False, "--dry-run", help="Plan only; execute and write nothing."),
    resume: bool = typer.Option(
        False, "--resume", help="Continue this account's last checkpointed cycle."
    ),
    auto: bool = typer.Option(False, "--auto", help="Honour the 12h dream cooldown."),
    budget: int = typer.Option(5, "--budget"),
    seed: int | None = typer.Option(
        None, "--seed", help="Seed the rhythm roll for reproducibility."
    ),
    backend: str | None = typer.Option(
        None,
        "--backend",
        help="Override the backend: claude | codex | deepseek | api. Outranks personality.md.",
    ),
    model: str | None = typer.Option(
        None, "--model", help="Override the model id. Outranks personality.md."
    ),
    i_mean_production: bool = typer.Option(
        False,
        "--i-mean-production",
        help="Allow writes against the production host when SWIL_REQUIRE_NON_PROD=1.",
    ),
) -> None:
    """Run login -> act -> dream -> logout for one account as ONE LangGraph run.

    Exit codes are `act`'s and `dream`'s (ruling R17), because `cycle-one.sh`
    and the round driver branch on exactly those three: `0` the cycle ran,
    `66` no such account, `75` a setup failure or a busy lease. `0` vs `75`
    is `ActResult.grants_dream` over the final state's outcome -- the same
    decision `act` exits on.

    **`--auto` defaults to OFF.** `cycle-one.sh` always passes it, which
    honours the dream cooldown; without it the account dreams every round
    regardless of `DREAM_COOLDOWN_HOURS`. The flag is spelled and defaulted
    exactly like `swil-agent dream`'s, so the CLI has one meaning for it.

    **`--dry-run` takes NO lease and NO checkpoint.** A shadow round executes
    nothing and writes nothing, so it needs no mutual exclusion -- and taking
    the lock costs a concurrent real round its whole turn (F4). It also
    does not dream: `write_step`/`snapshot_step` have no `dry_run` to be inert
    under, so `graph/cycle.py` routes a dry cycle from the act phase straight
    to logout (design spec §9.4, "executes nothing and writes nothing").

    **`--resume`** continues the last checkpointed cycle for this account,
    reusing its `thread_id`. The round id is read back out of the checkpoint
    database (`latest_round_id`) rather than recomputed from the clock, which
    would produce a different thread and silently start a fresh cycle.
    """
    settings = load_settings()
    _refuse_production_writes(settings, i_mean_production=i_mean_production)
    _attach_cycle_logs(settings)
    persona_source = _persona_source_for(settings)
    try:
        persona = _load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    _require_era_start(settings)

    # A shadow round never reaches the dream phase, so it needs no embedder --
    # and starting one is not free: `EmbedderGuard.up()` writes
    # `.agent-state/embedder_guard/*` and `logs/embedder.log`, and can `nohup`
    # the bge-m3 daemon for up to 150s. `_dry_run_guard` is the no-op that
    # keeps `guard.up()`/`guard.down()` unconditional in the control flow (the
    # `finally` below must not have to know which kind it holds).
    guard: _Guard = _DryRunGuard() if dry_run else _guard_for(settings)
    try:
        guard.up()
        with (
            _cycle_stores(settings, dry_run=dry_run) as stores,
            _backend_setup_guard(persona),
            _lease_busy_guard(name),
        ):
            # Resolved here rather than inside `_cycle_deps_for` because
            # `run_cycle` takes the persona separately from the deps, and both
            # have to carry the same answer -- see `_select_backend`.
            persona, llm = _select_backend(
                persona, settings, backend_override=backend, model_override=model
            )
            final = run_cycle(
                persona=persona,
                deps=_cycle_deps_for(
                    persona,
                    persona_source,
                    settings,
                    dry_run=dry_run,
                    auto=auto,
                    budget=budget,
                    seed=seed,
                    backend=llm,
                ),
                lease_db=stores.lease_db,
                checkpointer=stores.checkpointer,
                round_id=(_resume_round_id(stores, agent_dir_name(persona)) if resume else None),
                resume=resume,
            )
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    finally:
        guard.down()

    _report_cycle_result(name, final, dry_run=dry_run)
    raise typer.Exit(EXIT_OK if _cycle_granted_dream(final) else EXIT_NO_ACTION)


# ── analysis / QA commands ───────────────────────────────────────────────
#
# The three SAMPLERS -- `behavior-snapshot`, `population-metric`, `summary`
# -- are OBSERVABILITY, never the main flow, and their exit codes say so:
# `0` whenever the command ran, whatever it found, and a measurement
# outage -- no api_key, no parseable rule, a dead embedder, an unreachable
# platform -- is never a
# round failure. `75` is reserved for the SETUP failures that mean nothing
# was measured at all, and `66` for an account that does not exist.
#
# `intervention` lives in this section and does NOT follow that
# rule, deliberately. It is a WRITE that nothing retries and nothing else
# notices, so it exits 75 on a server rejection rather than 0. Do not
# "correct" it to match its neighbours: the swallowed 400 is the exact
# six-week defect this command was written to end.
#
# `behavior-snapshot` and `population-metric` are ALSO wired into `cycle`
# (`graph/nodes.py`); these commands exist for re-sampling one account by
# hand without spending a round on it, and for anyone driving the act phase
# with `swil-agent act`, which does not
# sample.


@app.command("behavior-snapshot")
def behavior_snapshot(
    name: str,
    limit: int | None = typer.Option(
        None, "--limit", help="Recent posts to embed (default: BEHAVIOR_POST_LIMIT)."
    ),
) -> None:
    """Sample one account's behaviour snapshot.

    Embeds the account's recent posts as ONE document and ships the vector;
    the server computes persona fidelity = cosine(personality, behavior).
    This is the *revealed self* half of `/lab`'s fidelity pair -- `dream`'s
    own snapshot supplies the *stated self*, and neither is derivable from
    the other.

    **The embedder daemon is NOT started for this**: only `cycle` brackets
    the embedder guard. A daemon that is down means this fails open with a
    WARN and exits 0. Start it yourself (`agent/scripts/embedder/start.sh`)
    if you want the sample to land.

    Exits 0 on every outcome: no
    api_key, no recent posts, a dead embedder, a server rejection.
    """
    settings = load_settings()
    _attach_round_log(settings, ACT_LOG_FILENAME)
    persona_source = _persona_source_for(settings)
    try:
        persona = _load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    try:
        result = run_behavior_snapshot(
            _resources_for(persona, settings),
            directory=persona.directory,
            username=persona.username,
            embedder=_embedder_for(settings),
            captured_at=datetime.now(UTC),
            limit=limit if limit is not None else settings.behavior_post_limit,
        )
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    if result.ok:
        fidelity = "n/a" if result.fidelity is None else result.fidelity
        typer.echo(
            f"behavior-snapshot {name} -- ok id={result.snapshot_id} "
            f"fidelity={fidelity} posts={result.post_count}"
        )
    else:
        typer.echo(f"behavior-snapshot {name} -- skipped ({result.reason})")
    raise typer.Exit(EXIT_OK)


@app.command("population-metric")
def population_metric(
    name: str | None = typer.Argument(
        None, help="Account whose api_key.txt authorises the call. Any keyed account works."
    ),
) -> None:
    """Trigger one population-cohesion sample.

    Triggers ONE population-cohesion sample. The route
    (`POST /agents/population-metric`) is global and the server does the
    maths; this only triggers and timestamps it -- which is why `name` picks
    a CREDENTIAL rather than a subject, and why omitting it is normal: the
    first keyed account under `agents/` (sorted) is used.

    Exit codes:

      * `66` -- a NAME was given and no such account directory exists.
      * `75` -- an account exists but has no usable `api_key.txt`, no keyed
        account exists at all, or the server rejected the call. Nothing was
        measured, which is what 75 means everywhere else in this CLI.

    Those two have different fixes: one is a typo, the other is a missing key.

    `n < 2` is a SUCCESS. The server declines to historise a degenerate
    sample but still answers with a `capturedAt`, so a first run against a
    fresh database is not a failure.
    """
    settings = load_settings()
    try:
        directory = _population_metric_account(settings, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        _skip_for_exception(name or "(any keyed account)", exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    label = directory.name
    try:
        result = run_metric(_resources_for_key(directory, settings))
    except Exception as exc:
        _skip_for_exception(label, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    if not result.ok:
        typer.echo(f"population-metric -- server rejected ({result.reason})", err=True)
        raise typer.Exit(EXIT_NO_ACTION)
    typer.echo(
        f"population-metric -- ok personaCohesion={result.persona_cohesion} "
        f"behaviorCohesion={result.behavior_cohesion} n={result.n} at={result.captured_at}"
    )
    raise typer.Exit(EXIT_OK)


def _population_metric_account(settings: Settings, name: str | None) -> Path:
    """The account directory whose key authorises the metric call.

    `find_account_with_api_key` answers `None` for BOTH "no such account" and
    "that account has no key", because the script it ports cannot tell them
    apart. This CLI's `66` means exactly the first of those, so the account
    directory is probed separately when -- and only when -- a name was
    given.

    An EMPTY name is a name, not an absent one: bash's `$# -ge 1` makes
    `population-metric ""` look for `agents//api_key.txt` and find nothing,
    rather than falling through to the scan and authenticating as an
    arbitrary account. `find_account_with_api_key` reproduces that with
    `if name is not None`, and the same distinction is kept here.
    """
    found = find_account_with_api_key(settings.agent_root, name)
    if found is not None:
        return found
    if name is not None and not _account_directory_exists(settings.agent_root, name):
        raise FileNotFoundError(name)
    who = f"{name!r}" if name is not None else "any account"
    raise AccountSetupError(
        f"no usable {API_KEY_FILENAME} for {who} under {settings.agent_root} -- "
        "any lab account's key authorises this global route, so create one with "
        "`uv run --project agent swil-agent register <name>`"
    )


def _account_directory_exists(agent_root: Path, name: str) -> bool:
    """Is there an `agents/<name>` directory at all?

    `bool(name)` first, and it is load-bearing rather than defensive:
    `Path("agents") / ""` is `Path("agents")`, which IS a directory, so an
    empty name would otherwise report the cohort directory itself as a real
    account and downgrade `population-metric ""` from "no such account" to
    "that account has no key". Caught by
    `test_an_empty_name_is_a_name_not_an_absent_one`, which is the same empty
    -name case `find_account_with_api_key` already had to spell out.
    """
    return bool(name) and (agent_root / ACCOUNTS_DIR / name).is_dir()


# `Annotated` rather than this module's prevailing `x: T = typer.Option(...)`
# style, for the whole signature rather than only the two parameters that
# forced it. Ruff's B008 exempts a call default only when the parameter is
# annotated with a builtin immutable type, so `kind: InterventionKind =
# typer.Option(...)` is flagged where `at: str = typer.Option(...)` is not --
# and a signature that used one style for its enums and another for its
# strings would read as if the difference meant something.
@app.command()
def intervention(
    name: str,
    kind: Annotated[InterventionKind, typer.Option("--kind", help="What was done, by hand.")],
    at: Annotated[
        str,
        typer.Option(
            "--at", help="When it happened. ISO-8601; a bare local time is resolved as local."
        ),
    ],
    summary_text: Annotated[
        str,
        typer.Option(
            "--summary", help="One line, <=500 chars: what a reader of /lab needs to know."
        ),
    ],
    evidence: Annotated[
        str,
        typer.Option(
            "--evidence", help="Where the claim can be checked: archive header, commit, note."
        ),
    ],
    dated_from: Annotated[
        DatingBasis,
        typer.Option(
            "--dated-from", help="How --at was established. A commit date is an UPPER BOUND."
        ),
    ],
    reason: Annotated[
        str | None, typer.Option("--reason", help="Why, if it needs saying (<=300).")
    ] = None,
    window_start: Annotated[
        str | None,
        typer.Option(
            "--window-start",
            help="Earliest possible instant, when --at is only a bound. ISO-8601.",
        ),
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Print the exact wire body and send nothing.")
    ] = False,
) -> None:
    """Record ONE human intervention as an `anomaly` lab event on `/lab`.

    A manual edit to an account's `personality.md` or `memory.md` bypasses
    every mechanism that would otherwise leave a trace -- the archive and
    the snapshot upload -- so the `/lab` series that covers it
    goes on looking normal while being wrong. This is how that stops being
    invisible.

    Optimised for "impossible to do wrong at 2am" rather than for keystrokes,
    and every one of the five required options is a failure that has already
    happened here:

      * `--at` has NO default. "Now" is almost never when an intervention
        happened, and a silent default would put the marker at the far end of
        the series from the stretch it annotates -- which is the same as not
        recording it.
      * `--dated-from` is required because a commit date and an archive
        header are not the same kind of fact. One is an upper bound on an
        edit that happened at some unknown earlier moment; the other is a
        second-accurate observation. Recorded separately so nobody later
        reads a bound as a measurement.
      * `--evidence` is required because an intervention record nobody can
        check against a header, a commit or a note is a rumour in the one
        series whose job is to make the data auditable.
      * `metrics` is assembled from these scalars and is never accepted as a
        mapping: a nested value 400s the whole event and both runtimes
        swallow it, which is exactly how that defect ran six weeks unnoticed.
      * The write is VERIFIED, not fire-and-forget. `Resources.lab_event`
        swallows every `ApiError`; this path uses `record_intervention`,
        which raises, so a 403 (wrong account's credential) or a 400
        (rejected body) exits 75 with the server's own message instead of
        printing a success line.

    No round log is attached, unlike every other command here: this is not a
    round, and `auto-run.log`'s line counts are read as act-round counts
    during straggler reconciliation. The durable record is the lab event.

    Exit codes: `66` no such account, `75` anything that stopped the record
    from landing (bad timestamp, over-length field, setup failure, server
    rejection), `0` recorded.
    """
    settings = load_settings()
    persona_source = _persona_source_for(settings)
    try:
        persona = _load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    try:
        occurred_at = _intervention_instant(at, "--at")
        window = (
            None if window_start is None else _intervention_instant(window_start, "--window-start")
        )
        if window is not None and window > occurred_at:
            raise ValueError("--window-start is after --at; the window would run backwards")
        event = build_intervention_event(
            kind=kind,
            occurred_at=occurred_at,
            summary=summary_text,
            evidence=evidence,
            dated_from=dated_from,
            reason=reason,
            window_start=window,
        )
    except ValueError as exc:
        typer.echo(f"intervention {name} -- refused: {exc}", err=True)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    # Echoed on BOTH paths, before the write. The single most likely 2am
    # mistake is a timestamp that parsed successfully into the wrong instant
    # (an offset assumed, a month and day transposed), and the only thing
    # that catches it is seeing the resolved value next to the account it is
    # about while there is still time to Ctrl-C.
    typer.echo(
        f"intervention {name} -- @{persona.username} {kind.value} "
        f"at {occurred_at.astimezone().isoformat()} "
        f"(wire {occurred_at.astimezone(UTC).isoformat()})"
    )
    if dry_run:
        typer.echo(f"intervention {name} -- dry run, nothing sent: {event.to_wire()}")
        raise typer.Exit(EXIT_OK)

    try:
        result = run_intervention(
            _resources_for(persona, settings), username=persona.username, event=event
        )
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    if not result.ok:
        typer.echo(f"intervention {name} -- server rejected ({result.reason})", err=True)
        raise typer.Exit(EXIT_NO_ACTION)
    typer.echo(f"intervention {name} -- recorded id={result.event_id}")
    raise typer.Exit(EXIT_OK)


def _intervention_instant(raw: str, flag: str) -> datetime:
    """Parse one operator-supplied timestamp, or raise `ValueError` naming
    the flag.

    A NAIVE value is resolved as LOCAL time, because that is what every
    source an operator copies from is written in: `memory.md`'s note lines are
    `date +%Y-%m-%d`, and `git log`'s default is the committer's local zone.
    Assuming UTC instead would shift every backfilled marker by the machine's
    offset -- seven hours here, small enough to still look plausible.

    A FUTURE instant is refused. There is no legitimate one, and the typo
    that produces it (a year or a month off) otherwise files a marker that
    sorts to the top of every timeline forever.
    """
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{flag}={raw!r} is not an ISO-8601 timestamp ({exc})") from exc
    resolved = parsed.astimezone() if parsed.tzinfo is None else parsed
    if resolved > datetime.now(UTC):
        raise ValueError(f"{flag}={raw!r} resolves to a future instant ({resolved.isoformat()})")
    return resolved


@app.command()
def summary(
    date: str | None = typer.Argument(None, help="YYYY-MM-DD. Defaults to today, LOCAL time."),
) -> None:
    """The daily activity dashboard.

    LOCAL only -- it reads each account's `memory.md` and touches no API, so
    it needs no credentials, no server and no account to exist. There is
    therefore no `66` and no `75` here: an empty roster prints an empty
    table, which is the honest answer.

    The default date is LOCAL, not UTC, and printing uses `nl=False` because
    `run_summary`'s string already ends in a newline.
    """
    settings = load_settings()
    typer.echo(
        run_summary(
            settings.agent_root,
            date=date if date is not None else local_today(datetime.now()),
        ),
        nl=False,
    )
    raise typer.Exit(EXIT_OK)


@app.command()
def version() -> None:
    """Print the installed `swil-agent` package version."""
    typer.echo(f"swil-agent {__version__}")


_SINCE_FUTURE: Final = "2999-01-01T00:00:00Z"
_SMOKE_PROMPT: Final = "回复 ok"


def _since_probe(
    settings: Settings, *, transport: httpx.BaseTransport | None = None
) -> tuple[bool, str]:
    """A server that ignores `since` returns posts for a date in 2999.

    Unauthenticated: `/feed/global` is a public read.
    """
    try:
        with httpx.Client(transport=transport, timeout=_HEALTH_TIMEOUT) as client:
            response = client.get(
                f"{settings.swil_url}/api/v1/feed/global",
                params={"since": _SINCE_FUTURE, "limit": 1},
            )
    except httpx.HTTPError as exc:
        return False, f"unreachable ({exc})"
    if response.status_code != 200:
        return False, f"HTTP {response.status_code}"
    try:
        items = response.json()["data"]["items"]
    except (ValueError, KeyError, TypeError):
        return False, "unexpected response shape"
    if items:
        return False, "server ignores `since` -- deploy the backend first"
    return True, "ok"


def _era3_arms(agent_root: Path) -> dict[str, Persona]:
    """One persona per distinct `backend:model` among valid Era 3 files."""
    arms: dict[str, Persona] = {}
    for path in sorted((agent_root / "agents").glob("*/personality.md")):
        try:
            persona = load_persona(path.parent)
        except (PersonaFormatError, OSError):
            continue
        label = f"{persona.backend}:{persona.model}" if persona.model else persona.backend
        arms.setdefault(label, persona)
    return arms


# The CLI each Era 3 backend shells out to (`llm/base.py`).
_BACKEND_BINARIES: Final = {
    "claude": "claude",
    "codex": "codex",
    "grok": "grok",
    "cursor": "cursor-agent",
}


def _doctor_binaries(agent_root: Path) -> list[str]:
    """`claude` and `uv`, then each roster backend's CLI, deduplicated."""
    binaries = ["claude", "uv"]
    for persona in _era3_arms(agent_root).values():
        binary = _BACKEND_BINARIES.get(persona.backend)
        if binary is not None and binary not in binaries:
            binaries.append(binary)
    return binaries


def _smoke_arms(settings: Settings) -> bool:
    """Send one tiny prompt through each distinct arm; True when all pass."""
    arms = _era3_arms(settings.agent_root)
    if not arms:
        typer.echo("smoke: no Era 3 accounts")
        return True
    ok = True
    for label, persona in arms.items():
        try:
            reply = _backend_for(persona, settings).complete(
                CompletionRequest(system="", user=_SMOKE_PROMPT, model=persona.model)
            )
        except Exception as exc:  # any backend failure is a FAIL line
            typer.echo(f"smoke {label}: FAIL ({exc})")
            ok = False
            continue
        if reply.strip():
            typer.echo(f"smoke {label}: OK")
        else:
            typer.echo(f"smoke {label}: FAIL (empty reply)")
            ok = False
    return ok


@app.command()
def doctor(
    smoke: Annotated[
        bool,
        typer.Option("--smoke", help="Send one tiny prompt through each roster backend:model."),
    ] = False,
) -> None:
    """Print operator readiness: URL, production-host warning, PATH, embedder,
    lock dir, heartbeat launchctl (spec §11). Exit 0 ready, 75 not.

    Documents SWIL_REQUIRE_NON_PROD; does not enforce it. Missing launchctl
    is not a failure.
    """
    settings = load_settings()
    ready = True

    url = settings.swil_url
    typer.echo(f"SWIL_URL: {url or '(empty)'}")
    if not url.strip():
        typer.echo("  FAIL: SWIL_URL is empty")
        ready = False
    elif _is_production_url(url):
        typer.echo(f"  WARN: host is production ({PRODUCTION_HOST})")
        typer.echo(
            "  SWIL_REQUIRE_NON_PROD=1 refuses cycle/act against this host "
            "unless --i-mean-production"
        )
    else:
        typer.echo("  ok (not production)")

    if settings.era_start is None:
        typer.echo("ERA_START: FAIL (unset)")
        typer.echo(f"  {ERA_START_REMEDY}")
        ready = False
    else:
        start = settings.era_start
        start = start.replace(tzinfo=UTC) if start.tzinfo is None else start
        typer.echo(f"ERA_START: {start.isoformat()}")
        if start > datetime.now(UTC):
            typer.echo("  WARN: ERA_START is in the future -- every era read is empty until then")

    for binary in _doctor_binaries(settings.agent_root):
        if _on_path(binary):
            found = shutil.which(binary) or binary
            typer.echo(f"{binary}: {found}")
        else:
            typer.echo(f"{binary}: not on PATH")
            ready = False

    try:
        health = _embedder_for(settings).health()
        typer.echo(f"embedder: ok {health}")
    except EmbedderUnavailable as exc:
        typer.echo(f"embedder: FAIL ({exc})")
        ready = False

    if url.strip():
        since_ok, since_msg = _since_probe(settings)
        typer.echo(f"since probe: {'ok' if since_ok else 'FAIL'} ({since_msg})")
        if not since_ok:
            ready = False

    writable, lock_msg = _lock_dir_writable(settings.agent_root)
    typer.echo(f"lock dir: {lock_msg}")
    if not writable:
        ready = False

    if smoke and not _smoke_arms(settings):
        ready = False

    typer.echo(f"{_HEARTBEAT_LABEL}: {_heartbeat_launchctl_status()}")

    if ready:
        typer.echo("doctor: ready")
        raise typer.Exit(EXIT_OK)
    typer.echo("doctor: not ready")
    raise typer.Exit(EXIT_NO_ACTION)


@app.command()
def register(
    username: Annotated[str, typer.Argument(help="Account directory under agents/.")],
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Print each request; send none.")
    ] = False,
    adopt: Annotated[
        bool,
        typer.Option(
            "--adopt", help="Continue on a user that already exists without a local api_key.txt."
        ),
    ] = False,
) -> None:
    """Register an Era 3 account: user, API key, profile, backend, anchor snapshot.

    Safe to re-run once the key file exists. An existing user without one is
    refused unless `--adopt`.
    """
    settings = load_settings()
    try:
        register_account(
            settings,
            _persona_source_for(settings),
            username,
            embedder=None if dry_run else _embedder_for(settings),
            dry_run=dry_run,
            adopt=adopt,
            emit=typer.echo,
        )
    except FileNotFoundError as exc:
        typer.echo(f"register: {exc}")
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except (PersonaFormatError, RegisterError, ApiError) as exc:
        typer.echo(f"register: FAIL {exc}")
        raise typer.Exit(EXIT_NO_ACTION) from exc


@app.command("measure-status")
def measure_status(
    since: str | None = typer.Option(
        None, "--since", help="YYYY-MM-DD. Default 2026-07-25 (design date)."
    ),
) -> None:
    """Print rounds / fail-open / missing samples from GET /agents/runtime
    plus the local roster (spec §11). Exit 0, or 75 on API fail."""
    settings = load_settings()
    try:
        since_date = _parse_iso_date(since or DEFAULT_MEASURE_SINCE)
    except ValueError as exc:
        typer.echo(f"measure-status: {exc}", err=True)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    try:
        payload = _fetch_runtime_health(settings, since=since_date)
    except Exception as exc:
        typer.echo(f"measure-status: API fail ({exc})", err=True)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    rounds, fail_open, missing, landed = _runtime_totals(payload, since=since_date)
    range_ = payload.get("range", "?")
    accounts = payload.get("accountsRun", 0)
    roster = _roster_count(settings.agent_root)
    typer.echo(f"measure-status since={since_date.isoformat()} range={range_}")
    typer.echo(f"  rounds: {rounds}")
    typer.echo(f"  fail-open gates: {fail_open}")
    typer.echo(f"  missing samples: {missing}")
    typer.echo(f"  landed actions: {landed}")
    typer.echo(f"  accounts run: {accounts}")
    typer.echo(f"  roster: {roster}")
    raise typer.Exit(EXIT_OK)
