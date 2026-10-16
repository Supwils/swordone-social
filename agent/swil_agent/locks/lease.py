"""Run leases -- a SQLite row that also holds the lock file.

Spec §7.3 says `lock_<name>` / `dream_lock_<name>` "become a row in SQLite
with a uniqueness constraint and a heartbeat timestamp". The lease keeps the
file as well: `opportunistic-round.sh` sweeps dead-PID lock files, and a
second process that only looks at `.agent-state/lock_<name>` must still see
the account as held.

So a lease holds BOTH:

- the **file lock** (`swil_agent.locks.file.FileLock`, 1800s staleness rule) --
  the cheap, atomic guard that `opportunistic-round.sh` also sweeps;
- the **row** -- this is what makes a lease *expire*, and what carries the
  identity (`run_id`, `pid`) that a bare lock file cannot.

Removing the file half would blind that sweep and any file-based check.

**What actually kills the orphan-lock class: the dead pid.** Time-based
expiry alone would cost a dead run's account up to 30 minutes of SKIPped
rounds. Both halves carry the holder's **pid** -- line 1 of the lock file and
the row's `pid` column -- and both are reclaimable *immediately* once that pid
is gone. The file has to apply the rule itself (`FileLock`): it is acquired
first, so a row reclaim behind a file that only aged out after 1800s was
unreachable for the whole window. Time expiry stays as the backstop for a
reused pid.

Pid liveness is only meaningful on the host that wrote the row. This runtime
is single-host by construction (the lease DB is a local SQLite file, and
SQLite over a network filesystem is unsound for other reasons), so no host
column is carried. If the DB ever becomes shared, `_pid_alive` must gain one.

Ordering is load-bearing: **file lock first, row second**. The file lock is
the cross-runtime authority, so the exclusion decision is made before any
claim is published; and if the row fails, the file lock is released. The
reverse order publishes a Python-side claim while the account still reads as
free to Bash, and any slip in its rollback strands a lock file -- invisible
to SQLite, and enough to make every later Bash round SKIP that account until
the staleness window runs out.

Release is **identity-scoped**, not key-scoped. A holder whose lease was
legitimately reclaimed while it was still running must not, on the way out,
delete the *successor's* row or unlink the successor's lock file -- which is
what a `WHERE (tenant, agent, kind)` delete and an unconditional unlink would
do, leaving the live successor holding neither half and nothing to tell it so.
Every write past acquisition therefore carries `run_id`, and the file half is
guarded by a random token this lease **wrote into** the lock file.

**Why a token in the file and not the inode number.** This guard used to
compare `st_ino`, on the stated assumption that a reclaim is unlink-then-create
and "the replacement gets a new inode". That is false, and not marginally:
ext4 hands a just-freed inode straight back to the next create, so on Linux
the successor's lock file routinely carries the predecessor's inode number and
the guard answers "still mine" about a file it does not own -- the exact ABA
hole it exists to close. APFS allocates file IDs from a monotonic counter
instead (measured on this repo's own volume: 300 unlink/create cycles at one
path, 300 distinct strictly-increasing ids), which is why the macOS dev
machine never saw this and why CI, the first time it ever ran this file on
Linux, failed both ABA tests immediately. **No `stat` field is a sound
identity**: `st_ino` and `st_dev` are recycled by design, and the timestamps
have filesystem-dependent granularity, so a create following an unlink within
the same tick is indistinguishable. Identity has to be something no later
file can be *handed*; a `uuid4` this process minted and wrote is that, and it
survives on disk exactly as long as the file it identifies. Cost: one small
read per heartbeat and one on release, in place of a `stat`.

A busy lease raises `LeaseBusy` immediately. There is deliberately no retry
loop: Bash logs `SKIP <name> -- locked` and moves on, and
waiting instead would change round scheduling.

**Concurrency on the SQLite file itself** (spec §15.1 row 23). Stage 3's
`--dry-run` shadow round never opened `run_leases.sqlite` -- a dry run takes
no lease -- so it never exercised what stage 4 does: 3-5 Python cycles, each
its own connection, sharing one file. `open_lease_db` sets `journal_mode=WAL`
and `busy_timeout` on that connection, once, at open, so a second writer
waits instead of raising `database is locked` on the spot. `heartbeat()`
still treats a locked database as a recoverable miss, not a reason to end the
cycle -- but logs it, because a heartbeat that fails silently and a heartbeat
that stops running are indistinguishable to Bash, which reclaims this lease's
file half after `LEASE_TTL_SECONDS` either way.
"""

