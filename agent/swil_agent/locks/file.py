"""Per-account lock files under `agent/.agent-state/`.

A lock file is the cheap guard that works without the SQLite run-lease row:
creation is atomic (`O_EXCL`), and a held file is reclaimed when it is
**stale**: its line-1 pid is a process that no longer exists, or its mtime is
older than 1800s (the backstop for a pid the system handed to someone else).
The dead-pid rule is what lets a crashed run's account run again on the next
round instead of 30 minutes later; `RunLease`'s row reclaim (`locks/lease.py`)
is only reachable once the file half has been won, so the file has to apply
the same rule itself.

**Reclaim has one winner.** An unlink-then-create reclaim lets a second
process that judged the SAME stale file unlink the first one's brand-new lock
and create its own: two holders. Here a reclaimer first takes an exclusive,
non-blocking `flock` on a hidden guard file next to the lock
(`.<name>.reclaim`, kept, never unlinked; the kernel drops the flock when its
holder dies, so a crashed reclaimer strands nothing). Under it, the lock file
must still be byte-for-byte (content and mtime) the file judged stale;
it is then renamed to a unique hidden tombstone (`.<name>.reclaim-<uuid>`),
checked once more, and deleted. Only then does the reclaimer race for the path
with `O_EXCL`, where exactly one create wins. A file that changed in between
(a new holder, or the old holder's heartbeat) is put back with `os.link`,
which never overwrites. The hidden names sit outside the round script's
`lock_*` / `dream_lock_*` sweep.

**The on-disk format is one or two lines.** Line 1 is the holder's pid and
nothing else, plus a newline, because `opportunistic-round.sh` sweeps a file
whose `head -1` pid is dead, and `cat`-ing a lock during an incident is how an
operator finds the process. Line 2 is OPTIONAL and carries an `identity` token
supplied by the caller -- a value unique to *this acquisition*, so a holder can
later tell its own file apart from a replacement created at the same path
after its lock was reclaimed. `read_lock_identity` is the reader.

A line 1 that is not a pid (empty, or not digits) is never read as dead: an
empty file is what a winner's lock looks like in the instant between its
`O_EXCL` create and its write, and stealing it there would be a double hold.
Such a file falls back to the mtime rule.
"""

from __future__ import annotations

import contextlib
import fcntl
import os
import time
import uuid
from pathlib import Path
from types import TracebackType
from typing import NamedTuple

STALE_AFTER_SECONDS = 1800


class LockBusy(RuntimeError):  # noqa: N818 -- mandated name, see task-2-brief.md interfaces
    """Another run holds this lock and it is not stale yet."""

    def __init__(self, path: Path, age_seconds: int, detail: str | None = None) -> None:
        suffix = "" if detail is None else f"; reclaim failed: {detail}"
        super().__init__(f"{path.name} held ({age_seconds}s){suffix}")
        self.path = path
        self.age_seconds = age_seconds
        self.detail = detail


class _Seen(NamedTuple):
    """What a lock file looked like: enough to tell it from any later file."""

    mtime: float
    content: bytes


def _inspect(path: Path) -> _Seen | None:
    """`path`'s mtime and bytes, or `None` if it is gone. Other `OSError`s
    propagate."""
    try:
        mtime = path.stat().st_mtime
        content = path.read_bytes()
    except FileNotFoundError:
        return None
    return _Seen(mtime, content)


