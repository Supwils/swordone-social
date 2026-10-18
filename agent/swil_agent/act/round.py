"""The act path as a sequence of steps: health probe -> `agentBackend` sync
-> context -> rhythm -> plan -> guardrails -> duplicate guard + execute ->
mark-read -> tally.

Each stage is a public function taking explicit arguments and returning a
value -- `login_step`, `sync_backend_step`, `context_step`, `plan_step`,
`guardrail_step`, `execute_step`, `finalize_step` -- with no shared mutable
state. Their one composition is the LangGraph phase graph: `graph/nodes_act.py`
adapts `CycleState` to these functions, and the `act` and `cycle` commands
both run that graph (S3 §4), so there is one implementation of the act path.
The lock is not a step: `graph/run.py` holds a `RunLease` around the run.

Three helpers the steps call live in siblings (S3 §9): the memory.md line
(`act/memory_log.py`), the self-similarity sample and duplicate guard
(`act/similarity.py`) and the smart mark-read (`act/notifications.py`). Each
is imported here by name, so a test patching `act.round.<helper>` patches the
name the step looks up.
"""

from __future__ import annotations

import logging
import random
import sqlite3
from collections.abc import Callable
from contextlib import AbstractContextManager, suppress
from datetime import datetime
from pathlib import Path
from typing import Final, NamedTuple

from swil_agent.act.context import build_context, overlay_probe_posts
from swil_agent.act.executor import execute_action
from swil_agent.act.guardrails import apply_guardrails, resolve_handles
from swil_agent.act.memory_log import _write_memory_line
from swil_agent.act.notifications import _mark_notifications_read
from swil_agent.act.planner import plan_request
from swil_agent.act.similarity import (
    DEFAULT_POST_DUPLICATE_THRESHOLD,
    DEFAULT_POST_DUPLICATE_WINDOW,
    Embedder,
    apply_duplicate_guard,
    candidate_post_text,
    similarity_step,
)
from swil_agent.api.client import ApiError
from swil_agent.api.resources import Resources
from swil_agent.llm.protocol import Backend
from swil_agent.locks.lease import LeaseBusy
from swil_agent.memory_rotation import rotate_memory
from swil_agent.models import (
    ActContext,
    Action,
    ActionResult,
    ActOutcome,
    ActSimilarity,
    ActSources,
    HandleMap,
    Persona,
    Plan,
    RhythmDecision,
    VetoedAction,
)
from swil_agent.persona.rhythm import decide_rhythm
from swil_agent.prompts import act_prompt
from swil_agent.prompts.types import RenderedPrompt

logger = logging.getLogger(__name__)


def allowed_for(persona: Persona) -> list[str]:
    """The backend allow-list handed to `apply_guardrails` (contract `02`
    §1.1). Empty means everything allowed.

    Codex used to be restricted to `post`/`nothing` because its `comment`
    and `like` writes were a confirmed silent-fail path. Write-verification
    is the real fix (loop-engine spec §7); comment/like/echo/follow now use
    the same executor as every other backend. The `persona` argument stays
    so a future allow-list is still a one-line change with a test to match.
    """
    return []


_BACKEND_SYNC_ERROR_CAP: Final = 160


def _agent_backend_value(persona: Persona) -> str:
    """`"${ai_backend}${ai_model:+:$ai_model}"` --
    `<backend>` alone when the persona declares no `Model:` bullet,
    `<backend>:<model>` when it does.

    `${ai_model:+...}` expands only for a NON-EMPTY model, so an empty
    string suffixes nothing and never produces a trailing colon; `Persona
    .model` is `None` (not `""`) in that case, hence the truthiness test.
    Bash also has an `ai_backend="${ai_backend:-claude}"` default;
    `Persona.backend` already defaults to `"claude"` in `models.py`.
    """
    return f"{persona.backend}:{persona.model}" if persona.model else persona.backend


