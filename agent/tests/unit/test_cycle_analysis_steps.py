"""The cycle's observability samplers, as wired into the graph.

`behavior_snapshot` (the act phase's tail) embeds the account's recent posts
and ships the "revealed self" half of `/lab`'s fidelity pair;
`population_metric` (the cycle's tail, after logout) triggers one
homogenization sample. Neither absence is loud -- a `/lab` series simply goes
flat -- so what this file pins is the WIRING: that each is called at all, from
the right position, with the right arguments, never under `--dry-run`, and
that a failure in either cannot cost the account its round. The samplers
themselves are covered by `test_behavior_snapshot.py` and
`test_population_metric.py`.
"""

from __future__ import annotations

import hashlib
import logging
import random
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.analysis import behavior_snapshot as behavior_module
from swil_agent.config import Settings
from swil_agent.dream.candidate import FilesystemDreamState
from swil_agent.graph import nodes_tail
from swil_agent.graph.cycle import run_cycle
from swil_agent.graph.deps import CycleDeps
from swil_agent.graph.nodes_tail import make_behavior_snapshot_node, make_population_metric_node
from swil_agent.graph.state import CycleState
from swil_agent.models import ActOutcome, Persona
from swil_agent.persona.source import GitPersonaSource

from ._node_modules import caller_of
from ._runners import FakeEmbedder, FakeResources, ScriptedBackend, make_persona

NOW = datetime(2026, 8, 19, 10, 0, 0)
# Deliberately a different instant from `NOW`: `captured_at` and `now` are read
# from independent `date` / `date -u` calls in Bash, and a fixture where they
# coincide cannot tell `captured_at=deps.captured_at` from `captured_at=
# deps.now` -- both format to the same `capturedAt` string.
CAPTURED_AT = datetime(2026, 8, 19, 2, 0, 0, tzinfo=UTC)
SEED = 7

# The loader requires the directory name to match `username`, and this file
# drives the real `GitPersonaSource`, so the two coincide here. The
# directory-vs-username split is pinned in `test_graph_nodes.py`.
DIR_NAME = "zenith"
USERNAME = "zenith"

PERSONALITY = """---
username: zenith
display_name: 测试
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

POST_BODY = "写完了 #alpha #beta"
POSTS = [{"id": "p1", "text": POST_BODY}]

INITIAL_MEMORY = "2026-08-01 | act | did a thing\n"

# Not the default of 12 (also `Resources.user_posts`' own default), so a node
# that hardcoded it is visible.
BEHAVIOR_LIMIT = 7


def _settings(root: Path, **overrides: Any) -> Settings:
    defaults: dict[str, Any] = {
        "agent_root": root,
        "behavior_post_limit": BEHAVIOR_LIMIT,
    }
    defaults.update(overrides)
    return Settings(**defaults)


class DerivedEmbedder:
    """Records every input AND returns a vector derived from it.

    Standing constraint §4: `FakeEmbedder` hands back its scripted vector
    whatever it was asked to embed, so a test asserting on the returned vector
    cannot tell WHICH document was embedded. Here two different texts can
    never produce the same vector, so the `embedding` that reaches the wire is
    itself evidence -- and "embed the personality instead of the posts" dies
    twice, once on `calls` and once on the payload.
    """

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [self.vector_for(text) for text in texts]

    @staticmethod
    def vector_for(text: str) -> list[float]:
        digest = hashlib.sha256(text.encode()).digest()
        return [float(len(text)), float(digest[0]), float(digest[1])]


def _account(root: Path, *, api_key: bool = True, personality: str = PERSONALITY) -> Path:
    directory = root / "agents" / DIR_NAME
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "personality.md").write_text(personality, encoding="utf-8")
    (directory / "memory.md").write_text(INITIAL_MEMORY, encoding="utf-8")
    if api_key:
        (directory / "api_key.txt").write_text("k-secret\n", encoding="utf-8")
    return directory


def _persona(root: Path, **kwargs: Any) -> Persona:
    _account(root, **kwargs)
    return GitPersonaSource(root).load(DIR_NAME)


def _resources(**kwargs: Any) -> FakeResources:
    resources = FakeResources(**kwargs)
    resources.user_post_items = [dict(item) for item in POSTS]
    return resources


def _deps(root: Path, **overrides: Any) -> CycleDeps:
    defaults: dict[str, Any] = {
        "resources": _resources(),
        "backend": ScriptedBackend('{"plan":[{"action":"post","text":"你好世界"}]}', DREAM_REPLY),
        "persona_source": GitPersonaSource(root),
        "embedder": FakeEmbedder(vectors=[[1.0], [1.0], [1.0]]),
        "dream_state": FilesystemDreamState(root / ".agent-state"),
        "settings": _settings(root),
        "agent_root": root,
        "health_check": lambda: True,
        "memory_text": INITIAL_MEMORY,
        "llm_backend": "claude",
        "llm_model": "opus",
        "rng": random.Random(SEED),
        "now": NOW,
        "captured_at": CAPTURED_AT,
    }
    defaults.update(overrides)
    return CycleDeps(**defaults)


def _root(tmp_path: Path) -> Path:
    root = tmp_path / "agent_root"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _run(root: Path, persona: Persona, deps: CycleDeps, **kwargs: Any) -> CycleState:
    lease_db = sqlite3.connect(":memory:")
    try:
        return run_cycle(
            persona=persona,
            deps=deps,
            lease_db=lease_db,
            round_id="analysis",
            run_id="run-1",
            **kwargs,
        )
    finally:
        lease_db.close()


# Every call the node modules make that this file needs to place in time.
# Patched on the calling node module's OWN globals (`caller_of`), because that is the name each node
# resolves at call time (standing constraint §6).
_TRACEABLE = (
    "execute_step",
    "finalize_step",
    "run_behavior_snapshot",
    "run_population_metric",
    "cooldown_step",
    "dream_step",
    "write_step",
    "snapshot_step",
)


def _trace_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record, in order, every traced call the node layer makes.

    `*args` as well as `**kwargs`: the samplers take `resources`
    POSITIONALLY (`run_behavior_snapshot(resources, *, ...)`), and a keyword-only spy
    silently turns every one of those calls into a `TypeError` that the
    node's own fail-soft guard then swallows -- a trace that records nothing
    while every fail-soft test still passes.
    """
    trace: list[str] = []

    def install(name: str) -> None:
        real = getattr(caller_of(name), name)

        def spy(*args: Any, **kwargs: Any) -> Any:
            trace.append(name)
            return real(*args, **kwargs)

        monkeypatch.setattr(caller_of(name), name, spy)

    for name in _TRACEABLE:
        install(name)
    return trace


