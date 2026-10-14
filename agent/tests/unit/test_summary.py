"""The daily dashboard, ported from `agent/scripts/agent-summary.sh`.

Local only -- nothing here touches the network, because the script does not
either. It reads `memory.md`, NOT `auto-run.log`.

Everything asserted here was additionally checked byte for byte against the
FROZEN script itself: `<scratchpad>/task3_summary_parity.py` copies
`agent-summary.sh` unmodified into a throwaway tree (its `ROOT_DIR` is
derived from its own location) and diffs its stdout against
`run_summary`'s return value -- over three synthetic trees covering a
missing trailing newline, a blank last line, an empty memory.md and an
absent `agents/` directory, and over the REAL 23-account roster at three
dates. All seven comparisons matched exactly.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from swil_agent.analysis.summary import (
    EMPTY_LATEST,
    LATEST_MAX_CHARS,
    AccountActivity,
    collect_activity,
    count_action,
    local_today,
    memory_lines,
    render_summary,
    run_summary,
    summarise_account,
)

DATE = "2026-08-19"


# ── memory_lines: grep/tail line splitting, not str.splitlines ───────────


def test_a_trailing_newline_does_not_add_an_empty_line() -> None:
    assert memory_lines("a\nb\n") == ["a", "b"]


def test_a_file_without_a_trailing_newline_still_has_its_last_line() -> None:
    """`tail -1` prints it, so it must be visible here too."""
    assert memory_lines("a\nb") == ["a", "b"]


def test_a_blank_last_line_survives() -> None:
    """This is what makes `${latest:-(empty)}` reachable."""
    assert memory_lines("a\n\n") == ["a", ""]


def test_an_empty_file_has_no_lines() -> None:
    assert memory_lines("") == []


def test_a_carriage_return_does_not_split_a_line() -> None:
    """`str.splitlines()` breaks on `\\r`, `\\v`, `\\f` and U+2028 as well,
    and strips a `\\r` before a `\\n`. `grep` and `tail` break on `\\n` alone
    and leave the CR in the line, where `cut -c1-60` still counts it."""
    assert memory_lines("a\rb\n") == ["a\rb"]


# ── count_action: the `^DATE.*| kind |` pattern ──────────────────────────


def test_a_matching_line_counts() -> None:
    assert count_action([f"{DATE} 10:00 | post | id=1"], DATE, "post") == 1


def test_another_date_does_not_count() -> None:
    assert count_action(["2026-08-18 10:00 | post | id=1"], DATE, "post") == 0


def test_the_date_must_start_the_line() -> None:
    """`^` is an anchor. A memory line QUOTING today's date mid-text is the
    realistic false positive -- these files are full of dated prose."""
    assert count_action([f"note about {DATE} | post | x"], DATE, "post") == 0


def test_the_marker_needs_both_pipes_and_both_spaces() -> None:
    assert count_action([f"{DATE} | posted | x"], DATE, "post") == 0
    assert count_action([f"{DATE} |post| x"], DATE, "post") == 0


def test_each_kind_counts_only_itself() -> None:
    lines = [
        f"{DATE} | post | a",
        f"{DATE} | comment | b",
        f"{DATE} | comment | c",
        f"{DATE} | like | d",
        f"{DATE} | follow | e",
        f"{DATE} | dream | personality consolidated",
        f"{DATE} | dm | to=x",
    ]
    assert count_action(lines, DATE, "post") == 1
    assert count_action(lines, DATE, "comment") == 2
    assert count_action(lines, DATE, "like") == 1
    assert count_action(lines, DATE, "follow") == 1


def test_counting_is_per_line_not_per_occurrence() -> None:
    """`grep -c` counts matching LINES. A line mentioning the marker twice
    is still one action."""
    assert count_action([f"{DATE} | post | quoting | post | again"], DATE, "post") == 1


# ── summarise_account ────────────────────────────────────────────────────


# The four counts are deliberately 1 / 2 / 3 / 4 -- all DIFFERENT. An earlier
# version had one of each, which made `ACTION_KINDS` permuted and the row's
# columns permuted BOTH survive their mutation: the assertion named the right
# field and the fixture made it impossible to tell apart (standing constraint
# §4). The stale `like` on the 18th is what makes the date argument
# observable.
_MEMORY = (
    f"{DATE} 10:00 | post | one\n"
    f"{DATE} 11:00 | comment | a\n"
    f"{DATE} 11:05 | comment | b\n"
    "2026-08-18 11:30 | like | old\n"
    f"{DATE} 12:00 | like | c\n"
    f"{DATE} 12:05 | like | d\n"
    f"{DATE} 12:10 | like | e\n"
    f"{DATE} 13:00 | follow | @p\n"
    f"{DATE} 13:05 | follow | @q\n"
    f"{DATE} 13:10 | follow | @r\n"
    f"{DATE} 13:15 | follow | @s\n"
)


def test_a_row_counts_the_four_kinds_for_the_named_date() -> None:
    row = summarise_account("alpha", _MEMORY, DATE)
    assert (row.posts, row.comments, row.likes, row.follows) == (1, 2, 3, 4)


def test_the_total_is_the_newline_count_not_the_line_count() -> None:
    """`wc -l` counts NEWLINES. A file with no trailing newline has one more
    line than newlines."""
    row = summarise_account("alpha", "a\nb\nc", DATE)
    assert row.total == 2
    assert len(memory_lines("a\nb\nc")) == 3


def test_the_latest_line_is_the_last_one() -> None:
    row = summarise_account("alpha", _MEMORY, DATE)
    assert row.latest == f"{DATE} 13:15 | follow | @s"


def test_the_latest_line_is_truncated_at_sixty_characters_not_bytes() -> None:
    """BSD `cut -c` is codepoint-based in a UTF-8 locale and these lines are
    CJK-heavy: 60 CJK characters are 180 bytes, so a byte slice would show a
    third of the text and could split a character."""
    line = "字" * 100
    row = summarise_account("alpha", line + "\n", DATE)
    assert row.latest == "字" * 60
    assert LATEST_MAX_CHARS == 60


def test_a_blank_last_line_leaves_latest_empty_in_the_data() -> None:
    """The `(empty)` placeholder is a RENDERING decision; the row itself
    says what it read."""
    assert summarise_account("alpha", "x\n\n", DATE).latest == ""


def test_an_empty_memory_is_all_zeros() -> None:
    row = summarise_account("alpha", "", DATE)
    assert row == AccountActivity(
        name="alpha", posts=0, comments=0, likes=0, follows=0, total=0, latest=""
    )


# ── collect_activity ─────────────────────────────────────────────────────


def _account(root: Path, cohort: str, name: str, memory: str | None = "x\n") -> Path:
    directory = root / cohort / name
    directory.mkdir(parents=True)
    if memory is not None:
        (directory / "memory.md").write_text(memory, encoding="utf-8")
    return directory


def test_accounts_are_sorted_by_name(tmp_path: Path) -> None:
    _account(tmp_path, "agents", "zenith")
    _account(tmp_path, "agents", "chawendao")
    assert [r.name for r in collect_activity(tmp_path, DATE)] == ["chawendao", "zenith"]


def test_only_agents_is_read(tmp_path: Path) -> None:
    """Era 3 has one cohort; a leftover `humans/` tree is not a roster."""
    _account(tmp_path, "agents", "zenith")
    _account(tmp_path, "humans", "aardvark")
    assert [r.name for r in collect_activity(tmp_path, DATE)] == ["zenith"]


def test_an_account_without_a_memory_file_gets_no_row(tmp_path: Path) -> None:
    """A brand-new account that has never acted is absent from the table,
    not a row of zeros (`[[ -f "$memfile" ]] || continue`)."""
    _account(tmp_path, "agents", "fresh", memory=None)
    _account(tmp_path, "agents", "veteran")
    assert [r.name for r in collect_activity(tmp_path, DATE)] == ["veteran"]


def test_a_missing_agents_directory_yields_no_rows(tmp_path: Path) -> None:
    (tmp_path / "logs").mkdir()
    assert collect_activity(tmp_path, DATE) == []


def test_an_empty_root_yields_no_rows(tmp_path: Path) -> None:
    assert collect_activity(tmp_path, DATE) == []


def test_a_loose_file_beside_the_accounts_is_not_a_row(tmp_path: Path) -> None:
    (tmp_path / "agents").mkdir()
    (tmp_path / "agents" / "README.md").write_text("x", encoding="utf-8")
    assert collect_activity(tmp_path, DATE) == []


def test_undecodable_bytes_do_not_crash_the_dashboard(tmp_path: Path) -> None:
    """`grep` and `wc` are byte-oriented and never fail on one bad byte. A
    dashboard that raises on a single corrupt account is worse than one that
    shows a replacement character."""
    directory = _account(tmp_path, "agents", "corrupt", memory=None)
    (directory / "memory.md").write_bytes(b"\xff\xfe bad\n")
    assert [r.name for r in collect_activity(tmp_path, DATE)] == ["corrupt"]


def test_the_date_reaches_the_counting(tmp_path: Path) -> None:
    """A dropped `date` argument would silently count against today, which
    is right on most days and wrong on exactly the days someone bothered to
    pass one."""
    _account(tmp_path, "agents", "alpha", memory=_MEMORY)
    today = collect_activity(tmp_path, DATE)[0]
    yesterday = collect_activity(tmp_path, "2026-08-18")[0]
    assert (today.posts, today.likes) == (1, 3)
    assert (yesterday.posts, yesterday.likes) == (0, 1)


# ── render_summary: the layout a human reads ─────────────────────────────


_EXPECTED = """ACCOUNT         POST  CMNT  LIKE  FOLL TOTAL   LATEST
────────────── ───── ───── ───── ───── ─────   ──────────
alpha              1     2     3     4    11   2026-08-19 13:15 | follow | @s
zeta               0     0     0     0     0   (empty)

