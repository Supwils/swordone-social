"""Run leases (task 3, spec §7.3).

Spec §7.3 read literally -- the PID lock files "become a row in SQLite" --
would silently destroy mutual exclusion during migration stages 3 and 4,
which is exactly when Bash and Python run the same 23-account roster. A Bash
round cannot see a SQLite row. So a lease holds BOTH: the row (identity,
heartbeat, expiry, and the death of the orphan-lock class) and the
Bash-visible file lock (cross-runtime exclusion). The file lock goes away at
stage 5, when Bash no longer runs.
"""

import logging
import os
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from swil_agent.locks.file import (
    STALE_AFTER_SECONDS,
    act_lock_path,
    dream_lock_path,
    read_lock_identity,
)
from swil_agent.locks.lease import (
    LEASE_TTL_SECONDS,
    LeaseBusy,
    RunLease,
    ensure_schema,
    open_lease_db,
    sweep_expired,
)

from ._sqlite import track

_NOW = 1_700_000_000.0

_INSERT = (
    "INSERT INTO run_leases "
    "(tenant, agent, kind, run_id, pid, acquired_at, heartbeat_at) "
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
)


def _now() -> float:
    return _NOW


def _memory_db() -> sqlite3.Connection:
    return track(sqlite3.connect(":memory:"))


def _insert_lease(
    db: sqlite3.Connection,
    tenant: str,
    agent: str,
    *,
    age_seconds: float = 0.0,
    kind: str = "act",
    run_id: str = "run-1",
    pid: int | None = None,
) -> None:
    """Write a lease row directly, with no file lock -- the state a crashed
    Python run leaves behind, and the only way to exercise the row-conflict
    branch of `__enter__` (a lease acquired through `RunLease` also holds the
    file lock, so a second `RunLease` would lose on the file lock first and
    never reach the INSERT).

    `pid` defaults to this process, which is by definition alive, so a row
    written by this helper is reclaimable only by the time-based rule unless
    a test says otherwise.
    """
    ensure_schema(db)
    stamp = _NOW - age_seconds
    holder = os.getpid() if pid is None else pid
    db.execute(_INSERT, (tenant, agent, kind, run_id, holder, stamp, stamp))
    db.commit()


def _heartbeat_of(db: sqlite3.Connection, tenant: str, agent: str, kind: str = "act") -> float:
    row = db.execute(
        "SELECT heartbeat_at FROM run_leases WHERE tenant = ? AND agent = ? AND kind = ?",
        (tenant, agent, kind),
    ).fetchone()
    assert row is not None, "no lease row"
    return float(row[0])


def _lease_kinds(db: sqlite3.Connection, tenant: str, agent: str) -> list[str]:
    rows = db.execute(
        "SELECT kind FROM run_leases WHERE tenant = ? AND agent = ? ORDER BY kind",
        (tenant, agent),
    ).fetchall()
    return [str(row[0]) for row in rows]


def _run_ids(db: sqlite3.Connection) -> list[str]:
    return [str(row[0]) for row in db.execute("SELECT run_id FROM run_leases ORDER BY run_id")]


def _row_count(db: sqlite3.Connection) -> int:
    return int(db.execute("SELECT COUNT(*) FROM run_leases").fetchone()[0])


def _kill_reporting_dead(*dead: int) -> Callable[[int, int], None]:
    """A fake `os.kill` -- `ProcessLookupError` for the named pids, silence for
    the rest. A fake rather than a real dead process: spawning and reaping one
    to test a liveness probe makes the suite depend on process scheduling."""

    def _kill(pid: int, sig: int) -> None:
        if pid in dead:
            raise ProcessLookupError(pid)

    return _kill


def _make_stale(db: sqlite3.Connection, lock: Path) -> None:
    """Age BOTH halves of the currently-held lease past their windows: the
    row past the lease TTL, the lock file's mtime past Bash's 1800s
    (auto-run.sh:422-423). This is the "holder is still running but its lease
    has expired" state -- the precondition for a legitimate reclaim."""
    db.execute("UPDATE run_leases SET heartbeat_at = ?", (_NOW - LEASE_TTL_SECONDS - 1,))
    db.commit()
    old = time.time() - (STALE_AFTER_SECONDS + 60)
    os.utime(lock, (old, old))


# --------------------------------------------------------------------------
# coexistence: the lease must still hold the file lock Bash can see
# --------------------------------------------------------------------------


def test_a_lease_also_creates_the_bash_visible_lock_file(tmp_path: Path) -> None:
    """Stages 3-4 run Bash and Python on the same roster. Bash cannot see a
    SQLite row -- if the lease does not also hold `.agent-state/lock_<name>`,
    a Bash round and a Python round run the same account concurrently.
    """
    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
        assert act_lock_path(tmp_path, "zenith").exists()
    assert not act_lock_path(tmp_path, "zenith").exists()


def test_a_dream_lease_holds_the_bash_dream_lock_path(tmp_path: Path) -> None:
    """dream.sh:460 locks `dream_lock_<name>`, a different file from
    auto-run.sh's `lock_<name>`. A dream lease that grabbed the act lock file
    would both block an unrelated act round and leave a real Bash dream
    round free to run the same account."""
    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="dream"):
        assert dream_lock_path(tmp_path, "zenith").exists()
        assert not act_lock_path(tmp_path, "zenith").exists()
    assert not dream_lock_path(tmp_path, "zenith").exists()


