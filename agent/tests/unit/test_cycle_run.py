"""cycle_run card + missing-sample events (spec §4).

The cycle already posts per-action `cycle` events. This file pins the ONE
row `/lab` will use as the round rollup: `metrics.kind == "cycle_run"`, the
exact key set, the outcome mapping, and the fail-loud half of the sampler
contract -- a raising sampler still returns the graph to logout and does
not change the round's act outcome, but it leaves a `missingSampler` warn
row AND a card with the matching flag.
"""

from __future__ import annotations

import logging
import random
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.analysis.cycle_run import (
    CYCLE_RUN_KIND,
    CYCLE_RUN_METRIC_KEYS,
    build_cycle_run_event,
    build_missing_sampler_event,
    grants_dream_for,
)
from swil_agent.config import Settings
from swil_agent.dream.candidate import FilesystemDreamState
from swil_agent.graph import nodes as nodes_module
from swil_agent.graph.cycle import run_cycle
from swil_agent.graph.nodes import (
    CycleDeps,
    make_behavior_snapshot_node,
    make_logout_node,
)
from swil_agent.models import ActOutcome, Persona
from swil_agent.persona.source import GitPersonaSource

from ._runners import FakeEmbedder, FakeResources, ScriptedBackend, SilentBackend

NOW = datetime(2026, 8, 21, 10, 0, 0)
CAPTURED_AT = datetime(2026, 8, 21, 2, 0, 0, tzinfo=UTC)
DIR_NAME = "zenith"
USERNAME = "zenith"

PERSONALITY = """---
username: zenith
display_name: 测试
bio: 一句话
model: claude:opus
board: ai
topics: [alpha, beta]
era: 3
---
# 测试

一个测试用的账号。

## 最近
- 一件旧事
"""

DREAM_REPLY = '{"recent": ["一件新事"]}'
INITIAL_MEMORY = "2026-08-01 | act | did a thing\n"


def _card(**overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "username": USERNAME,
        "attempted": 1,
        "landed": 1,
        "act_outcome": ActOutcome.LANDED_ALL,
        "grants_dream": True,
        "dream_accepted": True,
        "missing_behavior_snapshot": False,
        "duration_ms": 1200,
        "backend": "claude",
        "model": "opus",
    }
    kwargs.update(overrides)
    return build_cycle_run_event(**kwargs).to_wire()


# ── builder: spec §4 shape ──────────────────────────────────────────────────


def test_the_card_discriminates_on_metrics_kind_cycle_run() -> None:
    wire = _card()
    assert wire["type"] == "cycle"
    assert wire["phase"] == "act"
    assert wire["metrics"]["kind"] == CYCLE_RUN_KIND == "cycle_run"


def test_the_card_summary_is_cycle_run_username_act_outcome() -> None:
    """Spec §4: `summary: "cycle_run <username> <actOutcome>"`."""
    assert _card()["summary"] == "cycle_run zenith landed_all"
    assert _card(act_outcome=ActOutcome.OFFLINE)["summary"] == "cycle_run zenith offline"


def test_the_card_metrics_use_the_spec_keys_and_no_aliases() -> None:
    metrics = _card()["metrics"]
    assert set(metrics) == CYCLE_RUN_METRIC_KEYS
    assert set(metrics) == {
        "kind",
        "attempted",
        "landed",
        "actOutcome",
        "grantsDream",
        "dreamAccepted",
        "missingBehaviorSnapshot",
        "durationMs",
        "backend",
        "model",
    }


def test_the_card_metrics_are_flat_scalars() -> None:
    """`agentEventIngest.metrics` is a z.record of string/number/boolean/null.
    A nested value 400s the WHOLE event."""
    metrics = _card(dream_accepted=None)["metrics"]
    for key, value in metrics.items():
        assert isinstance(value, str | float | int | bool | type(None)), key


def test_dream_accepted_is_null_when_the_dream_did_not_run() -> None:
    assert _card(dream_accepted=None)["metrics"]["dreamAccepted"] is None


# ── builder: spec §4 outcome mapping ────────────────────────────────────────


def test_offline_and_dead_backend_are_fail() -> None:
    assert _card(act_outcome=ActOutcome.OFFLINE, grants_dream=False)["outcome"] == "fail"
    assert (
        _card(act_outcome=ActOutcome.BACKEND_UNAVAILABLE, grants_dream=False)["outcome"] == "fail"
    )