def _explode(name: str) -> Callable[..., Any]:
    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError(f"{name} blew up")

    return boom


# ── the node layer: what each sampler is handed ─────────────────────────────


def test_the_behavior_snapshot_node_embeds_the_posts_and_ships_that_vector(
    tmp_path: Path,
) -> None:
    """The input side and the wire side of the same claim.

    `DerivedEmbedder` encodes its input into the vector it returns, so
    "embedded the personality instead of the posts" dies on `calls` AND on the
    `embedding` that reached `create_behavior_snapshot`.
    """
    root = _root(tmp_path)
    persona = _persona(root)
    resources = _resources()
    embedder = DerivedEmbedder()

    assert (
        make_behavior_snapshot_node(_deps(root, resources=resources, embedder=embedder))(
            {"persona": persona}
        )
        == {}
    )

    assert embedder.calls == [[POST_BODY]]
    assert resources.user_posts_calls == [(USERNAME, BEHAVIOR_LIMIT)]
    assert len(resources.behavior_snapshots) == 1
    username, payload = resources.behavior_snapshots[0]
    assert username == USERNAME
    assert payload["embedding"] == DerivedEmbedder.vector_for(POST_BODY)
    assert payload["postCount"] == 1
    # `captured_at`, not `now`: the two are different instants in this file.
    assert payload["capturedAt"].startswith("2026-08-19T02:00:00")


def test_the_behavior_snapshot_node_is_not_the_personality_snapshot(tmp_path: Path) -> None:
    """Two different endpoints with two different bodies. `snapshot_step`
    uploads the STATED self (`personality.md`); this node uploads the REVEALED
    self (recent posts), and `/lab`'s fidelity number is the cosine between
    them -- so a node that called the personality endpoint would produce a
    fidelity of 1.0 for every account, forever."""
    root = _root(tmp_path)
    resources = _resources()

    make_behavior_snapshot_node(_deps(root, resources=resources))({"persona": _persona(root)})

    assert resources.snapshots == []
    assert len(resources.behavior_snapshots) == 1
    assert set(resources.behavior_snapshots[0][1]) == {
        "contentHash",
        "capturedAt",
        "postCount",
        "commentCount",
        "excerpt",
        "embedding",
    }


# ── fail-soft at the node ───────────────────────────────────────────────────


