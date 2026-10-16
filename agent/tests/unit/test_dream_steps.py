"""Tests for the dream steps in `swil_agent.dream.round` and the graph nodes
that drive them.

`run_dream` and the cycle graph call the same four steps (`cooldown_step`,
`dream_step`, `write_step`, `snapshot_step`); these tests pin each step on its
own, then the node wiring around them. Tests that read bytes back use the real
`GitPersonaSource` on a `tmp_path` roster.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

import pytest

from swil_agent.api.client import ApiError
from swil_agent.config import Settings
from swil_agent.dream.candidate import DREAM_INSTRUCTION, DREAM_MEMORY_NOTE
from swil_agent.dream.round import (
    build_snapshot_payload,
    cooldown_step,
    dream_step,
    snapshot_content,
    snapshot_step,
    write_step,
)
from swil_agent.graph.cycle import build_cycle
from swil_agent.graph.deps import CycleDeps
from swil_agent.graph.nodes_act import make_execute_node
from swil_agent.graph.nodes_dream import make_dream_node, make_snapshot_node, make_write_node
from swil_agent.models import Action, Persona
from swil_agent.persona.format import parse_persona, prompt_text
from swil_agent.persona.source import GitPersonaSource

from ._runners import (
    FakeEmbedder,
    FakePersonaSource,
    FakeResources,
    FakeState,
    ScriptedBackend,
    SilentBackend,
    StubBackend,
    make_cycle_deps,
)

NOW = datetime(2026, 10, 14, 20, 0, 0)
CAPTURED_AT = datetime(2026, 10, 14, 12, 0, 0, tzinfo=UTC)

PERSONALITY = """---
username: xiaoman
display_name: 小满
bio: 夜班护士，白天睡觉。
model: claude:claude-haiku-5-5
board: life-science
topics: [health, plants]
era: 3
---
# 小满

夜班护士，醒着的时候养多肉。说话很短，对新手很耐心。

