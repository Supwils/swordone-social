#!/usr/bin/env python3
"""Drop old LangGraph cycle checkpoints, keeping the last N rounds per account.

Every round opens a NEW thread per account -- `thread_id` is
`builtin:<account>:<round id>`, the round id `<UTC YYYYMMDDTHHMMSS>Z-r|m`
(Era 2 keys had no suffix) -- so nothing ever reuses an old thread
and nothing in the tree deleted them. Measured 2026-08-20: 70 MB for 56 threads,
roughly 35 MB per round, in a gitignored file on one laptop. At the 48h cadence
that is ~500 MB/month and it only goes up.

`swil-agent cycle --resume` needs the account's most recent thread, so keeping
one round back is already enough; the default keeps two, which costs one extra
round of disk and means a prune immediately after a failed round still leaves
something to resume.

    python3 agent/scripts/prune-checkpoints.py --dry-run
    python3 agent/scripts/prune-checkpoints.py --keep 2

Exits 0 when there is nothing to do, and when the database does not exist yet.
This is housekeeping: it must never be the reason a round does not run.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sqlite3
import sys

DEFAULT_DB = pathlib.Path(__file__).resolve().parent.parent / ".agent-state" / "cycle_checkpoints.sqlite"


# `swil_agent/round_id.py`'s `ROUND_ID_RE`, copied: this script runs under a
# bare `python3`, outside the package's environment.
ROUND_ID_RE = re.compile(r"^\d{8}T\d{6}Z-[rm]$", re.ASCII)


def round_sort_key(thread_id: str) -> tuple[bool, str]:
    """Order by the round id: its UTC stamp leads, so string order is time
    order. Keys that are not S2 ids (Era 2's suffixless stamps) rank below
    every S2 id -- the same rule as `round_id.round_sort_key`."""
    round_id = thread_id.rpartition(":")[2]
    return (ROUND_ID_RE.fullmatch(round_id) is not None, round_id)


def account_of(thread_id: str) -> str:
    """`builtin:zenith:20260819T213144` -> `builtin:zenith`.

    Split from the RIGHT and only once: an account name cannot contain ':',
    but the namespace prefix may gain segments later, and splitting from the
    left would silently start grouping every account under one key.
    """
    head, _, tail = thread_id.rpartition(":")
    return head if head and tail else thread_id


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=pathlib.Path, default=DEFAULT_DB)
    ap.add_argument("--keep", type=int, default=2, help="rounds to keep per account (default 2)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.keep < 1:
        print("--keep must be >= 1: keeping zero rounds breaks --resume", file=sys.stderr)
        return 64
    if not args.db.exists():
        return 0

    before = args.db.stat().st_size
    con = sqlite3.connect(args.db)
    try:
        threads = [r[0] for r in con.execute("SELECT DISTINCT thread_id FROM checkpoints")]
        by_account: dict[str, list[str]] = {}
        for t in threads:
            by_account.setdefault(account_of(t), []).append(t)

        # Sort on the round id alone: sorting the whole thread_id would order
        # by account first and silently keep the wrong ones.
        doomed: list[str] = []
        for _account, ts in by_account.items():
            ts.sort(key=round_sort_key)
            doomed.extend(ts[: max(0, len(ts) - args.keep)])

        if not doomed:
            print(f"prune-checkpoints: nothing to drop ({len(threads)} threads, "
                  f"{len(by_account)} accounts, {before / 1e6:.1f} MB)")
            return 0

        if args.dry_run:
            print(f"prune-checkpoints: would drop {len(doomed)} of {len(threads)} threads "
                  f"across {len(by_account)} accounts (keeping {args.keep} each)")
            return 0

        marks = ",".join("?" * len(doomed))
        con.execute(f"DELETE FROM writes WHERE thread_id IN ({marks})", doomed)
        con.execute(f"DELETE FROM checkpoints WHERE thread_id IN ({marks})", doomed)
        con.commit()
        # VACUUM is what actually returns the space; without it the file keeps
        # its size and the whole exercise reclaims nothing visible.
        con.execute("VACUUM")
    finally:
        con.close()

    after = args.db.stat().st_size
    print(f"prune-checkpoints: dropped {len(doomed)} threads, "
          f"{before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
