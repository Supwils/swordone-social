"""The phase graphs: the act nodes, the dream nodes and the population-cohesion
tail, wired together once per `Phases` member from the same `make_*_node`
factories (S3 §12.4).

```
login → plan → guardrail → execute → behavior_snapshot ─┐
          │        │                                     │
          │        └ (veto / empty) ───────────────────→ dream → write → snapshot
          │                                                 │
          └ (offline / dead backend) ───────→ logout ←──────┘ (no list)

  ... every path ends: → logout → population_metric → END
```

That is `Phases.CYCLE`, the `cycle` command's graph, node-for-node and
edge-for-edge the graph S3 started from (a test pins it). The two subsets are
SEPARATE graphs, not the cycle with phase-conditional routers, so neither the
cycle's topology nor its checkpoint schema depends on them:

```
ACT:    login → plan → guardrail → execute → logout → END
          │        │        └ (veto / empty) ──┘ ↑
          └────────┴─ (offline / dead backend) ───┘
DREAM:  dream → write → snapshot → END       (no list: dream → END)
```

`ACT` is the `act` command: no behaviour snapshot, no dream, no population
metric, and its logout files no cycle_run card -- an act-only run is not a
cycle (S3 §12.7). `DREAM` is the `dream` command. Running a graph -- the lease,
the stream, the heartbeat -- is `graph/run.py`; the retry policies are
`graph/policies.py`. Every phase attaches the same policy to the same node.

`population_metric` is the cycle's tail: EVERY path reaches `logout`, and
`logout -> population_metric -> END` is unconditional, so one
population-cohesion sample lands per cycle. It sits after `logout` because
`logout` is the ACCOUNT's terminal record and this is a reading of the whole
population -- see `make_population_metric_node`.

`behavior_snapshot` is the act phase's tail (once per act round); it is
fail-soft and skipped entirely under `--dry-run`.

Loop 3 (**default OFF**, `CycleConfig.max_rounds`) sends `behavior_snapshot`
back to `login` for another act round. It is built rather than omitted so
enabling it is a config change instead of a topology change -- but a graph
that loops by DEFAULT multiplies every account's spend, so the default is 1.
Only `CYCLE` has the loop.

**Where the business logic is not.** Every decision this module makes about
*whether* something may happen is delegated: "does this outcome still grant a
dream" is `ActResult.grants_dream` (design spec §7.1), constructed here rather
than reimplemented, so the graph and the CLI cannot answer it differently.
What is left is routing. `dream` routes to `write` only when it produced a
list, and `write_step` / `snapshot_step` still guard internally on `recent`
and `written`, so a mis-drawn edge writes nothing.

**No node declares a `timeout=`.** Measured 2026-08-18 (spec §5.4 as
corrected): `compile()` raises `ValueError: Node timeouts are only supported
for async nodes because sync Python execution cannot be safely cancelled
in-process`, and the async form returns control while ORPHANING the child
process -- trading an orphan lock for an orphan subprocess. Bounding lives in
the subprocess and transport layers, where `subprocess.run(timeout=)` actually
kills the child. `test_no_node_declares_a_timeout` fails the build if one
comes back.

**Deps arrive through the runtime context, not through `CycleState`.** The
state is checkpointed (msgpack/SQLite) and an `httpx` client cannot survive
that; the context is per-invocation and is never serialised (verified against
langgraph 1.2.11 -- the checkpoint's metadata carries `parents`/`source`/`step`
and nothing from the context). That is also what lets `build_cycle()` take no
deps at all, so the graph's shape can be compiled and inspected without a
roster.

**One `CycleDeps` per act round, not one per cycle.** `CycleDeps` is frozen and
its `memory_text` / `context_now` / `feed_context` are snapshots taken before
the round. Loop 3 therefore resolves deps through `CycleContext.deps_for_round`
on every node entry, keyed on `round_index`: round 2 gets REBUILT deps, or it
would plan against round 1's `memory.md` and the rhythm gate would let the
account post again over its own ceiling. `run_graph` refuses `max_rounds > 1`
against a single frozen `CycleDeps` rather than letting that happen quietly.
"""

from __future__ import annotations

import enum
import sqlite3
import time
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Any, Final, Protocol

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime

