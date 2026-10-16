"""`CycleState` -- the value the graph threads through every node (spec §5.5)."""

from __future__ import annotations

from typing import Final, TypedDict

from swil_agent.models import (
    ActContext,
    Action,
    ActionResult,
    ActOutcome,
    Persona,
    Plan,
    RhythmDecision,
    VetoedAction,
)

BUILTIN_TENANT: Final = "builtin"

# Public because a thread id is PARSED as well as built: `--resume` reads the
# round id back out of one (`graph/checkpoint.py`'s `latest_round_id`). Two
# private copies of `":"` is exactly how the two halves drift apart.
SEPARATOR: Final = ":"


def thread_id(tenant: str, agent: str, round_id: str) -> str:
    """`f"{tenant}:{agent}:{round_id}"` -- the checkpoint namespace key.

    The tenant is encoded from day one so multi-tenancy is a value change
    rather than a data migration (spec §5.5). Each component is validated
    against the separator: the id is parsed by splitting on `":"`, so a
    component containing one would silently reassign the fields -- an agent
    named `"a:b"` would land in another tenant's checkpoint namespace.
    """
    for label, value in (("tenant", tenant), ("agent", agent), ("round_id", round_id)):
        if SEPARATOR in value:
            raise ValueError(f"{label} must not contain {SEPARATOR!r}: {value!r}")
    return SEPARATOR.join((tenant, agent, round_id))


class CycleState(TypedDict, total=False):
    """The value LangGraph threads through every node of the cycle graph.

    `total=False`: nodes return *partial* updates and LangGraph merges them
    into the running state. A `total=True` TypedDict would force every node
    to construct and return the whole state on every invocation.

    Spec §5.5 listed the identity/act/dream fields below the comment markers;
    the rest were added by Task 7, when the nodes that produce and consume
    them were written and it became measurable which values actually have to
    cross a node boundary. Each one names its producer and its consumer,
    because a field nothing produces is dead weight and a field nothing
    consumes is a value the graph silently drops:

      * `rhythm` -- `login` produces, `plan` and `guardrail` consume. Both
        steps take the whole `RhythmDecision` and pick their own field off it
        (`guidance` vs `policy`), so the decision must survive intact rather
        than being flattened to whichever string one caller needed.
      * `actions` -- `guardrail` produces (the POST-guardrail survivors),
        `execute` consumes and writes back what survived the duplicate guard
        (what actually executed). Kept separate from `plan`, which stays the
        model's ORIGINAL proposal: `ActResult` reports both, and overwriting
        `plan` with the survivors would make a vetoed round indistinguishable
        from one the model never proposed anything in -- the exact confusion
        §7.5 exists to end.
      * `solo_nothing` -- `guardrail` produces, `execute` consumes. A plan
        whose only surviving action is `nothing` still EXECUTES but is
        labelled `PLANNER_EMPTY`; re-deriving that in the execute node would
        put a second copy of `GuardrailStep`'s classification in the graph.
      * `attempted` / `landed` / `results` / `outcome` -- `execute` produces.
        These four are `ActResult`'s tally, and the final `CycleState` is what
        a caller reports the round from.
      * `proceeded` / `dream_reason` -- `dream` produces. `dream_reason`
        carries why a dream produced no list (cooldown SKIP, empty or
        unparseable reply, a refused write).
      * `recent` -- `dream` produces (the new, clamped 最近 list), `write`
        and `snapshot` consume. `None` means there is nothing to write.
      * `written` -- `write` produces, `snapshot` consumes: the snapshot is a
        claim about what `personality.md` now says, so it keys off the write
        actually happening.
      * `snapshot_ok` / `snapshot_reason` -- `snapshot` produces; the reason
        is the failure's own message, never a hardcoded guess.
      * `dry_run` -- `run_cycle` produces (seeded from the round-0 deps), the
        act phase's two exits into the dream consume. It is a STATE field and
        not only a `CycleDeps` one because the routers are the consumer and a
        LangGraph conditional edge sees the state, not the runtime context.
        Design spec §9.4: a shadow round "builds context and produces a plan
        but executes nothing and **writes nothing**" -- and the dream phase's
        `write_step` rewrites `personality.md` and `snapshot_step` publishes
        it, neither of which takes a `dry_run` parameter to be inert under.
        So a dry run does not dream at all: it would otherwise rewrite 23
        personalities and upload 23 snapshots during the round whose whole
        premise is that Python never wrote (standing constraint §9).
      * `missing_behavior_snapshot` -- the behavior_snapshot node produces
        True when the sampler raised or failed to produce a sample. `logout`
        copies it onto the cycle_run card.
        Unset is False: a path that never reached the sampler (offline, dead
        backend, empty-plan skipping behavior_snapshot) is not a missing
        sample, it is a round that was not supposed to sample.
      * `missing_post_vector` -- `execute` produces True when a post landed
        but its vector was not filed (S2 §4); `logout` copies it onto the
        cycle_run card. Unset is False, like `missing_behavior_snapshot`.
      * `round_id` -- `run_cycle` seeds it (the id the thread is keyed on;
        S2 §3, `round_id.py`). Every node may read it; Task 2 stamps it on
        lab events. It is STATE and not a `CycleDeps` field so a resumed
        thread carries the id it was checkpointed with, by construction.
      * `started_monotonic` -- `run_cycle` seeds it from `deps.monotonic()`
        before the first node. `logout` subtracts it to fill `durationMs`.

    Every type here must survive a checkpoint round-trip, which for
    `SqliteSaver` means being reachable from these annotations --
    `graph/checkpoint.py` derives its msgpack allowlist from them, so a model
    or enum added here is registered automatically and one that is not
    reachable comes back as a plain dict/str.
    """

    # identity
    tenant: str
    agent: str
    persona: Persona
    thread_id: str
    round_id: str
    run_id: str

    # act
    context: ActContext | None
    plan: Plan | None
    rhythm: RhythmDecision | None
    actions: list[Action]
    solo_nothing: bool
    vetoed: list[VetoedAction]
    results: list[ActionResult]
    attempted: int
    landed: int
    outcome: ActOutcome | None
    round_index: int
    dry_run: bool

    # dream
    proceeded: bool
    dream_reason: str
    recent: list[str] | None
    written: bool
    snapshot_ok: bool
    snapshot_reason: str | None

    # ledger
    missing_behavior_snapshot: bool
    missing_post_vector: bool
    started_monotonic: float
