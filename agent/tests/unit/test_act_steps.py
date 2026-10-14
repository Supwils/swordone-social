"""Tests for the individual STEPS of `swil_agent.act.round` (Plan 3 Task 5).

`test_act_round.py` is the oracle for the composition: it drives `run_act`
end to end and must pass unchanged across any regrouping of the steps. This
file is the complement, and it exists because the oracle cannot see two
classes of defect:

  * **A step called directly.** Task 7's graph nodes call `login_step`,
    `execute_step`, `finalize_step` and friends themselves. A guard that
    lives in `run_act`'s body instead of in the step protects the CLI path
    and nothing else -- most sharply for `dry_run`, since Stage 3's shadow
    round drives 23 live accounts and `execute_step` performs 100% of a
    round's writes.
  * **A boundary that moved.** A mutation that moves a step boundary passes
    an end-to-end suite; each is pinned below with the mutation it kills
    named in the docstring.

Ordering is observed through a `Resources` double that records every call on
a shared trace, not through a `recorder=` parameter on the production
functions (the same convention `test_dream_round.py` follows, ruling R8).
"""

from __future__ import annotations

import json
import logging
import random
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.act.round import (
    context_step,
    execute_step,
    finalize_step,
    guardrail_step,
    login_step,
    plan_step,
    run_act,
    sync_backend_step,
)
from swil_agent.locks import FileLock, act_lock_path
from swil_agent.models import Action, ActOutcome, Persona, Plan, RhythmPolicy

from ._runners import FakeResources, SilentBackend, StubBackend, make_persona

NOW = datetime(2026, 8, 17, 10, 0, 0)
TODAY = "2026-08-17"


def _persona(
    tmp_path: Path,
    *,
    backend: str = "claude",
    username: str = "zenith",
    dir_name: str = "zenith",
    board: str = "",
    model: str | None = None,
) -> Persona:
    directory = tmp_path / "agents" / dir_name
    directory.mkdir(parents=True, exist_ok=True)
    return make_persona(
        username=username,
        directory=directory,
        backend=backend,
        model=model,
        board=board,
        prompt="PERSONA",
    )


