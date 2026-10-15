"""The act path's smart mark-read: which notifications a round answered,
and the one `POST /notifications/read` that clears them.

Moved out of `act/round.py` verbatim (S3 §9); `finalize_step` there is the
only caller.
"""

from __future__ import annotations

from typing import Any, Final

from swil_agent.api.client import ApiError
from swil_agent.api.resources import Resources
from swil_agent.models import Action

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