def sync_backend_step(
    *,
    resources: Resources,
    persona: Persona,
    agent_name: str,
    dry_run: bool = False,
) -> None:
    """PATCH the account profile with `{"agentBackend": ...}` every act round.

    Step 2 of the act path: its position in the sequence is after login and
    BEFORE any context is built (the login node calls it there) -- it is not
    deferred to the end of the round. Skipped on `dry_run`: this is a WRITE,
    and a shadow round performs none.

    `agentBackend` is the drift experiment's INDEPENDENT VARIABLE, so a
    runtime that stops refreshing it lets the field go stale for the whole
    roster mid-experiment. `Resources.update_profile` existed for exactly
    this call and had no callers.

    Non-fatal by design, and LOGGED rather than swallowed: a silent
    `|| true` once hid a 403 on this call for months (2026-08-05). The WARN
    line carries the error truncated to 160 characters.
    """
    if dry_run:
        return
    try:
        resources.update_profile({"agentBackend": _agent_backend_value(persona)})
    except ApiError as exc:
        logger.warning(
            "WARN %s — agentBackend sync failed: %s",
            agent_name,
            str(exc)[:_BACKEND_SYNC_ERROR_CAP],
        )


class LoginStep(NamedTuple):
    """What `login_step` establishes before a round may begin.

    No lock: the round's mutual exclusion is `graph/run.py`'s `RunLease`,
    held around the whole run (S3 §5) -- a LangGraph node cannot hold a
    context manager across nodes, and a second, step-level lock would be a
    second lock layer.
    """

    online: bool
    agent_name: str


def login_step(*, persona: Persona, health_check: Callable[[], bool]) -> LoginStep:
    """Step 1 of the act path: probe `/health`.

    `agent_name` is `basename "$agent_dir"`, i.e. `persona.directory.name`,
    NOT the persona's `Username` bullet -- the two can diverge, and every
    lock path and log line keys on the directory name.
    """
    return LoginStep(online=health_check(), agent_name=persona.directory.name)


class ContextStep(NamedTuple):
    """The read-side of a round: the planner's prompt inputs, plus the day's
    rhythm decision derived from them."""

    context: ActContext
    rhythm: RhythmDecision


DEFAULT_POST_PROBABILITY: Final = 60
"""Percent chance a round must post. `Settings.post_probability` carries the
same default; `act/` sits below `config`, so the two are pinned equal by test."""

DEFAULT_POST_CEILING_PER_DAY: Final = 1
"""At this many posts today the round may not post. Mirrors
`Settings.post_ceiling_per_day`."""


def context_step(
    *,
    resources: Resources,
    persona: Persona,
    memory_text: str,
    now: datetime,
    rng: random.Random,
    budget: int = 5,
    context_now: str = "(no context file)",
    feed_context: str = "",
    era_start: datetime | None = None,
    post_probability: int = DEFAULT_POST_PROBABILITY,
    post_ceiling: int = DEFAULT_POST_CEILING_PER_DAY,
    probe_board: str | None = None,
    world: ActSources | None = None,
) -> ContextStep:
    """Step 3 of the act path: `build_context` then `decide_rhythm`.

    One step because the rhythm's `posts_today` is `ctx.today_post_count`,
    which `build_context` computes from `memory_text`. `rng` is drawn only by
    the rhythm. The probe overlay (dry-run eval only) reads the probe board
    unfiltered.
    """
    ctx = build_context(
        resources,
        persona,
        memory_text=memory_text,
        now=now,
        budget=budget,
        context_now=context_now,
        feed_context=feed_context,
        era_start=era_start,
        world=world,
    )
    if probe_board:
        with suppress(ApiError):
            overlay_probe_posts(
                ctx,
                resources.feed_board(probe_board, limit=10, sort="latest"),
            )
    rhythm = decide_rhythm(
        ctx.today_post_count, rng, probability=post_probability, ceiling=post_ceiling
    )
    return ContextStep(context=ctx, rhythm=rhythm)


def plan_step(
    *,
    backend: Backend,
    persona: Persona,
    context: ActContext,
    rhythm: RhythmDecision,
    prompt: RenderedPrompt | None = None,
) -> Plan | None:
    """Step 4 of the act path: ask the backend for this round's plan.

    `prompt` is the request the plan node rendered through `prompts.act_prompt`
    (the node keeps its size for the cycle_run card); `None` renders v1 here.
    Callers pass the whole `RhythmDecision` and the renderer picks its field,
    so there is one place where that choice is made.

    `None` back is "the backend produced nothing at all"
    (`BackendUnavailableError`, or output that parsed to no plan); the caller
    maps it to `ActOutcome.BACKEND_UNAVAILABLE`.
    """
    rendered = prompt if prompt is not None else act_prompt("v1", persona, context, rhythm)
    return plan_request(backend, rendered.request, handle_keys=rendered.handles is not None)


