"""World-context renderers: the now-context, the follow-topics feed and the news digest.

Properties pinned here:

  * FRESHNESS -- the date comes from an injected clock; two clocks give two
    answers, so a hardcoded date is visible.
  * PER-ACCOUNT -- two accounts rendered in one process name themselves; a
    module-level constant would pass a single-account test.
  * WORDING -- the rendered text is pinned as a literal.
"""

from __future__ import annotations

import importlib
import re
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

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

from ._runners import RecordingRunner, make_persona


def _cli() -> ModuleType:
    """`swil_agent.cli`, imported only by the tests that drive the CLI seam,
    so the renderer tests here do not depend on the whole CLI importing."""
    return importlib.import_module("swil_agent.cli")


AGENT_DIR = Path(__file__).resolve().parents[2]
NEWS_FETCH_SH = AGENT_DIR / "scripts" / NEWS_FETCH_SCRIPT

# Two clocks, deliberately different in every rendered component (day AND
# time-of-day AND day-of-year parity), so a renderer that hardcodes any part
# of either format string is visible.
NOW_A = datetime(2026, 8, 20, 7, 42)
NOW_B = datetime(2026, 3, 4, 19, 5)


# ── executable-text helpers for the news-fetch.sh ceiling pin ─────────────
#
# The ceiling test reads numbers out of `news-fetch.sh`. A comment must not
# satisfy an anchor, and a comment must not hide a real line; matches count
# only on executable text, and a second hit is refused rather than ignored.
# Comment-ness is tested per physical line before `\`-continuations are joined.


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
        self.since_calls: list[tuple[str, str | None]] = []
        self.boards_calls = 0
        self.failing: set[str] = set()

    def feed_global(self, limit: int, sort: str, since: str | None = None) -> list[dict[str, Any]]:
        self.global_calls.append((limit, sort))
        self.since_calls.append(("feed_global", since))
        if "feed_global" in self.failing:
            raise ApiError(500, "boom", None)
        return self.global_feeds.get(limit, [])

    def feed_board(
        self, slug: str, limit: int = 12, sort: str = "latest", since: str | None = None
    ) -> list[dict[str, Any]]:
        self.board_calls.append((slug, limit, sort))
        self.since_calls.append((f"feed_board:{slug}", since))
        if f"feed_board_{slug}" in self.failing:
            raise ApiError(500, "boom", None)
        return self.board_feeds.get(slug, [])

    def get_boards(self) -> dict[str, str]:
        self.boards_calls += 1
        if "get_boards" in self.failing:
            raise ApiError(500, "boom", None)
        return self.boards

    def search_posts(
        self, q: str, limit: int = 12, since: str | None = None
    ) -> list[dict[str, Any]]:
        self.search_calls.append((q, limit))
        self.since_calls.append(("search_posts", since))
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
    board: str = "",
    directory: Path | None = None,
) -> Persona:
    return make_persona(
        username=username,
        topics=topics or [],
        board=board,
        directory=directory or Path("/tmp") / username,
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
    parametrisation. The format is `%Y年%m月%d日 %H:%M`, zero-padded.
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


# ── (c) template wording ──────────────────────────────────────────────────


def test_now_context_renders_the_pinned_template() -> None:
    """The prompt wording is pinned as a literal: a dropped or reordered
    section, a changed URL line or a lost trailing newline fails here."""
    activity = "- [x] 甲（2026-08-18）：内容"
    news = "**日报日期：** 2026-08-19\n### [ai] 标题"

    assert render_now_context(username="zenith", now=NOW_A, activity=activity, news=news) == (
        "# 当前时间上下文\n\n"
        "**今日日期：** 2026年08月20日 07:42\n"
        "**当前 Agent：** zenith\n\n"
        "## 平台最新动态（用于校准时间感知）\n"
        f"{activity}\n\n"
        "## 今日真实世界新闻（swil-news 日报，含各话题要点与总结）\n"
        f"{news}\n\n"
        "（完整日报可访问：https://swil-news.vercel.app/api/news/{topic}/{date}）\n\n"
        "## 注意事项\n"
        "- 以上日期是系统真实时间，优先于模型自身的时间估计\n"
        '- 发帖时涉及"最近""今天""当前"等表述，请以此日期为准\n'
        "- 训练截止日之后的世界事件，如无用户提供的信息，请明确说明不确定性，不要臆造\n"
        "- 上面这些新闻是**真实世界当天发生的事**，不是虚构素材。你可以据此发帖、评论、\n"
        "  或完全忽略——取决于它是否落在你关心的领域里。引用时按你自己的视角解读，\n"
        "  不要复述标题，也不要为了蹭热点去谈一个你的人设根本不关心的话题。\n"
    )


def test_now_context_keeps_all_four_notice_bullets() -> None:
    """A cheaper, independently-readable statement of the wording pin above.

    The heredoc comparison above would also catch a dropped bullet, but only
    as "the two big strings differ". This names the thing.
    """
    text = render_now_context(username="zenith", now=NOW_A, activity="A", news="N")
    body = text.split("## 注意事项\n", 1)[1]
    assert len([line for line in body.splitlines() if line.startswith("- ")]) == 4


# ── (d) the follow-topics feed comes from the API ─────────────────────────


def test_follow_topics_feed_renders_the_pinned_wording() -> None:
    """The follow-topics feed text is pinned as a literal, in the persona's
    declared (unsorted) topic order; a topic with no results gets no heading."""
    world = FakeWorld()
    world.searches = {
        "zeta": [
            _post("a" * 24, username="one", display="第一", text="第一条\n换行"),
            _post("b" * 24, username="two", display="第二", text="第二条"),
        ],
        "alpha": [_post("c" * 24, username="three", display="第三", text="第三条")],
    }

    text = render_follow_topics_feed(
        world, _persona("zenith", topics=["zeta", "empty", "alpha"]), now=NOW_A
    )

    assert text == (
        "# 关联话题动态 (2026-08-20 07:42)\n\n"
        "## #zeta\n"
        f"- [{'a' * 24}] @one（第一）: 第一条 换行\n"
        f"- [{'b' * 24}] @two（第二）: 第二条\n\n"
        "## #alpha\n"
        f"- [{'c' * 24}] @three（第三）: 第三条\n\n"
    )


_DOUBLED: dict[str, tuple[Callable[[str], object], str]] = {
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
    """Topics are searched in the persona's declared order, never `sorted()`.

    The fixture's three topics are in an order no sort produces -- neither
    ascending nor descending -- so both directions are visible.
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


def test_a_topic_is_searched_exactly_as_the_frontmatter_lists_it() -> None:
    """Topics are a YAML list now; nothing reshapes them on the way to search."""
    world = FakeWorld()
    world.searches = {"AI 行业": [_post("a" * 24)]}

    text = render_follow_topics_feed(world, _persona("zenith", topics=["AI 行业"]), now=NOW_A)

    assert world.search_calls == [("AI 行业", 12)]
    assert "## #AI 行业" in text.splitlines()


def test_follow_topics_feed_skips_a_topic_that_returned_nothing() -> None:
    """An empty search contributes no heading at all, rather than an empty section."""
    world = FakeWorld()
    world.searches = {"beta": [_post("c" * 24)]}

    text = render_follow_topics_feed(world, _persona("zenith", topics=["alpha", "beta"]), now=NOW_A)

    assert "## #alpha" not in text
    assert "## #beta" in text


def test_follow_topics_feed_survives_a_failing_search() -> None:
    """One topic's search failing costs that topic's block, never the whole feed."""
    world = FakeWorld()
    world.failing.add("search_alpha")
    world.searches = {"beta": [_post("c" * 24)]}

    text = render_follow_topics_feed(world, _persona("zenith", topics=["alpha", "beta"]), now=NOW_A)

    assert "## #alpha" not in text
    assert "## #beta" in text


def test_persona_without_follow_topics_gets_the_empty_string() -> None:
    """No topics gives the empty string, not a dated header with no sections:
    an empty feed_context is what makes `render_planner_prompt` drop the
    平台时间线 heading entirely."""
    world = FakeWorld()
    assert render_follow_topics_feed(world, _persona("zenith"), now=NOW_A) == ""
    assert world.search_calls == []


def test_topic_feed_line_truncates_at_200_characters() -> None:
    """The topic feed caps at 200, unlike the 120 of the now-context feed, so a
    renderer that shared one constant between them is visible here."""
    line = format_topic_feed([_post("a" * 24, text="字" * 500)])
    assert line.endswith("字" * 200)
    assert "字" * 201 not in line


# ── the platform-activity block ───────────────────────────────────────────


def test_platform_activity_line_format_and_120_char_cap() -> None:
    """The id in square brackets, the author's DISPLAY name, the date in
    full-width parentheses, a full-width colon, and a 120-character body."""
    rendered = format_now_feed([_post("a" * 24, display="某人", text="字" * 500)])
    assert rendered == f"- [{'a' * 24}] 某人（2026-08-18）：{'字' * 120}"


def test_a_board_account_reads_only_its_home_board() -> None:
    """Era 3: the home board at `limit=12`; no cross-board window, no boards lookup."""
    world = FakeWorld()
    world.boards = {"living": "1", "market": "2"}
    world.board_feeds = {
        "living": [_post("a" * 24, display="甲")],
        "market": [_post("b" * 24, display="乙")],
    }

    text = platform_activity(world, _persona("zenith", board="living"), now=NOW_A)

    assert world.board_calls == [("living", 12, "latest")]
    assert world.global_calls == []
    assert world.boards_calls == 0
    assert text == f"- [{'a' * 24}] 甲（2026-08-18）：一句话"


def test_a_board_account_with_an_empty_board_falls_back_to_the_global_feed() -> None:
    world = FakeWorld()
    world.global_feeds[15] = [_post("a" * 24)]

    text = platform_activity(world, _persona("zenith", board="living"), now=NOW_A)

    assert world.global_calls == [(15, "latest")]
    assert text.startswith(f"- [{'a' * 24}]")


def test_a_failing_board_read_falls_back_to_the_global_feed() -> None:
    world = FakeWorld()
    world.failing.add("feed_board_living")
    world.global_feeds[15] = [_post("a" * 24)]

    text = platform_activity(world, _persona("zenith", board="living"), now=NOW_A)

    assert world.global_calls == [(15, "latest")]
    assert text.startswith(f"- [{'a' * 24}]")


def test_an_account_with_a_blank_board_uses_the_fallback() -> None:
    world = FakeWorld()
    world.global_feeds[15] = [_post("a" * 24)]

    platform_activity(world, _persona("zenith"), now=NOW_A)

    assert world.board_calls == []
    assert world.global_calls == [(15, "latest")]


def test_platform_activity_degrades_to_the_placeholder_when_every_read_fails() -> None:
    """Placeholder-class, never vanish-class: the heading stays and says so."""
    world = FakeWorld()
    world.failing.add("feed_global")
    assert platform_activity(world, _persona("zenith"), now=NOW_A) == WORLD_CONTEXT_UNAVAILABLE


# ── era isolation on the world-context reads ──────────────────────────────

ERA = datetime(2026, 8, 18, 9, 30, tzinfo=UTC)
OLD_POST = _post("o" * 24, display="旧", created="2026-08-18T09:00:00.000Z")
NEW_POST = _post("n" * 24, display="新", created="2026-08-18T10:00:00.000Z")


def test_platform_activity_passes_since_on_every_read_when_the_era_is_set() -> None:
    world = FakeWorld()
    platform_activity(world, _persona("zenith", board="living"), now=NOW_A, era_start=ERA)
    assert world.since_calls == [
        ("feed_board:living", ERA.isoformat()),
        ("feed_global", ERA.isoformat()),
    ]


def test_platform_activity_sends_no_since_without_an_era() -> None:
    world = FakeWorld()
    platform_activity(world, _persona("zenith", board="living"), now=NOW_A)
    assert world.since_calls == [("feed_board:living", None), ("feed_global", None)]


def test_platform_activity_drops_pre_era_posts() -> None:
    world = FakeWorld()
    world.board_feeds = {"living": [OLD_POST, NEW_POST]}

    text = platform_activity(world, _persona("zenith", board="living"), now=NOW_A, era_start=ERA)

    assert "o" * 24 not in text
    assert "n" * 24 in text


def test_an_all_pre_era_board_falls_back_to_the_era_filtered_global_feed() -> None:
    world = FakeWorld()
    world.board_feeds = {"living": [OLD_POST]}
    world.global_feeds[15] = [OLD_POST]

    text = platform_activity(world, _persona("zenith", board="living"), now=NOW_A, era_start=ERA)

    assert world.global_calls == [(15, "latest")]
    assert text == WORLD_CONTEXT_UNAVAILABLE


def test_the_topic_search_passes_since_and_drops_pre_era_posts() -> None:
    world = FakeWorld()
    world.searches = {"alpha": [OLD_POST, NEW_POST], "beta": [OLD_POST]}

    text = render_follow_topics_feed(
        world, _persona("zenith", topics=["alpha", "beta"]), now=NOW_A, era_start=ERA
    )

    assert world.since_calls == [("search_posts", ERA.isoformat())] * 2
    assert "o" * 24 not in text
    assert "n" * 24 in text
    assert "## #beta" not in text


def test_the_topic_search_sends_no_since_without_an_era() -> None:
    world = FakeWorld()
    render_follow_topics_feed(world, _persona("zenith", topics=["alpha"]), now=NOW_A)
    assert world.since_calls == [("search_posts", None)]


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
    """A cache that is not there at all reads as unavailable, it does not raise."""
    assert read_news_digest(tmp_path, RecordingRunner()) == WORLD_CONTEXT_UNAVAILABLE


def test_news_digest_falls_back_to_the_placeholder_for_a_blank_cache(
    tmp_path: Path,
) -> None:
    """A cache of nothing but whitespace is the same as no cache."""
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

    text = _cli()._context_now_for(
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

    text = _cli()._context_now_for(
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

    first = _cli()._context_now_for(world, _persona("zenith"), settings, now=NOW_A, runner=runner)
    second = _cli()._context_now_for(
        world, _persona("liushang"), settings, now=NOW_A, runner=runner
    )

    assert "**当前 Agent：** zenith" in first
    assert "**当前 Agent：** liushang" in second


def test_cli_context_now_writes_no_file(tmp_path: Path) -> None:
    """R26: render in memory, write nothing, so parallel rounds cannot race
    on a shared `context/now.md`."""
    world = FakeWorld()
    _cli()._context_now_for(
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

    text = _cli()._feed_context_for(world, persona, now=NOW_A)

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

    text = _cli()._feed_context_for(world, _persona("zenith", topics=["alpha"]), now=NOW_A)

    assert "STALE-MARKER" not in text
    assert "# 关联话题动态 (2026-08-20 07:42)" in text


def test_cli_feed_context_threads_the_era_start(tmp_path: Path) -> None:
    world = FakeWorld()
    _cli()._feed_context_for(world, _persona("zenith", topics=["alpha"]), now=NOW_A, era_start=ERA)
    assert world.since_calls == [("search_posts", ERA.isoformat())]


def test_cli_context_now_threads_the_configured_era_start(tmp_path: Path) -> None:
    world = FakeWorld()
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test", era_start=ERA)
    _cli()._context_now_for(
        world, _persona("zenith", board="living"), settings, now=NOW_A, runner=RecordingRunner()
    )
    assert world.since_calls[0] == ("feed_board:living", ERA.isoformat())
