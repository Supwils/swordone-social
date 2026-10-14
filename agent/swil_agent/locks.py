"""Per-account lock files under `agent/.agent-state/`.

A lock file is the cheap guard that works without the SQLite run-lease row:
creation is atomic (`O_EXCL`) and a file older than 1800s is stale and
reclaimed. The design spec §7.3 adds the lease row, which expires a dead
run's claim where a dead run's lock file would not.

**The on-disk format is one or two lines.** Line 1 is the holder's pid and
nothing else, plus a newline, because
`cat`-ing a stale lock during an incident is how an operator finds the
process (cli.py's own LeaseBusy remedy tells them to do exactly that). Line 2
is OPTIONAL and carries an `identity` token supplied by the caller -- a value
unique to *this acquisition*, so a holder can later tell its own file apart
from a replacement created at the same path after its lock was reclaimed as
stale. `read_lock_identity` is the reader.

Staleness is decided from the file's **mtime** alone and release is
`rm -f`, so the optional second line is informational: what holders share is
the path, the mtime, and the file's existence.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from types import TracebackType

STALE_AFTER_SECONDS = 1800


class LockBusy(RuntimeError):  # noqa: N818 -- mandated name, see task-2-brief.md interfaces
    """Another run holds this lock and it is not stale yet."""

    def __init__(self, path: Path, age_seconds: int) -> None:
        super().__init__(f"{path.name} held ({age_seconds}s)")
        self.path = path
        self.age_seconds = age_seconds


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
    which is what the callers that never need to re-identify their file
    (`run_act`, `run_dream`, whose locks live and die inside a single `with`)
    should do.
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
            age = int(time.time() - self._path.stat().st_mtime)
        except OSError:
            age = 0
        if age < self._stale_after:
            raise LockBusy(self._path, age)
        self._path.unlink(missing_ok=True)
        if not self._try_create():
            raise LockBusy(self._path, age)
        self._held = True

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