class GuardrailStep(NamedTuple):
    """What survived the guardrails, plus the two classifications a caller
    needs to decide the round's `ActOutcome` without re-deriving them.

    `empty_outcome` is `None` when actions survived, and otherwise carries
    the reason the plan is empty:

      * `VETOED_EMPTY` -- guardrails actually dropped something.
      * `PLANNER_EMPTY` -- the model proposed nothing to begin with.

    Bash logs both as `planned: nothing`, indistinguishable (design spec
    §7.5) -- and that indistinguishability was the proximate cause of three
    codex accounts landing in an uninterpretable state on 2026-08-16, which
    is why the distinction is carried in the return value rather than
    recomputed by each caller from `vetoed`'s emptiness.

    `solo_nothing` is a SURVIVING plan whose only action is `nothing`: the
    model explicitly chose to be quiet. It is `PLANNER_EMPTY` too -- the
    same category as "proposed nothing", reached by a different route
    through guardrails (a lone `nothing` is never dropped by stage 2, which
    only strips `nothing` when it is mixed with other actions) -- but it is
    still EXECUTED, so its lab event and log line fire the way Bash's do.
    Hence a separate flag rather than a third `empty_outcome` value.
    """

    actions: list[Action]
    vetoed: list[VetoedAction]
    empty_outcome: ActOutcome | None
    solo_nothing: bool


def guardrail_step(
    *,
    plan: Plan,
    persona: Persona,
    rhythm: RhythmDecision,
    context: ActContext,
    budget: int = 5,
    handles: HandleMap | None = None,
) -> GuardrailStep:
    """Step 5 of the act path: backend allow-list, rhythm veto, dm contacts,
    one-post/one-echo + dedupe, budget cap -- then classify what is left.

    PURE: no I/O of any kind. `apply_guardrails` is a function of the plan
    and four already-computed values, and the three inputs that are easy to
    misroute are assembled here so they are assembled once -- the allow-list
    from `allowed_for(persona)` (never a raw literal), the policy from the
    rhythm decision, and the dm contact list from the context the planner
    was given rather than a fresh read (a re-read could return a DIFFERENT
    contact set from the one the model was shown, silently vetoing a dm the
    plan was entitled to make). `handles` (v2 only) maps handles back to ids
    first.
    """
    pre_vetoed: list[VetoedAction] = []
    if handles is not None:
        resolved = resolve_handles(plan, handles)
        plan = Plan(actions=resolved.actions)
        pre_vetoed = resolved.vetoed
    guarded = apply_guardrails(
        plan,
        policy=rhythm.policy,
        budget=budget,
        contacts=context.contacts,
        allowed=allowed_for(persona),
    )
    vetoed = [*pre_vetoed, *guarded.vetoed]
    if not guarded.actions:
        empty = ActOutcome.VETOED_EMPTY if vetoed else ActOutcome.PLANNER_EMPTY
        return GuardrailStep(
            actions=guarded.actions,
            vetoed=vetoed,
            empty_outcome=empty,
            solo_nothing=False,
        )
    solo_nothing = len(guarded.actions) == 1 and guarded.actions[0].kind == "nothing"
    return GuardrailStep(
        actions=guarded.actions,
        vetoed=vetoed,
        empty_outcome=None,
        solo_nothing=solo_nothing,
    )


def _resolve_board_id(resources: Resources, persona: Persona) -> str | None:
    """The `Board:` bullet resolved to a board id, ONCE per round (fix round
    1, item 5).

    Bash re-resolves on every `post` call, but guardrails
    cap a round at one post, so resolving once -- and only when there is
    something left to execute -- is behaviourally equivalent and cheaper.
    Guarded on `persona.board` being truthy, exactly like Bash's own
    `if [[ -n "$POST_BOARD" ]]`, so a persona with no `Board:` bullet never
    pays the network call. A failed lookup (`ApiError`) degrades to `None` --
    an unfiled post -- matching Bash's own "degrades to an unfiled post if
    the endpoint is unavailable, never blocks" comment.
    """
    if not persona.board:
        return None
    try:
        return resources.get_boards().get(persona.board)
    except ApiError:
        return None  # degrades to an unfiled post


