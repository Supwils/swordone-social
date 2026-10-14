"""Bounded memory retrieval for the act-path planner (loop-engine spec §8).

`memory.md` stays the append-only log. The planner no longer sees its tail:
`retrieve_memory` keeps a recency floor, then dated lines that mention a
counterparty or the board, capped and chronological. Dream still reads the
long window itself. `posts_today` is a full-file count in `context.py` and
must not be computed from this slice.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

_DATED = re.compile(r"^\d{4}-\d{2}-\d{2}")
_POST_LINE = re.compile(r"\| post \|")

_RECENCY_FLOOR = 8
_DEFAULT_LIMIT = 24


def retrieve_memory(
    memory_text: str,
    *,
    today: str,
    board: str,
    counterparties: Sequence[str],
    limit: int = _DEFAULT_LIMIT,
) -> str:
    """Return the planner's memory block per spec §8.

    1. Last 8 dated lines always (recency floor).
    2. From the rest, dated lines whose body mentions a counterparty
       username (from the assembled feed authors / DM partners) or the board
       slug / display, newest first.
    3. Always keep today's lines that are `post` (rhythm still needs
       `posts_today` from the **full** file, not the retrieved slice —
       `posts_today()` stays a full-file count).
    4. Cap the retrieved block at `limit` lines, order preserved
       (chronological).
    5. If the file is empty, return `""`.
    """
    lines = memory_text.splitlines()
    dated = [i for i, line in enumerate(lines) if _DATED.match(line)]
    if not dated:
        return ""

    recency = dated[-_RECENCY_FLOOR:]
    rest = dated[:-_RECENCY_FLOOR]
    needles = _needles(board, counterparties)

    picked: list[int] = []
    seen: set[int] = set()

    def take(idx: int) -> None:
        if idx in seen or len(picked) >= limit:
            return
        seen.add(idx)
        picked.append(idx)

    for idx in recency:
        take(idx)

    # Today's posts, newest first, so the cap drops the oldest extras.
    today_posts = [i for i in rest if lines[i].startswith(today) and _POST_LINE.search(lines[i])]
    for idx in reversed(today_posts):
        take(idx)

    for idx in reversed(rest):
        if _mentions(lines[idx], needles):
            take(idx)

    picked.sort()
    return "\n".join(lines[i] for i in picked)


def _needles(board: str, counterparties: Sequence[str]) -> tuple[str, ...]:
    names = [name for name in counterparties if name]
    names.extend(board.split())
    return tuple(names)


def _mentions(line: str, needles: Sequence[str]) -> bool:
    return any(needle in line for needle in needles)
