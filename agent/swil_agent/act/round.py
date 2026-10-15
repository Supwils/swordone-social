"""The act path as a sequence of steps, plus `run_act`, the function that
composes them: health probe -> lock -> `agentBackend` sync -> context ->
rhythm -> plan -> guardrails -> duplicate guard + execute -> mark-read ->
tally.

Each stage is a public function taking explicit arguments and returning a
value -- `login_step`, `sync_backend_step`, `context_step`, `plan_step`,
`guardrail_step`, `execute_step`, `finalize_step` -- with no shared mutable
state. `run_act` is their composition and nothing else. `graph/nodes.py`
adapts `CycleState` to these same functions, so the graph path and the direct
CLI path run one implementation.
"""

from __future__ import annotations

import logging
import random
import re
from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager, nullcontext, suppress
from datetime import datetime
from pathlib import Path
from typing import Any, Final, NamedTuple, Protocol

from swil_agent.act.context import build_context, overlay_probe_posts
from swil_agent.act.executor import execute_action
from swil_agent.act.guardrails import apply_guardrails
from swil_agent.act.planner import plan_round
from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.llm.base import Backend
from swil_agent.llm.extract import collapse_doubled_text
from swil_agent.locks import FileLock, LockBusy, act_lock_path, dream_lock_path
from swil_agent.memory_rotation import rotate_memory
from swil_agent.models import (
    ActContext,
    Action,
    ActionResult,
    ActOutcome,
    ActResult,
    ActSimilarity,
    Persona,
    Plan,
    RhythmDecision,
    VetoedAction,
)
from swil_agent.persona.format import card_text
from swil_agent.persona.rhythm import decide_rhythm

logger = logging.getLogger(__name__)

_MEMORY_PREVIEW_CAP = 80
_WHITESPACE_RUN = re.compile(r" {2,}")

# The exact `detail` string `act/executor.py`'s `_execute_comment` sets on the
# parent-unusable-retry-succeeded path. Duplicated here (not imported) because
# it is a private literal inside that module's function body, not a name --
# see `_memory_note`'s docstring for what this sentinel is for and the test
# that would catch the two strings drifting apart.
_PARENT_UNUSABLE_DETAIL = "parent unusable — posted top-level"


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


def _memory_field(raw: str | None) -> str:
    """Whitespace-clean one field for a memory.md note, WITHOUT the
    doubled-text collapse (contract `02` §4.2, cross-cutting facts).

    Mirrors `tr -d '\\n' | sed 's/  */ /g'` then `.strip()`, exactly like
    `act/executor.py`'s private `_clean` applies to the copy of the field it
    sends to the API -- reproduced here rather than imported because the
    memory line is built from the ORIGINAL `Action` the guardrails approved,
    independently of whatever the executor already did with its own copy of
    the same field on the way to the wire.
    """
    text = (raw or "").replace("\n", "")
    return _WHITESPACE_RUN.sub(" ", text).strip()


def _memory_text(raw: str | None) -> str:
    """`_memory_field` plus the doubled-text collapse -- for the fields
    `act/executor.py`'s module docstring names as eligible for it:
    `post.text`, `comment.text`, `echo.text`, `dm.text`. NEVER `imageTopic`
    or a username (fix round 1, task-7 review item 3: an earlier version of
    this module ran `image_topic` through this same collapsing function,
    which could make the `[img:...]` memory-line tag disagree with the
    topic string actually used to fetch the image -- a byte-compatibility
    break in shared on-disk state that only fires on an exact-duplicate
    topic string >= 40 chars, which is why it went unnoticed at first.
    `_memory_field` above is the non-collapsing variant now used for
    `image_topic`. `test_memory_note_collapses_...` pins this against the
    exact shape the brief specifies; a divergence between this and
    `executor._clean` would show up as the two modules' tests disagreeing
    on the same input, not as a shared import silently drifting.
    """
    return collapse_doubled_text(_memory_field(raw))


def _memory_username(raw: str | None) -> str:
    """`tr -d '@[:space:]'` -- mirrors `act/executor.py`'s private
    `_clean_username`, for the same reason `_memory_text` mirrors `_clean`."""
    return re.sub(r"[@\s]", "", raw or "")


