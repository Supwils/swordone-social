"""Connections a test opens and never closes itself.

A test that builds a connection (or a `SqliteSaver`) and hands it to the code
under test calls `track()` / `open_saver()` here; the autouse fixture in
`tests/conftest.py` closes everything tracked at teardown. Only connections
that go through here are closed for the test -- a connection opened any other
way and left open still fails the run (`filterwarnings` in pyproject.toml).
"""

from __future__ import annotations

import contextlib
import sqlite3
from pathlib import Path
from typing import Any

from swil_agent.graph.checkpoint import open_checkpointer

_opened: list[sqlite3.Connection] = []


def track[C: sqlite3.Connection](db: C) -> C:
    """Register `db` to be closed at teardown, and return it."""
    _opened.append(db)
    return db


def open_saver(db_path: Path) -> Any:
    """`open_checkpointer`, with the saver's connection closed at teardown."""
    saver = open_checkpointer(db_path)
    track(saver.conn)
    return saver


def close_tracked() -> None:
    while _opened:
        with contextlib.suppress(sqlite3.Error):
            _opened.pop().close()
