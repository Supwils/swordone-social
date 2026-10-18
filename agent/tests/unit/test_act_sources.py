"""`ActContext.sources`: the rows each act-prompt block was rendered from
(spec 2026-10-17 ruling R4). Keeping them changes no fetch and no byte -- the
goldens prove that; this file pins what is kept."""

from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.act.context import (
    WORLD_CONTEXT_UNAVAILABLE,
    build_context,
    follow_topic_items,
    overlay_probe_posts,
    platform_activity,
    platform_activity_items,
    read_news_digest,
    read_world_context,
    render_follow_topics_feed,
    render_now_context,
)
from swil_agent.cli import compose
from swil_agent.graph.nodes_act import make_login_node
from swil_agent.models import ActSources, ThreadSource, strip_model_labels

from ._golden_seams import _patch_cycle_seams
from ._runners import (
    FakePersonaSource,
    FakeResources,
    RecordingRunner,
    make_cycle_deps,
    make_persona,
)

NOW = datetime(2026, 10, 15, 3, 30)


def _post(post_id: str, *, comments: int = 0) -> dict[str, Any]:
    return {
        "id": post_id,
        "text": f"text {post_id}",
        "createdAt": "2026-10-14T10:00:00.000Z",
        "author": {"username": f"u{post_id}", "displayName": f"U{post_id}"},
        "likeCount": 1,
        "commentCount": comments,
    }


def test_platform_activity_items_reads_the_home_board_first() -> None:
    resources = FakeResources()
    resources.board_feeds = {"ai": [_post("a")]}
    resources.latest = [_post("b")]
    assert [i["id"] for i in platform_activity_items(resources, make_persona())] == ["a"]


def test_platform_activity_items_falls_back_to_the_global_feed() -> None:
    resources = FakeResources()
    resources.latest = [_post("b")]
    assert [i["id"] for i in platform_activity_items(resources, make_persona())] == ["b"]


def test_both_activity_reads_failing_is_no_rows_and_the_placeholder() -> None:
    resources = FakeResources()
    resources.fail("feed_board_ai")
    resources.fail("feed_global_latest")
    assert platform_activity_items(resources, make_persona()) == []
    assert platform_activity(resources, make_persona(), now=NOW) == WORLD_CONTEXT_UNAVAILABLE


def test_follow_topic_items_keeps_topic_order_and_skips_failed_searches() -> None:
    resources = FakeResources()
    resources.search_results = {"a": [_post("1")], "c": [_post("3")]}
    resources.fail("search_b")
    found = follow_topic_items(resources, make_persona(topics=["a", "b", "c"]))
    assert [(topic, [i["id"] for i in items]) for topic, items in found] == [
        ("a", ["1"]),
        ("c", ["3"]),
    ]


def test_read_world_context_renders_what_the_two_old_renderers_rendered(tmp_path: Path) -> None:
    resources = FakeResources()
    resources.board_feeds = {"ai": [_post("a")]}
    resources.search_results = {"alpha": [_post("s")]}
    (tmp_path / "context").mkdir()
    (tmp_path / "context" / "news_today.md").write_text("今日新闻\n", encoding="utf-8")
    persona = make_persona(topics=["alpha", "beta"])

    world = read_world_context(
        resources, persona, now=NOW, era_start=None, agent_root=tmp_path, runner=RecordingRunner()
    )

    assert world.context_now == render_now_context(
        username=persona.username,
        now=NOW,
        activity=platform_activity(resources, persona, now=NOW),
        news=read_news_digest(tmp_path, RecordingRunner()),
    )
    assert world.feed_context == render_follow_topics_feed(resources, persona, now=NOW)
    assert [i["id"] for i in world.sources.board_posts] == ["a"]
    assert {t: [i["id"] for i in items] for t, items in world.sources.topic_posts.items()} == {
        "alpha": ["s"],
        "beta": [],
    }
    assert world.sources.news == "今日新闻"


def test_build_context_keeps_every_row_it_rendered() -> None:
    resources = FakeResources()
    root = _post("r", comments=3)
    resources.recommended = [root]
    resources.latest = [_post("t")]
    resources.notification_items = [{"id": "n1", "type": "like", "actor": {"username": "x"}}]
    resources.posts = {"r": root}
    resources.thread_comments = {"r": [{"id": "c1", "text": "hi", "author": {"username": "y"}}]}
    resources.conversation_items = [{"id": "dm1", "participants": [{"username": "z"}]}]
    world = ActSources(board_posts=[_post("b")], topic_posts={"AI": [_post("s")]}, news="N")

    ctx = build_context(resources, make_persona(), memory_text="", now=NOW, budget=5, world=world)

    sources = ctx.sources
    assert sources is not None
    assert [i["id"] for i in sources.board_posts] == ["b"]
    assert list(sources.topic_posts) == ["AI"]
    assert sources.news == "N"
    assert [i["id"] for i in sources.recommended] == ["r"]
    assert [i["id"] for i in sources.timeline] == ["t"]
    assert [n["id"] for n in sources.notifications] == ["n1"]
    assert sources.threads == [ThreadSource(post=root, comments=resources.thread_comments["r"])]
    assert [c["id"] for c in sources.conversations] == ["dm1"]
    assert world.recommended == []  # the caller's object is copied, never mutated


def test_build_context_without_a_world_still_keeps_its_own_reads() -> None:
    ctx = build_context(FakeResources(), make_persona(), memory_text="", now=NOW, budget=5)
    assert ctx.sources == ActSources()


