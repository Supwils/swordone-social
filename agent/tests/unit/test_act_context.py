from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest

from swil_agent.act.context import (
    _within_era,
    build_context,
    engaged_post_ids,
    format_conversations,
    format_global_feed,
    format_notifications,
    format_thread,
    format_timeline_feed,
    last_post_line,
    posts_today,
    select_thread_targets,
)
from swil_agent.api.client import ApiError
from swil_agent.models import Persona

from ._runners import make_persona

NOW = datetime(2026, 8, 17, 10, 0, 0)

MEMORY = """\
2026-08-16 | post | id=aaaaaaaaaaaaaaaaaaaaaaaa | hello
2026-08-17 | post | id=bbbbbbbbbbbbbbbbbbbbbbbb | today one
2026-08-17 | like | postId=cccccccccccccccccccccccc
2026-08-17 | comment | postId=dddddddddddddddddddddddd commentId=eeeeeeeeeeeeeeeeeeeeeeee | hi
2026-08-17 | follow | @someone
"""


def _persona(backend: str = "claude") -> Persona:
    return make_persona(backend=backend)


# ── memory-derived fields (contract 01 §2e/§2f) ─────────────────────────────


def test_posts_today_counts_only_todays_post_lines() -> None:
    assert posts_today(MEMORY, "2026-08-17") == 1
    assert posts_today(MEMORY, "2026-08-16") == 1
    assert posts_today(MEMORY, "2026-08-18") == 0


def test_engaged_post_ids_takes_like_and_comment_only() -> None:
    assert engaged_post_ids(MEMORY) == "cccccccccccccccccccccccc,dddddddddddddddddddddddd"


def test_engaged_post_ids_ignores_post_and_follow_lines() -> None:
    # `post` lines carry `id=`, not `postId=`, and must never be treated as engagement.
    assert "aaaaaaaaaaaaaaaaaaaaaaaa" not in engaged_post_ids(MEMORY)
    assert "bbbbbbbbbbbbbbbbbbbbbbbb" not in engaged_post_ids(MEMORY)


def test_engaged_post_ids_is_empty_without_matches() -> None:
    assert engaged_post_ids("2026-08-17 | follow | @x\n") == ""


def test_last_post_line_returns_the_last_post_entry() -> None:
    assert last_post_line(MEMORY).endswith("today one")


def test_last_post_line_falls_back_when_there_are_no_posts() -> None:
    assert last_post_line("2026-08-17 | like | postId=x\n") == "(暂无发帖记录)"


# ── feed formatters (contract 01 §2g/§2h) ───────────────────────────────────

ITEM = {
    "id": "aaaaaaaaaaaaaaaaaaaaaaaa",
    "author": {"username": "zenith", "displayName": "玄思"},
    "createdAt": "2026-08-17T10:00:00Z",
    "likeCount": 3,
    "commentCount": 2,
    "text": "x" * 300,
}


def test_global_feed_line_shape_and_220_char_cap() -> None:
    line = format_global_feed([ITEM])
    assert line.startswith("postId:aaaaaaaaaaaaaaaaaaaaaaaa | @zenith（2026-08-17）♥3 💬2: ")
    assert line.endswith("x" * 220)
    assert "x" * 221 not in line


def test_timeline_feed_line_shape_and_140_char_cap() -> None:
    line = format_timeline_feed([ITEM])
    assert line.startswith("postId:aaaaaaaaaaaaaaaaaaaaaaaa | @zenith（2026-08-17）: ")
    assert line.count("x") == 140


def test_feed_formatters_flatten_newlines_to_spaces() -> None:
    item = {**ITEM, "text": "a\nb"}
    assert "a b" in format_global_feed([item])


# ── notifications (contract 01 §2j) ───────────────────────────────────────

NOTIFICATION = {
    "id": "notif0000000000000000000",
    "type": "comment",
    "actor": {"username": "vex", "displayName": "Vex"},
    "post": {"id": "post00000000000000000000", "textPreview": "p" * 80},
    "comment": {"id": "cmnt00000000000000000000", "textPreview": "c" * 80},
}


def test_notification_line_uses_the_post_id_not_the_notification_id() -> None:
    r"""Matches `auto-run.sh:580`'s own `\(.post.id)` -- this is parity, not a
    divergence. `NotificationDTO.id` and `.post.id` are different values
    (`server/src/lib/dto.ts:316-320`) and Bash reads the second one too."""
    line = format_notifications([NOTIFICATION])
    assert "postId:post00000000000000000000" in line
    assert "notif0000000000000000000" not in line


