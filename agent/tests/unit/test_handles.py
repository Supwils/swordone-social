"""Prompt v2 handles mapped back to ids before the guardrails (spec B1)."""

from __future__ import annotations

from pathlib import Path

import pytest

from swil_agent.act.guardrails import UNKNOWN_HANDLE, map_handles, resolve_handles
from swil_agent.act.round import guardrail_step, plan_step
from swil_agent.graph import nodes_act
from swil_agent.graph.nodes_act import make_guardrail_node
from swil_agent.graph.outcome import act_result_of
from swil_agent.graph.state import CycleState
from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import (
    ActContext,
    Action,
    ActOutcome,
    HandleMap,
    Plan,
    RhythmDecision,
    RhythmPolicy,
)
from swil_agent.prompts.types import RenderedPrompt

from ._runners import StubBackend, make_cycle_deps, make_persona

POST_ID = "a" * 24
COMMENT_ID = "b" * 24
HANDLES = HandleMap(posts={"p1": POST_ID}, comments={"c1": COMMENT_ID})
NO_POST = RhythmDecision(policy=RhythmPolicy.NO_POST, prefer_non_post="comment", guidance="g")


def test_known_handles_resolve_to_ids() -> None:
    plan = Plan(actions=[Action(kind="comment", post_id="p1", parent_id="c1", text="x")])
    resolved = resolve_handles(plan, HANDLES)
    assert resolved.actions == [
        Action(kind="comment", post_id=POST_ID, parent_id=COMMENT_ID, text="x")
    ]
    assert resolved.vetoed == []


def test_a_raw_24_hex_id_is_taken_as_written() -> None:
    plan = Plan(actions=[Action(kind="like", post_id="c" * 24)])
    assert resolve_handles(plan, HANDLES).actions[0].post_id == "c" * 24


def test_an_unknown_post_handle_drops_the_action() -> None:
    resolved = resolve_handles(Plan(actions=[Action(kind="like", post_id="p9")]), HANDLES)
    assert resolved.actions == []
    assert [v.reason for v in resolved.vetoed] == [UNKNOWN_HANDLE] == ["unknown_handle"]


def test_an_unknown_reply_handle_drops_the_whole_comment() -> None:
    plan = Plan(actions=[Action(kind="comment", post_id="p1", parent_id="c9", text="x")])
    assert [v.reason for v in resolve_handles(plan, HANDLES).vetoed] == [UNKNOWN_HANDLE]


def test_actions_without_a_target_pass_untouched() -> None:
    actions = [
        Action(kind="post", text="t"),
        Action(kind="follow", username="u"),
        Action(kind="dm", username="u", text="t"),
        Action(kind="nothing"),
    ]
    assert resolve_handles(Plan(actions=actions), HANDLES).actions == actions


def test_unknown_handles_are_recorded_before_the_other_stages() -> None:
    plan = Plan(actions=[Action(kind="like", post_id="p9"), Action(kind="like", post_id="p1")])
    step = guardrail_step(
        plan=plan, persona=make_persona(), rhythm=NO_POST, context=ActContext(), handles=HANDLES
    )
    assert [a.post_id for a in step.actions] == [POST_ID]
    assert [v.reason for v in step.vetoed] == [UNKNOWN_HANDLE]


def test_a_plan_of_only_unknown_handles_is_vetoed_empty() -> None:
    step = guardrail_step(
        plan=Plan(actions=[Action(kind="like", post_id="p9")]),
        persona=make_persona(),
        rhythm=NO_POST,
        context=ActContext(),
        handles=HANDLES,
    )
    assert step.empty_outcome is ActOutcome.VETOED_EMPTY


def test_without_handles_nothing_is_resolved_or_dropped() -> None:
    """A v1 round, or a thread planned before handles existed."""
    step = guardrail_step(
        plan=Plan(actions=[Action(kind="like", post_id="p9")]),
        persona=make_persona(),
        rhythm=NO_POST,
        context=ActContext(),
    )
    assert [a.post_id for a in step.actions] == ["p9"]