from __future__ import annotations

import contextlib
import logging
import os
import sqlite3
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from types import TracebackType
from typing import Final, Literal

from swil_agent.locks.file import (
    FileLock,
    LockBusy,
    act_lock_path,
    dream_lock_path,
    read_lock_identity,
)

logger = logging.getLogger("swil_agent.graph.leases")

# The same 1800s window `locks.STALE_AFTER_SECONDS` applies to the file half. The two
# halves of one lease must expire at the same instant -- any gap between them
# is a window in which one runtime reclaims what the other still considers
# held. `test_the_ttl_matches_the_bash_staleness_window` pins the equality.
LEASE_TTL_SECONDS: Final = 1800.0

# This module owns the FILENAME, not the directory -- the same split
# `graph/checkpoint.py` makes for `CHECKPOINT_DB_NAME`, so both stay trivially
# testable against a `tmp_path` while the composition root (`cli/stores.py`) decides
# they live next to `lock_<name>` under `agent/.agent-state/`.
LEASE_DB_NAME: Final = "run_leases.sqlite"

# Milliseconds `sqlite3`'s busy handler waits before raising `OperationalError`
# on a locked database, rather than raising immediately (SQLite's own C-level
# default). Stage 4 puts 3-5 Python cycles' `heartbeat()` calls on the same
# `run_leases.sqlite` -- Bash never opens this file, but the Python side alone
# is enough concurrent writers that "raise instantly" turns an ordinary
# lock-step collision into a lost round. Spec §15.1 row 23 names 5000; that
# value is deliberately NOT used here -- `sqlite3.connect()`'s own `timeout`
# parameter defaults to 5.0s and is *already* wired to this exact pragma
# (confirmed: a bare `sqlite3.connect(path)` reports `PRAGMA busy_timeout`
# as 5000 with no code in this module involved), so setting 5000 explicitly
# would be indistinguishable from not setting it at all -- a mutation
# deleting the pragma call would leave every test green. 8000 is chosen
# instead: still short enough that a stuck peer does not stall a heartbeat
# for minutes, and far enough from stdlib's own default that "this line
# runs" is provable rather than assumed.
_BUSY_TIMEOUT_MS: Final = 8000

LeaseKind = Literal["act", "dream"]

# What the file at the lock path is, relative to this lease. Three answers,
# not two, because the two decisions the lease makes about that file take
# opposite sides of the uncertain case: an mtime is refreshed only on proof
# of ownership (`ours`), while the unlink is skipped only on proof of foreign
# ownership (`theirs`) -- a stranded lock costs the account every later round,
# so `unknown` releases.
_LockFileOwner = Literal["ours", "theirs", "unknown"]

# `kind` is part of the identity because Bash locks act and dream separately.
# Collapsing them onto (tenant, agent) would serialise a dream behind an
# unrelated act -- a behaviour change, not a simplification.
_LOCK_PATH: Final[dict[str, Callable[[Path, str], Path]]] = {
    "act": act_lock_path,
    "dream": dream_lock_path,
}

_SCHEMA: Final = """CREATE TABLE IF NOT EXISTS run_leases (
    tenant TEXT NOT NULL,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    run_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    acquired_at REAL NOT NULL,
    heartbeat_at REAL NOT NULL,
    PRIMARY KEY (tenant, agent, kind)
)"""

# One spelling of each predicate, reused by every statement that needs it.
# `_OWNED_WHERE` is `_KEY_WHERE` plus the holder's identity: acquisition
# competes on the key, but every later write must prove it is still the
# holder, or a reclaimed-but-still-running lease clobbers its successor.
_KEY_WHERE: Final = "tenant = ? AND agent = ? AND kind = ?"
_OWNED_WHERE: Final = f"{_KEY_WHERE} AND run_id = ?"

_INSERT: Final = (
    "INSERT INTO run_leases "
    "(tenant, agent, kind, run_id, pid, acquired_at, heartbeat_at) "
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
)
_DELETE_OWNED: Final = f"DELETE FROM run_leases WHERE {_OWNED_WHERE}"
_TOUCH: Final = f"UPDATE run_leases SET heartbeat_at = ? WHERE {_OWNED_WHERE}"
_SELECT: Final = "SELECT tenant, agent, kind, run_id, pid, heartbeat_at FROM run_leases"
_SELECT_ONE: Final = f"{_SELECT} WHERE {_KEY_WHERE}"