def _memory_note(action: Action, result: ActionResult) -> str | None:
    """The per-kind memory note text (contract `02` §4.2), or `None` when no
    memory.md line should be written at all.

    Gated on `result.call_succeeded`, NOT on `result.landed` (ruling R19): a
    line is written only for a write that actually happened (contract `02`
    §4.1). For every kind but `follow` the two are equal.

    A `follow` that 409s ("already following", the common outcome) still
    counts as landed -- it is not a failed round -- but the write did not
    succeed, so it records nothing. `memory.md` is the dream's input AND the
    unit `DREAM_MIN_NEW_MEMORIES=8` counts, so a spurious line per
    repeat-follow would shift what every later dream reads and make dreams
    fire earlier.

    The gate here is only half the fix, and on its own it was inert (ruling
    R20). `call_succeeded` is `False` only on `_execute_follow`'s EXCEPT
    branch, and `Resources.follow` used to swallow the 409 before it could
    get there -- so the common "already following" outcome still took the
    success path and still wrote its line. That swallow is gone; the 409 now
    propagates like every other write failure, which is what makes this gate
    reachable at all. Driven end-to-end over a real 409 in
    `test_an_already_following_409_warns_and_writes_no_memory_line`, not
    through a fake whose `follow()` re-raises whatever it is handed.

    `nothing` never gets a line (contract `02` §4.1).
    """
    if not result.call_succeeded or action.kind == "nothing":
        return None

    if action.kind == "post":
        text = _memory_text(action.text)
        # image_topic never goes through the doubled-text collapse (fix
        # round 1, item 3) -- _memory_field, not _memory_text.
        topic = _memory_field(action.image_topic)
        img_tag = f"[img:{topic}] " if topic else ""
        return f"post | id={result.resource_id} | {img_tag}{text[:_MEMORY_PREVIEW_CAP]}"
    elif action.kind == "comment":
        text = _memory_text(action.text)
        # The retry-succeeded-top-level path (contract 02 §2.2) writes NO
        # parentId at all. `result.detail` is the
        # only signal left, after the fact, that this was that path.
        parent_tag = ""
        if action.parent_id and result.detail != _PARENT_UNUSABLE_DETAIL:
            parent_tag = f" parentId={action.parent_id}"
        return (
            f"comment | postId={action.post_id} commentId={result.resource_id}"
            f"{parent_tag} | {text[:_MEMORY_PREVIEW_CAP]}"
        )
    elif action.kind == "like":
        return f"like | postId={action.post_id}"
    elif action.kind == "follow":
        return f"follow | @{_memory_username(action.username)}"
    elif action.kind == "echo":
        text = _memory_text(action.text)
        quote_tag = f" | {text[:_MEMORY_PREVIEW_CAP]}" if text else ""
        return f"echo | id={result.resource_id} echoOf={action.post_id}{quote_tag}"
    elif action.kind == "dm":
        # `ActionResult` carries the conversation id in its own field.
        text = _memory_text(action.text)
        username = _memory_username(action.username)
        return (
            f"dm | to={username} conversationId={result.conversation_id} | "
            f"{text[:_MEMORY_PREVIEW_CAP]}"
        )
    else:
        # ActionKind is a closed 7-member Literal and `nothing` is handled by
        # the early return above, so every remaining member is covered by a
        # branch above -- this is unreachable for a validly constructed
        # Action, exactly like the equivalent branch in
        # act/executor.py:execute_action.
        raise AssertionError(  # pragma: no cover
            f"unhandled action kind for memory note: {action.kind!r}"
        )


# `_remember`'s own whitelist. A note whose leading verb is not
# one of these emits `action=""` -- which `LabEvent.to_wire` then OMITS from
# the body entirely, so `/lab` records the event with no action facet rather
# than with a made-up one. `echo` and `dm` are deliberately ABSENT: Bash's
# whitelist does not contain them either, so their memory events carry no
# action. Transcribed verbatim; do not "complete" it.
_MEMORY_EVENT_ACTIONS: Final = frozenset(
    {"post", "comment", "like", "follow", "unfollow", "delete", "nothing"}
)

# The first `id=`, `postId=` or `commentId=` followed by 24 hex characters.
# Case-sensitive and unanchored, exactly as `grep -E` is: the
# `conversationId=` in a `dm` note does NOT match (`Id` != `id`), so a dm's
# memory event carries no targetId -- checked against the real note shapes,
# not assumed.
_MEMORY_TARGET_RE: Final = re.compile(r"(?:id|postId|commentId)=([a-f0-9]{24})")