def test_notification_line_truncates_previews_to_50_chars() -> None:
    line = format_notifications([NOTIFICATION])
    assert "「" + "p" * 50 + "」" in line
    assert "「" + "c" * 50 + "」" in line


def test_notification_line_omits_absent_post_and_comment_blocks() -> None:
    line = format_notifications(
        [{"type": "follow", "actor": {"username": "v", "displayName": "V"}}]
    )
    assert line == "- [follow] @v（V）"


# ── thread selection (contract 01 §2i) ──────────────────────────────────────


def test_thread_targets_skips_engaged_and_takes_top_three_by_comment_count() -> None:
    items = [
        {"id": "a" * 24, "commentCount": 9},
        {"id": "b" * 24, "commentCount": 5},
        {"id": "c" * 24, "commentCount": 7},
        {"id": "d" * 24, "commentCount": 1},
        {"id": "e" * 24, "commentCount": 3},
    ]
    # engaged = "c"*24 -> c is dropped even though its commentCount (7) would
    # otherwise place it second; remaining candidates sorted desc by
    # commentCount are a(9), b(5), e(3) -- the top three of those.
    assert select_thread_targets(items, engaged="c" * 24) == ["a" * 24, "b" * 24, "e" * 24]


def test_thread_targets_requires_at_least_two_comments() -> None:
    assert select_thread_targets([{"id": "a" * 24, "commentCount": 1}], engaged="") == []


def test_thread_targets_includes_the_exact_boundary_of_two_comments() -> None:
    """Fix round 1, finding 4: `commentCount == 2` was never exercised by any
    fixture -- mutating `_THREAD_MIN_COMMENTS` from 2 to 3 left every
    existing test green. This pins the boundary itself: exactly 2 comments
    must be included (>=, not >)."""
    assert select_thread_targets([{"id": "a" * 24, "commentCount": 2}], engaged="") == ["a" * 24]


def test_format_thread_renders_post_header_as_pretty_printed_json() -> None:
    """Ruling R13 (fix round 1): `swil.sh thread` does not render a
    human-readable summary line for the post -- it pretty-prints the jq
    object verbatim (agent/scripts/swil.sh:558):
    `jq '.data.post | {id, author: .author.username, text, likeCount,
    commentCount, echoCount, createdAt}'`. `json.dumps(obj,
    ensure_ascii=False, indent=2)` was verified against a real `jq`
    invocation on an equivalent object to produce this exact byte sequence
    -- this pins that string literally, not a paraphrase of its shape."""
    post = {
        "id": "p" * 24,
        "author": {"username": "zenith"},
        "createdAt": "2026-08-17T10:00:00Z",
        "likeCount": 5,
        "commentCount": 1,
        "echoCount": 2,
        "text": "line one\nline two",
    }
    rendered = format_thread(post, [])
    expected_json = (
        "{\n"
        f'  "id": "{"p" * 24}",\n'
        '  "author": "zenith",\n'
        '  "text": "line one\\nline two",\n'
        '  "likeCount": 5,\n'
        '  "commentCount": 1,\n'
        '  "echoCount": 2,\n'
        '  "createdAt": "2026-08-17T10:00:00Z"\n'
        "}"
    )
    assert rendered == f"=== POST {'p' * 24} ===\n{expected_json}\n=== COMMENTS (up to 6) ===\n"


def test_format_thread_post_json_uses_null_for_missing_fields_like_jq_does() -> None:
    """jq's `{likeCount}` shorthand on an object missing that key evaluates
    to `null`, not `0` -- `.get()` must not silently supply a default the
    real jq pipeline never would, or the model sees a fabricated zero where
    Bash would have shown `null`."""
    post = {"id": "p" * 24}
    rendered = format_thread(post, [])
    assert '"author": null' in rendered
    assert '"text": null' in rendered
    assert '"likeCount": null' in rendered
    assert '"commentCount": null' in rendered
    assert '"echoCount": null' in rendered
    assert '"createdAt": null' in rendered


