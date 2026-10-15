"""The dream phase's nodes: `dream` (cooldown + the one LLM call, under a
deadline), `write` and `snapshot`.

Each adapts `CycleState` to the `dream/round.py` steps it imports by name; a
test patches a step HERE, on the module whose node looks it up at call time.
"""

from __future__ import annotations

import logging
from typing import Final

from swil_agent.dream.round import cooldown_step, dream_step, snapshot_step, write_step
from swil_agent.graph.deps import CycleDeps, NodeFn, agent_dir_name
from swil_agent.graph.state import CycleState

# The dream node's own FAIL line is a DREAM-PHASE record and must land in
# `agent/logs/dream.log`, not the act log -- the two files are different
# destinations and the `cycle` command
# routes a record to one or the other by the LOGGER THAT EMITTED IT
# (`cli/logs.py`'s `_DREAM_LOG_SOURCES`). The node layer is the one place that emits
# both phases: the deadline FAIL below is the dream's, and the logout record
# (`graph/nodes_tail.py`) is the cycle's own terminal line, which belongs with the act log.
# A single module logger cannot
# express that, so the dream-phase one is named as a child -- inheriting
# `swil_agent.graph.nodes`' level and handlers, so `caplog.at_level(..., logger=
# "swil_agent.graph.nodes")` still sees it. Both names are spelled out rather than
# derived from `__name__`: they predate the S3 §9 split of `graph/nodes.py`, and
# `cli/logs.py` routes on them.
dream_logger = logging.getLogger("swil_agent.graph.nodes.dream")

_DEADLINE_REASON: Final = "dream deadline exceeded before the LLM call"

# What a shadow round records instead of dreaming. `run_cycle` routes a dry
# cycle straight from the act phase to logout, so this reason is normally
# unreachable -- it exists so that a mis-drawn edge produces a legible
# "nothing happened" state rather than a real dream.
_DRY_RUN_REASON: Final = "dry run: the dream phase is skipped entirely"


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
    `run_graph`'s lease for the whole run, which is what `write_recent`
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