def _flatten_note(note: str) -> str:
    r"""`_remember`'s own normalisation of its argument:
    `tr '\n' ' '` then `sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'`.

    A RAW docstring on purpose: both of those are shell escapes, and in a
    normal docstring `\n` becomes a real newline and `\+` raises a
    SyntaxWarning -- i.e. the transcription stops being a transcription.

    Applied ONCE, to the value that feeds both the memory.md line and the
    lab event's `summary`, because Bash derives both from the same `$note`
    variable. Every component `_memory_note` assembles is already cleaned by
    `_memory_text`, so in practice this is a no-op today -- it exists so the
    two consumers cannot drift apart if a future note shape is not.
    """
    return re.sub(r"\s+", " ", note.replace("\n", " ")).strip(" ")


def _memory_event(note: str) -> LabEvent:
    """The SECOND lab event fired for every memory line, independent of the `cycle/act/*` event
    `act/executor.py` already emits per action.

    So one successful `post` produces TWO POSTs to
    `/agents/{username}/events` -- `cycle/act/success` and `memory/memory/success`
    (ruling R21); `/lab`'s memory surfaces read the second.

    Field placement: `type, phase, outcome, action, summary, reason,
    target_id, metrics`, with `reason` empty and `metrics` `"{}"`. The
    summary is the WHOLE flattened note -- uncapped, unlike the act events'
    200-char cap.
    """
    verb = note.split("|", 1)[0].strip()
    match = _MEMORY_TARGET_RE.search(note)
    return LabEvent(
        type="memory",
        phase="memory",
        outcome="success",
        action=verb if verb in _MEMORY_EVENT_ACTIONS else None,
        summary=note,
        reason=None,
        target_id=match.group(1) if match else None,
    )


def _write_memory_line(
    directory: Path,
    action: Action,
    result: ActionResult,
    *,
    now: datetime,
    resources: Resources,
    username: str,
) -> None:
    """Append one line to `<directory>/memory.md` AND fire the
    `memory/memory/success` lab event, matching `_remember()`
    in both halves and in that ORDER.

    The on-disk line is byte-for-byte `_remember`'s (contract `02` §4.2):
    `<YYYY-MM-DD> | <note>`. `directory` is `persona.directory` -- the same
    folder `resolve_agent_dir` returns and Bash calls `agent_dir` -- so this
    reads and writes the identical file a live Bash round would.

    ORDER IS THE CONTRACT: the file append happens BEFORE the
    event, so an events outage still leaves the memory
    line on disk -- and memory.md, not `/lab`, is what the next dream reads.
    The event itself cannot fail the round in either runtime: Bash ends
    `_lab_event`'s curl with `|| true` and
    `Resources.lab_event` documents the same guarantee ("this never
    raises"). No extra try/except is added here on purpose -- one would
    imply this module distrusts that contract, and would also hide a fake
    that breaks it.

    Real file I/O, performed directly rather than behind an injected seam:
    `FileLock` (Task 2) already established this module family's precedent
    of touching the filesystem for Bash-compatible on-disk state, and
    `memory.md` is exactly that. `username` is the `Username` bullet (whom
    the event is filed under), NOT the directory name -- the same
    distinction `execute_action` already draws.
    """
    note = _memory_note(action, result)
    if note is None:
        return
    note = _flatten_note(note)
    line = f"{now.strftime('%Y-%m-%d')} | {note}\n"
    with (directory / "memory.md").open("a", encoding="utf-8") as handle:
        handle.write(line)
    resources.lab_event(username, _memory_event(note))


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

    Step 2 of the act path (see `run_act`): its position in the
    sequence is after login and BEFORE any context is built, and this
    function is called from there -- it is not deferred to the end of the
    round. Skipped on `dry_run` for the same reason the lock is
    (`login_step`): this is a WRITE, and a shadow round performs none.

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


_MARK_READ_NOTIFICATION_LIMIT: Final = 20
_RESPONSE_NOTIFICATION_TYPES: Final = frozenset({"mention", "comment", "reply"})


def _comment_targets(actions: list[Action]) -> list[tuple[str, str]]:
    """`(post_id, parent_id)` pairs -- one per `comment` action in the
    (post-guardrail) plan, with `""` for an absent field.

    Plan-aware on purpose: a round may contain several comments and every
    one of them is collected, marking the whole set in a single call.
    """
    return [
        ((action.post_id or ""), (action.parent_id or ""))
        for action in actions
        if action.kind == "comment"
    ]


