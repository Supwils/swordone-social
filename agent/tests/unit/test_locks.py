import fcntl
import os
import subprocess
import threading
import time
from pathlib import Path

import pytest

from swil_agent.locks import file as file_module
from swil_agent.locks.file import (
    STALE_AFTER_SECONDS,
    FileLock,
    LockBusy,
    act_lock_path,
    dream_lock_path,
    read_lock_identity,
)


def test_lock_creates_the_file_and_removes_it_on_exit(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    with FileLock(path):
        assert path.exists()
    assert not path.exists()


def test_lock_writes_the_current_pid_into_the_file(tmp_path: Path) -> None:
    """Bash writes `echo "$$" > "$lock_file"` (auto-run.sh:411-433) -- the
    lock file's content isn't just a marker, it's a diagnostic (who is
    holding this?). A Python round must write the same thing, not an
    arbitrary placeholder, or an operator reading a stale lock's contents
    during an incident gets nothing useful. `echo` appends a trailing
    newline, so the byte-for-byte match requires one too (finding 2,
    fix round 1) -- a bare `str(os.getpid())` with no `\\n` would read
    correctly but not match Bash's own output byte-for-byte."""
    path = tmp_path / "lock_zenith"
    with FileLock(path):
        assert path.read_text(encoding="utf-8") == f"{os.getpid()}\n"


def test_lock_appends_an_identity_line_after_the_pid_when_one_is_given(tmp_path: Path) -> None:
    """`RunLease` needs to recognise its own lock file later, and no `stat`
    field can tell it (inode numbers are recycled). So the identity goes in
    the file. It goes on line TWO: line one stays byte-for-byte what
    `echo "$$"` writes, so `head -1` and a bare `cat` during an incident
    still name the holding process -- which is what cli.py's own LeaseBusy
    remedy tells an operator to do."""
    path = tmp_path / "lock_zenith"
    with FileLock(path, identity="deadbeef"):
        assert path.read_text(encoding="utf-8") == f"{os.getpid()}\ndeadbeef\n"
        assert path.read_text(encoding="utf-8").splitlines()[0] == str(os.getpid())


def test_read_lock_identity_returns_the_identity_that_was_written(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    with FileLock(path, identity="deadbeef"):
        assert read_lock_identity(path) == "deadbeef"


def test_read_lock_identity_is_none_for_a_bash_written_lock(tmp_path: Path) -> None:
    """`echo "$$" > "$lock_file"` (auto-run.sh:417, dream.sh:463) writes a
    bare pid. That is a real answer, not an error: the file is provably not
    one that a token-holding caller created, which is exactly what a stale
    Python holder needs to know before it unlinks what Bash just recreated."""
    path = tmp_path / "lock_zenith"
    path.write_text("99999\n", encoding="utf-8")
    assert read_lock_identity(path) is None


def test_read_lock_identity_is_none_for_a_lock_with_an_empty_second_line(tmp_path: Path) -> None:
    """A trailing blank line is not an identity. Returning `""` here would
    make an unidentified file compare equal to any caller holding `""`."""
    path = tmp_path / "lock_zenith"
    path.write_text("99999\n\n", encoding="utf-8")
    assert read_lock_identity(path) is None


def test_read_lock_identity_raises_when_the_file_cannot_be_read(tmp_path: Path) -> None:
    """Distinct from `None` on purpose. "No identity" and "I could not look"
    call for opposite responses at `RunLease`'s two call sites, so this
    function must not collapse them into one answer."""
    with pytest.raises(OSError):
        read_lock_identity(tmp_path / "lock_missing")


def test_a_lock_without_an_identity_stays_byte_identical_to_bashs_own_output(
    tmp_path: Path,
) -> None:
    """The default is still the Bash-identical single line. `run_act` and
    `run_dream` hold their lock inside one `with` and never need to
    re-identify the file, so they pay nothing for a guard they do not use."""
    path = tmp_path / "lock_zenith"
    with FileLock(path):
        assert read_lock_identity(path) is None


@pytest.mark.parametrize(
    "identity",
    ["two\nlines", "trailing\n", "\nleading", "", "carriage\rreturn"],
    ids=["embedded-lf", "trailing-lf", "leading-lf", "empty", "embedded-cr"],
)
def test_a_multiline_or_empty_identity_is_rejected_at_construction(
    tmp_path: Path, identity: str
) -> None:
    """Enforced, not merely documented. The identity is written verbatim, so
    a line break pushes the rest to line 3 and an empty string fails the
    reader's emptiness test -- either way `read_lock_identity` returns
    something that can never equal what the holder compares against, so the
    holder reads its own live lock as a stranger's, never refreshes the
    mtime, and never unlinks. That is a stranded lock every round, arriving
    silently. `\r` counts because `str.splitlines()` splits on it, which is
    what the reader uses.
    """
    with pytest.raises(ValueError, match="one non-empty line"):
        FileLock(tmp_path / "lock_zenith", identity=identity)


def test_a_rejected_identity_never_creates_a_lock_file(tmp_path: Path) -> None:
    """The guard is in `__init__`, so it fires before anything touches the
    filesystem. A lock created and then found invalid would be the stranded
    file the guard exists to prevent."""
    path = tmp_path / "lock_zenith"
    with pytest.raises(ValueError):
        FileLock(path, identity="two\nlines")
    assert not path.exists()


def test_lock_raises_when_a_fresh_lock_is_held(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text(str(os.getpid()), encoding="utf-8")
    with pytest.raises(LockBusy), FileLock(path):
        pass
    # A busy lock must not be touched by the failed acquire attempt.
    assert path.read_text(encoding="utf-8") == str(os.getpid())


def test_lock_reclaims_a_stale_lock(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text("999999", encoding="utf-8")
    old = time.time() - (STALE_AFTER_SECONDS + 60)
    os.utime(path, (old, old))
    with FileLock(path):
        assert path.exists()
    assert not path.exists()


def test_lock_releases_on_an_exception(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    with pytest.raises(RuntimeError), FileLock(path):
        raise RuntimeError("boom")
    assert not path.exists()


def test_lock_busy_reports_the_age_in_seconds(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text(str(os.getpid()), encoding="utf-8")
    old = time.time() - 120
    os.utime(path, (old, old))
    with pytest.raises(LockBusy) as exc_info, FileLock(path):
        pass
    assert exc_info.value.path == path
    # allow a couple seconds of test-runtime slack either side of 120
    assert 118 <= exc_info.value.age_seconds <= 122


def test_lock_creates_parent_directories(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "dir" / "lock_zenith"
    with FileLock(path):
        assert path.exists()
    assert not path.exists()


def test_lock_can_be_reacquired_after_a_clean_release(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    with FileLock(path):
        pass
    with FileLock(path):
        assert path.exists()
    assert not path.exists()


def test_act_lock_path_matches_the_bash_convention(tmp_path: Path) -> None:
    assert act_lock_path(tmp_path, "zenith") == tmp_path / ".agent-state" / "lock_zenith"


def test_dream_lock_path_matches_the_bash_convention(tmp_path: Path) -> None:
    assert dream_lock_path(tmp_path, "zenith") == tmp_path / ".agent-state" / "dream_lock_zenith"


def test_lock_busy_message_includes_the_file_name(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text("1", encoding="utf-8")
    old = time.time() - 5
    os.utime(path, (old, old))
    with pytest.raises(LockBusy) as exc_info, FileLock(path):
        pass
    assert "lock_zenith" in str(exc_info.value)


def test_lock_treats_a_stat_failure_as_age_zero_and_raises_busy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_try_create` failed (the file exists), and then the mtime probe
    itself fails (e.g. a concurrent unlink mid-race). Bash's fallback for a
    failed `stat` is age=0 (auto-run.sh comment: `stat -f %m ... || echo 0`)
    -- age 0 is always "fresh", so this must raise LockBusy, never silently
    treat an unreadable lock as free."""
    path = tmp_path / "lock_zenith"
    path.write_text("999999", encoding="utf-8")

    real_stat = Path.stat

    def _boom(self: Path, *args: object, **kwargs: object) -> os.stat_result:
        if self == path:
            raise OSError("stat failed")
        return real_stat(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "stat", _boom)
    with pytest.raises(LockBusy) as exc_info, FileLock(path):
        pass
    assert exc_info.value.age_seconds == 0


def test_lock_raises_when_the_stale_reclaim_retry_also_loses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stale-reclaim path is move-aside-then-retry-create -- if a second
    racing process recreates the file between the move and our retry, the
    retry's create-exclusive fails too. That must surface as LockBusy, not
    a silent double-acquire of the same account."""
    path = tmp_path / "lock_zenith"
    path.write_text("999999", encoding="utf-8")
    old = time.time() - (STALE_AFTER_SECONDS + 60)
    os.utime(path, (old, old))

    lock = FileLock(path)
    monkeypatch.setattr(lock, "_try_create", lambda: False)
    with pytest.raises(LockBusy):
        lock.acquire()
    # The stale file was still moved aside on the way to the failed retry,
    # and no tombstone is left behind.
    assert not path.exists()
    assert _lock_files(tmp_path) == []


# ── dead-pid reclaim and the one-winner reclaim (S6 AG-F12) ──────────────


def _lock_files(directory: Path) -> list[str]:
    """Everything but the kept reclaim guard (`.<name>.reclaim`)."""
    return sorted(p.name for p in directory.iterdir() if not p.name.endswith(".reclaim"))


def _tombstones(directory: Path) -> list[str]:
    return [p.name for p in directory.iterdir() if ".reclaim-" in p.name]


def _dead_pid() -> int:
    """A pid that existed a moment ago and no longer does."""
    child = subprocess.Popen(["true"])
    child.wait()
    return child.pid


def test_a_fresh_lock_whose_pid_is_dead_is_reclaimed_at_once(tmp_path: Path) -> None:
    """A crashed run's lock used to block its account for 1800 s; the round
    script already sweeps a dead `head -1` pid, and now the lock agrees."""
    path = tmp_path / "lock_zenith"
    path.write_text(f"{_dead_pid()}\n", encoding="utf-8")
    with FileLock(path, identity="mine"):
        assert read_lock_identity(path) == "mine"
        assert path.read_text(encoding="utf-8").splitlines()[0] == str(os.getpid())
    assert _lock_files(tmp_path) == []


@pytest.mark.parametrize("content", ["", "\n", "not-a-pid\n", "0\n", "-5\n"])
def test_a_fresh_lock_without_a_live_readable_pid_is_still_held(
    tmp_path: Path, content: str
) -> None:
    """An empty file is a winner's lock between its create and its write:
    reading it as dead would be a double hold. Only a real, dead pid is."""
    path = tmp_path / "lock_zenith"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(LockBusy), FileLock(path):
        pass
    assert path.read_text(encoding="utf-8") == content


def test_a_live_pid_of_another_user_is_held(tmp_path: Path) -> None:
    """pid 1 answers EPERM, not ESRCH: alive."""
    path = tmp_path / "lock_zenith"
    path.write_text("1\n", encoding="utf-8")
    with pytest.raises(LockBusy), FileLock(path):
        pass


def test_a_second_reclaimer_cannot_take_the_first_ones_new_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both judged the same stale file. A reclaims and creates; B, arriving
    late, moves A's FRESH file aside, sees it is not the one it judged, puts
    it back, and is busy. Unlink-then-create let B delete A's lock and create
    its own: two holders of one account."""
    path = tmp_path / "lock_zenith"
    path.write_text(f"{_dead_pid()}\n", encoding="utf-8")
    a = FileLock(path, identity="a")
    b = FileLock(path, identity="b")
    real_reclaim = b._reclaim

    def late(seen: object) -> bool:
        a.acquire()
        return real_reclaim(seen)  # type: ignore[arg-type]

    monkeypatch.setattr(b, "_reclaim", late)
    with pytest.raises(LockBusy):
        b.acquire()
    assert read_lock_identity(path) == "a"
    a.release()
    assert _lock_files(tmp_path) == []


def test_a_restore_never_overwrites_a_lock_created_in_the_meantime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The file changes between the in-guard look and the move (its holder's
    heartbeat), and a third process creates a lock at the empty path before
    the restore: the restore must not clobber it."""
    path = tmp_path / "lock_zenith"
    path.write_text(f"{_dead_pid()}\n", encoding="utf-8")
    lock = FileLock(path, identity="b")
    seen = file_module._inspect(path)
    assert seen is not None
    real_rename, real_link = os.rename, os.link

    def _heartbeat_then_rename(src: str | Path, dst: str | Path) -> None:
        os.utime(path, (seen.mtime - 100, seen.mtime - 100))
        real_rename(src, dst)

    def _contended_link(src: str | Path, dst: str | Path) -> None:
        Path(dst).write_text("c-holder\n", encoding="utf-8")
        real_link(src, dst)

    monkeypatch.setattr(os, "rename", _heartbeat_then_rename)
    monkeypatch.setattr(os, "link", _contended_link)
    assert lock._reclaim(seen) is False
    assert path.read_text(encoding="utf-8") == "c-holder\n"
    assert _tombstones(tmp_path) == []


def test_a_moved_file_that_changed_is_put_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text(f"{_dead_pid()}\n", encoding="utf-8")
    seen = file_module._inspect(path)
    assert seen is not None
    real_rename = os.rename

    def _heartbeat_then_rename(src: str | Path, dst: str | Path) -> None:
        os.utime(path, (seen.mtime - 100, seen.mtime - 100))
        real_rename(src, dst)

    monkeypatch.setattr(os, "rename", _heartbeat_then_rename)
    assert FileLock(path)._reclaim(seen) is False
    assert path.exists()
    assert _tombstones(tmp_path) == []


def test_a_reclaim_already_in_progress_is_busy(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text(f"{_dead_pid()}\n", encoding="utf-8")
    guard = os.open(tmp_path / ".lock_zenith.reclaim", os.O_CREAT | os.O_RDWR)
    try:
        fcntl.flock(guard, fcntl.LOCK_EX)
        with pytest.raises(LockBusy), FileLock(path):
            pass
    finally:
        os.close(guard)
    with FileLock(path):
        pass


def test_a_lock_released_before_the_reclaimer_looks_again_is_simply_taken(
    tmp_path: Path,
) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text(f"{_dead_pid()}\n", encoding="utf-8")
    seen = file_module._inspect(path)
    assert seen is not None
    path.unlink()
    assert FileLock(path)._reclaim(seen) is True


def test_concurrent_reclaimers_of_one_stale_lock_leave_exactly_one_holder(
    tmp_path: Path,
) -> None:
    path = tmp_path / "lock_zenith"
    for _round in range(25):
        path.write_text(f"{_dead_pid()}\n", encoding="utf-8")
        locks = [FileLock(path, identity=f"t{i}") for i in range(8)]
        start = threading.Barrier(len(locks))
        winners: list[FileLock] = []

        def contend(lock: FileLock, start: threading.Barrier, winners: list[FileLock]) -> None:
            start.wait()
            try:
                lock.acquire()
            except LockBusy:
                return
            winners.append(lock)

        threads = [threading.Thread(target=contend, args=(lock, start, winners)) for lock in locks]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert len(winners) == 1
        assert read_lock_identity(path) == winners[0]._identity
        winners[0].release()
        assert _lock_files(tmp_path) == []


def test_a_lock_released_between_the_create_and_the_look_is_raced_for(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "lock_zenith"
    lock = FileLock(path)
    real_create = lock._try_create
    attempts: list[bool] = []

    def first_loses() -> bool:
        if not attempts:
            attempts.append(False)
            return False  # the holder released right after this create failed
        attempts.append(True)
        return real_create()

    monkeypatch.setattr(lock, "_try_create", first_loses)
    lock.acquire()
    assert path.exists()
    lock.release()


def test_moving_aside_a_file_that_is_already_gone_frees_the_path(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text(f"{_dead_pid()}\n", encoding="utf-8")
    seen = file_module._inspect(path)
    assert seen is not None
    path.unlink()
    assert FileLock(path)._move_aside(seen) is True
    assert _tombstones(tmp_path) == []


def test_an_os_error_during_the_reclaim_is_busy_with_the_cause(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Not a raw `OSError` out of a lease: busy, naming why."""
    path = tmp_path / "lock_zenith"
    path.write_text(f"{_dead_pid()}\n", encoding="utf-8")
    real_inspect = file_module._inspect

    def failing_on_the_tombstone(target: Path) -> object:
        if ".reclaim-" in target.name:
            raise PermissionError("EACCES")
        return real_inspect(target)

    monkeypatch.setattr(file_module, "_inspect", failing_on_the_tombstone)
    with pytest.raises(LockBusy, match="reclaim failed: EACCES") as info, FileLock(path):
        pass
    assert info.value.detail == "EACCES"
    # The file it could not verify is put back, not deleted.
    assert path.exists()
    assert _tombstones(tmp_path) == []


def test_a_failed_restore_is_busy_with_the_cause(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text(f"{_dead_pid()}\n", encoding="utf-8")
    seen = file_module._inspect(path)
    assert seen is not None
    real_rename = os.rename

    def _heartbeat_then_rename(src: str | Path, dst: str | Path) -> None:
        os.utime(path, (seen.mtime - 100, seen.mtime - 100))
        real_rename(src, dst)

    def _no_link(src: str | Path, dst: str | Path) -> None:
        raise OSError("EXDEV")

    monkeypatch.setattr(os, "rename", _heartbeat_then_rename)
    monkeypatch.setattr(os, "link", _no_link)
    with pytest.raises(OSError, match="EXDEV"):
        FileLock(path)._reclaim(seen)
    assert _tombstones(tmp_path) == []