from swil_agent.graph.deps import CycleDeps, NodeFn, NodeStateError, agent_dir_name
from swil_agent.graph.nodes_act import (
    make_execute_node,
    make_guardrail_node,
    make_login_node,
    make_plan_node,
)
from swil_agent.graph.nodes_dream import make_dream_node, make_snapshot_node, make_write_node
from swil_agent.graph.nodes_tail import (
    make_act_logout_node,
    make_behavior_snapshot_node,
    make_logout_node,
    make_population_metric_node,
)
from swil_agent.graph.policies import (
    DREAM_RETRY,
    EXECUTE_RETRY,
    LOGIN_RETRY,
    PLAN_RETRY,
    SNAPSHOT_RETRY,
)
from swil_agent.graph.state import BUILTIN_TENANT, CycleState
from swil_agent.locks.lease import RunLease
from swil_agent.models import ActResult, Persona

# Node names, spelled once. They are also the `CycleState` thread's public
# vocabulary: a checkpoint records which node it stopped at, and `--resume`
# (task 9) reads that name back.
LOGIN: Final = "login"
PLAN: Final = "plan"
GUARDRAIL: Final = "guardrail"
EXECUTE: Final = "execute"
BEHAVIOR_SNAPSHOT: Final = "behavior_snapshot"
DREAM: Final = "dream"
WRITE: Final = "write"
SNAPSHOT: Final = "snapshot"
LOGOUT: Final = "logout"
POPULATION_METRIC: Final = "population_metric"

# Loop 3 OFF: one act round per cycle.
DEFAULT_MAX_ROUNDS: Final = 1


class Phases(enum.Enum):
    """Which graph a run executes -- one per command (S3 §4, §12.5)."""

    CYCLE = "cycle"  # login → plan → guardrail → execute → behavior_snapshot →
    # dream → write → snapshot → logout → population_metric
    ACT = "act"  # login → plan → guardrail → execute → logout
    DREAM = "dream"  # dream → write → snapshot


@dataclass(frozen=True)
class CycleConfig:
    """The act-loop bound. Validated at construction: an unbounded act loop is
    an unbounded number of posts."""

    max_rounds: int = DEFAULT_MAX_ROUNDS

    def __post_init__(self) -> None:
        if self.max_rounds < 1:
            raise ValueError("max_rounds must be at least one act round")


DepsProvider = Callable[[int], CycleDeps]


@dataclass(frozen=True)
class CycleContext:
    """LangGraph's per-invocation runtime context: everything a node needs
    that `CycleState` cannot carry across a checkpoint.

    `deps_for_round` is called with the number of act rounds ALREADY
    COMPLETED, so round 1 sees `0`. The dream phase resolves after the last
    act round and therefore asks for index `max_rounds`; a provider must
    tolerate that (the built-in constant provider ignores the index, and a
    real factory should clamp).

    `lease_db` / `lease_clock` are the run's own lease database and clock.
    Only `ACT`'s logout reads them: it takes the dream lease for memory
    rotation inside the node (S3 §12.7), because the `ACT` run holds the act
    lease alone.
    """

    deps_for_round: DepsProvider
    lease_db: sqlite3.Connection | None = None
    lease_clock: Callable[[], float] = time.time


CycleGraph = StateGraph[CycleState, CycleContext, CycleState, CycleState]
_Router = Callable[[CycleState], str]


class _CycleNode(Protocol):
    """The shape LangGraph's own `_NodeWithRuntime` protocol demands:
    `runtime` is KEYWORD-ONLY there. A positional second parameter is
    accepted at runtime and rejected by the `add_node` overloads under
    `mypy --strict`, which is a confusing way to find out."""

    def __call__(self, state: CycleState, *, runtime: Runtime[CycleContext]) -> CycleState: ...