def test_a_held_bash_lock_blocks_a_python_lease(tmp_path: Path) -> None:
    """The direction that matters most: Bash got there first."""
    lock = act_lock_path(tmp_path, "zenith")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("99999\n", encoding="utf-8")
    db = _memory_db()
    with pytest.raises(LeaseBusy), RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
        pass


def test_a_lease_lost_to_bash_writes_no_row(tmp_path: Path) -> None:
    """Companion to the test above, from the SQLite side: losing the file
    lock must leave no row behind either, or observability reports a Python
    run that never started and the row blocks the account's next real lease
    for a full TTL."""
    lock = act_lock_path(tmp_path, "zenith")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("99999\n", encoding="utf-8")
    db = _memory_db()
    ensure_schema(db)
    with pytest.raises(LeaseBusy), RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
        pass
    assert _row_count(db) == 0


def test_the_ttl_matches_the_bash_staleness_window() -> None:
    """auto-run.sh:423 and dream.sh:464 both reclaim at 1800s. A lease TTL
    that disagreed would make the two halves of the same lease expire at
    different moments -- the window in which Bash reclaims a lock whose row
    is still live (or the reverse) is exactly a double-run."""
    assert LEASE_TTL_SECONDS == 1800.0
    assert float(STALE_AFTER_SECONDS) == LEASE_TTL_SECONDS


def test_the_act_lock_file_is_named_after_the_persona_directory(tmp_path: Path) -> None:
    """`agent_dir_name` is the persona DIRECTORY name, not the username.

    Folder name and registered username can differ, and the round driver's
    stale-lock sweep looks for `.agent-state/lock_<dir name>`; a lease built
    from the username would hold a lock file nobody else looks at.
    """
    persona_dir = tmp_path / "agents" / "zenith"
    persona_dir.mkdir(parents=True)
    bash_lock = tmp_path / ".agent-state" / f"lock_{persona_dir.name}"

    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", persona_dir.name, kind="act"):
        assert bash_lock.exists()
    assert act_lock_path(tmp_path, persona_dir.name) == bash_lock


def test_the_dream_lock_file_is_named_after_the_persona_directory(tmp_path: Path) -> None:
    """Same contract on the dream side: `.agent-state/dream_lock_<dir name>`."""
    persona_dir = tmp_path / "agents" / "mangniu"
    persona_dir.mkdir(parents=True)
    bash_lock = tmp_path / ".agent-state" / f"dream_lock_{persona_dir.name}"

    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", persona_dir.name, kind="dream"):
        assert bash_lock.exists()
    assert dream_lock_path(tmp_path, persona_dir.name) == bash_lock


# --------------------------------------------------------------------------
# acquisition order: file lock first, row second
# --------------------------------------------------------------------------


def test_the_file_lock_is_acquired_before_the_row_is_written(tmp_path: Path) -> None:
    """Ordering, observed directly rather than inferred from an end state.
    `set_trace_callback` fires as each statement begins executing, so
    recording whether the lock file exists at that instant pins the sequence:
    by the time the INSERT runs, the Bash-visible lock must already be held.
    The reverse ordering would publish a Python-side claim in SQLite while
    the account is still, as far as Bash can tell, free."""
    db = _memory_db()
    lock = act_lock_path(tmp_path, "zenith")
    seen: list[tuple[str, bool]] = []
    db.set_trace_callback(lambda sql: seen.append((sql, lock.exists())))
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
        pass
    db.set_trace_callback(None)
    at_insert = [held for sql, held in seen if sql.lstrip().upper().startswith("INSERT")]
    assert at_insert == [True], seen


def test_a_failed_row_insert_releases_the_file_lock(tmp_path: Path) -> None:
    """Ordering: file lock first, row second. If the row fails, the file lock
    must not survive -- a stranded lock file is invisible to SQLite and makes
    every later Bash round SKIP until the staleness window runs out.

    The conflicting row is written directly (no file lock), which is the only
    way to reach the INSERT with the file lock in hand: a rival acquired
    through `RunLease` would hold the lock file too and lose there first.
    """
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith")
    # Same injected clock as the row, or the lease would judge it expired and
    # reclaim it instead of conflicting with it.
    lease = RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now)
    with pytest.raises(LeaseBusy), lease:
        pass
    assert not act_lock_path(tmp_path, "zenith").exists()


def test_a_database_error_that_is_not_a_conflict_also_releases_the_file_lock(
    tmp_path: Path,
) -> None:
    """`database is locked`, a closed connection, a disk error -- none of
    them are `IntegrityError`, and none of them may leave the Bash-visible
    lock behind. Handling only the conflict case is the shape of bug that
    strands a lock file."""

    class _FailingConnection(sqlite3.Connection):
        def execute(self, sql: str, parameters: Any = (), /) -> sqlite3.Cursor:
            if sql.lstrip().upper().startswith("INSERT"):
                raise sqlite3.OperationalError("database is locked")
            return super().execute(sql, parameters)

    db = track(sqlite3.connect(":memory:", factory=_FailingConnection))
    lease = RunLease(db, tmp_path, "builtin", "zenith", kind="act")
    with pytest.raises(sqlite3.OperationalError), lease:
        pass
    assert not act_lock_path(tmp_path, "zenith").exists()