def test_format_thread_comments_section_is_untruncated() -> None:
    post = {
        "id": "p" * 24,
        "author": {"username": "zenith"},
        "createdAt": "2026-08-17T00:00:00Z",
        "likeCount": 5,
        "commentCount": 1,
        "echoCount": 0,
        "text": "the post body",
    }
    comments = [
        {
            "id": "c" * 24,
            "author": {"username": "vex"},
            "createdAt": "2026-08-17T00:00:00Z",
            "likeCount": 1,
            "text": "y" * 500,
        }
    ]
    rendered = format_thread(post, comments)
    assert "=== COMMENTS (up to 6) ===" in rendered
    assert "y" * 500 in rendered  # not truncated, unlike the feed formatters


def test_format_thread_marks_replies_with_parent_id() -> None:
    post = {"id": "p" * 24, "author": {"username": "z"}, "createdAt": "2026-08-17"}
    comments = [
        {
            "id": "c" * 24,
            "author": {"username": "vex"},
            "createdAt": "2026-08-17",
            "parentId": "r" * 24,
            "text": "a reply",
        }
    ]
    rendered = format_thread(post, comments)
    assert f"↩reply→{'r' * 24}" in rendered


# ── conversations (contract 01 §2k) ─────────────────────────────────────────


def test_format_conversations_line_shape() -> None:
    """Pinned against `swil.sh dms`'s actual jq (agent/scripts/swil.sh:717-721):
    the unread marker appears only when unread, but the preview label is
    always preceded by two spaces, not one, regardless of the marker."""
    items = [
        {
            "id": "conv1",
            "participants": [{"username": "ada"}, {"username": "bob"}],
            "unread": True,
            "lastMessage": {"text": "z" * 100},
        }
    ]
    line = format_conversations(items)
    assert line.startswith("[conv1] @ada,bob ●未读  最近：")
    assert line.endswith("z" * 60)
    assert "z" * 61 not in line


def test_format_conversations_omits_unread_marker_when_read() -> None:
    items = [{"id": "conv1", "participants": [], "unread": False, "lastMessage": {"text": "hi"}}]
    line = format_conversations(items)
    assert line == "[conv1] @  最近：hi"


def test_format_conversations_falls_back_to_placeholder_without_a_last_message() -> None:
    """`swil.sh dms` uses jq's `//` fallback to a fixed placeholder string
    (`_NO_LAST_MESSAGE`) when there is no last message at all, not an empty
    string."""
    items = [{"id": "conv1", "participants": [], "unread": False, "lastMessage": None}]
    line = format_conversations(items)
    assert line.endswith("最近：（空）")


def test_format_conversations_does_not_fall_back_on_a_real_empty_string() -> None:
    """Fix round 1, finding 4: jq's `//` only substitutes on null/false,
    never on an empty string. jq's own fallback expression leaves a literal
    empty string exactly as it is -- the preview label with nothing after
    it -- and a Python `or`-based fallback (which treats `""` as falsy)
    would wrongly render the placeholder instead."""
    items = [{"id": "conv1", "participants": [], "unread": False, "lastMessage": {"text": ""}}]
    line = format_conversations(items)
    assert line == "[conv1] @  最近："


# ── build_context degradation (contract 01 §4 — the asymmetry) ─────────────