## 最近
- 多肉又死了一盆
"""

GOOD_REPLY = '{"recent": ["这周连上了四个夜班", "开始觉得 @alpha 说得有道理"]}'


@pytest.fixture
def root(tmp_path: Path) -> Path:
    directory = tmp_path / "agents" / "xiaoman"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(PERSONALITY, encoding="utf-8")
    (directory / "memory.md").write_text("", encoding="utf-8")
    return tmp_path


def _source(root: Path) -> GitPersonaSource:
    return GitPersonaSource(root)


def _persona(root: Path) -> Persona:
    return _source(root).load("xiaoman")


def _personality(root: Path) -> str:
    return (root / "agents" / "xiaoman" / "personality.md").read_text(encoding="utf-8")


def _dream_events(resources: FakeResources) -> list[tuple[str, str]]:
    return [(e.outcome, e.summary) for e in resources.lab_events if e.type == "dream"]


# ── cooldown_step ────────────────────────────────────────────────────────────


def test_cooldown_step_reads_memory_once_and_returns_it(root: Path) -> None:
    source = _source(root)
    source.append_memory("xiaoman", "2026-10-14 | post | 一件事")
    step = cooldown_step(
        persona=_persona(root),
        persona_source=source,
        state=FakeState(),
        settings=Settings(),
        now=NOW,
        auto=True,
    )
    assert step.proceed
    assert step.memory_text == "2026-10-14 | post | 一件事\n"


def test_cooldown_step_skips_inside_the_cooldown(root: Path) -> None:
    state = FakeState()
    state.set_last_dream(name="xiaoman", at=int(NOW.timestamp()) - 3600)
    step = cooldown_step(
        persona=_persona(root),
        persona_source=_source(root),
        state=state,
        settings=Settings(),
        now=NOW,
        auto=True,
    )
    assert not step.proceed
    assert step.reason == "cooldown (1h < 12h, +0 new memories)"


def test_cooldown_step_threads_the_settings(root: Path) -> None:
    state = FakeState()
    state.set_last_dream(name="xiaoman", at=int(NOW.timestamp()) - 3600)
    step = cooldown_step(
        persona=_persona(root),
        persona_source=_source(root),
        state=state,
        settings=Settings(dream_cooldown_hours=1),
        now=NOW,
        auto=True,
    )
    assert step.proceed


def test_cooldown_step_logs_the_override(root: Path, caplog: pytest.LogCaptureFixture) -> None:
    source = _source(root)
    for _ in range(8):
        source.append_memory("xiaoman", "2026-10-15 | like | x")
    state = FakeState()
    state.set_last_dream(name="xiaoman", at=int(NOW.timestamp()) - 3600)
    with caplog.at_level("INFO", logger="swil_agent.dream.round"):
        step = cooldown_step(
            persona=_persona(root),
            persona_source=source,
            state=state,
            settings=Settings(),
            now=NOW,
            auto=True,
        )
    assert step.proceed
    assert "xiaoman — cooldown override: +8 new memories since last dream" in caplog.text


# ── dream_step ───────────────────────────────────────────────────────────────


def test_dream_step_announces_itself_first_and_returns_the_list(root: Path) -> None:
    resources = FakeResources()
    backend = StubBackend(GOOD_REPLY)
    step = dream_step(persona=_persona(root), resources=resources, backend=backend, memory_text="")
    assert step.failure_reason is None
    assert step.recent == ["这周连上了四个夜班", "开始觉得 @alpha 说得有道理"]
    assert _dream_events(resources) == [("started", "dream started")]


def test_dream_step_sends_the_persona_prompt_and_the_memory_tail(root: Path) -> None:
    persona = _persona(root)
    memory = "".join(f"2026-10-14 | like | line-{i}\n" for i in range(40))
    resources = FakeResources()
    resources.notification_items = [
        {"actor": {"username": "alpha", "displayName": "Alpha"}, "type": "comment"}
    ]
    backend = StubBackend(GOOD_REPLY)
    dream_step(persona=persona, resources=resources, backend=backend, memory_text=memory)

    req = backend.last
    assert req is not None
    assert req.system == persona.prompt
    assert "---" not in req.system and "model:" not in req.system
    assert req.model == "claude-haiku-5-5"
    assert req.user.startswith(DREAM_INSTRUCTION)
    assert "line-10" in req.user and "line-39" in req.user
    assert "line-9\n" not in req.user  # only the last 30 lines
    assert "- @alpha（Alpha）：1 条回应" in req.user


def test_dream_step_clamps_an_over_limit_list(root: Path) -> None:
    reply = '{"recent": [' + ",".join(f'"{"长" * 200}{i}"' for i in range(8)) + "]}"
    step = dream_step(
        persona=_persona(root),
        resources=FakeResources(),
        backend=StubBackend(reply),
        memory_text="",
    )
    assert step.recent is not None
    assert len(step.recent) == 5
    assert all(len(item) <= 60 for item in step.recent)


def test_dream_step_fails_on_an_empty_reply(root: Path) -> None:
    resources = FakeResources()
    step = dream_step(
        persona=_persona(root), resources=resources, backend=SilentBackend(), memory_text=""
    )
    assert step.recent is None
    assert step.failure_reason == "LLM returned empty"
    assert _dream_events(resources)[-1] == ("fail", "LLM returned empty")


def test_dream_step_fails_on_garbage_and_writes_nothing(root: Path) -> None:
    resources = FakeResources()
    before = _personality(root)
    step = dream_step(
        persona=_persona(root),
        resources=resources,
        backend=StubBackend("我今天什么也不想说。"),
        memory_text="",
    )
    assert step.recent is None
    assert step.failure_reason == "unparseable dream output"
    assert _dream_events(resources)[-1] == ("fail", "unparseable dream output")
    assert _personality(root) == before


def test_dream_step_survives_a_failing_notifications_read(root: Path) -> None:
    resources = FakeResources()
    resources.fail("notifications")
    step = dream_step(
        persona=_persona(root),
        resources=resources,
        backend=StubBackend(GOOD_REPLY),
        memory_text="",
    )
    assert step.recent is not None


# ── write_step ───────────────────────────────────────────────────────────────


def test_write_step_with_no_list_writes_nothing() -> None:
    order: list[str] = []
    source = FakePersonaSource(order=order)
    resources = FakeResources(order=order)
    step = write_step(
        persona=Persona.model_validate(
            {**_bare_persona_fields(), "directory": Path("/tmp/xiaoman")}
        ),
        persona_source=source,
        state=FakeState(order=order),
        resources=resources,
        recent=None,
        now=NOW,
    )
    assert not step.written
    assert order == []
    assert resources.lab_events == []


def test_write_step_writes_marks_and_logs_in_order() -> None:
    order: list[str] = []
    source = FakePersonaSource(order=order)
    state = FakeState(order=order)
    resources = FakeResources()
    persona = Persona.model_validate({**_bare_persona_fields(), "directory": Path("/x/xiaoman")})
    step = write_step(
        persona=persona,
        persona_source=source,
        state=state,
        resources=resources,
        recent=["一", "二"],
        now=NOW,
    )
    assert step.written
    assert order == ["write_recent", "marker_last_dream", "memory_append"]
    assert source.written == [("xiaoman", ["一", "二"], NOW)]
    assert state.last_dream_ts("xiaoman") == int(NOW.timestamp())
    assert source.appended == [("xiaoman", f"2026-10-14 | {DREAM_MEMORY_NOTE}")]
    success = resources.lab_events[-1]
    assert (success.type, success.outcome, success.summary) == (
        "dream",
        "success",
        "personality updated",
    )
    assert not success.metrics


def test_write_step_keys_on_the_directory_name() -> None:
    source = FakePersonaSource()
    persona = Persona.model_validate(
        {**_bare_persona_fields(), "username": "xiaoman", "directory": Path("/x/folder")}
    )
    write_step(
        persona=persona,
        persona_source=source,
        state=FakeState(),
        resources=FakeResources(),
        recent=["一"],
        now=NOW,
    )
    assert source.written[0][0] == "folder"


def test_write_step_refuses_an_over_size_file_and_leaves_it_untouched(root: Path) -> None:
    directory = root / "agents" / "xiaoman"
    # A card that fits the 600-code-point card limit but pushes the file over
    # 4 KB once five long items are added (CJK is three bytes).
    big = PERSONALITY.replace(
        "夜班护士，醒着的时候养多肉。说话很短，对新手很耐心。", "长" * 590
    ).replace("bio: 夜班护士，白天睡觉。", "bio: " + "简" * 450)
    (directory / "personality.md").write_text(big, encoding="utf-8")
    persona = _persona(root)
    state = FakeState()
    resources = FakeResources()
    step = write_step(
        persona=persona,
        persona_source=_source(root),
        state=state,
        resources=resources,
        recent=["满" * 60] * 5,
        now=NOW,
    )
    assert not step.written
    assert _personality(root) == big
    assert not (directory / "personality.archive.md").exists()
    assert state.last_dream_ts("xiaoman") is None
    assert resources.lab_events[-1].outcome == "fail"


def test_write_step_on_disk_keeps_card_and_frontmatter(root: Path) -> None:
    before = parse_persona(PERSONALITY)
    step = write_step(
        persona=_persona(root),
        persona_source=_source(root),
        state=FakeState(),
        resources=FakeResources(),
        recent=["新的一件事"],
        now=NOW,
    )
    after = parse_persona(_personality(root))
    assert step.written
    assert after.card == before.card
    assert after.meta == before.meta
    assert after.recent == ("新的一件事",)


# ── snapshot_step ────────────────────────────────────────────────────────────


def test_snapshot_content_is_card_plus_recent_without_frontmatter(root: Path) -> None:
    content = snapshot_content(_persona(root), ["一", "二"])
    card = "# 小满\n\n夜班护士，醒着的时候养多肉。说话很短，对新手很耐心。"
    assert content == f"{card}\n\n## 最近\n- 一\n- 二"
    assert "---" not in content and "model:" not in content


def test_snapshot_step_owes_nothing_when_nothing_was_written(root: Path) -> None:
    resources = FakeResources()
    embedder = FakeEmbedder()
    step = snapshot_step(
        persona=_persona(root),
        resources=resources,
        embedder=embedder,
        agent_root=root,
        captured_at=CAPTURED_AT,
        recent=["一"],
        written=False,
    )
    assert (step.ok, step.reason) == (False, None)
    assert resources.snapshots == []
    assert embedder.call_count == 0


def test_snapshot_step_embeds_and_posts_the_prompt_text(root: Path) -> None:
    resources = FakeResources()
    embedder = FakeEmbedder([[0.1, 0.2, 0.3]])
    persona = _persona(root)
    step = snapshot_step(
        persona=persona,
        resources=resources,
        embedder=embedder,
        agent_root=root,
        captured_at=CAPTURED_AT,
        recent=["一", "二"],
        written=True,
    )
    content = snapshot_content(persona, ["一", "二"])
    username, payload = resources.snapshots[0]
    assert step.ok
    assert username == "xiaoman"
    assert embedder.embedded == [[content]]
    assert payload["contentHash"] == hashlib.sha256(content.encode()).hexdigest()
    assert payload["embedding"] == [0.1, 0.2, 0.3]
    assert payload["snapshotType"] == "dream"
    assert payload["archivePath"] == "agents/xiaoman/personality.md"
    assert "diffNarrative" not in payload and "aspectDrift" not in payload
    assert "---" not in payload["excerpt"] and "model:" not in payload["excerpt"]


def test_snapshot_content_matches_the_file_written_to_disk(root: Path) -> None:
    persona = _persona(root)
    write_step(
        persona=persona,
        persona_source=_source(root),
        state=FakeState(),
        resources=FakeResources(),
        recent=["一", "二"],
        now=NOW,
    )
    assert snapshot_content(persona, ["一", "二"]) == prompt_text(parse_persona(_personality(root)))


def test_snapshot_step_warns_when_the_embedder_is_down(root: Path) -> None:
    resources = FakeResources()
    step = snapshot_step(
        persona=_persona(root),
        resources=resources,
        embedder=FakeEmbedder(fail_always=True),
        agent_root=root,
        captured_at=CAPTURED_AT,
        recent=["一"],
        written=True,
    )
    assert not step.ok
    assert step.reason is not None and "fake embedder failing" in step.reason
    warn = resources.lab_events[-1]
    assert (warn.type, warn.outcome, warn.reason) == ("snapshot", "warn", step.reason)


def test_snapshot_step_warns_when_the_server_refuses(root: Path) -> None:
    resources = FakeResources(snapshot_raises=ApiError(403, "no", None))
    step = snapshot_step(
        persona=_persona(root),
        resources=resources,
        embedder=FakeEmbedder(),
        agent_root=root,
        captured_at=CAPTURED_AT,
        recent=["一"],
        written=True,
    )
    assert not step.ok
    assert resources.lab_events[-1].outcome == "warn"


def test_build_snapshot_payload_slices_the_excerpt_by_character(tmp_path: Path) -> None:
    payload = build_snapshot_payload(
        text="字" * 400 + "\n尾",
        directory=tmp_path / "agents" / "a",
        agent_root=tmp_path,
        embedding=[1.0],
        captured_at=CAPTURED_AT,
    )
    assert payload["excerpt"] == "字" * 280
    assert payload["capturedAt"] == "2026-10-14T12:00:00Z"


# ── graph wiring ─────────────────────────────────────────────────────────────


def _bare_persona_fields() -> dict[str, object]:
    return {
        "username": "xiaoman",
        "display_name": "小满",
        "topics": ["health"],
        "backend": "claude",
        "model": "claude-haiku-5-5",
        "board": "life-science",
        "era": 3,
        "card": "# 小满\n\n卡片",
        "prompt": "# 小满\n\n卡片\n\n## 最近\n（暂无）",
    }


def _deps(root: Path, **overrides: object) -> CycleDeps:
    fields: dict[str, object] = {
        "backend": StubBackend(GOOD_REPLY),
        "persona_source": _source(root),
        "llm_model": "opus",
        "now": NOW,
        "captured_at": CAPTURED_AT,
    }
    return make_cycle_deps(root, **(fields | overrides))


def test_the_cycle_graph_has_no_gate_and_no_rule_check() -> None:
    nodes = set(build_cycle().compile().get_graph().nodes) - {"__start__", "__end__"}
    assert nodes == {
        "login",
        "plan",
        "guardrail",
        "execute",
        "behavior_snapshot",
        "dream",
        "write",
        "snapshot",
        "logout",
        "population_metric",
    }


def test_the_dream_phase_runs_dream_then_write_then_snapshot() -> None:
    edges = {(e.source, e.target) for e in build_cycle().compile().get_graph().edges}
    assert ("dream", "write") in edges
    assert ("write", "snapshot") in edges
    assert ("snapshot", "logout") in edges
    assert ("behavior_snapshot", "dream") in edges
    assert ("guardrail", "dream") in edges


def test_the_dream_node_returns_the_new_list(root: Path) -> None:
    update = make_dream_node(_deps(root))({"persona": _persona(root)})
    assert update["proceeded"] is True
    assert update["recent"] == ["这周连上了四个夜班", "开始觉得 @alpha 说得有道理"]


def test_the_dream_node_reports_an_unparseable_reply(root: Path) -> None:
    update = make_dream_node(_deps(root, backend=StubBackend("不")))({"persona": _persona(root)})
    assert update["proceeded"] is True
    assert update.get("recent") is None
    assert update["dream_reason"] == "unparseable dream output"


def test_the_write_node_reports_why_a_list_was_refused(root: Path) -> None:
    directory = root / "agents" / "xiaoman"
    big = PERSONALITY.replace(
        "夜班护士，醒着的时候养多肉。说话很短，对新手很耐心。", "长" * 590
    ).replace("bio: 夜班护士，白天睡觉。", "bio: " + "简" * 450)
    (directory / "personality.md").write_text(big, encoding="utf-8")
    state = {"persona": _persona(root), "recent": ["满" * 60] * 5}
    update = make_write_node(_deps(root))(state)  # type: ignore[arg-type]
    assert update["written"] is False
    assert update["dream_reason"]
    assert _personality(root) == big


def test_the_write_node_leaves_dream_reason_alone_when_nothing_was_refused(root: Path) -> None:
    update = make_write_node(_deps(root))({"persona": _persona(root), "recent": None})
    assert update == {"written": False}


def test_the_dream_node_skips_on_a_dry_run(root: Path) -> None:
    backend = ScriptedBackend(GOOD_REPLY)
    update = make_dream_node(_deps(root, dry_run=True, backend=backend))(
        {"persona": _persona(root)}
    )
    assert update["proceeded"] is False
    assert backend.calls == []


def test_the_write_and_snapshot_nodes_land_the_list(root: Path) -> None:
    resources = FakeResources()
    deps = _deps(root, resources=resources)
    state = {"persona": _persona(root), "recent": ["一"]}
    written = make_write_node(deps)(state)  # type: ignore[arg-type]
    assert written == {"written": True}
    snap = make_snapshot_node(deps)({**state, **written})  # type: ignore[arg-type]
    assert snap == {"snapshot_ok": True, "snapshot_reason": None}
    assert parse_persona(_personality(root)).recent == ("一",)
    assert len(resources.snapshots) == 1


def test_the_write_node_writes_nothing_without_a_list(root: Path) -> None:
    before = _personality(root)
    update = make_write_node(_deps(root))({"persona": _persona(root)})
    assert update == {"written": False}
    assert _personality(root) == before


def test_the_write_and_snapshot_nodes_are_inert_on_a_dry_run(root: Path) -> None:
    resources = FakeResources()
    deps = _deps(root, dry_run=True, resources=resources)
    before = _personality(root)
    state = {"persona": _persona(root), "recent": ["一"], "written": True}
    assert make_write_node(deps)(state) == {"written": False}  # type: ignore[arg-type]
    assert make_snapshot_node(deps)(state) == {  # type: ignore[arg-type]
        "snapshot_ok": False,
        "snapshot_reason": None,
    }
    assert _personality(root) == before
    assert resources.snapshots == []


def test_the_execute_node_writes_the_post_guard_actions_back(root: Path) -> None:
    persona = _persona(root)
    actions = [Action(kind="like", post_id="p1")]
    update = make_execute_node(_deps(root))({"persona": persona, "actions": actions})
    assert update["actions"] == actions
