import os
import time
from pathlib import Path

import pytest

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
    path.write_text("999999", encoding="utf-8")
    with pytest.raises(LockBusy), FileLock(path):
        pass
    # A busy lock must not be touched by the failed acquire attempt.
    assert path.read_text(encoding="utf-8") == "999999"


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
    path.write_text("999999", encoding="utf-8")
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
    """The stale-reclaim path is unlink-then-retry-create -- if a second
    racing process recreates the file between the unlink and our retry, the
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
    # The stale file was still unlinked on the way to the failed retry.
    assert not path.exists()