class FakeResources:
    """Duck-types `Resources`' read surface; any method can be told to raise."""

    def __init__(self) -> None:
        self._fail: set[str] = set()
        self._fail_posts: set[str] = set()
        self.recommended: list[dict[str, Any]] = []
        self.latest: list[dict[str, Any]] = []
        self.notification_items: list[dict[str, Any]] = []
        self.contacts_result: list[str] = []
        self.conversation_items: list[dict[str, Any]] = []
        self.posts: dict[str, dict[str, Any]] = {}
        self.comments: dict[str, list[dict[str, Any]]] = {}
        # Recorded so a test can pin which feeds a round read, and with what `since`.
        self.board_feeds: dict[str, list[dict[str, Any]]] = {}
        self.board_lookup: dict[str, str] = {}
        self.feed_global_calls: list[tuple[int, str, str | None]] = []
        self.feed_board_calls: list[tuple[str, int, str, str | None]] = []
        self.get_boards_calls = 0

    def fail(self, name: str) -> None:
        self._fail.add(name)

    def fail_post(self, post_id: str) -> None:
        self._fail_posts.add(post_id)

    def feed_global(self, limit: int, sort: str, since: str | None = None) -> list[dict[str, Any]]:
        self.feed_global_calls.append((limit, sort, since))
        if f"feed_global_{sort}" in self._fail:
            raise ApiError(500, "boom", None)
        return self.recommended if sort == "recommended" else self.latest

    def feed_board(
        self, slug: str, limit: int = 12, sort: str = "latest", since: str | None = None
    ) -> list[dict[str, Any]]:
        self.feed_board_calls.append((slug, limit, sort, since))
        if f"feed_board_{slug}" in self._fail:
            raise ApiError(500, "boom", None)
        return self.board_feeds.get(slug, [])

    def get_boards(self) -> dict[str, str]:
        self.get_boards_calls += 1
        if "get_boards" in self._fail:
            raise ApiError(500, "boom", None)
        return dict(self.board_lookup)

    def notifications(self, limit: int, unread_only: bool = True) -> list[dict[str, Any]]:
        if "notifications" in self._fail:
            raise ApiError(500, "boom", None)
        return self.notification_items

    def get_post(self, post_id: str) -> dict[str, Any]:
        if post_id in self._fail_posts:
            raise ApiError(500, "boom", None)
        return self.posts.get(post_id, {"id": post_id})

    def get_comments(self, post_id: str, limit: int = 6) -> list[dict[str, Any]]:
        if post_id in self._fail_posts:
            raise ApiError(500, "boom", None)
        return self.comments.get(post_id, [])

    def contacts(self) -> list[str]:
        if "contacts" in self._fail:
            raise ApiError(500, "boom", None)
        return self.contacts_result

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        if "conversations" in self._fail:
            raise ApiError(500, "boom", None)
        return self.conversation_items


@pytest.fixture
def fake_resources() -> FakeResources:
    return FakeResources()


def test_a_failed_timeline_fetch_leaves_the_field_empty(fake_resources: FakeResources) -> None:
    fake_resources.fail("feed_global_latest")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5)
    assert ctx.timeline_feed == ""


def test_a_failed_recommended_fetch_still_renders_a_placeholder(
    fake_resources: FakeResources,
) -> None:
    fake_resources.fail("feed_global_recommended")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5)
    assert ctx.global_feed == "(could not fetch feed)"


def test_a_failed_notifications_fetch_still_renders_a_placeholder(
    fake_resources: FakeResources,
) -> None:
    fake_resources.fail("notifications")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5)
    assert ctx.notification_context == "（暂无新互动）"


def test_a_failed_contacts_fetch_empties_both_the_text_and_the_list(
    fake_resources: FakeResources,
) -> None:
    fake_resources.fail("contacts")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5)
    assert ctx.contacts_list == ""
    assert ctx.contacts == []


def test_a_failed_conversations_fetch_leaves_dm_context_empty(
    fake_resources: FakeResources,
) -> None:
    """Fix round 1, finding 3: `dm_context` is the one vanish-class field that
    had no failure-path test at all -- the reviewer deleted the
    `contextlib.suppress(ApiError)` guard around its assignment in
    `build_context` and the full suite still passed, because that guard has
    no `except` line for coverage to demand and nothing exercised the
    failure path. This closes that gap; see the report's mutation proof for
    the guard-deletion reproduction."""
    fake_resources.fail("conversations")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5)
    assert ctx.dm_context == ""


def test_one_failing_thread_does_not_drop_the_others(fake_resources: FakeResources) -> None:
    fake_resources.recommended = [
        {
            "id": "aaaaaaaaaaaaaaaaaaaaaaaa",
            "commentCount": 5,
            "author": {"username": "a"},
            "createdAt": "2026-08-17T00:00:00Z",
            "likeCount": 1,
            "text": "post a",
        },
        {
            "id": "bbbbbbbbbbbbbbbbbbbbbbbb",
            "commentCount": 3,
            "author": {"username": "b"},
            "createdAt": "2026-08-17T00:00:00Z",
            "likeCount": 1,
            "text": "post b",
        },
    ]
    fake_resources.fail_post("bbbbbbbbbbbbbbbbbbbbbbbb")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5)
    assert "aaaaaaaaaaaaaaaaaaaaaaaa" in ctx.thread_context
    assert "bbbbbbbbbbbbbbbbbbbbbbbb" not in ctx.thread_context