def _responded_notification_ids(
    notifications: list[dict[str, Any]], targets: list[tuple[str, str]]
) -> list[str]:
    """Pick the notification ids that answer one of the round's comments.

    A notification is selected when ANY target matches it:

      * the target has a `parentId` (this comment was a REPLY) -- match only
        the notification whose own `comment.id` IS that parent. Nothing else.
      * the target has no `parentId` (a TOP-LEVEL comment) -- match
        notifications on that `post.id` whose `type` is one of
        mention/comment/reply.

    The asymmetry is Bash's own, and the comment above it says why: matching
    on any notification sharing a `postId` would clear "someone commented on
    X" merely because the agent liked something else involving X, losing
    that context for the NEXT round. `like`/`follow`/`echo`/`dm` contribute
    no targets at all and so can never clear anything.

    jq's `null.id` is `null` rather than an error, so a notification with no
    `comment`/`post` object simply fails to match; the `isinstance` guards
    here reproduce that rather than raising.
    """
    selected: list[str] = []
    for item in notifications:
        notif_id = item.get("id")
        if not isinstance(notif_id, str) or not notif_id:
            continue
        comment = item.get("comment")
        comment_id = comment.get("id") if isinstance(comment, dict) else None
        post = item.get("post")
        post_id = post.get("id") if isinstance(post, dict) else None
        notif_type = item.get("type")
        for target_post_id, target_parent_id in targets:
            if target_parent_id:
                matched = comment_id == target_parent_id
            else:
                matched = post_id == target_post_id and notif_type in _RESPONSE_NOTIFICATION_TYPES
            if matched:
                selected.append(notif_id)
                break
    return selected


def _mark_notifications_read(resources: Resources, actions: list[Action]) -> None:
    """Bash's "smart mark-read" block, ported whole.

    Without it the same notifications come back unread every round and the
    agent posts duplicate replies to the same comment -- user-visible on the
    live site, which is why this is not deferrable observability polish.

    Two mutually exclusive branches, in Bash's own order:

      1. a plan that is ONLY `nothing` -> mark EVERYTHING read, so an idle
         agent is not stuck rereading the same 8 items forever. Bash's test
         is `[.[].action] | unique | join(",") == "nothing"`, i.e. EVERY
         action is `nothing` -- not "exactly one action, and it is nothing".
      2. otherwise, if the plan contains any `comment` -> re-read the 20 most
         recent unread notifications and mark only those the agent
         semantically responded to.

    A plan with no comments and no `nothing` (e.g. a lone `like`) marks
    NOTHING -- there is no third branch in Bash and there is none here.

    Fire-and-forget in both directions, matching Bash's `2>/dev/null ||
    echo '[]'` around the read and `|| true` around the write: a failed
    notifications read degrades to "mark nothing this round", and the write
    itself never raises (`Resources.mark_notifications_read`). This runs
    after the actions have already landed; nothing it does may turn a
    successful round into a failed one.
    """
    if actions and all(action.kind == "nothing" for action in actions):
        resources.mark_notifications_read()
        return

    targets = _comment_targets(actions)
    if not targets:
        return
    try:
        notifications = resources.notifications(limit=_MARK_READ_NOTIFICATION_LIMIT)
    except ApiError:
        return
    resources.mark_notifications_read(_responded_notification_ids(notifications, targets))


class LoginStep(NamedTuple):
    """What `login_step` establishes before a round may begin.

    `lock` is returned UNENTERED, and that is deliberate: the COMPOSER
    decides the scope it is held for. `run_act` holds it across the whole
    round; a LangGraph node cannot hold anything across nodes (a live
    context manager is not serializable checkpoint state), which is why the
    graph path takes a `RunLease` around the whole cycle instead
    (`graph/leases.py`, ruling R2) and uses this step for the probe alone.
    Returning an ALREADY-ENTERED stack would have made that second caller
    impossible to write correctly.
    """

    online: bool
    agent_name: str
    lock: AbstractContextManager[object]