class ExecuteStep(NamedTuple):
    """The write-side tally of a round.

    `actions` is what actually executed (after the duplicate guard), `vetoed`
    what the guard dropped, and `emptied` whether the guard left nothing but
    a `nothing` -- `finalize_step` reports that round as `VETOED_EMPTY`.
    `missing_post_vector` is true when a post landed but its vector was not
    filed (no vector, or the ingest failed); the cycle_run card copies it.
    """

    results: list[ActionResult]
    attempted: int
    landed: int
    actions: list[Action]
    vetoed: list[VetoedAction]
    emptied: bool = False
    missing_post_vector: bool = False


def _file_post_vector(
    resources: Resources,
    persona: Persona,
    result: ActionResult,
    sim: ActSimilarity | None,
    *,
    candidate: str | None,
    round_id: str | None,
) -> bool:
    """File a landed post's vector (S2 §4). True when it was filed.

    Only the vector the similarity step measured for THIS post's text is
    filed -- there is no second embed, so no vector means no ingest.
    `Resources.post_vector` never raises; a rejection is a False, which the
    caller records as a missing vector rather than a failed round.
    """
    if (
        sim is None
        or sim.vector is None
        or not result.resource_id
        or candidate_post_text([result.action]) != candidate
    ):
        return False
    return resources.post_vector(
        persona.username,
        post_id=result.resource_id,
        round_id=round_id,
        embedding=sim.vector,
        card_sim=sim.card_sim,
        max_sim=sim.max_sim,
    )


def execute_step(
    *,
    resources: Resources,
    persona: Persona,
    actions: list[Action],
    agent_name: str,
    now: datetime,
    access_key: str | None = None,
    dry_run: bool = False,
    embedder: Embedder | None = None,
    duplicate_window: int = DEFAULT_POST_DUPLICATE_WINDOW,
    duplicate_threshold: float = DEFAULT_POST_DUPLICATE_THRESHOLD,
    round_id: str | None = None,
) -> ExecuteStep:
    """Step 6 of the act path: duplicate guard, then execute every surviving
    action in order and append its `memory.md` line.

    `dry_run` short-circuits the whole step -- no guard, no board lookup, no
    write, no memory line, no lab event -- because this function performs all
    of a round's writes and the graph path calls it directly.

    The guard runs first, before any write: once this round's post lands it
    is one of the account's own posts, and comparing against it would report
    ~1.0. It lives in this step so every graph that executes gets it.
    `embedder=None` disables it.

    The memory write is inside the loop, so action N's memory event is sent
    before action N+1's write. Board resolution happens once, only when there
    is something to execute.

    A landed `post` then files its vector (`_file_post_vector`) under
    `round_id` -- `None` for a thread checkpointed before S2, which the
    server resolves. An echo or a comment never files one.
    """
    if dry_run:
        return ExecuteStep(results=[], attempted=0, landed=0, actions=list(actions), vetoed=[])

    sim = similarity_step(
        resources=resources,
        persona=persona,
        actions=actions,
        embedder=embedder,
        window=duplicate_window,
        threshold=duplicate_threshold,
        round_id=round_id,
    )
    candidate = candidate_post_text(actions)
    to_run, vetoed = apply_duplicate_guard(actions, sim, threshold=duplicate_threshold)
    emptied = bool(vetoed) and all(action.kind == "nothing" for action in to_run)

    board_id = _resolve_board_id(resources, persona) if not emptied else None

    results: list[ActionResult] = []
    landed = 0
    missing_post_vector = False
    for action in to_run:
        result = execute_action(
            resources,
            action,
            agent_name=agent_name,
            username=persona.username,
            access_key=access_key or "",
            board_id=board_id,
        )
        results.append(result)
        if result.landed:
            landed += 1
        _write_memory_line(
            persona.directory,
            action,
            result,
            now=now,
            resources=resources,
            username=persona.username,
        )
        if action.kind == "post" and result.landed:
            filed = _file_post_vector(
                resources, persona, result, sim, candidate=candidate, round_id=round_id
            )
            missing_post_vector = missing_post_vector or not filed
    return ExecuteStep(
        results=results,
        attempted=len(to_run),
        landed=landed,
        actions=to_run,
        vetoed=vetoed,
        emptied=emptied,
        missing_post_vector=missing_post_vector,
    )


