"""Checkpoint wiring (task 4, spec §5.5): registered pydantic types survive a
`SqliteSaver` round trip, including under `LANGGRAPH_STRICT_MSGPACK`.

See `swil_agent/graph/checkpoint.py`'s module docstring for what "registered"
buys and one measured wrinkle (`Action`) it does not change -- that wrinkle
is why `_full_state` below carries every OTHER type directly as a field
value (never nested only inside another model), so any one of THOSE
registrations, removed, corrupts a distinct field this suite catches.
"""

from __future__ import annotations

import logging
from enum import Enum
from pathlib import Path
from typing import get_args, get_origin, get_type_hints

import pytest
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel

from swil_agent.graph.checkpoint import (
    CHECKPOINT_DB_NAME,
    REGISTERED_TYPES,
    latest_round_id,
    open_checkpointer,
    thread_exists,
)
from swil_agent.graph.state import CycleState
from swil_agent.models import (
    ActContext,
    Action,
    ActionResult,
    ActOutcome,
    CooldownDecision,
    Persona,
    Plan,
    RhythmDecision,
    RhythmPolicy,
    VetoedAction,
)

from ._runners import make_persona
from ._sqlite import open_saver


def _persona(tmp_path: Path) -> Persona:
    return make_persona(username="zenith", directory=tmp_path / "agents" / "zenith")


def _full_state(tmp_path: Path) -> CycleState:
    """One value for every field that is itself directly registered.

    `Action` joined that list in Task 7 (`actions`, the post-guardrail
    survivors the `guardrail` node hands the `execute` node) -- until then it
    was only ever reachable nested inside another model, which is the wrinkle
    the module docstring above records. A mutation dropping any ONE of these
    registrations corrupts a distinct field, and the per-field loop in the
    strict test below names which.
    """
    return {
        "tenant": "builtin",
        "agent": "zenith",
        "persona": _persona(tmp_path),
        "thread_id": "builtin:zenith:round-1",
        "context": ActContext(context_now="ctx", contacts=["a", "b"]),
        "plan": Plan(actions=[Action(kind="post", text="hello")]),
        "rhythm": RhythmDecision(
            policy=RhythmPolicy.NO_POST, prefer_non_post="yes", guidance="今天少发帖"
        ),
        "actions": [Action(kind="like", text=None, post_id="a" * 24)],
        "vetoed": [VetoedAction(action=Action(kind="comment", text="no"), reason="rhythm")],
        "results": [
            ActionResult(action=Action(kind="post", text="hi"), landed=True, resource_id="123")
        ],
        "outcome": ActOutcome.LANDED_ALL,
        "round_index": 1,
        "recent": ["一件新事", "另一件"],
    }


def _one_node_graph(saver: object) -> object:
    builder = StateGraph(CycleState)
    builder.add_node("noop", lambda state: {})
    builder.add_edge(START, "noop")
    builder.add_edge("noop", END)
    return builder.compile(checkpointer=saver)  # type: ignore[arg-type]


def test_a_state_carrying_a_persona_round_trips(tmp_path: Path) -> None:
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    graph = _one_node_graph(saver)
    persona = _persona(tmp_path)
    config = {"configurable": {"thread_id": "builtin:zenith:round-1"}}
    graph.invoke({"agent": "zenith", "persona": persona}, config)  # type: ignore[attr-defined]
    snapshot = graph.get_state(config)  # type: ignore[attr-defined]
    assert snapshot.values["persona"] == persona


