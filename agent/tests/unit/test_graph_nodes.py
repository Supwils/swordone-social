"""The cycle's node functions (Plan 3 Task 7, spec §5.4).

A node adapts `CycleState` to one or more of the step functions Tasks 5 and 6
extracted, and does nothing else. So what these tests can see -- and what
`test_act_round.py` / `test_dream_round.py` (the two composition oracles) and
`test_act_steps.py` / `test_dream_steps.py` (the step-level pins) cannot -- is
exactly the wiring in between:

  * **A value that never crosses a node boundary.** The steps are correct in
    isolation; the graph fails by dropping what one node produced before the
    next one reads it. `recent` is the sharp case: the dream node produces
    it, and the write and snapshot nodes both consume it.
  * **A guard that stops being load-bearing on the graph path.** The two
    composition-shape pins in `test_dream_steps.py` monkeypatch
    `dream.round`'s MODULE GLOBALS, which is what makes them work for
    `run_dream` -- and what makes them blind here: `graph/nodes_dream.py` binds
    `write_step` / `snapshot_step` into its OWN globals at import, so those
    spies never see a node's call. The equivalents live in this file,
    patching the node module that calls each step (`_node_modules.caller_of`).
  * **`dry_run` that reaches the steps that write.** A `--dry-run` shadow
    round runs against live accounts. A node that forgets to thread it posts
    to production.
  * **The account's identity.** `agent_name` is the persona DIRECTORY name,
    never the username. Every node test that names an account uses a
    persona where they differ (built directly, not through the loader that
    requires them to match), so a node reaching for the wrong one is visible
    rather than coincidentally correct.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.api.client import ApiError
from swil_agent.config import Settings
from swil_agent.dream.round import snapshot_content
from swil_agent.graph import nodes_dream
from swil_agent.graph.deps import CycleDeps, NodeStateError, agent_dir_name
from swil_agent.graph.nodes_act import (
    make_execute_node,
    make_guardrail_node,
    make_login_node,
    make_plan_node,
)
from swil_agent.graph.nodes_dream import make_dream_node, make_snapshot_node, make_write_node
from swil_agent.graph.nodes_tail import make_logout_node
from swil_agent.graph.state import CycleState
from swil_agent.locks.file import act_lock_path
from swil_agent.models import (
    ActContext,
    Action,
    ActOutcome,
    Persona,
    Plan,
    RhythmDecision,
    RhythmPolicy,
)
from swil_agent.persona.rhythm import decide_rhythm

from ._node_modules import caller_of
from ._runners import (
    FakeEmbedder,
    FakePersonaSource,
    FakeResources,
    FakeState,
    ScriptedBackend,
    SilentBackend,
    StubBackend,
    make_cycle_deps,
    make_persona,
)

NOW = datetime(2026, 8, 17, 10, 0, 0)
# Deliberately NOT the same instant as `NOW`. Bash reads the two from
# independent `date` / `date -u` calls, and a fixture where they coincide
# cannot tell `captured_at=deps.captured_at` from `captured_at=deps.now`:
# both format to the same `capturedAt` string, so the assertion passes
# either way (review finding 8).
CAPTURED_AT = datetime(2026, 8, 17, 2, 0, 0, tzinfo=UTC)

# Cooldown markers are written RELATIVE TO `NOW`, never to the wall clock:
# `cooldown_step` is handed `deps.now`, so a marker seeded from
# `time.time()` is compared against a frozen 2026-08-17 and yields a
# NEGATIVE elapsed-hours value -- which skips for the wrong reason and stops
# discriminating the moment `dream_cooldown_hours` is what the test is about.
_AN_HOUR_BEFORE_NOW = int(NOW.timestamp()) - 3600

# Directory name and username deliberately differ everywhere in this
# file -- see the module docstring.
DIR_NAME = "zenith_dir"
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

CARD = "# 测试\n\n一个测试用的账号。"
DREAM_REPLY = '{"recent": ["一件新事", "开始觉得 @alpha 说得有道理"]}'
NEW_RECENT = ["一件新事", "开始觉得 @alpha 说得有道理"]


def _account(
    tmp_path: Path,
    *,
    dir_name: str = DIR_NAME,
    memory_text: str = "2026-08-01 | act | did a thing\n",
) -> Path:
    directory = tmp_path / "agents" / dir_name
    directory.mkdir(parents=True, exist_ok=True)
    directory.joinpath("personality.md").write_text(PERSONALITY, encoding="utf-8")
    directory.joinpath("memory.md").write_text(memory_text, encoding="utf-8")
    return directory


def _persona(
    tmp_path: Path,
    *,
    dir_name: str = DIR_NAME,
    username: str = USERNAME,
    backend: str = "claude",
    model: str | None = None,
) -> Persona:
    directory = _account(tmp_path, dir_name=dir_name)
    return make_persona(
        username=username,
        directory=directory,
        backend=backend,
        model=model,
        card=CARD,
        raw=PERSONALITY,
    )


def _deps(tmp_path: Path, **overrides: Any) -> CycleDeps:
    """`CycleDeps` with every collaborator a harmless double and every
    moment frozen, so each test overrides only what it is about."""
    defaults: dict[str, Any] = {
        "embedder": FakeEmbedder(vectors=[[1.0], [1.0]]),
        "settings": Settings(),
        "llm_model": "opus",
        "rng": random.Random(0),
        "now": NOW,
        "captured_at": CAPTURED_AT,
    }
    return make_cycle_deps(tmp_path, **(defaults | overrides))


def _plan_json(*actions: dict[str, str]) -> str:
    return json.dumps({"plan": list(actions)})


def _free_rhythm() -> RhythmDecision:
    return RhythmDecision(policy=RhythmPolicy.FREE, prefer_non_post="", guidance="- 本轮动作约束")


class TracingResources(FakeResources):
    """`FakeResources` plus an ordered, cross-method call trace -- the same
    instrument `test_act_steps.py` and `test_dream_steps.py` use, since the
    properties under test here are sequences ("synced before it read
    anything") rather than payloads."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.trace: list[str] = []
        self.event_usernames: list[str] = []

    def update_profile(self, patch: dict[str, Any]) -> None:
        self.trace.append("update_profile")
        super().update_profile(patch)

    def feed_global(self, limit: int, sort: str, since: str | None = None) -> list[dict[str, Any]]:
        self.trace.append(f"feed_global:{sort}")
        return super().feed_global(limit, sort, since)

    def notifications(self, limit: int, unread_only: bool = True) -> list[dict[str, Any]]:
        self.trace.append("notifications")
        return super().notifications(limit, unread_only)

    def contacts(self) -> list[str]:
        self.trace.append("contacts")
        return super().contacts()

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        self.trace.append("conversations")
        return super().conversations(limit)

    def create_post(
        self,
        text: str,
        board_id: str | None = None,
        image: tuple[str, bytes] | None = None,
        echo_of: str | None = None,
    ) -> str:
        self.trace.append("create_post")
        return super().create_post(text, board_id, image, echo_of)

    def mark_notifications_read(self, ids: list[str] | None = None) -> None:
        self.trace.append("mark_notifications_read")
        super().mark_notifications_read(ids)

    def create_snapshot(self, username: str, payload: dict[str, Any]) -> str:
        self.trace.append("create_snapshot")
        return super().create_snapshot(username, payload)

    def lab_event(self, username: str, event: Any) -> None:
        self.trace.append(f"lab_event:{event.type}/{event.outcome}")
        # WHO an event is filed under is a different question from whether it
        # fired: `POST /agents/{username}/events` takes the `Username` bullet,
        # while every log line in the same round takes the directory name.
        self.event_usernames.append(username)
        super().lab_event(username, event)


class ExplodingCollaborator:
    """Any attribute access at all raises.

    Stronger than "no call was recorded": a fake that records nothing is
    indistinguishable from a fake nobody asked for the recording of. This
    one fails on the ATTRIBUTE LOOKUP, so `deps.resources.contacts()` dies
    before the call even forms.
    """

    def __init__(self, label: str) -> None:
        self._label = label

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"a pure node touched {self._label}.{name}")