def test_a_second_lease_on_the_same_account_is_busy_and_leaves_no_lock_behind(
    tmp_path: Path,
) -> None:
    """A busy lease is a SKIP, matching Bash (auto-run.sh:424) -- no retry
    loop, no wait. And the loser must not disturb the winner's lock file."""
    db = _memory_db()
    outer = RunLease(db, tmp_path, "builtin", "zenith", kind="act")
    with outer:
        assert act_lock_path(tmp_path, "zenith").exists()
        with pytest.raises(LeaseBusy), RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
            pass
        assert act_lock_path(tmp_path, "zenith").exists()
        assert _row_count(db) == 1
    assert not act_lock_path(tmp_path, "zenith").exists()
    assert _row_count(db) == 0


# --------------------------------------------------------------------------
# a reclaimed-but-still-running holder must not clobber its successor
# --------------------------------------------------------------------------


def test_a_reclaimed_holder_does_not_delete_its_successors_row_or_lock(
    tmp_path: Path,
) -> None:
    """The ABA hole. Holder A's lease expires while A is still alive; B
    legitimately reclaims both halves; A then finishes and runs its cleanup.
    Keyed on `(tenant, agent, kind)` alone, A's `__exit__` would delete B's
    row and unlink B's lock file -- leaving B live, holding neither half, with
    nothing to tell it so, and Bash free to start a second round on the same
    account. Every write past acquisition therefore carries `run_id`, and the
    unlink is guarded by the identity token the lease wrote into the lock
    file. (This test alone cannot tell a sound identity from an unsound one --
    it passes on APFS against an inode-number guard too. The pair below,
    which simulates ext4 handing the freed inode straight back, is what
    discriminates.)
    """
    db = _memory_db()
    lock = act_lock_path(tmp_path, "zenith")
    a = RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="A", now=_now)
    a.__enter__()
    _make_stale(db, lock)

    b = RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="B", now=_now)
    b.__enter__()
    b_inode = lock.stat().st_ino
    assert _run_ids(db) == ["B"]

    a.__exit__(None, None, None)

    assert _run_ids(db) == ["B"], "A's exit deleted B's row"
    assert lock.exists(), "A's exit unlinked B's lock file"
    assert lock.stat().st_ino == b_inode
    b.__exit__(None, None, None)
    assert _row_count(db) == 0
    assert not lock.exists()


def test_a_lease_that_cannot_read_its_lock_identity_still_releases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the identity of the file it created cannot be read back -- an I/O
    error, or someone sweeping `.agent-state/` mid-round -- the lease takes
    the safe half of each rule, and the two halves point opposite ways: it
    still unlinks on the way out, because a lock file no process will ever
    come back for costs the account every round until Bash's staleness window
    expires; but it will not refresh an mtime it cannot prove is still its
    own, because that refresh would hide a successor's real age from Bash."""
    db = _memory_db()
    lock = act_lock_path(tmp_path, "zenith")
    real_read_text = Path.read_text
    reads = 0

    def _boom(self: Path, *args: object, **kwargs: object) -> str:
        nonlocal reads
        if self == lock:
            reads += 1
            raise OSError("read failed")
        return real_read_text(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "read_text", _boom)
    lease = RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now)
    lease.__enter__()

    aged = time.time() - 900
    os.utime(lock, (aged, aged))
    lease.heartbeat()
    assert reads, "the identity read never ran -- the seam moved"
    # `abs=1`, not bare `approx`: pytest's default is RELATIVE, and 1e-6 of a
    # Unix timestamp is ~1787 seconds -- wide enough to swallow a refresh to
    # the wall clock and call it unchanged. Two mutations survived on exactly
    # that before this was tightened (STANDING-CONSTRAINTS 4: the fixture has
    # to make the pinned value discriminable).
    assert lock.stat().st_mtime == pytest.approx(aged, abs=1)

    lease.__exit__(None, None, None)
    assert not lock.exists()
    assert _row_count(db) == 0


def test_a_reclaimed_holders_heartbeat_does_not_revive_its_row_or_extend_the_lock(
    tmp_path: Path,
) -> None:
    """Same hole on the heartbeat path. A stale holder that keeps beating
    would hold its successor's lease open on the successor's behalf -- and,
    worse, refresh a lock file it no longer owns, hiding the successor's real
    age from Bash."""
    db = _memory_db()
    lock = act_lock_path(tmp_path, "zenith")
    a = RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="A", now=_now)
    a.__enter__()
    _make_stale(db, lock)

    b = RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="B", now=_now)
    b.__enter__()
    aged = time.time() - 900
    os.utime(lock, (aged, aged))
    before_row = _heartbeat_of(db, "builtin", "zenith")
    before_mtime = lock.stat().st_mtime

    a.heartbeat(now=_NOW + 9999)

    assert _heartbeat_of(db, "builtin", "zenith") == before_row
    assert lock.stat().st_mtime == before_mtime
    b.__exit__(None, None, None)


# --------------------------------------------------------------------------
# ... and must not depend on the filesystem declining to recycle an inode
# --------------------------------------------------------------------------