@pytest.mark.parametrize("failing", ["notifications", "conversations"])
def test_a_failed_read_keeps_no_rows_for_its_block(failing: str) -> None:
    resources = FakeResources()
    resources.notification_items = [{"id": "n1"}]
    resources.conversation_items = [{"id": "dm1"}]
    resources.fail(failing)
    ctx = build_context(resources, make_persona(), memory_text="", now=NOW, budget=5)
    assert ctx.sources is not None
    assert getattr(ctx.sources, failing) == []


def test_the_probe_overlay_keeps_its_posts_for_v2() -> None:
    ctx = build_context(FakeResources(), make_persona(), memory_text="", now=NOW, budget=5)
    overlay_probe_posts(ctx, [_post("p")])
    assert ctx.sources is not None
    assert [i["id"] for i in ctx.sources.probe_posts] == ["p"]


def test_the_login_node_hands_the_world_rows_to_the_context(tmp_path: Path) -> None:
    deps = make_cycle_deps(tmp_path, world=ActSources(news="N"))
    update = make_login_node(deps)({"persona": make_persona(directory=tmp_path / "zenith")})
    assert update["context"].sources.news == "N"


def test_the_finish_step_puts_the_world_rows_on_the_deps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resources = FakeResources()
    resources.board_feeds = {"ai": [_post("a")]}
    _patch_cycle_seams(monkeypatch, tmp_path, resources=lambda persona, settings: resources)
    persona = make_persona(directory=tmp_path / "agents" / "zenith", model="opus")

    _, deps, finish = compose.act_deps_for(
        persona,
        FakePersonaSource(),
        compose.load_settings(),
        dry_run=True,
        budget=5,
        seed=0,
        probe_board=None,
    )

    assert finish is not None
    done = finish(deps)
    assert done.world is not None
    assert [i["id"] for i in done.world.board_posts] == ["a"]
    assert done.context_now.startswith("# 当前时间上下文")


# -- model labels never survive into kept rows (Era 3: personas never see one) --

_LABEL = "claude:claude-opus-5-5"


def _labelled(post_id: str, *, comments: int = 0) -> dict[str, Any]:
    """A row shaped like the server's: `toUserLiteDTO` puts `agentBackend` on
    every author, and an echo nests a second post with its own author."""
    row = _post(post_id, comments=comments)
    row["author"]["agentBackend"] = _LABEL
    row["echoOf"] = {
        "id": f"e{post_id}",
        "text": "echoed",
        "author": {"username": "orig", "agentBackend": "grok:grok-4.6"},
    }
    return row


def test_strip_model_labels_drops_the_key_at_every_depth_and_nothing_else() -> None:
    row = _labelled("a")
    before = copy.deepcopy(row)

    out = strip_model_labels([row, {"agentBackend": "x", "n": 1}])

    assert row == before  # pure: the caller's row, which v1 renders, is untouched
    expected = copy.deepcopy(before)
    del expected["author"]["agentBackend"]
    del expected["echoOf"]["author"]["agentBackend"]
    assert out == [expected, {"n": 1}]


def _labels_left(sources: ActSources | None) -> bool:
    assert sources is not None
    return "agentBackend" in json.dumps(sources.model_dump(mode="json"))


def test_no_capture_path_keeps_a_model_label(tmp_path: Path) -> None:
    resources = FakeResources()
    root = _labelled("r", comments=3)
    resources.recommended = [root]
    resources.latest = [_labelled("t")]
    resources.board_feeds = {"ai": [_labelled("b")]}
    resources.search_results = {"AI": [_labelled("s")]}
    resources.notification_items = [
        {"id": "n1", "type": "like", "actor": {"username": "x", "agentBackend": _LABEL}}
    ]
    resources.posts = {"r": root}
    resources.thread_comments = {
        "r": [{"id": "c1", "text": "hi", "author": {"username": "y", "agentBackend": _LABEL}}]
    }
    resources.conversation_items = [
        {"id": "dm1", "participants": [{"username": "z", "agentBackend": _LABEL}]}
    ]
    persona = make_persona()
    world = read_world_context(
        resources, persona, now=NOW, era_start=None, agent_root=tmp_path, runner=RecordingRunner()
    )
    assert not _labels_left(world.sources)

    ctx = build_context(resources, persona, memory_text="", now=NOW, budget=5, world=world.sources)
    overlay_probe_posts(ctx, [_labelled("p")])

    assert not _labels_left(ctx.sources)
    assert ctx.sources is not None
    assert ctx.sources.threads[0].post["echoOf"]["author"] == {"username": "orig"}
    assert ctx.sources.recommended[0]["author"]["displayName"] == "Ur"
    # The caller's rows keep their labels: stripping copies, never edits.
    assert resources.recommended[0]["author"]["agentBackend"] == _LABEL


def test_stripping_changes_no_rendered_v1_byte(tmp_path: Path) -> None:
    def rendered(make: Any) -> tuple[str, ...]:
        resources = FakeResources()
        root = make("r", comments=3)
        resources.recommended = [root]
        resources.latest = [make("t")]
        resources.board_feeds = {"ai": [make("b")]}
        resources.search_results = {"AI": [make("s")]}
        resources.posts = {"r": root}
        persona = make_persona()
        world = read_world_context(
            resources,
            persona,
            now=NOW,
            era_start=None,
            agent_root=tmp_path,
            runner=RecordingRunner(),
        )
        ctx = build_context(
            resources,
            persona,
            memory_text="",
            now=NOW,
            budget=5,
            context_now=world.context_now,
            feed_context=world.feed_context,
            world=world.sources,
        )
        overlay_probe_posts(ctx, [make("p")])
        return (
            ctx.context_now,
            ctx.feed_context,
            ctx.global_feed,
            ctx.timeline_feed,
            ctx.thread_context,
        )

    assert rendered(_labelled) == rendered(
        lambda post_id, comments=0: strip_model_labels(_labelled(post_id, comments=comments))
    )
