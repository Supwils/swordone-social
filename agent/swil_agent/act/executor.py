"""Execute one approved action and verify it actually landed.

Implements `execute_action` (contract `02` §2) plus the call sites for the
`cycle`/`act` lab events it fires (contract `02` §5.3).

**Write verification is the whole point of this module** (design spec §7.2).
A write is never judged by an exit code alone: a 2xx with no created row
(codex's `comment` and `like`) would otherwise log `DONE` while persisting
nothing (`likes.controller.ts`/`comments.controller.ts` 2xx, no row). Every
`Resources` write already raises `WriteNotVerifiedError` on a 2xx with no
provable created/changed state (Task 1); this module's job is to never
swallow that into a false "landed". A caught `ApiError` or
`WriteNotVerifiedError` always yields `landed=False` and a `detail` string
that preserves the response body; `ApiError`'s own `__str__` already carries
`status` and `body[:300]` (`api/client.py`), so reusing it unmodified is the
fix, not a new formatter.

Two rules are preserved deliberately:

Two Bash rules are preserved deliberately, not just left as historical
trivia:

  * **`follow` 409 / `CONFLICT` is idempotent success** (loop-engine spec
    §6) — `landed=True`, `call_succeeded=False`, no memory line. That is
    "already following": the edge exists, the round is not a failure, and
    no memory line is written. Any other `ApiError` /
    `WriteNotVerifiedError` is `landed=False`, so a 500 never looks like a
    healthy round in the tally.

    `Resources.follow` does NOT absorb a 409 (ruling R20): every non-2xx
    reaches the `except` branch below, which logs `WARN`, emits a `warn`
    event and writes no memory line.
  * **This module's own DM lab event never carries the message body**
    (contract `02` §2.6) — the `cycle/act/success` event it files sends only
    `"→@{username}"`.

    **That is NOT the same as "DM bodies stay out of the observation
    layer".** A second, independent event exists: `act/memory_log.py`'s
    `_write_memory_line` fires `memory/memory/success` for every memory
    line, and its `summary` is the WHOLE note -- for a dm
    `dm | to=<user> conversationId=<id> | <first 80 chars of the body>`. So
    the first 80 characters of a DM body DO reach
    `POST /agents/{username}/events`. Whether that preview SHOULD be in the
    events table is a product question for whoever owns `/lab`, not
    something to change quietly here.

`collapse_doubled_text` (contract `02`, "cross-cutting facts") applies to
`post.text`, `comment.text`, `echo.text`, and `dm.text` — never to
`imageTopic`, never to usernames.
"""

from __future__ import annotations

import logging
from typing import Protocol

import httpx

from swil_agent.act.execution_outcome import (
    ExecutionOutcome,
    _clean,
    _clean_username,
    _error_detail,
    _outcome,
    _skip,
)
from swil_agent.api.client import ApiError
from swil_agent.api.images import ImageFetchError, fetch_unsplash_image
from swil_agent.api.resources import Resources, WriteNotVerifiedError
from swil_agent.llm.extract import collapse_doubled_text
from swil_agent.models import Action, ActionResult

logger = logging.getLogger(__name__)

_SUMMARY_CAP = 200

# ECMAScript `String.prototype.trim` whitespace: WhiteSpace + LineTerminator.
# Python's `str.strip()` keeps U+FEFF (and strips a few C0/C1 separators JS keeps),
# so the server's `trim().min(1)` would disagree with a plain `.strip()`.
_JS_TRIM_CHARS = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_LOG_PREVIEW_CAP = 60
_QUOTE_PREVIEW_CAP = 40

# The two exception types a write can raise that must both be treated as
# "did not land" — a transport/HTTP failure (`ApiError`, which
# `TransportError` also is-a) and a 2xx response with no provable created
# state (`WriteNotVerifiedError`). Named once so every `except` clause below
# stays in lockstep; the write-verification test would catch either half
# drifting out of sync with the other.
_WriteFailure = (ApiError, WriteNotVerifiedError)


class ImageFetcher(Protocol):
    """Structurally matches `fetch_unsplash_image`'s real signature
    (`api/images.py`), not the brief's guessed one — the brief assumed a
    single-argument `topic -> (filename, bytes)` callable, but the actual
    function additionally requires `access_key` (Unsplash's `Client-ID`
    credential; an empty string routes straight to the Picsum fallback, see
    `images.py`'s `_fetch_unsplash`) and accepts an optional `transport` for
    test injection. A `Protocol` shaped to the guessed signature would
    reject `fetch_unsplash_image` itself as the default value under
    `mypy --strict`.
    """

    def __call__(
        self,
        topic: str,
        access_key: str,
        transport: httpx.BaseTransport | None = None,
    ) -> tuple[str, bytes]: ...


