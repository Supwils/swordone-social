"""The cycle's nodes: `CycleState` in, a PARTIAL `CycleState` out.

The nodes live in three modules split by phase (S3 §9) -- `graph/nodes_act.py`
(login, plan, guardrail, execute), `graph/nodes_dream.py` (dream, write,
snapshot) and `graph/nodes_tail.py` (the samplers, both logouts and the
cycle_run card). This module holds what they share: `CycleDeps`, `NodeFn`,
`NodeStateError`, `agent_dir_name` and `_require`. Each node module imports
the steps it calls by name, so a test patches a step on the module whose node
calls it.

Each node adapts the graph's single threaded value to the step functions
`act/round.py` and `dream/round.py` already expose, and does nothing else
(ruling R4): every decision lives in a step, so every phase graph -- `act`,
`dream`, `cycle` (S3 §4) -- runs ONE implementation of it, and the steps'
own tests cover the paths no graph test reaches.

**Dependencies do not live in `CycleState`.** The state is CHECKPOINTED --
msgpack, SQLite -- so it carries only values that can survive a process
restart: the persona, the plan, the new 最近 list. An `httpx` client, a subprocess
runner and a live `sqlite3.Connection` cannot. So the collaborators arrive
through `CycleDeps`, bound into each node by a factory (`make_login_node`
and friends) at graph-assembly time, and the node itself keeps the plain
`(state) -> partial` shape LangGraph wants.

**Node -> step map.** Three nodes call more than one step, and each grouping
is a behavioural constraint rather than a tidying:

  * `login` -> `login_step`, `sync_backend_step`, `context_step`. Order:
    probe, then the `agentBackend` PATCH (after login and before any
    context is built), then the read-side assembly. Putting the sync in any later node drops it
    entirely on every early-return path -- measured in Task 5's review, with the whole suite
    green, on the field that is the drift experiment's independent variable.
  * `plan` -> `plan_step`.
  * `guardrail` -> `guardrail_step`. PURE -- no I/O at all, which is why
    §5.4 gives it no retry policy.
  * `execute` -> `execute_step`, `finalize_step`. §5.4's topology has no
    `finalize` node, and the smart mark-read is gated on `landed > 0` from
    the tally `execute_step` has just produced.
  * `behavior_snapshot` -> `analysis.run_behavior_snapshot`. An observability
    sampler, not a step -- `analysis/` is a peer of `act/` and `dream/` --
    and its failure is SWALLOWED rather than surfaced.
  * `dream` -> `cooldown_step`, `dream_step`. The cooldown decides before the
    one paid LLM call.
  * `write` -> `write_step`; `snapshot` -> `snapshot_step`.
  * `logout` -> the terminal record, the cycle_run card and memory
    rotation (`memory_rotation.rotate_memory`); `ACT`'s logout has no card.

**Where the guards are, and why none of them are here.** `dry_run` is
threaded into `sync_backend_step`, `execute_step` and `finalize_step`;
`recent` into `write_step`; `written` into `snapshot_step`. Every one of
those steps guards INTERNALLY, so a mis-wired edge writes nothing rather
than writing the wrong thing.

**No node-level deadline.** LangGraph refuses `timeout=` on a sync node at
`compile()` time, and the async form returns control while ORPHANING the
subprocess (both measured; spec §5.4 as corrected). Every call that can hang
is bounded where it can be killed instead: the subprocess runner's per-call
timeout (`llm/runner.py`, 600s on grok) and the HTTP clients' own timeouts.
The whole cycle is bounded by the round's per-account timeout
(`opportunistic-round.sh` ACCOUNT_TIMEOUT).
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from swil_agent.api.resources import Resources
from swil_agent.config import Settings
from swil_agent.dream.candidate import DreamState
from swil_agent.dream.round import Embedder
from swil_agent.graph.state import CycleState
from swil_agent.llm.protocol import Backend
from swil_agent.models import Persona
from swil_agent.persona.source import PersonaSource

NodeFn = Callable[[CycleState], CycleState]


class NodeStateError(RuntimeError):
    """A node was entered without a value an earlier node was supposed to
    have produced -- i.e. the graph is mis-wired.

    Loud on purpose: the silent alternative looks like a normal quiet round,
    e.g. planning against a blank `ActContext()` (no feed, no notifications,
    no memory).
    """


def agent_dir_name(persona: Persona) -> str:
    """The account's identity everywhere in this runtime: the persona
    DIRECTORY name, never the frontmatter `username`.

    Lock files (`.agent-state/lock_<name>`), leases and log lines all key on
    it. The two can diverge, and the failure is silent in both directions --
    a lease keyed on the username locks a path nobody else looks at.
    """
    return persona.directory.name


@dataclass(frozen=True)
class CycleDeps:
    """Everything a node needs that `CycleState` cannot carry.

    Frozen and built ONCE per run by the composition root (`cli/compose.py`, one
    builder per phase): the clients, the frozen `now`, the `context_now` /
    `feed_context` / `memory_text` strings read before the round starts.

    Two consequences of "once per cycle" that Task 8 owns rather than this
    module:

      * `now` / `captured_at` are frozen for the whole cycle, where the CLI
        takes a fresh `datetime.now()` for its act command and another for
        its dream command. Within one cycle that is a difference of minutes
        in an archive stamp.
      * `memory_text`, `context_now` and `feed_context` are snapshots, taken
        by the builder's `finish` after the leases are held. A run has one
        act round, which is what makes one snapshot sound.

    `llm_backend` / `llm_model` are the resolved values `backend` was built
    from (`llm/selection.py`: flag > frontmatter > env > default), which the
    cycle_run card reports. Required, so a composition root cannot fall back
    to the persona file's declaration by forgetting them. `probe_board` is
    `act --dry-run --probe-board`'s overlay board (S3 §12.8); `None` otherwise.
    """

    resources: Resources
    backend: Backend
    persona_source: PersonaSource
    embedder: Embedder
    dream_state: DreamState
    settings: Settings
    agent_root: Path
    health_check: Callable[[], bool]
    memory_text: str
    llm_backend: str
    llm_model: str | None
    context_now: str = "(no context file)"
    feed_context: str = ""
    budget: int = 5
    access_key: str | None = None
    dry_run: bool = False
    auto: bool = False
    rng: random.Random = field(default_factory=random.Random)
    now: datetime = field(default_factory=datetime.now)
    captured_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    monotonic: Callable[[], float] = time.monotonic
    probe_board: str | None = None


# Completes a run's `CycleDeps` AFTER its leases are held (`run_graph`'s
# `finish_deps`): the memory read, the world context and the feed.
FinishDeps = Callable[[CycleDeps], CycleDeps]


def _require[T](value: T | None, *, key: str, node: str) -> T:
    if value is None:
        raise NodeStateError(f"the {node} node was entered without {key!r} in CycleState")
    return value
