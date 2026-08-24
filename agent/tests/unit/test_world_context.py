"""The world-context blocks `swil.sh login` used to write to disk.

Background, and why these tests are shaped the way they are. `swil.sh login`
wrote three artifacts -- `context/now.md`, `context/news_today.md`, and one
`context/feed_for_<username>.md` per account. The Python runtime became the
runtime of record on 2026-08-19 (`cycle-one.sh:45` dispatches straight to
`swil-agent cycle`) and nothing in it calls `swil.sh`, so it READ two of those
three files and WROTE none. Every round after the cutover was handed a
`now.md` frozen at 2026-08-19 05:30 -- a header telling all 23 accounts that
the date was the 19th and that they were `qiusai`'s session -- plus a news
digest dated 2026-08-18 and whatever follow-topics slice happened to be on
disk.

Three properties are pinned here, one per failure mode that produced:

  * FRESHNESS -- the date comes from an injected clock, and two clocks give
    two answers. A test with a single clock cannot tell a rendered date from
    a hardcoded one.
  * PER-ACCOUNT -- `now.md` was ONE shared file carrying a per-account
    `当前 Agent` line, which is why five parallel rounds raced on it and the
    file named a single account. Every test that could catch a regression
    here renders TWO accounts in one process and compares, because an
    assertion about a per-account value attached to a single-account render
    cannot distinguish an argument from a module-level constant.
  * TEMPLATE FIDELITY (ruling R28) -- the drift experiment is in flight, so
    only the FRESHNESS of the content may change, never the wording. The
    template is pinned against `agent/scripts/swil.sh`'s own heredoc, read
    out of the script at test time and byte-compared, rather than against a
    copy of it transcribed into this file: a transcription drifts silently
    from the thing it claims to pin, and the script is the source of truth
    (STANDING-CONSTRAINTS §1).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent import cli
from swil_agent.act.context import (
    NEWS_CACHE_FILENAME,
    NEWS_FETCH_SCRIPT,
    NEWS_FETCH_TIMEOUT,
    WORLD_CONTEXT_UNAVAILABLE,
    format_now_feed,
    format_topic_feed,
    platform_activity,
    read_news_digest,
    render_follow_topics_feed,
    render_now_context,
)
from swil_agent.api.client import ApiError
from swil_agent.config import Settings
from swil_agent.models import Persona
from swil_agent.persona.loader import load_persona

from ._runners import RecordingRunner

AGENT_DIR = Path(__file__).resolve().parents[2]
SWIL_SH = AGENT_DIR / "scripts" / "swil.sh"
NEWS_FETCH_SH = AGENT_DIR / "scripts" / NEWS_FETCH_SCRIPT

# Two clocks, deliberately different in every rendered component (day AND
# time-of-day AND day-of-year parity), so a renderer that hardcodes any part
# of either format string is visible.
NOW_A = datetime(2026, 8, 20, 7, 42)
NOW_B = datetime(2026, 3, 4, 19, 5)


# ── §14: every pin below reads EXECUTABLE text, never a comment ───────────
#
# STANDING-CONSTRAINTS §14, paid for three times now. The first was a
# Bash-side guard that searched a script for `--tools ""` while the fix's own
# explanatory comment contained that string. The second was this file: bare
# `index`/`re.search` over raw source, so a commented-out copy of a line above
# a reworded real one satisfied the pin completely. The third was the FIX for
# the second -- it grouped `\`-continuations before testing for comment-ness,
# and since bash does NOT continue a comment line, a `\`-terminated comment
# hid the executable line under it from the view while bash still ran it.
#
# So the failure has two directions and both are live:
#
#   * a comment SATISFYING an anchor -- the decoy above the real line;
#   * a comment HIDING the line that contradicts an anchor -- the
#     `\`-terminated comment, and a mid-line `#` parking the original text
#     after a renamed real assignment.
#
# Three rules close them, and all three are enforced in ONE place
# (`_code_hits` / `_code_match`) so there is one guard to pin rather than
# four copies to keep in step:
#
#   1. a physical line whose first non-blank character is `#` contributes
#      nothing, and does NOT swallow the line after it;
#   2. `\`-continuations are joined, so the "what precedes the anchor" test
#      below sees the whole line bash executes, and so an anchor that spans
#      a join is still findable (no anchor here spans one today -- the
#      topic-row jq lies wholly on `swil.sh:395`, which is a continuation of
#      the `curl` on `:394` -- but the rule is what keeps that true);
#   3. a match counts only if the text BEFORE it on its joined line contains
#      no `#`.
#
# Rule 3 is deliberately not "cut each line at its first `#`". That rule
# would truncate `swil.sh:397` -- `FEED_CONTENT+="## #${FT_TOPIC}\n…"` -- at
# `## `, turning a live anchor into a false failure. Filtering match
# POSITIONS instead never shortens anything: the `#`s in that line are all
# AFTER the anchor, so it still matches, and its extracted fragment is
# unchanged (pinned by the expansions test below).


def _executable_view(text: str) -> tuple[str, list[int]]:
    """`text` with comment lines dropped and continuations joined, plus the
    ORIGINAL offset of every surviving character.

    Comment-ness is tested on each PHYSICAL line BEFORE anything is joined to
    it, and that ordering is the whole point. Bash does not continue a
    comment: `# … \\` followed by `X=2` still executes `X=2`, because the `\\`
    is inside the comment and never reaches the line-continuation rule.
    Testing after the join deletes that `X=2` from the view -- which is a
    comment hiding the code that contradicts a pin, the inverse of the attack
    §14 was written for and just as green.

    A continuation line that happens to START with `#` is NOT a comment line;
    it is part of the logical line above it, and it is kept.
    """
    lines: list[tuple[int, str]] = []
    pos = 0
    for line in text.splitlines(keepends=True):
        lines.append((pos, line))
        pos += len(line)

    view: list[str] = []
    offsets: list[int] = []
    i = 0
    while i < len(lines):
        if lines[i][1].lstrip().startswith("#"):
            i += 1
            continue  # a comment contributes nothing AND continues nothing
        group = [lines[i]]
        while group[-1][1].rstrip("\n").endswith("\\") and i + 1 < len(lines):
            i += 1
            group.append(lines[i])
        i += 1
        for nth, (line_start, line) in enumerate(group):
            body = line
            if nth < len(group) - 1:
                # bash removes the backslash AND the newline, and keeps the
                # continuation line's own leading whitespace.
                body = line.rstrip("\n")[:-1]
            for offset, char in enumerate(body):
                view.append(char)
                offsets.append(line_start + offset)
    return "".join(view), offsets


def _executable(text: str) -> str:
    return _executable_view(text)[0]


def _is_code_position(view: str, at: int) -> bool:
    r"""Rule 3: nothing before `at` on its joined line may be a `#`.

    Without it, renaming the real assignment and parking the original text in
    a TRAILING comment passes every other check -- the anchor occurs exactly
    once, on an executable line, and it is the decoy.

    That, and only that, is what rule 3 buys. It is NOT what closes the
    hidden-DUPLICATE shapes (a `\`-terminated comment above a second
    assignment, or a second executable one): those die on the uniqueness
    assertion in `_the_code_hit` / `_the_code_match`, measured by re-running
    that mutation with this rule removed and watching it die anyway. Worth
    stating because crediting rule 3 there would tell the next person who
    changes it that more depends on it than does.
    """
    return "#" not in view[view.rfind("\n", 0, at) + 1 : at]


def _code_hits(view: str, anchor: str) -> list[int]:
    hits: list[int] = []
    at = view.find(anchor)
    while at != -1:
        if _is_code_position(view, at):
            hits.append(at)
        at = view.find(anchor, at + 1)
    return hits


def _the_code_hit(view: str, anchor: str, what: str) -> int:
    """The ONE executable position of `anchor`, or a loud failure.

    Uniqueness is asserted rather than "first match wins", and it is asserted
    HERE rather than at each caller so there is a single guard: two real
    assignments is the same defect as a decoy comment one step on, and a
    second `NEWS_TIMEOUT="${NEWS_TIMEOUT:-N}"` above the first would make the
    EFFECTIVE default the earlier one while a first-match reader reported the
    later. Neither number is trustworthy once there are two, so this refuses
    to pick.
    """
    hits = _code_hits(view, anchor)
    assert len(hits) == 1, f"{what} occurs {len(hits)} times in executable text, expected 1"
    return hits[0]


def _the_code_match(view: str, pattern: str, what: str) -> re.Match[str]:
    """`_the_code_hit` for a regex anchor."""
    hits = [m for m in re.finditer(pattern, view) if _is_code_position(view, m.start())]
    assert len(hits) == 1, f"{what} occurs {len(hits)} times in executable text, expected 1"
    return hits[0]


def _executable_span(text: str, anchor: str, what: str = "the anchor") -> tuple[int, int]:
    """Half-open `[start, end)` of `anchor`, matched in executable text but
    returned as offsets into the ORIGINAL `text`.

    For the heredoc pin, which must slice the body VERBATIM -- the body is
    Markdown and four of its lines begin with `#`, so it cannot be read out
    of the comment-stripped view. Only the anchor is matched there.
    """
    view, offsets = _executable_view(text)
    at = _the_code_hit(view, anchor, what)
    return offsets[at], offsets[at + len(anchor) - 1] + 1


# ── the Bash heredoc, read out of the script ──────────────────────────────

_HEREDOC_OPEN = 'cat > "$ROOT_DIR/context/now.md" <<EOF\n'

# §7 -- this anchor is DELIMITER-SPECIFIC, and one shape gets past it.
# RENAMING the delimiter fails loudly (`the now.md heredoc occurs 0 times`).
# But a SECOND write to the same file through a different delimiter --
# `cat > "$ROOT_DIR/context/now.md" <<EOF2` -- is not this anchor at all, so
# the uniqueness assertion sees one hit, reads the FIRST heredoc and passes,
# while bash's last write wins and `now.md` gets the second body. Measured:
# green with a `\`-comment hiding it AND with no comment anywhere, so this is
# not a §14 failure -- no comment need be involved.
#
# Recorded rather than closed. Closing it means detecting "any second write
# to this file", which is a different check with its own false-failure risk:
# a legitimate second write to `now.md` would then be a test failure with
# nothing wrong. Expiry: the moment `swil.sh` writes `now.md` more than once,
# this pin is reading the wrong body and the check has to be built.

# The four shell expansions inside that heredoc. Everything else in it is
# literal text -- including the `{topic}` / `{date}` in the swil-news URL,
# which carry no `$` and are NOT expansions.
_EXPANSIONS = (
    "$(date '+%Y年%m月%d日 %H:%M')",
    "$USERNAME",
    "$RECENT_POSTS",
    "$NEWS_HEADLINES",
)


def _bash_now_template(source: str | None = None) -> str:
    """`swil.sh`'s `now.md` heredoc body, verbatim.

    `source` exists so the guards below can be exercised by a UNIT test
    against a doctored script, rather than only by mutating the frozen
    `swil.sh` -- which CI cannot do, and which therefore leaves the guard
    unpinned everywhere except on this machine.
    """
    text = SWIL_SH.read_text(encoding="utf-8") if source is None else source
    _, start = _executable_span(text, _HEREDOC_OPEN, "the now.md heredoc")
    end = text.index("\nEOF\n", start)
    return text[start : end + 1]


def _bash_rendered(
    *, today: str, username: str, activity: str, news: str, source: str | None = None
) -> str:
    """What `swil.sh login`'s heredoc expands to, for known values."""
    rendered = _bash_now_template(source)
    for placeholder, value in zip(_EXPANSIONS, (today, username, activity, news), strict=True):
        rendered = rendered.replace(placeholder, value)
    return rendered


# ── the Bash `feed_for_*.md` builder, read out of the script ──────────────
#
# The now-context above was pinned against the script from the start; this
# file's expected value was TRANSCRIBED, which is the exact failure the
# heredoc pin was designed to avoid -- "a transcription drifts silently from
# the thing it claims to pin" (STANDING-CONSTRAINTS §1). It cost a real
# divergence: the topic list feeding these headings was derived differently
# from Bash (whitespace INSIDE a topic), and no test here could see it
# because both sides of the comparison were written by the same hand.
#
# `swil.sh:390-400` builds the file in three pieces, so this reads all three
# out of the script: the header assignment, the per-topic block assignment,
# and the jq program that renders one row.

_FEED_HEADER_ASSIGN = 'FEED_CONTENT="'
_FEED_BLOCK_ASSIGN = 'FEED_CONTENT+="'
_FEED_DATE_EXPANSION = "$(date '+%Y-%m-%d %H:%M')"
_FEED_BLOCK_EXPANSIONS = ("${FT_TOPIC}", "${FT_RESULTS}")

_TOPIC_JQ_OPEN = "jq -r '.data.items[]? | \""
_TOPIC_JQ_INTERPOLATIONS = (
    "\\(.id)",
    "\\(.author.username)",
    "\\(.author.displayName)",
    '\\(.text | gsub("\\n";" ") | .[0:200])',
)


def _bash_feed_fragment(assign: str, source: str | None = None) -> str:
    """The double-quoted literal assigned to `FEED_CONTENT` at `assign`.

    Read out of the EXECUTABLE view through `_the_code_hit` (§14). A bare
    `index` over raw source took the first textual match, so a commented-out
    copy of the original assignment above a reworded real one satisfied this
    pin completely.
    """
    view = _executable(SWIL_SH.read_text(encoding="utf-8") if source is None else source)
    start = _the_code_hit(view, assign, f"{assign!r}") + len(assign)
    return view[start : view.index('"\n', start)]


def _bash_topic_row(
    *, post_id: str, username: str, display: str, body: str, source: str | None = None
) -> str:
    """One rendered row of a `## #<topic>` block -- `swil.sh:395`'s jq string.

    `body` is what jq's `\\(.text | gsub("\\n";" ") | .[0:200])` produces:
    newlines already flattened to spaces, already truncated. Everything
    around it -- the brackets, the `@`, the full-width parentheses, the
    ASCII colon-space -- comes out of the script.
    """
    view = _executable(SWIL_SH.read_text(encoding="utf-8") if source is None else source)
    start = _the_code_hit(view, _TOPIC_JQ_OPEN, "the topic-row jq") + len(_TOPIC_JQ_OPEN)
    row = view[start : view.index("\"'", start)]
    values = (post_id, username, display, body)
    for placeholder, value in zip(_TOPIC_JQ_INTERPOLATIONS, values, strict=True):
        row = row.replace(placeholder, value)
    return row


def _bash_feed_rendered(
    *, today: str, blocks: list[tuple[str, str]], source: str | None = None
) -> str:
    """What `swil.sh login` writes to `context/feed_for_<username>.md`.

    `blocks` is `(topic, rendered_rows)` for the topics whose search returned
    something -- `swil.sh:396`'s `if [[ -n "$FT_RESULTS" ]]` means a topic
    that returned nothing contributes no block at all, so it simply does not
    appear in this list.
    """
    accumulated = _bash_feed_fragment(_FEED_HEADER_ASSIGN, source).replace(
        _FEED_DATE_EXPANSION, today
    )
    block_template = _bash_feed_fragment(_FEED_BLOCK_ASSIGN, source)
    for topic, rows in blocks:
        block = block_template
        for placeholder, value in zip(_FEED_BLOCK_EXPANSIONS, (topic, rows), strict=True):
            block = block.replace(placeholder, value)
        accumulated += block
    # `printf "%b" "$FEED_CONTENT"` (swil.sh:400) expands the accumulated
    # string's escapes ONCE, at the very end -- which is why this happens
    # here and not fragment by fragment.
    return accumulated.replace("\\n", "\n")


# ── test doubles ──────────────────────────────────────────────────────────


class FakeWorld:
    """Duck-types the four `Resources` READ methods the renderers use.

    Every call is recorded, because for this module the interesting mutations
    are on the ARGUMENTS (which board, which topic, which limit) rather than
    on what came back -- STANDING-CONSTRAINTS §2.
    """

    def __init__(self) -> None:
        self.global_feeds: dict[int, list[dict[str, Any]]] = {}
        self.board_feeds: dict[str, list[dict[str, Any]]] = {}
        self.boards: dict[str, str] = {}
        self.searches: dict[str, list[dict[str, Any]]] = {}
        self.global_calls: list[tuple[int, str]] = []
        self.board_calls: list[tuple[str, int, str]] = []
        self.search_calls: list[tuple[str, int]] = []
        self.boards_calls = 0
        self.failing: set[str] = set()

    def feed_global(self, limit: int, sort: str) -> list[dict[str, Any]]:
        self.global_calls.append((limit, sort))
        if "feed_global" in self.failing:
            raise ApiError(500, "boom", None)
        return self.global_feeds.get(limit, [])

    def feed_board(self, slug: str, limit: int = 12, sort: str = "latest") -> list[dict[str, Any]]:
        self.board_calls.append((slug, limit, sort))
        if f"feed_board_{slug}" in self.failing:
            raise ApiError(500, "boom", None)
        return self.board_feeds.get(slug, [])

    def get_boards(self) -> dict[str, str]:
        self.boards_calls += 1
        if "get_boards" in self.failing:
            raise ApiError(500, "boom", None)
        return self.boards

    def search_posts(self, q: str, limit: int = 12) -> list[dict[str, Any]]:
        self.search_calls.append((q, limit))
        if f"search_{q}" in self.failing:
            raise ApiError(500, "boom", None)
        return self.searches.get(q, [])


class ExplodingRunner:
    """A `Runner` whose subprocess call blows up.

    `SubprocessRunner` signals a dead/timed-out child by returning `""`, but
    it RAISES `BackendBinaryMissingError` (a `RuntimeError`) when argv[0] is
    not on PATH -- a machine with no `bash` on it, or an agent_root whose
    `scripts/` directory is not where it is expected. Ruling R27 says a news
    failure must be non-fatal, and "non-fatal" has to cover the raising shape
    too, not only the empty-string one.
    """

    def __init__(self) -> None:
        self.calls = 0

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self.calls += 1
        raise RuntimeError("news-fetch exploded")


def _post(
    post_id: str = "aaaaaaaaaaaaaaaaaaaaaaaa",
    *,
    username: str = "someone",
    display: str = "某人",
    text: str = "一句话",
    created: str = "2026-08-18T09:00:00.000Z",
) -> dict[str, Any]:
    return {
        "id": post_id,
        "text": text,
        "createdAt": created,
        "author": {"username": username, "displayName": display},
    }


def _persona(
    username: str,
    *,
    topics: list[str] | None = None,
    board: str | None = None,
    read: str | None = None,
    directory: Path | None = None,
) -> Persona:
    return Persona(
        username=username,
        directory=directory or Path("/tmp") / username,
        follow_topics=topics or [],
        board=board,
        read=read,
    )


def _agent_root_with_news(tmp_path: Path, digest: str) -> Path:
    (tmp_path / "context").mkdir(parents=True, exist_ok=True)
    (tmp_path / "context" / NEWS_CACHE_FILENAME).write_text(digest, encoding="utf-8")
    return tmp_path


# ── (a) freshness: the date comes from the clock ──────────────────────────


@pytest.mark.parametrize(
    ("now", "expected_line"),
    [
        (NOW_A, "**今日日期：** 2026年08月20日 07:42"),
        (NOW_B, "**今日日期：** 2026年03月04日 19:05"),
    ],
)
def test_now_context_dates_itself_from_the_injected_clock(
    now: datetime, expected_line: str
) -> None:
    """The defect this task fixes, stated as a property.

    Two clocks, two answers: a renderer that hardcoded EITHER date (which is
    what reading a frozen `now.md` amounted to) fails one half of this
    parametrisation. The format is `swil.sh:362`'s own
    `date '+%Y年%m月%d日 %H:%M'`, zero-padded month/day/hour included.
    """
    text = render_now_context(username="zenith", now=now, activity="A", news="N")
    assert expected_line in text.splitlines()


def test_now_context_never_carries_the_frozen_cutover_header() -> None:
    """A regression pin naming the exact bytes 23 accounts were served.

    `2026年08月19日 05:30` / `qiusai` is not an arbitrary example: it is what
    `agent/context/now.md` said for every round between the Stage-5 cutover
    and this fix.
    """
    text = render_now_context(username="zenith", now=NOW_A, activity="A", news="N")
    assert "2026年08月19日 05:30" not in text
    assert "qiusai" not in text


# ── (b) per-account: two accounts, one process ────────────────────────────


def test_two_accounts_rendered_in_one_process_name_themselves() -> None:
    """`now.md` was one shared file with a per-account line in it, so five
    parallel rounds raced and the file ended up naming ONE of them.

    Rendering both in the same process is the only shape that catches a
    module-level `_CURRENT_AGENT` (or a re-read of the shared file): an
    assertion about `当前 Agent` attached to a single render passes just as
    happily against a constant.
    """
    first = render_now_context(username="zenith", now=NOW_A, activity="A", news="N")
    second = render_now_context(username="liushang", now=NOW_A, activity="A", news="N")

    assert "**当前 Agent：** zenith" in first.splitlines()
    assert "**当前 Agent：** liushang" in second.splitlines()
    assert first != second


def test_two_accounts_get_their_own_follow_topics_feed_in_one_process() -> None:
    """Same shape, one layer down: the follow-topics feed is per-account too,
    and it was being read from a per-account FILE whose contents nobody
    refreshed.
    """
    world = FakeWorld()
    world.searches = {
        "alpha": [_post("a" * 24, username="one", display="第一", text="alpha post")],
        "gamma": [_post("g" * 24, username="two", display="第二", text="gamma post")],
    }

    first = render_follow_topics_feed(world, _persona("zenith", topics=["alpha"]), now=NOW_A)
    second = render_follow_topics_feed(world, _persona("liushang", topics=["gamma"]), now=NOW_A)

    assert "## #alpha" in first
    assert "## #gamma" not in first
    assert "## #gamma" in second
    assert "## #alpha" not in second
    assert world.search_calls == [("alpha", 12), ("gamma", 12)]


# ── (c) template fidelity (R28) ───────────────────────────────────────────


def test_now_context_is_byte_identical_to_the_bash_heredoc() -> None:
    """R28: only the freshness of the content may change, never the wording.

    The expected value is BUILT from `agent/scripts/swil.sh`'s own heredoc at
    test time. Deleting a 注意事项 bullet, reordering the sections, changing
    the swil-news URL line, or dropping the trailing newline all fail here --
    and so does an edit to the script that the Python side did not follow.
    """
    activity = "- [x] 甲（2026-08-18）：内容"
    news = "**日报日期：** 2026-08-19\n### [ai] 标题"
    expected = _bash_rendered(
        today="2026年08月20日 07:42", username="zenith", activity=activity, news=news
    )

    assert (
        render_now_context(username="zenith", now=NOW_A, activity=activity, news=news) == expected
    )


def test_the_bash_heredoc_has_exactly_the_four_expansions_we_substitute() -> None:
    """Guards the guard above.

    `_bash_rendered` only knows how to expand four things. If someone adds a
    fifth `$...` to the heredoc, the "expected" value would silently carry a
    raw shell expansion and the comparison above would start failing for a
    reason nobody could read. Failing HERE says what actually happened.
    """
    rendered = _bash_rendered(today="D", username="U", activity="A", news="N")
    assert "$" not in rendered
    assert "{topic}" in rendered  # literal, not an expansion
    assert "{date}" in rendered


def test_now_context_keeps_all_four_notice_bullets() -> None:
    """A cheaper, independently-readable statement of one half of R28.

    The heredoc comparison above would also catch a dropped bullet, but only
    as "the two big strings differ". This names the thing.
    """
    text = render_now_context(username="zenith", now=NOW_A, activity="A", news="N")
    body = text.split("## 注意事项\n", 1)[1]
    assert len([line for line in body.splitlines() if line.startswith("- ")]) == 4


# ── (d) the follow-topics feed comes from the API ─────────────────────────


def test_follow_topics_feed_is_byte_identical_to_the_bash_assignment() -> None:
    """R28 for the OTHER file `swil.sh login` wrote.

    The expected value is BUILT from `swil.sh:390-400` at test time -- the
    header assignment, the per-topic block assignment and the row jq, each
    read out of the script -- exactly as
    `test_now_context_is_byte_identical_to_the_bash_heredoc` does for
    `now.md`. It used to be a transcription, and the divergence a
    transcription cannot see (the topic strings themselves) turned out to be
    real: see `test_a_multi_word_topic_is_searched_the_way_bash_searched_it`.

    The topics are DELIBERATELY not in alphabetical order. `["alpha",
    "beta"]` is already sorted, so a renderer that sorted its topics was
    indiscriminable from one that kept the declaration order
    (STANDING-CONSTRAINTS §4) -- and no roster bullet is sorted.
    """
    world = FakeWorld()
    world.searches = {
        "zeta": [
            _post("a" * 24, username="one", display="第一", text="第一条\n换行"),
            _post("b" * 24, username="two", display="第二", text="第二条"),
        ],
        "alpha": [_post("c" * 24, username="three", display="第三", text="第三条")],
    }

    text = render_follow_topics_feed(world, _persona("zenith", topics=["zeta", "alpha"]), now=NOW_A)

    zeta_rows = "\n".join(
        (
            _bash_topic_row(post_id="a" * 24, username="one", display="第一", body="第一条 换行"),
            _bash_topic_row(post_id="b" * 24, username="two", display="第二", body="第二条"),
        )
    )
    alpha_rows = _bash_topic_row(post_id="c" * 24, username="three", display="第三", body="第三条")
    assert text == _bash_feed_rendered(
        today="2026-08-20 07:42", blocks=[("zeta", zeta_rows), ("alpha", alpha_rows)]
    )


def test_the_bash_feed_assignment_has_exactly_the_expansions_we_substitute() -> None:
    """Guards the guard above, the same way the heredoc's companion does.

    `_bash_feed_rendered` knows how to expand one date, two block variables
    and four jq interpolations. A fifth added to the script would otherwise
    leave a raw `$...` or `\\(...)` inside the "expected" value and turn the
    comparison above into an unreadable diff. Failing HERE names what
    happened.
    """
    rendered = _bash_feed_rendered(today="D", blocks=[("T", "R")])
    assert "$" not in rendered
    assert rendered == "# 关联话题动态 (D)\n\n## #T\nR\n\n"

    row = _bash_topic_row(post_id="I", username="U", display="N", body="B")
    assert "\\(" not in row
    assert "$" not in row


# A miniature `swil.sh`, carrying every shape the real anchors sit in. It is
# a FIXTURE, not a transcription of the script -- the frozen-script rows are
# what compare against the real thing. Its job is to contain what the view
# has to handle, including `#` INSIDE executable text: a fixture with no `#`
# in it cannot detect a stripper that eats too much (§4), which is exactly
# why an over-eager stripper was killed only by the frozen-script pins last
# round and not by the test written for it.
_VIEW_FIXTURE = (
    '# FEED_CONTENT="commented decoy"\n'
    '    # FEED_CONTENT="indented commented decoy"\n'
    "# a comment ending in a backslash \\\n"
    'FEED_CONTENT="real"\n'
    'BLOCK+="## #${FT_TOPIC}\\n"\n'
    "SPLIT=$(one | \\\n"
    "  two)\n"
    'TRAILING="kept"  # FEED_CONTENT="parked decoy"\n'
    # The symmetric case, and the one shape the fixture was missing: a
    # continuation line that BEGINS with `#`. Bash joins first and tokenises
    # after, so this is not a comment and `JOINED` ends up `## #not-a-comment`.
    # Without this row, testing every physical line for comment-ness -- the
    # mistake that looks symmetric to the one above -- leaves the whole suite
    # green while the readers return a wrong string.
    'JOINED="## \\\n'
    '#not-a-comment"\n'
    'NEXT="its own line"\n'
)


def test_the_view_drops_comments_and_keeps_the_hash_inside_executable_text() -> None:
    """Both directions of §14, on the helper rather than only through its
    callers, and with a fixture that can actually fail.

    `BLOCK+="## #${FT_TOPIC}\n"` is `swil.sh:397`'s shape and is the reason
    rule 3 filters match POSITIONS instead of cutting each line at its first
    `#`: a cutting rule would truncate that line at `## ` and turn a live
    anchor into a false failure.
    """
    view = _executable(_VIEW_FIXTURE)

    assert "commented decoy" not in view
    assert "indented commented decoy" not in view
    assert 'FEED_CONTENT="real"' in view
    # Executable `#`s survive intact -- a stripper that cut at the first `#`
    # would leave `BLOCK+="` and this line would say so.
    assert 'BLOCK+="## #${FT_TOPIC}\\n"' in view
    # A trailing comment is NOT removed from the view (removing it correctly
    # needs a quoting-aware parser); it is neutralised by rule 3 instead, and
    # the test below is the one that proves it.
    assert 'TRAILING="kept"' in view


def test_a_comment_does_not_continue_onto_the_line_below_it() -> None:
    r"""The defect the previous round's fix introduced.

    Bash does not continue a comment: the `\` at the end of `# … \` is inside
    the comment and never reaches the line-continuation rule, so the line
    below still executes. Grouping continuations BEFORE testing for
    comment-ness deleted that line from the view -- a comment HIDING the code
    that contradicts a pin, which is §14 inverted and just as green.

    Verified against real bash, not reasoned about: `# x \` + `X=2` leaves
    `X=2` set.
    """
    view = _executable(_VIEW_FIXTURE)
    assert 'FEED_CONTENT="real"' in view
    assert "a comment ending in a backslash" not in view

    # The false-failure half of the same bug: the hidden line is the one the
    # pin is looking for, so the pin fails for a reason that is not true.
    hidden = '# note \\\nFEED_CONTENT="real"\n'
    assert _bash_feed_fragment('FEED_CONTENT="', hidden) == "real"


def test_a_continuation_line_that_begins_with_a_hash_is_still_code() -> None:
    r"""The mistake that LOOKS symmetric to the one above, and is not.

    Comment-ness is tested per physical line, but only on the line that
    STARTS a logical line. Bash joins continuations first and tokenises
    afterwards, so `JOINED="## \` followed by `#not-a-comment"` sets `JOINED`
    to `## #not-a-comment`; the `#` is inside a quoted word that the line
    below merely finishes. Verified against real bash (3.2.57, macOS), not
    reasoned about.

    Testing EVERY physical line instead does two things, and neither is a
    loud failure. It deletes the continuation from the view, and it makes the
    join reach past it and swallow the next executable line -- so
    `_bash_feed_fragment` on `FEED_CONTENT="## \` / `#${FT_TOPIC}\n\n"` /
    `printf "%b" "$FEED_CONTENT"` returns `'## printf "%b" "$FEED_CONTENT'`
    with no exception raised. Measured, not predicted.

    §7 -- inert today: no `agent/scripts/*.sh` has a `\`-continuation into a
    `#`-leading line (`awk 'prev ~ /\\$/ && $0 ~ /^[[:space:]]*#/'` over all
    23 of them returns nothing). It stops being inert the first time one
    does, and `swil.sh:397` already assigns a `"## #..."` literal, so the
    distance is one line break.
    """
    view = _executable(_VIEW_FIXTURE)
    assert 'JOINED="## #not-a-comment"' in view
    # ...and the line below the continuation is still a line of its own. Under
    # the mistake above it becomes the continuation instead, which is how the
    # wrong string gets built rather than an error raised.
    assert '\nNEXT="its own line"' in view


def test_continuations_are_joined_the_way_bash_joins_them() -> None:
    r"""`\`+newline is removed and the continuation line keeps its own leading
    whitespace, so an anchor that spans the join is findable and the "what
    precedes the anchor" test sees the whole line bash executes.

    No anchor spans a join today -- the topic-row jq lies wholly on
    `swil.sh:395`, which is a continuation of the `curl` on `:394`, so what
    the join buys THERE is that rule 3 sees the `curl` half too. The
    spanning case is pinned anyway, because it is the property that keeps
    being true when the script moves.
    """
    view = _executable(_VIEW_FIXTURE)
    assert "SPLIT=$(one |   two)" in view
    assert "\\\n" not in view
    assert _code_hits(view, "one |   two") == [view.index("one |   two")]


def test_the_span_maps_back_onto_the_original_text() -> None:
    """The heredoc pin slices a body a comment-stripped view would have eaten
    -- four of its lines begin with `#` -- so only its ANCHOR is matched in
    the view and the offsets must land in the original."""
    start, end = _executable_span(_VIEW_FIXTURE, 'FEED_CONTENT="real"')
    assert _VIEW_FIXTURE[start:end] == 'FEED_CONTENT="real"'

    # Across a join, the end offset still lands past the last anchor
    # character in the ORIGINAL, where the `\` and newline are still present.
    start, end = _executable_span(_VIEW_FIXTURE, "one |   two")
    assert _VIEW_FIXTURE[start:end] == "one | \\\n  two"


def test_an_anchor_parked_behind_a_mid_line_hash_is_not_a_match() -> None:
    """The attack the uniqueness assertion alone does not stop.

    Rename the real assignment so the anchor occurs exactly once, reword what
    it writes, and park the ORIGINAL text in a trailing comment: one hit, on
    an executable line, and it is the decoy. Rule 3 -- nothing before the
    anchor on its joined line may be a `#` -- is what refuses it, and it
    refuses by NAME (zero hits) rather than by returning the wrong string.
    """
    doctored = (
        "FEED_BUF=\"# 关联话题最新动态 ($(date '+%Y-%m-%d %H:%M'))\\n\\n\""
        "  # FEED_CONTENT=\"# 关联话题动态 ($(date '+%Y-%m-%d %H:%M'))\\n\\n\"\n"
    )
    with pytest.raises(AssertionError, match="occurs 0 times"):
        _bash_feed_fragment('FEED_CONTENT="', doctored)


_DOUBLED: dict[str, tuple[Callable[[str], object], str]] = {
    "the feed assignment": (
        lambda src: _bash_feed_fragment('FEED_CONTENT="', src),
        'FEED_CONTENT="one"\nFEED_CONTENT="two"\n',
    ),
    "the topic-row jq": (
        lambda src: _bash_topic_row(post_id="I", username="U", display="N", body="B", source=src),
        "jq -r '.data.items[]? | \"one\"'\njq -r '.data.items[]? | \"two\"'\n",
    ),
    "the heredoc": (
        lambda src: _bash_now_template(src),
        'cat > "$ROOT_DIR/context/now.md" <<EOF\nA\nEOF\n'
        'cat > "$ROOT_DIR/context/now.md" <<EOF\nB\nEOF\n',
    ),
    # The news ceiling reads TWO numbers and each has its own guarded call,
    # so it needs two rows. With one, relaxing the spinlock-cap call survived
    # while the NEWS_TIMEOUT row went on passing -- §4 again, inside a test
    # written for §14.
    "the news ceiling / NEWS_TIMEOUT": (
        lambda src: _news_script_ceiling(src),
        "(( waited > 120 )) && return 1\n"
        'NEWS_TIMEOUT="${NEWS_TIMEOUT:-200}"\n'
        'NEWS_TIMEOUT="${NEWS_TIMEOUT:-45}"\n',
    ),
    "the news ceiling / spinlock cap": (
        lambda src: _news_script_ceiling(src),
        "(( waited > 120 )) && return 1\n"
        "(( waited > 30 )) && return 1\n"
        'NEWS_TIMEOUT="${NEWS_TIMEOUT:-45}"\n',
    ),
    # ...and a third, because the SHAPE of the second assignment is the other
    # thing that has to stay pinned. The row above doubles the modelled
    # `${NEWS_TIMEOUT:-N}` form; this one is a plain reassignment, which the
    # narrower regex neither saw nor refused. It is the whole of N6: with it
    # the ceiling read 165 while the script's own was 320 against a 180s
    # bound, and the suite stayed green.
    "the news ceiling / a second assignment of any shape": (
        lambda src: _news_script_ceiling(src),
        '(( waited > 120 )) && return 1\nNEWS_TIMEOUT="${NEWS_TIMEOUT:-45}"\nNEWS_TIMEOUT=200\n',
    ),
}


@pytest.mark.parametrize("what", list(_DOUBLED))
def test_every_pin_refuses_a_duplicated_anchor_rather_than_taking_the_first(what: str) -> None:
    """ "First match wins" is a decoy comment one step on: two REAL lines and
    the pin silently reads whichever comes first.

    Every guarded call is checked, because the guard used to be copied per
    caller and a relaxed copy survived the whole suite. They share one
    implementation now, and this parametrisation is what keeps each CALL
    routed through it -- a call that went back to a bare `index`/`re.search`
    would pass every frozen-script row (the real scripts have no duplicates)
    and fail only here.
    """
    call, doubled = _DOUBLED[what]
    with pytest.raises(AssertionError, match="occurs 2 times"):
        call(doubled)


def test_the_news_ceiling_reads_both_numbers_as_code() -> None:
    r"""A decoy `NEWS_TIMEOUT` in a comment, and a real one under a
    `\`-terminated comment, must both resolve to the executable value.

    This is the F6 condition restated: the bound only means anything if the
    number it is compared against is the one the script actually uses.
    """
    doctored = (
        '# NEWS_TIMEOUT="${NEWS_TIMEOUT:-45}"\n'
        "# hidden by a backslash comment \\\n"
        ": placeholder  # (( waited > 999 )) && return 1\n"
        "(( waited > 30 )) && return 1\n"
        'NEWS_TIMEOUT="${NEWS_TIMEOUT:-200}"\n'
    )
    assert _news_script_ceiling(doctored) == 230.0


def test_follow_topics_are_searched_in_the_personas_declared_order() -> None:
    """`for FT_TOPIC in "${FT_TOPICS[@]}"` (swil.sh:391) -- the bullet's own
    order, never `sorted()`.

    Real bullets are not alphabetical (`zenith`: `AI, philosophy, language,
    consciousness, perception, time`), so sorting would reorder every
    `## #<topic>` block in the prompt relative to the Bash rollback path and
    change the bytes R28 protects. The fixture's three topics are in an
    order no sort produces -- neither ascending nor descending -- so both
    directions are visible.
    """
    world = FakeWorld()
    world.searches = {
        "zeta": [_post("a" * 24)],
        "alpha": [_post("b" * 24)],
        "mu": [_post("c" * 24)],
    }

    text = render_follow_topics_feed(
        world, _persona("zenith", topics=["zeta", "alpha", "mu"]), now=NOW_A
    )

    assert world.search_calls == [("zeta", 12), ("alpha", 12), ("mu", 12)]
    assert [line for line in text.splitlines() if line.startswith("## #")] == [
        "## #zeta",
        "## #alpha",
        "## #mu",
    ]


def test_a_multi_word_topic_is_searched_the_way_bash_searched_it(tmp_path: Path) -> None:
    """`_get_field`'s `tr -d '[:space:]'` (swil.sh:55) deletes whitespace
    INSIDE a topic, not only around it.

    This starts at the `personality.md` rather than at a `Persona` because
    the divergence lived in the DERIVATION, not in the renderer: Python
    stripped each comma-separated element's ends and Bash collapsed the whole
    field before splitting it. The bullet below is
    `agent/agents/sketch/personality.md`'s, abridged -- that account
    (`Username: diannaokun`) is the one roster member the two derivations
    disagree about, on three of its thirteen topics.

    Both halves of the disagreement are asserted, because they are two
    different kinds of damage: the QUERY decides which posts reach the
    prompt, and the HEADING is bytes in the prompt that R28 pins.
    """
    (tmp_path / "personality.md").write_text(
        "- **Username:** diannaokun\n"
        "- **Follow Topics:** AI 行业, AI Agent 叙事, 程序员文化, AI 治理话术\n",
        encoding="utf-8",
    )
    persona = load_persona(tmp_path)
    assert persona.follow_topics == ["AI行业", "AIAgent叙事", "程序员文化", "AI治理话术"]

    world = FakeWorld()
    world.searches = {"AI行业": [_post("a" * 24)], "AI 行业": [_post("b" * 24)]}

    text = render_follow_topics_feed(world, persona, now=NOW_A)

    assert world.search_calls == [
        ("AI行业", 12),
        ("AIAgent叙事", 12),
        ("程序员文化", 12),
        ("AI治理话术", 12),
    ]
    assert "## #AI行业" in text.splitlines()
    assert "AI 行业" not in text
    assert f"- [{'a' * 24}]" in text
    assert f"- [{'b' * 24}]" not in text


def test_topic_whitespace_is_deleted_the_way_tr_deletes_it(tmp_path: Path) -> None:
    """`tr -d '[:space:]'` is not `replace(" ", "")`, and the difference is
    the reason `_split_topics` uses `str.split()`. A space-only collapse
    passes every OTHER test in this file, because no roster bullet contains a
    tab or a full-width space -- so without this one the choice would be
    undefended.

    WHAT THIS ASSERTS, precisely: Python's behaviour. The expected value is
    transcribed, not obtained by running `tr` -- an earlier version of this
    docstring said "measured directly against `tr`", which was a claim about
    a subprocess this test does not spawn. `tr` is NOT shelled out to here on
    purpose: BSD `tr` (macOS, where `swil.sh` runs) and GNU `tr` (Linux,
    where CI runs) disagree about U+3000, so a test that ran it would assert
    a different thing on each machine and fail in CI.

    The correspondence with `tr` was measured out of band, on macOS under
    `en_US.UTF-8`, and what it showed -- including the five codepoints and
    the one locale where the two do NOT correspond -- is recorded as §7
    conditions in `loader._split_topics`'s docstring, which is the honest
    place for a finding no test re-derives.
    """
    (tmp_path / "personality.md").write_text(
        "- **Username:** diannaokun\n- **Follow Topics:** A　B,\tC D\t, E\n",
        encoding="utf-8",
    )
    assert load_persona(tmp_path).follow_topics == ["AB", "CD", "E"]


def test_follow_topics_feed_skips_a_topic_that_returned_nothing() -> None:
    """`swil.sh:396`'s `if [[ -n "$FT_RESULTS" ]]` -- an empty search
    contributes no heading at all, rather than an empty section."""
    world = FakeWorld()
    world.searches = {"beta": [_post("c" * 24)]}

    text = render_follow_topics_feed(world, _persona("zenith", topics=["alpha", "beta"]), now=NOW_A)

    assert "## #alpha" not in text
    assert "## #beta" in text


def test_follow_topics_feed_survives_a_failing_search() -> None:
    """`curl -sf ... || true` (swil.sh:392-394): one topic's search failing
    costs that topic's block, never the whole feed."""
    world = FakeWorld()
    world.failing.add("search_alpha")
    world.searches = {"beta": [_post("c" * 24)]}

    text = render_follow_topics_feed(world, _persona("zenith", topics=["alpha", "beta"]), now=NOW_A)

    assert "## #alpha" not in text
    assert "## #beta" in text


def test_persona_without_follow_topics_gets_the_empty_string() -> None:
    """`swil.sh:387` guards the whole block on a non-empty `Follow Topics`,
    so such an account never had a `feed_for_*.md` file at all and
    `auto-run.sh:504` read the empty string. Not an error, and NOT a dated
    header with no sections under it -- an empty feed_context is what makes
    `render_planner_prompt` drop the 平台时间线 heading entirely."""
    world = FakeWorld()
    assert render_follow_topics_feed(world, _persona("zenith"), now=NOW_A) == ""
    assert world.search_calls == []


def test_topic_feed_line_truncates_at_200_characters() -> None:
    """`.[0:200]` in swil.sh:393's jq -- a different cap from the 120 the
    now-context feed uses, so a renderer that shared one constant between
    them is visible here."""
    line = format_topic_feed([_post("a" * 24, text="字" * 500)])
    assert line.endswith("字" * 200)
    assert "字" * 201 not in line


# ── the platform-activity block (swil.sh:328-352) ─────────────────────────


def test_platform_activity_line_format_and_120_char_cap() -> None:
    """`_fmt_posts` (swil.sh:318): the id in square brackets, the author's
    DISPLAY name, the date in full-width parentheses, a full-width colon, and
    a 120-character body. The assertion below is the line itself."""
    rendered = format_now_feed([_post("a" * 24, display="某人", text="字" * 500)])
    assert rendered == f"- [{'a' * 24}] 某人（2026-08-18）：{'字' * 120}"


def test_a_global_read_account_reads_the_global_feed() -> None:
    """`Read: global` takes `limit=18&sort=latest` (swil.sh:332)."""
    world = FakeWorld()
    world.global_feeds[18] = [_post("a" * 24)]

    text = platform_activity(world, _persona("zenith", read="global"), now=NOW_A)

    assert world.global_calls == [(18, "latest")]
    assert world.board_calls == []
    assert text.startswith(f"- [{'a' * 24}]")


def test_a_global_read_account_that_also_has_a_board_never_reads_the_board() -> None:
    """The two arms are EXCLUSIVE (`elif`, swil.sh:333) and this is the
    majority case, not a corner: **12 of the 23 accounts carry both
    bullets** -- `darkpool moguan qianxian shengyin shunteng sketch vex`
    under `agents/`, `chongkai lvchuang mangniu maobian zaofan` under
    `humans/`.

    Every other fixture in this file sets `read` OR `board`, never both, so
    the exclusivity was indiscriminable (STANDING-CONSTRAINTS §4): turning
    the `elif` into a second `if` left the whole suite green while giving
    each of those 12 accounts the global-18 read, DISCARDING it, and then
    going board-scoped -- one wasted request per round and the exact
    inversion of the experiment control `swil.sh:322-327` spends six lines
    defending. `Read: global` pins a cross-board role to the widest possible
    input while `Board` still files its posts; an account that reads its own
    board instead is neither wide-reading nor a control.

    The board is populated on purpose. An empty one would send the mutant
    through the global-15 fallback and make its damage look like a second
    global call rather than a board read.
    """
    world = FakeWorld()
    world.boards = {"living": "1", "market": "2"}
    world.global_feeds[18] = [_post("a" * 24, display="全局")]
    world.board_feeds = {"market": [_post("b" * 24, display="板块")]}

    text = platform_activity(world, _persona("zenith", read="global", board="market"), now=NOW_A)

    assert world.global_calls == [(18, "latest")]
    assert world.board_calls == []
    assert world.boards_calls == 0
    assert text == f"- [{'a' * 24}] 全局（2026-08-18）：一句话"


def test_the_global_sentinel_is_matched_case_insensitively() -> None:
    """`swil.sh:329` lowercases the `Read` bullet before comparing."""
    world = FakeWorld()
    world.global_feeds[18] = [_post("a" * 24)]
    platform_activity(world, _persona("zenith", read="GLOBAL"), now=NOW_A)
    assert world.global_calls == [(18, "latest")]


def test_a_board_account_reads_its_board_plus_a_rotating_cross_board() -> None:
    """`swil.sh:334-347`: the home board at `limit=12`, then ONE other board
    at `limit=3`, picked by day-of-year modulo the candidate count."""
    world = FakeWorld()
    world.boards = {"living": "1", "market": "2", "making": "3"}
    world.board_feeds = {
        "living": [_post("a" * 24, display="甲")],
        "market": [_post("b" * 24, display="乙")],
        "making": [_post("c" * 24, display="丙")],
    }
    # 2026-08-20 is day 232; candidates are [market, making]; 232 % 2 == 0.
    text = platform_activity(world, _persona("zenith", board="living"), now=NOW_A)

    assert world.board_calls == [("living", 12, "latest"), ("market", 3, "latest")]
    assert "（其他板块 · market）" in text
    assert f"- [{'a' * 24}] 甲" in text
    assert f"- [{'b' * 24}] 乙" in text


def test_the_cross_board_pick_rotates_with_the_day_of_year() -> None:
    """The rotation is the whole point of the cross-board window -- a fixed
    pick would be one more constant in every prompt. Same board, same
    candidate list, a different day: a different neighbour.
    """
    world = FakeWorld()
    world.boards = {"living": "1", "market": "2", "making": "3"}
    world.board_feeds = {"market": [_post("b" * 24)], "making": [_post("c" * 24)]}
    persona = _persona("zenith", board="living")

    # 2026-03-04 is day 63; 63 % 2 == 1 -> the SECOND candidate.
    text = platform_activity(world, persona, now=NOW_B)

    assert ("making", 3, "latest") in world.board_calls
    assert "（其他板块 · making）" in text


def test_a_board_account_with_an_empty_board_falls_back_to_the_global_feed() -> None:
    """`swil.sh:348-351`: a blank result from the board path re-reads global
    at `limit=15` -- a different limit from the `Read: global` arm's 18, so a
    renderer that collapsed the two is visible."""
    world = FakeWorld()
    world.global_feeds[15] = [_post("a" * 24)]

    text = platform_activity(world, _persona("zenith", board="living"), now=NOW_A)

    assert world.global_calls == [(15, "latest")]
    assert text.startswith(f"- [{'a' * 24}]")


def test_an_account_with_no_board_and_no_read_bullet_uses_the_fallback() -> None:
    """22 of the 23 roster accounts, and every account before boards existed."""
    world = FakeWorld()
    world.global_feeds[15] = [_post("a" * 24)]

    platform_activity(world, _persona("zenith"), now=NOW_A)

    assert world.global_calls == [(15, "latest")]
    assert world.boards_calls == 0


def test_platform_activity_degrades_to_the_placeholder_when_every_read_fails() -> None:
    """`swil.sh:352`. The block is placeholder-class, never vanish-class: the
    heading stays and says so."""
    world = FakeWorld()
    world.failing.add("feed_global")
    assert platform_activity(world, _persona("zenith"), now=NOW_A) == WORLD_CONTEXT_UNAVAILABLE


def test_an_empty_cross_board_contributes_no_label() -> None:
    """`swil.sh:342`'s `if [[ -n "$CROSS_POSTS" ]]`.

    The rotation can land on a board that has nothing on it -- `making`
    carried four posts roster-wide at the last count -- and a bare
    cross-board label with no rows under it would read to the model as a
    board that exists and is silent, which is a claim the data does not
    make.
    """
    world = FakeWorld()
    world.boards = {"living": "1", "market": "2"}
    world.board_feeds = {"living": [_post("a" * 24, display="甲")]}

    text = platform_activity(world, _persona("zenith", board="living"), now=NOW_A)

    assert world.board_calls == [("living", 12, "latest"), ("market", 3, "latest")]
    assert "其他板块" not in text
    assert text == f"- [{'a' * 24}] 甲（2026-08-18）：一句话"


def test_a_failing_boards_call_costs_only_the_cross_board_window() -> None:
    """`curl ... | jq ... || true` on swil.sh:337-340 -- the home board's
    posts still render."""
    world = FakeWorld()
    world.failing.add("get_boards")
    world.board_feeds = {"living": [_post("a" * 24, display="甲")]}

    text = platform_activity(world, _persona("zenith", board="living"), now=NOW_A)

    assert "（其他板块" not in text
    assert f"- [{'a' * 24}] 甲" in text


# ── (e) the news digest, and its failure being non-fatal ──────────────────


def test_news_digest_shells_out_to_news_fetch_then_reads_the_shared_cache(
    tmp_path: Path,
) -> None:
    """Ruling R27: `news_today.md` keeps its file and Python shells out to
    the existing cache-filler rather than reimplementing it."""
    (tmp_path / "scripts").mkdir()
    script = tmp_path / "scripts" / NEWS_FETCH_SCRIPT
    script.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    _agent_root_with_news(tmp_path, "**日报日期：** 2026-08-20\n")
    runner = RecordingRunner()

    digest = read_news_digest(tmp_path, runner)

    assert [call.argv for call in runner.calls] == [["bash", str(script)]]
    # The timeout is pinned too: `SubprocessRunner` enforces it by SIGKILLing
    # the child, and `news-fetch.sh` holds an inter-process lock directory for
    # its whole body -- a kill mid-body wedges every other account's news
    # fetch for the script's own 120s steal window. `Runner.run`'s 300s
    # default is a value nobody chose for this call.
    assert [call.timeout for call in runner.calls] == [NEWS_FETCH_TIMEOUT]
    assert NEWS_FETCH_TIMEOUT != 300.0
    assert digest == "**日报日期：** 2026-08-20"


def _news_script_ceiling(source: str | None = None) -> float:
    """`news-fetch.sh`'s own worst case, DERIVED from the script at test time.

    Two numbers, both read out of the script so this stays true when the
    script moves:

      * `_lock`'s spinlock cap -- `(( waited > N )) && return 1` with one
        `sleep 1` per iteration (`news-fetch.sh:70,74`), so N seconds of
        waiting before the lock is either acquired or given up on.
      * the download bound -- `NEWS_TIMEOUT`'s default, passed to
        `curl --max-time` (`news-fetch.sh:42,88`).

    They ADD rather than alternate on the reachable path: the cap only ends
    the WAIT, so a lock released at second N is followed by a full download.
    The jq render and the `mv` sit on top of both and are not modelled --
    which is why the assertion below is a strict `>` with room, not `>=`.

    Both numbers are read out of the EXECUTABLE view through
    `_the_code_match` (§14). A bare `re.search` over raw source took the
    first textual match, so commenting out the original `NEWS_TIMEOUT` line
    above a raised real one left this green with the script's true ceiling at
    320s against a 180s bound.

    What this models is the `:-N` DEFAULT, not the effective value of
    `NEWS_TIMEOUT` at the `curl`. The two agree only while the script assigns
    the variable ONCE, so the count is guarded first and the value is read
    out of the assignment that guard found -- one read, not two.

    The guard counts `NEWS_TIMEOUT=` in ANY shape, and that width is the
    whole point. Keying it on the `${NEWS_TIMEOUT:-N}` form caught
    `${NEWS_TIMEOUT:-200}` above `${NEWS_TIMEOUT:-45}` (two matches, refused
    by name) while a plain `NEWS_TIMEOUT=200` under the real line was neither
    seen nor refused: this returned 165 while the script's own ceiling was
    120 + 200 = 320s against a 180s bound. That is the F6 condition -- the
    Python timeout fires first, SIGKILLs bash, the `EXIT` trap never runs and
    the lock is orphaned -- reintroduced by a narrow regex, with the whole
    suite green. Measured in bash (`NEWS_TIMEOUT="${NEWS_TIMEOUT:-45}"` then
    `NEWS_TIMEOUT=200` leaves 200), not reasoned about.

    Two things are still NOT modelled, and a static read cannot model either.
    The env-var override: a caller who exports `NEWS_TIMEOUT` has left the
    budget this constant was derived against and nothing in the script says
    so. And reachability: an assignment inside a branch still counts as an
    assignment, so a second one is REFUSED rather than analysed. Refusing is
    the point -- once there are two, no static reader can say which one the
    `curl` sees, and a first-match reader and a last-match reader disagree
    while both sound certain.
    """
    view = _executable(NEWS_FETCH_SH.read_text(encoding="utf-8") if source is None else source)
    lock_wait = _the_code_match(view, r"\(\( waited > (\d+) \)\) && return 1", "the spinlock cap")
    assignment = _the_code_match(view, r"(?<![\w$])NEWS_TIMEOUT=\S*", "a NEWS_TIMEOUT assignment")
    default = re.fullmatch(r'NEWS_TIMEOUT="\$\{NEWS_TIMEOUT:-(\d+)\}"', assignment.group(0))
    assert default is not None, (
        f"the one NEWS_TIMEOUT assignment is {assignment.group(0)!r}, not the "
        "`${NEWS_TIMEOUT:-N}` form this models"
    )
    return float(lock_wait.group(1)) + float(default.group(1))


def test_the_news_fetch_timeout_clears_the_scripts_own_ceiling() -> None:
    """Firing this timeout is strictly worse than waiting for the script.

    `SubprocessRunner` enforces a timeout with SIGKILL; SIGKILL does not run
    `news-fetch.sh`'s `trap ... EXIT`; that trap is the only thing that
    removes `$STATE_DIR/news_fetch.lock` (`news-fetch.sh:83,86`). So a
    timeout that fires ORPHANS the very lock the constant exists to respect,
    and every later account of the round spins on it until `_lock`'s 120s
    steal window expires. This repo has lost whole rounds to orphaned locks
    before (CLAUDE.md, and the `dream_lock_<name>` SIGPIPE case).

    The pin is on the RELATIONSHIP, not on the literal: 90 -- the previous
    value -- was derived from the 45s download alone and looked defensible
    against any literal-valued assertion, while being reachable by any
    account that waited ~50s for the lock and then fetched slowly. A test
    that asserted `== 90.0` would have agreed with it.
    """
    ceiling = _news_script_ceiling()
    assert ceiling == 165.0  # 120s spinlock + 45s curl, as the script stands today
    assert ceiling < NEWS_FETCH_TIMEOUT


def test_news_digest_survives_a_news_fetch_that_raises(tmp_path: Path) -> None:
    """R27's "failure to fetch must be non-fatal", in its raising shape.

    The previous day's digest is still real news, which is exactly why
    `news-fetch.sh` keeps a cache in the first place."""
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / NEWS_FETCH_SCRIPT).write_text("#!/bin/sh\n", encoding="utf-8")
    _agent_root_with_news(tmp_path, "昨天的日报\n")
    runner = ExplodingRunner()

    assert read_news_digest(tmp_path, runner) == "昨天的日报"
    assert runner.calls == 1