def _execute_post(
    resources: Resources,
    action: Action,
    *,
    agent_name: str,
    images: ImageFetcher,
    access_key: str,
    board_id: str | None,
) -> ExecutionOutcome:
    text = _clean(action.text)
    if not text:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="empty text",
            lab_summary="post skipped: empty text",
        )
    text = collapse_doubled_text(text)

    # imageTopic gets the same whitespace cleanup as text but NEVER
    # collapse_doubled_text — contract 02's cross-cutting facts, pinned by
    # test_image_topic_is_not_collapsed.
    image_topic = _clean(action.image_topic)
    image: tuple[str, bytes] | None = None
    image_detail: str | None = None
    if image_topic:
        try:
            image = images(image_topic, access_key)
        except ImageFetchError as exc:
            # Bash degrades silently here (empty IMGFILE -> the non-multipart
            # branch, no error surfaced) -- contract 02 §2.1. This module
            # keeps the degrade-to-text-only behavior but says so in detail,
            # instead of staying silent about it.
            image_detail = f"image fetch failed, posted text-only: {exc}"

    try:
        post_id = resources.create_post(text, board_id=board_id, image=image)
    except _WriteFailure as exc:
        return _outcome(
            action,
            landed=False,
            resource_id=None,
            detail=_error_detail(exc),
            log_line=f"WARN {agent_name} post failed",
            lab_outcome="warn",
            lab_summary="post request failed",
        )

    img_tag = f" [img:{image_topic}]" if image_topic else ""
    return _outcome(
        action,
        landed=True,
        resource_id=post_id,
        detail=image_detail,
        log_line=f"DONE {agent_name} posted{img_tag}: {text[:_LOG_PREVIEW_CAP]}…",
        lab_outcome="success",
        lab_summary=text[:_SUMMARY_CAP],
    )


def _execute_comment(resources: Resources, action: Action, *, agent_name: str) -> ExecutionOutcome:
    post_id = (action.post_id or "").strip()
    text = collapse_doubled_text(_clean(action.text))
    if not post_id or not text:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="missing postId or text",
            lab_summary="comment skipped: missing postId or text",
        )
    parent_id = (action.parent_id or "").strip() or None

    try:
        comment_id = resources.create_comment(post_id, text, parent_id)
    except _WriteFailure as exc:
        primary_error = exc
    else:
        reply_tag = f" (reply to {parent_id})" if parent_id else ""
        return _outcome(
            action,
            landed=True,
            resource_id=comment_id,
            detail=None,
            log_line=f"DONE {agent_name} commented on {post_id}{reply_tag}",
            lab_outcome="success",
            lab_summary=text[:_SUMMARY_CAP],
            lab_target_id=post_id,
        )

    # Parent-ID fallback (contract 02 §2.2, spec §6.6): a reply is scoped to
    # its post server-side, so a mismatched (postId, parentId) pair 404s
    # "Parent comment not found" -- the model reads parentId out of the
    # notification list and postId out of the feed, so a stale pairing is a
    # routine miss, not a malformed decision, and the failed call created
    # nothing. Retry ONLY fires when parent_id was actually set: a plain
    # top-level comment failure has nothing left to fall back to.
    if parent_id:
        try:
            comment_id = resources.create_comment(post_id, text, None)
        except _WriteFailure as retry_error:
            return _outcome(
                action,
                landed=False,
                resource_id=None,
                detail=_error_detail(retry_error),
                log_line=f"WARN {agent_name} comment failed",
                lab_outcome="warn",
                lab_summary="comment request failed",
                lab_target_id=post_id,
            )
        return _outcome(
            action,
            landed=True,
            resource_id=comment_id,
            detail="parent unusable — posted top-level",
            log_line=(
                f"DONE {agent_name} commented on {post_id} "
                f"(parent {parent_id} unusable — posted top-level)"
            ),
            lab_outcome="success",
            lab_summary=text[:_SUMMARY_CAP],
            lab_target_id=post_id,
        )

    return _outcome(
        action,
        landed=False,
        resource_id=None,
        detail=_error_detail(primary_error),
        log_line=f"WARN {agent_name} comment failed",
        lab_outcome="warn",
        lab_summary="comment request failed",
        lab_target_id=post_id,
    )