def login_step(
    *,
    persona: Persona,
    agent_root: Path,
    health_check: Callable[[], bool],
    dry_run: bool = False,
) -> LoginStep:
    """Step 1 of the act path: probe `/health`, then choose the round's
    mutual exclusion (connectivity check, then the account lock).

    ORDER IS THE CONTRACT, and it is why the probe and the lock are one step
    rather than two: the probe runs BEFORE any per-account work, so an
    offline probe means no lock is ever constructed,
    let alone acquired -- an offline round can therefore never lose an
    acquire race, nor disturb a lock another process is holding. Splitting
    these apart invites a caller that acquires first and probes second,
    which no test would fail but which changes what an outage does to the
    roster.

    `agent_name` is `basename "$agent_dir"`, i.e.
    `persona.directory.name`, NOT the persona's `Username` bullet -- see
    `run_act`'s docstring for the case where the two diverge.

    F4: a dry run acquires NOTHING. `dry_run` executes no action, writes no
    memory line and PATCHes no profile, so it needs no mutual exclusion --
    and taking the lock made the documented "safe inspection command"
    actively unsafe: a dry run launched while a real round held the
    lock cost that account its whole round (a lock failure returns 75 and
    the account is skipped).
    `nullcontext` rather than a second "shared" lock mode: there is no
    resource to share access TO.
    """
    agent_name = persona.directory.name
    if not health_check():
        return LoginStep(online=False, agent_name=agent_name, lock=nullcontext())
    lock: AbstractContextManager[object] = (
        nullcontext() if dry_run else FileLock(act_lock_path(agent_root, agent_name))
    )
    return LoginStep(online=True, agent_name=agent_name, lock=lock)


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
) -> Plan | None:
    """Step 4 of the act path: ask the backend for this round's plan.

    Thin over `plan_round` on purpose -- what it carries is the WIRING, not
    logic: the planner takes `rhythm_guidance`, one of `RhythmDecision`'s
    three string fields, and handing it `prefer_non_post` (or `policy`)
    instead would still typecheck, still run, and quietly change every
    prompt the roster sees. Callers pass the whole `RhythmDecision` and this
    step picks the field, so there is one place where that choice is made.

    `None` is `plan_round`'s "the backend produced nothing at all" signal
    (`BackendUnavailableError`, or output that parsed to no plan); the
    caller maps it to `ActOutcome.BACKEND_UNAVAILABLE`.
    """
    return plan_round(backend, persona, context, rhythm_guidance=rhythm.guidance)


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
    plan was entitled to make).
    """
    guarded = apply_guardrails(
        plan,
        policy=rhythm.policy,
        budget=budget,
        contacts=context.contacts,
        allowed=allowed_for(persona),
    )
    if not guarded.actions:
        empty = ActOutcome.VETOED_EMPTY if guarded.vetoed else ActOutcome.PLANNER_EMPTY
        return GuardrailStep(
            actions=guarded.actions,
            vetoed=guarded.vetoed,
            empty_outcome=empty,
            solo_nothing=False,
        )
    solo_nothing = len(guarded.actions) == 1 and guarded.actions[0].kind == "nothing"
    return GuardrailStep(
        actions=guarded.actions,
        vetoed=guarded.vetoed,
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


# ── near-duplicate guard ─────────────────────────────────────────────────
#
# Before a post executes it is embedded and compared with the account's own
# last `window` posts; at max cosine >= `threshold` the post is dropped.


class Embedder(Protocol):
    """The one method this module needs from the bge-m3 daemon. Declared here
    rather than imported from a peer package (`dream`, `analysis`)."""

    def embed(self, texts: list[str]) -> list[list[float]]: ...


DEFAULT_POST_DUPLICATE_WINDOW: Final = 12
"""How many of the account's own recent posts a candidate is compared
against. Mirrors `Settings.post_duplicate_window`; pinned equal by test."""

DEFAULT_POST_DUPLICATE_THRESHOLD: Final = 0.92
"""Max cosine similarity at which a candidate post is dropped. Mirrors
`Settings.post_duplicate_threshold`; pinned equal by test."""

MIN_COMPARISON_CORPUS: Final = 2
"""Fewer prior posts than this and `max_sim` is `None` (not computed), so a
new account is never measured against a one-post sample."""


def candidate_post_text(actions: Sequence[Action]) -> str | None:
    """The text this round would post, or `None`.

    The first `post` action only (guardrails cap a round at one); an `echo` is
    commentary on someone else's post and is not a candidate. Normalised the
    way the executor puts it on the wire, so the measured string is the one
    that would be published. Blank yields `None`: the executor would skip it.
    """
    for action in actions:
        if action.kind == "post":
            return _memory_text(action.text) or None
    return None


def prior_post_texts(items: Sequence[dict[str, Any]]) -> list[str]:
    """The account's own recent post bodies, in API order.

    `originalText`, falling back to `text` only when it is null/false (an empty
    `originalText` is kept as-is, then dropped as blank). Non-string and
    whitespace-only bodies are dropped.
    """
    texts: list[str] = []
    for item in items:
        raw: Any = item.get("originalText")
        if raw is None or raw is False:
            raw = item.get("text")
        if isinstance(raw, str) and raw.strip():
            texts.append(raw)
    return texts


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Dot product of two L2-normalised bge-m3 vectors, clamped to [-1, 1].

    Callers check the vectors first. Unlike `dream/drift.py`'s `cosine_sim`
    this has no fail-open-to-1.0 fallback: here a HIGH value drops a post, so
    such a fallback would turn every broken embed into a veto.
    """
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return max(-1.0, min(1.0, dot))


