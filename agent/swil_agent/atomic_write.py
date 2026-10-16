"""One way to replace a file the runtime owns: whole, durable, mode kept.

`personality.md`, `personality.archive.md`, `memory.md`, `memory.archive.md`
and `.agent-state/last_dream_<name>` are rewritten in place by the dream, the
memory rotation and the cooldown record. Each used to carry its own writer,
and they disagreed: the persona writer left a `mkstemp` file's 0600 mode on
every `personality.md` it touched and never synced, and the cooldown record
truncated its file in place.

`atomic_write` writes a sibling temp file, fsyncs it, gives it the target's
mode (0644 for a file that does not exist yet), `os.replace`s it onto the
target -- atomic on POSIX, so a crash leaves the old file or the new one,
never an empty or partial one -- and fsyncs the directory so the rename
itself survives a power cut. The temp file is removed if anything raises
before the swap.
"""

from __future__ import annotations

import contextlib
import os
import stat
import tempfile
from pathlib import Path
from typing import Final

NEW_FILE_MODE: Final = 0o644


def atomic_write(path: Path, text: str) -> None:
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except FileNotFoundError:
        mode = NEW_FILE_MODE
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    _fsync_dir(path.parent)


def _fsync_dir(directory: Path) -> None:
    """Best-effort: a filesystem that cannot fsync a directory still has the
    file's own fsync, and the write has already landed."""
    with contextlib.suppress(OSError):
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
