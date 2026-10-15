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


# ── which round a command runs under (moved from cli, S3 §6) ─────────────
#
# Pure: every lookup arrives as a callable and the clock as a value, so this
# module imports neither the checkpoint layer nor the CLI. The refusals are
# domain errors defined here; `cli/run.py` maps them to exit codes and to the
# operator lines it has always printed.


class NoCheckpoint(LookupError):  # noqa: N818 -- mandated name, S3 spec §12.14
    """`--resume` found no checkpointed cycle for this account."""


class SweepResumeRefused(RuntimeError):  # noqa: N818 -- mandated name, S3 spec §12.14
    """`--resume` of a sweep's thread from outside that sweep (S2 §3).

    A sweep thread's data is filed under the sweep's round id, so a late
    resume -- an operator hours later, or a stale shell -- would mix a
    different moment's cycle into that round. Only the sweep itself, whose
    `SWIL_ROUND_ID` is that id, may resume it. `round_id` is the refused id.
    """

    def __init__(self, round_id: str) -> None:
        super().__init__(round_id)
        self.round_id = round_id


def resume_round_id(latest: Callable[[], str | None], *, env_round_id: str | None) -> str:
    """The round id `--resume` continues: the account's latest checkpointed
    one, as `latest()` reads it back out of the checkpoint database.

    A SWEEP thread (`-r`) resumes only when `env_round_id` (`SWIL_ROUND_ID`)
    is that same id -- the sweep re-launching its own account; anything else
    raises `SweepResumeRefused`. A manual (`-m`) thread resumes as is. No
    thread at all raises `NoCheckpoint`.

    Recomputing it from the clock (a fresh id) would build a DIFFERENT
    `thread_id` and silently start a brand-new cycle instead of continuing the
    interrupted one -- the failure mode where `--resume` appears to work and
    quietly re-runs the act phase, re-posting whatever already landed.
    """
    found = latest()
    if found is None:
        raise NoCheckpoint("no checkpointed cycle")
    is_sweep = is_valid_round_id(found) and round_kind(found) == "sweep"
    if is_sweep and (env_round_id or "").strip() != found:
        raise SweepResumeRefused(found)
    return found


def fresh_round_id(
    env_round_id: str | None, *, now: datetime, thread_exists: Callable[[str], bool]
) -> str:
    """The round id a NON-resumed `cycle` runs under (S2 §3): a valid
    `SWIL_ROUND_ID` this account has no thread for yet, else a manual id.

    `thread_exists` answers for this account's checkpoint database; a caller
    with no database to ask (a dry run) passes one that answers `False`, and
    the label then goes nowhere anyway.
    """
    return sweep_or_manual_round_id(env_round_id, now=now, thread_exists=thread_exists)


def act_round_id(
    env_round_id: str | None, *, now: datetime, thread_exists: Callable[[str], bool] | None
) -> str:
    """`act`'s round id. `act` keeps no checkpoint of its own, but a sweep's
    `cycle` left one for this account, and that thread is what marks an
    exported id as used.

    `thread_exists` is `None` when there is no such database to ask -- a dry
    run (opening it would write), a database that does not exist yet, or one
    that could not be read. The guard is lost then, not the round: the id is
    decided as if no thread existed.
    """
    return fresh_round_id(
        env_round_id,
        now=now,
        thread_exists=thread_exists if thread_exists is not None else _no_thread,
    )


def _no_thread(_round_id: str) -> bool:
    return False
