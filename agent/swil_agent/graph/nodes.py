"""The cycle's nodes: `CycleState` in, a PARTIAL `CycleState` out.

Each node adapts the graph's single threaded value to the step functions
`act/round.py` and `dream/round.py` already expose, and does nothing else.
That rule is the whole point of the split (ruling R4): `run_act` / `run_dream`
and the graph run ONE implementation of every decision, so the CLI path and
the durable path cannot drift into two behaviours. A line of logic that lives
here and nowhere else is a line the CLI does not execute -- and the reverse,
a guard left in `run_act`'s body, is a guard the graph does not get. Both
have already happened once each in this migration; both were caught by the
step-level tests, not by the oracles.

**Dependencies do not live in `CycleState`.** The state is CHECKPOINTED --
msgpack, SQLite -- so it carries only values that can survive a process
restart: the persona, the plan, the new 最近 list. An `httpx` client, a subprocess
runner and a live `sqlite3.Connection` cannot. So the collaborators arrive
through `CycleDeps`, bound into each node by a factory (`make_login_node`
and friends) at graph-assembly time, and the node itself keeps the plain
`(state) -> partial` shape LangGraph wants.

**Node -> step map.** Three nodes call more than one step, and each grouping
is a behavioural constraint rather than a tidying:

  * `login` -> `login_step`, `sync_backend_step`, `context_step`. Order:
    probe, then the `agentBackend` PATCH (after login and before any
    context is built), then the read-side assembly. Putting the sync in any later node drops it
    entirely on every early-return path -- measured in Task 5's review, with the whole suite
    green, on the field that is the drift experiment's independent variable.
  * `plan` -> `plan_step`.
  * `guardrail` -> `guardrail_step`. PURE -- no I/O at all, which is why
    §5.4 gives it no retry policy.
  * `execute` -> `execute_step`, `finalize_step`. §5.4's topology has no
    `finalize` node, and the smart mark-read is gated on `landed > 0` from
    the tally `execute_step` has just produced.
  * `behavior_snapshot` -> `analysis.run_behavior_snapshot`. An observability
    sampler, not a step -- `analysis/` is a peer of `act/` and `dream/` --
    and its failure is SWALLOWED rather than surfaced.
  * `dream` -> `cooldown_step`, `dream_step`. The cooldown decides before the
    one paid LLM call.
  * `write` -> `write_step`; `snapshot` -> `snapshot_step`.
  * `logout` -> the terminal record, the cycle_run card and memory
    rotation (`memory_rotation.rotate_memory`).

**Where the guards are, and why none of them are here.** `dry_run` is
threaded into `sync_backend_step`, `execute_step` and `finalize_step`;
`recent` into `write_step`; `written` into `snapshot_step`. Every one of
those steps guards INTERNALLY, so a mis-wired edge writes nothing rather
than writing the wrong thing.

**The deadline.** LangGraph refuses `timeout=` on a sync node at `compile()`
time, and the async form returns control while ORPHANING the subprocess
(both measured; spec §5.4 as corrected). So a node making several bounded
calls is bounded in aggregate by an explicit deadline computed at node entry
-- `dream` is that node: one bounded LLM call plus the reads that build its
prompt.
"""

from __future__ import annotations

import contextlib
import logging
import random
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from swil_agent.act.round import (
    context_step,
    execute_step,
    finalize_step,
    guardrail_step,
    login_step,
    plan_step,
    rotate_memory_soft,
    sync_backend_step,
)
from swil_agent.analysis.behavior_snapshot import run_behavior_snapshot
from swil_agent.analysis.cycle_run import (
    MISSING_SAMPLER_BEHAVIOR,
    build_cycle_run_event,
    build_missing_sampler_event,
    grants_dream_for,
)
from swil_agent.analysis.population_metric import run_population_metric
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources
from swil_agent.config import Settings
from swil_agent.dream.candidate import DreamState
from swil_agent.dream.round import (
    Embedder,
    cooldown_step,
    dream_step,
    snapshot_step,
    write_step,
)
from swil_agent.graph.state import CycleState
from swil_agent.llm.base import Backend
from swil_agent.models import ActOutcome, Persona
from swil_agent.persona.source import PersonaSource