def _grants_dream(state: CycleState) -> bool:
    """Design spec §7.1, via its ONE implementation.

    `ActResult.grants_dream` is constructed rather than reimplemented so the
    graph cannot answer differently from the `act` command's exit code: only
    `BACKEND_UNAVAILABLE` and `OFFLINE` deny the account its dream. An
    outcome that has not been decided yet (the act phase is still running)
    denies nothing.

    Spec §7.1: a rhythm veto or an empty plan must not cost the account its
    dream ("an empty plan came to cost a personality evolution"), and
    `finalize_step` records the same on the `landed == 0` branch.

    EQUIVALENT MUTANT, conditionally (standing constraint §7): the last line
    can be replaced by a direct membership test
    (`outcome not in (ActOutcome.BACKEND_UNAVAILABLE, ActOutcome.OFFLINE)`)
    and no test can tell, because that IS `ActResult.grants_dream`'s body
    today. It is written as a construction anyway, and the equivalence is the
    point: the graph must not be able to answer differently from the `act`
    command. It expires the moment §7.1's rule stops being a pure function of
    `outcome` -- e.g. if a future rule consults `landed` or `attempted` --
    at which point the membership form silently keeps the old semantics on
    the graph path only. Review found one further mutation here with no
    reachable failing case; it predates Plan 4 and is accepted rather than
    papered over with an assertion invented to kill it.
    """
    outcome = state.get("outcome")
    if outcome is None:
        return True
    return ActResult(outcome=outcome).grants_dream


def _dream_phase_or_logout(state: CycleState) -> str:
    """The ONE place the act phase can enter the dream phase, so the ONE place
    a shadow round has to be stopped.

    A dry run "builds context and produces a plan but executes nothing and
    writes nothing" (design spec §9.4), and the dream phase writes
    `personality.md` and publishes a snapshot, so a dry run skips it whole.
    The dream-phase nodes also check `dry_run` themselves; this edge is the
    cheap path, not the only defence.
    """
    if state.get("dry_run", False):
        return LOGOUT
    return DREAM if _grants_dream(state) else LOGOUT


def _continue_or_logout(next_node: str) -> _Router:
    """The act phase's two early exits (`login` offline, `plan` empty). Both
    ask the same question, so it is spelled once."""

    def route(state: CycleState) -> str:
        return next_node if _grants_dream(state) else LOGOUT

    return route


def _after_guardrail(state: CycleState) -> str:
    """§5.4's "(rhythm veto / empty)" edge.

    An empty survivor list routes AROUND `execute` -- an empty plan is an
    early return, and in a graph the equivalent is this edge. Entered anyway,
    `finalize_step` would turn the `VETOED_EMPTY` the guardrail node just
    decided into `LANDED_PARTIAL` and log Bash's FAIL line. A solo `nothing`
    is NOT this case: it is a surviving action and still executes.
    """
    if state.get("actions"):
        return EXECUTE
    return _dream_phase_or_logout(state)


def _act_after_guardrail(state: CycleState) -> str:
    """`ACT`'s copy of the edge above, with logout where the dream was: the
    act command never dreams, so an emptied plan ends the run."""
    return EXECUTE if state.get("actions") else LOGOUT


def _after_execute(config: CycleConfig) -> _Router:
    """Loop 3, resolved AFTER the behavior snapshot rather than straight off
    `execute`.

    `round_index` counts act rounds COMPLETED (the execute node increments
    it), so it doubles as the index of the deps the next round needs. The
    router hangs off `behavior_snapshot` because the sample is taken at
    the end of EACH act round -- putting it
    after this branch instead would sample only the last round of a loop-3
    configuration."""

    def route(state: CycleState) -> str:
        if state.get("round_index", 0) < config.max_rounds:
            return LOGIN
        return _dream_phase_or_logout(state)

    return route


def _after_dream(state: CycleState) -> str:
    """A cooldown SKIP, a failed reply and a blown deadline produce no list:
    there is nothing to write or snapshot, so they go straight to logout."""
    return WRITE if state.get("recent") is not None else LOGOUT


def _dream_after_dream(state: CycleState) -> str:
    """`DREAM`'s copy of the edge above: with no logout in the graph, a dream
    that produced no list ends the run."""
    return WRITE if state.get("recent") is not None else END


def _deps_of(runtime: Runtime[CycleContext], state: CycleState) -> CycleDeps:
    return runtime.context.deps_for_round(state.get("round_index", 0))


