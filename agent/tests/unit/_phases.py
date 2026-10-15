"""Drive the `ACT` and `DREAM` phase graphs the way the deleted `run_act` /
`run_dream` composers were driven (S3 Task 4).

`run_act` and `run_dream` were hand-written compositions of the act and dream
steps; S3 §4 deleted them, and the `act` / `dream` commands now run
`graph/run.py`'s `run_graph(..., phases=Phases.ACT | Phases.DREAM)`. The
behaviour tests that used to drive a composer keep their arguments and their
assertions and drive the phase graph through these two adapters instead -- so
what they pin is now what the commands execute.

Each adapter takes the composer's old keyword arguments, builds the
`CycleDeps` the matching `cli.py` deps builder would build (settings carried
on `Settings`, the unused dream collaborators as fakes), runs the graph over a
private in-memory lease database unless one is passed in, and projects the
result with `graph/outcome.py` -- the same projection the commands report.
"""

from __future__ import annotations

import contextlib
import random
import sqlite3
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from swil_agent.act.round import (
    DEFAULT_POST_CEILING_PER_DAY,
    DEFAULT_POST_DUPLICATE_THRESHOLD,
    DEFAULT_POST_DUPLICATE_WINDOW,
    DEFAULT_POST_PROBABILITY,
)
from swil_agent.config import Settings
from swil_agent.graph.cycle import Phases
from swil_agent.graph.deps import CycleDeps
from swil_agent.graph.outcome import act_result_of, dream_result_of
from swil_agent.graph.run import run_graph
from swil_agent.models import ActResult, DreamResult, Persona

from ._runners import FakePersonaSource, FakeState

# The dream's fixed instants when a caller passes none: an aware UTC moment
# for the snapshot, a naive local one for the archive stamp and the marker.
_CAPTURED_AT = datetime(2026, 8, 17, 2, 0, 0, tzinfo=UTC)


@contextlib.contextmanager
def _lease_db(given: sqlite3.Connection | None) -> Iterator[sqlite3.Connection]:
    """The caller's lease database, or a private in-memory one closed after
    the run (the caller owns, and closes, its own)."""
    if given is not None:
        yield given
        return
    with contextlib.closing(sqlite3.connect(":memory:")) as db:
        yield db


def run_act_phase(
    *,
    persona: Persona,
    resources: Any,
    backend: Any,
    memory_text: str,
    agent_root: Path,
    now: datetime,
    rng: random.Random,
    health_check: Callable[[], bool],
    budget: int = 5,
    context_now: str = "(no context file)",
    feed_context: str = "",
    dry_run: bool = False,
    access_key: str | None = None,
    embedder: Any = None,
    era_start: datetime | None = None,
    post_probability: int = DEFAULT_POST_PROBABILITY,
    post_ceiling: int = DEFAULT_POST_CEILING_PER_DAY,
    duplicate_window: int = DEFAULT_POST_DUPLICATE_WINDOW,
    duplicate_threshold: float = DEFAULT_POST_DUPLICATE_THRESHOLD,
    probe_board: str | None = None,
    round_id: str | None = None,
    lease_db: sqlite3.Connection | None = None,
) -> ActResult:
    """One `Phases.ACT` run with `run_act`'s old arguments; its `ActResult`.

    `embedder=None` disables the duplicate guard, as it did for `run_act`.
    `round_id=None` lets `run_graph` mint a manual id, so the similarity row
    and the post-vector ingest carry one (the graph always seeds a round id).
    """
    settings = Settings(
        agent_root=agent_root,
        era_start=era_start,
        post_probability=post_probability,
        post_ceiling_per_day=post_ceiling,
        post_duplicate_window=duplicate_window,
        post_duplicate_threshold=duplicate_threshold,
    )
    deps = CycleDeps(
        resources=resources,
        backend=backend,
        persona_source=FakePersonaSource(),
        embedder=embedder,
        dream_state=FakeState(),
        settings=settings,
        agent_root=agent_root,
        health_check=health_check,
        memory_text=memory_text,
        llm_backend=persona.backend,
        llm_model=persona.model,
        context_now=context_now,
        feed_context=feed_context,
        budget=budget,
        access_key=access_key,
        dry_run=dry_run,
        rng=rng,
        now=now,
        captured_at=_CAPTURED_AT,
        probe_board=probe_board,
    )
    with _lease_db(lease_db) as db:
        final = run_graph(deps, phases=Phases.ACT, persona=persona, lease_db=db, round_id=round_id)
    result = act_result_of(final)
    assert result is not None, "every ACT path decides an outcome"
    return result


def run_dream_phase(
    *,
    persona: Persona,
    persona_source: Any,
    resources: Any,
    backend: Any,
    embedder: Any,
    state: Any,
    settings: Settings,
    agent_root: Path,
    now: datetime,
    captured_at: datetime = _CAPTURED_AT,
    auto: bool = False,
    lease_db: sqlite3.Connection | None = None,
) -> DreamResult:
    """One `Phases.DREAM` run with `run_dream`'s old arguments; its
    `DreamResult`. Like `_dream_deps_for`, no world context and an empty
    `memory_text`: `cooldown_step` reads `memory.md` itself."""
    deps = CycleDeps(
        resources=resources,
        backend=backend,
        persona_source=persona_source,
        embedder=embedder,
        dream_state=state,
        settings=settings,
        agent_root=agent_root,
        health_check=lambda: True,
        memory_text="",
        llm_backend=persona.backend,
        llm_model=persona.model,
        auto=auto,
        now=now,
        captured_at=captured_at,
    )
    with _lease_db(lease_db) as db:
        final = run_graph(deps, phases=Phases.DREAM, persona=persona, lease_db=db)
    return dream_result_of(final)
