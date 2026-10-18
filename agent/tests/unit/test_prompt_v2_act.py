"""Prompt v2's act user turn (spec 2026-10-17 B1-B2)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from swil_agent.config import Settings
from swil_agent.graph.nodes_act import make_guardrail_node, make_plan_node
from swil_agent.models import (
    ActContext,
    ActSources,
    HandleMap,
    RhythmDecision,
    RhythmPolicy,
    ThreadSource,
)
from swil_agent.prompts import act_prompt
from swil_agent.prompts.types import ACT_PROMPT_PARTS
from swil_agent.prompts.v2.act import POST_LIMIT, PREAMBLE, merge_posts, render_act_v2

from ._labels import roster_model_labels
from ._runners import StubBackend, make_cycle_deps, make_persona

MUST = RhythmDecision(
    policy=RhythmPolicy.MUST_POST, prefer_non_post="comment", guidance="g", roll=7
)
NO = RhythmDecision(policy=RhythmPolicy.NO_POST, prefer_non_post="comment", guidance="g", roll=90)
CEILING = RhythmDecision(
    policy=RhythmPolicy.NO_POST, prefer_non_post="comment", guidance="g", ceiling_reached=True
)


def _id(n: int) -> str:
    return f"{n:024x}"


def _item(n: int, *, text: str = "帖子", comments: int = 2) -> dict[str, Any]:
    return {
        "id": _id(n),
        "text": text,
        "author": {"username": "laozhou", "displayName": "老周"},
        "likeCount": 3,
        "commentCount": comments,
    }


def _ctx(sources: ActSources | None = None, **fields: Any) -> ActContext:
    return ActContext(today="2026-10-17", sources=sources or ActSources(), **fields)


def _user(sources: ActSources, rhythm: RhythmDecision = MUST, **fields: Any) -> str:
    return render_act_v2(make_persona(), _ctx(sources, **fields), rhythm).request.user


def test_posts_merge_by_priority_and_the_first_occurrence_wins() -> None:
    sources = ActSources(
        probe_posts=[_item(9)],
        board_posts=[_item(1), _item(2)],
        topic_posts={"a": [_item(2), _item(3)]},
        recommended=[_item(3), _item(4)],
        timeline=[_item(1), _item(5)],
    )
    assert [p["id"] for p in merge_posts(sources)] == [_id(n) for n in (9, 1, 2, 3, 4, 5)]


def test_the_post_list_stops_at_30() -> None:
    assert len(merge_posts(ActSources(recommended=[_item(n) for n in range(1, 50)]))) == 30
    assert POST_LIMIT == 30


def test_a_post_line_is_handle_author_capped_text_and_counts() -> None:
    sources = ActSources(board_posts=[_item(1, text="长" * 300)])
    prompt = render_act_v2(make_persona(), _ctx(sources), MUST)
    lines = prompt.request.user.splitlines()
    assert "p1 @laozhou 老周：" + "长" * 160 + "  ♥3 💬2" in lines
    assert prompt.handles == HandleMap(posts={"p1": _id(1)})


def test_an_engaged_post_is_marked_as_such() -> None:
    assert "（已互动）" in _user(ActSources(board_posts=[_item(1)]), engaged_ids=_id(1))


def test_empty_blocks_are_omitted_with_their_headings() -> None:
    user = _user(ActSources())
    for gone in (
        "### 帖子",
        "### 讨论",
        "### 通知",
        "### 私信",
        "### 你最近做过的事",
        "### 今天的新闻",
        "私信只能发给",
    ):
        assert gone not in user
    assert user.startswith(PREAMBLE + "\n## 现在是 2026-10-17\n\n## 这一轮\n")


def test_a_context_without_sources_still_renders() -> None:
    """A thread checkpointed before rows were kept (Review Focus 1)."""
    prompt = render_act_v2(make_persona(), ActContext(today="2026-10-17"), MUST)
    assert "## 这一轮" in prompt.request.user
    assert prompt.handles == HandleMap()


def test_a_thread_reuses_its_posts_handle_and_numbers_its_comments() -> None:
    root = _item(1, comments=8)
    comments = [
        {
            "id": f"c{n:023x}",
            "text": "评" * 200,
            "author": {"username": f"u{n}"},
            **({"parentId": f"c{1:023x}"} if n == 2 else {}),
        }
        for n in range(1, 9)
    ]
    prompt = render_act_v2(
        make_persona(),
        _ctx(ActSources(recommended=[root], threads=[ThreadSource(post=root, comments=comments)])),
        MUST,
    )
    lines = prompt.request.user.splitlines()
    assert "p1 下的评论：" in lines
    assert "c2 @u2（回复 c1）：" + "评" * 120 in lines
    assert prompt.handles is not None
    assert sorted(prompt.handles.comments) == [f"c{n}" for n in range(1, 7)]
    assert prompt.handles.comments["c1"] == f"c{1:023x}"


def test_a_thread_root_outside_the_post_list_gets_its_own_handle() -> None:
    """Review Focus 2: a reply must still be possible."""
    extra = _item(99, comments=3)
    sources = ActSources(
        recommended=[_item(n) for n in range(1, 31)],
        threads=[ThreadSource(post=extra, comments=[{"id": "c" * 24, "text": "hi", "author": {}}])],
    )
    prompt = render_act_v2(make_persona(), _ctx(sources), MUST)
    assert prompt.handles is not None and prompt.handles.posts["p31"] == _id(99)
    lines = prompt.request.user.splitlines()
    root_line = lines.index("p31 @laozhou 老周：帖子  ♥3 💬3")
    assert lines[root_line + 1] == "p31 下的评论："
    assert _id(99) not in prompt.request.user


def test_threads_are_separated_and_rows_without_ids_are_skipped() -> None:
    first, second = _item(1, comments=3), _item(2, comments=3)
    sources = ActSources(
        board_posts=[first, second],
        threads=[
            ThreadSource(post=first, comments=[{"text": "无 id"}, {"id": "e" * 24, "text": "a"}]),
            ThreadSource(post={"text": "无 id 的帖子"}, comments=[{"id": "f" * 24}]),
            ThreadSource(post=second, comments=[{"id": "a" * 24, "text": "b", "author": {}}]),
        ],
    )
    user = _user(sources)
    block = user[user.index("### 讨论\n") : user.index("\n\n## 这一轮")]
    assert block == "### 讨论\np1 下的评论：\nc1 @：a\n\np2 下的评论：\nc2 @：b"


def test_a_free_rhythm_states_no_verdict() -> None:
    free = RhythmDecision(policy=RhythmPolicy.FREE, prefer_non_post="comment", guidance="g")
    user = _user(ActSources(), free)
    assert user[user.index("## 这一轮") :].splitlines()[1].startswith("- 最多 5 个动作")


def test_notifications_name_their_post_and_comment_by_handle_only() -> None:
    note = {
        "type": "reply",
        "actor": {"username": "xiaoman"},
        "post": {"id": _id(5), "textPreview": "原帖"},
        "comment": {"id": "d" * 24, "textPreview": "回复内容"},
    }
    prompt = render_act_v2(make_persona(), _ctx(ActSources(notifications=[note] * 10)), MUST)
    lines = [line for line in prompt.request.user.splitlines() if line.startswith("- @xiaoman")]
    assert len(lines) == 8
    assert lines[0] == "- @xiaoman 回复了你 p1「原帖」 c1「回复内容」"
    assert _id(5) not in prompt.request.user and "d" * 24 not in prompt.request.user
    assert prompt.handles == HandleMap(posts={"p1": _id(5)}, comments={"c1": "d" * 24})


def test_a_liked_comment_is_named_as_a_comment_under_its_post() -> None:
    notes = [
        {
            "type": "like",
            "actor": {"username": "xiaoman"},
            "post": {"id": _id(5), "textPreview": "原帖"},
            "comment": {"id": "d" * 24, "textPreview": "我的评论"},
        },
        {
            "type": "like",
            "actor": {"username": "a"},
            "comment": {"id": "e" * 24, "textPreview": "x"},
        },
        {"type": "like", "actor": {"username": "b"}, "post": {"id": _id(5), "textPreview": "原帖"}},
    ]
    prompt = render_act_v2(make_persona(), _ctx(ActSources(notifications=notes)), MUST)
    lines = prompt.request.user.splitlines()
    assert "- @xiaoman 赞了你在 p1「原帖」下的评论 c1「我的评论」" in lines
    assert "- @a 赞了你的评论 c2「x」" in lines
    assert "- @b 赞了你的帖子 p1「原帖」" in lines


def test_a_notification_on_a_listed_post_reuses_its_handle() -> None:
    note = {
        "type": "comment",
        "actor": {"username": "a"},
        "post": {"id": _id(1), "textPreview": "帖"},
    }
    sources = ActSources(board_posts=[_item(1)], notifications=[note])
    prompt = render_act_v2(make_persona(), _ctx(sources), MUST)
    assert "- @a 评论了你的帖子 p1「帖」" in prompt.request.user.splitlines()
    assert prompt.handles == HandleMap(posts={"p1": _id(1)})


def test_dms_contacts_and_the_dm_line_are_capped() -> None:
    conversations = [
        {
            "id": f"dm{n}",
            "participants": [{"username": f"f{n}"}],
            "unread": n == 0,
            "lastMessage": {"text": "在吗"},
        }
        for n in range(8)
    ]
    user = _user(ActSources(conversations=conversations), contacts=[f"f{n}" for n in range(25)])
    assert "- @f0（未读）：在吗" in user
    assert "- @f6" not in user
    assert "dm0" not in user
    partners = [f"f{n}" for n in range(8)]
    rest = sorted(f"f{n}" for n in range(8, 25))
    expected = "- 私信只能发给：" + "、".join([*partners, *rest][:20]) + "。"
    assert expected in user.splitlines()


def test_a_dm_partner_past_the_20th_name_is_still_a_contact() -> None:
    contacts = [f"a{n:02d}" for n in range(25)] + ["zz"]
    conversations = [{"id": "dm", "participants": [{"username": "zz"}, {"username": "stranger"}]}]
    user = _user(ActSources(conversations=conversations), contacts=contacts)
    line = next(line for line in user.splitlines() if line.startswith("- 私信只能发给："))
    names = line.removeprefix("- 私信只能发给：").removesuffix("。").split("、")
    assert names == ["zz", *(f"a{n:02d}" for n in range(19))]


@pytest.mark.parametrize(
    ("rhythm", "line"),
    [
        (MUST, "- 本轮发 1 条帖子。"),
        (NO, "- 本轮不发帖。"),
        (CEILING, "- 今天已经发过帖子，本轮不发帖。"),
    ],
)
def test_the_rhythm_is_one_verdict_line_without_the_dice(rhythm: RhythmDecision, line: str) -> None:
    user = _user(ActSources(), rhythm)
    assert line in user.splitlines()
    assert "/100" not in user


def test_memory_is_id_free_and_keeps_the_last_16_lines() -> None:
    memory = "\n".join(
        f"2026-10-{d:02d} | comment | postId={_id(d)} commentId={_id(d)} | 第{d}条"
        for d in range(1, 21)
    )
    user = _user(ActSources(), recent_memory=memory)
    lines = [line for line in user.splitlines() if line.startswith("- 10-")]
    assert len(lines) == 16
    assert lines[0] == "- 10-05 评论：第5条"
    assert lines[-1] == "- 10-20 评论：第20条"
    assert "postId" not in user


def test_news_is_the_boards_topics_plus_general() -> None:
    digest = (
        "### [finance] 金融\n→ 金融总结\n"
        "### [ai-tech] AI\n→ AI 总结\n"
        "### [general] 通用\n→ 通用总结\n"
    )
    prompt = render_act_v2(make_persona(board="market"), _ctx(ActSources(news=digest)), MUST)
    assert "[finance] 金融总结" in prompt.request.user
    assert "[general] 通用总结" in prompt.request.user
    assert "AI 总结" not in prompt.request.user


def test_the_char_counts_add_up_to_the_request() -> None:
    sources = ActSources(board_posts=[_item(1)], notifications=[{"type": "like", "actor": {}}])
    ctx = _ctx(sources, recent_memory="2026-10-17 | dream | x")
    prompt = render_act_v2(make_persona(), ctx, MUST)
    assert tuple(prompt.chars) == ACT_PROMPT_PARTS
    assert sum(prompt.chars[p] for p in ACT_PROMPT_PARTS[1:-1]) == len(prompt.request.user)
    assert prompt.chars["total"] == len(prompt.request.system) + len(prompt.request.user)
    assert prompt.chars["feeds"] > 0 and prompt.chars["social"] > 0 and prompt.chars["memory"] > 0


_BUDGET_MUST = "- 本轮发 1 条帖子。\n- 最多 4 个动作（含这条帖子），其余做几个按你的性格。\n"
_BUDGET_FREE = "- 最多 4 个动作，做几个按你的性格；不想做就选 nothing。\n"


@pytest.mark.parametrize(
    ("rhythm", "head"),
    [
        (MUST, _BUDGET_MUST),
        (NO, "- 本轮不发帖。\n" + _BUDGET_FREE),
        (CEILING, "- 今天已经发过帖子，本轮不发帖。\n" + _BUDGET_FREE),
    ],
)
def test_the_tail_is_the_spec_text_after_the_material(rhythm: RhythmDecision, head: str) -> None:
    """Spec B2, except the must-post budget line (controller ruling, Task 10
    review): "nothing" would contradict the post that round must make."""
    user = _user(ActSources(board_posts=[_item(1)]), rhythm, contacts=["b"], action_budget=4)
    tail = user[user.index("## 这一轮") :]
    assert tail == (
        "## 这一轮\n"
        + head
        + "- 最多 1 条 echo；同一条帖子同一个动作只做一次；标了「已互动」的不要再点赞或评论。\n"
        "- 私信只能发给：b。\n"
        "- 新闻只在你关心时用，用自己的角度说，不复述标题。\n"
        "\n"
        '只输出一个 JSON 对象：{"plan":[动作…]}\n'
        '{"action":"post","text":"…"}               可加 "imageTopic":"英文关键词"，系统配图\n'
        '{"action":"comment","post":"p1","text":"…"}  回复某条评论时加 "reply":"c1"\n'
        '{"action":"like","post":"p1"}\n'
        '{"action":"echo","post":"p1"}               可加 "text" 写引用语\n'
        '{"action":"follow","username":"…"}\n'
        '{"action":"dm","username":"…","text":"…"}\n'
        '{"action":"nothing"}'
    )


def test_no_model_label_appears_in_a_fully_populated_v2_prompt() -> None:
    labels = roster_model_labels()
    assert {"claude", "codex", "grok", "cursor"} <= labels
    root = _item(1, comments=3)
    sources = ActSources(
        board_posts=[root],
        topic_posts={"AI": [_item(2)]},
        recommended=[_item(3)],
        timeline=[_item(4)],
        threads=[ThreadSource(post=root, comments=[{"id": "c" * 24, "text": "嗯", "author": {}}])],
        notifications=[{"type": "like", "actor": {"username": "a"}, "post": {"id": _id(1)}}],
        conversations=[{"id": "dm", "participants": [{"username": "b"}]}],
        news="### [general] 通用\n- 要点\n→ 总结\n",
    )
    prompt = render_act_v2(make_persona(), _ctx(sources, contacts=["b"]), MUST)
    text = (prompt.request.system + "\n" + prompt.request.user).lower()
    assert sorted(label for label in labels if label in text) == []


def test_v2_runs_through_the_seam_the_plan_node_and_the_guardrail(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, prompt_version="v2", prompt_v2_enabled=True)
    backend = StubBackend('{"plan":[{"action":"like","post":"p1"}]}')
    deps = make_cycle_deps(tmp_path, settings=settings, backend=backend)
    ctx = _ctx(ActSources(board_posts=[_item(1)]))
    assert act_prompt("v2", make_persona(), ctx, NO).version == "v2"

    planned = make_plan_node(deps)({"persona": make_persona(), "context": ctx, "rhythm": NO})
    assert planned["prompt_version"] == "v2"
    assert planned["handles"].posts == {"p1": _id(1)}

    guarded = make_guardrail_node(deps)(
        {"persona": make_persona(), "context": ctx, "rhythm": NO, **planned}
    )
    assert [a.post_id for a in guarded["actions"]] == [_id(1)]
