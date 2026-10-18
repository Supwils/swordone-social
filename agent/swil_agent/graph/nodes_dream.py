"""The dream phase's nodes: `dream` (cooldown + the one LLM call), `write`
and `snapshot`.

Each adapts `CycleState` to the `dream/round.py` steps it imports by name; a
test patches a step HERE, on the module whose node looks it up at call time.
"""

from __future__ import annotations

from typing import Final

from swil_agent.dream.round import cooldown_step, dream_step, snapshot_step, write_step
from swil_agent.graph.deps import CycleDeps, NodeFn
from swil_agent.graph.state import CycleState

# What a shadow round records instead of dreaming. `run_cycle` routes a dry
# cycle straight from the act phase to logout, so this reason is normally
# unreachable -- it exists so that a mis-drawn edge produces a legible
# "nothing happened" state rather than a real dream.
_DRY_RUN_REASON: Final = "dry run: the dream phase is skipped entirely"


def make_dream_node(deps: CycleDeps) -> NodeFn:
    """`cooldown_step` -> `dream_step`.

    One node because the cooldown must decide before the paid LLM call. The
    call is bounded where it can actually be killed -- the subprocess runner's
    per-call timeout -- not by a node-level deadline: the only thing that ran
    before it here is the cooldown's local file reads, so a deadline checked
    between the two bounded nothing.

    `dry_run` is checked here as well as on the edge that routes a shadow
    round to logout: `dream_step` posts a lab event and spends an LLM call.
    """

    def dream(state: CycleState) -> CycleState:
        if deps.dry_run:
            return {"proceeded": False, "dream_reason": _DRY_RUN_REASON}
        persona = state["persona"]
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

        dreamt = dream_step(
            persona=persona,
            resources=deps.resources,
            backend=deps.backend,
            memory_text=cooldown.memory_text,
            version=deps.settings.prompt_version,
        )
        chars: CycleState = (
            {"dream_prompt_chars": dreamt.prompt_chars} if dreamt.prompt_chars is not None else {}
        )
        if dreamt.failure_reason is not None:
            return {"proceeded": True, "dream_reason": dreamt.failure_reason, **chars}
        return {"proceeded": True, "recent": dreamt.recent, **chars}

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