def test_the_allowlist_is_explicit_and_closed(tmp_path: Path) -> None:
    """`open_checkpointer`'s `allowed_msgpack_modules` must be **droppable
    only by failing this test**, and the previous two attempts to say so both
    could not.

    History, because the shape matters more than the fix: this assertion was
    first written as `monkeypatch.setenv("LANGGRAPH_STRICT_MSGPACK", "true")`,
    which is inert -- the constant is read once at import. It was then
    "fixed" with `monkeypatch.setattr(lg_msgpack, "STRICT_MSGPACK_ENABLED",
    True)`, which is ALSO insufficient, for the same structural reason one
    level up: `BaseCheckpointSaver.serde` is an import-time CLASS ATTRIBUTE
    (`serde: SerializerProtocol = JsonPlusSerializer()`), so a naive
    `SqliteSaver(conn)` gets a serializer constructed long before any
    `setattr` lands, carrying the permissive `allowed_msgpack_modules=True`.
    Dropping our explicit allowlist entirely left the suite green.

    So this test asserts nothing about WHEN a constant is read. It asserts the
    OBSERVABLE consequence of the allowlist being explicit and closed: a type
    that is NOT on it is refused. Measured against langgraph 1.2.11:

      * explicit allowlist -> an unregistered model comes back as a plain
        `dict` (logged: "Blocked deserialization ... not in
        allowed_msgpack_modules");
      * the library default -> the same value comes back as the real model
        (logged: "Deserializing unregistered type ... will be blocked in a
        future version").

    `CooldownDecision` is the right probe precisely because it is NOT reachable
    from `CycleState` -- `test_the_derived_registration_covers_every_model_
    reachable_from_cycle_state` is what keeps that true, so the two tests
    fail together rather than drifting apart.
    """
    assert CooldownDecision not in REGISTERED_TYPES, (
        "CooldownDecision became reachable from CycleState; pick another "
        "unregistered probe, or this test proves nothing"
    )
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)

    payload = {"probe": CooldownDecision(proceed=True, reason="probe")}
    restored = saver.serde.loads_typed(saver.serde.dumps_typed(payload))

    assert type(restored["probe"]) is dict, (
        "the serializer accepted a type outside the allowlist -- "
        "`allowed_msgpack_modules` is not being passed explicitly"
    )


def test_every_registered_type_survives_the_round_trip_as_itself(tmp_path: Path) -> None:
    """The positive half, through the SAME serializer instance the saver
    actually holds. A checkpoint that comes back with the right values in the
    wrong types is the failure mode §15.1 row 16 records: `ActOutcome` is a
    `StrEnum`, so every `==` still held while the value was already a plain
    `str`.
    """
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    graph = _one_node_graph(saver)
    state = _full_state(tmp_path)
    config = {"configurable": {"thread_id": state["thread_id"]}}
    graph.invoke(state, config)  # type: ignore[attr-defined]
    snapshot = graph.get_state(config)  # type: ignore[attr-defined]
    for key, expected in state.items():
        assert snapshot.values[key] == expected, key
        assert type(snapshot.values[key]) is type(expected), key