logger = logging.getLogger(__name__)

# The dream node's own FAIL line is a DREAM-PHASE record and must land in
# `agent/logs/dream.log`, not the act log -- the two files are different
# destinations and the `cycle` command
# routes a record to one or the other by the LOGGER THAT EMITTED IT
# (`cli.py`'s `_DREAM_LOG_SOURCES`). This module is the one place that emits
# both phases: the deadline FAIL below is the dream's, and the logout record
# is the cycle's own terminal line, which belongs with the act log. A single module logger cannot
# express that, so the dream-phase one is named as a child -- inheriting this
# module's level and handlers, so `caplog.at_level(..., logger=
# "swil_agent.graph.nodes")` still sees it.
dream_logger = logging.getLogger(f"{__name__}.dream")

NodeFn = Callable[[CycleState], CycleState]

# The `dream` node's aggregate budget. One LLM call capped at
# `SubprocessRunner`'s 300s, plus the group-memory read that builds its
# prompt -- 600s is that with room, not a limit anyone should hit.
# Overridable per cycle via `CycleDeps.dream_deadline_seconds`.
DREAM_DEADLINE_SECONDS: Final = 600.0

_DEADLINE_REASON: Final = "dream deadline exceeded before the LLM call"

# What a shadow round records instead of dreaming. `run_cycle` routes a dry
# cycle straight from the act phase to logout, so this reason is normally
# unreachable -- it exists so that a mis-drawn edge produces a legible
# "nothing happened" state rather than a real dream.
_DRY_RUN_REASON: Final = "dry run: the dream phase is skipped entirely"


class NodeStateError(RuntimeError):
    """A node was entered without a value an earlier node was supposed to
    have produced -- i.e. the graph is mis-wired.

    Loud on purpose: the silent alternative looks like a normal quiet round,
    e.g. planning against a blank `ActContext()` (no feed, no notifications,
    no memory).
    """


def agent_dir_name(persona: Persona) -> str:
    """The account's identity everywhere in this runtime: the persona
    DIRECTORY name, never the frontmatter `username`.

    Lock files (`.agent-state/lock_<name>`), leases and log lines all key on
    it. The two can diverge, and the failure is silent in both directions --
    a lease keyed on the username locks a path nobody else looks at.
    """
    return persona.directory.name


@dataclass(frozen=True)
class CycleDeps:
    """Everything a node needs that `CycleState` cannot carry.

    Frozen and built ONCE per cycle by the composition root, mirroring what
    `cli.py` already hands `run_act` / `run_dream`: the same clients, the
    same frozen `now`, the same `context_now` / `feed_context` / `memory_text`
    strings read from disk before the round starts.

    Two consequences of "once per cycle" that Task 8 owns rather than this
    module:

      * `now` / `captured_at` are frozen for the whole cycle, where the CLI
        takes a fresh `datetime.now()` for its act command and another for
        its dream command. Within one cycle that is a difference of minutes
        in an archive stamp, and it keeps the graph path byte-comparable
        against the direct path for the parity oracle.
      * `memory_text`, `context_now` and `feed_context` are snapshots. If
        loop 3 (multi-round, `MAX_ROUNDS=1` by default, i.e. OFF) is ever
        turned on, round 2 must be given REBUILT deps -- reusing round 1's
        `memory_text` would hide round 1's own posts from
        `ActContext.today_post_count`, and the rhythm gate would let the
        account post again over its ceiling.

    `llm_backend` / `llm_model` are the resolved values `backend` was built
    from (`llm/selection.py`: flag > frontmatter > env > default), which the
    cycle_run card reports. Required, so a composition root cannot fall back
    to the persona file's declaration by forgetting them.
    """

    resources: Resources
    backend: Backend
    persona_source: PersonaSource
    embedder: Embedder
    dream_state: DreamState
    settings: Settings
    agent_root: Path
    health_check: Callable[[], bool]
    memory_text: str
    llm_backend: str
    llm_model: str | None
    context_now: str = "(no context file)"
    feed_context: str = ""
    budget: int = 5
    access_key: str | None = None
    dry_run: bool = False
    auto: bool = False
    rng: random.Random = field(default_factory=random.Random)
    now: datetime = field(default_factory=datetime.now)
    captured_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    dream_deadline_seconds: float = DREAM_DEADLINE_SECONDS
    monotonic: Callable[[], float] = time.monotonic


