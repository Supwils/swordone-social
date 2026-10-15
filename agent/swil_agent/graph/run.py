"""Running a phase graph: the lease, the stream, the heartbeat (S3 §4, §5).

`run_graph` is the ONE runner the `act`, `dream` and `cycle` commands share;
`run_cycle` (`graph/cycle.py`) is its `Phases.CYCLE` call. What it adds around
the graph `graph/cycle.py` builds is the lease and, for `CYCLE` only, the
checkpointer.

**The lease wraps the whole run, for every kind its phases need.**
`lease_kinds` is the one function that decides them: a cycle acts AND dreams,
and the two phases lock separately (`lock_<name>`, `dream_lock_<name>`), so
`CYCLE` holds both for the whole run -- a dream that only checked its own lock
would otherwise rewrite `personality.md` under a cycle that is dreaming.
`ACT` holds the act lease alone and takes the dream lease inside its logout,
non-blocking, for memory rotation only (S3 §12.7, §12.10): holding it for the
whole act would make a manual `act` and a standalone `dream` SKIP each other
for no correctness reason. `DREAM` holds the dream lease. Leases are held by
this function and not by a node: a context manager cannot span nodes.

**`heartbeat()` is called from here, between nodes.** `run_graph` drives the
graph with `stream(stream_mode="values")` rather than `invoke`, and beats every
lease after every superstep -- so each beat immediately precedes the next
node's execution and the 1800s staleness window restarts at that node's start.
Without any caller, a run longer than `LEASE_TTL_SECONDS` has its lock file
reclaimed by the next round WHILE STILL HOLDING IT. No single node outruns the
window on its own: the longest is one LLM call capped at 300s. The dream's
`write_recent` holds no lock of its own and relies on this lease for
`dream_lock_<name>`.
"""

from __future__ import annotations

import contextlib
import sqlite3
import time
import uuid
from collections.abc import Callable
from typing import Any, Final, cast

from langgraph.checkpoint.base import BaseCheckpointSaver

# `RunnableConfig` is re-exported by `langgraph.types` at runtime but is not in
# its `__all__`, and `mypy --strict` implies `--no-implicit-reexport`. Importing
# it from `langchain_core.runnables`, where it actually lives, would put an
# UNDECLARED transitive dependency in this package's import list. Same shape as
# the `eff_request_host` ignore in `api/client.py`.
from langgraph.types import RunnableConfig  # type: ignore[attr-defined]

from swil_agent.graph.cycle import (
    CycleConfig,
    CycleContext,
    DepsProvider,
    Phases,
    build_graph,
)
from swil_agent.graph.deps import CycleDeps, agent_dir_name
from swil_agent.graph.state import BUILTIN_TENANT, CycleState, thread_id
from swil_agent.locks.lease import LeaseKind, RunLease
from swil_agent.models import Persona
from swil_agent.round_id import manual_round_id

# LangGraph's own default. Every extra act round costs 5 supersteps, so the
# derived limit only ever exceeds this for a configuration that turns loop 3
# on.
_DEFAULT_RECURSION_LIMIT: Final = 25

# What each phase locks, act before dream: one fixed order, so two runs racing
# for the same account cannot deadlock against each other.
_LEASE_KINDS: Final[dict[Phases, tuple[LeaseKind, ...]]] = {
    Phases.CYCLE: ("act", "dream"),
    Phases.ACT: ("act",),
    Phases.DREAM: ("dream",),
}

FinishDeps = Callable[[CycleDeps], CycleDeps]


def lease_kinds(phases: Phases) -> tuple[LeaseKind, ...]:
    """The leases a non-dry run of `phases` holds for its whole duration:
    `CYCLE` (act, dream), `ACT` (act), `DREAM` (dream) -- S3 §12.10."""
    return _LEASE_KINDS[phases]


def _recursion_limit(config: CycleConfig) -> int:
    """Five supersteps per act round (`login`, `plan`, `guardrail`, `execute`,
    `behavior_snapshot`), plus the `dream` / `write` / `snapshot` / `logout` /
    `population_metric` tail and START."""
    needed = 5 * config.max_rounds + 6
    return max(_DEFAULT_RECURSION_LIMIT, needed)


