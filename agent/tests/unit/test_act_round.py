"""Tests for `swil_agent.act.round` (design spec §7, contract `01` §1 +
`02` §3-§5) -- the six-outcome composition of the whole act path.

The outcome-mapping table (`test_outcome_mapping`) is the deliverable: every
row is set up so a plausible one-line mutation of `run_act` would produce a
DIFFERENT outcome, not merely a different code path to the same one -- see
each scenario's inline comment for the specific mutation it pins.
"""

from __future__ import annotations

import json
import logging
import os
import random
from collections.abc import Callable
from datetime import datetime
from json import loads as _json_loads
from pathlib import Path
from typing import Any

import httpx
import pytest

from swil_agent.act.memory_log import _memory_event
from swil_agent.act.round import allowed_for
from swil_agent.api.auth import ApiKeyAuth
from swil_agent.api.client import ApiClient, ApiError
from swil_agent.api.resources import Resources
from swil_agent.llm.protocol import Backend
from swil_agent.locks.file import act_lock_path, dream_lock_path
from swil_agent.locks.lease import LeaseBusy
from swil_agent.models import Action, ActOutcome, ActResult, Persona

from ._phases import run_act_phase
from ._runners import ExplodingBackend, FakeResources, SilentBackend, StubBackend, make_persona

NOW = datetime(2026, 8, 17, 10, 0, 0)


def _persona(
    tmp_path: Path,
    *,
    backend: str = "claude",
    username: str = "zenith",
    dir_name: str = "zenith",
    board: str = "",
) -> Persona:
    """`username` and `dir_name` default to the same string but can be set
    apart: `agent_name` is the directory name, not the username, and a
    fixture where the two always match cannot catch a slip between them."""
    directory = tmp_path / "agents" / dir_name
    directory.mkdir(parents=True, exist_ok=True)
    return make_persona(
        username=username, directory=directory, backend=backend, board=board, prompt="PERSONA"
    )


def _plan_json(actions: list[Action]) -> str:
    wire: list[dict[str, str]] = []
    for a in actions:
        obj: dict[str, str] = {"action": a.kind}
        if a.text is not None:
            obj["text"] = a.text
        if a.post_id is not None:
            obj["postId"] = a.post_id
        if a.parent_id is not None:
            obj["parentId"] = a.parent_id
        if a.username is not None:
            obj["username"] = a.username
        if a.image_topic is not None:
            obj["imageTopic"] = a.image_topic
        wire.append(obj)
    return json.dumps({"plan": wire})


def _run(
    tmp_path: Path,
    *,
    persona: Persona | None = None,
    resources: FakeResources | None = None,
    backend: Backend | None = None,
    memory_text: str = "",
    health_check: Callable[[], bool] | None = None,
    dry_run: bool = False,
    rng: random.Random | None = None,
    access_key: str | None = None,
) -> ActResult:
    return run_act_phase(
        persona=persona or _persona(tmp_path),
        resources=resources if resources is not None else FakeResources(),
        backend=backend or StubBackend('{"plan":[{"action":"nothing"}]}'),
        memory_text=memory_text,
        agent_root=tmp_path,
        now=NOW,
        rng=rng or random.Random(0),
        health_check=health_check or (lambda: True),
        dry_run=dry_run,
        access_key=access_key,
    )


# ── allowed_for (contract 02 §1.1, spec §6.8) ───────────────────────────────


def test_allowed_for_is_unrestricted_including_for_codex(tmp_path: Path) -> None:
    """Loop-engine spec §7: the Codex post/nothing allow-list is gone.
    Comment/like/echo/follow use the same write-verified executor."""
    assert allowed_for(_persona(tmp_path, backend="codex")) == []
    assert allowed_for(_persona(tmp_path, backend="claude")) == []


# ── the outcome-mapping table (the deliverable) ─────────────────────────────


def _scenario(name: str, tmp_path: Path) -> ActResult:
    post_id = "f" * 24

    if name == "all_actions_land":
        # Mutation this pins: remove the `like_raises` absence (i.e. inject
        # a failure) and this becomes LANDED_PARTIAL, not LANDED_ALL.
        backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
        return _run(tmp_path, backend=backend, resources=FakeResources())

    if name == "some_actions_fail":
        # Two actions of DIFFERENT kinds so guardrails' dedupe/caps don't
        # collapse them: follow always lands (executor.py's deliberate
        # design), like is forced to fail. Mutation this pins: remove
        # `like_raises` and landed becomes 2/2 -> LANDED_ALL instead.
        backend = StubBackend(
            '{"plan":[{"action":"follow","username":"vex"},'
            f'{{"action":"like","postId":"{post_id}"}}]}}'
        )
        resources = FakeResources(like_raises=ApiError(500, "boom", None))
        return _run(tmp_path, backend=backend, resources=resources)

    if name == "guardrails_empty_the_plan":
        # The default daily ceiling (1) is reached by the post already logged
        # today, forcing policy=NO_POST; the model's only action is `post`,
        # so guardrails drop it to empty WITH a non-empty vetoed list.
        # Mutation this pins: if guardrails did not veto, the post would
        # survive -> LANDED_ALL, not VETOED_EMPTY.
        persona = _persona(tmp_path)
        backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
        memory_text = f"2026-08-17 | post | id={'a' * 24} | earlier\n"
        return _run(tmp_path, persona=persona, backend=backend, memory_text=memory_text)

    if name == "model_chose_nothing":
        # A lone `nothing` survives guardrails untouched (stage 2 only
        # strips `nothing` mixed with other actions) with an EMPTY vetoed
        # list -- the mirror-image setup of guardrails_empty_the_plan,
        # proving PLANNER_EMPTY and VETOED_EMPTY are pinned by different
        # scenarios, not the same one asserting two different labels.
        backend = StubBackend('{"plan":[{"action":"nothing"}]}')
        return _run(tmp_path, backend=backend)

    if name == "planner_returned_empty_plan":
        # The SECOND route to PLANNER_EMPTY (fix round 1, item 1): the
        # backend's own JSON is `{"plan":[]}` -- `normalize_plan` yields
        # `Plan(actions=[])`, so `guarded.actions == []` AND
        # `guarded.vetoed == []` with NOTHING for guardrails to have
        # removed, because there was never anything in the plan to begin
        # with. This is `round.py`'s `if not guarded.actions:` branch, NOT
        # the solo-`[nothing]` branch `model_chose_nothing` exercises --
        # the two reach `PLANNER_EMPTY` through different code paths, and
        # this scenario was previously untested: flipping
        # `ActOutcome.VETOED_EMPTY if guarded.vetoed else
        # ActOutcome.PLANNER_EMPTY` to always return `VETOED_EMPTY` failed
        # no test before this scenario existed. Mutation this pins: that
        # exact flip.
        backend = StubBackend('{"plan":[]}')
        return _run(tmp_path, backend=backend)

    if name == "backend_silent":
        # Mutation this pins: swap SilentBackend for a StubBackend that
        # returns real JSON and this becomes a landed/vetoed outcome, not
        # BACKEND_UNAVAILABLE.
        return _run(tmp_path, backend=SilentBackend())

    if name == "platform_unreachable":
        # Mutation this pins: flip health_check to `lambda: True` and this
        # falls through to whatever the (never-reached) plan/guardrails
        # would have produced instead of OFFLINE.
        return _run(tmp_path, health_check=lambda: False)

    if name == "every_action_fails":
        # Mutation this pins: remove `like_raises` and landed becomes 1/1
        # -> LANDED_ALL, not LANDED_PARTIAL.
        backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
        resources = FakeResources(like_raises=ApiError(500, "boom", None))
        return _run(tmp_path, backend=backend, resources=resources)

    raise AssertionError(f"unknown scenario: {name!r}")


@pytest.mark.parametrize(
    ("scenario", "expected", "grants_dream"),
    [
        ("all_actions_land", ActOutcome.LANDED_ALL, True),
        ("some_actions_fail", ActOutcome.LANDED_PARTIAL, True),
        ("guardrails_empty_the_plan", ActOutcome.VETOED_EMPTY, True),
        ("model_chose_nothing", ActOutcome.PLANNER_EMPTY, True),
        ("planner_returned_empty_plan", ActOutcome.PLANNER_EMPTY, True),
        ("backend_silent", ActOutcome.BACKEND_UNAVAILABLE, False),
        ("platform_unreachable", ActOutcome.OFFLINE, False),
        # Bash treats "every planned action failed" as rc=75 and skips the
        # dream (contract 02 §3.2: dreaming on unrefreshed memory
        # manufactures drift that never happened). Design spec §7.1 is
        # explicit that only BACKEND_UNAVAILABLE/OFFLINE deny the dream, so
        # under the typed outcomes this is LANDED_PARTIAL with landed == 0,
        # and the dream proceeds -- see test_every_action_failing_... below
        # for the accompanying FAIL-level log line and the landed==0 record.
        ("every_action_fails", ActOutcome.LANDED_PARTIAL, True),
    ],
)
def test_outcome_mapping(
    scenario: str, expected: ActOutcome, grants_dream: bool, tmp_path: Path
) -> None:
    result = _scenario(scenario, tmp_path)
    assert result.outcome is expected
    assert result.grants_dream is grants_dream