def _recycle_inodes(monkeypatch: pytest.MonkeyPatch, target: Path, ino: int = 4_242_424) -> None:
    """Make every `stat` of `target` report the SAME `st_ino`, whichever file
    is currently at that path.

    This is ext4, simulated. A reclaim is unlink-then-create
    (auto-run.sh:428-429, dream.sh:471-472), and Linux hands the inode the
    unlink just freed straight back to the create that follows -- so the
    successor's lock file answers to the predecessor's inode number. APFS
    usually allocates a fresh one, which is why the two tests below passed on
    the dev machine and failed on the first CI run that ever executed this
    file on Linux, and why the behaviour has to be injected to be provable
    here at all.

    Only `st_ino` is substituted; `st_mtime` in particular is passed through
    unrounded, because `FileLock`'s staleness rule and these tests both read
    it.
    """
    real_stat = Path.stat

    def _stat(self: Path, *args: object, **kwargs: object) -> os.stat_result:
        st: os.stat_result = real_stat(self, *args, **kwargs)  # type: ignore[arg-type]
        if self != target:
            return st
        fields = list(st[:10])
        fields[1] = ino
        return os.stat_result(
            tuple(fields),
            {"st_atime": st.st_atime, "st_mtime": st.st_mtime, "st_ctime": st.st_ctime},
        )

    monkeypatch.setattr(Path, "stat", _stat)


def test_a_reclaimed_holder_does_not_unlink_its_successors_lock_when_the_inode_is_recycled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ABA hole again, on the filesystem that actually has it.

    Identical to `test_a_reclaimed_holder_does_not_delete_its_successors_row_or_lock`
    except that the lock path's inode number never changes. A guard keyed on
    `st_ino` reads B's file as its own here and deletes it; the assertion this
    makes is that A's identity survives an inode number being handed back,
    which no `stat` field can promise and a token written into the file can.
    """
    db = _memory_db()
    lock = act_lock_path(tmp_path, "zenith")
    _recycle_inodes(monkeypatch, lock)
    a = RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="A", now=_now)
    a.__enter__()
    _make_stale(db, lock)

    b = RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="B", now=_now)
    b.__enter__()
    b_identity = read_lock_identity(lock)
    assert b_identity is not None, "B's lock carries no identity to be recognised by"
    assert _run_ids(db) == ["B"]

    a.__exit__(None, None, None)

    assert _run_ids(db) == ["B"], "A's exit deleted B's row"
    assert lock.exists(), "A's exit unlinked B's lock file"
    assert read_lock_identity(lock) == b_identity, "A's exit replaced B's lock file"
    b.__exit__(None, None, None)
    assert not lock.exists()


def test_a_reclaimed_holders_heartbeat_does_not_extend_the_lock_when_the_inode_is_recycled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same, on the heartbeat path: A must not refresh B's mtime and hide B's
    real age from the next Bash round, however the filesystem allocates."""
    db = _memory_db()
    lock = act_lock_path(tmp_path, "zenith")
    _recycle_inodes(monkeypatch, lock)
    a = RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="A", now=_now)
    a.__enter__()
    _make_stale(db, lock)

    b = RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="B", now=_now)
    b.__enter__()
    aged = time.time() - 900
    os.utime(lock, (aged, aged))
    before_row = _heartbeat_of(db, "builtin", "zenith")
    before_mtime = lock.stat().st_mtime

    a.heartbeat(now=_NOW + 9999)

    assert _heartbeat_of(db, "builtin", "zenith") == before_row
    assert lock.stat().st_mtime == before_mtime, "A extended B's lock file mtime"
    b.__exit__(None, None, None)


def test_undecodable_bytes_in_the_lock_file_do_not_escape_the_heartbeat_or_the_exit(
    tmp_path: Path,
) -> None:
    """`read_text` raises `UnicodeDecodeError` on non-UTF-8 bytes, and that is
    a `ValueError` -- it does NOT descend from `OSError`, so an `except
    OSError` lets it through.

    Both places this guard runs are places an exception must not reach.
    `run_cycle` calls `heartbeat()` between every superstep with no guard of
    its own (`graph/cycle.py:672`), so an escape there ends the round; and
    `__exit__` reaches it through a `finally` that has ALREADY committed the
    row DELETE, so an escape there leaves the lock file on disk with no
    SQLite record of it -- the orphan-lock class this module exists to kill,
    recreated by its own guard. The `stat()` this guard replaced could not
    raise this, so the hazard arrived with the fix.
    """
    db = _memory_db()
    lock = act_lock_path(tmp_path, "zenith")
    lease = RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="A", now=_now)
    lease.__enter__()
    lock.write_bytes(b"\xff\xfe not utf-8 at all\n")
    aged = time.time() - 30
    os.utime(lock, (aged, aged))

    lease.heartbeat(now=_NOW + 9999)
    assert lock.stat().st_mtime == pytest.approx(aged, abs=1), "refreshed an unprovable mtime"

    lease.__exit__(None, None, None)
    assert _row_count(db) == 0
    assert not lock.exists(), "left an unidentifiable lock file behind with no row"


def test_the_lock_identity_is_fresh_for_every_acquisition_of_the_same_path(
    tmp_path: Path,
) -> None:
    """The property the ABA guard rests on, asserted directly rather than
    through its consequence: two leases on the SAME path, in the same process,
    write different identities. A token derived from anything stable per path
    or per process -- the pid, `run_id`'s own `pid-<n>` default, the path
    itself -- would satisfy every other test in this file and re-open the
    hole, because the successor would be indistinguishable from the
    predecessor exactly when it matters."""
    db = _memory_db()
    lock = act_lock_path(tmp_path, "zenith")
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now):
        first = read_lock_identity(lock)
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now):
        second = read_lock_identity(lock)
    assert first is not None
    assert second is not None
    assert first != second


