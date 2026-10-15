"""The three phase graphs -- `Phases.CYCLE`, `ACT`, `DREAM` -- and the one
runner they share (S3 Task 4: spec §4, §5 as amended by §12.4-§12.11).

`act` and `dream` used to be hand-written compositions (`run_act`,
`run_dream`) with their own lock layer. They now run separate graphs built
from the cycle's own node factories, under `graph/run.py`'s leases. This file
pins what that change must and must not do:

  * `CYCLE` is node-for-node, edge-for-edge and policy-for-policy the graph
    S3 started from (its goldens are immutable);
  * the two subset topologies, their lease kinds, and that they are never
    checkpointed;
  * `ACT`'s logout: no cycle_run card, rotation only when not OFFLINE, under a
    node-local non-blocking dream lease;
  * the per-phase deps (`ACT` never probes the embedder; `DREAM` reads no
    feed, runs no news fetch and probes before selecting a backend);
  * Review Focus 1-3: a manual `act` beside a running cycle, `dream`'s
    `--auto` contract, and an unparseable dream.
"""

from __future__ import annotations

import contextlib
import logging
import os
import random
import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from swil_agent import cli
from swil_agent.cli import compose
from swil_agent.cli import run as cli_run
from swil_agent.config import Settings
from swil_agent.graph import nodes_act
from swil_agent.graph.checkpoint import CHECKPOINT_DB_NAME, checkpointer_at
from swil_agent.graph.cycle import (
    BEHAVIOR_SNAPSHOT,
    DREAM,
    EXECUTE,
    GUARDRAIL,
    LOGIN,
    LOGOUT,
    PLAN,
    POPULATION_METRIC,
    SNAPSHOT,
    WRITE,
    CycleContext,
    Phases,
    build_graph,
)
from swil_agent.graph.deps import CycleDeps, NodeStateError
from swil_agent.graph.outcome import act_result_of, cycle_granted_dream, dream_result_of
from swil_agent.graph.run import lease_kinds, run_graph
from swil_agent.locks.file import act_lock_path, dream_lock_path
from swil_agent.locks.lease import LEASE_DB_NAME, RunLease, open_lease_db
from swil_agent.models import ActOutcome, Persona
from swil_agent.persona.source import GitPersonaSource

from ._golden_seams import DREAM_REPLY, _FakeEmbedderClient, _FakeGuard, _patch_cycle_seams
from ._phases import run_act_phase, run_dream_phase
from ._runners import (
    FakeEmbedder,
    FakePersonaSource,
    FakeResources,
    FakeState,
    RecordingRunner,
    ScriptedBackend,
    StubBackend,
    make_persona,
)

runner = CliRunner()

NOW = datetime(2026, 10, 14, 20, 0, 0)
_ERA_START = datetime(2000, 1, 1, tzinfo=UTC)
_POST_PLAN = '{"plan":[{"action":"post","text":"hello from zenith"}]}'
_NOTHING_PLAN = '{"plan":[{"action":"nothing"}]}'
_BAD_DREAM_REPLY = "我今天什么也不想写。"
_INITIAL_MEMORY = "2026-08-01 | act | did a thing\n"

_PERSONALITY = """---
username: zenith
display_name: 测试
bio: 一句话简介
model: claude:opus
board: ai
topics: [alpha, beta]
era: 3
---
# 测试用人格

一个测试用的账号。

## 最近
- 一件旧事
"""


@pytest.fixture
def lease_db() -> Iterator[sqlite3.Connection]:
    with contextlib.closing(sqlite3.connect(":memory:")) as db:
        yield db


def _persona(root: Path, *, dir_name: str = "zenith") -> Persona:
    directory = root / "agents" / dir_name
    directory.mkdir(parents=True, exist_ok=True)
    return make_persona(username="zenith", directory=directory, prompt="PERSONA")