def _require[T](value: T | None, *, key: str, node: str) -> T:
    if value is None:
        raise NodeStateError(f"the {node} node was entered without {key!r} in CycleState")
    return value


def make_login_node(deps: CycleDeps) -> NodeFn:
    """`login_step` -> `sync_backend_step` -> `context_step`.

    The probe comes first and an offline probe returns immediately: Bash's
    `check_internet` runs once in Main, before any per-account work, so an
    offline round PATCHes nothing and reads nothing.

    `login_step`'s lock is deliberately NOT entered. A node cannot hold a
    context manager across nodes -- it is not serializable checkpoint state
    -- so the graph path takes a `RunLease` around the whole cycle
    (`graph/leases.py`, ruling R2) and uses this step for the probe alone.
    Entering it here would create `.agent-state/lock_<name>` and release it
    one node later, which during stages 3-4 is enough to make a concurrent
    Bash round SKIP the account entirely.
    """

    def login(state: CycleState) -> CycleState:
        persona = state["persona"]
        # `agent_root` and `dry_run` are EQUIVALENT MUTANTS here, and only
        # here: inside `login_step` both feed the lock CHOICE alone
        # (`FileLock(act_lock_path(agent_root, name))` vs `nullcontext()`),
        # and this node discards `step.lock`. So substituting either changes
        # nothing observable and no test can kill it -- do not "fix" that by
        # inventing an assertion. They stop being equivalent the moment a
        # caller stops discarding the lock, which is exactly what Task 8's
        # `RunLease` wiring does when it takes the same paths; the pins for
        # both then live with the lease, not here.
        step = login_step(
            persona=persona,
            agent_root=deps.agent_root,
            health_check=deps.health_check,
            dry_run=deps.dry_run,
        )
        if not step.online:
            return {"agent": step.agent_name, "outcome": ActOutcome.OFFLINE}

        sync_backend_step(
            resources=deps.resources,
            persona=persona,
            agent_name=step.agent_name,
            dry_run=deps.dry_run,
        )
        context, rhythm = context_step(
            resources=deps.resources,
            persona=persona,
            memory_text=deps.memory_text,
            now=deps.now,
            rng=deps.rng,
            budget=deps.budget,
            context_now=deps.context_now,
            feed_context=deps.feed_context,
            era_start=deps.settings.era_start,
            post_probability=deps.settings.post_probability,
            post_ceiling=deps.settings.post_ceiling_per_day,
        )
        return {"agent": step.agent_name, "context": context, "rhythm": rhythm}

    return login


def make_plan_node(deps: CycleDeps) -> NodeFn:
    """`plan_step`. `None` back means the backend produced nothing at all,
    which is one of the only two outcomes that deny the account its dream --
    so the label is set here rather than inferred downstream from a missing
    plan (an empty plan and an absent one are different rounds)."""

    def plan(state: CycleState) -> CycleState:
        planned = plan_step(
            backend=deps.backend,
            persona=state["persona"],
            context=_require(state.get("context"), key="context", node="plan"),
            rhythm=_require(state.get("rhythm"), key="rhythm", node="plan"),
        )
        if planned is None:
            return {"plan": None, "outcome": ActOutcome.BACKEND_UNAVAILABLE}
        return {"plan": planned}

    return plan