def test_a_lease_does_not_unlink_a_lock_bash_reclaimed_and_recreated(tmp_path: Path) -> None:
    """The cross-runtime shape of the same hole, and the reason the identity
    lives in the file's CONTENT rather than beside it. Bash reclaims a stale
    lock with `rm -f` + `echo "$$"` (auto-run.sh:428-429), which leaves a file
    with a pid and no identity line at all. The stale Python holder must read
    that as someone else's and leave both the file and its mtime alone --
    otherwise it deletes the running Bash round's lock and a third round is
    free to start on the same account."""
    db = _memory_db()
    lock = act_lock_path(tmp_path, "zenith")
    lease = RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="A", now=_now)
    lease.__enter__()

    # Exactly what auto-run.sh:428-429 leaves behind.
    lock.unlink()
    lock.write_text("999999\n", encoding="utf-8")
    aged = time.time() - 30
    os.utime(lock, (aged, aged))

    lease.heartbeat(now=_NOW + 9999)
    # `abs=1` for the reason spelled out above -- a bare `approx` on a Unix
    # timestamp tolerates ~1787s and would pass on a refreshed mtime.
    assert lock.stat().st_mtime == pytest.approx(aged, abs=1), "extended Bash's lock file mtime"

    lease.__exit__(None, None, None)
    assert lock.exists(), "unlinked Bash's lock file"
    assert lock.read_text(encoding="utf-8") == "999999\n"


# --------------------------------------------------------------------------
# expiry: pid liveness first, time as the backstop
# --------------------------------------------------------------------------


def test_a_lease_whose_process_is_gone_is_reclaimed_immediately(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The headline benefit, and the thing time-based expiry alone does NOT
    deliver: Bash already reclaims at 1800s, so a purely time-based row buys
    nothing over the lock file next to it. A run that died ten seconds ago
    must not cost the account the next thirty minutes of rounds."""
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith", age_seconds=10, pid=424242)
    monkeypatch.setattr(os, "kill", _kill_reporting_dead(424242))
    assert sweep_expired(db, now=_now()) == 1
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now):
        assert _row_count(db) == 1


def test_a_lease_takes_over_from_a_dead_process_without_an_external_sweep(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """And it must happen inside `__enter__`, or "no post-round manual sweep"
    is still false -- someone would have to remember to call `sweep_expired`."""
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith", age_seconds=10, pid=424242, run_id="dead")
    monkeypatch.setattr(os, "kill", _kill_reporting_dead(424242))
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="live", now=_now):
        assert _run_ids(db) == ["live"]


def test_a_lease_owned_by_another_users_live_process_is_not_reclaimed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`os.kill(pid, 0)` raises `PermissionError` when the process exists but
    belongs to another user. That means ALIVE. Reading it as dead would steal
    a live lease -- the exact double-run this whole module exists to prevent,
    reintroduced through the mechanism meant to fix it."""
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith", age_seconds=10, pid=424242)

    def _kill(pid: int, sig: int) -> None:
        raise PermissionError(pid)

    monkeypatch.setattr(os, "kill", _kill)
    assert sweep_expired(db, now=_now()) == 0


def test_a_nonpositive_pid_is_never_probed(monkeypatch: pytest.MonkeyPatch) -> None:
    """`os.kill(0, 0)` signals this process's ENTIRE group and a negative pid
    signals another group -- neither is a liveness probe. A corrupt or
    zero-defaulted row must never be turned into a group-wide signal."""
    probed: list[int] = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: probed.append(pid))
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith", age_seconds=10, pid=0)
    _insert_lease(db, "builtin", "vex", age_seconds=10, pid=-1)
    assert sweep_expired(db, now=_now()) == 0
    assert probed == []


def test_a_live_process_holding_a_time_expired_lease_is_still_reclaimed(
    tmp_path: Path,
) -> None:
    """Time expiry remains the backstop -- for a pid that was reused by an
    unrelated process, the row would otherwise read as live forever."""
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith", age_seconds=LEASE_TTL_SECONDS + 1)
    assert sweep_expired(db, now=_now()) == 1


def test_an_expired_lease_is_reclaimable(tmp_path: Path) -> None:
    """A dead run's lease expires on its own (spec §7.3) -- this is the whole
    point: it kills the SIGPIPE-141 orphan lock and the post-round manual sweep."""
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith", age_seconds=LEASE_TTL_SECONDS + 1)
    assert sweep_expired(db, now=_now()) == 1
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now):
        pass


def test_a_lease_reclaims_its_own_expired_row_without_an_external_sweep(
    tmp_path: Path,
) -> None:
    """If reclaiming needed someone to call `sweep_expired` first, the row
    would be a NEW orphan class -- worse than the lock file it accompanies,
    which auto-run.sh:427-428 reclaims by itself. `__enter__` clears its own
    key, exactly as Bash clears its own stale lock."""
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith", age_seconds=LEASE_TTL_SECONDS + 1)
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now):
        assert _heartbeat_of(db, "builtin", "zenith") == _NOW


def test_a_lease_one_second_short_of_the_ttl_is_still_busy(tmp_path: Path) -> None:
    """Bash treats `age < 1800` as held (auto-run.sh:423). The row must not
    be more forgiving than the lock file sitting next to it."""
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith", age_seconds=LEASE_TTL_SECONDS - 1)
    assert sweep_expired(db, now=_now()) == 0
    lease = RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now)
    with pytest.raises(LeaseBusy), lease:
        pass


