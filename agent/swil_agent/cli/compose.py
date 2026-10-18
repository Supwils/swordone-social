"""The composition root: every collaborator a command builds, as one seam each.

This module is the ONLY place in the package allowed to import every layer
(`api/`, `llm/`, `embedder/`, `persona/`, `act/`, `dream/`) at once and wire
concrete collaborators together from a `Settings` instance and an account
name. Every module below it stays unit-testable in isolation because none of
them constructs its own collaborators -- see `act/round.py`'s and
`dream/round.py`'s own module docstrings for the same argument from their
side of the seam.

**Commands resolve every seam through this module object**
(`compose.resources_for(...)`, `compose.now()`), and the builders here call
each other through their module-global names, so a test replaces exactly one
layer in one place -- `monkeypatch.setattr(compose, "resources_for", fake)`
-- and every command and every builder that reaches it sees the fake. The
backend leaves live in `cli/compose_backend.py` (size cap) and are re-bound
here under the same names (`import x as x`, the explicit re-export form);
`cycle_stores` and `lease_busy_guard` live in `cli/stores.py` and are
re-bound the same way.

The clock is a seam too: every `datetime.now()` the CLI used to take is a
`now(tz)` call here or in a command, at the same site and in the same order,
and `measure-status`'s `date.today()` is `today()`.

`tests/unit/test_cli.py` monkeypatches every network- and subprocess-facing
seam for its `CliRunner` tests, and calls several of them directly (over
`httpx.MockTransport`) so they are not *only* ever exercised through a
monkeypatched stand-in for themselves.
"""

from __future__ import annotations

import logging
import random
from dataclasses import replace
from datetime import UTC, date, datetime, tzinfo
from pathlib import Path
from typing import NamedTuple, Protocol

import httpx

from swil_agent.act.context import WorldContext, read_world_context
from swil_agent.analysis.population_metric import API_KEY_FILENAME
from swil_agent.api.auth import ApiKeyAuth, PasswordAuth, resolve_auth
from swil_agent.api.client import ApiClient
from swil_agent.api.resources import Resources
from swil_agent.cli.compose_backend import api_backend_for as api_backend_for
from swil_agent.cli.compose_backend import backend_for as backend_for
from swil_agent.cli.compose_backend import backend_setup_guard as backend_setup_guard
from swil_agent.cli.errors import AccountSetupError
from swil_agent.cli.stores import cycle_stores as cycle_stores
from swil_agent.cli.stores import lease_busy_guard as lease_busy_guard
from swil_agent.config import Settings
from swil_agent.config import load_settings as load_settings
from swil_agent.dream.candidate import DreamState, FilesystemDreamState
from swil_agent.embedder.client import EmbedderClient, EmbedderUnavailable
from swil_agent.embedder.guard import EmbedderGuard
from swil_agent.graph.deps import CycleDeps, FinishDeps, agent_dir_name
from swil_agent.llm.errors import BackendConfigurationError
from swil_agent.llm.protocol import Backend
from swil_agent.llm.remedy import backend_setup_remedy
from swil_agent.llm.runner import Runner, StatusRunner, SubprocessRunner
from swil_agent.llm.selection import apply_choice, resolve_backend_choice
from swil_agent.models import Persona
from swil_agent.persona.source import GitPersonaSource, PersonaSource

# The CLI's logger names predate the package split and the round logs route
# by them (S3 §12.16): `swil_agent.cli` for every CLI record, and
# `swil_agent.cli.dream` -- the CLI's DREAM-PHASE channel. Only the
# round-level embedder-down ERROR uses that one, and it exists so that record
# lands in `dream.log` from `cycle` as well as from `dream` -- under `dream`
# the whole invocation goes to that file anyway, and a probe that changed
# file depending on which command ran it is the kind of inconsistency nobody
# notices until they grep for it. See `cli/logs.py`'s `_DREAM_LOG_SOURCES`.
logger = logging.getLogger("swil_agent.cli")
dream_logger = logging.getLogger("swil_agent.cli.dream")

_HEALTH_TIMEOUT = 10.0