def make_guardrail_node(deps: CycleDeps) -> NodeFn:
    """`guardrail_step`. PURE: it reads `deps.budget` and nothing else off
    `deps`, so this node performs no I/O of any kind -- which is why §5.4
    gives it no retry policy and why a test asserts it cannot even touch
    `Resources`.

    `actions` (the survivors) is a separate field from `plan` (the model's
    original proposal) on purpose: `ActResult` reports both, and §7.5 exists
    because "guardrails dropped all five" and "the model proposed nothing"
    were indistinguishable.
    """

    def guardrail(state: CycleState) -> CycleState:
        guarded = guardrail_step(
            plan=_require(state.get("plan"), key="plan", node="guardrail"),
            persona=state["persona"],
            rhythm=_require(state.get("rhythm"), key="rhythm", node="guardrail"),
            context=_require(state.get("context"), key="context", node="guardrail"),
            budget=deps.budget,
        )
        update: CycleState = {
            "actions": guarded.actions,
            "vetoed": guarded.vetoed,
            "solo_nothing": guarded.solo_nothing,
        }
        if guarded.empty_outcome is not None:
            update["outcome"] = guarded.empty_outcome
        return update

    return guardrail


def make_execute_node(deps: CycleDeps) -> NodeFn:
    """`execute_step` -> `finalize_step`, both threaded `dry_run`.

    `deps.embedder` and the `post_duplicate_*` settings are threaded into
    `execute_step` because the near-duplicate guard lives inside that
    function, not in `run_act`'s body -- which is what lets this node get it
    without a copy. The guard's vetoes are appended to the state's `vetoed`.

    `state["round_id"]` labels the similarity event and the post-vector
    ingest; a thread checkpointed before S2 has none and sends `null`. A post
    that landed without its vector filed sets `missing_post_vector`.

    An empty `actions` list returns an empty partial instead of running the
    steps. That mirrors `run_act`'s item 7 -- an empty plan is an early
    return, not a step -- and in the graph the equivalent is an edge that
    routes around this node. This is the belt to that braces: entered by
    mistake, the node must not run `finalize_step` and convert the
    `VETOED_EMPTY` the guardrail node just decided into `LANDED_PARTIAL`
    plus Bash's FAIL line. A solo `nothing` is NOT this case -- it is a
    surviving action and still executes.
    """

    def execute(state: CycleState) -> CycleState:
        actions = state.get("actions") or []
        if not actions:
            return {}

        persona = state["persona"]
        agent_name = agent_dir_name(persona)
        step = execute_step(
            resources=deps.resources,
            persona=persona,
            actions=actions,
            agent_name=agent_name,
            now=deps.now,
            access_key=deps.access_key,
            dry_run=deps.dry_run,
            embedder=deps.embedder,
            duplicate_window=deps.settings.post_duplicate_window,
            duplicate_threshold=deps.settings.post_duplicate_threshold,
            round_id=state.get("round_id"),
        )
        outcome = finalize_step(
            resources=deps.resources,
            actions=step.actions,
            agent_name=agent_name,
            attempted=step.attempted,
            landed=step.landed,
            solo_nothing=state.get("solo_nothing", False),
            dry_run=deps.dry_run,
            emptied=step.emptied,
        )
        update: CycleState = {
            "actions": step.actions,
            "results": step.results,
            "attempted": step.attempted,
            "landed": step.landed,
            "outcome": outcome,
            "vetoed": [*(state.get("vetoed") or []), *step.vetoed],
        }
        if step.missing_post_vector:
            update["missing_post_vector"] = True
        return update

    return execute


@contextlib.contextmanager
def _fail_soft(label: str, name: str) -> Iterator[None]:
    """Swallow any `Exception` from a measurement, logging it.

    No measurement outage may change the round's outcome: left uncaught, an
    unexpected error aborts the whole LangGraph run and costs the account its
    logout record. `BaseException` (`KeyboardInterrupt`, `SystemExit`) is not
    caught -- that is the operator or the platform ending the run.
    """
    try:
        yield
    except Exception as exc:
        # The traceback at DEBUG and the one-line cause at WARNING, matching
        # `cli.py`'s `_skip_for_exception`: a stack trace in the act log
        # would read as a round failure to anyone grepping it for one.
        logger.debug("%s failed for %s", label, name, exc_info=exc)
        logger.warning(
            "%s: %s — sampling failed (%s: %s); the round is unaffected",
            label,
            name,
            type(exc).__name__,
            exc,
        )