def test_a_missing_sampler_is_warn_even_when_the_act_landed() -> None:
    assert _card(missing_behavior_snapshot=True)["outcome"] == "warn"


def test_the_card_has_no_era_2_gate_fields() -> None:
    """The drift gate and the rule check are gone; the server reads both
    fields as optional for older rows."""
    metrics = _card()["metrics"]
    assert "gateStatus" not in metrics
    assert "missingRuleCheck" not in metrics


def test_offline_fail_outranks_a_missing_sampler() -> None:
    """Spec §4 lists OFFLINE/BACKEND_UNAVAILABLE before the warn clause."""
    wire = _card(
        act_outcome=ActOutcome.OFFLINE,
        grants_dream=False,
        missing_behavior_snapshot=True,
    )
    assert wire["outcome"] == "fail"


def test_empty_plan_and_rhythm_veto_are_skip() -> None:
    assert _card(act_outcome=ActOutcome.PLANNER_EMPTY, landed=0, attempted=0)["outcome"] == "skip"
    assert _card(act_outcome=ActOutcome.VETOED_EMPTY, landed=0, attempted=0)["outcome"] == "skip"


def test_a_missing_sampler_on_an_empty_plan_is_warn_not_skip() -> None:
    """Warn outranks skip: a quiet round whose sampler failed is not health."""
    wire = _card(act_outcome=ActOutcome.PLANNER_EMPTY, missing_behavior_snapshot=True)
    assert wire["outcome"] == "warn"


def test_a_clean_landed_round_is_success() -> None:
    assert _card()["outcome"] == "success"
    partial = _card(act_outcome=ActOutcome.LANDED_PARTIAL, landed=1, attempted=2)
    assert partial["outcome"] == "success"


# ── grants_dream_for ───────────────────────────────────────────────────────


def test_an_undecided_act_outcome_still_grants_a_dream() -> None:
    assert grants_dream_for(None) is True
    assert grants_dream_for(ActOutcome.LANDED_ALL) is True
    assert grants_dream_for(ActOutcome.OFFLINE) is False


# ── missingSampler event ────────────────────────────────────────────────────


def test_a_missing_sampler_event_is_a_cycle_warn_without_the_cycle_run_kind() -> None:
    """Two writes on purpose: this is the audit row; the card is the rollup.
    Readers MUST ignore events without kind=cycle_run when building the strip.
    """
    wire = build_missing_sampler_event(sampler="behavior_snapshot").to_wire()
    assert wire["type"] == "cycle"
    assert wire["phase"] == "act"
    assert wire["outcome"] == "warn"
    assert wire["metrics"] == {"missingSampler": "behavior_snapshot"}
    assert "kind" not in wire["metrics"]


# ── graph: raising sampler is fail-soft on outcome, fail-loud on the ledger ─


def _account(root: Path) -> Path:
    directory = root / "agents" / DIR_NAME
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "personality.md").write_text(PERSONALITY, encoding="utf-8")
    (directory / "memory.md").write_text(INITIAL_MEMORY, encoding="utf-8")
    (directory / "api_key.txt").write_text("k-secret\n", encoding="utf-8")
    return directory


def _persona(root: Path) -> Persona:
    _account(root)
    return GitPersonaSource(root).load(DIR_NAME)


def _deps(root: Path, **overrides: Any) -> CycleDeps:
    defaults: dict[str, Any] = {
        "resources": FakeResources(),
        "backend": ScriptedBackend('{"plan":[{"action":"post","text":"你好世界"}]}', DREAM_REPLY),
        "persona_source": GitPersonaSource(root),
        "embedder": FakeEmbedder(vectors=[[1.0], [1.0], [1.0]]),
        "dream_state": FilesystemDreamState(root / ".agent-state"),
        "settings": Settings(agent_root=root),
        "agent_root": root,
        "health_check": lambda: True,
        "memory_text": INITIAL_MEMORY,
        "rng": random.Random(7),
        "now": NOW,
        "captured_at": CAPTURED_AT,
    }
    defaults.update(overrides)
    return CycleDeps(**defaults)


def _run(root: Path, deps: CycleDeps, persona: Persona | None = None) -> dict[str, Any]:
    lease_db = sqlite3.connect(":memory:")
    try:
        return dict(
            run_cycle(
                persona=persona or _persona(root),
                deps=deps,
                lease_db=lease_db,
                round_id="cycle-run",
                run_id="run-1",
            )
        )
    finally:
        lease_db.close()