def _all_collaborators_explode() -> dict[str, Any]:
    """Every I/O-capable field of `CycleDeps`, replaced by a double that
    raises on any attribute access. `health_check` is a plain callable, so it
    raises when CALLED rather than when looked up."""

    def boom() -> bool:
        raise AssertionError("a pure node called health_check")

    return {
        "resources": ExplodingCollaborator("Resources"),
        "backend": ExplodingCollaborator("Backend"),
        "persona_source": ExplodingCollaborator("PersonaSource"),
        "embedder": ExplodingCollaborator("Embedder"),
        "dream_state": ExplodingCollaborator("DreamState"),
        "health_check": boom,
    }


def _spy_on(monkeypatch: pytest.MonkeyPatch, step: str) -> dict[str, Any]:
    """Record the kwargs a step is called with, then run the real step.

    The input-side instrument. A node's whole job is turning `CycleState`
    into step ARGUMENTS, so a mutation that passes the wrong argument is
    invisible to any assertion about what the node returned -- which is how
    sixteen of them survived the first mutation round. Patches
    the calling node module's own global (`caller_of`), since that is the
    name a node resolves.
    """
    real = getattr(caller_of(step), step)
    seen: dict[str, Any] = {}

    def spy(**kwargs: Any) -> Any:
        seen.update(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(caller_of(step), step, spy)
    return seen


# ── login ───────────────────────────────────────────────────────────────────


def test_the_login_node_probes_then_syncs_the_backend_then_builds_context(
    tmp_path: Path,
) -> None:
    """Probe, then the `agentBackend` PATCH, then the context reads.

    Mutation this kills: returning an empty partial, and separately, moving
    `sync_backend_step` out of this node -- deferring the sync drops the
    `agentBackend` PATCH entirely on every early-return path.
    """
    resources = TracingResources()
    persona = _persona(tmp_path)
    probes: list[str] = []

    def probe() -> bool:
        probes.append("health")
        return True

    node = make_login_node(_deps(tmp_path, resources=resources, health_check=probe))
    update = node({"persona": persona})

    assert probes == ["health"]
    assert resources.trace[0] == "update_profile"
    assert resources.profile_patches == [{"agentBackend": "claude"}]
    assert "feed_global:recommended" in resources.trace[1:]
    assert isinstance(update["context"], ActContext)
    assert isinstance(update["rhythm"], RhythmDecision)


def test_an_offline_login_node_reports_offline_and_touches_nothing(tmp_path: Path) -> None:
    """`check_internet` runs before any per-account work, so an offline
    round PATCHes nothing and reads nothing -- there is no session to build
    context against."""
    resources = TracingResources()
    node = make_login_node(_deps(tmp_path, resources=resources, health_check=lambda: False))

    update = node({"persona": _persona(tmp_path)})

    assert update["outcome"] is ActOutcome.OFFLINE
    assert "context" not in update
    assert resources.trace == []


def test_the_login_node_never_takes_the_account_lock(tmp_path: Path) -> None:
    """A node cannot hold anything across nodes (ruling R2): a live context
    manager is not serializable checkpoint state, so the graph path takes a
    `RunLease` around the WHOLE cycle and uses `login_step` for the probe
    alone.

    Mutation this kills: `with step.lock:` inside the node. It creates
    `.agent-state/lock_<name>` and -- since the node returns immediately --
    either releases it before the round it was meant to protect, or (held
    open) strands it. During stages 3-4 a concurrent Bash round then hits
    `SKIP <name> -- locked` and loses both its act and its dream.
    """
    node = make_login_node(_deps(tmp_path))

    node({"persona": _persona(tmp_path)})

    assert not act_lock_path(tmp_path, DIR_NAME).exists()
    assert not act_lock_path(tmp_path, USERNAME).exists()


def test_the_login_node_publishes_the_directory_name_as_the_accounts_identity(
    tmp_path: Path,
) -> None:
    """`agent_name` is `basename "$agent_dir"` (auto-run.sh:407), not the
    `Username` bullet, and the lease Task 8 wraps the cycle in has to be
    built from the SAME value: a lease keyed on the username computes a
    different lock path, voiding cross-runtime exclusion with every test
    green.

    Mutation this kills: `{"agent": persona.username}`.
    """
    node = make_login_node(_deps(tmp_path))

    update = node({"persona": _persona(tmp_path), "agent": USERNAME})

    assert update["agent"] == DIR_NAME
    assert agent_dir_name(_persona(tmp_path)) == DIR_NAME


def test_the_login_nodes_backend_sync_is_inert_under_dry_run(tmp_path: Path) -> None:
    """F4/Stage 3: a shadow round performs no writes, and the `agentBackend`
    PATCH is a write. Context is still built -- inspecting the plan a round
    WOULD produce is the whole point of `--dry-run`."""
    resources = TracingResources()
    node = make_login_node(_deps(tmp_path, resources=resources, dry_run=True))

    update = node({"persona": _persona(tmp_path)})

    assert resources.profile_patches == []
    assert isinstance(update["context"], ActContext)


# ── plan ────────────────────────────────────────────────────────────────────


def test_the_plan_node_asks_the_backend_with_the_rounds_rhythm_guidance(
    tmp_path: Path,
) -> None:
    """`plan_step` takes `RhythmDecision.guidance` -- one of three string
    fields, any of which typechecks. This pins that the node hands over the
    whole decision and lets the step pick, rather than picking for it.
    """
    backend = StubBackend(_plan_json({"action": "nothing"}))
    node = make_plan_node(_deps(tmp_path, backend=backend))
    rhythm = _free_rhythm()

    update = node({"persona": _persona(tmp_path), "context": ActContext(), "rhythm": rhythm})

    plan = update["plan"]
    assert plan is not None
    assert [action.kind for action in plan.actions] == ["nothing"]
    assert backend.last is not None
    assert rhythm.guidance in backend.last.user


def test_a_backend_that_produced_nothing_becomes_backend_unavailable(tmp_path: Path) -> None:
    """`plan_step` returns `None` for "the backend produced nothing at all";
    `ActOutcome.BACKEND_UNAVAILABLE` is the only act outcome besides
    `OFFLINE` that denies the account its dream, so the label has to be set
    here rather than inferred later from an absent plan."""
    node = make_plan_node(_deps(tmp_path, backend=SilentBackend()))

    update = node(
        {"persona": _persona(tmp_path), "context": ActContext(), "rhythm": _free_rhythm()}
    )

    assert update["plan"] is None
    assert update["outcome"] is ActOutcome.BACKEND_UNAVAILABLE


def test_the_plan_node_refuses_to_run_without_the_context_the_login_node_makes(
    tmp_path: Path,
) -> None:
    """A mis-wired edge is a programming error, and the failure mode without
    this guard is silent: `plan_step` would happily prompt the model with a
    blank `ActContext()` -- no feed, no notifications, no memory -- and the
    round would look like a normal quiet one."""
    node = make_plan_node(_deps(tmp_path))

    with pytest.raises(NodeStateError, match="context"):
        node({"persona": _persona(tmp_path), "rhythm": _free_rhythm()})


# ── guardrail ───────────────────────────────────────────────────────────────


def test_the_guardrail_node_performs_no_io_at_all(tmp_path: Path) -> None:
    """Spec §5.4: `guardrail` is a pure function, no I/O -- which is why it
    carries no `RetryPolicy` in Task 8's table.

    EVERY collaborator explodes, not just the two obvious ones (review
    finding 5): a node reaching for `deps.embedder`, `deps.runner`,
    `deps.persona_source` or `deps.dream_state` is doing I/O just as surely
    as one calling `Resources`, and a purity test that only guards the API
    client certifies a narrower claim than the one it makes. Each double
    raises on ATTRIBUTE ACCESS, so this fails on the lookup rather than on a
    missing recording -- a fake that records nothing is indistinguishable
    from a fake nobody asked.
    """
    deps = _deps(tmp_path, **_all_collaborators_explode())
    node = make_guardrail_node(deps)

    update = node(
        {
            "persona": _persona(tmp_path),
            "context": ActContext(),
            "rhythm": _free_rhythm(),
            "plan": Plan(actions=[Action(kind="like", post_id="a" * 24)]),
        }
    )

    assert [action.kind for action in update["actions"]] == ["like"]


def test_the_guardrail_node_hands_on_the_survivors_and_the_vetoes(tmp_path: Path) -> None:
    """§7.5: a dropped action is recorded with its reason, never filtered
    silently -- "the contacts list dropped a DM" and "the model chose to
    do nothing" must stay distinguishable. Codex is no longer allow-listed
    (loop-engine spec §7); a DM to someone not in contacts is the veto."""
    node = make_guardrail_node(_deps(tmp_path))
    plan = Plan(
        actions=[
            Action(kind="post", text="hello"),
            Action(kind="dm", username="vex", text="hi"),
        ]
    )

    update = node(
        {
            "persona": _persona(tmp_path, backend="codex"),
            "context": ActContext(),
            "rhythm": _free_rhythm(),
            "plan": plan,
        }
    )

    assert [action.kind for action in update["actions"]] == ["post"]
    assert [vetoed.action.kind for vetoed in update["vetoed"]] == ["dm"]
    assert update["solo_nothing"] is False
    assert "outcome" not in update


@pytest.mark.parametrize(
    ("plan", "expected"),
    [
        (Plan(actions=[]), ActOutcome.PLANNER_EMPTY),
        (
            Plan(actions=[Action(kind="dm", username="vex", text="hi")]),
            ActOutcome.VETOED_EMPTY,
        ),
    ],
)
def test_an_empty_plan_carries_the_reason_it_is_empty(
    tmp_path: Path, plan: Plan, expected: ActOutcome
) -> None:
    """`GuardrailStep.empty_outcome` distinguishes "guardrails dropped
    everything" from "the model proposed nothing"; both log `planned:
    nothing` under Bash. The node must carry that distinction into the state
    rather than leaving the graph to re-derive it from `vetoed`'s emptiness.
    """
    node = make_guardrail_node(_deps(tmp_path))

    update = node(
        {
            "persona": _persona(tmp_path, backend="codex"),
            "context": ActContext(),
            "rhythm": _free_rhythm(),
            "plan": plan,
        }
    )

    assert update["actions"] == []
    assert update["outcome"] is expected


def test_a_lone_nothing_survives_and_is_flagged_as_such(tmp_path: Path) -> None:
    """A solo `nothing` is EXECUTED (its lab event and log line fire) but
    labelled `PLANNER_EMPTY`. The flag has to cross to the execute node,
    which passes it to `finalize_step`."""
    node = make_guardrail_node(_deps(tmp_path))

    update = node(
        {
            "persona": _persona(tmp_path),
            "context": ActContext(),
            "rhythm": _free_rhythm(),
            "plan": Plan(actions=[Action(kind="nothing")]),
        }
    )

    assert [action.kind for action in update["actions"]] == ["nothing"]
    assert update["solo_nothing"] is True


# ── execute ─────────────────────────────────────────────────────────────────


def test_the_execute_node_executes_then_finalizes(tmp_path: Path) -> None:
    """One node for `execute_step` + `finalize_step`, because §5.4's topology
    has no `finalize` node. The mark-read is the observable half of the
    second step -- it is gated on `landed > 0` (`auto-run.sh:768-803`), so a
    node that stopped after `execute_step` would leave every responded
    notification unread forever.
    """
    resources = TracingResources()
    resources.notification_items = [
        {"id": "n1", "type": "comment", "post": {"id": "a" * 24}},
    ]
    node = make_execute_node(_deps(tmp_path, resources=resources))

    update = node(
        {
            "persona": _persona(tmp_path),
            "actions": [Action(kind="comment", post_id="a" * 24, text="hi")],
            "solo_nothing": False,
        }
    )

    assert update["attempted"] == 1
    assert update["landed"] == 1
    assert update["outcome"] is ActOutcome.LANDED_ALL
    assert [result.landed for result in update["results"]] == [True]
    assert resources.marked_read == [["n1"]]


def test_the_execute_node_is_completely_inert_under_dry_run(tmp_path: Path) -> None:
    """Constraint the whole Stage-3 shadow round rests on: `execute_step`
    performs 100% of a round's writes and `finalize_step` performs the
    mark-read. A node that threaded `dry_run` into neither posts for real
    across 23 live accounts.

    Mutation this kills: dropping `dry_run=deps.dry_run` from either call.
    Without it on `execute_step` the post lands; without it on
    `finalize_step` the round logs `FAIL <agent> — all 0 planned actions
    failed`, 23 spurious FAIL lines per round in the very log the canary is
    judged from.
    """
    resources = TracingResources()
    node = make_execute_node(_deps(tmp_path, resources=resources, dry_run=True))
    memory = tmp_path / "agents" / DIR_NAME / "memory.md"
    _account(tmp_path)
    before = memory.read_text(encoding="utf-8")

    update = node(
        {
            "persona": _persona(tmp_path),
            "actions": [Action(kind="post", text="hello")],
            "solo_nothing": False,
        }
    )

    assert resources.calls == []
    assert resources.marked_read == []
    assert memory.read_text(encoding="utf-8") == before
    assert update["attempted"] == 0
    assert update["results"] == []
    assert update["outcome"] is ActOutcome.LANDED_ALL


def test_the_execute_node_names_the_directory_in_the_round_it_logs(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Every identifier in a round is the directory name; `persona.username`
    is only ever the `Username` bullet. A node passing the wrong one still
    executes correctly and mislabels every log line -- which is how a
    `humans/` account shadowed by a stray `agents/<name>` dir becomes
    untraceable.
    """
    node = make_execute_node(_deps(tmp_path))

    with caplog.at_level(logging.INFO, logger="swil_agent.act.executor"):
        node(
            {
                "persona": _persona(tmp_path),
                "actions": [Action(kind="like", post_id="a" * 24)],
                "solo_nothing": False,
            }
        )

    assert f"DONE {DIR_NAME} liked" in caplog.text
    assert f"DONE {USERNAME} liked" not in caplog.text


def test_the_execute_node_does_not_turn_an_empty_plan_into_a_failed_round(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """`run_act`'s item 7 is an early return, not a step: an empty plan
    executes nothing and keeps the outcome `guardrail_step` already decided.
    The graph's equivalent is an edge, and this is the belt to that
    braces -- entered by mistake, the node must not run `finalize_step` and
    turn `VETOED_EMPTY` into `LANDED_PARTIAL` plus a FAIL line.
    """
    resources = TracingResources()
    node = make_execute_node(_deps(tmp_path, resources=resources))

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        update = node(
            {"persona": _persona(tmp_path), "actions": [], "outcome": ActOutcome.VETOED_EMPTY}
        )

    assert update == {}
    assert "FAIL" not in caplog.text
    assert resources.calls == []


# ── dream ───────────────────────────────────────────────────────────────────


def test_the_dream_node_carries_the_new_list_forward(tmp_path: Path) -> None:
    """`recent` is the dream node's one product; the write and snapshot nodes
    both read it from the state. The memory comes from the INJECTED source
    (`cooldown_step`'s read), not from the file on disk."""
    source = FakePersonaSource()
    source.memory[DIR_NAME] = "2026-08-01 | act | INJECTED-MEMORY-MARKER\n"
    backend = StubBackend(DREAM_REPLY)
    node = make_dream_node(_deps(tmp_path, persona_source=source, backend=backend))

    update = node({"persona": _persona(tmp_path)})

    assert update["proceeded"] is True
    assert update["recent"] == NEW_RECENT
    assert backend.last is not None
    assert "INJECTED-MEMORY-MARKER" in backend.last.user


def test_a_cooled_down_account_never_reaches_the_backend(tmp_path: Path) -> None:
    """The cooldown gate is inside this node, so a SKIPped account costs no
    LLM call -- and the SKIP line `cooldown_step` logs is the only record
    that the round happened and declined."""
    state = FakeState()
    state.record_dream(DIR_NAME, at=_AN_HOUR_BEFORE_NOW)
    backend = ScriptedBackend(DREAM_REPLY)
    node = make_dream_node(_deps(tmp_path, dream_state=state, backend=backend, auto=True))

    update = node({"persona": _persona(tmp_path)})

    assert update["proceeded"] is False
    assert "cooldown" in update["dream_reason"]
    assert backend.calls == []
    assert "recent" not in update


def test_an_empty_reply_is_reported_as_the_dreams_reason(tmp_path: Path) -> None:
    """A dead backend fails the dream; the reason belongs in the state so the
    cycle's summary can say why nothing was written."""
    node = make_dream_node(_deps(tmp_path, backend=SilentBackend()))

    update = node({"persona": _persona(tmp_path)})

    assert update["proceeded"] is True
    assert update["dream_reason"] == "LLM returned empty"
    assert "recent" not in update


# ── write ───────────────────────────────────────────────────────────────────


def test_the_write_node_hands_a_missing_list_to_the_step_rather_than_skipping_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The composition-shape pin, on the NODE path: `recent=None` is THREADED
    into `write_step`, whose own guard is what keeps a failed dream off disk.
    `nodes_dream.py` binds `write_step` into its own globals, so this spy is the
    only one that sees the node's call."""
    seen = _spy_on(monkeypatch, "write_step")
    source = FakePersonaSource()
    node = make_write_node(_deps(tmp_path, persona_source=source))

    update = node({"persona": _persona(tmp_path)})

    assert seen["recent"] is None
    assert update == {"written": False}
    assert source.written == []


def test_the_write_node_keys_the_write_and_the_marker_on_the_directory_name(
    tmp_path: Path,
) -> None:
    """`write_recent` and `last_dream_<name>` both take the DIRECTORY name."""
    state = FakeState()
    source = FakePersonaSource()
    node = make_write_node(_deps(tmp_path, dream_state=state, persona_source=source))

    update = node({"persona": _persona(tmp_path), "recent": NEW_RECENT})

    assert update == {"written": True}
    assert source.written[0][0] == DIR_NAME
    assert state.last_dream_ts(DIR_NAME) == int(NOW.timestamp())
    assert state.last_dream_ts(USERNAME) is None


def test_the_write_node_is_inert_under_a_dry_run(tmp_path: Path) -> None:
    """A shadow round writes NOTHING. `write_step` takes no `dry_run`, so
    this node is the closest place to the write that can carry the guard:
    with it deleted, one mis-drawn edge rewrites a real `personality.md`."""
    source = FakePersonaSource()
    state = FakeState()
    node = make_write_node(_deps(tmp_path, dry_run=True, persona_source=source, dream_state=state))

    update = node({"persona": _persona(tmp_path), "recent": NEW_RECENT})

    assert update == {"written": False}
    assert source.written == []
    assert source.appended == []
    assert state.last_dream_ts(DIR_NAME) is None


def test_the_snapshot_node_is_inert_under_a_dry_run(tmp_path: Path) -> None:
    """The other half: a snapshot is a PUBLISHED claim about what this
    account's `personality.md` now says. Uploading one during a shadow round
    puts a row in `personalitysnapshots` for a document that was never
    written.

    `written=True` is supplied deliberately: the dry-run guard must not
    depend on the write node having already declined.
    """
    resources = TracingResources()
    embedder = FakeEmbedder(vectors=[[1.0]])
    node = make_snapshot_node(_deps(tmp_path, dry_run=True, resources=resources, embedder=embedder))

    update = node({"persona": _persona(tmp_path), "recent": NEW_RECENT, "written": True})

    assert update["snapshot_ok"] is False
    assert update["snapshot_reason"] is None
    assert resources.snapshots == []
    assert embedder.call_count == 0


# ── snapshot ────────────────────────────────────────────────────────────────


def test_the_list_survives_the_hand_off_from_the_write_node_to_the_snapshot_node(
    tmp_path: Path,
) -> None:
    """The whole chain across a node boundary: the list the dream produced is
    written, then embedded and uploaded as the card plus that list.

    Mutation this kills: the snapshot node reading anything other than the
    state's `recent` -- the vector would then describe a document the file
    does not hold.
    """
    persona = _persona(tmp_path)
    resources = TracingResources()
    embedder = FakeEmbedder(vectors=[[0.5]])
    deps = _deps(tmp_path, resources=resources, embedder=embedder)
    state: CycleState = {"persona": persona, "recent": NEW_RECENT}

    state.update(make_write_node(deps)(state))  # type: ignore[typeddict-item]
    state.update(make_snapshot_node(deps)(state))  # type: ignore[typeddict-item]

    assert state["snapshot_ok"] is True
    assert embedder.embedded == [[snapshot_content(persona, NEW_RECENT)]]
    assert "一件新事" in embedder.embedded[0][0]
    _, payload = resources.snapshots[0]
    assert "diffNarrative" not in payload
    assert "aspectDrift" not in payload


def test_the_snapshot_node_publishes_nothing_when_no_write_happened(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A snapshot is a CLAIM about what `personality.md` now says. Publishing
    one for a refused write puts a row in `personalitysnapshots` for a
    document that never existed.

    The spy is the node-path half of the same shape pin as the write node's:
    `written=False` must be THREADED IN, so the step's own guard stays the
    load-bearing one.
    """
    resources = TracingResources()
    real_snapshot = nodes_dream.snapshot_step
    seen: dict[str, Any] = {}

    def spy_snapshot(**kwargs: Any) -> Any:
        seen.update(kwargs)
        return real_snapshot(**kwargs)

    monkeypatch.setattr(nodes_dream, "snapshot_step", spy_snapshot)
    node = make_snapshot_node(_deps(tmp_path, resources=resources))

    update = node({"persona": _persona(tmp_path), "recent": NEW_RECENT, "written": False})

    assert seen["written"] is False
    assert update["snapshot_ok"] is False
    assert update["snapshot_reason"] is None
    assert resources.snapshots == []


def test_a_failed_upload_reports_the_servers_own_reason(tmp_path: Path) -> None:
    """Never a hardcoded guess: the 2026-07-31 incident cost two
    investigations chasing a healthy server while "no api_key.txt for
    <name>" was already printed one line above."""
    embedder = FakeEmbedder(fail_always=True)
    node = make_snapshot_node(_deps(tmp_path, embedder=embedder))

    update = node({"persona": _persona(tmp_path), "recent": NEW_RECENT, "written": True})

    assert update["snapshot_ok"] is False
    assert update["snapshot_reason"] is not None
    assert "fake embedder" in update["snapshot_reason"]


# ── logout ──────────────────────────────────────────────────────────────────


def test_the_logout_node_records_the_round_it_is_closing(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """There is no session artefact left to clear -- what remains is §7.6's
    terminal record, carrying `run_id` and the outcome. Without it a cycle
    that ends has no line saying so, and "did this account run at all"
    becomes unanswerable from the log.
    """
    node = make_logout_node(_deps(tmp_path))

    with caplog.at_level(logging.INFO, logger="swil_agent.graph.nodes"):
        update = node(
            {
                "persona": _persona(tmp_path),
                "run_id": "run-7",
                "outcome": ActOutcome.LANDED_ALL,
                "written": True,
                "snapshot_ok": True,
            }
        )

    assert update == {}
    assert "run-7" in caplog.text
    assert DIR_NAME in caplog.text
    assert "landed_all" in caplog.text
    # The True side of the pair: without these, a node hardcoding
    # `dream_written=False` / `snapshot_ok=False` passes both logout tests --
    # the shadow-round test below reports exactly those values legitimately.
    assert "dream_written=True" in caplog.text
    assert "snapshot_ok=True" in caplog.text


def test_the_logout_node_releases_nothing_the_lease_owns(tmp_path: Path) -> None:
    """The lease wraps the WHOLE cycle (ruling R2) and is the only thing
    entitled to unlink the lock file. A logout node that "tidied up" would
    hand a live successor a lock it does not hold -- the ABA hole Task 3's
    review closed inside `RunLease`, reopened one layer up.
    """
    lock_path = act_lock_path(tmp_path, DIR_NAME)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text(str(os.getpid()), encoding="utf-8")
    # The logout node files the `cycle_run` card, so `Resources` is a recording
    # fake rather than an exploding one; the file is the claim under test.
    resources = FakeResources()
    node = make_logout_node(_deps(tmp_path, resources=resources))

    node({"persona": _persona(tmp_path), "run_id": "run-7"})

    assert lock_path.exists()
    assert len(resources.lab_events) == 1


# ── every node ──────────────────────────────────────────────────────────────


def test_every_node_returns_a_partial_never_the_whole_state(tmp_path: Path) -> None:
    """`CycleState` is `total=False` precisely so a node can return only what
    it changed and let LangGraph merge. A node echoing its input back would
    still pass every test above -- and would overwrite, on every hop, fields
    a concurrent branch had updated.
    """
    persona = _persona(tmp_path)
    deps = _deps(tmp_path)
    inputs: CycleState = {
        "persona": persona,
        "tenant": "builtin",
        "agent": DIR_NAME,
        "run_id": "run-7",
        "context": ActContext(),
        "rhythm": _free_rhythm(),
    }

    for factory in (make_login_node, make_plan_node, make_guardrail_node):
        update = factory(deps)({**inputs, "plan": Plan(actions=[Action(kind="nothing")])})
        assert "persona" not in update
        assert "tenant" not in update
        assert "run_id" not in update


# ── what the nodes PASS IN ──────────────────────────────────────────────────
#
# Everything above this line perturbs what a node RETURNS. A node whose whole
# job is adapting state to step arguments is broken by breaking the
# ARGUMENTS, and the review found sixteen such mutations alive against the
# first round of this file. Three were HIGH: a mislabelled solo-`nothing`
# round, every dream prompt built with no memory, and every round planning
# blind.


def test_the_execute_node_hands_finalize_the_solo_nothing_flag_it_was_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A surviving lone `nothing` still EXECUTES, but its outcome is
    `PLANNER_EMPTY`, not the landed/attempted formula's `LANDED_ALL`.

    Mutation this kills: `solo_nothing=False` hardcoded in the execute node.
    Nothing else notices -- the action still runs, its lab event still fires,
    the tally is still 1/1 -- and the round is relabelled as "the model
    acted" when the model explicitly chose to be quiet. That is exactly the
    distinction §7.5 exists to make legible, and the drift experiment reads
    the label, not the action list.
    """
    seen = _spy_on(monkeypatch, "finalize_step")
    node = make_execute_node(_deps(tmp_path))

    update = node(
        {
            "persona": _persona(tmp_path),
            "actions": [Action(kind="nothing")],
            "solo_nothing": True,
        }
    )

    assert seen["solo_nothing"] is True
    assert update["outcome"] is ActOutcome.PLANNER_EMPTY
    assert update["attempted"] == 1


def test_the_dream_node_prompts_from_the_memory_the_cooldown_step_read(
    tmp_path: Path,
) -> None:
    """`dream_step` must be handed `cooldown_step`'s read of `memory.md`, not
    the act path's `deps.memory_text` snapshot. With the wrong one every
    dream on the roster is prompted from an act-side snapshot -- for a
    dream-only cycle, an empty one."""
    source = FakePersonaSource()
    source.memory[DIR_NAME] = "2026-08-01 | act | DREAM-SIDE-MEMORY-MARKER\n"
    backend = ScriptedBackend(DREAM_REPLY)
    node = make_dream_node(
        _deps(tmp_path, persona_source=source, backend=backend, memory_text="ACT-SIDE-SNAPSHOT")
    )

    node({"persona": _persona(tmp_path)})

    assert len(backend.calls) == 1
    assert "DREAM-SIDE-MEMORY-MARKER" in backend.calls[0].user
    assert "ACT-SIDE-SNAPSHOT" not in backend.calls[0].user


def test_the_login_node_threads_every_prompt_input_into_the_context(
    tmp_path: Path,
) -> None:
    """`context_step` takes three strings the composition root read off disk
    -- `memory_text`, `context_now`, `feed_context` -- and each has a
    harmless-looking default.

    Mutation this kills: passing any of them as its default instead of the
    dep. Every round would then plan BLIND: no `context/now.md`, no
    follow-topic feed, and -- through `memory_text` -- no recent memory plus
    a `today_post_count` of 0, which also hands the rhythm gate the wrong
    number and lets an account post past its daily ceiling. `run_act`'s
    oracle cannot see it; only the assembled `ActContext` can.
    """
    memory_text = f"{NOW:%Y-%m-%d} | post | MEMORY-MARKER newpost0000000000000000\n"
    node = make_login_node(
        _deps(
            tmp_path,
            memory_text=memory_text,
            context_now="CTX-NOW-MARKER",
            feed_context="FEED-CONTEXT-MARKER",
        )
    )

    update = node({"persona": _persona(tmp_path)})

    context = update["context"]
    assert context is not None
    assert context.context_now == "CTX-NOW-MARKER"
    assert context.feed_context == "FEED-CONTEXT-MARKER"
    assert "MEMORY-MARKER" in context.recent_memory
    assert context.today_post_count == 1


def test_the_execute_node_reports_attempts_and_landings_separately(tmp_path: Path) -> None:
    """A round where the two numbers DIFFER. Without one, transposing them is
    undetectable -- and `landed`/`attempted` is the formula the outcome and
    every operator-facing tally are built on."""
    resources = TracingResources(like_raises=ApiError(500, "boom", None))
    node = make_execute_node(_deps(tmp_path, resources=resources))

    update = node(
        {
            "persona": _persona(tmp_path),
            "actions": [
                Action(kind="post", text="hello"),
                Action(kind="like", post_id="a" * 24),
            ],
            "solo_nothing": False,
        }
    )

    assert update["attempted"] == 2
    assert update["landed"] == 1
    assert update["outcome"] is ActOutcome.LANDED_PARTIAL


@pytest.mark.parametrize(
    ("factory", "missing", "extra"),
    [
        (make_plan_node, "context", {"rhythm": _free_rhythm()}),
        (make_plan_node, "rhythm", {"context": ActContext()}),
        (make_guardrail_node, "plan", {"context": ActContext(), "rhythm": _free_rhythm()}),
        (make_guardrail_node, "context", {"plan": Plan(), "rhythm": _free_rhythm()}),
        (make_guardrail_node, "rhythm", {"plan": Plan(), "context": ActContext()}),
    ],
)
def test_a_node_entered_without_a_value_it_needs_says_which(
    tmp_path: Path, factory: Any, missing: str, extra: dict[str, Any]
) -> None:
    """Every `_require` call site, one param each.

    100% line coverage hid the gap: `_require` is ONE function, so exercising
    two of its call sites lights up every line of it and says nothing about
    the others. Each has a silent alternative -- planning
    against a blank context -- and the whole point of the guard is that a mis-wired edge is
    loud rather than plausible.
    """
    node = factory(_deps(tmp_path))

    with pytest.raises(NodeStateError, match=missing):
        node({"persona": _persona(tmp_path), **extra})


# ── the frozen cycle values ─────────────────────────────────────────────────


def test_the_execute_node_dates_the_memory_line_with_the_cycles_now(tmp_path: Path) -> None:
    """`deps.now` is frozen for the cycle. A node calling `datetime.now()`
    itself dates the memory line by the wall clock at the moment that node
    ran -- which for a cycle spanning midnight files the act under one day
    and the dream under the next, while `posts_today` counts by date prefix.
    """
    persona = _persona(tmp_path)
    node = make_execute_node(_deps(tmp_path))

    node(
        {
            "persona": persona,
            "actions": [Action(kind="like", post_id="a" * 24)],
            "solo_nothing": False,
        }
    )

    memory = persona.directory.joinpath("memory.md").read_text(encoding="utf-8")
    assert f"{NOW:%Y-%m-%d} | like |" in memory


def test_the_write_node_stamps_the_write_and_the_marker_with_the_cycles_now(
    tmp_path: Path,
) -> None:
    """The same frozen moment reaches BOTH of `write_step`'s time-carrying
    writes: the archive stamp, and the `last_dream_<name>` epoch marker the
    next round's cooldown is measured from."""
    source = FakePersonaSource()
    dream_state = FakeState()
    node = make_write_node(_deps(tmp_path, persona_source=source, dream_state=dream_state))

    node({"persona": _persona(tmp_path), "recent": NEW_RECENT})

    assert source.written[0][2] == NOW
    assert dream_state.last_dream_ts(DIR_NAME) == int(NOW.timestamp())
    assert source.appended == [(DIR_NAME, f"{NOW:%Y-%m-%d} | dream | 最近已更新")]


def test_the_snapshot_node_stamps_captured_at_from_the_cycle(tmp_path: Path) -> None:
    """`captured_at` is a SEPARATE UTC moment from `now` (Bash reads them
    from two independent `date` / `date -u` calls). A node substituting `now`
    stamps every snapshot in local time while still claiming the `Z`."""
    resources = TracingResources()
    node = make_snapshot_node(_deps(tmp_path, resources=resources))

    node({"persona": _persona(tmp_path), "recent": NEW_RECENT, "written": True})

    _, payload = resources.snapshots[0]
    assert payload["capturedAt"] == "2026-08-17T02:00:00Z"


def test_the_login_node_rolls_the_rhythm_with_the_injected_rng(tmp_path: Path) -> None:
    """§6.3: randomness must be INJECTABLE, or a round is unreproducible and
    the rhythm gate untestable. The roll has to come from `deps.rng`, never
    from a `random.Random()` the node makes for itself."""
    settings = Settings()
    expected = decide_rhythm(
        0,
        random.Random(7),
        probability=settings.post_probability,
        ceiling=settings.post_ceiling_per_day,
    )
    node = make_login_node(_deps(tmp_path, rng=random.Random(7), settings=settings))

    update = node({"persona": _persona(tmp_path)})

    rhythm = update["rhythm"]
    assert rhythm is not None
    assert rhythm.roll == expected.roll
    assert rhythm.policy is expected.policy


def test_the_action_budget_reaches_both_the_context_and_the_guardrails(
    tmp_path: Path,
) -> None:
    """One number, two consumers: it is shown to the model
    (`ActContext.action_budget`) and enforced afterwards (`apply_guardrails`).
    A node letting either fall back to the default 5 would promise the model
    a budget the guardrails then cut, or cap a round the model was told it
    could fill."""
    deps = _deps(tmp_path, budget=2)
    persona = _persona(tmp_path)

    context = make_login_node(deps)({"persona": persona})["context"]
    assert context is not None
    assert context.action_budget == 2

    update = make_guardrail_node(deps)(
        {
            "persona": persona,
            "context": ActContext(),
            "rhythm": _free_rhythm(),
            "plan": Plan(
                actions=[
                    Action(kind="like", post_id="a" * 24),
                    Action(kind="like", post_id="b" * 24),
                    Action(kind="like", post_id="c" * 24),
                ]
            ),
        }
    )
    assert len(update["actions"]) == 2


def test_a_forced_cycle_dreams_through_a_live_cooldown(tmp_path: Path) -> None:
    """`auto` is the difference between `dream <name>` and `dream <name>
    --auto`: force mode never consults the markers at all. A node
    hardcoding `auto=True` turns every manual dream into a cooldown-gated
    one; hardcoding `False` breaks the 12h floor for the whole roster."""
    persona = _persona(tmp_path)
    dream_state = FakeState()
    dream_state.record_dream(DIR_NAME, at=_AN_HOUR_BEFORE_NOW)
    node = make_dream_node(
        _deps(
            tmp_path,
            dream_state=dream_state,
            backend=ScriptedBackend(DREAM_REPLY),
            auto=False,
        )
    )

    update = node({"persona": persona})

    assert update["proceeded"] is True
    assert update["recent"] == NEW_RECENT


def test_the_cooldown_window_comes_from_the_cycles_settings(tmp_path: Path) -> None:
    """`Settings` is a dep, not a module-level read: `DREAM_COOLDOWN_HOURS`
    is documented as tunable per environment, and a node resolving its own
    `Settings()` would ignore whatever the operator set for this run."""
    persona = _persona(tmp_path)
    dream_state = FakeState()
    dream_state.record_dream(DIR_NAME, at=_AN_HOUR_BEFORE_NOW)
    node = make_dream_node(
        _deps(
            tmp_path,
            dream_state=dream_state,
            backend=ScriptedBackend(DREAM_REPLY),
            settings=Settings(dream_cooldown_hours=0),
            auto=True,
        )
    )

    update = node({"persona": persona})

    assert update["proceeded"] is True


def test_the_execute_node_forwards_the_cycles_image_credential(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`access_key` is a credential from the composition root. Substituting
    `None` is SILENT: `execute_action` falls back to Picsum, every image post
    still lands, and the roster quietly stops using Unsplash. Asserted on the
    step's argument because the fallback leaves no other trace."""
    seen = _spy_on(monkeypatch, "execute_step")
    node = make_execute_node(_deps(tmp_path, access_key="unsplash-key"))

    node(
        {
            "persona": _persona(tmp_path),
            "actions": [Action(kind="like", post_id="a" * 24)],
            "solo_nothing": False,
        }
    )

    assert seen["access_key"] == "unsplash-key"


# ── the argument table's remaining rows ─────────────────────────────────────
#
# The second review's diagnosis: the input-side instrument had been applied to
# eight NAMED sites instead of generalised, so the same class stayed open one
# node downstream. These close it. The full node -> step -> argument table is
# in the task report; every row below is one of its cells, and the derivation
# is from the step SIGNATURES rather than from any review's list, so a row
# nobody has flagged yet is covered too.


def test_the_write_node_writes_the_list_from_the_state(tmp_path: Path) -> None:
    """Mutation this kills: the node writing `persona.recent` (the OLD list)
    instead of the state's new one -- `personality.md` would never change
    while the snapshot node uploads the new list."""
    source = FakePersonaSource()
    persona = _persona(tmp_path).model_copy(update={"recent": ["一件旧事"]})
    node = make_write_node(_deps(tmp_path, persona_source=source))

    node({"persona": persona, "recent": NEW_RECENT})

    assert source.written[0][1] == NEW_RECENT


def test_the_plan_node_prompts_with_the_context_the_login_node_built(
    tmp_path: Path,
) -> None:
    """The previous round's HIGH finding, one node downstream: `context` is
    threaded from state into `plan_step`, and a blank `ActContext()` there is
    a model planning with no feed, no notifications and no memory -- a round
    that reads as quiet rather than broken.

    Also pins `persona`, whose only externally visible effect on this call is
    `CompletionRequest.model` -- the model tier, i.e. the drift experiment's
    independent variable.
    """
    backend = StubBackend(_plan_json({"action": "nothing"}))
    persona = _persona(tmp_path, model="haiku")
    node = make_plan_node(_deps(tmp_path, backend=backend))

    node(
        {
            "persona": persona,
            "context": ActContext(context_now="CTX-IN-THE-PROMPT"),
            "rhythm": _free_rhythm(),
        }
    )

    assert backend.last is not None
    assert "CTX-IN-THE-PROMPT" in backend.last.user
    assert backend.last.model == "haiku"


def test_the_guardrail_node_judges_dms_against_the_contacts_in_the_context(
    tmp_path: Path,
) -> None:
    """`context` reaches `guardrail_step` for exactly one reason: its
    `contacts` list decides which `dm` recipients are reachable.

    Mutation this kills: `context=ActContext()`. Every `dm` on the roster is
    then dropped as "dm recipient not in contacts" -- recorded in `vetoed`
    and logged as a legitimate guardrail decision, which is the worst shape a
    bug can take. `apply_guardrails` gets the contacts the PLANNER saw, never
    a fresh read, for the same reason.
    """
    node = make_guardrail_node(_deps(tmp_path))

    update = node(
        {
            "persona": _persona(tmp_path),
            "context": ActContext(contacts=["alice"]),
            "rhythm": _free_rhythm(),
            "plan": Plan(actions=[Action(kind="dm", username="alice", text="hi")]),
        }
    )

    assert [action.kind for action in update["actions"]] == ["dm"]
    assert update["vetoed"] == []


def test_the_guardrail_node_enforces_the_rhythm_policy_it_was_given(
    tmp_path: Path,
) -> None:
    """`rhythm` reaches `guardrail_step` as the POLICY -- not the guidance
    the plan node picks off the same object. A `no_post` round must actually
    drop the post: rhythm enforcement is the asymmetry §6.2 pins, and a node
    substituting a free rhythm would let every account post straight through
    its own quiet window."""
    node = make_guardrail_node(_deps(tmp_path))

    update = node(
        {
            "persona": _persona(tmp_path),
            "context": ActContext(),
            "rhythm": RhythmDecision(
                policy=RhythmPolicy.NO_POST, prefer_non_post="like", guidance="- 禁止 post"
            ),
            "plan": Plan(
                actions=[
                    Action(kind="post", text="hello"),
                    Action(kind="like", post_id="a" * 24),
                ]
            ),
        }
    )

    assert [action.kind for action in update["actions"]] == ["like"]
    assert [vetoed.reason for vetoed in update["vetoed"]] == ["rhythm policy no_post"]


def test_the_snapshot_node_paths_the_archive_relative_to_the_agent_root(
    tmp_path: Path,
) -> None:
    """`archivePath` is the account's `personality.md` relative to
    `agent_root`. Substituting `persona.directory` collapses the path to a
    bare filename. `contentHash` in the same assertion pins the hashed text:
    the card plus the NEW list."""
    resources = TracingResources()
    persona = _persona(tmp_path)
    node = make_snapshot_node(_deps(tmp_path, resources=resources))

    node({"persona": persona, "recent": NEW_RECENT, "written": True})

    _, payload = resources.snapshots[0]
    assert payload["archivePath"] == f"agents/{DIR_NAME}/personality.md"
    expected = snapshot_content(persona, NEW_RECENT)
    assert payload["contentHash"] == hashlib.sha256(expected.encode()).hexdigest()


def test_the_logout_record_describes_a_shadow_round_as_a_shadow_round(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Three of the six fields in §7.6's terminal record are hardcodable
    without breaking anything else, and `dry_run` is the dangerous one: a
    hardcoded `False` makes every shadow round read as a REAL round in the
    log.

    The complement of `…records_the_round_it_is_closing`, which reports the
    opposite value for all three -- one test alone cannot tell a threaded
    field from a constant.
    """
    node = make_logout_node(_deps(tmp_path, dry_run=True))

    with caplog.at_level(logging.INFO, logger="swil_agent.graph.nodes"):
        node(
            {
                "persona": _persona(tmp_path),
                "run_id": "run-9",
                "outcome": ActOutcome.PLANNER_EMPTY,
                "written": False,
                "snapshot_ok": False,
            }
        )

    assert "dry_run=True" in caplog.text
    assert "dream_written=False" in caplog.text
    assert "snapshot_ok=False" in caplog.text
    assert "planner_empty" in caplog.text


def test_the_logout_records_two_flags_cannot_be_transposed(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """`dream_written` and `snapshot_ok` are both booleans in the same call,
    so swapping the two ARGUMENTS is invisible to every test that reports the
    same value for both -- and the two existing logout tests do exactly that
    (True/True and False/False).

    They answer different questions: `dream_written` is "did `personality.md`
    change", `snapshot_ok` is "did the row reach `personalitysnapshots`". A
    transposition makes a round whose snapshot upload failed read as one whose
    personality never changed.
    """
    node = make_logout_node(_deps(tmp_path))

    with caplog.at_level(logging.INFO, logger="swil_agent.graph.nodes"):
        node(
            {
                "persona": _persona(tmp_path),
                "run_id": "run-11",
                "outcome": ActOutcome.LANDED_ALL,
                "written": True,
                "snapshot_ok": False,
            }
        )

    assert "dream_written=True" in caplog.text
    assert "snapshot_ok=False" in caplog.text


# ── the dry-run guard, at every node of the dream phase ────────────────────


def test_the_dream_node_is_inert_under_a_dry_run(tmp_path: Path) -> None:
    """`dream_step` posts a `dream/started` lab event and spends an LLM call;
    a shadow round must do neither."""
    resources = TracingResources()
    backend = ScriptedBackend(DREAM_REPLY)
    node = make_dream_node(_deps(tmp_path, dry_run=True, resources=resources, backend=backend))

    update = node({"persona": _persona(tmp_path)})

    assert update["proceeded"] is False
    assert "recent" not in update
    assert resources.lab_events == []
    assert backend.calls == []


def test_a_round_where_nothing_landed_names_the_directory_in_its_fail_line(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """`finalize_step`'s `agent_name`, whose only observable use is this line
    -- and whose docstring records this exact bug being fixed once already
    (fix round 1, item 2: that one call passed `persona.username` while every
    other identifier in the round was the directory)."""
    resources = TracingResources(like_raises=ApiError(500, "boom", None))
    node = make_execute_node(_deps(tmp_path, resources=resources))

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        update = node(
            {
                "persona": _persona(tmp_path),
                "actions": [Action(kind="like", post_id="a" * 24)],
                "solo_nothing": False,
            }
        )

    assert update["landed"] == 0
    assert f"FAIL {DIR_NAME} — all 1 planned actions failed" in caplog.text


def test_a_failed_backend_sync_names_the_directory_it_failed_for(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """`sync_backend_step`'s `agent_name`, same story: its only observable
    use is the WARN line, and that line exists because a bare `|| true` once
    hid a 403 for months. A WARN naming an account nobody can find in the
    roster is barely an improvement."""
    resources = TracingResources(update_profile_raises=ApiError(403, "forbidden", None))
    node = make_login_node(_deps(tmp_path, resources=resources))

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        node({"persona": _persona(tmp_path)})

    assert f"WARN {DIR_NAME} — agentBackend sync failed" in caplog.text


def test_the_backend_sync_carries_the_personas_model_tier(tmp_path: Path) -> None:
    """`persona` reaches `sync_backend_step` and the PATCH body is derived
    from it -- `<backend>:<model>`, never a literal. `agentBackend` is the
    drift experiment's independent variable and the tier is the half that
    varies across the roster."""
    resources = TracingResources()
    node = make_login_node(_deps(tmp_path, resources=resources))

    node({"persona": _persona(tmp_path, backend="claude", model="haiku")})

    assert resources.profile_patches == [{"agentBackend": "claude:haiku"}]


def test_an_absent_written_flag_publishes_nothing(tmp_path: Path) -> None:
    """`state.get("written", False)`: the DEFAULT, exercised by leaving the
    key out entirely. Every other test supplies it, so flipping the fallback
    to `True` survives them all -- and a `True` default publishes a snapshot
    for a round that never wrote, the fabricated-row failure the threading
    exists to prevent."""
    resources = TracingResources()
    node = make_snapshot_node(_deps(tmp_path, resources=resources))

    update = node({"persona": _persona(tmp_path), "recent": NEW_RECENT})

    assert update["snapshot_ok"] is False
    assert resources.snapshots == []


def test_an_absent_solo_nothing_flag_is_not_a_quiet_round(tmp_path: Path) -> None:
    """`state.get("solo_nothing", False)`: a `True` fallback would label
    every round reaching this node `PLANNER_EMPTY` -- "the model chose to be
    quiet" -- including rounds where it posted."""
    node = make_execute_node(_deps(tmp_path))

    update = node(
        {
            "persona": _persona(tmp_path),
            "actions": [Action(kind="like", post_id="a" * 24)],
        }
    )

    assert update["outcome"] is ActOutcome.LANDED_ALL


def test_every_lab_event_is_filed_under_the_username_not_the_directory(
    tmp_path: Path,
) -> None:
    """`persona.username` is what `POST /agents/{username}/events` and the
    snapshot upload take, while every log line takes the directory name.

    Drives the whole dream path through its three nodes, which also proves
    the hand-offs compose: recent -> written -> upload.
    """
    resources = TracingResources()
    deps = _deps(
        tmp_path,
        resources=resources,
        backend=ScriptedBackend(DREAM_REPLY),
        embedder=FakeEmbedder(vectors=[[0.5]]),
    )
    state: CycleState = {"persona": _persona(tmp_path)}

    for factory in (make_dream_node, make_write_node, make_snapshot_node):
        state.update(factory(deps)(state))  # type: ignore[typeddict-item]

    assert state["written"] is True
    assert state["snapshot_ok"] is True
    assert set(resources.event_usernames) == {USERNAME}
    assert resources.snapshots[0][0] == USERNAME


def test_the_execute_nodes_lab_events_are_filed_under_the_username_too(
    tmp_path: Path,
) -> None:
    """The act path's half of the same distinction: `execute_action` takes
    `agent_name` (the directory, for the log line) AND `username` (for the
    event endpoint), and the execute node is where both are chosen."""
    resources = TracingResources()
    node = make_execute_node(_deps(tmp_path, resources=resources))

    node(
        {
            "persona": _persona(tmp_path),
            "actions": [Action(kind="like", post_id="a" * 24)],
            "solo_nothing": False,
        }
    )

    assert set(resources.event_usernames) == {USERNAME}


# ── S2 §4: the execute node files post vectors under the cycle's round id ──


class _PerTextEmbedder:
    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0] for _ in texts]


def test_the_execute_node_files_the_post_vector_under_the_states_round_id(
    tmp_path: Path,
) -> None:
    resources = FakeResources()
    node = make_execute_node(_deps(tmp_path, resources=resources, embedder=_PerTextEmbedder()))

    update = node(
        {
            "persona": _persona(tmp_path),
            "round_id": "20261014T091500Z-r",
            "actions": [Action(kind="post", text="你好世界")],
            "solo_nothing": False,
        }
    )

    assert [(name, body["round_id"]) for name, body in resources.post_vectors] == [
        (USERNAME, "20261014T091500Z-r")
    ]
    assert "missing_post_vector" not in update


def test_the_execute_node_flags_a_landed_post_without_a_vector(tmp_path: Path) -> None:
    resources = FakeResources()
    node = make_execute_node(
        _deps(tmp_path, resources=resources, embedder=FakeEmbedder(fail_always=True))
    )

    update = node(
        {
            "persona": _persona(tmp_path),
            "actions": [Action(kind="post", text="你好世界")],
            "solo_nothing": False,
        }
    )

    assert update["landed"] == 1
    assert update["missing_post_vector"] is True
    assert resources.post_vectors == []


def test_a_legacy_state_without_a_round_id_files_a_null_round(tmp_path: Path) -> None:
    resources = FakeResources()
    node = make_execute_node(_deps(tmp_path, resources=resources, embedder=_PerTextEmbedder()))

    node(
        {
            "persona": _persona(tmp_path),
            "actions": [Action(kind="post", text="你好世界")],
            "solo_nothing": False,
        }
    )

    assert resources.post_vectors[0][1]["round_id"] is None
