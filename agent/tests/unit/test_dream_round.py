"""Tests for `swil_agent.dream.round.run_dream` -- the `dream` command's
composition: lock, cooldown, one LLM call, write, snapshot.

Every test runs against a real `GitPersonaSource` on a `tmp_path` roster so
the assertions are about bytes on disk.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from swil_agent.config import Settings
from swil_agent.dream.round import run_dream
from swil_agent.locks import LockBusy, dream_lock_path
from swil_agent.persona.format import parse_persona, render_persona
from swil_agent.persona.loader import load_persona
from swil_agent.persona.source import ARCHIVE_HEADER, GitPersonaSource

from ._runners import ExplodingBackend, FakeEmbedder, FakeResources, FakeState, StubBackend

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


@pytest.fixture
def root(tmp_path: Path) -> Path:
    directory = tmp_path / "agents" / "xiaoman"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(PERSONALITY, encoding="utf-8")
    (directory / "memory.md").write_text("2026-10-14 | post | 下班了\n", encoding="utf-8")
    return tmp_path


def _dir(root: Path) -> Path:
    return root / "agents" / "xiaoman"


def _file(root: Path, name: str = "personality.md") -> str:
    return (_dir(root) / name).read_text(encoding="utf-8")


def _frontmatter_and_card(text: str) -> str:
    return text.split("\n## 最近\n", 1)[0]


def _run(
    root: Path,
    reply: str,
    *,
    resources: FakeResources | None = None,
    embedder: FakeEmbedder | None = None,
    state: FakeState | None = None,
    auto: bool = False,
    backend: object | None = None,
):  # type: ignore[no-untyped-def]
    source = GitPersonaSource(root)
    return run_dream(
        persona=source.load("xiaoman"),
        persona_source=source,
        resources=resources or FakeResources(),
        backend=backend or StubBackend(reply),  # type: ignore[arg-type]
        embedder=embedder or FakeEmbedder(),
        state=state or FakeState(),
        settings=Settings(agent_root=root),
        agent_root=root,
        now=NOW,
        captured_at=CAPTURED_AT,
        auto=auto,
    )


def test_an_over_limit_reply_lands_as_five_short_items(root: Path) -> None:
    items = ",".join(f'"{"长" * 200}{i}"' for i in range(8))
    result = _run(root, f'好的：\n```json\n{{"recent": [{items}]}}\n```')

    assert result.proceeded and result.accepted
    persona = load_persona(_dir(root))  # the written file still passes the loader
    assert len(persona.recent) == 5
    assert all(len(item) <= 60 for item in persona.recent)
    assert result.recent == persona.recent


def test_card_and_frontmatter_are_byte_identical_after_a_dream(root: Path) -> None:
    """Byte identity holds for a file authored with `render_persona` (how the
    Era 3 roster is written). A hand-formatted file keeps the same meta and
    card but has its YAML re-rendered on the first write -- see the next test."""
    canonical = render_persona(parse_persona(PERSONALITY))
    (_dir(root) / "personality.md").write_text(canonical, encoding="utf-8")
    _run(root, '{"recent": ["这周连上了四个夜班"]}')
    after = _file(root)
    assert _frontmatter_and_card(after) == _frontmatter_and_card(canonical)
    assert parse_persona(after).recent == ("这周连上了四个夜班",)


def test_a_hand_formatted_file_keeps_its_meta_and_card(root: Path) -> None:
    _run(root, '{"recent": ["一"]}')
    before, after = parse_persona(PERSONALITY), parse_persona(_file(root))
    assert after.meta == before.meta
    assert after.card == before.card


def test_the_archive_gains_exactly_one_entry(root: Path) -> None:
    _run(root, '{"recent": ["一"]}')
    archive = _file(root, "personality.archive.md")
    header = ARCHIVE_HEADER.format(stamp="2026-10-14 20:00:00")
    assert archive.startswith(header + PERSONALITY)
    assert archive.count("# 旧版 personality（归档于") == 1


def test_garbage_leaves_the_file_untouched_and_files_a_fail_event(root: Path) -> None:
    resources = FakeResources()
    state = FakeState()
    result = _run(root, "今天不想写。", resources=resources, state=state)

    assert result.proceeded and not result.accepted
    assert result.reason == "unparseable dream output"
    assert _file(root) == PERSONALITY
    assert not (_dir(root) / "personality.archive.md").exists()
    assert state.last_dream_ts("xiaoman") is None
    assert resources.snapshots == []
    fail = [e for e in resources.lab_events if e.outcome == "fail"]
    assert [(e.type, e.phase, e.summary) for e in fail] == [
        ("dream", "dream", "unparseable dream output")
    ]


def test_a_list_of_blank_items_is_unparseable_and_writes_nothing(root: Path) -> None:
    """Blanks clamp to an empty 最近, and an empty 最近 is unparseable."""
    resources = FakeResources()
    state = FakeState()
    result = _run(root, '{"recent": ["", "  ", "-"]}', resources=resources, state=state)

    assert result.proceeded and not result.accepted
    assert result.reason == "unparseable dream output"
    assert _file(root) == PERSONALITY
    assert not (_dir(root) / "personality.archive.md").exists()
    assert state.last_dream_ts("xiaoman") is None
    fail = [e for e in resources.lab_events if e.outcome == "fail"]
    assert [(e.type, e.phase, e.summary) for e in fail] == [
        ("dream", "dream", "unparseable dream output")
    ]


def test_the_snapshot_carries_no_frontmatter(root: Path) -> None:
    resources = FakeResources()
    embedder = FakeEmbedder()
    result = _run(root, '{"recent": ["一"]}', resources=resources, embedder=embedder)

    assert result.snapshot_ok
    ((_, payload),) = resources.snapshots
    ((embedded,),) = embedder.embedded
    for text in (payload["excerpt"], embedded):
        assert "---" not in text
        assert "model:" not in text
        assert "username:" not in text
    assert embedded.startswith("# 小满")


def test_a_successful_dream_files_started_then_success(root: Path) -> None:
    resources = FakeResources()
    _run(root, '{"recent": ["一"]}', resources=resources)
    assert [(e.type, e.outcome, e.summary) for e in resources.lab_events] == [
        ("dream", "started", "dream started"),
        ("dream", "success", "personality updated"),
        ("snapshot", "success", "snapshot uploaded"),
    ]


def test_the_dream_records_its_own_memory_line_and_marker(root: Path) -> None:
    state = FakeState()
    _run(root, '{"recent": ["一"]}', state=state)
    assert state.last_dream_ts("xiaoman") == int(NOW.timestamp())
    assert _file(root, "memory.md").splitlines()[-1].startswith("2026-10-14 | dream |")


def test_a_cooldown_skip_never_calls_the_model(root: Path) -> None:
    state = FakeState()
    state.set_last_dream(name="xiaoman", at=int(NOW.timestamp()) - 3600)
    resources = FakeResources()
    result = _run(root, "", resources=resources, state=state, auto=True, backend=ExplodingBackend())
    assert not result.proceeded
    assert result.reason.startswith("cooldown (1h < 12h")
    assert resources.lab_events == []
    assert _file(root) == PERSONALITY


def test_a_snapshot_failure_does_not_undo_the_write(root: Path) -> None:
    result = _run(root, '{"recent": ["一"]}', embedder=FakeEmbedder(fail_always=True))
    assert result.accepted
    assert not result.snapshot_ok
    assert result.snapshot_reason is not None
    assert parse_persona(_file(root)).recent == ("一",)


def test_the_dream_lock_is_held_and_released(root: Path) -> None:
    lock = dream_lock_path(root, "xiaoman")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("someone else", encoding="utf-8")
    with pytest.raises(LockBusy):
        _run(root, '{"recent": ["一"]}')
    assert _file(root) == PERSONALITY

    lock.unlink()
    _run(root, '{"recent": ["一"]}')
    assert not lock.exists()


def test_the_lock_is_released_when_the_backend_explodes(root: Path) -> None:
    with pytest.raises(RuntimeError):
        _run(root, "", backend=ExplodingBackend())
    assert not dream_lock_path(root, "xiaoman").exists()
    assert _file(root) == PERSONALITY