def _explode(name: str) -> Any:
    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError(f"{name} blew up")

    return boom


def _cycle_run_events(resources: FakeResources) -> list[Any]:
    return [event for event in resources.lab_events if event.metrics.get("kind") == CYCLE_RUN_KIND]


def _missing_sampler_events(resources: FakeResources) -> list[Any]:
    return [event for event in resources.lab_events if "missingSampler" in event.metrics]


def test_a_raising_sampler_emits_missing_sampler_and_still_returns_a_partial(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Spec §4: raise → warn event with missingSampler, round continues."""
    root = tmp_path / "agent_root"
    resources = FakeResources()
    monkeypatch.setattr(nodes_module, "run_behavior_snapshot", _explode("run_behavior_snapshot"))

    with caplog.at_level(logging.WARNING, logger="swil_agent.graph.nodes"):
        update = make_behavior_snapshot_node(_deps(root, resources=resources))(
            {"persona": _persona(root)}
        )

    assert update == {"missing_behavior_snapshot": True}
    events = _missing_sampler_events(resources)
    assert len(events) == 1
    assert events[0].outcome == "warn"
    assert events[0].metrics == {"missingSampler": "behavior_snapshot"}
    assert resources.lab_event_usernames == [USERNAME]


def test_a_raising_sampler_still_returns_the_graph_to_logout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail-soft on the round: the act still lands, personality still writes,
    logout still runs. Fail-loud on the ledger: missingSampler + card flag."""
    root = tmp_path / "agent_root"
    resources = FakeResources()
    monkeypatch.setattr(nodes_module, "run_behavior_snapshot", _explode("run_behavior_snapshot"))

    final = _run(root, _deps(root, resources=resources))

    assert final.get("outcome") is ActOutcome.LANDED_ALL
    assert final.get("written") is True
    assert final.get("missing_behavior_snapshot") is True
    missing = _missing_sampler_events(resources)
    assert [event.metrics["missingSampler"] for event in missing] == ["behavior_snapshot"]
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert cards[0].outcome == "warn"
    assert cards[0].metrics["missingBehaviorSnapshot"] is True
    assert cards[0].metrics["actOutcome"] == "landed_all"
    assert cards[0].metrics["grantsDream"] is True


def test_an_offline_cycle_still_emits_a_cycle_run_card(tmp_path: Path) -> None:
    """Spec §4: one event per finished cycle, including early logout."""
    root = tmp_path / "agent_root"
    resources = FakeResources()

    final = _run(root, _deps(root, resources=resources, health_check=lambda: False))

    assert final.get("outcome") is ActOutcome.OFFLINE
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert cards[0].outcome == "fail"
    assert cards[0].summary == "cycle_run zenith offline"
    assert cards[0].metrics["actOutcome"] == "offline"
    assert cards[0].metrics["grantsDream"] is False
    assert cards[0].metrics["dreamAccepted"] is None
    assert cards[0].metrics["missingBehaviorSnapshot"] is False
    assert set(cards[0].metrics) == CYCLE_RUN_METRIC_KEYS
    assert resources.lab_event_usernames[-1] == USERNAME


def test_a_dead_backend_cycle_emits_a_fail_card(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()

    final = _run(root, _deps(root, resources=resources, backend=SilentBackend()))

    assert final.get("outcome") is ActOutcome.BACKEND_UNAVAILABLE
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert cards[0].outcome == "fail"
    assert cards[0].metrics["actOutcome"] == "backend_unavailable"


def test_an_empty_plan_cycle_emits_a_skip_card(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()
    deps = _deps(
        root,
        resources=resources,
        backend=ScriptedBackend('{"plan":[]}', DREAM_REPLY),
    )

    final = _run(root, deps)

    assert final.get("outcome") is ActOutcome.PLANNER_EMPTY
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert cards[0].outcome == "skip"
    assert cards[0].metrics["actOutcome"] == "planner_empty"
    assert cards[0].metrics["missingBehaviorSnapshot"] is False


def test_a_landed_dream_is_dream_accepted_true_and_success(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()

    final = _run(root, _deps(root, resources=resources))

    assert final.get("written") is True
    assert final.get("recent") == ["一件新事"]
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert cards[0].outcome == "success"
    assert cards[0].metrics["dreamAccepted"] is True
    assert set(cards[0].metrics) == CYCLE_RUN_METRIC_KEYS


def test_a_dry_run_does_not_emit_a_cycle_run_card(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()

    _run(root, _deps(root, resources=resources, dry_run=True))

    assert _cycle_run_events(resources) == []
    assert _missing_sampler_events(resources) == []


def test_the_logout_card_uses_the_username_and_the_injected_clock(
    tmp_path: Path,
) -> None:
    """The card is filed under the username; duration comes off deps.monotonic."""
    root = tmp_path / "agent_root"
    resources = FakeResources()
    ticks = iter([10.5])
    deps = _deps(root, resources=resources, monotonic=lambda: next(ticks))
    node = make_logout_node(deps)

    update = node(
        {
            "persona": _persona(root),
            "run_id": "run-7",
            "outcome": ActOutcome.LANDED_ALL,
            "attempted": 2,
            "landed": 2,
            "written": True,
            "started_monotonic": 10.0,
            "backend": "unused",
        }
    )

    assert update == {}
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert resources.lab_event_usernames == [USERNAME]
    assert cards[0].metrics["durationMs"] == 500
    assert cards[0].metrics["backend"] == "claude"
    assert cards[0].metrics["model"] == "opus"
    assert cards[0].metrics["attempted"] == 2
    assert cards[0].metrics["landed"] == 2


def test_a_failed_dream_card_records_dream_accepted_false(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()
    node = make_logout_node(_deps(root, resources=resources))

    node(
        {
            "persona": _persona(root),
            "run_id": "run-7",
            "outcome": ActOutcome.LANDED_ALL,
            "proceeded": True,
            "written": False,
            "dream_reason": "unparseable dream output",
        }
    )

    cards = _cycle_run_events(resources)
    assert cards[0].metrics["dreamAccepted"] is False


def test_a_lab_outage_emitting_the_card_does_not_change_logout(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The ledger is fail-loud when it lands; a dead events endpoint must not
    become the round's exit code. The miss itself is WARNING so a missing
    ledger is grep-able (DEBUG would drown in the round log)."""
    root = tmp_path / "agent_root"
    resources = FakeResources(lab_event_raises=RuntimeError("events down"))
    node = make_logout_node(_deps(root, resources=resources))

    with caplog.at_level(logging.WARNING, logger="swil_agent.graph.nodes"):
        update = node(
            {
                "persona": _persona(root),
                "run_id": "run-7",
                "outcome": ActOutcome.OFFLINE,
            }
        )

    assert update == {}
    assert any(
        rec.levelno == logging.WARNING and "lab event failed" in rec.message
        for rec in caplog.records
    )


# ── memory rotation at logout ───────────────────────────────────────────────


def _long_memory(persona: Persona, count: int) -> list[str]:
    lines = [f"2026-08-01 | old {i}" for i in range(count)]
    (persona.directory / "memory.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return lines


def _lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def test_logout_rotates_an_oversized_memory_file(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    persona = _persona(root)
    lines = _long_memory(persona, 301)

    make_logout_node(_deps(root))({"persona": persona, "outcome": ActOutcome.LANDED_ALL})

    assert _lines(persona.directory / "memory.md") == lines[-200:]
    assert _lines(persona.directory / "memory.archive.md") == lines[:101]


def test_a_dry_run_logout_never_rotates(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    persona = _persona(root)
    _long_memory(persona, 301)

    make_logout_node(_deps(root, dry_run=True))({"persona": persona})

    assert len(_lines(persona.directory / "memory.md")) == 301
    assert not (persona.directory / "memory.archive.md").exists()


def test_a_full_cycle_rotates_after_the_round_wrote_its_lines(tmp_path: Path) -> None:
    """Rotation runs at logout, so this round's own post and dream lines are
    in the newest 200 rather than archived."""
    root = tmp_path / "agent_root"
    persona = _persona(root)
    _long_memory(persona, 400)

    final = _run(root, _deps(root), persona=persona)

    assert final.get("written") is True
    live = _lines(persona.directory / "memory.md")
    assert len(live) == 200
    assert live[-1].endswith("| dream | 最近已更新")
    assert _lines(persona.directory / "memory.archive.md")[0] == "2026-08-01 | old 0"