def test_the_guardrail_node_hands_the_state_handles_to_the_step(tmp_path: Path) -> None:
    node = make_guardrail_node(make_cycle_deps(tmp_path))
    update = node(
        {
            "persona": make_persona(),
            "context": ActContext(),
            "rhythm": NO_POST,
            "plan": Plan(actions=[Action(kind="like", post_id="p1")]),
            "handles": HANDLES,
        }
    )
    assert [a.post_id for a in update["actions"]] == [POST_ID]


def test_plan_step_reads_handle_keys_only_for_a_prompt_with_handles() -> None:
    reply = '{"plan":[{"action":"like","post":"p1"}]}'
    request = CompletionRequest(system="s", user="u")
    with_handles = RenderedPrompt(version="v2", request=request, chars={}, handles=HANDLES)
    without = RenderedPrompt(version="v1", request=request, chars={}, handles=None)
    common = {"persona": make_persona(), "context": ActContext(), "rhythm": NO_POST}

    v2 = plan_step(backend=StubBackend(reply), prompt=with_handles, **common)
    v1 = plan_step(backend=StubBackend(reply), prompt=without, **common)

    assert v2 is not None and v2.actions[0].post_id == "p1"
    assert v1 is not None and v1.actions[0].post_id is None


def test_padded_handles_and_ids_are_stripped_before_lookup() -> None:
    plan = Plan(
        actions=[
            Action(kind="comment", post_id=" p1 ", parent_id="c1\n", text="x"),
            Action(kind="like", post_id=f" {'c' * 24} "),
        ]
    )
    resolved = resolve_handles(plan, HANDLES)
    assert [(a.post_id, a.parent_id) for a in resolved.actions] == [
        (POST_ID, COMMENT_ID),
        ("c" * 24, None),
    ]
    assert resolved.vetoed == []


def test_a_handle_and_its_raw_id_dedupe_after_resolution() -> None:
    plan = Plan(actions=[Action(kind="like", post_id="p1"), Action(kind="like", post_id=POST_ID)])
    step = guardrail_step(
        plan=plan, persona=make_persona(), rhythm=NO_POST, context=ActContext(), handles=HANDLES
    )
    assert [a.post_id for a in step.actions] == [POST_ID]
    assert [v.reason for v in step.vetoed] == [f"duplicate like on {POST_ID}"]


def test_map_handles_keeps_an_unknown_target_as_written() -> None:
    plan = Plan(actions=[Action(kind="like", post_id="p9"), Action(kind="like", post_id="p1")])
    assert [a.post_id for a in map_handles(plan, HANDLES).actions] == ["p9", POST_ID]


def _rendered(handles: HandleMap | None) -> RenderedPrompt:
    request = CompletionRequest(system="s", user="u")
    return RenderedPrompt(version="v1", request=request, chars={}, handles=handles)


def test_the_plan_node_keeps_v2_handles_in_the_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(nodes_act, "act_prompt", lambda *_args: _rendered(HANDLES))
    node = nodes_act.make_plan_node(make_cycle_deps(tmp_path))
    update = node({"persona": make_persona(), "context": ActContext(), "rhythm": NO_POST})
    assert update["handles"] == HANDLES


def test_the_plan_node_leaves_handles_unset_under_v1(tmp_path: Path) -> None:
    node = nodes_act.make_plan_node(make_cycle_deps(tmp_path))
    update = node({"persona": make_persona(), "context": ActContext(), "rhythm": NO_POST})
    assert update["prompt_version"] == "v1"
    assert "handles" not in update


def test_the_act_result_carries_the_state_handles() -> None:
    state: CycleState = {"outcome": ActOutcome.PLANNER_EMPTY, "handles": HANDLES}
    result = act_result_of(state)
    assert result is not None and result.handles == HANDLES
    assert act_result_of({"outcome": ActOutcome.PLANNER_EMPTY}).handles is None  # type: ignore[union-attr]