def test_a_lease_at_exactly_the_ttl_is_expired() -> None:
    """The other side of the same boundary: Bash's `age < 1800` means age
    1800 is stale and gets reclaimed."""
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith", age_seconds=LEASE_TTL_SECONDS)
    assert sweep_expired(db, now=_now()) == 1


def test_sweep_expired_leaves_live_leases_alone_and_counts_only_what_it_deleted() -> None:
    db = _memory_db()
    _insert_lease(db, "builtin", "zenith", age_seconds=LEASE_TTL_SECONDS + 1)
    _insert_lease(db, "builtin", "vex", age_seconds=LEASE_TTL_SECONDS + 1)
    _insert_lease(db, "builtin", "quant", age_seconds=10)
    assert sweep_expired(db, now=_now()) == 2
    assert _lease_kinds(db, "builtin", "quant") == ["act"]
    assert _row_count(db) == 1


def test_sweep_expired_creates_the_schema_when_it_has_never_been_used() -> None:
    """The sweep is a startup chore -- it can run against a fresh database
    before any lease has ever been taken, and must not blow up on a missing
    table."""
    assert sweep_expired(_memory_db(), now=_now()) == 0


# --------------------------------------------------------------------------
# heartbeat
# --------------------------------------------------------------------------


def test_the_heartbeat_advances_while_held(tmp_path: Path) -> None:
    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act") as lease:
        first = _heartbeat_of(db, "builtin", "zenith")
        lease.heartbeat(now=first + 5)
        assert _heartbeat_of(db, "builtin", "zenith") == first + 5


def test_the_heartbeat_defaults_to_the_injected_clock(tmp_path: Path) -> None:
    """Spec §6.3: time is injectable. A `time.time()` call written inline
    would make every heartbeat test a sleeping test."""
    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now) as lease:
        db.execute("UPDATE run_leases SET heartbeat_at = 0")
        lease.heartbeat()
        assert _heartbeat_of(db, "builtin", "zenith") == _NOW


def test_the_heartbeat_refreshes_the_lock_file_mtime_so_bash_sees_it_alive(
    tmp_path: Path,
) -> None:
    """Bash's staleness test is the lock file's mtime, not its contents
    (auto-run.sh:422, dream.sh:463). A Python cycle that outlives 1800s while
    heartbeating only the row would have its lock file reclaimed out from
    under it by the next Bash round -- the exact double-run the file lock
    exists to prevent."""
    db = _memory_db()
    lock = act_lock_path(tmp_path, "zenith")
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act") as lease:
        old = time.time() - (STALE_AFTER_SECONDS + 60)
        os.utime(lock, (old, old))
        assert time.time() - lock.stat().st_mtime > STALE_AFTER_SECONDS
        lease.heartbeat()
        assert time.time() - lock.stat().st_mtime < STALE_AFTER_SECONDS


def test_the_heartbeat_tolerates_a_missing_lock_file(tmp_path: Path) -> None:
    """An operator sweeping `.agent-state/` by hand mid-round must not crash
    a live cycle -- the row is still the authoritative liveness record."""
    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now) as lease:
        act_lock_path(tmp_path, "zenith").unlink()
        lease.heartbeat()
        assert _heartbeat_of(db, "builtin", "zenith") == _NOW


# --------------------------------------------------------------------------
# `kind` is part of the key
# --------------------------------------------------------------------------


def test_an_act_lease_and_a_dream_lease_can_be_held_at_once(tmp_path: Path) -> None:
    """Bash locks act and dream separately (`lock_<name>` vs
    `dream_lock_<name>`), so `kind` belongs in the primary key. Collapsing
    them to (tenant, agent) would serialise a dream behind an unrelated act
    -- a behaviour change, not a simplification."""
    db = _memory_db()
    act = RunLease(db, tmp_path, "builtin", "zenith", kind="act")
    dream = RunLease(db, tmp_path, "builtin", "zenith", kind="dream")
    with act, dream:
        assert act_lock_path(tmp_path, "zenith").exists()
        assert dream_lock_path(tmp_path, "zenith").exists()
        assert _lease_kinds(db, "builtin", "zenith") == ["act", "dream"]


def test_the_primary_key_is_tenant_agent_kind() -> None:
    """Structural pin on the same rule, straight from the schema."""
    db = _memory_db()
    ensure_schema(db)
    rows = db.execute("PRAGMA table_info(run_leases)").fetchall()
    key = [str(row[1]) for row in sorted(rows, key=lambda r: r[5]) if row[5]]
    assert key == ["tenant", "agent", "kind"]


def test_the_row_separates_tenants_but_the_bash_lock_path_does_not(tmp_path: Path) -> None:
    """The row's key carries the tenant (spec §5.5 -- multi-tenancy as a value
    change rather than a data migration), so two tenants CAN hold rows for the
    same agent name. The Bash lock path cannot: `.agent-state/lock_<name>` has
    no tenant in it, because Bash's namespace predates the idea. So a real
    second-tenant lease still loses on the file lock.

    That is correct while the file half exists -- two tenants sharing one
    persona directory would be two rounds writing one set of files -- and it
    is what actually happens today, so it is asserted rather than wished
    away. Tenants separate fully at stage 5, when the file half goes.
    """
    db = _memory_db()
    _insert_lease(db, "acme", "zenith")
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now):
        assert _row_count(db) == 2

    db.execute("DELETE FROM run_leases")
    db.commit()
    held = RunLease(db, tmp_path, "acme", "zenith", kind="act", now=_now)
    with held:
        rival = RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now)
        with pytest.raises(LeaseBusy), rival:
            pass