def test_a_sampler_that_raises_is_swallowed_at_the_node(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The node carries no retry policy and no fallback edge, so an escaping
    exception aborts the whole LangGraph run -- costing the account its dream
    and its logout record in order to record a number on a panel.

    The LABEL is asserted, not only the cause: `auto-run.log` is what an
    operator greps when a `/lab` series goes flat.
    """
    root = _root(tmp_path)
    monkeypatch.setattr(nodes_tail, "run_behavior_snapshot", _explode("run_behavior_snapshot"))

    with caplog.at_level(logging.WARNING, logger="swil_agent.graph.nodes"):
        update = make_behavior_snapshot_node(_deps(root))({"persona": _persona(root)})

    assert update == {"missing_behavior_snapshot": True}
    messages = [record.getMessage() for record in caplog.records]
    assert any(
        message.startswith(f"behavior-snapshot: {DIR_NAME} ")
        and "run_behavior_snapshot blew up" in message
        for message in messages
    ), messages


def test_a_sampler_does_not_swallow_a_keyboard_interrupt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`except Exception`, not `except BaseException`. A `KeyboardInterrupt`
    is the operator ending the run; swallowing it would carry on with the
    cycle while still holding both leases."""

    def interrupt(*_args: Any, **_kwargs: Any) -> Any:
        raise KeyboardInterrupt

    monkeypatch.setattr(nodes_tail, "run_behavior_snapshot", interrupt)

    root = _root(tmp_path)
    with pytest.raises(KeyboardInterrupt):
        make_behavior_snapshot_node(_deps(root))({"persona": _persona(root)})


# ── --dry-run: the guard lives WITH the call ────────────────────────────────


def test_the_behavior_sampler_touches_nothing_under_dry_run(tmp_path: Path) -> None:
    """`run_behavior_snapshot` POSTs and takes no `dry_run` parameter, and the
    act phase runs under `--dry-run` (inertly) and flows straight into this
    node -- so this guard is the only one. Asserted on reads too: a node that
    fetched the posts and then decided not to ship them still costs a shadow
    round one API call per account."""
    root = _root(tmp_path)
    resources = _resources()
    embedder = DerivedEmbedder()
    deps = _deps(root, resources=resources, embedder=embedder, dry_run=True)

    assert make_behavior_snapshot_node(deps)({"persona": _persona(root)}) == {}

    assert resources.user_posts_calls == []
    assert resources.lab_events == []
    assert resources.behavior_snapshots == []
    assert embedder.calls == []


# ── the cycle: position, and what a mis-ordered call would measure ──────────


def test_a_full_cycle_samples_behaviour_after_the_act_and_before_the_dream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The recorded call sequence: the behaviour snapshot is the act phase's
    tail (after `finalize_step`), and the population sample is the cycle's
    last call."""
    root = _root(tmp_path)
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root), _deps(root))

    assert trace == [
        "execute_step",
        "finalize_step",
        "run_behavior_snapshot",
        "cooldown_step",
        "dream_step",
        "write_step",
        "snapshot_step",
        # The cycle's tail, after `logout`. It is LAST because the population
        # vector it summarises only finishes moving when this account's own
        # snapshot has landed -- sampling before `snapshot_step` would read
        # the population as it was before this round's contribution.
        "run_population_metric",
    ]


def test_a_cooldown_skip_is_still_sampled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The behaviour snapshot belongs to the act phase, so an account inside
    its 12h cooldown -- the common case -- still ships one per round."""
    root = _root(tmp_path)
    state_dir = root / ".agent-state"
    state_dir.mkdir(parents=True, exist_ok=True)
    # Seeded RELATIVE TO `NOW`: `cooldown_step` is handed `deps.now`.
    (state_dir / f"last_dream_{DIR_NAME}").write_text(
        str(int(NOW.timestamp()) - 3600), encoding="utf-8"
    )
    resources = _resources()
    trace = _trace_calls(monkeypatch)

    final = _run(root, _persona(root), _deps(root, resources=resources, auto=True))

    assert final.get("proceeded") is False
    assert "dream_step" not in trace
    assert trace.index("run_behavior_snapshot") < trace.index("cooldown_step")
    assert len(resources.behavior_snapshots) == 1


def test_an_empty_plan_ships_no_behaviour_vector_but_still_dreams(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty plan routes AROUND `execute`, hence around its successor: no
    posts were made this round, so there is no new behaviour to sample. The
    dream still runs (`ActResult.grants_dream`)."""
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)
    deps = _deps(root, resources=resources, backend=ScriptedBackend('{"plan":[]}', DREAM_REPLY))

    final = _run(root, _persona(root), deps)

    assert final.get("outcome") is ActOutcome.PLANNER_EMPTY
    assert "run_behavior_snapshot" not in trace
    assert resources.behavior_snapshots == []
    assert "dream_step" in trace


@pytest.mark.parametrize(
    ("label", "deps_overrides"),
    [
        ("offline", {"health_check": lambda: False}),
        ("dead backend", {"backend": ScriptedBackend("not json at all")}),
    ],
)
def test_a_round_that_never_acted_samples_nothing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    label: str,
    deps_overrides: dict[str, Any],
) -> None:
    """The two outcomes that deny the account its dream (§7.1) never reach
    the sampler: sampling either would file a measurement about a round that
    did not happen."""
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root), _deps(root, resources=resources, **deps_overrides))

    assert "run_behavior_snapshot" not in trace, label
    assert resources.user_posts_calls == []
    assert resources.behavior_snapshots == []


def test_a_dry_cycle_ships_no_behaviour_vector(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The node guard asserted through the whole graph: the act phase runs
    under `--dry-run` and flows into the sampler, so deleting the guard
    reddens this test and not only a node-level one."""
    root = _root(tmp_path)
    resources = _resources()
    embedder = DerivedEmbedder()
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root), _deps(root, resources=resources, embedder=embedder, dry_run=True))

    assert trace == ["execute_step", "finalize_step"]
    assert resources.user_posts_calls == []
    assert resources.behavior_snapshots == []
    assert resources.lab_events == []
    assert embedder.calls == []