def _bind(factory: Callable[[CycleDeps], NodeFn]) -> _CycleNode:
    """Adapt a `make_*_node` factory to a node that resolves its deps at CALL
    time from the runtime context.

    Binding at assembly time instead would freeze one `CycleDeps` into the
    compiled graph, which is correct for a single-round cycle and silently
    wrong for loop 3 -- round 2 would plan against round 1's `memory_text`.
    """

    def node(state: CycleState, *, runtime: Runtime[CycleContext]) -> CycleState:
        return factory(_deps_of(runtime, state))(state)

    return node


def _execute_node(state: CycleState, *, runtime: Runtime[CycleContext]) -> CycleState:
    """`execute`, plus loop 3's counter.

    The increment lives here rather than in a router because a LangGraph
    conditional edge returns a destination and cannot write state, and rather
    than in `graph/nodes_act.py` because "how many rounds has this cycle run" is
    the graph's question, not the node's.
    """
    update = make_execute_node(_deps_of(runtime, state))(state)
    update["round_index"] = state.get("round_index", 0) + 1
    return update


def _act_logout_node(state: CycleState, *, runtime: Runtime[CycleContext]) -> CycleState:
    """`ACT`'s logout, handed a factory for the node-local dream lease.

    The lease is built lazily, inside the node, only when the round rotates:
    a dry or OFFLINE `act` never reaches the factory, so it never needs the
    lease database. Same tenant, account and `run_id` as the act lease the
    run already holds -- `kind` is part of the lease key, so the two rows
    never collide.
    """
    deps = _deps_of(runtime, state)
    context = runtime.context

    def rotation_lease() -> AbstractContextManager[object]:
        if context.lease_db is None:
            raise NodeStateError("the ACT logout node needs the run's lease database")
        return RunLease(
            context.lease_db,
            deps.agent_root,
            state.get("tenant", BUILTIN_TENANT),
            agent_dir_name(state["persona"]),
            "dream",
            run_id=state.get("run_id"),
            now=context.lease_clock,
        )

    return make_act_logout_node(deps, rotation_lease)(state)


def _new_graph() -> CycleGraph:
    return StateGraph(CycleState, context_schema=CycleContext)


def _build_cycle_graph(cfg: CycleConfig) -> CycleGraph:
    graph = _new_graph()

    graph.add_node(LOGIN, _bind(make_login_node), retry_policy=LOGIN_RETRY)
    graph.add_node(PLAN, _bind(make_plan_node), retry_policy=PLAN_RETRY)
    graph.add_node(GUARDRAIL, _bind(make_guardrail_node))
    graph.add_node(EXECUTE, _execute_node, retry_policy=EXECUTE_RETRY)
    graph.add_node(BEHAVIOR_SNAPSHOT, _bind(make_behavior_snapshot_node))
    graph.add_node(DREAM, _bind(make_dream_node), retry_policy=DREAM_RETRY)
    graph.add_node(WRITE, _bind(make_write_node))
    graph.add_node(SNAPSHOT, _bind(make_snapshot_node), retry_policy=SNAPSHOT_RETRY)
    graph.add_node(LOGOUT, _bind(make_logout_node))
    graph.add_node(POPULATION_METRIC, _bind(make_population_metric_node))

    graph.add_edge(START, LOGIN)
    graph.add_conditional_edges(LOGIN, _continue_or_logout(PLAN), [PLAN, LOGOUT])
    graph.add_conditional_edges(PLAN, _continue_or_logout(GUARDRAIL), [GUARDRAIL, LOGOUT])
    graph.add_conditional_edges(GUARDRAIL, _after_guardrail, [EXECUTE, DREAM, LOGOUT])
    graph.add_edge(EXECUTE, BEHAVIOR_SNAPSHOT)
    graph.add_conditional_edges(BEHAVIOR_SNAPSHOT, _after_execute(cfg), [LOGIN, DREAM, LOGOUT])
    graph.add_conditional_edges(DREAM, _after_dream, [WRITE, LOGOUT])
    graph.add_edge(WRITE, SNAPSHOT)
    graph.add_edge(SNAPSHOT, LOGOUT)
    graph.add_edge(LOGOUT, POPULATION_METRIC)
    graph.add_edge(POPULATION_METRIC, END)
    return graph


