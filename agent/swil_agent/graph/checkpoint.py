"""SQLite checkpointer wiring: `CycleState` round-trips through LangGraph's
`SqliteSaver`, with every pydantic model reachable from it registered against
the msgpack serializer's allowlist.

Why registration is needed (measured behaviour, not speculation): a
`SqliteSaver` built with the library's own default serializer round-trips a
`CycleState` carrying a `Persona` today, but logs `Deserializing unregistered
type ... This will be blocked in a future version. Set
LANGGRAPH_STRICT_MSGPACK=true to block now, or add to allowed_msgpack_modules
to allow explicitly.` A pinned-version bump that flips that default to strict
would take resume out with no warning -- the whole point of persisting
`CycleState` is that a crashed cycle can restart from its last checkpoint,
and that path would go dark silently. Registering the types now, instead of
waiting for the upgrade to force the issue, is what this module does.

Where the DB file lives: `agent/.agent-state/`, the same directory Task 3's
`RunLease` / `FileLock` use for `lock_<name>` / `dream_lock_<name>` and that
`FilesystemDreamState` (`cli.py:382`) uses for its own state -- one directory
for every piece of "the Python runtime's local, per-account state" rather
than a new top-level directory per feature. `leases.py` itself takes a bare
`sqlite3.Connection` and does not choose a path (that call sits with a
future wiring task); the same is true here -- `open_checkpointer` takes a
full `db_path` rather than hardcoding one, so a caller is expected to pass
`settings.agent_root / ".agent-state" / CHECKPOINT_DB_NAME`, matching the
`FilesystemDreamState` pattern above. This module only owns the filename
(`CHECKPOINT_DB_NAME`), not the directory, so it stays trivially testable
against `tmp_path`.

The list of registered types is DERIVED from `CycleState`'s resolved type
hints, not hand-written: a hand-written list silently misses a field added
by a later task, and that is exactly the failure mode this module exists to
prevent. `typing.get_type_hints(CycleState)` is required rather than
`CycleState.__annotations__` -- with `from __future__ import annotations` in
`state.py`, `__annotations__` holds unresolved `ForwardRef`s
(`ForwardRef('Persona', module='swil_agent.graph.state')`), not classes.

Derivation walks two levels of nesting, not one: `CycleState`'s own fields
(`Persona`, `ActContext | None`, `Plan | None`, `list[VetoedAction]`,
`list[ActionResult]`, plus the plain-value fields) are unwrapped first, then
EVERY pydantic model found that way has its own resolved fields unwrapped
too, and so on until nothing new turns up. That second level is what finds `Action` -- it is not a
`CycleState` annotation itself, only reachable through `Plan.actions`,
`VetoedAction.action`, and `ActionResult.action`. A single-level unwrap over
`CycleState` alone would miss it silently;
`test_the_derived_registration_covers_every_model_reachable_from_cycle_state`
(in the test module) pins the full closure so that regression cannot land
quietly.

One measured wrinkle, not obvious from the interface: as of Task 4, `Action`
never independently reached the msgpack allowlist check at runtime. The
serializer's pydantic-v2 branch calls `obj.model_dump()` before encoding,
which flattens `Plan.actions` / `VetoedAction.action` / `ActionResult.action`
into plain dicts BEFORE the ext-hook ever asks "is this type registered?" --
reconstruction of the nested `Action` happens through `Plan(**kwargs)`'s own
pydantic validation, not a second allowlist check. Verified directly:
round-tripping a `Plan` and a `VetoedAction` through a `JsonPlusSerializer`
allowlisted for `Plan`/`VetoedAction` but explicitly NOT `Action` reconstructs
both correctly. Task 4 recorded that registering it anyway was still correct
because "`Action` ever becoming a direct `CycleState` field" would change
that -- and Task 7's `actions: list[Action]` (the post-guardrail survivors
the `guardrail` node hands the `execute` node) is exactly that field, so the
registration is now load-bearing rather than merely harmless.

The same trap with the opposite outcome, measured on 2026-08-18: an
UNREGISTERED type is not merely warned about when an explicit
`allowed_msgpack_modules` is passed -- it is *blocked on load* and comes back
degraded. A `CycleState` carrying `ActOutcome.LANDED_ALL` and a
`RhythmDecision` through an allowlist missing both deserialized to the plain
`str` `'landed_all'` and a plain `dict`, with only a WARNING log to say so.
`ActOutcome` is a `StrEnum`, so every `==` and `in` comparison against it
still held and no test would have gone red. Hence `_discover_registered_types`
collects enums as well as models: a resumed cycle must get its own types back,
not string-shaped lookalikes that happen to compare equal today.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from enum import Enum
from pathlib import Path
from typing import Any, Final, get_args, get_origin, get_type_hints

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.sqlite import SqliteSaver
from pydantic import BaseModel

from swil_agent.graph.state import SEPARATOR, CycleState

CHECKPOINT_DB_NAME: Final = "cycle_checkpoints.sqlite"
_THREAD_ID_PARTS: Final = 3

# The checkpointer's type, re-exported under a name of ours. `cli.py` is the
# composition root that holds one for the length of a cycle, and the AST
# architecture test (§5.2) forbids it -- or anything else outside `graph/` --
# from importing `langgraph` to say so. An alias here is what lets that rule
# stay absolute instead of gaining a "except for the type annotation"
# exception.
type Checkpointer = SqliteSaver


def _unwrap(hint: object) -> set[type]:
    """Recursively unwrap a type hint down to the bare classes inside it.

    Handles every generic shape `CycleState` and the models it carries
    actually use -- `X | None` (a `types.UnionType`), `list[X]` -- and
    anything else `typing.get_origin`/`get_args` can decompose, by recursing
    on each argument until an origin-less (bare) value is reached. A literal
    value (one arm of `Literal["post", ...]`, say) is not a class, so it is
    dropped rather than raising.
    """
    origin = get_origin(hint)
    if origin is None:
        return {hint} if isinstance(hint, type) else set()
    found: set[type] = set()
    for arg in get_args(hint):
        found |= _unwrap(arg)
    return found


def _discover_registered_types() -> frozenset[type[BaseModel] | type[Enum]]:
    """Every pydantic model AND enum reachable from `CycleState`, transitively.

    Level 1: unwrap each of `CycleState`'s own resolved type hints. Level 2+:
    for every pydantic model that surfaces, unwrap ITS OWN resolved type
    hints too, and repeat until nothing new is found. This is what makes
    `Action` reachable (see the module docstring) and what makes a field
    added by a later task impossible to silently miss: if it is annotated on
    `CycleState` -- directly, inside a generic, or nested inside a model
    already reachable from `CycleState` -- this function finds it.

    Enums are collected too (Task 7, measured). `CycleState.outcome` is a
    bare `ActOutcome`, and with an explicit `allowed_msgpack_modules` an
    unregistered type is not merely warned about -- it is BLOCKED on load
    and silently degrades: `ActOutcome.LANDED_ALL` came back as the plain
    `str` `'landed_all'`. `ActOutcome` is a `StrEnum`, so every comparison
    still happened to hold, which is precisely what makes the degradation
    worth registering away rather than living with -- the next enum field
    (or the first non-`StrEnum` one) would come back as an unusable string
    with nothing red. Only models are recursed INTO: an enum's own
    `get_type_hints` carries no field types to follow.
    """
    found: set[type[BaseModel] | type[Enum]] = set()
    queue: list[type] = []
    for hint in get_type_hints(CycleState).values():
        queue.extend(_unwrap(hint))
    while queue:
        candidate = queue.pop()
        if not (isinstance(candidate, type) and issubclass(candidate, (BaseModel, Enum))):
            continue
        if candidate in found:
            continue
        found.add(candidate)
        if issubclass(candidate, BaseModel):
            for hint in get_type_hints(candidate).values():
                queue.extend(_unwrap(hint))
    return frozenset(found)


REGISTERED_TYPES: Final[frozenset[type[BaseModel] | type[Enum]]] = _discover_registered_types()


@contextmanager
def checkpointer_at(db_path: Path) -> Iterator[Checkpointer]:
    """`open_checkpointer`, plus closing the connection it opened.

    `open_checkpointer` deliberately leaves the connection's lifetime to its
    caller (its own docstring), which is right for a test that wants to read
    the database back afterwards and wrong for a long-lived process that runs
    many cycles: `SqliteSaver` holds a `sqlite3.Connection` and nothing else
    ever closes it. This is the composition-root shape, so `cli.py` does not
    have to reach for `.conn` -- which would also mean importing `langgraph`
    outside `graph/`.
    """
    saver = open_checkpointer(db_path)
    try:
        yield saver
    finally:
        saver.conn.close()


def latest_round_id(saver: BaseCheckpointSaver[Any], tenant: str, agent: str) -> str | None:
    """The most recent checkpointed `round_id` for one account, or `None`.

    This is what `swil-agent cycle --resume` resolves: the thread id is the
    checkpoint's ONLY key, and a resuming process cannot rebuild it from
    `deps.now` because that is a different moment. Rather than persisting a
    "last round" marker of our own -- one more file under `.agent-state/`, one
    more thing that can be stale or orphaned -- the answer is read back out of
    the checkpoint database, which is the only place that can actually say
    whether there is anything to resume.

    Ordering is by `round_id` STRING comparison, and that is sound rather than
    lucky: `graph/cycle.py` formats it `%Y%m%dT%H%M%S`, a fixed-width
    zero-padded stamp whose lexicographic order IS its chronological order.
    Taking `max()` therefore does not depend on the saver's own `list()`
    ordering, which is not part of its documented interface.

    A malformed thread id (one that does not split into exactly three
    components) is skipped rather than raising: `thread_id()` refuses to BUILD
    one, so any such row was written by something else, and a foreign row in a
    shared database must not be able to break `--resume`.
    """
    rounds: list[str] = []
    for tup in saver.list(None):
        raw = tup.config.get("configurable", {}).get("thread_id")
        if not isinstance(raw, str):
            # UNTESTED and deliberately so: `RunnableConfig["configurable"]`
            # is `dict[str, Any]`, so a non-str `thread_id` is well-typed but
            # is not something `SqliteSaver` can produce -- every row it
            # yields was written from a string key. Reaching it through the
            # real saver would mean corrupting the database by hand, which
            # would test the fixture rather than the guard. Kept because the
            # alternative to skipping is a `TypeError` from `.split()` that
            # takes `--resume` down for one bad row in a shared database.
            continue
        parts = raw.split(SEPARATOR)
        if len(parts) != _THREAD_ID_PARTS:
            continue
        if parts[0] == tenant and parts[1] == agent:
            rounds.append(parts[2])
    return max(rounds) if rounds else None


def open_checkpointer(db_path: Path) -> SqliteSaver:
    """Open a `SqliteSaver` at `db_path`, with every `REGISTERED_TYPES` model
    allowlisted against the msgpack serializer.

    Passing `allowed_msgpack_modules=list(REGISTERED_TYPES)` explicitly --
    rather than leaving the serializer on its library default -- sidesteps
    the `LANGGRAPH_STRICT_MSGPACK` environment variable's sentinel branch
    entirely: an explicit allowlist behaves identically whether or not that
    variable is set, because it is only consulted when no
    `allowed_msgpack_modules` argument is supplied at all. That is the
    property `test_registration_is_strict_enough_to_survive_strict_msgpack`
    pins, and it is what makes this registration survive a future version
    that flips the *default* -- this module never relies on the default.

    The database file (and its parent directory) is created if it does not
    already exist. `SqliteSaver.setup()` is called immediately so the schema
    exists as soon as this function returns, rather than lazily on the first
    `get`/`put` call.

    Callers own the returned `SqliteSaver`'s connection lifetime -- this
    function does not wrap it in a context manager, matching the interface
    this task specifies (`open_checkpointer(db_path: Path) -> SqliteSaver`,
    not a context-manager factory).
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    serde = JsonPlusSerializer(allowed_msgpack_modules=list(REGISTERED_TYPES))
    saver = SqliteSaver(conn, serde=serde)
    saver.setup()
    return saver
