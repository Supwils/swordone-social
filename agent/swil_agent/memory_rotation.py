"""Keep `memory.md` short without losing a line.

`memory.md` is append-only and grows every round. Once it passes `max_lines`,
the oldest lines move to `memory.archive.md` (appended, chronological) and the
live file is atomically rewritten with the newest `keep` lines.

Both the act and the dream path append to memory.md, each under its own lock,
so a caller must hold BOTH `lock_<name>` and `dream_lock_<name>` while it
rotates; otherwise an append between the read and the replace is lost.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Final

from swil_agent.atomic_write import atomic_write

ARCHIVE_FILENAME: Final = "memory.archive.md"
DEFAULT_MAX_LINES: Final = 300
DEFAULT_KEEP: Final = 200


def _lines(text: str) -> list[str]:
    """Split on `\\n` only, dropping the one empty element a trailing newline
    leaves -- the same rule `analysis/summary.py` uses."""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def rotate_memory(
    path: Path, *, max_lines: int = DEFAULT_MAX_LINES, keep: int = DEFAULT_KEEP
) -> int:
    """Rotate `path` when it holds more than `max_lines` lines.

    Returns the number of lines moved to the archive (0 for a no-op or a
    missing file). The archive is written before the live file is replaced,
    so a crash in between duplicates lines rather than losing them.
    """
    if keep > max_lines:
        raise ValueError(f"keep ({keep}) must not exceed max_lines ({max_lines})")
    if not path.is_file():
        return 0
    lines = _lines(path.read_text(encoding="utf-8"))
    if len(lines) <= max_lines:
        return 0

    moved, kept = lines[:-keep] if keep else lines, lines[-keep:] if keep else []
    archive = path.with_name(ARCHIVE_FILENAME)
    prefix = ""
    if archive.is_file() and archive.stat().st_size > 0:
        with archive.open("rb") as handle:
            handle.seek(-1, os.SEEK_END)
            if handle.read(1) != b"\n":
                prefix = "\n"
    with archive.open("a", encoding="utf-8") as handle:
        handle.write(prefix + "\n".join(moved) + "\n")
        handle.flush()
        os.fsync(handle.fileno())

    atomic_write(path, "".join(f"{line}\n" for line in kept))
    return len(moved)