def test_an_unknown_kind_is_rejected(tmp_path: Path) -> None:
    """There is no Bash lock file for a third kind, so a typo would silently
    run with no cross-runtime exclusion at all."""
    with pytest.raises(ValueError, match="unknown lease kind"):
        RunLease(_memory_db(), tmp_path, "builtin", "zenith", kind="logout")  # type: ignore[arg-type]


# --------------------------------------------------------------------------
# release
# --------------------------------------------------------------------------


def test_the_row_and_the_lock_are_both_released_when_the_body_raises(
    tmp_path: Path,
) -> None:
    """The orphan-lock class this task exists to kill was created by exactly
    this path: an accepted dream exiting after `snapshot uploaded`, with the
    lock file still on disk. Release is unconditional."""
    db = _memory_db()
    lease = RunLease(db, tmp_path, "builtin", "zenith", kind="act")
    with pytest.raises(RuntimeError, match="boom"), lease:
        raise RuntimeError("boom")
    assert not act_lock_path(tmp_path, "zenith").exists()
    assert _row_count(db) == 0


@pytest.mark.parametrize("boom", [KeyboardInterrupt(), SystemExit(141)])
def test_both_halves_are_released_on_a_base_exception(tmp_path: Path, boom: BaseException) -> None:
    """141 is the literal exit code of the incidents this task is named
    after -- an accepted dream exiting 141 (SIGPIPE) after `snapshot
    uploaded`, orphaning `dream_lock_<name>`. Neither `SystemExit` nor
    `KeyboardInterrupt` is an `Exception`, so a cleanup written as
    `except Exception` would miss precisely the case that created the
    defect. `try/finally` does not."""
    db = _memory_db()
    lease = RunLease(db, tmp_path, "builtin", "zenith", kind="act")
    with pytest.raises(type(boom)), lease:
        raise boom
    assert not act_lock_path(tmp_path, "zenith").exists()
    assert _row_count(db) == 0


def test_the_lock_is_released_even_if_deleting_the_row_fails(tmp_path: Path) -> None:
    """A dead database on the way out must not strand the Bash-visible lock
    -- the row expires on its own after the TTL, the lock file would not."""
    db = _memory_db()
    lease = RunLease(db, tmp_path, "builtin", "zenith", kind="act")
    lease.__enter__()
    db.close()
    with pytest.raises(sqlite3.ProgrammingError):
        lease.__exit__(None, None, None)
    assert not act_lock_path(tmp_path, "zenith").exists()


def test_a_released_account_can_be_leased_again_immediately(tmp_path: Path) -> None:
    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
        pass
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
        assert act_lock_path(tmp_path, "zenith").exists()
        assert _row_count(db) == 1


def test_the_run_id_and_pid_are_recorded_for_diagnostics(tmp_path: Path) -> None:
    """`SKIP zenith -- locked (another run in progress)` is all Bash can say.
    The row is what makes `who holds this account, since when, and is that
    process still alive` answerable."""
    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="r-42", now=_now):
        row = db.execute("SELECT run_id, pid, acquired_at FROM run_leases").fetchone()
        assert row == ("r-42", os.getpid(), _NOW)


# --------------------------------------------------------------------------
# concurrency: WAL + busy_timeout on the connection a lease actually uses
# (spec §15.1 row 23 -- stage 3's dry run never opened this file, since a dry
# run takes no lease; stage 4 puts 3-5 Python cycles on it at once)
# --------------------------------------------------------------------------


def test_open_lease_db_puts_a_real_connection_in_wal_journal_mode(tmp_path: Path) -> None:
    """Queried on the SAME connection `open_lease_db` returns and a lease
    goes on to use -- not inferred from the setup code having run. A real
    file, not `:memory:`: SQLite silently pins an in-memory database to
    `memory` journal mode no matter what is requested, so a `:memory:`
    fixture here would pass whether or not the WAL pragma executed, proving
    nothing about the file every real cycle actually opens.
    """
    db_path = tmp_path / "run_leases.sqlite"
    db = track(open_lease_db(str(db_path)))
    try:
        with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
            journal_mode = db.execute("PRAGMA journal_mode").fetchone()[0]
        assert str(journal_mode).lower() == "wal"
    finally:
        db.close()


def test_open_lease_db_sets_a_busy_timeout_distinguishable_from_sqlite3s_own_default(
    tmp_path: Path,
) -> None:
    """`sqlite3.connect()`'s own `timeout` parameter defaults to 5.0s and is
    already wired to `PRAGMA busy_timeout` -- a bare `sqlite3.connect(path)`,
    with no code from this module involved at all, reports `busy_timeout` as
    5000. A test pinned to 5000 could not tell "the pragma ran" from "nobody
    ever calls `open_lease_db` and plain `sqlite3.connect` was used instead"
    apart -- exactly the fixture-discriminability trap (mutating this line
    out would leave such a test green). `_BUSY_TIMEOUT_MS` is chosen away
    from stdlib's default for exactly this reason; this test pins the actual
    value in force on the connection a lease uses, not the module constant,
    so a regression back to a value indistinguishable from the stdlib
    default fails here even if `_BUSY_TIMEOUT_MS` itself is edited to match.
    """
    plain = track(sqlite3.connect(str(tmp_path / "plain.sqlite")))
    assert plain.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    plain.close()

    db_path = tmp_path / "run_leases.sqlite"
    db = track(open_lease_db(str(db_path)))
    try:
        with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
            busy_timeout = db.execute("PRAGMA busy_timeout").fetchone()[0]
        assert int(busy_timeout) == 8000
    finally:
        db.close()


