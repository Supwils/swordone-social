"""The prompt seam (spec 2026-10-17 A1): `act_prompt("v1", ...)` is the
pre-move renderer byte for byte. The 16 golden runs drive the seam end to end
and stay unchanged; this file pins the seam on its own."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

from swil_agent.act.context import build_context, render_now_context
from swil_agent.act.planner import render_planner_prompt
from swil_agent.act.round import plan_step
from swil_agent.dream.candidate import build_dream_prompt
from swil_agent.graph.nodes_act import make_plan_node
from swil_agent.graph.nodes_dream import make_dream_node
from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import ActContext, ActOutcome, ActSources, RhythmDecision, RhythmPolicy
from swil_agent.prompts import act_prompt, dream_prompt
from swil_agent.prompts.types import ACT_PROMPT_PARTS, act_chars

from ._runners import FakeResources, SilentBackend, StubBackend, make_cycle_deps, make_persona

NOW = datetime(2026, 10, 15, 3, 30)
MUST = RhythmDecision(
    policy=RhythmPolicy.MUST_POST,
    prefer_non_post="comment",
    guidance="- 本轮随机抽样：1/100，命中 60% 的发帖概率；本轮必须选择 post。",
    post_ceiling=1,
    post_probability=60,
    roll=1,
)


def _built_context() -> ActContext:
    """A context the way a real round builds one, golden-world rows."""
    resources = FakeResources()
    post = {
        "id": "6a0000000000000000000001",
        "text": "今天的晚霞很好看",
        "createdAt": "2026-10-14T10:00:00.000Z",
        "author": {"username": "lumen", "displayName": "流明"},
        "likeCount": 2,
        "commentCount": 2,
    }
    resources.recommended = [post]
    resources.latest = [post]
    resources.posts = {post["id"]: post}
    resources.thread_comments = {post["id"]: [{"id": "c1", "text": "确实", "author": {}}]}
    resources.notification_items = [{"type": "mention", "actor": {"username": "lumen"}}]
    resources.contacts_result = ["lumen"]
    now_block = render_now_context(username="zenith", now=NOW, activity="A", news="今日新闻")
    return build_context(
        resources,
        make_persona(),
        memory_text="2026-10-12 | post | id=6c0000000000000000000003 | 旧帖\n",
        now=NOW,
        budget=5,
        context_now=now_block,
        feed_context="ft",
        world=ActSources(news="今日新闻"),
    )


CONTEXTS = {
    "empty": ActContext(),
    "populated": ActContext(
        feed_context="ft",
        timeline_feed="tl",
        thread_context="th",
        contacts_list="vex",
        dm_context="dm",
        engaged_ids="a" * 24,
    ),
    "built": _built_context(),
}


@pytest.mark.parametrize("name", list(CONTEXTS))
def test_v1_through_the_seam_is_the_v1_renderer(name: str) -> None:
    ctx = CONTEXTS[name]
    persona = make_persona(model="opus")
    prompt = act_prompt("v1", persona, ctx, MUST)
    assert prompt.version == "v1"
    assert prompt.handles is None
    assert prompt.request == CompletionRequest(
        system=persona.prompt,
        user=render_planner_prompt(ctx, rhythm_guidance=MUST.guidance),
        model="opus",
    )


@pytest.mark.parametrize("name", list(CONTEXTS))
def test_the_char_counts_add_up_to_the_request(name: str) -> None:
    prompt = act_prompt("v1", make_persona(), CONTEXTS[name], MUST)
    chars = prompt.chars
    assert tuple(chars) == ACT_PROMPT_PARTS
    assert sum(chars[part] for part in ACT_PROMPT_PARTS[1:-1]) == len(prompt.request.user)
    assert chars["system"] == len(prompt.request.system)
    assert chars["total"] == len(prompt.request.system) + len(prompt.request.user)
    assert all(value >= 0 for value in chars.values())


def test_the_news_inside_the_now_context_is_counted_as_news() -> None:
    chars = act_prompt("v1", make_persona(), CONTEXTS["built"], MUST).chars
    assert chars["news"] == len("今日新闻")
    assert chars["threads"] > 0 and chars["feeds"] > 0 and chars["social"] > 0


def test_news_that_is_not_inside_the_now_context_counts_zero() -> None:
    ctx = ActContext(context_now="no digest here", sources=ActSources(news="今日新闻"))
    assert act_prompt("v1", make_persona(), ctx, MUST).chars["news"] == 0


def test_an_unknown_version_is_refused() -> None:
    with pytest.raises(ValueError, match="v9"):
        act_prompt("v9", make_persona(), ActContext(), MUST)  # type: ignore[arg-type]


def test_plan_step_without_a_prompt_renders_v1() -> None:
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    plan_step(backend=backend, persona=make_persona(), context=ActContext(), rhythm=MUST)
    assert backend.last == act_prompt("v1", make_persona(), ActContext(), MUST).request


def test_the_plan_node_records_the_version_and_the_size(tmp_path: Path) -> None:
    node = make_plan_node(make_cycle_deps(tmp_path))
    update = node({"persona": make_persona(), "context": ActContext(), "rhythm": MUST})
    assert update["prompt_version"] == "v1"
    assert update["act_prompt_chars"]["total"] > 0
    assert "handles" not in update


def test_a_silent_backend_still_records_the_prompt_size(tmp_path: Path) -> None:
    node = make_plan_node(make_cycle_deps(tmp_path, backend=SilentBackend()))
    update = node({"persona": make_persona(), "context": ActContext(), "rhythm": MUST})
    assert update["outcome"] is ActOutcome.BACKEND_UNAVAILABLE
    assert update["act_prompt_chars"]["total"] > 0


@pytest.mark.parametrize(("memory", "group"), [("m", ""), ("", ""), ("m", "- @a：x")])
def test_v1_dream_through_the_seam_is_build_dream_prompt(memory: str, group: str) -> None:
    persona = make_persona(model="opus")
    prompt = dream_prompt("v1", persona, memory_tail=memory, group_memory=group)
    assert prompt.version == "v1"
    assert prompt.request == build_dream_prompt(persona, memory_tail=memory, group_memory=group)
    assert prompt.chars == {"system": len(prompt.request.system), "user": len(prompt.request.user)}


def test_the_dream_seam_refuses_an_unknown_version() -> None:
    with pytest.raises(ValueError, match="v9"):
        dream_prompt("v9", make_persona(), memory_tail="", group_memory="")  # type: ignore[arg-type]


def test_the_dream_node_records_the_dream_prompt_size(tmp_path: Path) -> None:
    deps = make_cycle_deps(tmp_path, backend=StubBackend('{"recent": ["一件新事"]}'))
    update = make_dream_node(deps)({"persona": make_persona(directory=tmp_path / "zenith")})
    assert update["proceeded"] is True
    assert update["dream_prompt_chars"]["user"] > 0


def test_a_failed_dream_still_records_its_prompt_size(tmp_path: Path) -> None:
    deps = make_cycle_deps(tmp_path, backend=SilentBackend())
    update = make_dream_node(deps)({"persona": make_persona(directory=tmp_path / "zenith")})
    assert update["dream_reason"] == "LLM returned empty"
    assert update["dream_prompt_chars"]["user"] > 0


def test_the_now_context_template_lives_in_prompts_v1() -> None:
    from swil_agent.act import context
    from swil_agent.prompts.v1 import now

    assert context.NOW_CONTEXT_TEMPLATE is now.NOW_CONTEXT_TEMPLATE


def test_the_dead_backend_constraint_field_is_gone_and_old_rows_still_load() -> None:
    assert "backend_action_constraint" not in ActContext.model_fields
    assert ActContext.model_validate({"backend_action_constraint": ""}) == ActContext()


def test_act_chars_refuses_an_unknown_part() -> None:
    with pytest.raises(ValueError, match="bogus"):
        act_chars("sys", [("bogus", "x")])