# ── fail-soft, through the whole graph ──────────────────────────────────────


@pytest.mark.parametrize("step", ["run_behavior_snapshot", "run_population_metric"])
def test_a_sampler_failure_leaves_the_whole_round_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    """The strongest form of "fail-soft": not "the exception was caught" but
    "every other effect of the round is byte-identical".

    Run twice against two freshly seeded roots -- once clean, once with the
    named sampler raising -- and compare the outcome, the tally, the dream,
    the rewritten `personality.md`, `memory.md` and the round's
    non-analysis lab events.
    """

    def observed(root: Path, broken: bool) -> dict[str, Any]:
        resources = _resources()
        persona = _persona(root)
        with monkeypatch.context() as patch:
            if broken:
                patch.setattr(caller_of(step), step, _explode(step))
            final = _run(root, persona, _deps(root, resources=resources))
        return {
            "outcome": final.get("outcome"),
            "tally": (final.get("landed"), final.get("attempted")),
            "written": final.get("written"),
            "snapshot_ok": final.get("snapshot_ok"),
            "personality": (persona.directory / "personality.md").read_text(encoding="utf-8"),
            "memory": (persona.directory / "memory.md").read_text(encoding="utf-8"),
            "events": [
                sorted(event.to_wire().items())
                for event in resources.lab_events
                if event.metrics.get("kind") != "cycle_run"
                and "missingSampler" not in event.metrics
            ],
            "posts": [post.text for post in resources.created_posts],
        }

    clean = observed(_root(tmp_path / "clean"), broken=False)
    with_failure = observed(_root(tmp_path / "broken"), broken=True)

    assert clean["written"] is True, "the control round must dream, or it compares nothing"
    assert with_failure == clean


# ── the settings seam ───────────────────────────────────────────────────────


def test_the_behavior_post_limit_carries_the_modules_own_default() -> None:
    """`config.py` sits below `analysis/` in the dependency order and cannot
    import the constant, so the two are pinned equal here."""
    settings = Settings()
    assert settings.behavior_post_limit == behavior_module.DEFAULT_POST_LIMIT == 12


# ── the cycle tail: one population-cohesion sample per round ────────────────


