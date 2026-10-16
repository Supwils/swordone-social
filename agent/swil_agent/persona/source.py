"""Where a persona is stored.

`GitPersonaSource` keeps the built-in roster on disk under git: personality.md,
personality.archive.md and memory.md. The git history IS the drift audit trail,
which is why these stay files rather than moving into the database.

`ApiPersonaSource` — for owner-created agents whose personas live server-side —
implements the same Protocol and is Plan 2+. Callers above this seam receive a
Persona and must never touch the filesystem directly.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Protocol

from swil_agent.atomic_write import atomic_write
from swil_agent.models import Persona
from swil_agent.persona.format import (
    MAX_FILE_BYTES,
    PersonaFormatError,
    clamp_recent,
    parse_persona,
    render_persona,
)
from swil_agent.persona.loader import load_persona, resolve_agent_dir

ARCHIVE_HEADER = "---\n# 旧版 personality（归档于 {stamp}）\n---\n"
_STAMP_FORMAT = "%Y-%m-%d %H:%M:%S"


class PersonaSource(Protocol):
    def load(self, name: str) -> Persona: ...
    def write_recent(self, name: str, recent: Sequence[str], when: datetime) -> str: ...
    def read_memory(self, name: str) -> str: ...
    def append_memory(self, name: str, line: str) -> None: ...


class GitPersonaSource:
    def __init__(self, agent_root: Path) -> None:
        self._agent_root = agent_root

    def _dir(self, name: str) -> Path:
        return resolve_agent_dir(self._agent_root, name)

    def load(self, name: str) -> Persona:
        return load_persona(self._dir(name))

    def write_recent(self, name: str, recent: Sequence[str], when: datetime) -> str:
        """Replace the persona's 最近 list and return the new file text.

        Only 最近 changes: frontmatter and card are re-rendered from the file as
        it is now. The old file is prepended to `personality.archive.md` first,
        so a failure there leaves `personality.md` untouched. Raises
        `PersonaFormatError` (writing nothing) when the current file is not a
        valid persona or the result would exceed the file size limit.
        """
        directory = self._dir(name)
        personality = directory / "personality.md"
        archive = directory / "personality.archive.md"

        current = load_persona(directory)
        doc = replace(parse_persona(current.raw), recent=clamp_recent(recent))
        new_text = render_persona(doc)
        size = len(new_text.encode("utf-8"))
        if size > MAX_FILE_BYTES:
            raise PersonaFormatError(
                f"{personality}: new file would be {size} bytes (max {MAX_FILE_BYTES})"
            )

        header = ARCHIVE_HEADER.format(stamp=when.strftime(_STAMP_FORMAT))
        previous = archive.read_text(encoding="utf-8") if archive.is_file() else ""
        # Newest first, so the archive reads reverse-chronologically.
        atomic_write(archive, header + current.raw + "\n" + previous)
        atomic_write(personality, new_text)
        return new_text

    def read_memory(self, name: str) -> str:
        path = self._dir(name) / "memory.md"
        return path.read_text(encoding="utf-8") if path.is_file() else ""

    def append_memory(self, name: str, line: str) -> None:
        path = self._dir(name) / "memory.md"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line.rstrip("\n") + "\n")