def measure_act_similarity(
    *,
    candidate_text: str,
    # Shadows the imported `card_text()` helper inside this function; the
    # caller passes its already-stripped result.
    card_text: str,
    prior_texts: Sequence[str],
    embedder: Embedder,
) -> ActSimilarity:
    """How close `candidate_text` sits to the closest of `prior_texts`, and to
    the account's card.

    One embed call: `[candidate, card, *prior]`, or `[candidate, card]` when
    the corpus is below `MIN_COMPARISON_CORPUS` (S2 §4) -- the card is
    measured on every candidate, a new account's included, and the candidate
    vector is kept for the post-vector ingest. The card is never a prior: it
    enters `card_sim`, never `max_sim`. An empty card is left out of the
    batch and has no `card_sim`.

    Any embedder failure, short or mismatched batch, or unusable vector
    yields `max_sim`, `card_sim` and `vector` all `None` with
    `embedder_ok=False`. `ValueError` is caught too: `EmbedderClient.embed`
    raises it for a batch above `MAX_BATCH`.
    """
    corpus = list(prior_texts)
    compared = corpus if len(corpus) >= MIN_COMPARISON_CORPUS else []
    card = [card_text] if card_text else []
    batch = [candidate_text, *card, *compared]
    failed = ActSimilarity(max_sim=None, compared_against=len(corpus), embedder_ok=False)
    try:
        vectors = embedder.embed(batch)
    except (EmbedderUnavailable, ValueError):
        return failed

    if len(vectors) != len(batch):
        return failed
    candidate_vector, *rest = vectors
    if not candidate_vector or any(len(v) != len(candidate_vector) for v in rest):
        return failed
    card_vectors, prior_vectors = rest[: len(card)], rest[len(card) :]

    return ActSimilarity(
        max_sim=(
            max(_cosine(candidate_vector, v) for v in prior_vectors) if prior_vectors else None
        ),
        compared_against=len(corpus),
        embedder_ok=True,
        card_sim=_cosine(candidate_vector, card_vectors[0]) if card_vectors else None,
        vector=list(candidate_vector),
    )


_SIMILARITY_FETCH_FAILED: Final = "could not fetch prior posts"
_SIMILARITY_EMBEDDER_DOWN: Final = "embedder unreachable"
_SIMILARITY_CORPUS_TOO_SMALL: Final = f"fewer than {MIN_COMPARISON_CORPUS} prior posts"


def _similarity_event(
    sim: ActSimilarity,
    *,
    window: int,
    threshold: float,
    reason: str | None,
    round_id: str | None,
) -> LabEvent:
    """The `/lab` row for one post candidate, dropped or not.

    `cycle`/`act` moves no `/lab` counter. `action` is unset: this row is a
    measurement, the executor files the real `post` event. The measured
    summary is a contract with `server/src/modules/agents/persona/collapse.ts`,
    which selects on it, so a dropped candidate keeps it and says `dropped`
    in `metrics`. `metrics` stays flat (the ingest schema rejects nested
    values), and `maxSim` is `null`, never `0.0`, when it was not computed.

    `cardSim` (S2 §4) is `null` when not computed. `roundId` is omitted when
    the cycle has none (a resumed thread checkpointed before S2).
    """
    measured = sim.max_sim is not None
    metrics: dict[str, Any] = {
        "maxSim": sim.max_sim,
        "comparedAgainst": sim.compared_against,
        "embedderOk": sim.embedder_ok,
        "window": window,
        "threshold": threshold,
        "dropped": sim.dropped,
        "cardSim": sim.card_sim,
    }
    if round_id is not None:
        metrics["roundId"] = round_id
    return LabEvent(
        type="cycle",
        phase="act",
        outcome="success" if measured else "skip",
        summary=(
            "act self-similarity measured" if measured else "act self-similarity not computed"
        ),
        reason=reason,
        metrics=metrics,
    )


def _similarity_reason(sim: ActSimilarity) -> str | None:
    if sim.max_sim is not None:
        return None
    return _SIMILARITY_EMBEDDER_DOWN if not sim.embedder_ok else _SIMILARITY_CORPUS_TOO_SMALL


