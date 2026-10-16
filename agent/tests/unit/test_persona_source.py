"""Tests for the PersonaSource seam.

Every test builds its own `tmp_path` roster: `write_recent` overwrites a live
`personality.md`, and none of these tests may point at a real account.
"""

import os
import stat
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.persona.format import PersonaFormatError, parse_persona
from swil_agent.persona.source import GitPersonaSource

PERSONALITY = """---
username: tester
display_name: 测试
bio: 一句话
model: claude:claude-opus-5-5
board: perception
topics: [alpha, beta]
era: 3
---
# 测试

一个只存在于测试里的人。

## 最近
- 旧的一件事
"""


@pytest.fixture
def agent_root(tmp_path: Path) -> Path:
    d = tmp_path / "agents" / "tester"
    d.mkdir(parents=True)
    (d / "personality.md").write_text(PERSONALITY, encoding="utf-8")
    return tmp_path


def _personality(root: Path) -> Path:
    return root / "agents" / "tester" / "personality.md"


def _archive(root: Path) -> str:
    return (root / "agents" / "tester" / "personality.archive.md").read_text(encoding="utf-8")


def test_load_returns_a_persona(agent_root: Path) -> None:
    persona = GitPersonaSource(agent_root).load("tester")
    assert persona.username == "tester"
    assert persona.backend == "claude"
    assert persona.model == "claude-opus-5-5"


def test_write_recent_replaces_only_the_recent_list(agent_root: Path) -> None:
    before = parse_persona(PERSONALITY)
    text = GitPersonaSource(agent_root).write_recent(
        "tester", ["新的一件事", "另一件"], datetime(2026, 10, 14, 2, 30, 0)
    )
    after = parse_persona(_personality(agent_root).read_text(encoding="utf-8"))
    assert text == _personality(agent_root).read_text(encoding="utf-8")
    assert after.recent == ("新的一件事", "另一件")
    assert after.card == before.card
    assert after.meta == before.meta


def test_write_recent_clamps_to_the_limits(agent_root: Path) -> None:
    items = ["", "- " + "长" * 200, *[f"事{i}" for i in range(8)]]
    GitPersonaSource(agent_root).write_recent("tester", items, datetime(2026, 10, 14))
    recent = parse_persona(_personality(agent_root).read_text(encoding="utf-8")).recent
    assert recent == ("长" * 60, "事0", "事1", "事2", "事3")


def test_write_recent_with_nothing_leaves_an_empty_list(agent_root: Path) -> None:
    text = GitPersonaSource(agent_root).write_recent("tester", [], datetime(2026, 10, 14))
    assert parse_persona(text).recent == ()
    assert text.endswith("## 最近\n")


def test_archive_prepends_the_old_version_with_a_timestamp(agent_root: Path) -> None:
    GitPersonaSource(agent_root).write_recent("tester", ["NEW-1"], datetime(2026, 8, 17, 2, 30, 0))
    archive = _archive(agent_root)
    assert "归档于 2026-08-17 02:30:00" in archive
    assert "旧的一件事" in archive, "the ORIGINAL must be archived, not the new text"
    assert "NEW-1" not in archive


def test_second_archive_goes_on_top(agent_root: Path) -> None:
    source = GitPersonaSource(agent_root)
    source.write_recent("tester", ["NEW-1"], datetime(2026, 8, 17, 1, 0, 0))
    source.write_recent("tester", ["NEW-2"], datetime(2026, 8, 17, 2, 0, 0))
    archive = _archive(agent_root)
    assert archive.index("归档于 2026-08-17 02:00:00") < archive.index("归档于 2026-08-17 01:00:00")


def test_write_recent_refuses_an_invalid_persona(agent_root: Path) -> None:
    _personality(agent_root).write_text(PERSONALITY.replace("era: 3", "era: 2"), "utf-8")
    with pytest.raises(PersonaFormatError):
        GitPersonaSource(agent_root).write_recent("tester", ["x"], datetime(2026, 10, 14))
    assert not (agent_root / "agents" / "tester" / "personality.archive.md").exists()