Date: 2026-08-19
"""


def test_the_rendered_dashboard_matches_the_scripts_layout(tmp_path: Path) -> None:
    """The whole point of this module is that a human reads it and CLAUDE.md
    documents the command, so the columns are pinned as a block: one space
    between fields, THREE before LATEST, `%-14s` for the account and `%5s`
    for each count.

    Byte-for-byte parity with the frozen script itself is verified separately
    (see this module's docstring) -- this pin is what keeps it that way.
    """
    _account(tmp_path, "agents", "alpha", memory=_MEMORY)
    _account(tmp_path, "agents", "zeta", memory="")
    assert run_summary(tmp_path, date=DATE) == _EXPECTED


def test_run_summary_threads_its_date_to_both_halves(tmp_path: Path) -> None:
    """Two separate hand-offs (`collect_activity` and `render_summary`) take
    the same argument, and a mutant hardcoding EITHER of them survives every
    test that only ever uses one date -- standing constraint §2's
    producer/consumer point. This one uses a date that is neither today nor
    the module default."""
    _account(tmp_path, "agents", "alpha", memory=_MEMORY)
    out = run_summary(tmp_path, date="2026-08-18")
    assert "Date: 2026-08-18" in out
    # 0 posts, 0 comments, 1 like, 0 follows on the 18th -- and the total is
    # still every line in the file.
    assert out.splitlines()[2].split()[1:6] == ["0", "0", "1", "0", "11"]


def test_the_header_and_rule_rows_are_present_on_an_empty_roster(tmp_path: Path) -> None:
    """The script prints them before it looks at anything, so `swil-agent
    summary` on a fresh checkout still shows a table rather than a blank."""
    out = run_summary(tmp_path, date=DATE)
    assert out.splitlines()[0].startswith("ACCOUNT")
    assert out.splitlines()[1].startswith("─")
    assert out.splitlines()[-1] == f"Date: {DATE}"
    assert "rotate-memory" not in out


def test_a_blank_line_precedes_the_footer(tmp_path: Path) -> None:
    """`echo ""` (:51)."""
    lines = run_summary(tmp_path, date=DATE).splitlines()
    assert lines[-2] == ""


def test_the_output_ends_with_a_newline(tmp_path: Path) -> None:
    """The script's last `echo` emits one; a CLI that prints this must not
    add a second."""
    out = run_summary(tmp_path, date=DATE)
    assert out.endswith(f"{DATE}\n")
    assert not out.endswith("\n\n")


def test_an_empty_latest_renders_as_the_placeholder() -> None:
    row = AccountActivity(name="quiet", posts=0, comments=0, likes=0, follows=0, total=0, latest="")
    assert EMPTY_LATEST in render_summary([row], DATE)


def test_a_long_account_name_is_not_truncated() -> None:
    """`%-14s` pads to 14 but never cuts; a 15-character folder name pushes
    the columns right rather than losing a character of the name."""
    row = AccountActivity(
        name="a" * 20, posts=1, comments=0, likes=0, follows=0, total=1, latest="x"
    )
    assert "a" * 20 in render_summary([row], DATE)


def test_the_date_appears_in_the_footer_not_only_in_the_counting() -> None:
    assert "Date: 1999-01-01" in render_summary([], "1999-01-01")


# ── local_today ──────────────────────────────────────────────────────────


def test_local_today_formats_the_given_moment() -> None:
    """`date '+%Y-%m-%d'` with no `-u`: LOCAL time. Taking `now` as an
    argument is what keeps the default the caller's decision, and what makes
    this assertion possible at all."""
    assert local_today(datetime(2019, 3, 4, 5, 6, 7)) == "2019-03-04"