def test_the_cycle_tail_records_exactly_one_population_cohesion_sample(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Before this node existed the homogenization series held three points in
    four months, each from a human remembering to run the command.

    ONE, not two: `record_population_metric` inserts a row on every call
    (`population/population.ts`), so a second call per cycle silently doubles the
    series' sampling rate -- which is a change to what the trend MEANS, made
    by a duplicated line.
    """
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root), _deps(root, resources=resources))

    assert trace.count("run_population_metric") == 1
    assert resources.calls.count("record_population_metric") == 1
    # Last of everything the round does: the reading is only complete once
    # this account's own snapshot has landed.
    assert trace[-1] == "run_population_metric"


def test_an_offline_round_records_no_population_sample_but_a_dead_backend_does(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one discrimination this node makes, and both halves of it.

    `OFFLINE` is the `$SWIL_URL/health` probe having failed, so the POST is
    guaranteed to fail too: a roster sweep against a down platform would spend
    23 connection timeouts and print 23 WARN lines about a measurement nobody
    could have taken.

    `BACKEND_UNAVAILABLE` is a dead LLM with a HEALTHY platform, where the
    population reading is exactly as valid as on any other round -- and it is
    the round on which cohesion is most worth having, since nothing that
    round changed any account's vectors. Asserted as a PAIR: a node that
    skipped on any non-acting outcome would pass the first assertion alone.
    """
    offline_root = _root(tmp_path / "offline")
    offline_resources = _resources()
    offline_trace = _trace_calls(monkeypatch)
    _run(
        offline_root,
        _persona(offline_root),
        _deps(offline_root, resources=offline_resources, health_check=lambda: False),
    )
    assert "run_population_metric" not in offline_trace
    assert offline_resources.calls == []

    dead_root = _root(tmp_path / "dead")
    dead_resources = _resources()
    dead_trace = _trace_calls(monkeypatch)
    _run(
        dead_root,
        _persona(dead_root),
        _deps(
            dead_root,
            resources=dead_resources,
            backend=ScriptedBackend("not json at all"),
        ),
    )
    assert dead_trace.count("run_population_metric") == 1
    assert dead_resources.calls == ["record_population_metric"]


def test_a_dry_cycle_records_no_population_sample(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Standing constraints §5 and §9. `run_population_metric` POSTs on every
    successful path and takes no `dry_run` parameter to be inert under, and
    the tail is reached from every route including the dry one -- so this line
    in the node is the only guard, and deleting it writes 23 rows into the
    homogenization series during a round that is supposed to write nothing."""
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root), _deps(root, resources=resources, dry_run=True))

    assert "run_population_metric" not in trace
    assert resources.calls == []


def test_a_population_sample_failure_leaves_the_round_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Fail-soft, like its sibling and for the same reason: this node
    carries no retry policy and no fallback edge, so an escaping exception
    aborts the LangGraph run after the account has already acted, dreamt and
    logged out -- discarding a completed round to record a number on a panel.

    The label is pinned as well as the cause: `population-metric` is what an
    operator greps for when the homogenization trend stops moving, and a WARN
    naming a different sampler sends them to the wrong panel.
    """
    root = _root(tmp_path)
    monkeypatch.setattr(nodes_tail, "run_population_metric", _explode("run_population_metric"))

    with caplog.at_level(logging.WARNING, logger="swil_agent.graph.nodes"):
        final = _run(root, _persona(root), _deps(root))

    assert final.get("outcome") is ActOutcome.LANDED_ALL
    assert final.get("written") is True
    messages = [record.getMessage() for record in caplog.records]
    assert any(
        message.startswith(f"population-metric: {DIR_NAME} ")
        and "run_population_metric blew up" in message
        for message in messages
    ), messages


def test_the_population_sample_does_not_swallow_a_keyboard_interrupt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`except Exception`, not `except BaseException` -- the same line the
    behaviour sampler is held to. Swallowing a `KeyboardInterrupt` here
    would carry on with the cycle while still holding both leases."""

    def interrupt(*_args: Any, **_kwargs: Any) -> Any:
        raise KeyboardInterrupt

    monkeypatch.setattr(nodes_tail, "run_population_metric", interrupt)

    root = _root(tmp_path)
    with pytest.raises(KeyboardInterrupt):
        make_population_metric_node(_deps(root))({"persona": _persona(root)})


def test_the_population_sample_needs_no_api_key_because_the_route_is_global(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unlike `behavior_snapshot`, which skips an account with no
    `api_key.txt`, this node has no such check and must not grow one.

    `POST /agents/population-metric` takes no username and any authenticated
    lab account authorises it, so `deps.resources` -- whatever `resolve_auth`
    picked, Bearer or the `SWIL_PASS` session cookie -- is already sufficient.
    A key check copied from the sibling would silently stop sampling on every
    key-less account.
    """
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root, api_key=False), _deps(root, resources=resources))

    assert trace.count("run_population_metric") == 1
    assert resources.calls.count("record_population_metric") == 1


def test_the_population_node_has_no_cohort_skip(tmp_path: Path) -> None:
    """Era 3 has one cohort. The Era 2 `humans/` skip is gone, so the node
    samples whatever directory the persona lives in."""
    resources = _resources()
    directory = tmp_path / "humans" / DIR_NAME
    directory.mkdir(parents=True)
    persona = make_persona(username=USERNAME, directory=directory)

    make_population_metric_node(_deps(_root(tmp_path), resources=resources))(
        {"persona": persona, "outcome": ActOutcome.LANDED_ALL}
    )

    assert resources.calls == ["record_population_metric"]