def test_news_digest_falls_back_to_the_placeholder_with_no_cache(
    tmp_path: Path,
) -> None:
    """swil.sh:361's `cat ... || echo <placeholder>` -- a cache that is not
    there at all reads as unavailable, it does not raise."""
    assert read_news_digest(tmp_path, RecordingRunner()) == WORLD_CONTEXT_UNAVAILABLE


def test_news_digest_falls_back_to_the_placeholder_for_a_blank_cache(
    tmp_path: Path,
) -> None:
    """`[[ -z "${NEWS_HEADLINES//[[:space:]]/}" ]]` (swil.sh:362) -- a cache
    of nothing but whitespace is the same as no cache."""
    _agent_root_with_news(tmp_path, "   \n\n")
    assert read_news_digest(tmp_path, RecordingRunner()) == WORLD_CONTEXT_UNAVAILABLE


def test_news_digest_falls_back_to_the_placeholder_for_undecodable_bytes(
    tmp_path: Path,
) -> None:
    """`UnicodeDecodeError` is a `ValueError`, so `except OSError` does not
    catch it -- the trap `locks.py:69-73` documents by name. The news cache is
    SHARED state written by `news-fetch.sh`, so one truncated multi-byte write
    escaped this function and cost every account in the round its cycle, while
    every sibling degradation here (missing script, failed subprocess, missing
    file, blank file) fails open."""
    (tmp_path / "context").mkdir(parents=True, exist_ok=True)
    (tmp_path / "context" / NEWS_CACHE_FILENAME).write_bytes(b"\xe4\xbb\x8a\xe6\x97")

    assert read_news_digest(tmp_path, RecordingRunner()) == WORLD_CONTEXT_UNAVAILABLE