def test_two_planner_empty_routes_have_different_vetoed_shapes(tmp_path: Path) -> None:
    """The deliverable's missing cell (fix round 1, item 1): both
    `model_chose_nothing` and `planner_returned_empty_plan` land on
    `PLANNER_EMPTY`, but they reach it through genuinely different guardrail
    outputs -- a solo `[nothing]` that SURVIVED guardrails (non-empty
    `guarded.actions`, `is_solo_nothing` override) vs. an empty plan that
    guardrails never touched at all (`guarded.actions == []`,
    `guarded.vetoed == []`). Both must have an empty `vetoed` list -- that
    is what distinguishes PLANNER_EMPTY from VETOED_EMPTY -- but they are
    not the same code path, which is why flipping `round.py`'s
    `VETOED_EMPTY if guarded.vetoed else PLANNER_EMPTY` ternary only shows
    up if BOTH routes are tested."""
    empty_plan_result = _scenario("planner_returned_empty_plan", tmp_path)
    solo_nothing_result = _scenario("model_chose_nothing", tmp_path)
    assert empty_plan_result.outcome is ActOutcome.PLANNER_EMPTY
    assert solo_nothing_result.outcome is ActOutcome.PLANNER_EMPTY
    assert empty_plan_result.vetoed == []
    assert solo_nothing_result.vetoed == []
    # The shape difference the two routes actually take: the empty-plan
    # route never reaches execute_action (nothing to execute), the
    # solo-nothing route does (for lab-event/log parity -- see
    # test_solo_nothing_still_executes_for_lab_event_parity).
    assert empty_plan_result.results == []
    assert len(solo_nothing_result.results) == 1