def _build_act_graph() -> CycleGraph:
    """S3 §12.5: the cycle's act half with the same routers where they apply,
    and every exit -- offline, dead backend, emptied plan, executed -- ending
    at logout."""
    graph = _new_graph()

    graph.add_node(LOGIN, _bind(make_login_node), retry_policy=LOGIN_RETRY)
    graph.add_node(PLAN, _bind(make_plan_node), retry_policy=PLAN_RETRY)
    graph.add_node(GUARDRAIL, _bind(make_guardrail_node))
    graph.add_node(EXECUTE, _execute_node, retry_policy=EXECUTE_RETRY)
    graph.add_node(LOGOUT, _act_logout_node)

    graph.add_edge(START, LOGIN)
    graph.add_conditional_edges(LOGIN, _continue_or_logout(PLAN), [PLAN, LOGOUT])
    graph.add_conditional_edges(PLAN, _continue_or_logout(GUARDRAIL), [GUARDRAIL, LOGOUT])
    graph.add_conditional_edges(GUARDRAIL, _act_after_guardrail, [EXECUTE, LOGOUT])
    graph.add_edge(EXECUTE, LOGOUT)
    graph.add_edge(LOGOUT, END)
    return graph


def _build_dream_graph() -> CycleGraph:
    """S3 §12.5: the cycle's dream half. A cooldown SKIP, a failed reply or a
    blown deadline ends the run at `dream`."""
    graph = _new_graph()

    graph.add_node(DREAM, _bind(make_dream_node), retry_policy=DREAM_RETRY)
    graph.add_node(WRITE, _bind(make_write_node))
    graph.add_node(SNAPSHOT, _bind(make_snapshot_node), retry_policy=SNAPSHOT_RETRY)

    graph.add_edge(START, DREAM)
    graph.add_conditional_edges(DREAM, _dream_after_dream, [WRITE, END])
    graph.add_edge(WRITE, SNAPSHOT)
    graph.add_edge(SNAPSHOT, END)
    return graph


def build_graph(phases: Phases, config: CycleConfig | None = None) -> CycleGraph:
    """Assemble one phase's graph. Takes no deps: they arrive per invocation
    through `CycleContext`, so the shape can be compiled and inspected
    without a roster (and `build_graph(...).compile()` is the test that a
    `timeout=` has not come back).

    The returned graph is UNcompiled, per the interface §5.4 specifies --
    `run_graph` compiles it with whatever checkpointer the caller supplies.
    `config` bounds loop 3, which only `CYCLE` has.
    """
    if phases is Phases.ACT:
        return _build_act_graph()
    if phases is Phases.DREAM:
        return _build_dream_graph()
    return _build_cycle_graph(config or CycleConfig())


def build_cycle(config: CycleConfig | None = None) -> CycleGraph:
    """`build_graph(Phases.CYCLE, config)` -- the name the cycle's tests and
    the dispatch test inspect."""
    return build_graph(Phases.CYCLE, config)


def run_cycle(
    *,
    persona: Persona,
    deps: CycleDeps | DepsProvider,
    lease_db: sqlite3.Connection,
    checkpointer: BaseCheckpointSaver[Any] | None = None,
    config: CycleConfig | None = None,
    tenant: str = BUILTIN_TENANT,
    round_id: str | None = None,
    run_id: str | None = None,
    resume: bool = False,
    lease_clock: Callable[[], float] = time.time,
) -> CycleState:
    """Run one full cycle for one account and return its final `CycleState`:
    `run_graph(deps, phases=Phases.CYCLE, ...)`, whose docstring carries the
    lease, round-id and resume contract.

    Holds BOTH of Bash's per-account locks (`lock_<name>` and
    `dream_lock_<name>`) for the whole run, beats them between nodes, and
    releases both however the cycle ends. A busy lease raises `LeaseBusy`
    before any node runs, with no LLM call spent; the caller SKIPs, as Bash
    does.
    """
    # Imported here rather than at the top: `graph/run.py` builds its graphs
    # from this module, so a module-level import would be circular.
    from swil_agent.graph.run import run_graph

    return run_graph(
        deps,
        phases=Phases.CYCLE,
        persona=persona,
        lease_db=lease_db,
        checkpointer=checkpointer,
        config=config,
        tenant=tenant,
        round_id=round_id,
        run_id=run_id,
        resume=resume,
        lease_clock=lease_clock,
    )