def test_a_news_failure_leaves_the_whole_now_context_intact(tmp_path: Path) -> None:
    """The round-level statement of (e): every other channel still renders."""
    world = FakeWorld()
    world.global_feeds[15] = [_post("a" * 24, display="甲")]

    text = render_now_context(
        username="zenith",
        now=NOW_A,
        activity=platform_activity(world, _persona("zenith"), now=NOW_A),
        news=read_news_digest(tmp_path, ExplodingRunner()),
    )

    assert "**今日日期：** 2026年08月20日 07:42" in text
    assert "**当前 Agent：** zenith" in text
    assert f"- [{'a' * 24}] 甲" in text
    assert WORLD_CONTEXT_UNAVAILABLE in text


# ── the cli seam: fresh render, never the stale file ──────────────────────


def _cli_settings(tmp_path: Path) -> Settings:
    return Settings(agent_root=tmp_path, swil_url="https://example.test")


def test_cli_context_now_ignores_a_stale_now_md_on_disk(tmp_path: Path) -> None:
    """The defect itself, at the seam that had it.

    A `now.md` is planted with the frozen header the roster was actually
    served. `_context_now_for` must not carry a byte of it.
    """
    (tmp_path / "context").mkdir()
    (tmp_path / "context" / "now.md").write_text(
        "# 当前时间上下文\n\n**今日日期：** 2026年08月19日 05:30\n"
        "**当前 Agent：** qiusai\nSTALE-MARKER\n",
        encoding="utf-8",
    )
    world = FakeWorld()
    world.global_feeds[15] = [_post("a" * 24)]

    text = cli._context_now_for(
        world,
        _persona("zenith"),
        _cli_settings(tmp_path),
        now=NOW_A,
        runner=RecordingRunner(),
    )

    assert "STALE-MARKER" not in text
    assert "qiusai" not in text
    assert "**今日日期：** 2026年08月20日 07:42" in text


