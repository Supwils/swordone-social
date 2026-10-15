"""The planner context's pure formatters (contract `01` §2): the
`memory.md`-derived fields, era isolation, and the feed, notification,
thread and conversation renderers.

No I/O and no `Resources`: every function here maps already-fetched data
(or the memory text) to a prompt string. Moved out of `act/context.py`
verbatim (S3 §9); `build_context` there does the fetching and calls these.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any

_POST_LINE = re.compile(r"\| post \|")
_ENGAGED_LINE = re.compile(r"^\d{4}-\d{2}-\d{2} \| (?:like|comment) \|")
_POST_ID = re.compile(r"postId=([a-f0-9]{24})")

_ENGAGED_TAIL_LINES = 50
_ENGAGED_MAX_IDS = 30

_GLOBAL_FEED_TEXT_CAP = 220
_TIMELINE_TEXT_CAP = 140
_PREVIEW_CAP = 50

_THREAD_TARGETS = 3
_THREAD_MIN_COMMENTS = 2
_THREAD_COMMENT_LIMIT = 6

_DM_PREVIEW_CAP = 60


# ── memory-derived fields (contract 01 §2e/§2f, local — no API) ────────────


def posts_today(memory_text: str, today: str) -> int:
    """Count today's `post` entries in memory.md.

    A LOCAL count, not an API call: the daily-ceiling gate reads it, and
    memory.md is the record of what this account itself posted.
    """
    return sum(
        1 for line in memory_text.splitlines() if line.startswith(today) and _POST_LINE.search(line)
    )


def engaged_post_ids(memory_text: str) -> str:
    """Comma-joined post ids this account already liked or commented on.

    Pipeline from contract 01 §2e: keep dated like/comment lines, take the last
    50, extract every `postId=<24 hex>`, dedupe, sort, cap at 30. `post` lines
    are excluded by the line filter -- they carry `id=`, not `postId=`, and
    counting them would tell the model it had already engaged with its own posts.
    """
    matched = [line for line in memory_text.splitlines() if _ENGAGED_LINE.match(line)]
    ids = {m.group(1) for line in matched[-_ENGAGED_TAIL_LINES:] for m in _POST_ID.finditer(line)}
    return ",".join(sorted(ids)[:_ENGAGED_MAX_IDS])


def last_post_line(memory_text: str) -> str:
    posts = [line for line in memory_text.splitlines() if _POST_LINE.search(line)]
    return posts[-1] if posts else "(暂无发帖记录)"


def _feed_usernames(items: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for item in items:
        username = _author(item).get("username")
        if isinstance(username, str) and username:
            names.append(username)
    return names


def _conversation_usernames(items: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for item in items:
        participants = item.get("participants")
        if not isinstance(participants, list):
            continue
        for participant in participants:
            if isinstance(participant, dict):
                username = participant.get("username")
                if isinstance(username, str) and username:
                    names.append(username)
    return names


def _counterparties(
    recommended: list[dict[str, Any]],
    timeline: list[dict[str, Any]],
    conversations: list[dict[str, Any]],
) -> list[str]:
    """Usernames the round actually assembled: feed authors and DM partners.

    Spec §8: retrieval prefers dated lines that mention these, not the
    whole log. Deduped, order of first appearance — matching does not
    depend on order.
    """
    seen: set[str] = set()
    names: list[str] = []
    for username in (
        *_feed_usernames(recommended),
        *_feed_usernames(timeline),
        *_conversation_usernames(conversations),
    ):
        if username not in seen:
            seen.add(username)
            names.append(username)
    return names


# ── era isolation ───────────────────────────────────────────────────────────


def _as_utc(moment: datetime) -> datetime:
    """A naive datetime is read as UTC, the server's clock."""
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment


def _since(era_start: datetime | None) -> str | None:
    return _as_utc(era_start).isoformat() if era_start is not None else None


def _created_at(item: dict[str, Any]) -> datetime | None:
    raw = item.get("createdAt")
    if not isinstance(raw, str):
        return None
    try:
        return _as_utc(datetime.fromisoformat(raw.replace("Z", "+00:00")))
    except ValueError:
        return None


def _within_era(items: list[dict[str, Any]], era_start: datetime | None) -> list[dict[str, Any]]:
    """Drop items created before `era_start`; identity when no era is set.

    An item with a missing or unparseable `createdAt` is dropped: it cannot
    be shown to belong to this era.
    """
    if era_start is None:
        return items
    start = _as_utc(era_start)
    return [
        item for item in items if (created := _created_at(item)) is not None and created >= start
    ]


# ── feed formatters (contract 01 §2g/§2h) ───────────────────────────────────


def _flat(text: object, cap: int) -> str:
    return str(text or "").replace("\n", " ")[:cap]


def _day(item: dict[str, Any]) -> str:
    return str(item.get("createdAt", ""))[:10]


def _author(item: dict[str, Any]) -> dict[str, Any]:
    author = item.get("author")
    return author if isinstance(author, dict) else {}


