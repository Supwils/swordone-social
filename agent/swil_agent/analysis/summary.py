"""The daily activity dashboard, read by a human.

LOCAL ONLY -- there is no API call anywhere in this module. It reads each account's
`memory.md` and prints posts / comments / likes / follows for one date, the
latest line, and the total line count. Rotation is automatic now
(`memory_rotation.py`, at the end of every real round).

It reads `memory.md`, NOT the act log. The output is read by eye, so the
layout is kept stable column for
column rather than improved -- see `render_summary`.

`run_summary` returns the text instead of printing it: the CLI owns stdout,
the same split every other entry point in this package uses, and it is what
lets the whole layout be asserted in a test without capturing a stream.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict

MEMORY_FILENAME: Final = "memory.md"

# Era 3 has one cohort: every account lives under `agents/`.
ACCOUNTS_DIR: Final = "agents"

# The four `grep -c` lines, in column order.
ACTION_KINDS: Final = ("post", "comment", "like", "follow")

# `cut -c1-60` (:44). CHARACTERS, not bytes: BSD `cut -c` is codepoint-based
# in a UTF-8 locale, and these lines are CJK-heavy, so a byte slice would
# show a fifth of the text and could split a character.
LATEST_MAX_CHARS: Final = 60

# `${latest:-(empty)}` (:47) -- a memory.md whose last line is blank.
EMPTY_LATEST: Final = "(empty)"

_HEADER: Final = ("ACCOUNT", "POST", "CMNT", "LIKE", "FOLL", "TOTAL", "LATEST")
_RULES: Final = (
    "──────────────",
    "─────",
    "─────",
    "─────",
    "─────",
    "─────",
    "──────────",
)


class AccountActivity(BaseModel):
    """One row of the dashboard.

    `latest` is the raw (already truncated) last line -- empty stays empty
    here, and `render_summary` is the only place it becomes `(empty)`, so
    the data and its presentation do not have to agree about what a blank
    memory.md means.
    """

    model_config = ConfigDict(frozen=True)

    name: str
    posts: int
    comments: int
    likes: int
    follows: int
    total: int
    latest: str


def memory_lines(text: str) -> list[str]:
    """The lines `grep` and `tail` would see.

    `split("\\n")` with the trailing empty element dropped, NOT
    `str.splitlines()`: splitlines also breaks on `\\r`, `\\v`, `\\f` and
    U+2028, and strips a `\\r` before a `\\n`. `grep` and `tail` break on
    `\\n` alone and leave a CR at the end of the line, where it is part of
    what `cut -c1-60` then measures.

    A file not ending in a newline still has a final line (`tail -1` prints
    it), which is why only ONE trailing empty is dropped.
    """
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def count_action(lines: list[str], date: str, action: str) -> int:
    """`grep -c "^${DATE}.*| post |"`.

    In a POSIX BRE `|` is a literal pipe, so the pattern is: the line starts
    with `date`, and the literal `| post |` appears somewhere at or after
    that prefix. `.*` matching greedily then backtracking is exactly "there
    exists such a position", which is what `in` says.

    DIVERGENCE, deliberate: `date` is interpolated into a regex by Bash, so
    a caller passing `2026.08.19` would get `.` as a wildcard there. It is
    treated as a literal string here -- an argument that names a day is
    data, not a pattern, and no caller has ever passed one that is not
    `YYYY-MM-DD`.
    """
    marker = f"| {action} |"
    return sum(1 for line in lines if line.startswith(date) and marker in line[len(date) :])


def summarise_account(name: str, memory_text: str, date: str) -> AccountActivity:
    """One account's row.

    `total` is `wc -l`, i.e. the number of NEWLINES -- deliberately not
    `len(memory_lines(...))`. The two differ by one for a file with no
    trailing newline.
    """
    lines = memory_lines(memory_text)
    counts = [count_action(lines, date, action) for action in ACTION_KINDS]
    return AccountActivity(
        name=name,
        posts=counts[0],
        comments=counts[1],
        likes=counts[2],
        follows=counts[3],
        total=memory_text.count("\n"),
        latest=(lines[-1] if lines else "")[:LATEST_MAX_CHARS],
    )


def collect_activity(agent_root: Path, date: str) -> list[AccountActivity]:
    """Every account under `agents/` with a `memory.md`, sorted by name.

    A missing `agents/` directory yields no rows, and so does an account
    with no `memory.md` -- a brand-new account that has never acted has no
    row at all rather than a row of zeros.

    `errors="replace"` rather than a hard decode: `grep` and `wc` are
    byte-oriented and never fail on one bad byte, and a dashboard that
    raises on a single corrupt account is worse than one that shows a
    replacement character in its `LATEST` column.
    """
    base = agent_root / ACCOUNTS_DIR
    if not base.is_dir():
        return []
    rows: list[AccountActivity] = []
    for directory in sorted(p for p in base.iterdir() if p.is_dir()):
        memory = directory / MEMORY_FILENAME
        if not memory.is_file():
            continue
        text = memory.read_text(encoding="utf-8", errors="replace")
        rows.append(summarise_account(directory.name, text, date))
    return rows


def render_summary(rows: list[AccountActivity], date: str) -> str:
    """The dashboard as text, ending in a newline.

    `%-14s %5s %5s %5s %5s %5s   %s` -- note
    the THREE spaces before the last column and one everywhere else.

    Bash's `printf` pads by BYTES and Python's format spec pads by
    CHARACTERS. The rule row is unaffected: `──────────────` is 14
    characters (42 bytes) and each `─────` is 5 (15 bytes), so both are
    already at or over their field width and neither implementation pads
    them. Account names are ASCII, where the two measures agree. The
    `LATEST` column has no width at all.
    """
    lines = [
        _row(*_HEADER),
        _row(*_RULES),
    ]
    for row in rows:
        lines.append(
            _row(
                row.name,
                str(row.posts),
                str(row.comments),
                str(row.likes),
                str(row.follows),
                str(row.total),
                row.latest or EMPTY_LATEST,
            )
        )
    lines.extend(["", f"Date: {date}"])
    return "\n".join(lines) + "\n"


def _row(
    account: str, posts: str, comments: str, likes: str, follows: str, total: str, latest: str
) -> str:
    return f"{account:<14} {posts:>5} {comments:>5} {likes:>5} {follows:>5} {total:>5}   {latest}"


def local_today(now: datetime) -> str:
    """`$(date '+%Y-%m-%d')` -- LOCAL time, not UTC.

    Takes `now` rather than reading the clock so the default is decided by
    the caller and is pinnable in a test; `run_summary` requires an explicit
    `date` for the same reason.
    """
    return now.strftime("%Y-%m-%d")


def run_summary(agent_root: Path, *, date: str) -> str:
    """Read every `memory.md` under `agent_root` and render the dashboard."""
    return render_summary(collect_activity(agent_root, date), date)
