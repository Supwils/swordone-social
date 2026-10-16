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
window on its own: the longest is one LLM call, capped at 600s on grok
(`llm/backends/grok.py`) and 300s on every other backend (`llm/runner.py`).
The dream's `write_recent` holds no lock of its own and relies on this lease
for `dream_lock_<name>`.

**A resume never re-enters `execute` or `write`.** Neither is idempotent: a
cycle that died inside `execute` may already have landed some of its actions,
and one that died inside `write` may already have rewritten `personality.md`
and archived the old file. Re-running either from the top would post twice or
archive twice, so `--resume` refuses (`UnsafeResumeError`, exit 64) and the
operator runs a fresh cycle instead.
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

from swil_agent.graph.cycle import EXECUTE, WRITE, CycleContext, Phases, build_graph
from swil_agent.graph.deps import CycleDeps, FinishDeps, agent_dir_name
from swil_agent.graph.state import BUILTIN_TENANT, CycleState, thread_id
from swil_agent.locks.lease import LeaseKind, RunLease
from swil_agent.models import Persona
from swil_agent.round_id import manual_round_id

# What each phase locks, act before dream: one fixed order, so two runs racing
# for the same account cannot deadlock against each other.
_LEASE_KINDS: Final[dict[Phases, tuple[LeaseKind, ...]]] = {
    Phases.CYCLE: ("act", "dream"),
    Phases.ACT: ("act",),
    Phases.DREAM: ("dream",),
}

# The nodes a resume must not re-enter, and why (module docstring).
_UNSAFE_TO_RESUME: Final[dict[str, str]] = {
    EXECUTE: "some of its actions may already have landed, and re-running it would post them again",
    WRITE: "personality.md may already be rewritten, and re-running it would archive it twice",
}


class UnsafeResumeError(RuntimeError):
    """`--resume` of a thread whose next node is `execute` or `write`.

    Raised before any lease is taken or node runs. The CLI exits 64: the
    invocation is what is wrong, and the remedy is a fresh cycle."""

    def __init__(self, agent: str, round_id: str, node: str) -> None:
        self.agent = agent
        self.round_id = round_id
        self.node = node
        super().__init__(
            f"{agent}: refusing to --resume round {round_id} -- it stopped inside "
            f"`{node}`, and {_UNSAFE_TO_RESUME[node]}. Run a fresh "
            f"`swil-agent cycle {agent} --auto` (without --resume) instead"
        )


def lease_kinds(phases: Phases) -> tuple[LeaseKind, ...]:
    """The leases a non-dry run of `phases` holds for its whole duration:
    `CYCLE` (act, dream), `ACT` (act), `DREAM` (dream) -- S3 §12.10."""
    return _LEASE_KINDS[phases]


def run_graph(
    deps: CycleDeps,
    *,
    phases: Phases,
    persona: Persona,
    lease_db: sqlite3.Connection,
    checkpointer: BaseCheckpointSaver[Any] | None = None,
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

    `dry_run` takes NO lease: a dry run executes
    nothing and writes nothing, so it needs no mutual exclusion -- and taking
    the lock would cost a concurrent real round its whole turn (F4).

    `finish_deps`, when given, completes the deps AFTER the leases are held
    and before the first node runs. `act` and `cycle` build their world
    context (the feed and search reads, the `news-fetch.sh` refresh) and read
    `memory.md` there, so an account another run holds costs no reads at all
    (S3 §12.2(f)) and the memory snapshot cannot race that run's appends.

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

    Three consequences of resuming worth knowing: a thread whose previous run
    completed runs no nodes at all and returns its stored final state, a
    thread that was never checkpointed raises langgraph's `EmptyInputError`,
    and a thread whose next node is `execute` or `write` raises
    `UnsafeResumeError` before any lease is taken (module docstring).
    """
    if phases is not Phases.CYCLE and (checkpointer is not None or resume):
        raise ValueError(f"a {phases.value} run is not checkpointed: --resume is a cycle option")
    if resume and checkpointer is None:
        raise ValueError("resume=True needs a checkpointer: there is nothing to continue from")
    if deps.probe_board and not deps.dry_run:
        raise ValueError("--probe-board requires --dry-run")
    name = agent_dir_name(persona)
    round_key = round_id if round_id is not None else manual_round_id(deps.captured_at)
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
        "dry_run": deps.dry_run,
        "started_monotonic": deps.monotonic(),
    }
    # `None` on a resume: see this function's docstring. The seed is still
    # BUILT on that path, because it is also this function's return value if
    # the resumed thread has nothing left to run.
    stream_input = None if resume else state
    app = build_graph(phases).compile(checkpointer=checkpointer)
    run_config: RunnableConfig = {"configurable": {"thread_id": thread}}
    if resume:
        # Before the lease, so a refused resume takes none ...
        _refuse_unsafe_resume(app, run_config, name, round_key)

    with contextlib.ExitStack() as stack:
        leases = _acquire(
            stack, lease_db, deps, tenant, name, run_key, lease_clock, lease_kinds(phases)
        )
        if resume:
            # ... and again under it: a run that held this thread until a
            # moment ago (its lease reclaimed) may have moved it on since.
            _refuse_unsafe_resume(app, run_config, name, round_key)
        if finish_deps is not None:
            deps = finish_deps(deps)
        context = CycleContext(deps=deps, lease_db=lease_db, lease_clock=lease_clock)
        for chunk in app.stream(
            stream_input, config=run_config, context=context, stream_mode="values"
        ):
            state = cast(CycleState, chunk)
            for lease in leases:
                # Between nodes, so every beat immediately precedes the next
                # node's execution and the 1800s staleness window restarts
                # at that node's start.
                lease.heartbeat()
    return state


def _refuse_unsafe_resume(app: Any, run_config: RunnableConfig, name: str, round_key: str) -> None:
    """Raise `UnsafeResumeError` if the thread's next node is one a resume
    must not re-enter (module docstring)."""
    for pending in app.get_state(run_config).next:
        if pending in _UNSAFE_TO_RESUME:
            raise UnsafeResumeError(name, round_key, pending)


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
