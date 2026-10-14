"""`memory_rotation.rotate_memory`: keep memory.md short, never lose a line."""

from __future__ import annotations

from pathlib import Path

import pytest

from swil_agent import memory_rotation
from swil_agent.memory_rotation import ARCHIVE_FILENAME, rotate_memory


def _write_lines(path: Path, count: int, *, prefix: str = "line") -> list[str]:
    lines = [f"2026-10-14 | {prefix} {i}" for i in range(count)]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return lines


def _read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def test_301_lines_moves_the_oldest_101_to_the_archive_in_order(tmp_path: Path) -> None:
    memory = tmp_path / "memory.md"
    lines = _write_lines(memory, 301)

    moved = rotate_memory(memory)

    assert moved == 101
    assert _read_lines(tmp_path / ARCHIVE_FILENAME) == lines[:101]
    assert _read_lines(memory) == lines[-200:]
    assert memory.read_text(encoding="utf-8").endswith("\n")


def test_exactly_300_lines_is_a_no_op(tmp_path: Path) -> None:
    memory = tmp_path / "memory.md"
    _write_lines(memory, 300)
    before = memory.read_bytes()

    assert rotate_memory(memory) == 0
    assert memory.read_bytes() == before
    assert not (tmp_path / ARCHIVE_FILENAME).exists()


def test_an_existing_archive_is_appended_to_not_replaced(tmp_path: Path) -> None:
    memory = tmp_path / "memory.md"
    archive = tmp_path / ARCHIVE_FILENAME
    archive.write_text("old 1\nold 2\n", encoding="utf-8")
    lines = _write_lines(memory, 301)

    rotate_memory(memory)

    assert _read_lines(archive) == ["old 1", "old 2", *lines[:101]]


def test_an_archive_without_a_trailing_newline_does_not_merge_lines(tmp_path: Path) -> None:
    memory = tmp_path / "memory.md"
    archive = tmp_path / ARCHIVE_FILENAME
    archive.write_text("old tail", encoding="utf-8")
    lines = _write_lines(memory, 301)

    rotate_memory(memory)

    assert _read_lines(archive) == ["old tail", *lines[:101]]


def test_a_missing_memory_file_is_a_no_op(tmp_path: Path) -> None:
    assert rotate_memory(tmp_path / "memory.md") == 0
    assert not (tmp_path / ARCHIVE_FILENAME).exists()


def test_custom_limits_are_honoured(tmp_path: Path) -> None:
    memory = tmp_path / "memory.md"
    lines = _write_lines(memory, 11)

    assert rotate_memory(memory, max_lines=10, keep=4) == 7
    assert _read_lines(memory) == lines[-4:]
    assert _read_lines(tmp_path / ARCHIVE_FILENAME) == lines[:7]


def test_a_file_without_a_trailing_newline_keeps_its_last_line(tmp_path: Path) -> None:
    memory = tmp_path / "memory.md"
    lines = [f"l{i}" for i in range(6)]
    memory.write_text("\n".join(lines), encoding="utf-8")

    assert rotate_memory(memory, max_lines=5, keep=2) == 4
    assert _read_lines(memory) == ["l4", "l5"]


def test_keep_zero_moves_everything(tmp_path: Path) -> None:
    memory = tmp_path / "memory.md"
    lines = _write_lines(memory, 3)

    assert rotate_memory(memory, max_lines=2, keep=0) == 3
    assert memory.read_text(encoding="utf-8") == ""
    assert _read_lines(tmp_path / ARCHIVE_FILENAME) == lines


def test_keep_must_not_exceed_max_lines(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="keep"):
        rotate_memory(tmp_path / "memory.md", max_lines=10, keep=11)


def test_the_live_file_is_replaced_atomically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The rewrite goes through `os.replace`, so a crash mid-write leaves the
    old file whole rather than a truncated one."""
    memory = tmp_path / "memory.md"
    _write_lines(memory, 301)
    calls: list[tuple[str, str]] = []
    real_replace = memory_rotation.os.replace

    def spy(src: str, dst: str) -> None:
        calls.append((str(src), str(dst)))
        real_replace(src, dst)

    monkeypatch.setattr(memory_rotation.os, "replace", spy)
    rotate_memory(memory)

    assert len(calls) == 1
    assert calls[0][1] == str(memory)
    assert not [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]


def test_a_failed_rewrite_leaves_the_live_file_whole(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    memory = tmp_path / "memory.md"
    _write_lines(memory, 301)
    before = memory.read_bytes()

    def boom(src: str, dst: str) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(memory_rotation.os, "replace", boom)
    with pytest.raises(OSError, match="disk full"):
        rotate_memory(memory)

    assert memory.read_bytes() == before
    assert not [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]


def test_the_live_file_keeps_its_mode(tmp_path: Path) -> None:
    """`mkstemp` creates 0600; the rewritten memory.md must keep its own mode."""
    memory = tmp_path / "memory.md"
    _write_lines(memory, 301)
    memory.chmod(0o644)

    rotate_memory(memory)

    assert memory.stat().st_mode & 0o777 == 0o644


def test_the_archive_and_the_temp_file_are_synced_before_the_replace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both writes reach disk before the live file is swapped, so a power
    loss cannot leave the moved lines in neither file."""
    memory = tmp_path / "memory.md"
    _write_lines(memory, 301)
    events: list[str] = []
    real_fsync = memory_rotation.os.fsync
    real_replace = memory_rotation.os.replace

    def fsync(fd: int) -> None:
        events.append("fsync")
        real_fsync(fd)

    def replace(src: str, dst: str) -> None:
        events.append("replace")
        real_replace(src, dst)

    monkeypatch.setattr(memory_rotation.os, "fsync", fsync)
    monkeypatch.setattr(memory_rotation.os, "replace", replace)
    rotate_memory(memory)

    assert events == ["fsync", "fsync", "replace"]
