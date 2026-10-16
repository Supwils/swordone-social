"""`atomic_write`: the one writer for persona, memory rotation and the dream record."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from swil_agent import atomic_write as module
from swil_agent.atomic_write import NEW_FILE_MODE, atomic_write
from swil_agent.dream.candidate import FilesystemDreamState


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


@pytest.mark.parametrize("mode", [0o600, 0o640, 0o644])
def test_an_existing_files_mode_is_kept(tmp_path: Path, mode: int) -> None:
    path = tmp_path / "personality.md"
    path.write_text("old", encoding="utf-8")
    os.chmod(path, mode)
    atomic_write(path, "new")
    assert path.read_text(encoding="utf-8") == "new"
    assert _mode(path) == mode


def test_a_new_file_gets_the_default_mode_not_mkstemps_0600(tmp_path: Path) -> None:
    path = tmp_path / "personality.archive.md"
    atomic_write(path, "first")
    assert path.read_text(encoding="utf-8") == "first"
    assert _mode(path) == NEW_FILE_MODE


def test_the_file_and_then_the_directory_are_synced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []
    real_fsync, real_replace = os.fsync, os.replace

    def fsync(fd: int) -> None:
        events.append("dir" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file")
        real_fsync(fd)

    def replace(src: str, dst: str) -> None:
        events.append("replace")
        real_replace(src, dst)

    monkeypatch.setattr(module.os, "fsync", fsync)
    monkeypatch.setattr(module.os, "replace", replace)
    atomic_write(tmp_path / "memory.md", "x\n")
    assert events == ["file", "replace", "dir"]


def test_a_directory_that_cannot_be_synced_does_not_fail_the_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_fsync = os.fsync

    def fsync(fd: int) -> None:
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError("EINVAL")
        real_fsync(fd)

    monkeypatch.setattr(module.os, "fsync", fsync)
    path = tmp_path / "memory.md"
    atomic_write(path, "x\n")
    assert path.read_text(encoding="utf-8") == "x\n"


def test_a_failed_swap_leaves_the_original_and_no_temp_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "memory.md"
    path.write_text("original", encoding="utf-8")

    def replace(src: str, dst: str) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(module.os, "replace", replace)
    with pytest.raises(OSError, match="disk full"):
        atomic_write(path, "new")
    assert path.read_text(encoding="utf-8") == "original"
    assert [p.name for p in tmp_path.iterdir()] == ["memory.md"]


def test_the_dream_record_is_written_atomically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`record_dream` used to truncate `last_dream_<name>` in place: a crash
    there read back as "never dreamed" and dreamed again next round."""
    calls: list[Path] = []
    real = module.atomic_write

    def spy(path: Path, text: str) -> None:
        calls.append(path)
        real(path, text)

    monkeypatch.setattr("swil_agent.dream.candidate.atomic_write", spy)
    state = FilesystemDreamState(tmp_path)
    state.record_dream("zenith", at=1_760_000_000)
    assert calls == [tmp_path / "last_dream_zenith"]
    assert (tmp_path / "last_dream_zenith").read_text(encoding="utf-8") == "1760000000"
    assert state.last_dream_ts("zenith") == 1_760_000_000