def _emit_lab(resources: Resources, username: str, event: LabEvent) -> None:
    """Best-effort ledger write -- a dead events endpoint must not become
    the round's exit code. Same net as `dream/round.py`'s `_emit`."""
    try:
        resources.lab_event(username, event)
    except Exception:
        logger.warning(
            "lab event failed for %s (%s/%s/%s): outcome unaffected",
            username,
            event.type,
            event.phase,
            event.outcome,
        )


def _sampler_missing(label: str, name: str, body: Callable[[], bool]) -> bool:
    """Run a sampler. True if the sample is missing. Never raises Exception.

    `body` returns True when a sample landed (or a documented skip made one
    unnecessary). False or an unexpected exception is a missing sample --
    fail-soft on the round, fail-loud on the ledger.
    """
    try:
        return not body()
    except Exception as exc:
        logger.debug("%s failed for %s", label, name, exc_info=exc)
        logger.warning(
            "%s: %s — sampling failed (%s: %s); the round is unaffected",
            label,
            name,
            type(exc).__name__,
            exc,
        )
        return True


# Documented skip reasons `run_behavior_snapshot` returns with `ok=False`.
# These are "nothing to sample", not "the sampler failed": a quiet account
# or a key-less fixture must not inflate `/lab`'s missingSamples.
_BEHAVIOR_SKIP_REASONS: Final = frozenset({"no api_key.txt", "no recent posts"})


def make_behavior_snapshot_node(deps: CycleDeps) -> NodeFn:
    """`run_behavior_snapshot` -- the act phase's tail, run after the smart
    mark-read and before logout. It embeds the account's recent posts and ships the vector so
    `/lab` can compare *revealed self* against the *stated self*
    `snapshot_step` uploads -- the two halves of the persona-fidelity pair.
    Neither half is derivable from the other, which is why omitting this one
    flattens a panel rather than degrading it.

    A NODE rather than a tail call inside `make_execute_node`, for two
    reasons that are both about not sampling twice. `execute` carries
    `EXECUTE_RETRY`, so a failure after the write loop (an `OSError`
    appending to `memory.md`) re-enters that node -- and a tail call would
    ship a second snapshot for the same round. And on `--resume`, LangGraph
    restarts at the node that died; a completed node is not re-run, where a
    tail call inside a re-run node is.

    Reachability follows from where the node sits: an offline probe, a dead
    backend and an empty plan after guardrails never reach `execute`, so they
    never reach this node either. A round where every planned action failed
    still samples (design spec §7.1 -- only `BACKEND_UNAVAILABLE` and
    `OFFLINE` deny the round its tail, the same correction `finalize_step`
    already records for the dream).

    `dry_run` is checked HERE, and here is the ONLY place it can be checked:
    unlike the dream phase, the act phase has no edge that routes a shadow
    round around this node -- `execute` runs under `--dry-run` (inertly) and
    flows straight into it. `run_behavior_snapshot` takes no `dry_run`
    parameter to be inert under, and it POSTs on every successful path, so
    deleting this line posts a behavior snapshot for all 23 accounts during
    the round whose exit criterion is "Python never wrote" (standing
    constraint §5 and §9).
    """

    def behavior_snapshot(state: CycleState) -> CycleState:
        if deps.dry_run:
            return {}
        persona = state["persona"]
        name = agent_dir_name(persona)

        def body() -> bool:
            result = run_behavior_snapshot(
                deps.resources,
                directory=persona.directory,
                username=persona.username,
                embedder=deps.embedder,
                captured_at=deps.captured_at,
                limit=deps.settings.behavior_post_limit,
            )
            return result.ok or result.reason in _BEHAVIOR_SKIP_REASONS

        missing = _sampler_missing("behavior-snapshot", name, body)
        if missing:
            _emit_lab(
                deps.resources,
                persona.username,
                build_missing_sampler_event(sampler=MISSING_SAMPLER_BEHAVIOR),
            )
            return {"missing_behavior_snapshot": True}
        return {}

    return behavior_snapshot