def test_every_action_failing_logs_fail_and_records_landed_zero(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    post_id = "f" * 24
    backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
    resources = FakeResources(like_raises=ApiError(500, "boom", None))
    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        result = _run(tmp_path, backend=backend, resources=resources)
    assert result.landed == 0
    assert result.attempted == 1
    assert "FAIL zenith — all 1 planned actions failed; dream will be skipped" in caplog.text


def test_fail_log_uses_the_directory_name_not_the_username(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Fix round 1, item 2: Bash's own FAIL line (`auto-run.sh:763`) is
    keyed on `$agent_name` (`basename "$agent_dir"`), not the `Username`
    bullet -- an earlier version of this log call passed `persona.username`
    instead, a slip the default `_persona()` fixture could never catch
    because it always sets `username` and `dir_name` to the same string.
    This test sets them apart on purpose: `directory.name` must appear in
    the log line, and the (deliberately different) `username` must not."""
    persona = _persona(tmp_path, username="not-the-directory-name", dir_name="zenith")
    post_id = "f" * 24
    backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
    resources = FakeResources(like_raises=ApiError(500, "boom", None))
    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert "FAIL zenith — all 1 planned actions failed" in caplog.text
    assert "not-the-directory-name" not in caplog.text


def test_backend_unavailable_is_not_the_same_as_planner_empty(tmp_path: Path) -> None:
    """A silent backend (plan_round returns None) must never collapse into
    the same bucket as a model that explicitly chose `nothing` -- spec §7.1
    names this distinction as the whole point of the outcome type."""
    backend_result = _scenario("backend_silent", tmp_path)
    nothing_result = _scenario("model_chose_nothing", tmp_path)
    assert backend_result.outcome is not nothing_result.outcome


# ── health probe ordering (contract 01 §1) ──────────────────────────────────


def test_offline_health_check_does_nothing_else_and_leaves_no_lock_behind(
    tmp_path: Path,
) -> None:
    """An OFFLINE act makes the probe and nothing else, and leaves no lock
    file: the act lease it held for the run is released on the way out. (It
    no longer probes BEFORE taking the lease -- S3 §12.2(c).)"""
    calls: list[str] = []

    def _health() -> bool:
        calls.append("health")
        return False

    result = _run(tmp_path, health_check=_health)
    assert result.outcome is ActOutcome.OFFLINE
    assert calls == ["health"]
    assert not act_lock_path(tmp_path, "zenith").exists()


# ── lock behavior (ruling R6: a busy lease propagates, is not an ActOutcome) ─


def test_the_act_phase_raises_lease_busy_when_the_account_lock_is_held(tmp_path: Path) -> None:
    lock = act_lock_path(tmp_path, "zenith")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("1", encoding="utf-8")
    with pytest.raises(LeaseBusy):
        _run(tmp_path)
    # Someone else's lock, untouched by the failed acquire attempt.
    assert lock.read_text(encoding="utf-8") == "1"


def test_run_act_releases_the_lock_even_when_a_step_raises(tmp_path: Path) -> None:
    """The brief's own sketch of this test injects a `planner=` keyword
    `run_act` does not accept (task-7-brief.md step 3) -- `plan_round` is a
    plain call this function makes, not a parameter it takes. The
    equivalent real failure mode is a backend whose `.complete()` raises
    something OTHER than `BackendUnavailableError`: `plan_round` only
    catches that one exception type, so anything else propagates through it
    and through `run_act` unchanged, exercising the exact "mid-round step
    raises" scenario the brief intended without inventing a parameter that
    does not exist."""
    with pytest.raises(RuntimeError, match="exploding backend"):
        _run(tmp_path, backend=ExplodingBackend())
    assert not act_lock_path(tmp_path, "zenith").exists()


# ── dry_run inertness (design spec §9.4) ────────────────────────────────────


def test_dry_run_never_calls_the_api_or_writes_memory(tmp_path: Path) -> None:
    persona = _persona(tmp_path)
    post_id = "f" * 24
    backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
    resources = FakeResources()

    result = _run(tmp_path, persona=persona, backend=backend, resources=resources, dry_run=True)

    # Absence of effects, not merely a returned value: no write call was
    # ever recorded, and memory.md was never even created.
    assert resources.calls == []
    assert resources.lab_events == []
    assert not (persona.directory / "memory.md").exists()
    assert result.results == []
    assert result.attempted == 0
    assert result.landed == 0


def test_dry_run_still_returns_the_plan_and_vetoes(tmp_path: Path) -> None:
    """The whole point of dry_run: inspect what WOULD have executed."""
    post_id = "f" * 24
    backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
    result = _run(tmp_path, backend=backend, dry_run=True)
    assert result.plan is not None
    assert [a.kind for a in result.plan.actions] == ["like"]
    assert result.vetoed == []


def test_dry_run_reports_vetoed_empty_when_guardrails_would_have_dropped_everything(
    tmp_path: Path,
) -> None:
    persona = _persona(tmp_path)
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    memory_text = f"2026-08-17 | post | id={'a' * 24} | earlier\n"
    result = _run(tmp_path, persona=persona, backend=backend, memory_text=memory_text, dry_run=True)
    assert result.outcome is ActOutcome.VETOED_EMPTY
    assert len(result.vetoed) == 1


def test_dry_run_classifies_a_solo_nothing_plan_as_planner_empty(tmp_path: Path) -> None:
    """The plan-shape classification (empty vs. solo-`nothing`) applies
    identically whether or not `dry_run` is set -- it never depends on
    execution, so dry_run must not accidentally report LANDED_ALL here."""
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    result = _run(tmp_path, backend=backend, dry_run=True)
    assert result.outcome is ActOutcome.PLANNER_EMPTY


# ── memory.md line shapes (contract 02 §4.2) ────────────────────────────────


def _run_and_collect_memory(
    tmp_path: Path, actions: list[Action], *, resources: FakeResources | None = None
) -> list[str]:
    persona = _persona(tmp_path)
    backend = StubBackend(_plan_json(actions))
    _run(tmp_path, persona=persona, backend=backend, resources=resources or FakeResources())
    memory_file = persona.directory / "memory.md"
    if not memory_file.exists():
        return []
    return memory_file.read_text(encoding="utf-8").splitlines()


def test_memory_lines_match_the_bash_shapes(tmp_path: Path) -> None:
    # The exact resource id from task-7-brief.md, quoted verbatim.
    lines = _run_and_collect_memory(
        tmp_path,
        [
            Action(kind="post", text="hello"),
            Action(kind="like", post_id="f" * 24),
            Action(kind="follow", username="vex"),
            Action(kind="nothing"),
        ],
        resources=FakeResources(post_id="newpost0000000000000000"),
    )
    assert lines == [
        "2026-08-17 | post | id=newpost0000000000000000 | hello",
        "2026-08-17 | like | postId=" + "f" * 24,
        "2026-08-17 | follow | @vex",
    ]


def test_memory_note_collapses_internal_whitespace(tmp_path: Path) -> None:
    lines = _run_and_collect_memory(tmp_path, [Action(kind="post", text="a\n\n  b")])
    assert lines[0].endswith("| a b")


def test_memory_line_for_post_includes_the_image_tag(tmp_path: Path) -> None:
    lines = _run_and_collect_memory(
        tmp_path, [Action(kind="post", text="look", image_topic="city night")]
    )
    assert lines == ["2026-08-17 | post | id=post-1 | [img:city night] look"]


def test_memory_line_image_tag_is_never_doubled_text_collapsed(tmp_path: Path) -> None:
    """Fix round 1, item 3: `executor.py`'s module docstring is explicit
    that `collapse_doubled_text` applies to `post.text`/`comment.text`/
    `echo.text`/`dm.text` and NEVER to `imageTopic` -- an earlier version of
    `round.py`'s `_memory_note` ran `image_topic` through the same
    collapsing function it used for `text`, which could make the
    `[img:...]` memory-line tag disagree with the topic string actually
    used to fetch the image. This exact literal (`"citynight" * 6`, >= 40
    chars and an exact self-duplicate) is the one `test_executor.py`'s own
    `test_image_topic_is_not_collapsed` uses to prove the same rule at the
    executor layer; reused here so the two layers are pinned by an
    identical input, not merely similarly-worded assertions."""
    topic = "citynight" * 6
    lines = _run_and_collect_memory(tmp_path, [Action(kind="post", text="x", image_topic=topic)])
    assert lines == [f"2026-08-17 | post | id=post-1 | [img:{topic}] x"]


def test_memory_line_for_comment_includes_parent_id_on_a_real_reply(tmp_path: Path) -> None:
    post_id = "f" * 24
    parent_id = "c" * 24
    lines = _run_and_collect_memory(
        tmp_path,
        [Action(kind="comment", post_id=post_id, parent_id=parent_id, text="reply text")],
    )
    assert lines == [
        f"2026-08-17 | comment | postId={post_id} commentId=comment-1 "
        f"parentId={parent_id} | reply text"
    ]


def test_memory_line_for_comment_omits_parent_id_after_the_fallback_retry(tmp_path: Path) -> None:
    """When the parent comment is unusable, `execute_action` retries
    top-level and its own `ActionResult.detail` records that fallback
    (`"parent unusable — posted top-level"`) -- the memory line must match
    what swil.sh's own retry call would have written (no parentId), not
    what the model originally asked for."""
    post_id = "f" * 24
    parent_id = "c" * 24
    resources = FakeResources(fail_first_comment=True)
    persona = _persona(tmp_path)
    backend = StubBackend(
        _plan_json([Action(kind="comment", post_id=post_id, parent_id=parent_id, text="hi")])
    )
    _run(tmp_path, persona=persona, backend=backend, resources=resources)
    lines = (persona.directory / "memory.md").read_text(encoding="utf-8").splitlines()
    assert lines == [f"2026-08-17 | comment | postId={post_id} commentId=comment-2 | hi"]


def test_memory_line_for_echo_includes_the_quote(tmp_path: Path) -> None:
    post_id = "f" * 24
    lines = _run_and_collect_memory(
        tmp_path, [Action(kind="echo", post_id=post_id, text="nice take")]
    )
    assert lines == [f"2026-08-17 | echo | id=post-1 echoOf={post_id} | nice take"]


def test_memory_line_for_echo_without_a_quote_has_no_trailing_tag(tmp_path: Path) -> None:
    post_id = "f" * 24
    lines = _run_and_collect_memory(tmp_path, [Action(kind="echo", post_id=post_id)])
    assert lines == [f"2026-08-17 | echo | id=post-1 echoOf={post_id}"]


def test_memory_line_for_dm_matches_swil_sh_711_byte_for_byte(tmp_path: Path) -> None:
    """Fix round 1, item 4: `swil.sh:711`'s own `_remember` call is
    `_remember "dm | to=$RECIPIENT conversationId=$CONV_ID | ${TEXT:0:80}"`.
    `Resources.send_dm` now returns `(conversation_id, message_id)`
    (resources.py/executor.py, this same fix round) and `ActionResult`
    carries the conversation id in its own field, so this line now
    byte-matches the Bash shape instead of the earlier `messageId=`
    substitute.

    `vex` must be pre-populated as a contact or guardrails' stage 4 (DM
    recipient must be in `ctx.contacts`) drops the action before it ever
    reaches execution -- see `test_a_dm_outside_contacts_is_vetoed_not_executed`."""
    resources = FakeResources()
    resources.contacts_result = ["vex"]
    lines = _run_and_collect_memory(
        tmp_path, [Action(kind="dm", username="vex", text="hey")], resources=resources
    )
    assert lines == ["2026-08-17 | dm | to=vex conversationId=conv-1 | hey"]


def test_a_dm_outside_contacts_is_vetoed_not_executed(tmp_path: Path) -> None:
    """Companion to the test above: WITHOUT the contacts population, the
    same dm plan is silently dropped by guardrails, not executed and
    memory-lined -- proving the contacts population above is load-bearing,
    not incidental setup."""
    lines = _run_and_collect_memory(tmp_path, [Action(kind="dm", username="vex", text="hey")])
    assert lines == []


def test_nothing_writes_no_memory_line_even_when_it_is_the_whole_plan(tmp_path: Path) -> None:
    lines = _run_and_collect_memory(tmp_path, [Action(kind="nothing")])
    assert lines == []


def test_a_failed_action_writes_no_memory_line(tmp_path: Path) -> None:
    post_id = "f" * 24
    persona = _persona(tmp_path)
    backend = StubBackend(_plan_json([Action(kind="like", post_id=post_id)]))
    resources = FakeResources(like_raises=ApiError(500, "boom", None))
    _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert not (persona.directory / "memory.md").exists()


def test_empty_plan_after_guardrails_executes_nothing_at_all(tmp_path: Path) -> None:
    """VETOED_EMPTY/PLANNER_EMPTY (an empty guarded action list) must never
    reach `execute_action` -- there is nothing to execute, so no write call,
    no lab event, and no memory line of any kind should appear."""
    persona = _persona(tmp_path)
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    memory_text = f"2026-08-17 | post | id={'a' * 24} | earlier\n"
    resources = FakeResources()
    result = _run(
        tmp_path, persona=persona, backend=backend, memory_text=memory_text, resources=resources
    )
    assert result.outcome is ActOutcome.VETOED_EMPTY
    assert resources.calls == []
    assert not (persona.directory / "memory.md").exists()


def test_solo_nothing_still_executes_for_lab_event_parity(tmp_path: Path) -> None:
    """A lone `nothing` is classified PLANNER_EMPTY, but Bash's own
    `execute_action` still calls through for it (DONE log + lab event) --
    this module reproduces that rather than short-circuiting before
    execution the way the empty-plan case does."""
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    resources = FakeResources()
    result = _run(tmp_path, backend=backend, resources=resources)
    assert result.outcome is ActOutcome.PLANNER_EMPTY
    assert len(result.results) == 1
    assert result.results[0].landed is True
    assert len(resources.lab_events) == 1


# ── ActResult.context / .plan population per outcome ────────────────────────


def test_context_and_plan_are_populated_on_a_normal_round(tmp_path: Path) -> None:
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    result = _run(tmp_path, backend=backend)
    assert result.context is not None
    assert result.plan is not None


def test_backend_unavailable_still_carries_context_but_no_plan(tmp_path: Path) -> None:
    result = _run(tmp_path, backend=SilentBackend())
    assert result.context is not None
    assert result.plan is None


def test_offline_carries_neither_context_nor_plan(tmp_path: Path) -> None:
    result = _run(tmp_path, health_check=lambda: False)
    assert result.context is None
    assert result.plan is None


# ── board resolution (fix round 1, item 5) ──────────────────────────────────


def test_board_id_is_resolved_from_persona_board_and_threaded_into_the_post(
    tmp_path: Path,
) -> None:
    persona = _persona(tmp_path, board="tech")
    resources = FakeResources()
    resources.board_lookup = {"tech": "board-1"}
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert resources.created_posts[0].board_id == "board-1"
    assert resources.get_boards_calls == 1


def test_no_board_bullet_never_calls_get_boards(tmp_path: Path) -> None:
    """Mutation this pins: dropping the `if persona.board:` guard would make
    every round -- even one with no `Board:` bullet at all -- pay a network
    call for nothing, matching Bash's own `if [[ -n "$POST_BOARD" ]]`."""
    persona = _persona(tmp_path, board="")
    resources = FakeResources()
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert resources.get_boards_calls == 0
    assert resources.created_posts[0].board_id is None


def test_board_resolution_failure_degrades_to_an_unfiled_post(tmp_path: Path) -> None:
    """Matches swil.sh's own comment: "degrades to an unfiled post if the
    endpoint is unavailable ... never blocks" -- a failed GET /boards must
    not cost the round its post."""
    persona = _persona(tmp_path, board="tech")
    resources = FakeResources()
    resources.fail("get_boards")
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    result = _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert result.outcome is ActOutcome.LANDED_ALL
    assert resources.created_posts[0].board_id is None


def test_board_lookup_miss_also_degrades_to_an_unfiled_post(tmp_path: Path) -> None:
    """`persona.board` names a slug `get_boards()` doesn't have -- a plain
    dict miss, not an `ApiError` -- must degrade the same way as an outright
    failed lookup, not raise a `KeyError` out of `run_act`."""
    persona = _persona(tmp_path, board="nonexistent-slug")
    resources = FakeResources()
    resources.board_lookup = {"tech": "board-1"}
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert resources.created_posts[0].board_id is None


def test_board_resolution_is_skipped_when_the_plan_ends_up_empty(tmp_path: Path) -> None:
    """Board resolution happens after the empty-plan/dry_run early returns
    (round.py), so a round that never reaches execution never pays the
    network call either -- proven directly, not just implied by "once per
    round"."""
    persona = _persona(tmp_path, board="tech")
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    memory_text = f"2026-08-17 | post | id={'a' * 24} | earlier\n"
    resources = FakeResources()
    result = _run(
        tmp_path, persona=persona, backend=backend, memory_text=memory_text, resources=resources
    )
    assert result.outcome is ActOutcome.VETOED_EMPTY
    assert resources.get_boards_calls == 0


# ── unsplash access_key (fix round 1, item 6) ───────────────────────────────


def test_access_key_is_threaded_into_execute_action(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`run_act` does not resolve its own Unsplash credential -- it is a
    plain, caller-supplied parameter (ruling, fix round 1 item 6). Spied at
    the `execute_action` call site (patching the name `round.py` imported
    it under) since `FakeResources` has no visibility into `access_key`
    itself -- that argument only ever reaches a real `ImageFetcher`, which
    this round never exercises (no `imageTopic` in the plan below)."""
    import swil_agent.act.round as round_module

    captured: dict[str, object] = {}
    original = round_module.execute_action

    def _spy(resources: object, action: object, **kwargs: object) -> object:
        captured.update(kwargs)
        return original(resources, action, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(round_module, "execute_action", _spy)
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    _run(tmp_path, backend=backend, access_key="unsplash-test-key")
    assert captured["access_key"] == "unsplash-test-key"


def test_access_key_defaults_to_empty_string_not_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`execute_action`'s own default is `access_key: str = ""` (routes
    straight to the Picsum fallback) -- `run_act`'s `access_key or ""` must
    never let a bare `None` reach it, which would be a `str | None` where
    `execute_action`'s signature demands `str`."""
    import swil_agent.act.round as round_module

    captured: dict[str, object] = {}
    original = round_module.execute_action

    def _spy(resources: object, action: object, **kwargs: object) -> object:
        captured.update(kwargs)
        return original(resources, action, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(round_module, "execute_action", _spy)
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    _run(tmp_path, backend=backend)  # access_key left at its default (None)
    assert captured["access_key"] == ""


# ── F4: a dry run must not contend for the account lock ────────────────────


def test_dry_run_completes_while_someone_else_holds_the_lock(tmp_path: Path) -> None:
    """A dry run executes nothing and writes nothing, so it needs no mutual
    exclusion -- and taking the lock made the documented "safe inspection
    command" actively unsafe: a dry run launched while a real Bash round was
    live made THAT round lose the acquire race and SKIP
    (`auto-run.sh:416-432` returns 75), silently costing the account its
    round.

    Mutation this catches: restoring the unconditional `with
    FileLock(act_lock_path(...))` around the whole body -- `run_act` then
    raises `LockBusy` here instead of returning a plan.
    """
    lock = act_lock_path(tmp_path, "zenith")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("999", encoding="utf-8")

    result = _run(tmp_path, dry_run=True)

    assert result.outcome is ActOutcome.PLANNER_EMPTY  # the solo-`nothing` plan
    assert result.plan is not None
    # Someone else's lock is still theirs, byte for byte.
    assert lock.read_text(encoding="utf-8") == "999"


def test_a_real_run_still_contends_for_the_lock(tmp_path: Path) -> None:
    """The other half of the F4 change: skipping the lock is scoped to
    `dry_run` ONLY. Mutation this catches: making the `nullcontext` branch
    unconditional, which would let two concurrent real rounds interleave --
    the duplicate-post/memory-corruption class the lock exists for."""
    lock = act_lock_path(tmp_path, "zenith")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text(str(os.getpid()), encoding="utf-8")
    with pytest.raises(LeaseBusy):
        _run(tmp_path, dry_run=False)


# ── F8: the agentBackend profile sync (auto-run.sh:473-494) ────────────────


def test_agent_backend_is_synced_with_the_model_tier_suffix(tmp_path: Path) -> None:
    """`"${ai_backend}${ai_model:+:$ai_model}"` -- the tier is the drift
    experiment's independent variable, and until 2026-08-01 Bash sent the
    bare backend, making every server-side record say "claude"."""
    persona = _persona(tmp_path).model_copy(update={"backend": "claude", "model": "sonnet"})
    resources = FakeResources()
    _run(tmp_path, persona=persona, resources=resources)
    assert resources.profile_patches == [{"agentBackend": "claude:sonnet"}]


def test_agent_backend_without_a_model_bullet_has_no_trailing_colon(tmp_path: Path) -> None:
    """`${ai_model:+...}` expands only for a NON-EMPTY model. Mutation this
    catches: an unconditional f-string, which ships `"claude:None"` /
    `"claude:"` for every account with no `- **Model:**` bullet -- four of
    them today (CLAUDE.md's backend-bullet census)."""
    resources = FakeResources()
    _run(tmp_path, persona=_persona(tmp_path), resources=resources)
    assert resources.profile_patches == [{"agentBackend": "claude"}]


def test_a_failed_agent_backend_sync_warns_and_the_round_continues(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Bash's own comment: a bare `|| true` with stderr to /dev/null is what
    hid a 403 on every `humans/` round for months. Non-fatal, but LOUD."""
    resources = FakeResources(update_profile_raises=ApiError(403, "x" * 400, "FORBIDDEN"))
    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        result = _run(tmp_path, resources=resources)
    assert result.outcome is ActOutcome.PLANNER_EMPTY  # the round still ran
    assert "agentBackend sync failed" in caplog.text
    # Bash truncates to 160 chars (`${backend_sync_err:0:160}`); the 400-char
    # body above proves the cap is applied rather than the message merely
    # being short.
    line = next(r.getMessage() for r in caplog.records if "agentBackend" in r.getMessage())
    assert len(line.split("agentBackend sync failed: ", 1)[1]) == 160


def test_dry_run_does_not_sync_the_agent_backend(tmp_path: Path) -> None:
    """The sync is a PATCH -- a write -- and `--dry-run` is documented as
    writing nothing."""
    resources = FakeResources()
    _run(tmp_path, resources=resources, dry_run=True)
    assert resources.profile_patches == []


# ── F3: smart mark-read (auto-run.sh:768-803) ─────────────────────────────


def _notification(
    notif_id: str, *, notif_type: str, post_id: str | None = None, comment_id: str | None = None
) -> dict[str, object]:
    item: dict[str, object] = {"id": notif_id, "type": notif_type}
    if post_id is not None:
        item["post"] = {"id": post_id}
    if comment_id is not None:
        item["comment"] = {"id": comment_id}
    return item


def test_a_plan_of_only_nothing_marks_everything_read(tmp_path: Path) -> None:
    """`auto-run.sh:786-787`: an idle agent must not be stuck rereading the
    same 8 items forever. `None` is the `{"all": true}` body."""
    resources = FakeResources()
    _run(tmp_path, resources=resources)  # default plan is a solo `nothing`
    assert resources.marked_read == [None]


def test_a_reply_marks_only_the_parent_comments_notification(tmp_path: Path) -> None:
    """The `cid` clause: a reply matches that ONE `comment.id` and nothing
    else. Mutation this catches: falling through to the postId clause for a
    reply, which would also clear `n-post` below -- exactly the
    "someone commented on X" context Bash's comment says must survive."""
    post_id = "f" * 24
    parent_id = "c" * 24
    resources = FakeResources()
    resources.notification_items = [
        _notification("n-parent", notif_type="comment", post_id=post_id, comment_id=parent_id),
        _notification("n-post", notif_type="comment", post_id=post_id, comment_id="d" * 24),
    ]
    backend = StubBackend(
        json.dumps(
            {
                "plan": [
                    {"action": "comment", "postId": post_id, "parentId": parent_id, "text": "hi"}
                ]
            }
        )
    )
    _run(tmp_path, resources=resources, backend=backend)
    assert resources.marked_read == [["n-parent"]]


def test_a_top_level_comment_marks_only_response_type_notifications_on_its_post(
    tmp_path: Path,
) -> None:
    """The `pid` clause: mention/comment/reply on that post, and only those.
    Mutation this catches: dropping the type filter, which would also clear
    the `like` and `follow` rows below."""
    post_id = "f" * 24
    resources = FakeResources()
    resources.notification_items = [
        _notification("n-mention", notif_type="mention", post_id=post_id),
        _notification("n-comment", notif_type="comment", post_id=post_id),
        _notification("n-reply", notif_type="reply", post_id=post_id),
        _notification("n-like", notif_type="like", post_id=post_id),
        _notification("n-follow", notif_type="follow"),
        _notification("n-other-post", notif_type="comment", post_id="e" * 24),
    ]
    backend = StubBackend(
        json.dumps({"plan": [{"action": "comment", "postId": post_id, "text": "hi"}]})
    )
    _run(tmp_path, resources=resources, backend=backend)
    assert resources.marked_read == [["n-mention", "n-comment", "n-reply"]]


def test_a_plan_with_no_comment_and_no_nothing_marks_nothing(tmp_path: Path) -> None:
    """There is no third branch in Bash: a lone `like` clears no
    notification. Mutation this catches: an unconditional `mark all` fallback
    at the end of the block, which would wipe unread mentions the agent never
    answered."""
    post_id = "f" * 24
    resources = FakeResources()
    resources.notification_items = [_notification("n-1", notif_type="mention", post_id=post_id)]
    backend = StubBackend(json.dumps({"plan": [{"action": "like", "postId": post_id}]}))
    result = _run(tmp_path, resources=resources, backend=backend)
    assert result.landed == 1
    assert resources.marked_read == []


def test_a_round_where_nothing_landed_marks_nothing(tmp_path: Path) -> None:
    """Bash's mark-read block sits AFTER the `landed == 0` early return
    (`auto-run.sh:762-765`), so those notifications survive to the next
    round. Mutation this catches: hoisting the call above the `landed > 0`
    guard."""
    post_id = "f" * 24
    resources = FakeResources(comment_returns_no_id=True)
    resources.notification_items = [_notification("n-1", notif_type="mention", post_id=post_id)]
    backend = StubBackend(
        json.dumps({"plan": [{"action": "comment", "postId": post_id, "text": "hi"}]})
    )
    result = _run(tmp_path, resources=resources, backend=backend)
    assert result.landed == 0
    assert resources.marked_read == []


def test_a_comment_matching_no_notification_marks_nothing_on_the_wire(tmp_path: Path) -> None:
    """`_responded_notification_ids` returning `[]` reaches
    `Resources.mark_notifications_read([])`, which sends NOTHING -- the
    server's `ids` branch is `.min(1)` and `auto-run.sh:800` guards the call
    the same way (`if [[ "$notif_ids_json" != "[]" ... ]]`).

    Added by ruling R20's fake-fidelity audit: this is the state where a fake
    that recorded the empty call would have diverged from the real method,
    and the divergence would have been invisible because no test drove it."""
    post_id = "f" * 24
    resources = FakeResources()
    # An unread notification the plan's comment does NOT respond to.
    resources.notification_items = [_notification("n-1", notif_type="like", post_id=post_id)]
    backend = StubBackend(
        json.dumps({"plan": [{"action": "comment", "postId": post_id, "text": "hi"}]})
    )
    result = _run(tmp_path, resources=resources, backend=backend)
    assert result.landed == 1
    assert resources.marked_read == []


def test_a_failed_notifications_read_degrades_to_marking_nothing(tmp_path: Path) -> None:
    """`2>/dev/null || echo '[]'` around Bash's own re-read: housekeeping
    must never turn a landed round into a failed one."""
    post_id = "f" * 24
    resources = FakeResources()
    resources.fail("notifications")
    backend = StubBackend(
        json.dumps({"plan": [{"action": "comment", "postId": post_id, "text": "hi"}]})
    )
    result = _run(tmp_path, resources=resources, backend=backend)
    assert result.outcome is ActOutcome.LANDED_ALL
    assert resources.marked_read == []


def test_dry_run_marks_no_notifications_read(tmp_path: Path) -> None:
    resources = FakeResources()
    _run(tmp_path, resources=resources, dry_run=True)
    assert resources.marked_read == []


# ── R19: a 409'd follow lands, but writes no memory line ──────────────────


def test_a_successful_follow_still_writes_its_memory_line(tmp_path: Path) -> None:
    """The other half: `swil.sh:682`'s `_remember "follow | @$USERNAME"` DOES
    run on a genuine new follow, so the line itself is correct parity and must
    not be lost while fixing the 409 case."""
    lines = _run_and_collect_memory(tmp_path, [Action(kind="follow", username="vex")])
    assert lines == ["2026-08-17 | follow | @vex"]


def test_call_succeeded_defaults_to_landed_for_every_other_kind(tmp_path: Path) -> None:
    """`_outcome` derives `call_succeeded` from `landed` unless a branch says
    otherwise, so only `follow` can ever differ. Mutation this catches:
    defaulting `call_succeeded` to a bare `True`, which would resurrect the
    memory line for every FAILED post/comment/like/echo/dm as well -- a far
    bigger contamination of `memory.md` than the one this ruling fixes."""
    lines = _run_and_collect_memory(
        tmp_path,
        [Action(kind="like", post_id="f" * 24)],
        resources=FakeResources(like_raises=ApiError(500, "boom", None)),
    )
    assert lines == []


# ── R20: the 409 path, driven through the REAL Resources ──────────────────
#
# `FakeResources(follow_raises=...)` cannot drive this case. Its `follow()`
# re-raises whatever it is handed, so the exception always reaches
# `_execute_follow`'s `except` branch -- which is precisely the thing the real
# method's CONFLICT-swallowing used to make unreachable. A fake whose
# behaviour diverges from the method it stands in for is worse than no test:
# it reports coverage OF the divergence. So these drive `run_act` with a real
# `Resources` over `httpx.MockTransport`, and the 409 comes from the wire.


def _recording_transport(
    follow_status: int,
) -> tuple[httpx.MockTransport, list[tuple[str, str]]]:
    """A transport serving every endpoint one `run_act` round touches.

    Reads (feed/notifications/conversations/contacts) answer with empty
    envelopes so `build_context` produces a valid, empty context; the only
    interesting response is `POST /users/vex/follow`, which answers
    `follow_status`. Every request is recorded as `(method, path)` so a test
    can assert the follow really was attempted rather than short-circuited
    somewhere upstream.
    """
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        seen.append((request.method, path))
        if path == "/api/v1/users/vex/follow":
            if follow_status == 204:
                return httpx.Response(204)
            return httpx.Response(
                follow_status,
                json={"error": {"code": "CONFLICT", "message": "Already following this user"}},
            )
        if path == "/api/v1/auth/me":
            return httpx.Response(200, json={"data": {"user": {"username": "zenith"}}})
        if path == "/api/v1/users/me":
            return httpx.Response(200, json={"data": {}})
        if path.endswith("/events"):
            return httpx.Response(201, json={"data": {"event": {"id": "e1"}}})
        return httpx.Response(200, json={"data": {"items": []}})

    return httpx.MockTransport(handler), seen


def _live_resources(transport: httpx.MockTransport) -> Resources:
    return Resources(ApiClient("https://example.test", ApiKeyAuth("k"), transport=transport))


def test_an_already_following_409_warns_and_writes_no_memory_line(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """RULING R20. Bash splits this across two levels and the port has to too.

    `swil.sh` runs under `set -euo pipefail` and `_curl` returns 1 for any
    status >= 400 (swil.sh:132-135), so `swil.sh follow` exits NON-ZERO on a
    409 and never reaches `_remember` (swil.sh:679-683). One level up,
    `auto-run.sh:243-252` therefore takes its `else` branch -- `WARN <name>
    follow @<user> failed (likely already following)` plus a `warn` lab event
    -- and then `return 0`, because "already following" is the common outcome
    and is not a failed ROUND.

    So the correct shape for a 409 is: landed, WARN, `warn` event, NO memory
    line. Python previously produced landed, DONE, `success` event, AND a
    memory line -- wrong on three counts, including mislabelling the case in
    `/lab`.

    Mutation this catches: restoring `if exc.code == "CONFLICT": return` in
    `Resources.follow`. Under it the round reports DONE, files a `success`
    event, and appends `2026-08-17 | follow | @vex`.
    """
    transport, seen = _recording_transport(409)
    persona = _persona(tmp_path)
    backend = StubBackend(_plan_json([Action(kind="follow", username="vex")]))

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.executor"):
        result = run_act_phase(
            persona=persona,
            resources=_live_resources(transport),
            backend=backend,
            memory_text="",
            agent_root=tmp_path,
            now=NOW,
            rng=random.Random(0),
            health_check=lambda: True,
        )

    assert ("POST", "/api/v1/users/vex/follow") in seen  # it really was attempted
    # Still a landed round -- `grants_dream` must not change.
    assert result.landed == 1
    assert result.attempted == 1
    assert result.outcome is ActOutcome.LANDED_ALL
    assert result.grants_dream is True
    # Bash's `else` branch, both channels.
    assert "WARN zenith follow @vex failed (likely already following)" in caplog.text
    assert "DONE zenith followed @vex" not in caplog.text
    assert "likely already following" in (result.results[0].detail or "")
    # ... and NOTHING in memory.md.
    assert not (persona.directory / "memory.md").exists()


def test_a_409_files_a_warn_lab_event_not_a_success_one(tmp_path: Path) -> None:
    """The `/lab` half of the same defect, asserted on the wire rather than
    on a fake: `emit_lab_event "cycle" "act" "warn" "follow" "follow request
    failed" "<target>"` (auto-run.sh:248). Mutation this catches: the same
    restored CONFLICT swallow, which files `success`/`followed @vex`."""
    transport, _ = _recording_transport(409)
    events: list[dict[str, Any]] = []

    def capturing(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/events"):
            events.append(_json_loads(request.content))
        return transport.handler(request)  # type: ignore[attr-defined]

    run_act_phase(
        persona=_persona(tmp_path),
        resources=_live_resources(httpx.MockTransport(capturing)),
        backend=StubBackend(_plan_json([Action(kind="follow", username="vex")])),
        memory_text="",
        agent_root=tmp_path,
        now=NOW,
        rng=random.Random(0),
        health_check=lambda: True,
    )

    follow_events = [e for e in events if e.get("action") == "follow"]
    assert [e["outcome"] for e in follow_events] == ["warn"]
    assert follow_events[0]["summary"] == "follow request failed"
    assert follow_events[0]["reason"] == "vex"


def test_a_genuine_204_follow_still_lands_dones_and_remembers(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The other half, also through the real `Resources`: `swil.sh:682`'s
    `_remember "follow | @$USERNAME"` DOES run on a genuine new follow, so
    fixing the 409 case must not cost the success case its line, its DONE, or
    its `success` event."""
    transport, seen = _recording_transport(204)
    persona = _persona(tmp_path)

    with caplog.at_level(logging.INFO, logger="swil_agent.act.executor"):
        result = run_act_phase(
            persona=persona,
            resources=_live_resources(transport),
            backend=StubBackend(_plan_json([Action(kind="follow", username="vex")])),
            memory_text="",
            agent_root=tmp_path,
            now=NOW,
            rng=random.Random(0),
            health_check=lambda: True,
        )

    assert ("POST", "/api/v1/users/vex/follow") in seen
    assert result.landed == 1
    assert "DONE zenith followed @vex" in caplog.text
    assert (persona.directory / "memory.md").read_text(encoding="utf-8").splitlines() == [
        "2026-08-17 | follow | @vex"
    ]


# ── R21: `_remember`'s SECOND lab event (swil.sh:192-202) ─────────────────
#
# `_remember` does two things per memory line, not one: it appends to
# memory.md AND fires an independent `memory/memory/success` event. So a
# single successful `post` produces TWO POSTs to /agents/{username}/events
# under Bash -- `cycle/act/success` from auto-run.sh's `emit_lab_event`, and
# `memory/memory/success` from swil.sh's `_remember`. Python emitted one.
#
# Driven on the wire rather than through `FakeResources`, for two reasons:
# the count of POSTs to /events IS the assertion, and `FakeResources
# .lab_event` can raise where the real one contractually cannot -- so a fake
# would be modelling a stricter world than production has.

_POST_ID = "aaaaaaaaaaaaaaaaaaaaaaaa"
_COMMENT_ID = "bbbbbbbbbbbbbbbbbbbbbbbb"
_TARGET_POST_ID = "cccccccccccccccccccccccc"
_CONV_ID = "dddddddddddddddddddddddd"
_MESSAGE_ID = "eeeeeeeeeeeeeeeeeeeeeeee"


def _wire_transport(
    *,
    events: list[dict[str, Any]],
    events_status: int = 201,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    contacts: tuple[str, ...] = (),
) -> httpx.MockTransport:
    """Serves every endpoint one `run_act` round touches, recording each
    `/agents/{username}/events` body into `events` in call order.

    `events_status` lets a test answer that endpoint with a failure;
    `on_event` fires at the moment the event POST is made, which is how the
    ordering test observes whether memory.md was written first.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/events"):
            body = _json_loads(request.content)
            events.append(body)
            if on_event is not None:
                on_event(body)
            if events_status >= 400:
                return httpx.Response(events_status, json={"error": {"code": "INTERNAL"}})
            return httpx.Response(events_status, json={"data": {"event": {"id": "e1"}}})
        if path == "/api/v1/posts":
            return httpx.Response(201, json={"data": {"post": {"id": _POST_ID}}})
        if path.endswith("/comments"):
            return httpx.Response(201, json={"data": {"comment": {"id": _COMMENT_ID}}})
        if path.endswith("/like"):
            return httpx.Response(200, json={"data": {"likeCount": 1, "liked": True}})
        if path.endswith("/follow"):
            return httpx.Response(204)
        # `send_dm`'s two calls. Branch on METHOD, not just path: the same
        # `/conversations` path is a GET in `build_context` (the dm-context
        # block) and a POST here.
        if path == "/api/v1/conversations" and request.method == "POST":
            return httpx.Response(201, json={"data": {"conversation": {"id": _CONV_ID}}})
        if path.endswith("/messages"):
            return httpx.Response(201, json={"data": {"message": {"id": _MESSAGE_ID}}})
        if path == "/api/v1/users/zenith/following":
            return httpx.Response(
                200, json={"data": {"items": [{"username": c} for c in contacts]}}
            )
        if path == "/api/v1/auth/me":
            return httpx.Response(200, json={"data": {"user": {"username": "zenith"}}})
        if path == "/api/v1/users/me":
            return httpx.Response(200, json={"data": {}})
        return httpx.Response(200, json={"data": {"items": []}})

    return httpx.MockTransport(handler)


def _run_on_the_wire(tmp_path: Path, action: Action, transport: httpx.MockTransport) -> ActResult:
    return run_act_phase(
        persona=_persona(tmp_path),
        resources=_live_resources(transport),
        backend=StubBackend(_plan_json([action])),
        memory_text="",
        agent_root=tmp_path,
        now=NOW,
        rng=random.Random(0),
        health_check=lambda: True,
    )


def _memory_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in events if e.get("type") == "memory"]


def test_a_landed_post_emits_two_events_the_act_one_and_the_memory_one(
    tmp_path: Path,
) -> None:
    """`_remember` (swil.sh:192-202) fires a SECOND, independent event for
    every memory line, so one successful `post` is two POSTs to
    /agents/{username}/events -- `cycle/act/success` then
    `memory/memory/success`. Python emitted only the first, for every write
    action kind, halving what `/lab`'s memory surfaces saw.

    Captured in contract 02 §372 and then lost between the contract and the
    plan: no task covered it, no ruling decided it, no §15 row recorded it.

    Mutation this catches: deleting `_write_memory_line`'s
    `resources.lab_event(...)` call -- the list below drops to one entry.
    """
    events: list[dict[str, Any]] = []
    result = _run_on_the_wire(
        tmp_path, Action(kind="post", text="hello"), _wire_transport(events=events)
    )

    assert result.landed == 1
    assert sorted((e["type"], e["phase"], e["outcome"]) for e in events) == [
        ("cycle", "act", "success"),
        ("memory", "memory", "success"),
    ]

    # ORDER IS A KNOWN DIVERGENCE, asserted here so it stays visible rather
    # than silently blessed. Bash fires the MEMORY event first: `swil.sh
    # post` performs the write and calls `_remember` (which posts the memory
    # event) entirely inside itself, and only when it returns does
    # `auto-run.sh:175` call `emit_lab_event "cycle" "act" "success"`.
    # Python is the reverse -- `execute_action` files its act event before
    # returning, and `run_act` writes memory afterwards -- because the
    # module seam puts memory.md in `act/round.py` and lab events for
    # actions in `act/executor.py`. Both events land either way; only their
    # arrival order at /agents/{u}/events differs (spec §15.1 row 13). If
    # someone later reorders to match Bash, this assertion fails on purpose:
    # update the §15 row with it.
    assert [e["type"] for e in events] == ["cycle", "memory"]


def test_the_memory_event_carries_the_whole_note_as_its_summary(tmp_path: Path) -> None:
    """`_lab_event "memory" "memory" "success" "$action" "$note" "" ...` --
    the summary is the ENTIRE flattened note, uncapped, unlike the act
    events' 200-char cap. And `reason` is the 6th positional and is empty,
    so `LabEvent.to_wire` omits it.

    Mutation this catches: reusing the act path's `_SUMMARY_CAP`, or
    summarising anything other than the note (e.g. just the text)."""
    events: list[dict[str, Any]] = []
    _run_on_the_wire(tmp_path, Action(kind="post", text="hello"), _wire_transport(events=events))

    memory = _memory_events(events)[0]
    assert memory["summary"] == f"post | id={_POST_ID} | hello"
    assert memory["metrics"] == {}
    assert "reason" not in memory


@pytest.mark.parametrize(
    ("action", "expected_action", "expected_target"),
    [
        (Action(kind="post", text="hello"), "post", _POST_ID),
        (
            Action(kind="comment", post_id=_TARGET_POST_ID, text="hi"),
            "comment",
            _TARGET_POST_ID,
        ),
        (Action(kind="like", post_id=_TARGET_POST_ID), "like", _TARGET_POST_ID),
        (Action(kind="follow", username="vex"), "follow", None),
        (Action(kind="echo", post_id=_TARGET_POST_ID), None, _POST_ID),
    ],
)
def test_the_memory_events_action_and_target_id_per_kind(
    tmp_path: Path,
    action: Action,
    expected_action: str | None,
    expected_target: str | None,
) -> None:
    """The two derivations `_remember` makes from the note, on every action
    kind that can reach it:

      * `action` = `awk -F'|' '{print $1}' | xargs`, kept only when it is in
        the whitelist `post|comment|like|follow|unfollow|delete|nothing`
        (swil.sh:196). `echo` is NOT in that whitelist, so its memory event
        carries no action at all -- transcribed, not tidied.
      * `targetId` = the FIRST `(id|postId|commentId)=[a-f0-9]{24}` match
        (swil.sh:193). A `comment` note contains both `postId=` and
        `commentId=`, and `head -1` takes the postId; a `follow` note has no
        24-hex id anywhere, so the field is omitted entirely.

    Mutations this catches: adding `echo`/`dm` to the whitelist; dropping
    `head -1` (a comment would then report its commentId); anchoring the
    regex (nothing would ever match).
    """
    events: list[dict[str, Any]] = []
    _run_on_the_wire(tmp_path, action, _wire_transport(events=events))

    memory = _memory_events(events)[0]
    assert memory.get("action") == expected_action
    assert memory.get("targetId") == expected_target


def test_the_memory_line_is_on_disk_before_the_event_is_posted(tmp_path: Path) -> None:
    """ORDER IS THE CONTRACT. `_remember` appends to memory.md (swil.sh:190)
    BEFORE calling `_lab_event` (swil.sh:197/200), so an events outage still
    leaves the line on disk -- and memory.md, not `/lab`, is what the next
    dream reads.

    Observed by reading the file from inside the events handler, at the
    moment the POST is made. Mutation this catches: swapping the two
    statements in `_write_memory_line`."""
    events: list[dict[str, Any]] = []
    persona_dir = tmp_path / "agents" / "zenith"
    seen_at_memory_event: list[str] = []

    def snapshot(body: dict[str, Any]) -> None:
        if body.get("type") != "memory":
            return
        path = persona_dir / "memory.md"
        seen_at_memory_event.append(path.read_text(encoding="utf-8") if path.is_file() else "")

    _run_on_the_wire(
        tmp_path,
        Action(kind="post", text="hello"),
        _wire_transport(events=events, on_event=snapshot),
    )

    # Keyed on the MEMORY event rather than on a positional index, so this
    # keeps testing what it says even if the act/memory event order is ever
    # changed to match Bash's (see the ordering note above).
    assert seen_at_memory_event == [f"2026-08-17 | post | id={_POST_ID} | hello\n"]


def test_a_failing_event_post_does_not_fail_the_round(tmp_path: Path) -> None:
    """Bash ends `_lab_event`'s curl with `|| true` (swil.sh:245), so a lab
    event can never fail a round -- and a lab event that COULD would be a
    worse bug than the missing event this ruling adds.

    Driven at 500 on the wire rather than through a fake that raises,
    because the swallow lives in `Resources.lab_event` and that is the code
    under test here. Mutation this catches: removing that method's
    `except ApiError: return`."""
    events: list[dict[str, Any]] = []
    result = _run_on_the_wire(
        tmp_path,
        Action(kind="post", text="hello"),
        _wire_transport(events=events, events_status=500),
    )

    assert result.landed == 1
    assert result.outcome is ActOutcome.LANDED_ALL
    assert len(events) == 2  # both were attempted
    assert (tmp_path / "agents" / "zenith" / "memory.md").is_file()


# ── the note -> event mapping, including the kinds no act round reaches ───


def test_memory_event_summary_is_uncapped() -> None:
    """`_remember` passes the WHOLE note as `summary` -- there is no
    truncation anywhere in swil.sh:192-202, unlike auto-run.sh's act events
    which slice `${text:0:200}`.

    A UNIT test with a synthetic long note, deliberately: no note a normal
    round produces is long enough to show this. `_memory_note` caps its text
    component at `_MEMORY_PREVIEW_CAP` (80), and the longest BOUNDED shape is
    the full comment note -- `comment | postId=<24> commentId=<24>
    parentId=<24> | <80>` = 193 chars -- so a 200-char cap is invisible
    through `run_act`, which is exactly why the wire test above cannot carry
    this assertion and this one exists.

    One shape is NOT bounded: `post`'s `[img:<topic>]` tag interpolates
    `image_topic` with no cap (`_memory_field`, matching `swil.sh:458`'s
    equally uncapped `${IMAGE_TOPIC:+[img:$IMAGE_TOPIC] }`), so a long enough
    planner-supplied topic pushes the note past the server's
    `summary: z.string().trim().min(1).max(500)`
    (`runtime/runtime.schemas.ts`) and the event 400s. Deliberately NOT capped here
    (ruling R22): Bash is uncapped too and both runtimes swallow that 400
    identically (`|| true` at swil.sh:246, `Resources.lab_event`'s
    `except ApiError`), so capping would be a Python-only divergence that
    made the two runtimes send different bodies for the same action. Recorded
    as spec §15.2 row 18 instead.

    Mutation this catches: `summary=note[:_SUMMARY_CAP]`, i.e. copying the
    act path's cap onto a path Bash does not cap."""
    note = "post | id=" + _POST_ID + " | " + ("x" * 400)
    assert _memory_event(note).summary == note
    assert len(_memory_event(note).summary) > 200


@pytest.mark.parametrize(
    ("note", "expected_action"),
    [
        (f"post | id={_POST_ID} | hi", "post"),
        (f"comment | postId={_TARGET_POST_ID} commentId={_COMMENT_ID} | hi", "comment"),
        (f"like | postId={_TARGET_POST_ID}", "like"),
        ("follow | @vex", "follow"),
        ("unfollow | @vex", "unfollow"),
        (f"delete | id={_POST_ID}", "delete"),
        ("nothing | anything", "nothing"),
        (f"echo | id={_POST_ID} echoOf={_TARGET_POST_ID}", None),
        (f"dm | to=vex conversationId={_COMMENT_ID} | hi", None),
        ("set-tags | a,b", None),
    ],
)
def test_memory_event_whitelist_covers_every_verb_swil_sh_lists(
    note: str, expected_action: str | None
) -> None:
    """The whole whitelist, including `unfollow`/`delete`/`nothing`, which no
    act round can reach today (`ActionKind` has no unfollow or delete, and
    `nothing` never writes a memory line at all) but which `swil.sh:196`
    lists -- so the transcription is complete rather than complete-enough for
    the reachable subset. `set-tags` stands in for the `*)` fallthrough.

    Mutation this catches: dropping any verb from `_MEMORY_EVENT_ACTIONS`,
    or emitting `action=""` as a literal instead of omitting the field."""
    assert _memory_event(note).action == expected_action


@pytest.mark.parametrize(
    ("note", "expected"),
    [
        (f"post | id={_POST_ID} | hi", _POST_ID),
        (f"comment | postId={_TARGET_POST_ID} commentId={_COMMENT_ID} | hi", _TARGET_POST_ID),
        ("follow | @vex", None),
        # `conversationId` is NOT `id`: grep -E is case-sensitive, so a dm's
        # note has no match at all.
        (f"dm | to=vex conversationId={_COMMENT_ID} | hi", None),
        # 23 hex chars -- one short of the {24} the regex demands.
        ("post | id=aaaaaaaaaaaaaaaaaaaaaaa | hi", None),
        # Uppercase hex is outside [a-f0-9].
        (f"post | id={'A' * 24} | hi", None),
    ],
)
def test_memory_event_target_id_matches_the_grep(note: str, expected: str | None) -> None:
    """`grep -Eo '(id|postId|commentId)=[a-f0-9]{24}' | head -1 | cut -d= -f2`
    -- exactly. Mutation this catches: relaxing `{24}` to `+`, or adding
    `conversationId` to the alternation, either of which would start filing
    dm and short-id events under a targetId Bash leaves empty."""
    assert _memory_event(note).target_id == expected


# ── R22: the two kinds nothing covered ────────────────────────────────────


def test_a_dm_puts_the_body_preview_in_the_memory_event_but_not_the_act_one(
    tmp_path: Path,
) -> None:
    r"""`dm` was the one action kind with no end-to-end test, and the one
    whose two events differ MOST from each other.

    `auto-run.sh:287-289`'s own event carries the recipient only
    (`"→@vex"`) -- deliberately, so private conversations stay off that
    surface. But `_remember` fires a SECOND event whose summary is the whole
    note, and `swil.sh:711` builds that note as
    `dm | to=$RECIPIENT conversationId=$CONV_ID | ${TEXT:0:80}` -- i.e. the
    first 80 characters of the message body DO reach
    `POST /agents/{username}/events`, in both runtimes.

    `swil.sh:708-710`'s comment says the opposite ("carries the recipient
    but never the body"); it is true of auto-run.sh's event and false of the
    `_remember` call three lines below it. `agent/scripts/` is frozen so
    that comment stays, and this test is where the real behaviour is written
    down.

    Mutation this catches: sending anything other than the full note as the
    memory event's summary for a dm (e.g. copying the act event's
    recipient-only string, on the theory that the docstring was right).
    """
    events: list[dict[str, Any]] = []
    # Longer than the 80-char preview so the cap is visible, and NOT a
    # doubled string -- "x"*100 is "x"*50 twice, which `collapse_doubled_text`
    # would halve before the cap ever applied, making the assertion below
    # pass for the wrong reason.
    body = "y" + "x" * 99
    result = _run_on_the_wire(
        tmp_path,
        Action(kind="dm", username="vex", text=body),
        _wire_transport(events=events, contacts=("vex",)),
    )
    assert result.landed == 1

    act = next(e for e in events if e["type"] == "cycle")
    memory = next(e for e in events if e["type"] == "memory")

    assert act["summary"] == "→@vex"  # recipient only, no body
    assert memory["summary"] == f"dm | to=vex conversationId={_CONV_ID} | {'y' + 'x' * 79}"
    # `dm` is not in swil.sh:196's whitelist, and `conversationId` does not
    # match the `(id|postId|commentId)=` grep -- so both facets are absent.
    assert "action" not in memory
    assert "targetId" not in memory


def test_the_memory_note_is_flattened_before_it_is_written_or_sent(tmp_path: Path) -> None:
    r"""Pins the `_flatten_note` CALL SITE, which nothing else did -- deleting
    `note = _flatten_note(note)` from `_write_memory_line` left the whole
    suite green.

    A TAB in the comment text is the reachable way in. `_memory_field`
    collapses runs of literal SPACES only (`_WHITESPACE_RUN` is `r" {2,}"`,
    mirroring Bash's `sed 's/  */ /g'`), so a tab survives into the note and
    is normalised only by `_flatten_note`'s `\s+`. Both consumers must see
    the flattened value, because Bash derives both from the same `$note`
    variable (swil.sh:189-190, then :197).

    Reachable in principle -- the planner returns JSON, which can carry
    `\t` -- though not observed in practice (0 tabs across 5,424 real memory
    lines).

    NOTE the platform divergence recorded as spec §15.1 row 14: Bash's
    `sed 's/[[:space:]]\+/ /g'` collapses whitespace runs on GNU sed but NOT
    on the BSD sed this runtime actually runs on, where `\+` is a literal
    plus. Python keeps the sane behaviour on purpose; the row exists so a
    Linux deploy does not silently change Bash's.
    """
    events: list[dict[str, Any]] = []
    _run_on_the_wire(
        tmp_path,
        Action(kind="comment", post_id=_TARGET_POST_ID, text="hello\tworld"),
        _wire_transport(events=events),
    )

    expected = f"comment | postId={_TARGET_POST_ID} commentId={_COMMENT_ID} | hello world"
    assert (tmp_path / "agents" / "zenith" / "memory.md").read_text(
        encoding="utf-8"
    ) == f"2026-08-17 | {expected}\n"
    memory = next(e for e in events if e["type"] == "memory")
    assert memory["summary"] == expected


# ── memory rotation at the end of a real round ──────────────────────────────


def _long_memory(persona: Persona, count: int) -> list[str]:
    lines = [f"2026-08-16 | old {i}" for i in range(count)]
    (persona.directory / "memory.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return lines


def test_a_real_round_rotates_an_oversized_memory_file(tmp_path: Path) -> None:
    persona = _persona(tmp_path)
    lines = _long_memory(persona, 350)

    _run(tmp_path, persona=persona)

    live = (persona.directory / "memory.md").read_text(encoding="utf-8").splitlines()
    archive = (persona.directory / "memory.archive.md").read_text(encoding="utf-8").splitlines()
    assert len(live) == 200
    assert archive == lines[:150]


def test_a_dry_run_never_rotates_memory(tmp_path: Path) -> None:
    persona = _persona(tmp_path)
    _long_memory(persona, 350)

    _run(tmp_path, persona=persona, dry_run=True)

    assert len((persona.directory / "memory.md").read_text(encoding="utf-8").splitlines()) == 350
    assert not (persona.directory / "memory.archive.md").exists()


def test_an_empty_plan_round_still_rotates(tmp_path: Path) -> None:
    persona = _persona(tmp_path)
    _long_memory(persona, 301)
    backend = StubBackend('{"plan":[]}')

    result = _run(tmp_path, persona=persona, backend=backend)

    assert result.outcome is ActOutcome.PLANNER_EMPTY
    assert (persona.directory / "memory.archive.md").exists()


def test_a_rotation_failure_warns_and_never_changes_the_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import swil_agent.act.round as act_round

    def boom(path: Path) -> int:
        raise OSError("read-only fs")

    monkeypatch.setattr(act_round, "rotate_memory", boom)
    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        result = _run(tmp_path)

    assert result.outcome is ActOutcome.PLANNER_EMPTY
    assert "memory rotation failed" in caplog.text


def test_a_held_dream_lock_skips_rotation(tmp_path: Path) -> None:
    """A standalone `dream` appends to memory.md under the dream lock only, so
    rotating under the act lock alone could drop its line between the read
    and the replace. The rotation waits for the next round instead."""
    persona = _persona(tmp_path)
    _long_memory(persona, 350)
    lock = dream_lock_path(tmp_path, persona.directory.name)
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text(f"{os.getpid()}\n", encoding="utf-8")

    _run(tmp_path, persona=persona)

    assert len((persona.directory / "memory.md").read_text(encoding="utf-8").splitlines()) >= 350
    assert not (persona.directory / "memory.archive.md").exists()
    assert lock.exists(), "the dream's lock must not be released by the act round"


def test_a_rotation_that_takes_the_dream_lock_releases_it(tmp_path: Path) -> None:
    persona = _persona(tmp_path)
    _long_memory(persona, 301)

    _run(tmp_path, persona=persona)

    assert (persona.directory / "memory.archive.md").exists()
    assert not dream_lock_path(tmp_path, persona.directory.name).exists()


def test_a_non_utf8_memory_file_warns_and_never_changes_the_outcome(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    persona = _persona(tmp_path)
    (persona.directory / "memory.md").write_bytes(b"\xff\xfe bad\n" * 400)

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        result = _run(tmp_path, persona=persona)

    assert result.outcome is ActOutcome.PLANNER_EMPTY
    assert "memory rotation failed" in caplog.text