def _deps_provider(deps: CycleDeps | DepsProvider, config: CycleConfig) -> DepsProvider:
    """A single frozen `CycleDeps` is only sound for a single act round.

    `memory_text`, `context_now` and `feed_context` are snapshots taken before
    the cycle starts. Reusing them for round 2 hides round 1's own posts from
    `ActContext.today_post_count`, and the rhythm gate then lets the account
    post again over its ceiling -- a real over-posting round, invisible in
    every unit test, which is why this is refused at the call instead of
    documented.
    """
    if isinstance(deps, CycleDeps):
        if config.max_rounds > 1:
            raise ValueError(
                "max_rounds > 1 needs deps rebuilt per round: pass a "
                "Callable[[int], CycleDeps], not a single frozen CycleDeps "
                "(round 2 would plan against round 1's memory_text)"
            )
        frozen = deps
        return lambda _round_index: frozen
    return deps


def run_graph(
    deps: CycleDeps | DepsProvider,
    *,
    phases: Phases,
    persona: Persona,
    lease_db: sqlite3.Connection,
    checkpointer: BaseCheckpointSaver[Any] | None = None,
    config: CycleConfig | None = None,
    tenant: str = BUILTIN_TENANT,
    round_id: str | None = None,
    run_id: str | None = None,
    resume: bool = False,
    lease_clock: Callable[[], float] = time.time,
    finish_deps: FinishDeps | None = None,
) -> CycleState:
    """Run one phase graph for one account and return its final `CycleState`.

    Holds the leases `lease_kinds(phases)` names for the whole run, beats them
    between nodes, and releases them however the run ends -- normal return,
    exception, `SystemExit(141)`. A busy lease raises `LeaseBusy` before any
    node runs, with no LLM call spent; the caller SKIPs, as Bash does.

    `dry_run` (read off the round-0 deps) takes NO lease: a dry run executes
    nothing and writes nothing, so it needs no mutual exclusion -- and taking
    the lock would cost a concurrent real round its whole turn (F4).

    `finish_deps`, when given, completes the round-0 deps AFTER the leases are
    held and before the first node runs. `act` builds its world context (the
    feed and search reads, the `news-fetch.sh` refresh) and reads `memory.md`
    there, so an account another run holds costs no reads at all (S3
    §12.2(f)). It takes a single `CycleDeps` only.

    Identity: the lease, the log lines and `CycleState["agent"]` all use the
    persona DIRECTORY name (`agent_dir_name`), never the `Username` bullet --
    the `Username` bullet and the directory name can differ. `round_id` is
    chosen by the caller (`round_id.py`: resume, then `SWIL_ROUND_ID`, then
    manual) and defaults to a MANUAL id at `deps.captured_at`, so it is
    reproducible from the run's frozen moment and never mistaken for a
    sweep. It keys the thread and is seeded into `CycleState["round_id"]`,
    where every node reads it. `run_id` defaults to a fresh uuid, because
    `RunLease`'s release is identity-scoped and a successor must never be
    mistakable for the holder it replaced.

    Only `CYCLE` is checkpointed: a subset run compiles without a
    checkpointer, so `checkpointer` and `resume` are refused for `ACT` and
    `DREAM` (`--resume` is a `cycle` option only).

    `resume=True` streams **`None`** instead of the seed state, which is what
    actually continues an interrupted run: measured against langgraph 1.2.11,
    a graph that died inside node `b` resumes at `b` and does NOT re-run `a`,
    while streaming the seed state again would re-apply it as an update
    (resetting `round_index` to 0, among other things) before continuing. It
    requires a `checkpointer` -- there is nothing to continue from without one
    -- and the caller must supply the ORIGINAL `round_id`, because the thread
    id is the checkpoint's only key and the default derives it from
    `deps.captured_at`, which is a different moment in the resuming process.
    The resumed state keeps the `round_id` it was checkpointed with.

    Two consequences of resuming worth knowing: a thread whose previous run
    completed runs no nodes at all and returns its stored final state, and a
    thread that was never checkpointed raises langgraph's `EmptyInputError`.
    """
    cfg = config or CycleConfig()
    if phases is not Phases.CYCLE and (checkpointer is not None or resume):
        raise ValueError(f"a {phases.value} run is not checkpointed: --resume is a cycle option")
    if resume and checkpointer is None:
        raise ValueError("resume=True needs a checkpointer: there is nothing to continue from")
    if finish_deps is not None and not isinstance(deps, CycleDeps):
        raise ValueError("finish_deps completes a single CycleDeps, not a per-round provider")
    provider = _deps_provider(deps, cfg)
    first = provider(0)
    if first.probe_board and not first.dry_run:
        raise ValueError("--probe-board requires --dry-run")
    name = agent_dir_name(persona)
    round_key = round_id if round_id is not None else manual_round_id(first.captured_at)
    run_key = run_id if run_id is not None else uuid.uuid4().hex
    thread = thread_id(tenant, name, round_key)

    # EQUIVALENT MUTANT, conditionally (standing constraint §7): `"agent"`
    # here can be swapped for `persona.username` and no test can tell, because
    # the `login` node returns `{"agent": step.agent_name}` on BOTH its
    # branches and always runs first, so the seed is always overwritten before
    # anything reads it. It stops being equivalent the moment a node other
    # than `login` becomes the entry point, or `login` stops reporting the
    # name on one of its branches -- and the seeded value is what a checkpoint
    # written before `login` completes would carry. It is the DIRECTORY name
    # for the same reason everything else here is. (`DREAM` enters at
    # `dream`, which never reports the name: the seed is what it keeps.)
    state: CycleState = {
        "tenant": tenant,
        "agent": name,
        "persona": persona,
        "thread_id": thread,
        "round_id": round_key,
        "run_id": run_key,
        "round_index": 0,
        # Read off the ROUND-0 deps, the same instance `_acquire` asks about
        # the lease. A provider that flipped `dry_run` between rounds would be
        # a contradiction in terms, and the routers need one answer.
        "dry_run": first.dry_run,
        "started_monotonic": first.monotonic(),
    }
    # `None` on a resume: see this function's docstring. The seed is still
    # BUILT on that path, because it is also this function's return value if
    # the resumed thread has nothing left to run.
    stream_input = None if resume else state
    app = build_graph(phases, cfg).compile(checkpointer=checkpointer)
    run_config: RunnableConfig = {
        "configurable": {"thread_id": thread},
        "recursion_limit": _recursion_limit(cfg),
    }

    with contextlib.ExitStack() as stack:
        leases = _acquire(
            stack, lease_db, first, tenant, name, run_key, lease_clock, lease_kinds(phases)
        )
        if finish_deps is not None:
            provider = _deps_provider(finish_deps(first), cfg)
        context = CycleContext(deps_for_round=provider, lease_db=lease_db, lease_clock=lease_clock)
        for chunk in app.stream(
            stream_input, config=run_config, context=context, stream_mode="values"
        ):
            state = cast(CycleState, chunk)
            for lease in leases:
                # Between nodes, so every beat immediately precedes the next
                # node's execution and Bash's 1800s staleness window restarts
                # at that node's start.
                lease.heartbeat()
    return state


def _acquire(
    stack: contextlib.ExitStack,
    db: sqlite3.Connection,
    deps: CycleDeps,
    tenant: str,
    name: str,
    run_key: str,
    clock: Callable[[], float],
    kinds: tuple[LeaseKind, ...],
) -> list[RunLease]:
    """Enter one `RunLease` per kind, in order; a dry run takes none. Each
    lease takes its file lock first and its row second (`locks/lease.py`)."""
    if deps.dry_run:
        return []
    return [
        stack.enter_context(
            RunLease(db, deps.agent_root, tenant, name, kind, run_id=run_key, now=clock)
        )
        for kind in kinds
    ]