class TracingResources(FakeResources):
    """`FakeResources` plus an ordered, cross-method call trace.

    `FakeResources` records each call KIND in its own list (`calls`,
    `profile_patches`, `marked_read`, `lab_events`), which answers "did this
    happen" but never "did it happen before that". Every mutation this file
    kills is a reordering, so the trace is the instrument -- entries are
    coarse strings, since what is under test is sequence, not payload.

    `lock_path`, if given, makes every `update_profile` call record whether
    the account's lock file existed at that instant -- the only way to
    observe from outside that the `agentBackend` sync happened INSIDE the
    lock, since the lock is a file whose existence is the whole signal.
    """

    def __init__(self, *, lock_path: Path | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.trace: list[str] = []
        self.lock_path = lock_path
        self.lock_held_during_patch: list[bool] = []

    def update_profile(self, patch: dict[str, Any]) -> None:
        self.trace.append("update_profile")
        if self.lock_path is not None:
            self.lock_held_during_patch.append(self.lock_path.exists())
        super().update_profile(patch)

    def feed_global(self, limit: int, sort: str, since: str | None = None) -> list[dict[str, Any]]:
        self.trace.append(f"feed_global:{sort}")
        return super().feed_global(limit, sort, since)

    def notifications(self, limit: int, unread_only: bool = True) -> list[dict[str, Any]]:
        self.trace.append("notifications")
        return super().notifications(limit, unread_only)

    def contacts(self) -> list[str]:
        self.trace.append("contacts")
        return super().contacts()

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        self.trace.append("conversations")
        return super().conversations(limit)

    def get_boards(self) -> dict[str, str]:
        self.trace.append("get_boards")
        return super().get_boards()

    def like_post(self, post_id: str) -> None:
        self.trace.append(f"like_post:{post_id}")
        super().like_post(post_id)

    def create_post(
        self,
        text: str,
        board_id: str | None = None,
        image: tuple[str, bytes] | None = None,
        echo_of: str | None = None,
    ) -> str:
        self.trace.append("create_post")
        return super().create_post(text, board_id, image, echo_of)

    def mark_notifications_read(self, ids: list[str] | None = None) -> None:
        self.trace.append("mark_notifications_read")
        super().mark_notifications_read(ids)

    def lab_event(self, username: str, event: Any) -> None:
        self.trace.append(f"lab_event:{event.type}/{event.phase}")
        super().lab_event(username, event)


def _plan_json(*actions: dict[str, str]) -> str:
    return json.dumps({"plan": list(actions)})


def _run(
    tmp_path: Path,
    *,
    persona: Persona | None = None,
    resources: FakeResources | None = None,
    backend: Any = None,
    memory_text: str = "",
    dry_run: bool = False,
    **kwargs: Any,
) -> Any:
    return run_act(
        persona=persona or _persona(tmp_path),
        resources=resources if resources is not None else FakeResources(),
        backend=backend or StubBackend('{"plan":[{"action":"nothing"}]}'),
        memory_text=memory_text,
        agent_root=tmp_path,
        now=NOW,
        rng=random.Random(0),
        health_check=lambda: True,
        dry_run=dry_run,
        **kwargs,
    )


# ── login_step ──────────────────────────────────────────────────────────────


def test_login_step_offline_hands_back_no_real_lock(tmp_path: Path) -> None:
    """An offline probe must yield a lock that CANNOT touch the filesystem.

    `run_act` cannot catch this on its own -- it returns `OFFLINE` before it
    ever enters `login.lock`, and `FileLock.__init__` writes nothing -- so
    the hazard lands on the second caller: a Task 7 node doing `with
    login.lock:` without branching on `online` would create
    `.agent-state/lock_<name>`. During Stages 3-4 a concurrent Bash round
    then hits `SKIP ... -- locked` and loses BOTH its act and its dream.

    Mutation this kills: returning `FileLock(act_lock_path(...))` on the
    offline branch (or hoisting the lock choice above the probe).
    """
    step = login_step(
        persona=_persona(tmp_path),
        agent_root=tmp_path,
        health_check=lambda: False,
    )

    assert step.online is False
    assert isinstance(step.lock, nullcontext)
    assert not isinstance(step.lock, FileLock)
    with step.lock:
        pass
    assert not act_lock_path(tmp_path, "zenith").exists()


def test_login_step_online_locks_under_the_directory_name_not_the_username(
    tmp_path: Path,
) -> None:
    """Bash's `agent_name` is `basename "$agent_dir"` (`auto-run.sh:437`),
    never the `Username` bullet -- the two diverge in the documented "stray
    agents/<name> dir shadows a humans/ account" case, and a lock computed
    from the wrong one voids cross-runtime exclusion with the suite green."""
    persona = _persona(tmp_path, username="zenith", dir_name="zenith_dir")

    step = login_step(persona=persona, agent_root=tmp_path, health_check=lambda: True)

    assert step.online is True
    assert step.agent_name == "zenith_dir"
    assert isinstance(step.lock, FileLock)
    with step.lock:
        assert act_lock_path(tmp_path, "zenith_dir").exists()
        assert not act_lock_path(tmp_path, "zenith").exists()
    assert not act_lock_path(tmp_path, "zenith_dir").exists()


def test_login_step_dry_run_takes_no_lock(tmp_path: Path) -> None:
    """F4: a dry run acquires NOTHING, so the documented "safe inspection
    command" cannot cost a live Bash round its lock."""
    step = login_step(
        persona=_persona(tmp_path),
        agent_root=tmp_path,
        health_check=lambda: True,
        dry_run=True,
    )

    assert step.online is True
    assert isinstance(step.lock, nullcontext)
    with step.lock:
        pass
    assert not act_lock_path(tmp_path, "zenith").exists()


# ── sync_backend_step (M1/M3: the boundary my brief got wrong) ──────────────


def test_sync_backend_step_writes_the_backend_and_model_tier(tmp_path: Path) -> None:
    resources = FakeResources()

    sync_backend_step(
        resources=resources,
        persona=_persona(tmp_path, backend="claude", model="sonnet"),
        agent_name="zenith",
    )

    assert resources.profile_patches == [{"agentBackend": "claude:sonnet"}]


def test_sync_backend_step_is_inert_under_dry_run(tmp_path: Path) -> None:
    """The guard travels with the step, not with whichever caller remembers
    it -- this is a PATCH against a live account."""
    resources = FakeResources()

    sync_backend_step(
        resources=resources,
        persona=_persona(tmp_path),
        agent_name="zenith",
        dry_run=True,
    )

    assert resources.profile_patches == []


@pytest.mark.parametrize(
    ("backend", "expected_outcome"),
    [
        (SilentBackend(), ActOutcome.BACKEND_UNAVAILABLE),
        (StubBackend('{"plan":[]}'), ActOutcome.PLANNER_EMPTY),
    ],
)
def test_the_backend_sync_still_happens_on_a_round_that_returns_early(
    tmp_path: Path, backend: Any, expected_outcome: ActOutcome
) -> None:
    """M1 (the brief's own instruction: defer the sync to `finalize_step`).

    Deferring it drops the PATCH ENTIRELY on every early-return path --
    backend-unavailable, planner-empty, vetoed-empty -- and the whole
    902-test suite stays green. `agentBackend` is the drift experiment's
    independent variable and empty-plan rounds are common on this roster, so
    the field would have gone stale on exactly the accounts under study.
    """
    resources = FakeResources()

    result = _run(tmp_path, resources=resources, backend=backend)

    assert result.outcome is expected_outcome
    assert resources.profile_patches == [{"agentBackend": "claude"}]


def test_the_backend_sync_still_happens_on_a_vetoed_empty_round(tmp_path: Path) -> None:
    """M1, third early-return path: a DM to someone not in contacts is
    stripped by the contacts guardrail. Codex is no longer allow-listed
    (loop-engine spec §7); the veto still has to fire the backend sync."""
    resources = FakeResources()
    persona = _persona(tmp_path, backend="codex")
    backend = StubBackend(_plan_json({"action": "dm", "username": "vex", "text": "hi"}))

    result = _run(tmp_path, persona=persona, resources=resources, backend=backend)

    assert result.outcome is ActOutcome.VETOED_EMPTY
    assert resources.profile_patches == [{"agentBackend": "codex"}]


def test_the_backend_sync_precedes_every_other_call_of_the_round(tmp_path: Path) -> None:
    """M1's other half: relocating the sync past the round's reads/writes.

    Bash PATCHes at `auto-run.sh:473-494`, before any context is built, so
    the sync is the FIRST call a round makes. A round that syncs at the end
    reports a backend the round did not run under if it dies mid-way.
    """
    resources = TracingResources()
    backend = StubBackend(_plan_json({"action": "like", "postId": "a" * 24}))

    _run(tmp_path, resources=resources, backend=backend)

    assert resources.trace[0] == "update_profile"
    assert "update_profile" not in resources.trace[1:]


def test_the_backend_sync_happens_while_the_account_lock_is_held(tmp_path: Path) -> None:
    """M3: hoisting the sync above `with login.lock:`.

    Silent in a single process and invisible to every assertion about WHAT
    was patched -- but the PATCH would then race a concurrent Bash round for
    the same account's profile, which is the entire reason Bash does it
    after `acquire_lock`.
    """
    resources = TracingResources(lock_path=act_lock_path(tmp_path, "zenith"))

    _run(tmp_path, resources=resources)

    assert resources.lock_held_during_patch == [True]


def test_a_dry_run_syncs_nothing_and_never_creates_the_lock(tmp_path: Path) -> None:
    resources = TracingResources(lock_path=act_lock_path(tmp_path, "zenith"))

    _run(tmp_path, resources=resources, dry_run=True)

    assert resources.profile_patches == []
    assert resources.lock_held_during_patch == []
    assert not act_lock_path(tmp_path, "zenith").exists()


# ── context_step ────────────────────────────────────────────────────────────


def test_context_step_feeds_the_rhythm_the_count_it_just_computed(tmp_path: Path) -> None:
    """The two calls are one step because `decide_rhythm`'s `posts_today` is
    `ctx.today_post_count`. Mutation this kills: passing a re-derived or
    zero count -- the default ceiling is 1, so a round with one post already
    on record must come back `NO_POST` whatever the roll."""
    memory = f"{TODAY} | post | id=abc | hello\n"

    step = context_step(
        resources=FakeResources(),
        persona=_persona(tmp_path),
        memory_text=memory,
        now=NOW,
        rng=random.Random(0),
        post_probability=100,
    )

    assert step.context.today_post_count == 1
    assert step.rhythm.policy is RhythmPolicy.NO_POST
    assert step.rhythm.post_ceiling == 1


def test_context_step_threads_the_configured_probability_and_ceiling(tmp_path: Path) -> None:
    memory = f"{TODAY} | post | id=abc | hello\n"

    step = context_step(
        resources=FakeResources(),
        persona=_persona(tmp_path),
        memory_text=memory,
        now=NOW,
        rng=random.Random(0),
        post_probability=100,
        post_ceiling=2,
    )

    assert step.rhythm.policy is RhythmPolicy.MUST_POST
    assert step.rhythm.post_probability == 100
    assert step.rhythm.post_ceiling == 2


def test_context_step_defaults_match_the_settings_defaults() -> None:
    from swil_agent.act import round as act_round
    from swil_agent.config import Settings

    settings = Settings()
    assert act_round.DEFAULT_POST_PROBABILITY == settings.post_probability == 60
    assert act_round.DEFAULT_POST_CEILING_PER_DAY == settings.post_ceiling_per_day == 1


def test_context_step_threads_the_era_start_into_every_feed_read(tmp_path: Path) -> None:
    era = datetime(2026, 10, 15, tzinfo=UTC)
    resources = FakeResources()

    context_step(
        resources=resources,
        persona=_persona(tmp_path),
        memory_text="",
        now=NOW,
        rng=random.Random(0),
        era_start=era,
    )

    assert resources.since_calls == [("feed_global", era.isoformat())] * 2


def test_context_step_files_no_lab_event(tmp_path: Path) -> None:
    """The Era 2 board-read row is gone: reading writes nothing."""
    resources = FakeResources()
    context_step(
        resources=resources,
        persona=_persona(tmp_path, board="living"),
        memory_text="",
        now=NOW,
        rng=random.Random(0),
    )
    assert resources.lab_events == []
    assert resources.feed_board_calls == []


def test_run_act_threads_its_rhythm_settings_into_the_context_step(tmp_path: Path) -> None:
    result = _run(tmp_path, post_probability=0, post_ceiling=5)
    assert result.rhythm is not None
    assert result.rhythm.policy is RhythmPolicy.NO_POST
    assert result.rhythm.post_probability == 0
    assert result.rhythm.post_ceiling == 5


def test_run_act_threads_its_era_start_into_the_feed_reads(tmp_path: Path) -> None:
    era = datetime(2026, 10, 15, tzinfo=UTC)
    resources = FakeResources()
    _run(tmp_path, resources=resources, era_start=era)
    assert ("feed_global", era.isoformat()) in resources.since_calls
    assert all(since == era.isoformat() for _, since in resources.since_calls)


# ── plan_step ───────────────────────────────────────────────────────────────


def test_plan_step_sends_the_rhythms_guidance_not_another_of_its_fields(
    tmp_path: Path,
) -> None:
    """`RhythmDecision` carries three strings and the planner wants exactly
    one of them. Handing it `prefer_non_post` typechecks, runs, and silently
    changes every prompt the roster sees -- so the choice is made in one
    place and pinned here."""
    persona = _persona(tmp_path)
    ctx_step = context_step(
        resources=FakeResources(),
        persona=persona,
        memory_text=f"{TODAY} | post | id=abc | hello\n",
        now=NOW,
        rng=random.Random(0),
    )
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')

    plan = plan_step(
        backend=backend,
        persona=persona,
        context=ctx_step.context,
        rhythm=ctx_step.rhythm,
    )

    assert plan is not None
    assert backend.last is not None
    assert ctx_step.rhythm.guidance in backend.last.user
    assert ctx_step.rhythm.prefer_non_post != ctx_step.rhythm.guidance


def test_plan_step_returns_none_when_the_backend_produces_nothing(tmp_path: Path) -> None:
    persona = _persona(tmp_path)
    ctx_step = context_step(
        resources=FakeResources(),
        persona=persona,
        memory_text="",
        now=NOW,
        rng=random.Random(0),
    )

    plan = plan_step(
        backend=SilentBackend(),
        persona=persona,
        context=ctx_step.context,
        rhythm=ctx_step.rhythm,
    )

    assert plan is None


# ── guardrail_step ──────────────────────────────────────────────────────────


def test_guardrail_step_performs_no_api_calls(tmp_path: Path) -> None:
    """Task 7 requires the `guardrail` node to be pure. The contacts list it
    filters dms against comes from the context the planner was SHOWN, never
    a fresh read -- a re-read could return a different set and veto a dm the
    plan was entitled to make."""
    resources = TracingResources()
    persona = _persona(tmp_path)
    ctx_step = context_step(
        resources=resources,
        persona=persona,
        memory_text="",
        now=NOW,
        rng=random.Random(0),
    )
    resources.trace.clear()
    plan = Plan(actions=[Action(kind="like", post_id="a" * 24)])

    step = guardrail_step(
        plan=plan, persona=persona, rhythm=ctx_step.rhythm, context=ctx_step.context
    )

    assert resources.trace == []
    assert step.empty_outcome is None
    assert step.solo_nothing is False
    assert [a.kind for a in step.actions] == ["like"]


def test_guardrail_step_labels_a_dropped_plan_vetoed_and_an_absent_one_empty(
    tmp_path: Path,
) -> None:
    """The one distinction Bash cannot make: it logs both as `planned:
    nothing`, which is what left three codex accounts uninterpretable on
    2026-08-16. Codex is no longer allow-listed (loop-engine spec §7); a
    DM to someone not in contacts is the veto that still empties a plan."""
    persona = _persona(tmp_path, backend="codex")
    ctx_step = context_step(
        resources=FakeResources(),
        persona=persona,
        memory_text="",
        now=NOW,
        rng=random.Random(0),
    )

    dropped = guardrail_step(
        plan=Plan(actions=[Action(kind="dm", username="vex", text="hi")]),
        persona=persona,
        rhythm=ctx_step.rhythm,
        context=ctx_step.context,
    )
    absent = guardrail_step(
        plan=Plan(actions=[]),
        persona=persona,
        rhythm=ctx_step.rhythm,
        context=ctx_step.context,
    )

    assert dropped.empty_outcome is ActOutcome.VETOED_EMPTY
    assert dropped.vetoed != []
    assert absent.empty_outcome is ActOutcome.PLANNER_EMPTY
    assert absent.vetoed == []


def test_guardrail_step_flags_a_surviving_lone_nothing(tmp_path: Path) -> None:
    """`solo_nothing` is not an `empty_outcome`: the action survives and is
    still executed, so its lab event and log line fire the way Bash's do."""
    persona = _persona(tmp_path)
    ctx_step = context_step(
        resources=FakeResources(),
        persona=persona,
        memory_text="",
        now=NOW,
        rng=random.Random(0),
    )

    step = guardrail_step(
        plan=Plan(actions=[Action(kind="nothing")]),
        persona=persona,
        rhythm=ctx_step.rhythm,
        context=ctx_step.context,
    )

    assert step.empty_outcome is None
    assert step.solo_nothing is True
    assert [a.kind for a in step.actions] == ["nothing"]


# ── execute_step ────────────────────────────────────────────────────────────


def test_execute_step_writes_each_actions_memory_line_before_the_next_write(
    tmp_path: Path,
) -> None:
    """M2: batching the memory writes after the execute loop.

    Bash's `_remember` runs inside `swil.sh`'s own per-action case, so action
    N's `memory/memory/success` event is POSTed before action N+1's write
    goes out. Batching reorders every memory event to the end of the round
    and changes what survives a crash mid-round -- and the whole
    pre-existing suite stays green, because the return value is identical.
    """
    resources = TracingResources()
    persona = _persona(tmp_path)
    actions = [
        Action(kind="like", post_id="a" * 24),
        Action(kind="like", post_id="b" * 24),
    ]

    step = execute_step(
        resources=resources,
        persona=persona,
        actions=actions,
        agent_name="zenith",
        now=NOW,
    )

    assert step.landed == 2
    first_memory_event = resources.trace.index("lab_event:memory/memory")
    second_write = resources.trace.index(f"like_post:{'b' * 24}")
    assert first_memory_event < second_write, resources.trace
    assert (persona.directory / "memory.md").read_text(encoding="utf-8").count("\n") == 2


def test_execute_step_is_inert_under_dry_run(tmp_path: Path) -> None:
    """The step that performs 100% of a round's writes must honour the flag
    ITSELF. Stage 3 is a `--dry-run` shadow round over 23 live accounts: a
    caller that threaded `dry_run` into every step that accepted one, and
    found this one did not, would post for real.
    """
    resources = TracingResources()
    persona = _persona(tmp_path, board="tech")
    resources.board_lookup = {"tech": "board-1"}

    step = execute_step(
        resources=resources,
        persona=persona,
        actions=[Action(kind="post", text="hello")],
        agent_name="zenith",
        now=NOW,
        dry_run=True,
    )

    assert (step.results, step.attempted, step.landed) == ([], 0, 0)
    assert step.vetoed == []
    assert step.emptied is False
    assert resources.trace == []
    assert resources.get_boards_calls == 0
    assert not (persona.directory / "memory.md").exists()


def test_execute_step_resolves_the_board_once_for_the_whole_round(tmp_path: Path) -> None:
    resources = TracingResources()
    persona = _persona(tmp_path, board="tech")
    resources.board_lookup = {"tech": "board-1"}

    execute_step(
        resources=resources,
        persona=persona,
        actions=[Action(kind="post", text="hello")],
        agent_name="zenith",
        now=NOW,
    )

    assert resources.get_boards_calls == 1
    assert resources.created_posts[0].board_id == "board-1"


# ── finalize_step ───────────────────────────────────────────────────────────


def test_finalize_step_is_inert_under_dry_run(tmp_path: Path) -> None:
    """Mark-read is a WRITE, and one that mutates what the next REAL round
    sees. The dry label is returned directly rather than falling through to
    the normal classification, which would log Bash's FAIL line at every
    shadow round (a dry run's `landed` is always 0)."""
    resources = TracingResources()

    outcome = finalize_step(
        resources=resources,
        actions=[Action(kind="nothing")],
        agent_name="zenith",
        attempted=0,
        landed=0,
        solo_nothing=False,
        dry_run=True,
    )

    assert outcome is ActOutcome.LANDED_ALL
    assert resources.trace == []
    assert resources.marked_read == []


def test_a_dry_run_of_a_real_plan_is_landed_all_and_logs_no_fail_line(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The end-to-end half of the guard above, and a gap the oracle leaves
    open: no existing test asserts the OUTCOME of a dry run whose plan has a
    real (non-`nothing`) surviving action. Without `finalize_step`'s guard
    the round reports `LANDED_PARTIAL` and writes
    `FAIL zenith -- all 0 planned actions failed` to `auto-run.log`'s Python
    equivalent, at every account of every shadow round."""
    backend = StubBackend(_plan_json({"action": "like", "postId": "a" * 24}))

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        result = _run(tmp_path, backend=backend, dry_run=True)

    assert result.outcome is ActOutcome.LANDED_ALL
    assert result.attempted == 0
    assert caplog.text == ""


def test_finalize_step_marks_nothing_when_nothing_landed(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Bash's mark-read block sits after its `landed == 0` return, so those
    notifications must survive to the next round -- and the FAIL line is
    keyed on the DIRECTORY name."""
    resources = TracingResources()

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        outcome = finalize_step(
            resources=resources,
            actions=[Action(kind="like", post_id="a" * 24)],
            agent_name="zenith_dir",
            attempted=1,
            landed=0,
            solo_nothing=False,
        )

    assert outcome is ActOutcome.LANDED_PARTIAL
    assert resources.trace == []
    assert "FAIL zenith_dir" in caplog.text


def test_finalize_step_marks_read_when_something_landed(tmp_path: Path) -> None:
    resources = TracingResources()

    outcome = finalize_step(
        resources=resources,
        actions=[Action(kind="nothing")],
        agent_name="zenith",
        attempted=1,
        landed=1,
        solo_nothing=True,
    )

    assert outcome is ActOutcome.PLANNER_EMPTY
    assert resources.marked_read == [None]


def test_finalize_step_reports_a_guard_emptied_round_as_vetoed_and_marks_nothing(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The duplicate guard dropped the only post and a `nothing` ran in its
    place. Like a plan the guardrails emptied, the round is `VETOED_EMPTY`
    and its notifications survive for the next round."""
    resources = TracingResources()

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        outcome = finalize_step(
            resources=resources,
            actions=[Action(kind="nothing")],
            agent_name="zenith",
            attempted=1,
            landed=1,
            solo_nothing=False,
            emptied=True,
        )

    assert outcome is ActOutcome.VETOED_EMPTY
    assert resources.marked_read == []
    assert "FAIL" not in caplog.text


def test_context_step_overlays_probe_posts_without_era_filtering_them(tmp_path: Path) -> None:
    """The probe overlay (dry-run eval only) is unchanged by Era 3: its posts
    are prepended as-is, whatever their date."""
    resources = FakeResources()
    probe = {
        "id": "p" * 24,
        "author": {"username": "probe-attacker"},
        "createdAt": "2020-01-01T00:00:00.000Z",
        "text": "PROBE_CANARY_A",
    }
    resources.board_feeds["probes"] = [probe]

    step = context_step(
        resources=resources,
        persona=_persona(tmp_path),
        memory_text="",
        now=NOW,
        rng=random.Random(0),
        era_start=datetime(2026, 10, 15, tzinfo=UTC),
        probe_board="probes",
    )

    assert step.context.probe_post_ids == ["p" * 24]
    assert "PROBE_CANARY_A" in step.context.global_feed
    assert ("feed_board:probes", None) in resources.since_calls
