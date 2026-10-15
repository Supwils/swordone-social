"""Round ids: the label that groups one sweep's data on the server (S2 §3).

Format `^\\d{8}T\\d{6}Z-[rm]$`: a UTC `%Y%m%dT%H%M%S` stamp, then `-r` for a
sweep (minted ONCE by `opportunistic-round.sh` and exported as
`SWIL_ROUND_ID` to every account it launches) or `-m` for anything run by
hand. The stamp leads so lexicographic order is time order -- the checkpoint
`latest_round_id` and `prune-checkpoints.py` sort on it.

A round never dies on a label: an invalid or already-used env id logs a
warning and falls back to a manual id. "Already used" means this account's
checkpoint DB already holds a thread for that id -- a stale `SWIL_ROUND_ID`
left exported in an operator's shell must never re-enter a finished thread.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final, Literal

logger = logging.getLogger(__name__)

# `re.ASCII`: without it `\d` also matches Arabic-Indic and fullwidth digits,
# which neither sort with the stamp nor parse with `strptime`.
ROUND_ID_RE: Final = re.compile(r"^\d{8}T\d{6}Z-[rm]$", re.ASCII)

# `%Y%m%dT%H%M%S` and not `isoformat()`: `thread_id` splits on `":"`, and an
# ISO timestamp carries two of them.
_STAMP_FORMAT: Final = "%Y%m%dT%H%M%S"

RoundKind = Literal["sweep", "manual"]


def is_valid_round_id(value: str) -> bool:
    # `fullmatch`, not `match`: `$` also matches before a trailing newline.
    return ROUND_ID_RE.fullmatch(value) is not None


def round_kind(round_id: str) -> RoundKind:
    if not is_valid_round_id(round_id):
        raise ValueError(f"not a round id: {round_id!r}")
    return "sweep" if round_id.endswith("-r") else "manual"


def manual_round_id(now: datetime) -> str:
    """`<UTC now>Z-m`. A naive `now` is read as local time, as `astimezone` does."""
    return now.astimezone(UTC).strftime(_STAMP_FORMAT) + "Z-m"


def round_sort_key(round_id: str) -> tuple[bool, str]:
    """Order round ids by time. Keys that are not S2 ids -- Era 2's suffixless
    stamps still sitting in a dev checkpoint DB -- rank below every S2 id
    rather than crash or interleave with them."""
    return (is_valid_round_id(round_id), round_id)


def sweep_or_manual_round_id(
    env_value: str | None,
    *,
    now: datetime,
    thread_exists: Callable[[str], bool],
) -> str:
    """The round id a fresh (non-resumed) `cycle`/`act` runs under.

    `env_value` is `SWIL_ROUND_ID`; `thread_exists(id)` answers whether this
    account already has a checkpointed thread for that id (a caller without a
    checkpoint DB answers `False`).
    """
    candidate = (env_value or "").strip()
    if not candidate:
        return manual_round_id(now)
    fallback = manual_round_id(now)
    if not is_valid_round_id(candidate):
        logger.warning(
            "SWIL_ROUND_ID=%r is not a valid round id; running as manual round %s",
            candidate,
            fallback,
        )
        return fallback
    if thread_exists(candidate):
        logger.warning(
            "SWIL_ROUND_ID=%s already has a checkpointed thread for this account "
            "(a stale export?); running as manual round %s",
            candidate,
            fallback,
        )
        return fallback
    return candidate