_EMBEDDER_DOWN_AFTER_GUARD_UP = (
    "embedder unreachable after guard up (embedder_url=%s) -- every dream "
    "snapshot this invocation uploads will fail with its own per-dream WARN, "
    "and the duplicate guard fails open."
)


# ── the clock ─────────────────────────────────────────────────────────────


def now(tz: tzinfo | None = None) -> datetime:
    """`datetime.now(tz)`: the one clock read every command goes through."""
    return datetime.now(tz)


def today() -> date:
    """`date.today()`: the local date, for `measure-status`'s range."""
    return date.today()


# ── collaborators ─────────────────────────────────────────────────────────


def persona_source_for(settings: Settings) -> PersonaSource:
    return GitPersonaSource(settings.agent_root)


def resources_for(
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


def resources_for_key(
    directory: Path, settings: Settings, *, transport: httpx.BaseTransport | None = None
) -> Resources:
    """A `Resources` authorised by ONE account's `api_key.txt` and nothing
    else -- the shape `population-metric` needs.

    `POST /agents/population-metric` is a global route: picking an account
    here is picking a CREDENTIAL, never a subject. So this
    deliberately does NOT go through `resources_for`, which would need a
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


def select_backend(
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
        raise AccountSetupError(backend_setup_remedy(persona, exc)) from exc

    for warning in warnings:
        logger.warning("WARN %s", warning)
    logger.info("%s — %s", persona.username, choice.describe())

    resolved = apply_choice(persona, choice)
    # The api kind goes straight to the factory; every CLI kind goes through
    # `backend_for`, which is the name ~18 tests replace to keep a unit test
    # from shelling out to the real `claude` binary. Routing the CLI kinds past
    # it would silently un-fake all of them -- which is exactly what happened
    # the first time this function was written, and it showed up as the suite
    # hanging on a live `claude -p` rather than as a failure.
    if choice.kind == "api":
        return resolved, api_backend_for(resolved, choice, settings)
    return resolved, backend_for(resolved, settings)


def runner_for(settings: Settings) -> StatusRunner:
    _ = settings  # no per-runner settings today; kept for interface stability
    return SubprocessRunner()


def embedder_for(
    settings: Settings, *, transport: httpx.BaseTransport | None = None
) -> EmbedderClient:
    return EmbedderClient(settings.embedder_url, transport=transport)


def guard_for(settings: Settings) -> EmbedderGuard:
    return EmbedderGuard(settings.agent_root, runner=SubprocessRunner())


class Guard(Protocol):
    """The two calls a command makes on the embedder daemon's lifecycle.

    Named as a Protocol so `cycle` can hold either the real `EmbedderGuard` or
    the dry-run no-op below in ONE variable, and keep `guard.up()` /
    `finally: guard.down()` unconditional. A `if not dry_run: guard.up()` pair
    with a matching `finally` is the shape that eventually leaks a started
    daemon on some third branch.
    """

    def up(self) -> None: ...

    def down(self) -> None: ...


class DryRunGuard:
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


def state_for(settings: Settings) -> DreamState:
    return FilesystemDreamState(settings.agent_root / ".agent-state")


def health_check(settings: Settings, *, transport: httpx.BaseTransport | None = None) -> bool:
    """A raw, UNPREFIXED GET to `${SWIL_URL}/health` -- `ApiClient` always
    prefixes `/api/v1` (api/client.py), so this stays outside it entirely
    rather than mixing a bare-URL HTTP concern into that module: nothing
    else in this package performs this one raw request. The login node
    calls it once per act round, through `CycleDeps.health_check`.
    """
    try:
        with httpx.Client(transport=transport, timeout=_HEALTH_TIMEOUT) as client:
            response = client.get(f"{settings.swil_url}/health")
    except httpx.HTTPError:
        return False
    return response.status_code == 200


def world_context_for(
    resources: Resources,
    persona: Persona,
    settings: Settings,
    *,
    now: datetime,
    runner: Runner,
) -> WorldContext:
    """The now-context and the follow-topics feed, RENDERED for this account
    (rulings R25/R26), plus the rows both came from (`read_world_context`: the
    activity read, the `news-fetch.sh` refresh, the topic searches). No
    `context/now.md` is written, so the per-account `当前 Agent` line is not
    something five parallel rounds race on. `now` is the builder's frozen clock,
    so this block, the context's `today` and the memory line agree."""
    return read_world_context(
        resources,
        persona,
        now=now,
        era_start=settings.era_start,
        agent_root=settings.agent_root,
        runner=runner,
    )


def probe_embedder(embedder: EmbedderClient, settings: Settings) -> None:
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


# ── per-phase deps (S3 §12.6) ─────────────────────────────────────────────


class PhaseDeps(NamedTuple):
    """What every per-phase builder returns, in ONE order.

    `persona` is the copy the backend was resolved for (`select_backend`), so
    the graph's persona and `deps.backend` cannot disagree; `finish` is the
    `run_graph(finish_deps=...)` hook, `None` when the phase has nothing to
    build after its lease is held.
    """

    persona: Persona
    deps: CycleDeps
    finish: FinishDeps | None = None


def dream_deps_for(
    persona: Persona,
    persona_source: PersonaSource,
    settings: Settings,
    *,
    auto: bool,
    backend_override: str | None = None,
    model_override: str | None = None,
) -> PhaseDeps:
    """`Phases.DREAM`'s deps (S3 §12.6), and the persona the backend was
    resolved for.

    The `dream` command's composition, unchanged: the embedder probe runs
    BEFORE backend selection (so `dream.log` reads ERROR, then the model
    line), and there is no world context, no follow-topics feed and no news
    fetch -- a dream reads none of them. `memory_text` stays empty because
    `cooldown_step` reads `memory.md` itself, under the dream lease.
    `health_check` is never called: the DREAM graph has no login.
    """
    embedder = embedder_for(settings)
    probe_embedder(embedder, settings)

    persona, backend = select_backend(
        persona,
        settings,
        backend_override=backend_override,
        model_override=model_override,
    )
    deps = CycleDeps(
        resources=resources_for(persona, settings),
        backend=backend,
        persona_source=persona_source,
        embedder=embedder,
        dream_state=state_for(settings),
        settings=settings,
        agent_root=settings.agent_root,
        health_check=lambda: health_check(settings),
        memory_text="",
        llm_backend=persona.backend,
        llm_model=persona.model,
        auto=auto,
        now=now(),
        captured_at=now(UTC),
    )
    return PhaseDeps(persona, deps)


def act_deps_for(
    persona: Persona,
    persona_source: PersonaSource,
    settings: Settings,
    *,
    dry_run: bool,
    budget: int,
    seed: int | None,
    probe_board: str | None,
    backend_override: str | None = None,
    model_override: str | None = None,
) -> PhaseDeps:
    """`Phases.ACT`'s deps (S3 §12.6), in two halves, and the persona the
    backend was resolved for.

    The backend is selected first, exactly where the `act` command selected
    it before this builder ran. The first half is then everything the `act`
    command built before its round: ONE `Resources` (a second `resources_for`
    would re-authenticate an account on the `SWIL_PASS` fallback), one
    `Runner` and ONE `now`, so the world-context block and the round's own
    `today` cannot disagree. An `EmbedderClient` goes with it for the
    enforcing duplicate guard's sample (fail-open) -- with NO
    `probe_embedder` call and no `EmbedderGuard` bracket: the round always
    runs `cycle`, which brackets one.

    The second half, `finish` (`_world_context_finish`), reads `memory.md`
    and renders the world context and the follow-topics feed AFTER the act
    lease is held (`run_graph`'s `finish_deps`): an account another run
    holds costs no reads and no `news-fetch.sh` (S3 §12.2(f)).
    """
    persona, backend = select_backend(
        persona, settings, backend_override=backend_override, model_override=model_override
    )
    resources = resources_for(persona, settings)
    runner = runner_for(settings)
    round_now = now()
    deps = CycleDeps(
        resources=resources,
        backend=backend,
        persona_source=persona_source,
        embedder=embedder_for(settings),
        dream_state=state_for(settings),
        settings=settings,
        agent_root=settings.agent_root,
        health_check=lambda: health_check(settings),
        memory_text="",
        llm_backend=persona.backend,
        llm_model=persona.model,
        budget=budget,
        access_key=settings.unsplash_access_key,
        dry_run=dry_run,
        rng=random.Random(seed),
        now=round_now,
        probe_board=probe_board,
    )
    return PhaseDeps(
        persona,
        deps,
        _world_context_finish(persona, persona_source, settings, resources, runner, round_now),
    )


def _world_context_finish(
    persona: Persona,
    persona_source: PersonaSource,
    settings: Settings,
    resources: Resources,
    runner: Runner,
    round_now: datetime,
) -> FinishDeps:
    """The reads `act` and `cycle` defer until their lease is held --
    `memory.md`, the world context (runs `news-fetch.sh`), the follow-topics
    feed -- in ONE order for both, over the deps' own `Resources`, `Runner`
    and frozen `now`: the prompt bytes depend on all three."""

    def finish(base: CycleDeps) -> CycleDeps:
        memory_text = persona_source.read_memory(agent_dir_name(persona))
        world = world_context_for(resources, persona, settings, now=round_now, runner=runner)
        return replace(
            base,
            memory_text=memory_text,
            context_now=world.context_now,
            feed_context=world.feed_context,
            world=world.sources,
        )

    return finish


def cycle_deps_for(
    persona: Persona,
    persona_source: PersonaSource,
    settings: Settings,
    *,
    dry_run: bool,
    auto: bool,
    budget: int,
    seed: int | None,
    backend: Backend,
) -> PhaseDeps:
    """Everything the ten nodes need, built once per cycle.

    Deliberately the SAME collaborators, read from the same places, that
    `act_deps_for` and `dream_deps_for` build, so the three commands cannot
    drift into three compositions.

    One real difference, recorded on `CycleDeps` itself: `now` and
    `captured_at` are frozen ONCE here, where `act` and `dream` are two
    processes taking a fresh `now()` each. Within one cycle that is
    minutes in a memory-line date.

    The backend is the one exception to "built once per cycle, here": it is
    resolved and built by the command body and passed in, because `run_cycle`
    takes the persona separately from the deps and the resolution has to reach
    both halves (see `select_backend`) BEFORE the round id is decided and
    logged. Building it here would give the graph a persona whose
    `backend`/`model` disagree with the backend beside it -- and
    `agentBackend` is projected from the persona. `persona` here is that
    resolved copy, returned unchanged.

    `probe_embedder` runs here for the same reason `dream_deps_for` runs it:
    once per invocation, right after `guard.up()`, before any account work --
    `EmbedderGuard.up()` cannot fail loudly (R10). **Except under `dry_run`**:
    a shadow round never dreams or uploads a snapshot, so probing would only
    emit one ERROR per account into `dream.log` for work that does not run.

    The memory / world-context / feed reads are `_world_context_finish`, run
    by `run_cycle` after BOTH leases are held (as `act_deps_for`'s are).
    """
    embedder = embedder_for(settings)
    if not dry_run:
        probe_embedder(embedder, settings)
    # Hoisted out of the `CycleDeps(...)` call because the world-context
    # renderers in `finish` need the SAME three: one `Resources` (a second one
    # would re-run `PasswordAuth.login` for an account without an
    # api_key.txt), one `Runner`, and the one `now` this cycle is frozen at.
    resources = resources_for(persona, settings)
    runner = runner_for(settings)
    round_now = now()
    deps = CycleDeps(
        resources=resources,
        backend=backend,
        persona_source=persona_source,
        embedder=embedder,
        dream_state=state_for(settings),
        settings=settings,
        agent_root=settings.agent_root,
        health_check=lambda: health_check(settings),
        memory_text="",
        # `persona` is `select_backend`'s resolved copy, the one `backend`
        # was built from -- so these are what ran, not what the file says.
        llm_backend=persona.backend,
        llm_model=persona.model,
        budget=budget,
        access_key=settings.unsplash_access_key,
        dry_run=dry_run,
        auto=auto,
        rng=random.Random(seed),
        now=round_now,
        captured_at=now(UTC),
    )
    return PhaseDeps(
        persona,
        deps,
        _world_context_finish(persona, persona_source, settings, resources, runner, round_now),
    )
