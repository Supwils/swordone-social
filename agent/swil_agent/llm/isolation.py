"""A fresh, empty working directory for every persona-facing LLM call.

`--tools ""` (and its per-CLI equivalents) closes one hole: the model's
built-in tools. This module is half of the fix for the other one -- the
operator's own configuration riding along into a persona's context. Every
agent CLI discovers config from its working directory: `CLAUDE.md` and
`.claude/` (claude), `AGENTS.md` and the git root (codex), `.mcp.json`,
`.cursor/` and `.grok/` (grok). Started from this repository, a persona call
read the repo's instructions and could reach `agent/.env` and every
`api_key.txt` with a read tool. The other half is each backend's isolation
flags (see `llm/backends/claude.py`).

One directory per call, created immediately before it and removed
immediately after (errors ignored: a CLI that left a lock file behind must
not turn a finished call into a failed one). Nothing is ever put in it.
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Final

PREFIX: Final = "swil-llm-"


@contextmanager
def isolated_cwd() -> Iterator[str]:
    """Yield the path of a new empty temp directory; remove it on exit."""
    path = tempfile.mkdtemp(prefix=PREFIX)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)