def _warn_embedder_unreachable(username: str) -> None:
    logger.warning("act-similarity: %s — embedder unreachable; skipping (fail-open)", username)


def similarity_step(
    *,
    resources: Resources,
    persona: Persona,
    actions: Sequence[Action],
    embedder: Embedder | None,
    window: int = DEFAULT_POST_DUPLICATE_WINDOW,
    threshold: float = DEFAULT_POST_DUPLICATE_THRESHOLD,
    round_id: str | None = None,
) -> ActSimilarity | None:
    """Measure this round's candidate post against the account's OWN recent
    posts and its card, decide whether it is a near-duplicate, and record one
    lab event.

    Returns `None` when there is nothing to measure (no embedder, no post).
    `dropped` is true only for a computed `max_sim >= threshold`; a failed
    fetch, a down embedder or too small a corpus fails open (`dropped`
    false). A failed fetch still embeds `[candidate, card]` (S2 §4), so the
    card similarity and the post's vector survive it. Never raises: any
    unexpected error is logged and yields `None`, which also fails open.
    """
    try:
        if embedder is None:
            return None
        candidate = candidate_post_text(actions)
        if candidate is None:
            return None
        card = card_text(persona.card)

        try:
            items = resources.user_posts(persona.username, limit=window)
        except ApiError as exc:
            logger.warning(
                "act-similarity: %s — could not fetch prior posts (%s); skipping",
                persona.username,
                exc,
            )
            sim = measure_act_similarity(
                candidate_text=candidate, card_text=card, prior_texts=[], embedder=embedder
            )
            if not sim.embedder_ok:
                _warn_embedder_unreachable(persona.username)
            resources.lab_event(
                persona.username,
                _similarity_event(
                    sim,
                    window=window,
                    threshold=threshold,
                    reason=_SIMILARITY_FETCH_FAILED,
                    round_id=round_id,
                ),
            )
            return sim

        sim = measure_act_similarity(
            candidate_text=candidate,
            card_text=card,
            prior_texts=prior_post_texts(items),
            embedder=embedder,
        )
        if not sim.embedder_ok:
            _warn_embedder_unreachable(persona.username)
        if sim.max_sim is not None and sim.max_sim >= threshold:
            sim = sim.model_copy(update={"dropped": True})
            logger.warning(
                "act-similarity: %s — post dropped as a near-duplicate (max_sim %.3f >= %s)",
                persona.username,
                sim.max_sim,
                threshold,
            )
        resources.lab_event(
            persona.username,
            _similarity_event(
                sim,
                window=window,
                threshold=threshold,
                reason=_similarity_reason(sim),
                round_id=round_id,
            ),
        )
        return sim
    except Exception as exc:
        logger.debug("act-similarity failed for %s", persona.username, exc_info=exc)
        logger.warning(
            "act-similarity: %s — sampling failed (%s: %s); the round is unaffected",
            persona.username,
            type(exc).__name__,
            exc,
        )
        return None


def duplicate_veto_reason(sim: ActSimilarity, threshold: float) -> str:
    return f"near-duplicate of a recent post (max_sim {sim.max_sim:.3f} >= {threshold})"


def apply_duplicate_guard(
    actions: Sequence[Action], sim: ActSimilarity | None, *, threshold: float
) -> tuple[list[Action], list[VetoedAction]]:
    """Remove the candidate post when `sim` says it is a near-duplicate.

    A plan left empty becomes a single `nothing`, so the round still records
    that it did nothing.
    """
    if sim is None or not sim.dropped:
        return list(actions), []
    kept = list(actions)
    index = next(i for i, action in enumerate(kept) if action.kind == "post")
    vetoed = [VetoedAction(action=kept.pop(index), reason=duplicate_veto_reason(sim, threshold))]
    if not kept:
        kept = [Action(kind="nothing")]
    return kept, vetoed


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
    ~1.0. It lives here rather than in `run_act` so the graph path gets it
    too. `embedder=None` disables it.

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
    round's outcome. The caller must hold both the act and the dream lock."""
    try:
        moved = rotate_memory(directory / "memory.md")
    except (OSError, ValueError) as exc:
        logger.warning(
            "memory rotation failed for %s (%s); the round is unaffected", agent_name, exc
        )
        return
    if moved:
        logger.info("memory rotated for %s — %d lines archived", agent_name, moved)