def test_no_deprecation_warning_is_emitted(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The brief's own sketch names `recwarn`, pytest's `warnings.warn`
    capture fixture. Measured: the unregistered-type notice is emitted
    through `logging.Logger.warning` (`jsonplus.py`'s `_warn_once`), never
    `warnings.warn` -- `recwarn.list` stays empty even for a genuinely
    unregistered type, so it cannot fail for the reason this test names.
    `caplog` is the fixture that can actually observe the message.
    """
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    graph = _one_node_graph(saver)
    persona = _persona(tmp_path)
    config = {"configurable": {"thread_id": "builtin:zenith:round-1"}}
    with caplog.at_level(logging.WARNING):
        graph.invoke({"agent": "zenith", "persona": persona}, config)  # type: ignore[attr-defined]
        graph.get_state(config)  # type: ignore[attr-defined]
    assert not any("unregistered type" in record.message for record in caplog.records)


def _independent_walk(hints: object) -> set[type[BaseModel] | type[Enum]]:
    """A second, hand-written traversal of `CycleState`'s resolved type
    hints -- deliberately NOT a call to `checkpoint._discover_registered_
    types` -- so a bug in that function's own recursion (e.g. unwrapping only
    `CycleState`'s direct fields and never walking a found model's own
    fields, which is exactly what would silently drop `Action`) shows up as
    a mismatch here instead of trivially agreeing with itself.
    """
    found: set[type[BaseModel] | type[Enum]] = set()
    stack = list(hints)  # type: ignore[arg-type]
    while stack:
        hint = stack.pop()
        origin = get_origin(hint)
        if origin is not None:
            stack.extend(get_args(hint))
            continue
        if not isinstance(hint, type) or hint in found:
            continue
        if issubclass(hint, BaseModel):
            found.add(hint)
            stack.extend(get_type_hints(hint).values())
        elif issubclass(hint, Enum):
            found.add(hint)
    return found


def test_the_derived_registration_covers_every_model_reachable_from_cycle_state() -> None:
    expected = _independent_walk(get_type_hints(CycleState).values())
    assert expected == {
        Persona,
        ActContext,
        Plan,
        Action,
        VetoedAction,
        ActionResult,
        RhythmDecision,
        ActOutcome,
        RhythmPolicy,
    }
    assert expected == REGISTERED_TYPES


def test_an_enum_field_survives_as_its_enum_and_not_as_a_lookalike_string(
    tmp_path: Path,
) -> None:
    """`CycleState.outcome` is a bare `ActOutcome`, and an unregistered type
    is BLOCKED on load when an explicit allowlist is passed -- it comes back
    as the plain `str` the enum was encoded from.

    `ActOutcome` is a `StrEnum`, so `snapshot.values["outcome"] ==
    ActOutcome.LANDED_ALL` holds either way and the per-field loop in
    `test_registration_is_strict_enough_to_survive_strict_msgpack` cannot see
    the degradation. Only an identity/type assertion can. Mutation this
    kills: dropping the `Enum` arm from `_discover_registered_types`, which
    leaves every model field intact and this one field quietly string-shaped
    -- the shape a non-`StrEnum` field would arrive in as an outright bug.
    """
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    graph = _one_node_graph(saver)
    config = {"configurable": {"thread_id": "builtin:zenith:round-1"}}
    graph.invoke(  # type: ignore[attr-defined]
        {"agent": "zenith", "outcome": ActOutcome.LANDED_ALL}, config
    )
    snapshot = graph.get_state(config)  # type: ignore[attr-defined]

    assert isinstance(snapshot.values["outcome"], ActOutcome)
    assert type(snapshot.values["outcome"]) is not str


# ── latest_round_id: what `swil-agent cycle --resume` continues ────────────


def _checkpoint(saver: object, thread: str) -> None:
    graph = _one_node_graph(saver)
    graph.invoke({"agent": "zenith"}, {"configurable": {"thread_id": thread}})  # type: ignore[attr-defined]


def test_the_latest_round_is_the_most_recent_one_not_the_first(tmp_path: Path) -> None:
    """`--resume` continues the LAST cycle, and "last" is decided by string
    order over `%Y%m%dT%H%M%S` -- a fixed-width zero-padded stamp whose
    lexicographic order IS its chronological order, so `max()` does not depend
    on the saver's own `list()` ordering.

    Three rounds, inserted OUT of chronological order so a version that
    returned "the first row the saver yielded" is visible too. Resuming the
    oldest round would re-run a cycle that already finished -- re-posting
    whatever it landed -- while the interrupted one stays interrupted.
    """
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    for round_id in ("20260817T090000", "20260818T140000", "20260817T235959"):
        _checkpoint(saver, f"builtin:zenith:{round_id}")

    assert latest_round_id(saver, "builtin", "zenith") == "20260818T140000"


def test_the_latest_round_is_scoped_to_one_account_and_one_tenant(tmp_path: Path) -> None:
    """The thread id is `tenant:agent:round_id` and the database is SHARED by
    every account, so a lookup that ignored either component would resume one
    account's cycle under another's name -- with that account's persona
    already in the checkpoint, which is how a round posts as the wrong
    agent."""
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    _checkpoint(saver, "builtin:zenith:20260817T090000")
    _checkpoint(saver, "builtin:someone_else:20260818T140000")
    _checkpoint(saver, "acme:zenith:20260819T140000")

    assert latest_round_id(saver, "builtin", "zenith") == "20260817T090000"
    assert latest_round_id(saver, "acme", "zenith") == "20260819T140000"
    assert latest_round_id(saver, "builtin", "nobody") is None


def test_a_foreign_thread_id_cannot_break_the_lookup(tmp_path: Path) -> None:
    """`thread_id()` refuses to BUILD an id that does not split into exactly
    three components, so any such row was written by something else. A shared
    database must not let a foreign row turn `--resume` into a crash."""
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    _checkpoint(saver, "not-a-cycle-thread")
    _checkpoint(saver, "builtin:zenith:20260817T090000")

    assert latest_round_id(saver, "builtin", "zenith") == "20260817T090000"


def test_an_empty_database_has_no_round_to_resume(tmp_path: Path) -> None:
    """`None`, not an exception -- the CLI turns it into a SKIP naming the
    command that creates a checkpoint, where langgraph's own `EmptyInputError`
    would read as a bug."""
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    assert latest_round_id(saver, "builtin", "zenith") is None


def test_the_latest_round_is_the_newest_of_mixed_sweep_and_manual_ids(tmp_path: Path) -> None:
    """S2 ids lead with the UTC stamp, so `-r` and `-m` interleave in time
    order and the suffix never outranks the stamp."""
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    for round_id in ("20261014T091500Z-r", "20261016T080000Z-m", "20261015T120000Z-r"):
        _checkpoint(saver, f"builtin:zenith:{round_id}")

    assert latest_round_id(saver, "builtin", "zenith") == "20261016T080000Z-m"


def test_an_era_2_round_key_ranks_below_any_new_round_id(tmp_path: Path) -> None:
    """A dev checkpoint DB may still hold `%Y%m%dT%H%M%S` keys from before the
    S2 format. They must not crash the lookup, and a new-format id wins even
    against an old key with a later stamp."""
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    _checkpoint(saver, "builtin:zenith:20991231T235959")
    _checkpoint(saver, "builtin:zenith:20261014T091500Z-m")

    assert latest_round_id(saver, "builtin", "zenith") == "20261014T091500Z-m"


def test_thread_exists_is_true_only_for_a_checkpointed_thread(tmp_path: Path) -> None:
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    _checkpoint(saver, "builtin:zenith:20261014T091500Z-r")

    assert thread_exists(saver, "builtin:zenith:20261014T091500Z-r")
    assert not thread_exists(saver, "builtin:zenith:20261014T091500Z-m")
    assert not thread_exists(saver, "builtin:other:20261014T091500Z-r")


def test_thread_exists_without_a_checkpointer_is_false() -> None:
    """A dry run opens no checkpoint DB; "unavailable" reads as "no thread"."""
    assert not thread_exists(None, "builtin:zenith:20261014T091500Z-r")


def test_thread_exists_on_a_closed_database_is_false(tmp_path: Path) -> None:
    saver = open_saver(tmp_path / CHECKPOINT_DB_NAME)
    _checkpoint(saver, "builtin:zenith:20261014T091500Z-r")
    saver.conn.close()

    assert not thread_exists(saver, "builtin:zenith:20261014T091500Z-r")


@pytest.mark.filterwarnings("error::ResourceWarning")
@pytest.mark.filterwarnings("error::pytest.PytestUnraisableExceptionWarning")
def test_a_corrupt_database_closes_the_connection_it_opened(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`setup()` raises on a file that is not a database; the connection
    opened for it must be closed rather than left for the GC to warn about."""
    import gc
    import sqlite3
    import warnings

    from swil_agent.graph import checkpoint as checkpoint_module

    # Earlier tests' savers are not this test's subject: collect them first,
    # quietly, so the final `gc.collect()` can only report THIS test's leak.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ResourceWarning)
        gc.collect()

    opened: list[sqlite3.Connection] = []
    real_connect = sqlite3.connect

    def _recording_connect(*args: object, **kwargs: object) -> sqlite3.Connection:
        conn = real_connect(*args, **kwargs)  # type: ignore[arg-type]
        opened.append(conn)
        return conn

    monkeypatch.setattr(checkpoint_module.sqlite3, "connect", _recording_connect)
    db = tmp_path / "cycle_checkpoints.sqlite"
    db.write_bytes(b"not a database" * 100)

    with pytest.raises(sqlite3.DatabaseError):
        open_checkpointer(db)

    assert len(opened) == 1
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        opened[0].execute("SELECT 1")
    opened.clear()
    gc.collect()
