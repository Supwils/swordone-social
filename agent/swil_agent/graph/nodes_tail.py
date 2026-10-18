"""The cycle's tail nodes: the two samplers (`behavior_snapshot`,
`population_metric`), the cycle's `logout` with its cycle_run card, and
`ACT`'s own logout.

Logs under `swil_agent.graph.nodes` -- the name `cli/logs.py` routes to the
act log and every `caplog` filter is written against -- not this module's
`__name__`.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Callable, Iterator
from typing import Final

from swil_agent.act.round import rotate_memory_if_free, rotate_memory_soft
from swil_agent.analysis.behavior_snapshot import run_behavior_snapshot
from swil_agent.analysis.cycle_run import (
    MISSING_SAMPLER_BEHAVIOR,
    build_cycle_run_event,
    build_missing_sampler_event,
    grants_dream_for,
)
from swil_agent.analysis.population_metric import run_population_metric
from swil_agent.graph.deps import CycleDeps, NodeFn, agent_dir_name
from swil_agent.graph.state import CycleState
from swil_agent.models import ActOutcome

logger = logging.getLogger("swil_agent.graph.nodes")


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
        # `cli/errors.py`'s `skip_for_exception`: a stack trace in the act log
        # would read as a round failure to anyone grepping it for one.
        logger.debug("%s failed for %s", label, name, exc_info=exc)
        logger.warning(
            "%s: %s — sampling failed (%s: %s); the round is unaffected",
            label,
            name,
            type(exc).__name__,
            exc,
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
            deps.resources.lab_event(
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


def make_logout_node(deps: CycleDeps) -> NodeFn:
    """The cycle's terminal record.

    There is no session to tear down: §7.4 removed `.agent-state/active`
    (agent identity is a value in `CycleState`, which is what makes parallel
    runs safe by construction rather than by the `SWIL_AGENT` workaround),
    and the lease that holds the account's lock file wraps the WHOLE
    cycle -- releasing anything here would hand a live successor a lock it
    does not hold, which is the ABA hole `RunLease` closed one layer down.

    So what is left is §7.6's structured line: `run_id`, the account, the
    act outcome and what the dream did -- the only record that a cycle
    reached its end -- then the cycle_run card and memory rotation. Rotation
    runs here, under the cycle's lease, after the dream has read memory.md;
    a dry run does neither.
    """

    def logout(state: CycleState) -> CycleState:
        _log_logout(deps, state)
        if not deps.dry_run:
            _emit_cycle_run_card(deps, state)
            persona = state["persona"]
            rotate_memory_soft(persona.directory, agent_dir_name(persona))
        return {}

    return logout


def make_act_logout_node(
    deps: CycleDeps, rotation_lease: Callable[[], contextlib.AbstractContextManager[object]]
) -> NodeFn:
    """`ACT`'s terminal record (S3 §12.7): the logout line, NO cycle_run card
    (an act-only run is not a cycle), and memory rotation only for a round
    that reached the platform. `ACT` holds the act lease alone, so rotation
    runs under `rotation_lease()` -- the dream lease, non-blocking, taken here
    for the rotation alone; busy skips it (`rotate_memory_if_free`).
    """

    def logout(state: CycleState) -> CycleState:
        _log_logout(deps, state)
        if not deps.dry_run and state.get("outcome") is not ActOutcome.OFFLINE:
            persona = state["persona"]
            rotate_memory_if_free(persona.directory, agent_dir_name(persona), rotation_lease)
        return {}

    return logout


def _log_logout(deps: CycleDeps, state: CycleState) -> None:  # §7.6's structured line
    logger.info(
        "logout %s — run_id=%s outcome=%s dream_written=%s snapshot_ok=%s dry_run=%s",
        agent_dir_name(state["persona"]),
        state.get("run_id", ""),
        state.get("outcome"),
        state.get("written", False),
        state.get("snapshot_ok", False),
        deps.dry_run,
    )


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
        prompt_version=state.get("prompt_version") or deps.settings.prompt_version,
        act_prompt_chars=state.get("act_prompt_chars"),
        dream_prompt_chars=state.get("dream_prompt_chars"),
    )
    deps.resources.lab_event(persona.username, event)