def run_act(
    *,
    persona: Persona,
    resources: Resources,
    backend: Backend,
    memory_text: str,
    agent_root: Path,
    now: datetime,
    rng: random.Random,
    health_check: Callable[[], bool],
    budget: int = 5,
    context_now: str = "(no context file)",
    feed_context: str = "",
    dry_run: bool = False,
    access_key: str | None = None,
    embedder: Embedder | None = None,
    era_start: datetime | None = None,
    post_probability: int = DEFAULT_POST_PROBABILITY,
    post_ceiling: int = DEFAULT_POST_CEILING_PER_DAY,
    duplicate_window: int = DEFAULT_POST_DUPLICATE_WINDOW,
    duplicate_threshold: float = DEFAULT_POST_DUPLICATE_THRESHOLD,
    probe_board: str | None = None,
    round_id: str | None = None,
) -> ActResult:
    """One act round: login -> sync -> context + rhythm -> plan -> guardrails
    -> duplicate guard + execute -> finalize.

      * Offline health probe -> `OFFLINE`, nothing else attempted.
      * A held lock raises `LockBusy` out of this function; the caller treats
        it as a skip.
      * `plan_step` returning `None` -> `BACKEND_UNAVAILABLE`.
      * Guardrails emptying the plan -> that `empty_outcome`, nothing executed.
      * The duplicate guard's veto is appended to `vetoed`; a round it empties
        is `VETOED_EMPTY`.

    `dry_run` is threaded through the steps that write (each is inert under
    it), so a dry round still plans and applies guardrails and returns
    `plan`/`vetoed` with `results == []` and `attempted == 0`.

    `agent_name` (lock path, executor, FAIL line) is the directory name, not
    the username. `health_check` and `access_key` come from the composition
    root. `round_id` labels the similarity event and the post-vector ingest.
    """
    if probe_board and not dry_run:
        raise ValueError("--probe-board requires --dry-run")

    login = login_step(
        persona=persona,
        agent_root=agent_root,
        health_check=health_check,
        dry_run=dry_run,
    )
    if not login.online:
        return ActResult(outcome=ActOutcome.OFFLINE)

    agent_name = login.agent_name

    def locked() -> ActResult:
        sync_backend_step(
            resources=resources, persona=persona, agent_name=agent_name, dry_run=dry_run
        )

        ctx, rhythm = context_step(
            resources=resources,
            persona=persona,
            memory_text=memory_text,
            now=now,
            rng=rng,
            budget=budget,
            context_now=context_now,
            feed_context=feed_context,
            era_start=era_start,
            post_probability=post_probability,
            post_ceiling=post_ceiling,
            probe_board=probe_board,
        )

        plan = plan_step(backend=backend, persona=persona, context=ctx, rhythm=rhythm)
        if plan is None:
            return ActResult(outcome=ActOutcome.BACKEND_UNAVAILABLE, rhythm=rhythm, context=ctx)

        guarded = guardrail_step(
            plan=plan,
            persona=persona,
            rhythm=rhythm,
            context=ctx,
            budget=budget,
        )

        if guarded.empty_outcome is not None:
            return ActResult(
                outcome=guarded.empty_outcome,
                vetoed=guarded.vetoed,
                rhythm=rhythm,
                plan=plan,
                context=ctx,
            )

        step = execute_step(
            resources=resources,
            persona=persona,
            actions=guarded.actions,
            agent_name=agent_name,
            now=now,
            access_key=access_key,
            dry_run=dry_run,
            embedder=embedder,
            duplicate_window=duplicate_window,
            duplicate_threshold=duplicate_threshold,
            round_id=round_id,
        )

        outcome = finalize_step(
            resources=resources,
            actions=step.actions,
            agent_name=agent_name,
            attempted=step.attempted,
            landed=step.landed,
            solo_nothing=guarded.solo_nothing,
            dry_run=dry_run,
            emptied=step.emptied,
        )

        return ActResult(
            outcome=outcome,
            results=step.results,
            vetoed=[*guarded.vetoed, *step.vetoed],
            rhythm=rhythm,
            plan=plan,
            context=ctx,
            attempted=step.attempted,
            landed=step.landed,
        )

    with login.lock:
        result = locked()
        if not dry_run:
            # A standalone `dream` appends to memory.md under the dream lock
            # alone, so rotation also needs it. Busy means a dream is running:
            # skip, and the next round rotates.
            try:
                with FileLock(dream_lock_path(agent_root, agent_name)):
                    rotate_memory_soft(persona.directory, agent_name)
            except LockBusy:
                logger.info("memory rotation skipped for %s — dream lock held", agent_name)
        return result