def finalize_step(
    *,
    resources: Resources,
    actions: list[Action],
    agent_name: str,
    attempted: int,
    landed: int,
    solo_nothing: bool,
    dry_run: bool = False,
    emptied: bool = False,
) -> ActOutcome:
    """Step 7 of the act path: the post-execution tail -- smart mark-read,
    then the round's `ActOutcome`.

    `dry_run` skips the mark-read (its only write) and returns a label:
    `PLANNER_EMPTY` for a solo-`nothing` plan, `LANDED_ALL` otherwise.

    `emptied` (the duplicate guard dropped the round's only post) returns
    `VETOED_EMPTY` before the mark-read, exactly like a plan the guardrails
    emptied: those notifications were not answered and must survive.

    Mark-read runs only when something landed, so a round where everything
    failed leaves its notifications for the next round.

    Outcome precedence: `solo_nothing` -> `PLANNER_EMPTY`; `landed == 0` ->
    `LANDED_PARTIAL` with a FAIL warning (the dream is still granted);
    `landed == attempted` -> `LANDED_ALL`; otherwise `LANDED_PARTIAL`.
    `agent_name` is the directory name.
    """
    if dry_run:
        return ActOutcome.PLANNER_EMPTY if solo_nothing else ActOutcome.LANDED_ALL
    if emptied:
        return ActOutcome.VETOED_EMPTY

    if landed > 0:
        _mark_notifications_read(resources, actions)

    if solo_nothing:
        return ActOutcome.PLANNER_EMPTY
    if landed == 0:
        logger.warning(
            "FAIL %s — all %d planned actions failed; dream will be skipped",
            agent_name,
            attempted,
        )
        return ActOutcome.LANDED_PARTIAL
    if landed == attempted:
        return ActOutcome.LANDED_ALL
    return ActOutcome.LANDED_PARTIAL


def rotate_memory_soft(directory: Path, agent_name: str) -> None:
    """Rotate `directory/memory.md` (see `memory_rotation.py`). A failure --
    including a file that is not UTF-8 -- is a WARN line and never the
    round's outcome. The caller must hold both the act and the dream lock:
    the cycle holds both leases for the run; `act` takes the dream lease for
    the rotation alone (`rotate_memory_if_free`)."""
    try:
        moved = rotate_memory(directory / "memory.md")
    except (OSError, ValueError) as exc:
        logger.warning(
            "memory rotation failed for %s (%s); the round is unaffected", agent_name, exc
        )
        return
    if moved:
        logger.info("memory rotated for %s — %d lines archived", agent_name, moved)


def rotate_memory_if_free(
    directory: Path, agent_name: str, dream_lease: Callable[[], AbstractContextManager[object]]
) -> None:
    """`rotate_memory_soft` under `dream_lease()`, taken non-blocking.

    A standalone `dream` appends to memory.md under the dream lock alone, so
    an `act` (which holds only the act lease) needs that lock too before it
    rotates. Busy (`LeaseBusy`) means a dream is running: skip, and the next
    round rotates -- the round itself still succeeds. A lease-database error
    (`sqlite3.Error`, e.g. `database is locked` past the busy timeout) is the
    same kind of miss, logged at WARNING like `rotate_memory_soft`'s own
    failures: rotation is housekeeping and never the round's outcome.
    """
    try:
        with dream_lease():
            rotate_memory_soft(directory, agent_name)
    except LeaseBusy:
        logger.info("memory rotation skipped for %s — dream lock held", agent_name)
    except sqlite3.Error as exc:
        logger.warning(
            "memory rotation skipped for %s — lease db error (%s); the round is unaffected",
            agent_name,
            exc,
        )
