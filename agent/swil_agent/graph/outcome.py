"""What a finished phase graph reports: `ActResult` / `DreamResult` projected
from its final `CycleState` (S3 §4, §12.9; moved from the CLI).

One function each, so `act`, `dream` and `cycle` read their result off the
graph the same way, and `cli/report.py`'s renderers (`report_act_result`,
`report_dream_result`) stay the ONE place a result becomes a line.
"""

from __future__ import annotations

from swil_agent.graph.state import CycleState
from swil_agent.models import ActResult, DreamResult


def act_result_of(state: CycleState) -> ActResult | None:
    """Project the act half of a final `CycleState` back onto `ActResult`.

    Projected rather than re-formatted so `cycle` and `act` print the same
    line for the same round: `report_act_result` is the ONE renderer, and a
    second copy of that format is a second thing to keep in step with
    whatever a shadow-round comparison greps for.

    `None` when the run never reached an outcome at all -- a resumed thread
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
        handles=state.get("handles"),
        context=state.get("context"),
        rhythm=state.get("rhythm"),
        attempted=state.get("attempted", 0),
        landed=state.get("landed", 0),
    )


def dream_result_of(state: CycleState) -> DreamResult:
    """The dream half, same idea. `accepted` is `written` -- the flag that
    answers "did `personality.md` actually change".

    `reason` is the dream's own failure, or the write's refusal, or the
    cooldown's SKIP reason -- whichever produced no list. The `dream` command
    exits on `proceeded` alone, and prints `recent` only when `accepted`.
    """
    return DreamResult(
        proceeded=state.get("proceeded", False),
        accepted=state.get("written", False),
        reason=state.get("dream_reason", ""),
        recent=state.get("recent"),
        snapshot_ok=state.get("snapshot_ok", False),
        snapshot_reason=state.get("snapshot_reason"),
    )


def cycle_granted_dream(state: CycleState) -> bool:
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