def test_write_recent_refuses_to_write_an_over_size_file(agent_root: Path) -> None:
    # Legal on load (just under 4096 bytes); five 60-char items push it over.
    big = PERSONALITY.replace("bio: 一句话", "bio: " + "长" * 1220)
    _personality(agent_root).write_text(big, encoding="utf-8")
    assert len(big.encode("utf-8")) <= 4096
    with pytest.raises(PersonaFormatError, match="4096"):
        GitPersonaSource(agent_root).write_recent("tester", ["满" * 60] * 5, datetime(2026, 10, 14))
    assert _personality(agent_root).read_text(encoding="utf-8") == big
    assert not (agent_root / "agents" / "tester" / "personality.archive.md").exists()


def test_memory_append_and_read_roundtrip(agent_root: Path) -> None:
    source = GitPersonaSource(agent_root)
    assert source.read_memory("tester") == ""
    source.append_memory("tester", "first line")
    source.append_memory("tester", "second line")
    assert source.read_memory("tester").splitlines() == ["first line", "second line"]


def test_unknown_account_raises(agent_root: Path) -> None:
    with pytest.raises(FileNotFoundError):
        GitPersonaSource(agent_root).load("no_such_account")


def test_write_recent_leaves_no_temp_files(agent_root: Path) -> None:
    GitPersonaSource(agent_root).write_recent("tester", ["NEW-1"], datetime(2026, 8, 17))
    names = {p.name for p in (agent_root / "agents" / "tester").iterdir()}
    assert names == {"personality.md", "personality.archive.md"}


def test_write_failure_leaves_the_original_personality_intact(
    agent_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A crash mid-write must never leave `personality.md` truncated. The
    patched `write` does a real partial write and raises; under the atomic
    implementation that lands on a temp file, never on the live one."""
    source = GitPersonaSource(agent_root)
    personality_path = _personality(agent_root)
    original = personality_path.read_text(encoding="utf-8")

    real_fdopen = os.fdopen

    class _Crashing:
        def __init__(self, handle: Any) -> None:
            self._handle = handle

        def __enter__(self) -> "_Crashing":
            return self

        def __exit__(self, *exc: object) -> None:
            self._handle.close()

        def write(self, data: str) -> int:
            if "CORRUPT-CANDIDATE" in data and "归档于" not in data:
                self._handle.write(data[: len(data) // 2])
                raise OSError("simulated crash mid-write")
            return int(self._handle.write(data))

        def __getattr__(self, name: str) -> Any:
            return getattr(self._handle, name)

    def crashing_fdopen(fd: int, *args: Any, **kwargs: Any) -> Any:
        return _Crashing(real_fdopen(fd, *args, **kwargs))

    monkeypatch.setattr(os, "fdopen", crashing_fdopen)

    with pytest.raises(OSError):
        source.write_recent("tester", ["CORRUPT-CANDIDATE"], datetime(2026, 8, 17, 3, 0, 0))

    assert personality_path.read_text(encoding="utf-8") == original
    leftovers = [
        p.name
        for p in personality_path.parent.iterdir()
        if p.name not in {"personality.md", "personality.archive.md"}
    ]
    assert leftovers == [], f"temp file left behind: {leftovers}"


def test_write_recent_keeps_the_file_mode(agent_root: Path) -> None:
    """S6 AG-F17: the old writer left `mkstemp`'s 0600 on every
    personality.md it touched."""
    personality_path = _personality(agent_root)
    os.chmod(personality_path, 0o644)
    GitPersonaSource(agent_root).write_recent("tester", ["x"], datetime(2026, 8, 17, 3, 0, 0))
    assert stat.S_IMODE(personality_path.stat().st_mode) == 0o644
    archive = personality_path.parent / "personality.archive.md"
    assert stat.S_IMODE(archive.stat().st_mode) == 0o644