class LeaseBusy(RuntimeError):  # noqa: N818 -- mandated name, see task-3-brief.md interfaces
    """Another run holds this account's lease. The caller SKIPs, as Bash does."""

    def __init__(self, tenant: str, agent: str, kind: str, reason: str) -> None:
        super().__init__(f"{tenant}:{agent} {kind} lease busy ({reason})")
        self.tenant = tenant
        self.agent = agent
        self.kind = kind
        self.reason = reason


def _pid_alive(pid: int) -> bool:
    """Is `pid` a live process on this host?

    `os.kill(pid, 0)` sends no signal but runs the same permission and
    existence checks, which is the standard liveness probe. Two traps:

    - `PermissionError` means the process **exists** and belongs to another
      user. It is emphatically not "dead" -- reading it as dead would steal a
      live lease. Every non-`ProcessLookupError` `OSError` is answered
      "alive" for the same reason: the conservative failure is to leave a
      lease alone and let the time-based TTL handle it.
    - `pid <= 0` is not a probe at all: `os.kill(0, 0)` signals this
      process's entire group and a negative pid signals another group.
      Answered "alive" so a corrupt row can never be turned into a
      group-wide signal.
    """
    if pid <= 0:
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def open_lease_db(path: str) -> sqlite3.Connection:
    """Open a connection to the lease database, tuned for the concurrency
    stage 4 introduces: `journal_mode=WAL` and `busy_timeout` set on the
    connection, once, here.

    Before this, `sqlite3.connect` was called with every other setting left
    at SQLite's own defaults: rollback journal, and a busy timeout of zero --
    meaning a second writer that finds the database locked raises
    `sqlite3.OperationalError` immediately rather than waiting for the first
    writer to finish its transaction. `ensure_schema` runs on every
    `RunLease.__enter__` and every `sweep_expired` call -- setting pragmas
    there would mean re-issuing them on every one of those, which is `PRAGMA
    busy_timeout` for the connection either way but is exactly the "scattered
    across call sites" shape this function exists to avoid: one caller
    reconnecting with a different timeout would have no single place that
    still describes what the connection's settings actually are. Applying it
    once, at the point the connection is opened, means the pragmas are a
    property of the connection for its entire lifetime, not of any particular
    call that happens to run first.

    A `:memory:` connection (dry runs, most of this module's own tests)
    cannot use WAL -- SQLite pins an in-memory database to `MEMORY` journal
    mode regardless of what is requested, silently, which is fine: nothing
    else can open a second connection to the same private `:memory:`
    database, so there is no contention for WAL to help with there anyway.
    `busy_timeout` still applies (and is harmless) on that path.
    """
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
    return db


def ensure_schema(db: sqlite3.Connection) -> None:
    """Idempotent; every entry point calls it so no caller has to remember."""
    db.execute(_SCHEMA)
    db.commit()


def _reclaim(db: sqlite3.Connection, now: float, key: tuple[str, str, str] | None = None) -> int:
    """Delete every reclaimable lease (optionally only one key's); return the count.

    Reclaimable means **either** the holder's pid is gone -- immediate, and
    the whole reason the row exists -- **or** the heartbeat has aged past the
    TTL, which is the backstop for a pid that was reused by an unrelated
    process. Deletes are identity-scoped on `run_id` so a row that was
    replaced between the SELECT and the DELETE is left alone.
    """
    sql, params = (_SELECT, ()) if key is None else (_SELECT_ONE, key)
    rows = db.execute(sql, params).fetchall()
    dead = [
        (tenant, agent, kind, run_id)
        for tenant, agent, kind, run_id, pid, heartbeat_at in rows
        if not _pid_alive(int(pid)) or heartbeat_at <= now - LEASE_TTL_SECONDS
    ]
    for owned_key in dead:
        db.execute(_DELETE_OWNED, owned_key)
    db.commit()
    return len(dead)


def sweep_expired(db: sqlite3.Connection, now: float) -> int:
    """Delete every reclaimable lease; return the count.

    A convenience for startup and for observability. Correctness does not
    depend on anyone calling it -- `RunLease.__enter__` reclaims its own key,
    the same way the file lock reclaims its own stale file. Requiring an
    external sweep would have made the row a *new* orphan class, strictly
    worse than the lock file it accompanies.
    """
    ensure_schema(db)
    return _reclaim(db, now)


