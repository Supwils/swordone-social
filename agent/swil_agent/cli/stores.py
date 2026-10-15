"""The two local databases a command opens, and how it reports a busy lease.

Commands reach `cycle_stores` and `lease_busy_guard` through
`cli/compose.py`, so a test patches them in one place.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import ExitStack, closing, contextmanager
from dataclasses import dataclass
from pathlib import Path

from swil_agent.cli.errors import AccountSetupError
from swil_agent.config import Settings
from swil_agent.graph.checkpoint import CHECKPOINT_DB_NAME, Checkpointer, checkpointer_at
from swil_agent.locks.lease import LEASE_DB_NAME, LeaseBusy, open_lease_db

__all__ = [
    "CHECKPOINT_DB_NAME",
    "LEASE_DB_NAME",
    "CycleStores",
    "checkpoint_db_path",
    "checkpoint_db_path_hint",
    "cycle_stores",
    "lease_busy_guard",
    "lease_db_path",
]


@dataclass
class CycleStores:
    """The two databases a cycle needs, and the one thing they have in common:
    a dry run gets neither on disk."""

    lease_db: sqlite3.Connection
    checkpointer: Checkpointer | None


@contextmanager
def cycle_stores(
    settings: Settings, *, dry_run: bool, checkpoint: bool = True
) -> Iterator[CycleStores]:
    """Open (and always close) the lease and checkpoint databases.

    `checkpoint=False` opens the lease database alone: `act` and `dream` run
    a subset graph, which is never checkpointed (S3 §4).

    Both live in `agent/.agent-state/`, next to `lock_<name>` and the dream
    cooldown markers -- one directory for the Python runtime's local
    per-account state, matching `compose.state_for`. The two modules own their
    FILENAMES (`LEASE_DB_NAME`, `CHECKPOINT_DB_NAME`) and this composition
    root owns the directory.

    **A dry run gets an in-memory lease DB and no checkpointer at all.**
    `run_cycle` already takes no lease when `deps.dry_run` is set, so the
    connection is never used -- but `sqlite3.connect(<path>)` CREATES the file
    regardless, and a shadow round that leaves two new databases in
    `.agent-state/` has written to disk during the round whose exit criterion
    is "nothing to revert; Python never wrote" (spec §10 stage 3). Resuming a
    shadow round is meaningless for the same reason there is nothing to
    resume from.
    """
    with ExitStack() as stack:
        target = ":memory:"
        if not dry_run:
            # `sqlite3.connect` does not create missing parents -- it raises
            # `OperationalError: unable to open database file`, which reads as
            # a bug rather than as "this account has never had local state".
            # `open_checkpointer` already mkdirs its own; this is the same
            # directory, and the lease DB is opened first.
            lease_path = lease_db_path(settings)
            lease_path.parent.mkdir(parents=True, exist_ok=True)
            target = str(lease_path)
        lease_db = stack.enter_context(closing(open_lease_db(target)))
        checkpointer = (
            None
            if dry_run or not checkpoint
            else stack.enter_context(checkpointer_at(checkpoint_db_path(settings)))
        )
        yield CycleStores(lease_db=lease_db, checkpointer=checkpointer)


def lease_db_path(settings: Settings) -> Path:
    return settings.agent_root / ".agent-state" / LEASE_DB_NAME


def checkpoint_db_path(settings: Settings) -> Path:
    return settings.agent_root / ".agent-state" / CHECKPOINT_DB_NAME


def checkpoint_db_path_hint() -> str:
    return f"agent/.agent-state/{CHECKPOINT_DB_NAME}"


@contextmanager
def lease_busy_guard(name: str) -> Iterator[None]:
    """Turn `LeaseBusy` into an `AccountSetupError` carrying a REMEDY.

    `LeaseBusy`'s own message is a cause ("... act lease busy (lock_zenith
    held (12s))") and ruling R17 wants the SKIP line to name the remedy too.
    It has one, and this project has already needed it: an accepted Bash dream
    exits 141 after "snapshot uploaded" and orphans `dream_lock_<name>`, so
    "another run holds it" and "a dead run left it behind" look identical
    until someone checks the pid inside the file (CLAUDE.md, "Accepted-dream
    SIGPIPE orphan lock"). Bash itself only logs `SKIP <name> — locked` and
    moves on, which is why those orphans went unnoticed for whole rounds.
    """

    try:
        yield
    except LeaseBusy as exc:
        raise AccountSetupError(
            f"{name}: {exc} -- another run holds this account. Wait for it, or "
            f"if it is an orphan (`head -1 agent/.agent-state/*lock_{name}` names "
            "a pid that is no longer alive) remove that lock file; leases older "
            "than 1800s are reclaimed automatically"
        ) from exc