def make_population_metric_node(deps: CycleDeps) -> NodeFn:
    """`run_population_metric` -- the cycle's tail, and the ONLY thing that
    puts a point on `/lab`'s homogenization trend.

    Before it was wired here the series held three points in four months,
    each from someone running the command by hand.

    **Why here, and what it costs.** The route is `POST
    /agents/population-metric`: GLOBAL, no username, no body, and the SERVER
    does all of the arithmetic from vectors it already stores
    (`recordPopulationMetric` -> `computeCohesion`, `population/population.ts`).
    So this adds exactly one HTTP round-trip per cycle and NO second embedder
    call -- the embeddings it summarises were shipped earlier in this same
    round by `behavior_snapshot` and, on an accepted dream, `snapshot_step`.
    Sampling here rather than once per roster sweep is also what makes the
    series causal: the population vector moves when an account's snapshot
    lands, and this samples immediately after that account's did.

    **Position: AFTER `logout`, deliberately.** `logout` is the ACCOUNT's
    terminal record -- §7.6's structured line, "the only record that a cycle
    reached its end rather than dying somewhere in the middle". This
    measurement is not about the account at all; it is a reading of the whole
    population that the account's round happens to be a good moment to take.
    Putting it after keeps that line meaning what it says, and keeps every
    router honestly named `_continue_or_logout` rather than pointing at a
    sampler. The cost is cosmetic and named here so nobody reports it as a
    bug: a fail-soft WARN from this node appears BELOW the logout line.

    **The `OFFLINE` skip is not symmetry with the other sampler.** They
    skip a round that did not happen. This one skips a round that could not
    have reached the API: `ActOutcome.OFFLINE` is the health probe against
    `$SWIL_URL/health` having failed, so the POST is guaranteed to fail too.
    Left in, a roster sweep against a down platform would spend 23 connection
    timeouts and print 23 WARN lines about a measurement nobody could have
    taken -- standing constraint §9's "23 spurious FAIL lines per round" in
    another costume. `BACKEND_UNAVAILABLE` deliberately does NOT skip: that
    is a dead LLM with a healthy platform, and the population reading is as
    valid then as on any other round.
    """

    def population_metric(state: CycleState) -> CycleState:
        if deps.dry_run:
            return {}
        if state.get("outcome") is ActOutcome.OFFLINE:
            return {}
        with _fail_soft("population-metric", agent_dir_name(state["persona"])):
            run_population_metric(deps.resources)
        return {}

    return population_metric


def make_dream_node(deps: CycleDeps) -> NodeFn:
    """`cooldown_step` -> `dream_step`, under an explicit deadline.

    One node because the cooldown must decide before the paid LLM call. The
    deadline is checked before that call; exceeding it degrades to the shape
    of a failed dream (proceeded, no list, a reason) rather than raising, so a
    cycle that has already acted still reaches its logout record.

    `dry_run` is checked here as well as on the edge that routes a shadow
    round to logout: `dream_step` posts a lab event and spends an LLM call.
    """

    def dream(state: CycleState) -> CycleState:
        if deps.dry_run:
            return {"proceeded": False, "dream_reason": _DRY_RUN_REASON}
        persona = state["persona"]
        deadline = deps.monotonic() + deps.dream_deadline_seconds

        cooldown = cooldown_step(
            persona=persona,
            persona_source=deps.persona_source,
            state=deps.dream_state,
            settings=deps.settings,
            now=deps.now,
            auto=deps.auto,
        )
        if not cooldown.proceed:
            return {"proceeded": False, "dream_reason": cooldown.reason}

        if deps.monotonic() >= deadline:
            dream_logger.warning("FAIL %s — %s", agent_dir_name(persona), _DEADLINE_REASON)
            return {"proceeded": True, "dream_reason": _DEADLINE_REASON}

        dreamt = dream_step(
            persona=persona,
            resources=deps.resources,
            backend=deps.backend,
            memory_text=cooldown.memory_text,
        )
        if dreamt.failure_reason is not None:
            return {"proceeded": True, "dream_reason": dreamt.failure_reason}
        return {"proceeded": True, "recent": dreamt.recent}

    return dream