def test_cli_context_now_reads_the_news_cache_under_the_configured_agent_root(
    tmp_path: Path,
) -> None:
    """`settings.agent_root`, not the process's working directory.

    The distinction is invisible in most tests and dangerous exactly here:
    the real `agent/` IS the cwd when the suite runs, and it carries a real
    `scripts/news-fetch.sh` and a real `context/news_today.md`. A renderer
    rooted at `Path.cwd()` therefore produces perfectly plausible news --
    from the developer's own machine -- and every assertion that merely
    checked "the digest is in there" passes. So the cache planted here
    carries a marker no real digest could contain, and the assertion is on
    the marker.
    """
    _agent_root_with_news(tmp_path, "NEWS-MARKER-8814\n")
    world = FakeWorld()

    text = cli._context_now_for(
        world,
        _persona("zenith"),
        _cli_settings(tmp_path),
        now=NOW_A,
        runner=RecordingRunner(),
    )

    assert "NEWS-MARKER-8814" in text


def test_cli_context_now_names_the_calling_account_not_a_shared_file(
    tmp_path: Path,
) -> None:
    """Two accounts, one process, through the CLI seam -- R26's race, gone
    because there is no shared file left to race on."""
    world = FakeWorld()
    settings = _cli_settings(tmp_path)
    runner = RecordingRunner()

    first = cli._context_now_for(world, _persona("zenith"), settings, now=NOW_A, runner=runner)
    second = cli._context_now_for(world, _persona("liushang"), settings, now=NOW_A, runner=runner)

    assert "**当前 Agent：** zenith" in first
    assert "**当前 Agent：** liushang" in second