# The tests above prove failure degrades correctly, but a `timeline_feed == ""`
# assertion is also what an implementation that never sets the field at all
# would produce -- vacuously. This test proves the success path is real: it
# is the same fixture family with nothing failed, and every block that the
# tests above show *vanishing* or *falling back* on failure is asserted to
# carry real, distinguishable content when the underlying call succeeds. If
# `build_context` stopped assigning to (say) `ctx.timeline_feed` entirely,
# this test would fail (empty string) even though every degradation test
# above would still pass.
def test_build_context_populates_every_block_on_success(fake_resources: FakeResources) -> None:
    fake_resources.recommended = [
        {
            "id": "aaaaaaaaaaaaaaaaaaaaaaaa",
            "commentCount": 5,
            "author": {"username": "a"},
            "createdAt": "2026-08-17T00:00:00Z",
            "likeCount": 1,
            "text": "recommended post",
        }
    ]
    fake_resources.latest = [
        {
            "id": "llllllllllllllllllllllll",
            "author": {"username": "l"},
            "createdAt": "2026-08-17T00:00:00Z",
            "text": "latest post",
        }
    ]
    fake_resources.notification_items = [
        {
            "type": "like",
            "actor": {"username": "v", "displayName": "V"},
            "post": {"id": "pppppppppppppppppppppppp", "textPreview": "hi"},
        }
    ]
    fake_resources.contacts_result = ["bob", "carl"]
    fake_resources.conversation_items = [
        {
            "id": "conv1",
            "participants": [{"username": "bob"}],
            "unread": True,
            "lastMessage": {"text": "hey"},
        }
    ]

    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5)
    assert "recommended post" in ctx.global_feed
    assert "latest post" in ctx.timeline_feed
    assert "pppppppppppppppppppppppp" in ctx.notification_context
    assert "aaaaaaaaaaaaaaaaaaaaaaaa" in ctx.thread_context
    assert ctx.contacts == ["bob", "carl"]
    assert ctx.contacts_list == "bob\ncarl"
    assert "hey" in ctx.dm_context


def test_build_context_passes_through_context_now_and_feed_context(
    fake_resources: FakeResources,
) -> None:
    """`context_now`/`feed_context` are RENDERED by the caller (`cli.py`, via
    `render_now_context` / `render_follow_topics_feed`); this function must
    pass them through untouched rather than re-deriving or dropping them.

    They were files `swil.sh login` wrote until 2026-08-20, when the runtime
    stopped reading a `now.md` nothing had refreshed since the Stage-5
    cutover. The seam this test pins is the same either way."""
    ctx = build_context(
        fake_resources,
        _persona(),
        memory_text="",
        now=NOW,
        budget=5,
        context_now="今日上下文",
        feed_context="关注话题动态",
    )
    assert ctx.context_now == "今日上下文"
    assert ctx.feed_context == "关注话题动态"


def test_build_context_derives_rhythm_fields_from_memory(fake_resources: FakeResources) -> None:
    ctx = build_context(fake_resources, _persona(), memory_text=MEMORY, now=NOW, budget=5)
    assert ctx.today == "2026-08-17"
    assert ctx.today_post_count == 1
    assert ctx.last_post.endswith("today one")
    assert ctx.engaged_ids == "cccccccccccccccccccccccc,dddddddddddddddddddddddd"
    assert ctx.action_budget == 5


def test_build_context_leaves_backend_action_constraint_empty_for_every_backend(
    fake_resources: FakeResources,
) -> None:
    """Loop-engine spec §7: the Codex post-only prompt is gone. Write-verification
    is the real fix; `ActContext.backend_action_constraint` is always `""`.
    """
    for backend in ("codex", "claude", "deepseek"):
        ctx = build_context(fake_resources, _persona(backend), memory_text="", now=NOW, budget=5)
        assert ctx.backend_action_constraint == ""


# ── read scope: home board (now-context) + global feed, for everyone ─────


ERA = datetime(2026, 10, 15, 0, 0, 0, tzinfo=UTC)


def _post(post_id: str, created_at: str, *, comments: int = 0) -> dict[str, Any]:
    return {
        "id": post_id,
        "author": {"username": "a"},
        "createdAt": created_at,
        "likeCount": 0,
        "commentCount": comments,
        "text": f"text {post_id}",
    }