def _execute_like(resources: Resources, action: Action, *, agent_name: str) -> ExecutionOutcome:
    post_id = (action.post_id or "").strip()
    if not post_id:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="missing postId",
            lab_summary="like skipped: missing postId",
        )
    try:
        resources.like_post(post_id)
    except _WriteFailure as exc:
        return _outcome(
            action,
            landed=False,
            resource_id=None,
            detail=_error_detail(exc),
            log_line=f"WARN {agent_name} like failed",
            lab_outcome="warn",
            lab_summary="like request failed",
            lab_target_id=post_id,
        )
    return _outcome(
        action,
        landed=True,
        resource_id=None,
        detail=None,
        log_line=f"DONE {agent_name} liked {post_id}",
        lab_outcome="success",
        lab_summary="liked post",
        lab_target_id=post_id,
    )


def _is_follow_conflict(exc: ApiError | WriteNotVerifiedError) -> bool:
    """HTTP 409 or error code `CONFLICT` — "already following" (spec §6)."""
    return isinstance(exc, ApiError) and (exc.status == 409 or exc.code == "CONFLICT")


def _execute_follow(resources: Resources, action: Action, *, agent_name: str) -> ExecutionOutcome:
    username = _clean_username(action.username)
    if not username:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="missing username",
            lab_summary="follow skipped: missing username",
        )
    try:
        resources.follow(username)
    except _WriteFailure as exc:
        # Loop-engine spec §6: only 409 / `CONFLICT` is idempotent success
        # (`landed=True`, `call_succeeded=False`, no memory line). Any other
        # write failure is not landed — Bash's "every follow is landed" lie
        # hid a broken follow path inside a healthy tally.
        if _is_follow_conflict(exc):
            return _outcome(
                action,
                landed=True,
                # The follow write did NOT succeed, so no memory.md line
                # (rulings R19 + R20).
                call_succeeded=False,
                resource_id=None,
                detail=f"likely already following: {_error_detail(exc)}",
                log_line=f"WARN {agent_name} follow @{username} failed (likely already following)",
                lab_outcome="warn",
                lab_summary="follow request failed",
                lab_reason=username,
            )
        return _outcome(
            action,
            landed=False,
            resource_id=None,
            detail=_error_detail(exc),
            log_line=f"WARN {agent_name} follow @{username} failed",
            lab_outcome="warn",
            lab_summary="follow request failed",
            lab_reason=username,
        )
    return _outcome(
        action,
        landed=True,
        resource_id=None,
        detail=None,
        log_line=f"DONE {agent_name} followed @{username}",
        lab_outcome="success",
        lab_summary=f"followed @{username}",
    )


def _execute_echo(resources: Resources, action: Action, *, agent_name: str) -> ExecutionOutcome:
    post_id = (action.post_id or "").strip()
    if not post_id:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="missing postId",
            lab_summary="echo skipped: missing postId",
        )
    # Quote text is optional (a plain repost) -- only postId gates the skip.
    text = collapse_doubled_text(_clean(action.text))
    try:
        echo_id = resources.create_post(text, echo_of=post_id)
    except _WriteFailure as exc:
        return _outcome(
            action,
            landed=False,
            resource_id=None,
            detail=_error_detail(exc),
            log_line=f"WARN {agent_name} echo failed",
            lab_outcome="warn",
            lab_summary="echo request failed",
            lab_target_id=post_id,
        )
    quote_tag = f" (quote: {text[:_QUOTE_PREVIEW_CAP]})" if text else ""
    return _outcome(
        action,
        landed=True,
        resource_id=echo_id,
        detail=None,
        log_line=f"DONE {agent_name} echoed {post_id}{quote_tag}",
        lab_outcome="success",
        # A plain repost has no text, and the server refuses an empty
        # summary (`trim().min(1)`), dropping the event. "echoed post" is
        # `like`'s "liked post": the target is already in `targetId`.
        lab_summary=_echo_summary(text),
        lab_target_id=post_id,
    )


def _echo_summary(text: str) -> str:
    capped = text[:_SUMMARY_CAP]
    return capped if capped.strip(_JS_TRIM_CHARS) else "echoed post"


def _execute_dm(resources: Resources, action: Action, *, agent_name: str) -> ExecutionOutcome:
    username = _clean_username(action.username)
    text = collapse_doubled_text(_clean(action.text))
    if not username or not text:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="missing username or text",
            lab_summary="dm skipped: missing username or text",
        )
    try:
        conversation_id, message_id = resources.send_dm(username, text)
    except _WriteFailure as exc:
        return _outcome(
            action,
            landed=False,
            resource_id=None,
            detail=_error_detail(exc),
            log_line=f"WARN {agent_name} dm to @{username} failed",
            lab_outcome="warn",
            lab_summary="dm request failed",
            lab_reason=username,
        )
    # Recipient only, never the body (contract 02 §2.6) -- private
    # conversations stay out of the observation layer by design. A local
    # memory-line preview is Bash's other half of this asymmetry; ported
    # memory.md writing is a Phase 2 concern, out of scope here.
    return _outcome(
        action,
        landed=True,
        resource_id=message_id,
        detail=None,
        log_line=f"DONE {agent_name} dm → @{username}",
        lab_outcome="success",
        lab_summary=f"→@{username}",
        conversation_id=conversation_id,
    )