def _holder_is_dead(content: bytes) -> bool:
    """Is line 1 a pid that names no process on this host?

    Only `ProcessLookupError` is death: `PermissionError` is a live process of
    another user. A line 1 that is not a positive pid is never dead (see the
    module docstring) -- and `os.kill(0, 0)` would probe a whole group."""
    first = content.split(b"\n", 1)[0].strip()
    if not first.isdigit() or int(first) <= 0:
        return False
    try:
        os.kill(int(first), 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False


def act_lock_path(agent_root: Path, name: str) -> Path:
    return agent_root / ".agent-state" / f"lock_{name}"


def dream_lock_path(agent_root: Path, name: str) -> Path:
    return agent_root / ".agent-state" / f"dream_lock_{name}"


def read_lock_identity(path: Path) -> str | None:
    """The identity token on the lock file's second line, or `None` if it has none.

    `None` is a real answer, not an error: a Bash-written lock (`echo "$$"`)
    is a bare pid, and so is a `FileLock` constructed without an `identity`.
    Either way the file is provably not one that a caller holding a token
    created, which is what the caller needs to know.

    A file this cannot READ raises instead, because the safe response to "I
    cannot tell" differs by call site and this function must not decide it: a
    holder deciding whether to REFRESH an mtime should treat it as not-mine,
    while a holder deciding whether to UNLINK on the way out should treat it
    as mine -- a stranded lock file costs the account every later round, which
    is the orphan-lock class this whole module exists to avoid.

    **Two exception types, and callers must catch both.** `OSError` covers
    missing/unreadable. Bytes that are not UTF-8 raise `UnicodeDecodeError`,
    which is a `ValueError` and therefore NOT caught by `except OSError` --
    the trap that hid this for a review round. Callers that treat a failure as
    "unknown" must spell `except (OSError, UnicodeDecodeError)`.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) < 2 or not lines[1]:
        return None
    return lines[1]


class FileLock:
    """`identity`, when given, is written on the file's second line.

    It must be unique to this acquisition -- `uuid4().hex`, not a pid and not
    a run id derived from one. The point is to let a holder whose lock was
    reclaimed as stale recognise that the file now at its path is a
    *successor's*, and anything a later process can be handed again (a pid, an
    inode number) cannot do that.

    It must also be exactly one non-empty line, and that is **enforced here
    rather than documented here**. It is written verbatim, so a line break
    would push the rest onto line 3 and an empty string would fail the
    reader's own emptiness test -- either way `read_lock_identity` returns
    something that never equals what the holder is comparing against, the
    holder reads its own live lock as a stranger's forever, and it therefore
    never refreshes the mtime and never unlinks. That is a stranded lock every
    round, arriving silently. A `ValueError` at construction turns a rule a
    comment could only assert into one a test can pin.

    Omitting it keeps the file byte-for-byte identical to Bash's own output,
    which is what a caller that never needs to re-identify its file should
    do. (Since S3 the only caller is `RunLease`, which always passes one.)
    """

    def __init__(
        self,
        path: Path,
        *,
        stale_after: int = STALE_AFTER_SECONDS,
        identity: str | None = None,
    ) -> None:
        # `splitlines() != [identity]` is the round-trip test, not a
        # line-count test: it is exactly the condition "`read_lock_identity`
        # gives this string back". A count of 1 is not enough -- a TRAILING
        # newline splits to one line whose value differs from the input, so
        # the holder would compare `"tok\n"` against the `"tok"` it reads back
        # and never match. Rejects embedded \n and \r, leading and trailing
        # breaks, and the empty string (`"".splitlines()` is `[]`) in one
        # predicate.
        if identity is not None and identity.splitlines() != [identity]:
            raise ValueError(f"lock identity must be exactly one non-empty line: {identity!r}")
        self._path = path
        self._stale_after = stale_after
        self._identity = identity
        self._held = False

    def _try_create(self) -> bool:
        try:
            fd = os.open(self._path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            # Trailing newline, so `cat` of a lock during an incident prints
            # the pid cleanly. The identity line, when there is one, goes
            # AFTER the pid for the same reason: `head -1` and a bare `cat`
            # still name the process.
            suffix = "" if self._identity is None else f"{self._identity}\n"
            handle.write(f"{os.getpid()}\n{suffix}")
        return True

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if self._try_create():
            self._held = True
            return
        try:
            seen = _inspect(self._path)
        except OSError:
            # Bash's fallback for a failed `stat` was age 0: always fresh, so
            # an unreadable lock is never silently treated as free.
            raise LockBusy(self._path, 0) from None
        if seen is not None:
            age = int(time.time() - seen.mtime)
            if age < self._stale_after and not _holder_is_dead(seen.content):
                raise LockBusy(self._path, age)
            try:
                reclaimed = self._reclaim(seen)
            except OSError as exc:
                # The guard, a look, the move or the restore failed for a
                # reason other than a racing peer. Not ours to take: busy,
                # with the cause, never a raw OSError out of a lease.
                raise LockBusy(self._path, age, detail=str(exc)) from exc
            if not reclaimed:
                raise LockBusy(self._path, age)
        else:
            age = 0  # released between our create and our look: just race for it
        if not self._try_create():
            raise LockBusy(self._path, age)
        self._held = True

    def _reclaim(self, seen: _Seen) -> bool:
        """Move the stale file `seen` out of the way. True when the path is
        now free of it; False when this call must not take the lock (another
        reclaim is in progress, or the file is no longer the one judged)."""
        guard_path = self._path.with_name(f".{self._path.name}.reclaim")
        guard = os.open(guard_path, os.O_CREAT | os.O_RDWR, 0o644)
        try:
            try:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return False  # another reclaimer is in the critical section
            current = _inspect(self._path)
            if current is None:
                return True  # released or swept meanwhile: `O_EXCL` decides
            if current != seen:
                return False  # a new holder, or the old one's heartbeat
            return self._move_aside(seen)
        finally:
            os.close(guard)  # releases the flock

    def _move_aside(self, seen: _Seen) -> bool:
        """Rename the judged file to a tombstone and verify it is `seen`.

        **Known window, accepted.** Between the in-guard look and the rename
        (microseconds) the old holder could release and a new holder create:
        the rename then takes the NEW holder's file. The verify catches that
        and `link` puts it back -- unless a third process created a lock at
        the empty path in that same gap, in which case the restore is refused
        (`link` never overwrites), the third process holds the lock, and the
        new holder learns at its next heartbeat that the file is not its own.
        Any `OSError` but a vanished file propagates (the caller reports
        busy); a file it could not verify is put back first, never deleted.
        """
        tombstone = self._path.with_name(f".{self._path.name}.reclaim-{uuid.uuid4().hex}")
        try:
            os.rename(self._path, tombstone)
        except FileNotFoundError:
            return True
        try:
            if _inspect(tombstone) == seen:
                return True
            # Changed between the look and the move: restore without ever
            # overwriting a lock created at the path since.
            with contextlib.suppress(FileExistsError):
                os.link(tombstone, self._path)
            return False
        except OSError:
            with contextlib.suppress(OSError):
                os.link(tombstone, self._path)
            raise
        finally:
            tombstone.unlink(missing_ok=True)

    def release(self) -> None:
        if self._held:
            self._path.unlink(missing_ok=True)
            self._held = False

    def __enter__(self) -> FileLock:
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.release()