def _long_memory(persona: Persona, count: int = 350) -> None:
    lines = [f"2026-08-16 | old {i}" for i in range(count)]
    (persona.directory / "memory.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _memory_lines(persona: Persona) -> int:
    return len((persona.directory / "memory.md").read_text(encoding="utf-8").splitlines())


def _act(root: Path, persona: Persona, **kwargs: Any) -> Any:
    defaults: dict[str, Any] = {
        "persona": persona,
        "resources": FakeResources(),
        "backend": StubBackend(_NOTHING_PLAN),
        "memory_text": "",
        "agent_root": root,
        "now": NOW,
        "rng": random.Random(0),
        "health_check": lambda: True,
    }
    defaults.update(kwargs)
    return run_act_phase(**defaults)


def _edges(phases: Phases) -> set[tuple[str, str, bool]]:
    drawn = build_graph(phases).compile().get_graph()
    return {(edge.source, edge.target, edge.conditional) for edge in drawn.edges}


def _nodes(phases: Phases) -> set[str]:
    return {node.id for node in build_graph(phases).compile().get_graph().nodes.values()}


# ── topology (§12.4, §12.5) ──────────────────────────────────────────────────


def test_the_cycle_graph_is_the_pre_s3_graph_node_edge_and_policy_for_policy() -> None:
    """Recorded off `build_cycle()` before Task 4 touched it. `CycleState`
    gained no key and `CYCLE` gained no phase-conditional router: the subset
    graphs are separate graphs, so a checkpoint written before S3 still
    resumes into the same topology."""
    assert _nodes(Phases.CYCLE) == {
        "__start__",
        "__end__",
        LOGIN,
        PLAN,
        GUARDRAIL,
        EXECUTE,
        BEHAVIOR_SNAPSHOT,
        DREAM,
        WRITE,
        SNAPSHOT,
        LOGOUT,
        POPULATION_METRIC,
    }
    assert _edges(Phases.CYCLE) == {
        ("__start__", "login", False),
        ("behavior_snapshot", "dream", True),
        ("behavior_snapshot", "login", True),
        ("behavior_snapshot", "logout", True),
        ("dream", "logout", True),
        ("dream", "write", True),
        ("execute", "behavior_snapshot", False),
        ("guardrail", "dream", True),
        ("guardrail", "execute", True),
        ("guardrail", "logout", True),
        ("login", "logout", True),
        ("login", "plan", True),
        ("logout", "population_metric", False),
        ("plan", "guardrail", True),
        ("plan", "logout", True),
        ("population_metric", "__end__", False),
        ("snapshot", "logout", False),
        ("write", "snapshot", False),
    }
    policies = {
        name: None if spec.retry_policy is None else spec.retry_policy.max_attempts
        for name, spec in build_graph(Phases.CYCLE).nodes.items()
    }
    assert policies == {
        LOGIN: 2,
        PLAN: 1,
        GUARDRAIL: None,
        EXECUTE: 2,
        BEHAVIOR_SNAPSHOT: None,
        DREAM: 1,
        WRITE: None,
        SNAPSHOT: 2,
        LOGOUT: None,
        POPULATION_METRIC: None,
    }


def test_the_act_graph_ends_every_path_at_logout() -> None:
    assert _nodes(Phases.ACT) == {"__start__", "__end__", LOGIN, PLAN, GUARDRAIL, EXECUTE, LOGOUT}
    assert _edges(Phases.ACT) == {
        ("__start__", "login", False),
        ("login", "plan", True),
        ("login", "logout", True),
        ("plan", "guardrail", True),
        ("plan", "logout", True),
        ("guardrail", "execute", True),
        ("guardrail", "logout", True),
        ("execute", "logout", False),
        ("logout", "__end__", False),
    }


def test_the_dream_graph_ends_a_no_list_dream_at_once() -> None:
    assert _nodes(Phases.DREAM) == {"__start__", "__end__", DREAM, WRITE, SNAPSHOT}
    assert _edges(Phases.DREAM) == {
        ("__start__", "dream", False),
        ("dream", "write", True),
        ("dream", "__end__", True),
        ("write", "snapshot", False),
        ("snapshot", "__end__", False),
    }


def test_every_phase_attaches_the_cycles_retry_policy_to_the_same_node() -> None:
    """§12.2(e): the retry policies now apply to subsets too."""
    cycle_nodes = build_graph(Phases.CYCLE).nodes
    for phases in (Phases.ACT, Phases.DREAM):
        for name, spec in build_graph(phases).nodes.items():
            assert spec.retry_policy == cycle_nodes[name].retry_policy, (phases, name)


def test_lease_kinds_per_phase() -> None:
    """§12.10: ACT holds the act lease alone; its logout takes the dream lease
    for rotation only."""
    assert lease_kinds(Phases.CYCLE) == ("act", "dream")
    assert lease_kinds(Phases.ACT) == ("act",)
    assert lease_kinds(Phases.DREAM) == ("dream",)


# ── ACT's logout (§12.7) ─────────────────────────────────────────────────────


def test_an_act_run_files_no_cycle_run_card_and_logs_the_logout_line(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    persona = _persona(tmp_path)
    resources = FakeResources()

    with caplog.at_level(logging.INFO, logger="swil_agent.graph.nodes"):
        result = _act(tmp_path, persona, resources=resources, backend=StubBackend(_POST_PLAN))

    assert result.outcome is ActOutcome.LANDED_ALL
    assert not [e for e in resources.lab_events if (e.metrics or {}).get("kind") == "cycle_run"]
    logout = [r for r in caplog.records if r.getMessage().startswith("logout zenith — ")]
    assert len(logout) == 1
    assert logout[0].name == "swil_agent.graph.nodes"
    assert "outcome=landed_all dream_written=False" in logout[0].getMessage()


def test_an_offline_act_never_rotates_memory(tmp_path: Path) -> None:
    persona = _persona(tmp_path)
    _long_memory(persona)

    result = _act(tmp_path, persona, health_check=lambda: False)

    assert result.outcome is ActOutcome.OFFLINE
    assert _memory_lines(persona) == 350
    assert not (persona.directory / "memory.archive.md").exists()


def test_an_act_rotates_under_its_act_lease_and_a_node_local_dream_lease(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, lease_db: sqlite3.Connection
) -> None:
    """While `rotate_memory` runs, BOTH lock files exist and BOTH lease rows
    are held under the run's id; after the run, neither is left behind."""
    import swil_agent.act.round as act_round

    persona = _persona(tmp_path)
    _long_memory(persona, 301)
    db = lease_db
    seen: list[tuple[bool, bool, list[str]]] = []
    real = act_round.rotate_memory

    def spy(path: Path) -> int:
        seen.append(
            (
                act_lock_path(tmp_path, "zenith").exists(),
                dream_lock_path(tmp_path, "zenith").exists(),
                sorted(row[0] for row in db.execute("SELECT kind FROM run_leases")),
            )
        )
        return real(path)

    monkeypatch.setattr(act_round, "rotate_memory", spy)
    _act(tmp_path, persona, lease_db=db)

    assert seen == [(True, True, ["act", "dream"])]
    assert (persona.directory / "memory.archive.md").exists()
    assert not act_lock_path(tmp_path, "zenith").exists()
    assert not dream_lock_path(tmp_path, "zenith").exists()
    assert list(db.execute("SELECT kind FROM run_leases")) == []


def test_a_held_dream_lease_skips_the_rotation_with_the_info_line_and_the_act_succeeds(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, lease_db: sqlite3.Connection
) -> None:
    """Non-blocking: a standalone dream holding `dream_lock_<name>` costs the
    act its rotation, never the round -- and never a wait."""
    persona = _persona(tmp_path)
    _long_memory(persona)
    db = lease_db

    with (
        RunLease(db, tmp_path, "builtin", "zenith", "dream", run_id="a-dream"),
        caplog.at_level(logging.INFO, logger="swil_agent.act.round"),
    ):
        result = _act(tmp_path, persona, lease_db=db)

    assert result.outcome is ActOutcome.PLANNER_EMPTY
    assert _memory_lines(persona) == 350
    skipped = [r for r in caplog.records if "rotation skipped" in r.getMessage()]
    assert [(r.name, r.levelno, r.getMessage()) for r in skipped] == [
        (
            "swil_agent.act.round",
            logging.INFO,
            "memory rotation skipped for zenith — dream lock held",
        )
    ]


def test_a_lease_db_error_on_the_rotation_lease_warns_and_the_act_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    lease_db: sqlite3.Connection,
) -> None:
    """The node-local dream lease meets a lease database that fails
    (`database is locked` past the busy timeout): rotation is skipped with a
    WARN, the act keeps its outcome, and the act lease is still released."""
    from swil_agent.graph import cycle as cycle_module

    real_lease = cycle_module.RunLease

    class _LockedDb:
        def __enter__(self) -> None:
            raise sqlite3.OperationalError("database is locked")

        def __exit__(self, *exc: object) -> None:
            return None

    def lease(*args: Any, **kwargs: Any) -> Any:
        return _LockedDb() if args[4] == "dream" else real_lease(*args, **kwargs)

    monkeypatch.setattr(cycle_module, "RunLease", lease)
    persona = _persona(tmp_path)
    _long_memory(persona)

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        result = _act(tmp_path, persona, lease_db=lease_db)

    assert result.outcome is ActOutcome.PLANNER_EMPTY
    assert _memory_lines(persona) == 350
    warned = [r for r in caplog.records if "rotation skipped" in r.getMessage()]
    assert [(r.name, r.levelno) for r in warned] == [("swil_agent.act.round", logging.WARNING)]
    assert "lease db error (database is locked)" in warned[0].getMessage()
    assert not act_lock_path(tmp_path, "zenith").exists()
    assert list(lease_db.execute("SELECT kind FROM run_leases")) == []


def test_the_probe_board_reaches_context_step_in_act(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§12.8: `probe_board` rides on `CycleDeps` and the login node hands it
    to `context_step`; the overlay reads that board."""
    seen: list[str | None] = []
    real = nodes_act.context_step

    def spy(**kwargs: Any) -> Any:
        seen.append(kwargs.get("probe_board"))
        return real(**kwargs)

    monkeypatch.setattr(nodes_act, "context_step", spy)
    resources = FakeResources()
    _act(tmp_path, _persona(tmp_path), resources=resources, dry_run=True, probe_board="probes")

    assert seen == ["probes"]
    assert ("probes", 10, "latest") in resources.feed_board_calls


def test_a_real_act_run_refuses_a_probe_board(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="--probe-board requires --dry-run"):
        _act(tmp_path, _persona(tmp_path), probe_board="probes")
    assert not act_lock_path(tmp_path, "zenith").exists()


# ── DREAM ────────────────────────────────────────────────────────────────────


def _dream_root(tmp_path: Path) -> Path:
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(_PERSONALITY, encoding="utf-8")
    (directory / "memory.md").write_text(_INITIAL_MEMORY, encoding="utf-8")
    return tmp_path


def _dream(root: Path, *, auto: bool, state: FakeState, backend: Any) -> Any:
    source = GitPersonaSource(root)
    return run_dream_phase(
        persona=source.load("zenith"),
        persona_source=source,
        resources=FakeResources(),
        backend=backend,
        embedder=FakeEmbedder(),
        state=state,
        settings=Settings(agent_root=root),
        agent_root=root,
        now=NOW,
        auto=auto,
    )


def test_a_dream_run_with_auto_honours_the_cooldown_and_spends_no_call(tmp_path: Path) -> None:
    root = _dream_root(tmp_path)
    state = FakeState()
    state.set_last_dream(hours_ago=1)
    backend = ScriptedBackend(DREAM_REPLY)

    result = _dream(root, auto=True, state=state, backend=backend)

    assert result.proceeded is False
    assert "cooldown" in result.reason
    assert backend.calls == []


def test_a_dream_run_without_auto_ignores_the_cooldown(tmp_path: Path) -> None:
    root = _dream_root(tmp_path)
    state = FakeState()
    state.set_last_dream(hours_ago=1)

    result = _dream(root, auto=False, state=state, backend=ScriptedBackend(DREAM_REPLY))

    assert result.proceeded is True
    assert result.accepted is True


# ── never checkpointed (§4) ──────────────────────────────────────────────────


@pytest.mark.parametrize("phases", [Phases.ACT, Phases.DREAM])
def test_a_subset_run_refuses_a_checkpointer_and_resume(
    tmp_path: Path, phases: Phases, lease_db: sqlite3.Connection
) -> None:
    persona = _persona(tmp_path)
    deps = CycleDeps(
        resources=FakeResources(),
        backend=StubBackend(_NOTHING_PLAN),
        persona_source=FakePersonaSource(),
        embedder=FakeEmbedder(),
        dream_state=FakeState(),
        settings=Settings(agent_root=tmp_path),
        agent_root=tmp_path,
        health_check=lambda: True,
        memory_text="",
        llm_backend="claude",
        llm_model=None,
    )
    db = lease_db
    with checkpointer_at(tmp_path / "ckpt.sqlite") as saver:
        with pytest.raises(ValueError, match="not checkpointed"):
            run_graph(deps, phases=phases, persona=persona, lease_db=db, checkpointer=saver)
        rows = saver.conn.execute("SELECT COUNT(*) FROM checkpoints").fetchone()
    with pytest.raises(ValueError, match="not checkpointed"):
        run_graph(deps, phases=phases, persona=persona, lease_db=db, resume=True)
    assert rows == (0,)
    assert not act_lock_path(tmp_path, "zenith").exists()


# ── the commands ─────────────────────────────────────────────────────────────


@pytest.fixture
def cli_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(_PERSONALITY, encoding="utf-8")
    (directory / "memory.md").write_text(_INITIAL_MEMORY, encoding="utf-8")
    monkeypatch.delenv("SWIL_ROUND_ID", raising=False)
    monkeypatch.delenv("SWIL_REQUIRE_NON_PROD", raising=False)
    settings = Settings(
        agent_root=tmp_path, era_start=_ERA_START, post_probability=100, post_ceiling_per_day=10
    )
    _patch_cycle_seams(monkeypatch, tmp_path, settings=settings)
    return tmp_path


def _state_files(root: Path) -> set[str]:
    state = root / ".agent-state"
    return {p.name for p in state.iterdir()} if state.is_dir() else set()


def _memory(root: Path) -> str:
    return (root / "agents" / "zenith" / "memory.md").read_text(encoding="utf-8")


def test_a_manual_act_beside_a_running_cycle_skips_75_before_any_read(
    cli_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review Focus 1. A sweep's `cycle` of the same account holds both of
    its leases (this process stands in for it, so its pid is alive). The
    manual `act` SKIPs with exit 75 and the lease's remedy line, reads
    nothing, probes nothing, and leaves `memory.md` and the cycle's lock
    files exactly as they were."""
    resources = FakeResources()
    job_runner = RecordingRunner()
    probes: list[str] = []
    monkeypatch.setattr(compose, "resources_for", lambda persona, settings: resources)
    monkeypatch.setattr(compose, "runner_for", lambda settings: job_runner)
    monkeypatch.setattr(compose, "health_check", lambda settings: probes.append("probe") or True)
    state_dir = cli_root / ".agent-state"
    state_dir.mkdir()
    db = open_lease_db(str(state_dir / LEASE_DB_NAME))
    request_close = contextlib.closing(db)

    with (
        request_close,
        RunLease(db, cli_root, "builtin", "zenith", "act", run_id="the-sweep"),
        RunLease(db, cli_root, "builtin", "zenith", "dream", run_id="the-sweep"),
    ):
        result = runner.invoke(cli.app, ["act", "zenith", "--seed", "0"])
        held = sorted(row[0] for row in db.execute("SELECT run_id FROM run_leases"))

    assert result.exit_code == 75
    assert "act lease busy" in result.stdout
    assert "another run holds this account" in result.stdout
    assert held == ["the-sweep", "the-sweep"]
    assert _memory(cli_root) == _INITIAL_MEMORY
    assert resources.search_calls == []
    assert resources.feed_board_calls == []
    assert resources.profile_patches == []
    assert job_runner.calls == []
    assert probes == []


def test_a_dry_act_takes_no_lease_and_writes_nothing(cli_root: Path) -> None:
    lock = act_lock_path(cli_root, "zenith")
    lock.parent.mkdir(parents=True)
    lock.write_text(f"{os.getpid()}\n", encoding="utf-8")

    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run", "--seed", "0"])

    assert result.exit_code == 0, result.output
    assert "would execute: post" in result.stdout
    assert _state_files(cli_root) == {"lock_zenith"}
    assert lock.read_text(encoding="utf-8") == f"{os.getpid()}\n"
    assert _memory(cli_root) == _INITIAL_MEMORY


def test_act_and_dream_open_the_lease_db_and_never_a_checkpoint_db(cli_root: Path) -> None:
    acted = runner.invoke(cli.app, ["act", "zenith", "--seed", "0"])
    dreamt = runner.invoke(cli.app, ["dream", "zenith"])

    assert (acted.exit_code, dreamt.exit_code) == (0, 0), acted.output + dreamt.output
    assert LEASE_DB_NAME in _state_files(cli_root)
    assert CHECKPOINT_DB_NAME not in _state_files(cli_root)
    assert not [name for name in _state_files(cli_root) if "lock_" in name]


def test_the_act_command_never_probes_the_embedder(
    cli_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    embedder = _FakeEmbedderClient()
    guard = _FakeGuard()
    monkeypatch.setattr(compose, "embedder_for", lambda settings: embedder)
    monkeypatch.setattr(compose, "guard_for", lambda settings: guard)

    result = runner.invoke(cli.app, ["act", "zenith", "--seed", "0"])

    assert result.exit_code == 0, result.output
    assert embedder.health_calls == 0
    assert (guard.up_calls, guard.down_calls) == (0, 0)


class _OrderedEmbedder(_FakeEmbedderClient):
    def __init__(self, order: list[str]) -> None:
        super().__init__()
        self._order = order

    def health(self) -> dict[str, object]:
        self._order.append("probe_embedder")
        return super().health()


def test_the_dream_command_reads_no_world_and_probes_before_selecting_a_backend(
    cli_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§12.6: DREAM's deps have no world context, no follow-topics feed and no
    news fetch, and the embedder probe precedes backend selection -- the
    order `dream.log` has always had."""
    order: list[str] = []
    resources = FakeResources()
    job_runner = RecordingRunner()
    real_select = compose.select_backend

    def select(*args: Any, **kwargs: Any) -> Any:
        order.append("select_backend")
        return real_select(*args, **kwargs)

    monkeypatch.setattr(compose, "embedder_for", lambda settings: _OrderedEmbedder(order))
    monkeypatch.setattr(compose, "select_backend", select)
    monkeypatch.setattr(compose, "resources_for", lambda persona, settings: resources)
    monkeypatch.setattr(compose, "runner_for", lambda settings: job_runner)

    result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 0, result.output
    assert order == ["probe_embedder", "select_backend"]
    assert resources.search_calls == []
    assert resources.feed_board_calls == []
    assert resources.since_calls == []
    assert job_runner.calls == []


def test_dream_without_auto_right_after_a_dream_still_dreams(
    cli_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review Focus 2, first half: the cooldown is ignored without `--auto`."""
    monkeypatch.setattr(
        compose, "backend_for", lambda persona, settings: ScriptedBackend(DREAM_REPLY)
    )
    state = cli_root / ".agent-state"
    state.mkdir()
    (state / "last_dream_zenith").write_text(str(int(NOW.timestamp())), encoding="utf-8")

    result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 0, result.output
    assert "dream written" in result.stdout


def test_dream_with_auto_inside_the_cooldown_is_a_no_op_exit_75(cli_root: Path) -> None:
    """Review Focus 2, second half: `--auto` inside the cooldown changes
    nothing on disk and exits 75, as before."""
    state = cli_root / ".agent-state"
    state.mkdir()
    marker = state / "last_dream_zenith"
    marker.write_text(str(int(datetime.now().timestamp())), encoding="utf-8")
    before = marker.read_text(encoding="utf-8")

    result = runner.invoke(cli.app, ["dream", "zenith", "--auto"])

    assert result.exit_code == 75
    assert "SKIP zenith -- cooldown" in result.stdout
    assert (cli_root / "agents" / "zenith" / "personality.md").read_text(
        encoding="utf-8"
    ) == _PERSONALITY
    assert marker.read_text(encoding="utf-8") == before


def test_an_unparseable_dream_keeps_the_file_files_dream_fail_and_exits_0(
    cli_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review Focus 3: `personality.md` untouched, a `dream`/`fail` event
    filed, and exit 0 -- the dream RAN (`proceeded`), as `dream` always
    reported it."""
    resources = FakeResources()
    monkeypatch.setattr(compose, "resources_for", lambda persona, settings: resources)
    monkeypatch.setattr(
        compose, "backend_for", lambda persona, settings: ScriptedBackend(_BAD_DREAM_REPLY)
    )

    result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 0
    assert "dream failed -- unparseable dream output" in result.stdout
    assert (cli_root / "agents" / "zenith" / "personality.md").read_text(
        encoding="utf-8"
    ) == _PERSONALITY
    assert not (cli_root / "agents" / "zenith" / "personality.archive.md").exists()
    fails = [(e.type, e.phase, e.outcome) for e in resources.lab_events if e.outcome == "fail"]
    assert fails == [("dream", "dream", "fail")]


# ── the projections (`graph/outcome.py`, moved from cli) ─────────────────────


def test_the_dream_report_follows_the_write() -> None:
    """`accepted` answers "did `personality.md` actually change", which is
    `written` -- a claim about the FILE -- never `proceeded` or the presence
    of a parsed list. The write node's dry-run guard returns `written=False`
    with a list in hand, and a refused write does the same."""
    state = {
        "proceeded": True,
        "recent": ["一件新事"],
        "written": False,
        "dream_reason": "file too large",
    }
    result = dream_result_of(state)  # type: ignore[arg-type]
    assert result.accepted is False
    assert result.reason == "file too large"
    assert result.recent == ["一件新事"]


def test_a_cycle_with_no_outcome_yet_is_not_reported_as_a_failed_round() -> None:
    """`run_cycle` returns the ACCUMULATED state, and a resumed thread with
    nothing left to run carries whatever the interrupted run had already
    recorded -- which may be nothing at all. Treating "not decided" as
    "denied" would exit 75 on a cycle that simply had no work left, and
    `cycle-one.sh` reads that as "the act did not land"."""
    assert cycle_granted_dream({}) is True
    assert cycle_granted_dream({"outcome": ActOutcome.OFFLINE}) is False
    assert cycle_granted_dream({"outcome": ActOutcome.LANDED_PARTIAL}) is True
    assert act_result_of({}) is None


# ── the guards no command path reaches ───────────────────────────────────────


def _bare_deps(root: Path) -> CycleDeps:
    return CycleDeps(
        resources=FakeResources(),
        backend=StubBackend(_NOTHING_PLAN),
        persona_source=FakePersonaSource(),
        embedder=FakeEmbedder(),
        dream_state=FakeState(),
        settings=Settings(agent_root=root),
        agent_root=root,
        health_check=lambda: True,
        memory_text="",
        llm_backend="claude",
        llm_model=None,
    )


def test_the_act_logout_will_not_rotate_without_the_runs_lease_database(tmp_path: Path) -> None:
    """`run_graph` always hands the ACT graph its lease database; a caller
    that compiles the graph itself and forgets it gets a loud error at the
    rotation, never an unlocked one."""
    persona = _persona(tmp_path)
    deps = _bare_deps(tmp_path)
    app = build_graph(Phases.ACT).compile()

    with pytest.raises(NodeStateError, match="lease database"):
        app.invoke(
            {"persona": persona, "run_id": "r", "dry_run": False},
            context=CycleContext(deps_for_round=lambda _index: deps),
        )
    assert not dream_lock_path(tmp_path, "zenith").exists()


def test_finish_deps_completes_a_single_cycle_deps_only(
    tmp_path: Path, lease_db: sqlite3.Connection
) -> None:
    deps = _bare_deps(tmp_path)
    with pytest.raises(ValueError, match="finish_deps"):
        run_graph(
            lambda _index: deps,
            phases=Phases.ACT,
            persona=_persona(tmp_path),
            lease_db=lease_db,
            finish_deps=lambda base: base,
        )
    assert not act_lock_path(tmp_path, "zenith").exists()


def test_an_act_graph_that_ends_without_an_outcome_is_an_unexpected_skip(
    cli_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every ACT path decides an outcome; if one ever does not, `act` says so
    as a bug (`UNEXPECTED`) and exits 75 rather than inventing a round."""
    monkeypatch.setattr(cli_run, "run_graph", lambda *args, **kwargs: {})

    result = runner.invoke(cli.app, ["act", "zenith", "--seed", "0"])

    assert result.exit_code == 75
    assert "UNEXPECTED RuntimeError: the act graph ended without an act outcome" in result.stdout