OLD = _post("o" * 24, "2026-10-14T23:59:59.000Z", comments=9)
NEW = _post("n" * 24, "2026-10-15T00:00:01.000Z", comments=3)


def test_both_feed_passes_read_the_global_feed_and_never_a_board(
    fake_resources: FakeResources,
) -> None:
    persona = make_persona(board="market")
    build_context(fake_resources, persona, memory_text="", now=NOW, budget=5)
    assert fake_resources.feed_global_calls == [(40, "recommended", None), (18, "latest", None)]
    assert fake_resources.feed_board_calls == []
    assert fake_resources.get_boards_calls == 0


def test_no_since_is_sent_when_the_era_is_unset(fake_resources: FakeResources) -> None:
    build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5, era_start=None)
    assert [since for *_, since in fake_resources.feed_global_calls] == [None, None]


def test_every_feed_read_passes_since_when_the_era_is_set(
    fake_resources: FakeResources,
) -> None:
    build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5, era_start=ERA)
    assert [since for *_, since in fake_resources.feed_global_calls] == [
        ERA.isoformat(),
        ERA.isoformat(),
    ]


def test_items_older_than_the_era_are_dropped_client_side(
    fake_resources: FakeResources,
) -> None:
    fake_resources.recommended = [OLD, NEW]
    fake_resources.latest = [OLD, NEW]
    ctx = build_context(
        fake_resources, _persona(), memory_text="", now=NOW, budget=5, era_start=ERA
    )
    assert "n" * 24 in ctx.global_feed
    assert "o" * 24 not in ctx.global_feed
    assert "o" * 24 not in ctx.timeline_feed
    assert "n" * 24 in ctx.timeline_feed


def test_thread_targets_come_only_from_era_filtered_items(
    fake_resources: FakeResources,
) -> None:
    """The old post has more comments and would win the thread pick."""
    fake_resources.recommended = [OLD, NEW]
    ctx = build_context(
        fake_resources, _persona(), memory_text="", now=NOW, budget=5, era_start=ERA
    )
    assert "n" * 24 in ctx.thread_context
    assert "o" * 24 not in ctx.thread_context


def test_an_all_old_feed_falls_back_to_the_placeholder(fake_resources: FakeResources) -> None:
    fake_resources.recommended = [OLD]
    fake_resources.latest = [OLD]
    ctx = build_context(
        fake_resources, _persona(), memory_text="", now=NOW, budget=5, era_start=ERA
    )
    assert ctx.global_feed == "(could not fetch feed)"
    assert ctx.timeline_feed == ""
    assert ctx.thread_context == ""


def test_without_an_era_old_items_are_kept(fake_resources: FakeResources) -> None:
    fake_resources.recommended = [OLD, NEW]
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5)
    assert "o" * 24 in ctx.global_feed


# ── _within_era ──────────────────────────────────────────────────────────


def test_within_era_is_the_identity_without_an_era() -> None:
    items = [OLD, NEW, {"id": "x"}]
    assert _within_era(items, None) == items


def test_within_era_keeps_an_item_created_exactly_at_the_era_start() -> None:
    edge = _post("e" * 24, "2026-10-15T00:00:00.000Z")
    assert _within_era([edge], ERA) == [edge]


def test_within_era_drops_items_with_a_missing_or_unparseable_date() -> None:
    items = [{"id": "a"}, {"id": "b", "createdAt": "yesterday"}, {"id": "c", "createdAt": 5}]
    assert _within_era(items, ERA) == []


def test_within_era_treats_a_naive_era_start_as_utc() -> None:
    naive = datetime(2026, 10, 15, 0, 0, 0)
    assert _within_era([OLD, NEW], naive) == [NEW]


def test_within_era_compares_across_time_zones() -> None:
    """00:30 at +08:00 is 16:30 the previous day in UTC: before the era."""
    east = _post("t" * 24, "2026-10-15T00:30:00+08:00")
    assert _within_era([east], ERA) == []
    assert _within_era([east], ERA - timedelta(hours=8)) == [east]
    assert _within_era([east], datetime(2026, 10, 15, 0, 0, tzinfo=timezone(timedelta(hours=8))))


def test_within_era_treats_a_naive_created_at_as_utc() -> None:
    naive_item = _post("z" * 24, "2026-10-15T00:00:01")
    assert _within_era([naive_item], ERA) == [naive_item]