def test_a_memory_lease_db_still_gets_a_busy_timeout_even_though_wal_is_impossible(
    tmp_path: Path,
) -> None:
    """The dry-run path (`cli.py`'s `_cycle_stores`) opens `:memory:` through
    this same function. WAL cannot apply there (SQLite pins in-memory
    databases to `memory` journal mode), but `busy_timeout` is an ordinary
    per-connection pragma with no such restriction, and costs nothing to set
    on a connection nothing else can ever contend for."""
    db = track(open_lease_db(":memory:"))
    try:
        assert str(db.execute("PRAGMA journal_mode").fetchone()[0]).lower() == "memory"
        assert int(db.execute("PRAGMA busy_timeout").fetchone()[0]) == 8000
    finally:
        db.close()


# --------------------------------------------------------------------------
# heartbeat is best-effort: a locked database must not abort a cycle, and a
# failure to beat must not go unnoticed either (spec §15.1 row 23)
# --------------------------------------------------------------------------


class _LockedOnHeartbeat(sqlite3.Connection):
    """Fails only the heartbeat's `UPDATE` -- `RunLease.__enter__` never
    issues one (schema DDL, a `SELECT` for reclaim, an `INSERT`), so this
    isolates the failure to exactly the statement `heartbeat()` runs and
    leaves acquisition itself unaffected."""

    def execute(self, sql: str, parameters: Any = (), /) -> sqlite3.Cursor:
        if sql.lstrip().upper().startswith("UPDATE"):
            raise sqlite3.OperationalError("database is locked")
        return super().execute(sql, parameters)


def _locked_on_heartbeat_db() -> sqlite3.Connection:
    return track(sqlite3.connect(":memory:", factory=_LockedOnHeartbeat))


def test_a_heartbeat_failure_does_not_abort_the_cycle(tmp_path: Path) -> None:
    """The whole point: `run_cycle` calls `heartbeat()` between every graph
    superstep with no guard of its own, so a raised `OperationalError` here
    would end an in-flight round over a single missed beat. It must not."""
    db = _locked_on_heartbeat_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act") as lease:
        lease.heartbeat()  # must not raise


def test_a_heartbeat_failure_is_logged_at_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Not abort, but not silent either: a heartbeat that keeps failing is,
    from Bash's side, indistinguishable from a process that stopped
    heartbeating for real, and Bash reclaims this lease's file half after
    `LEASE_TTL_SECONDS` either way. An operator needs to see this before
    that clock runs out, which means it must be logged at a level nobody
    has to opt into -- WARNING, not INFO or DEBUG."""
    db = _locked_on_heartbeat_db()
    with (
        caplog.at_level(logging.WARNING, logger="swil_agent.graph.leases"),
        RunLease(db, tmp_path, "builtin", "zenith", kind="act", run_id="r-1") as lease,
    ):
        lease.heartbeat()
    assert "heartbeat failed" in caplog.text
    assert "zenith" in caplog.text
    assert "r-1" in caplog.text


def test_a_successful_heartbeat_logs_nothing_at_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Negative control for the test above: a mutant that warns unconditionally
    (not only on failure) would pass every other test in this file and hide a
    genuinely healthy fleet behind constant WARNING noise an operator would
    learn to ignore -- which defeats the point of logging failures at all."""
    db = _memory_db()
    with (
        caplog.at_level(logging.WARNING, logger="swil_agent.graph.leases"),
        RunLease(db, tmp_path, "builtin", "zenith", kind="act") as lease,
    ):
        lease.heartbeat()
    assert caplog.text == ""


def test_a_heartbeat_row_failure_still_refreshes_the_bash_visible_lock_file(
    tmp_path: Path,
) -> None:
    """The row write and the file touch are two different liveness signals
    for two different readers (this module's own docstring). A transient
    `database is locked` on the row must not also cost the cycle its
    Bash-visible half -- that file's mtime is the ONLY thing a concurrently
    running Bash round ever looks at (auto-run.sh:422)."""
    db = _locked_on_heartbeat_db()
    lock = act_lock_path(tmp_path, "zenith")
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act") as lease:
        old = time.time() - (STALE_AFTER_SECONDS + 60)
        os.utime(lock, (old, old))
        assert time.time() - lock.stat().st_mtime > STALE_AFTER_SECONDS
        lease.heartbeat()
        assert time.time() - lock.stat().st_mtime < STALE_AFTER_SECONDS


def test_a_heartbeat_failure_does_not_touch_the_row(tmp_path: Path) -> None:
    """Companion to the failure-is-logged test, from the data side: a failed
    `UPDATE` must leave `heartbeat_at` exactly where it was, not partially
    applied -- `_LockedOnHeartbeat` raises before `sqlite3` can commit
    anything, so the row this test reads back must still carry the
    acquisition-time stamp."""
    db = _locked_on_heartbeat_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act", now=_now) as lease:
        before = _heartbeat_of(db, "builtin", "zenith")
        lease.heartbeat(now=before + 500)
        assert _heartbeat_of(db, "builtin", "zenith") == before