def test_cli_context_now_writes_no_file(tmp_path: Path) -> None:
    """R26: render in memory, write nothing. `context/now.md` stays a
    Bash-only artifact, so the rollback path (`SWIL_RUNTIME=bash`) keeps
    working and nothing races on it."""
    world = FakeWorld()
    cli._context_now_for(
        world,
        _persona("zenith"),
        _cli_settings(tmp_path),
        now=NOW_A,
        runner=RecordingRunner(),
    )
    assert not (tmp_path / "context" / "now.md").exists()


def test_cli_feed_context_uses_the_username_bullet_not_the_directory_name(
    tmp_path: Path,
) -> None:
    """The folder name and the `Username` bullet differ on this roster
    (CLAUDE.md's own note on the codex silent-fail investigation), so the
    fixture makes them differ here too -- otherwise reading the wrong one is
    undetectable (STANDING-CONSTRAINTS §4).

    The topic list is what the search is keyed on, and it comes from THIS
    persona.
    """
    world = FakeWorld()
    world.searches = {"alpha": [_post("a" * 24)]}
    persona = _persona("shengyin", topics=["alpha"], directory=tmp_path / "agents" / "sketch")

    text = cli._feed_context_for(world, persona, now=NOW_A)

    assert world.search_calls == [("alpha", 12)]
    assert "## #alpha" in text


def test_cli_feed_context_ignores_a_stale_feed_file_on_disk(tmp_path: Path) -> None:
    """The other half of the same defect: `feed_for_<username>.md` was being
    read from disk, and the newest one on the roster was 12 hours old with
    several dating from three days earlier."""
    (tmp_path / "context").mkdir()
    (tmp_path / "context" / "feed_for_zenith.md").write_text(
        "# 关联话题动态 (2026-08-19 00:41)\nSTALE-MARKER\n", encoding="utf-8"
    )
    world = FakeWorld()
    world.searches = {"alpha": [_post("a" * 24)]}

    text = cli._feed_context_for(world, _persona("zenith", topics=["alpha"]), now=NOW_A)

    assert "STALE-MARKER" not in text
    assert "# 关联话题动态 (2026-08-20 07:42)" in text