def format_global_feed(items: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"postId:{item.get('id', '')} | @{_author(item).get('username', '')}"
        f"（{_day(item)}）♥{item.get('likeCount', 0)} 💬{item.get('commentCount', 0)}: "
        f"{_flat(item.get('text'), _GLOBAL_FEED_TEXT_CAP)}"
        for item in items
    )


def format_timeline_feed(items: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"postId:{item.get('id', '')} | @{_author(item).get('username', '')}"
        f"（{_day(item)}）: {_flat(item.get('text'), _TIMELINE_TEXT_CAP)}"
        for item in items
    )


# ── notifications (contract 01 §2j) ────────────────────────────────────────


def format_notifications(items: list[dict[str, Any]]) -> str:
    """Render the unread-notifications block, one line per notification.

    The `postId:` label carries the POST's id (`NotificationDTO.post.id`), not
    the notification's own id, so the model can act on the post directly.
    """
    lines: list[str] = []
    for item in items:
        actor = item.get("actor")
        actor = actor if isinstance(actor, dict) else {}
        line = (
            f"- [{item.get('type', '')}] @{actor.get('username', '')}"
            f"（{actor.get('displayName', '')}）"
        )
        post = item.get("post")
        if isinstance(post, dict):
            preview = _flat(post.get("textPreview"), _PREVIEW_CAP)
            line += f"：postId:{post.get('id', '')} 帖子「{preview}」"
        comment = item.get("comment")
        if isinstance(comment, dict):
            preview = _flat(comment.get("textPreview"), _PREVIEW_CAP)
            line += f" / 评论ID:{comment.get('id', '')}（属于上面那个 postId）内容：「{preview}」"
        lines.append(line)
    return "\n".join(lines)


# ── thread targets + rendering (contract 01 §2i) ────────────────────────────


def select_thread_targets(items: list[dict[str, Any]], *, engaged: str) -> list[str]:
    skip = {part for part in engaged.split(",") if part}
    busy = [
        item
        for item in items
        if int(item.get("commentCount") or 0) >= _THREAD_MIN_COMMENTS
        and str(item.get("id", "")) not in skip
    ]
    busy.sort(key=lambda item: -int(item.get("commentCount") or 0))
    return [str(item["id"]) for item in busy[:_THREAD_TARGETS] if item.get("id")]


def _post_json(post: dict[str, Any]) -> str:
    """Pretty-print the post as a JSON object with a fixed key set and order.

    Every value is `.get(key)` with NO default, so a missing field renders as
    `null` instead of a fabricated `0` or `""`.
    """
    obj = {
        "id": post.get("id"),
        "author": _author(post).get("username"),
        "text": post.get("text"),
        "likeCount": post.get("likeCount"),
        "commentCount": post.get("commentCount"),
        "echoCount": post.get("echoCount"),
        "createdAt": post.get("createdAt"),
    }
    return json.dumps(obj, ensure_ascii=False, indent=2)


def format_thread(post: dict[str, Any], comments: list[dict[str, Any]]) -> str:
    """One thread block: the post header plus up to 6 comments.

    The post itself is the pretty-printed JSON object from `_post_json`, not a
    summary line. Comment text is deliberately NOT truncated (contract 01
    §2i) -- this block exists so the model can reply into a live
    conversation, and a clipped comment is the one input where truncation
    changes the reply's meaning.
    """
    head = f"=== POST {post.get('id', '')} ===\n{_post_json(post)}"
    rows: list[str] = []
    for comment in comments[:_THREAD_COMMENT_LIMIT]:
        commenter = _author(comment)
        reply = f" ↩reply→{comment['parentId']}" if comment.get("parentId") else ""
        rows.append(
            f"[{comment.get('id', '')}] @{commenter.get('username', '')}{reply} "
            f"（{_day(comment)}）♥{comment.get('likeCount', 0)}: "
            f"{str(comment.get('text') or '').replace(chr(10), ' ')}"
        )
    return head + "\n=== COMMENTS (up to 6) ===\n" + "\n".join(rows)


# ── conversations (contract 01 §2k) ─────────────────────────────────────────


_NO_LAST_MESSAGE = "（空）"


def format_conversations(items: list[dict[str, Any]]) -> str:
    """Render one line per conversation (contract 01 §2k): the conversation id
    and participant usernames, an unread marker only when unread, then a fixed
    two-space-separated preview label and the last message text (or the
    placeholder in `_NO_LAST_MESSAGE`, capped at 60 chars).
    """
    lines: list[str] = []
    for item in items:
        participants = item.get("participants")
        names = (
            ",".join(
                p.get("username", "")
                for p in participants
                if isinstance(p, dict) and isinstance(p.get("username"), str)
            )
            if isinstance(participants, list)
            else ""
        )
        unread = " ●未读" if item.get("unread") else ""
        last_message = item.get("lastMessage")
        text = last_message.get("text") if isinstance(last_message, dict) else None
        # jq's `//` only substitutes on null/false, never on "" -- an `or`
        # here would wrongly swallow a real empty-string message.
        preview = _flat(text if text is not None else _NO_LAST_MESSAGE, _DM_PREVIEW_CAP)
        lines.append(f"[{item.get('id', '')}] @{names}{unread}  最近：{preview}")
    return "\n".join(lines)