class RunLease:
    """Context manager holding one account's run lease for the duration of a cycle.

    Both halves are released on `__exit__` unconditionally -- normal return,
    `Exception`, `KeyboardInterrupt`, `SystemExit(141)`. That is the whole
    point: the orphan locks this replaces came from a path that exited
    without running its cleanup.
    """

    def __init__(
        self,
        db: sqlite3.Connection,
        agent_root: Path,
        tenant: str,
        agent_dir_name: str,
        kind: LeaseKind,
        *,
        run_id: str | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        """`agent_dir_name` is the **persona directory name** (`agents/<name>`),
        not the username.

        Lock files are `.agent-state/lock_<dir name>`. Folder name and
        registered username can diverge, and a lease built from the username
        computes a *different* lock path than every other holder -- with every
        test still green, because each would lock a file no one else looks
        at. Pass `Path(persona_dir).name`.
        """
        if kind not in _LOCK_PATH:
            # There is no Bash lock file for a third kind, so a typo would run
            # with no cross-runtime exclusion at all rather than failing loudly.
            raise ValueError(f"unknown lease kind: {kind!r}")
        self._db = db
        self._key = (tenant, agent_dir_name, kind)
        # Defaults to the pid for the same reason Bash writes `$$` into the
        # lock file: with no run id supplied, "who holds this" should still
        # be answerable. The graph passes `CycleState["run_id"]`.
        self._run_id = f"pid-{os.getpid()}" if run_id is None else run_id
        self._owned_key = (*self._key, self._run_id)
        self._pid = os.getpid()
        self._now = now
        self._lock_path = _LOCK_PATH[kind](agent_root, agent_dir_name)
        # Minted here, once, and written into the lock file at acquisition:
        # one `RunLease` instance is one acquisition (`cycle.py:_acquire`
        # builds a fresh one per kind per round and enters it exactly once),
        # so the token's lifetime is the file's. NOT `run_id`: its own default
        # is `pid-<n>`, and a pid is precisely the kind of value the operating
        # system hands out again.
        self._lock_token = uuid.uuid4().hex
        self._lock = FileLock(self._lock_path, identity=self._lock_token)

    def _lock_file_owner(self) -> _LockFileOwner:
        """Whose is the file at the lock path *now*?

        Identity is the random token this lease WROTE INTO the file at
        acquisition, compared against what is on disk at this instant. It is
        deliberately not any `stat` field: this guard used to compare
        `st_ino`, and an inode number is recycled -- ext4 hands the one just
        freed by the reclaiming unlink straight back to the create that
        follows it, so the successor's
        file answers to the predecessor's inode and the predecessor then
        deletes a lock it does not hold. `st_dev` is likewise reused, and the
        timestamps have filesystem-dependent granularity. A token cannot be
        handed to a later file by anyone but this process.

        `theirs` covers a Bash reclaim too: `echo "$$"` writes a bare pid with
        no identity line at all, which is not this lease's token.
        """
        try:
            on_disk = read_lock_identity(self._lock_path)
        except (OSError, UnicodeDecodeError):
            # Unreadable, already gone, or bytes that are not UTF-8 at all.
            # `UnicodeDecodeError` is caught HERE and not by an `except
            # OSError` because it is a `ValueError`: it does not descend from
            # `OSError` and an `except OSError` lets it escape. That escape is
            # not a cosmetic gap -- `run_graph` calls `heartbeat()` between
            # every superstep with no guard of its own (`graph/run.py`),
            # and `__exit__` reaches this through a `finally` that has already
            # committed the row DELETE, so a single 0xff byte in the lock file
            # would end the round AND leave the file behind with no SQLite
            # record of it -- the orphan-lock class this module exists to
            # kill, reintroduced by its own guard. The `stat()` this guard
            # replaced could not raise it, so the class is new here and is
            # pinned by a test.
            #
            # The caller decides what to do with `unknown` -- see
            # `_LockFileOwner` -- because "assume mine" and "assume not mine"
            # are each the safe answer at exactly one of the two call sites.
            return "unknown"
        return "ours" if on_disk == self._lock_token else "theirs"

    def _holds_lock_file(self) -> bool:
        """Is the file at the lock path PROVABLY still the one this lease created?"""
        return self._lock_file_owner() == "ours"

    def __enter__(self) -> RunLease:
        try:
            self._lock.acquire()
        except LockBusy as exc:
            # Bash (or another Python run) got there first. No row is written,
            # so nothing has to be rolled back.
            raise LeaseBusy(*self._key, str(exc)) from exc
        # No identity to capture here: `FileLock` wrote `self._lock_token`
        # into the file as part of the same atomic create that won the lock,
        # so there is no window between "we hold it" and "we can prove it",
        # and no read that could fail and leave the lease unable to recognise
        # its own file for the rest of the round.
        try:
            ensure_schema(self._db)
            now = self._now()
            _reclaim(self._db, now, self._key)
            self._db.execute(_INSERT, (*self._key, self._run_id, self._pid, now, now))
            self._db.commit()
        except Exception as exc:
            # Every failure past this point -- conflict, `database is locked`,
            # a closed connection -- must give the file lock back. Catching
            # only IntegrityError is what strands a lock file.
            self._release_lock_file()
            if isinstance(exc, sqlite3.IntegrityError):
                raise LeaseBusy(*self._key, "lease row already held") from exc
            raise
        return self

    def heartbeat(self, *, now: float | None = None) -> None:
        """Mark the lease alive: advance the row, and refresh the lock file's mtime.

        Both, because the two runtimes read different things. Bash's staleness
        test is the file's mtime, so a long
        cycle that only heartbeat the row would have its lock file reclaimed
        out from under it by the next Bash round -- the double-run the file
        half exists to prevent. The file is touched with the real wall clock
        rather than `now`, because `FileLock` compares against `time.time()`;
        an injected test clock written into the mtime would read as decades
        stale.

        Both writes are identity-scoped. A lease that was legitimately
        reclaimed while still running updates zero rows and touches nothing,
        rather than extending its successor's claim on its behalf.

        The row write is best-effort. `run_cycle` calls this between every
        graph superstep with no guard of its own (spec §15.1 row 23), so a
        `sqlite3.OperationalError` here -- realistically `database is locked`,
        stage 4's 3-5 concurrent Python cycles sharing `run_leases.sqlite`
        with `busy_timeout` already exhausted -- would otherwise propagate out
        of `run_cycle` and end the round over a single missed beat. That is
        the wrong failure mode: a missed beat is recoverable (the next node's
        heartbeat tries again), a dead round is not. But it is not swallowed
        silently either -- a heartbeat that keeps failing is functionally
        identical, from Bash's side, to a process that stopped heartbeating
        for real, and another holder reclaims this lease's file half after
        `LEASE_TTL_SECONDS` regardless of why the row went stale. Logged at
        WARNING, so an operator sees a struggling lease well before that
        1800s clock runs out and a second runtime starts acting on the same
        account -- not after. The lock file below is still touched
        regardless of whether the row write succeeded: it is the half every
        other holder reads, and it does not depend on SQLite.
        """
        stamp = self._now() if now is None else now
        try:
            self._db.execute(_TOUCH, (stamp, *self._owned_key))
            self._db.commit()
        except sqlite3.OperationalError as exc:
            logger.warning(
                "lease heartbeat failed for %s:%s %s (run_id=%s): %s -- row not refreshed",
                *self._key,
                self._run_id,
                exc,
            )
        if self._holds_lock_file():
            # Gone means someone swept `.agent-state/` by hand mid-round; the
            # row is still the liveness record, so do not kill the cycle.
            with contextlib.suppress(OSError):
                os.utime(self._lock_path, None)

    def _release_lock_file(self) -> None:
        """Unlink the lock file unless it is PROVABLY someone else's.

        `FileLock.release()` unlinks whatever is at the path. If this lease
        was reclaimed as stale and a successor recreated the file, that unlink
        would leave a live successor holding no lock at all -- and Bash would
        then be free to start a second round on the same account.

        `unknown` releases, which is the opposite of what `heartbeat` does
        with it and is deliberate: the mtime refresh is an *extra* claim, so
        declining it costs nothing, while declining the unlink strands a lock
        file that no Python process will ever come back for and that costs the
        account every round until its pid is seen dead or 1800s pass.
        """
        if self._lock_file_owner() != "theirs":
            self._lock.release()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        try:
            self._db.execute(_DELETE_OWNED, self._owned_key)
            self._db.commit()
        finally:
            # `finally`, so a dead database on the way out cannot strand the
            # lock file. The row expires on its own after the TTL;
            # the lock file would not.
            self._release_lock_file()