def make_write_node(deps: CycleDeps) -> NodeFn:
    """`write_step`, with `recent` threaded in rather than branched on: the
    step's own `recent is None` guard is what keeps a failed dream off disk.

    A refused write (the file would break the format or the size limit)
    reports its reason as `dream_reason`. `dry_run` is checked here too: this
    node performs every write of the dream phase. The dream lock is held by
    `run_cycle`'s lease for the whole cycle, which is what `write_recent`
    relies on.
    """

    def write(state: CycleState) -> CycleState:
        if deps.dry_run:
            return {"written": False}
        step = write_step(
            persona=state["persona"],
            persona_source=deps.persona_source,
            state=deps.dream_state,
            resources=deps.resources,
            recent=state.get("recent"),
            now=deps.now,
        )
        if step.reason is not None:
            return {"written": step.written, "dream_reason": step.reason}
        return {"written": step.written}

    return write


def make_snapshot_node(deps: CycleDeps) -> NodeFn:
    """`snapshot_step`, keyed on `written` (the snapshot is a published claim
    about what `personality.md` now says). `dry_run` is checked here too."""

    def snapshot(state: CycleState) -> CycleState:
        if deps.dry_run:
            return {"snapshot_ok": False, "snapshot_reason": None}
        step = snapshot_step(
            persona=state["persona"],
            resources=deps.resources,
            embedder=deps.embedder,
            agent_root=deps.agent_root,
            captured_at=deps.captured_at,
            recent=state.get("recent"),
            written=state.get("written", False),
        )
        return {"snapshot_ok": step.ok, "snapshot_reason": step.reason}

    return snapshot


def make_logout_node(deps: CycleDeps) -> NodeFn:
    """The cycle's terminal record.

    There is no session to tear down: §7.4 removed `.agent-state/active`
    (agent identity is a value in `CycleState`, which is what makes parallel
    runs safe by construction rather than by the `SWIL_AGENT` workaround),
    and the lease that holds the Bash-visible lock file wraps the WHOLE
    cycle -- releasing anything here would hand a live successor a lock it
    does not hold, which is the ABA hole `RunLease` closed one layer down.

    So what is left is §7.6's structured line: `run_id`, the account, the
    act outcome and what the dream did -- the only record that a cycle
    reached its end -- then the cycle_run card and memory rotation. Rotation
    runs here, under the cycle's lease, after the dream has read memory.md;
    a dry run does neither.
    """

    def logout(state: CycleState) -> CycleState:
        logger.info(
            "logout %s — run_id=%s outcome=%s dream_written=%s snapshot_ok=%s dry_run=%s",
            agent_dir_name(state["persona"]),
            state.get("run_id", ""),
            state.get("outcome"),
            state.get("written", False),
            state.get("snapshot_ok", False),
            deps.dry_run,
        )
        if not deps.dry_run:
            _emit_cycle_run_card(deps, state)
            persona = state["persona"]
            rotate_memory_soft(persona.directory, agent_dir_name(persona))
        return {}

    return logout


def _emit_cycle_run_card(deps: CycleDeps, state: CycleState) -> None:
    """One cycle_run card per finished cycle, including early logout.

    `backend`/`model` come from `deps` -- what the LLM client was built from
    -- not from the persona file."""
    persona = state["persona"]
    outcome = state.get("outcome")
    proceeded = state.get("proceeded", False)
    written = state.get("written", False)
    started = state.get("started_monotonic")
    duration_ms = 0 if started is None else max(0, int((deps.monotonic() - started) * 1000))
    if written:
        dream_accepted: bool | None = True
    elif proceeded:
        dream_accepted = False
    else:
        dream_accepted = None
    event = build_cycle_run_event(
        username=persona.username,
        attempted=state.get("attempted", 0),
        landed=state.get("landed", 0),
        act_outcome=outcome,
        grants_dream=grants_dream_for(outcome),
        dream_accepted=dream_accepted,
        missing_behavior_snapshot=state.get("missing_behavior_snapshot", False),
        duration_ms=duration_ms,
        backend=deps.llm_backend,
        model=deps.llm_model or "",
        round_id=state.get("round_id"),
        missing_post_vector=state.get("missing_post_vector", False),
    )
    _emit_lab(deps.resources, persona.username, event)