def _execute_nothing(action: Action, *, agent_name: str) -> ExecutionOutcome:
    return _outcome(
        action,
        landed=True,
        resource_id=None,
        detail=None,
        log_line=f"DONE {agent_name} — chose to do nothing",
        lab_outcome="success",
        lab_summary="chose to do nothing",
    )


def execute_action(
    resources: Resources,
    action: Action,
    *,
    agent_name: str,
    username: str,
    images: ImageFetcher = fetch_unsplash_image,
    access_key: str = "",
    board_id: str | None = None,
) -> ActionResult:
    """Execute one planned action and report whether it actually landed.

    Success is decided by a RETURNED RESOURCE ID (or, for `like`/`follow`, a
    verified state change), never by the absence of an exception (design
    spec §7.2) -- the root-cause fix for the codex silent failures: an
    exit-code-only check saw a 2xx with no
    created row and logged `DONE` and the round tallied a landing that never
    happened. Every `Resources` write already raises on that shape (Task
    1); this function's only job is to never catch that exception and treat
    it as success anyway.

    A failed action never aborts the round -- the caller tallies results
    (contract `02` §3.1); this function always returns a value, never
    raises for an ordinary write failure.

    `agent_name` feeds the log line and the follow-failure lab reason;
    `username` is who the lab event is filed under
    (`POST /agents/{username}/events`, contract `02` §5.3) -- unrelated to
    which account authenticated the underlying write, which `resources`
    already carries baked into its `ApiClient`.

    `images`/`access_key`/`board_id` are extension points the brief's own
    `execute_action` sketch omitted despite requiring them for the `post`
    kind's `create_post(text, board_id=..., image=...)` call and this
    module's `ImageFetcher` Protocol: `images` defaults to the real
    `fetch_unsplash_image` (R5 — tests inject a fake), `access_key` defaults
    to `""` (routes straight to the Picsum fallback, matching bash's own
    `[[ -n "${UNSPLASH_ACCESS_KEY:-}" ]]` skip), and `board_id` defaults to
    `None` (unfiled post) since neither `Action` nor this function's brief
    signature carries a persona's `Board` bullet -- that resolution belongs
    to whichever caller assembles the round (not yet ported), not to a
    single action's executor.
    """
    if action.kind == "post":
        outcome = _execute_post(
            resources,
            action,
            agent_name=agent_name,
            images=images,
            access_key=access_key,
            board_id=board_id,
        )
    elif action.kind == "comment":
        outcome = _execute_comment(resources, action, agent_name=agent_name)
    elif action.kind == "like":
        outcome = _execute_like(resources, action, agent_name=agent_name)
    elif action.kind == "follow":
        outcome = _execute_follow(resources, action, agent_name=agent_name)
    elif action.kind == "echo":
        outcome = _execute_echo(resources, action, agent_name=agent_name)
    elif action.kind == "dm":
        outcome = _execute_dm(resources, action, agent_name=agent_name)
    elif action.kind == "nothing":
        outcome = _execute_nothing(action, agent_name=agent_name)
    else:
        # `action.kind` is `ActionKind`, a closed 7-member Literal, and
        # `Action` validates it at construction time (Task 1's models.py) --
        # unlike bash, which reads a free-form string off decision JSON and
        # has a real "unknown action" branch (contract 02 §2.8). There is no
        # runtime path into this `else` for a Python-constructed `Action`;
        # it exists so mypy sees every branch return and so this function
        # never silently mishandles a future ActionKind addition -- it
        # raises loudly here instead of falling through to unhandled state.
        raise AssertionError(f"unhandled action kind: {action.kind!r}")  # pragma: no cover

    # `log_line` is the per-action DONE/WARN/SKIP line. `agent/logs/
    # auto-run.log` is what straggler reconciliation and post-run QA grep
    # after a round; a Python round that never wrote a line there is
    # indistinguishable from a round that never happened.
    #
    # Level from the lab outcome rather than by re-parsing the line's own
    # DONE/WARN/SKIP prefix -- same fact, already typed. The FILE handler
    # renders `[ts] <message>` with no level (Bash's `_log` format exactly,
    # see `cli/logs.py`); the level only shapes the stderr stream.
    logger.log(
        logging.INFO if outcome.lab_event.outcome == "success" else logging.WARNING,
        "%s",
        outcome.log_line,
    )
    resources.lab_event(username, outcome.lab_event)
    return outcome.result
