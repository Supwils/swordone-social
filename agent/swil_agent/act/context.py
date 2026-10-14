"""Assemble the planner prompt context (contract `01` §2, §4).

`build_context` is the single entry point: it fetches every API-sourced
block through `Resources`, degrading per-block, and combines them with the
local `memory.md`-derived fields. See `swil_agent.models.ActContext` for the
two field classes (placeholder vs vanish) this module must preserve.

Era 3 read scope is the same for every account: the home board (in the
now-context) plus the global feed. Every feed and search read asks for
`since=<ERA_START>` and drops anything older client-side as well, so posts
from a sealed era never reach a prompt.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from swil_agent.act.memory import retrieve_memory
from swil_agent.api.client import ApiError
from swil_agent.api.resources import Resources
from swil_agent.llm.base import Runner
from swil_agent.models import ActContext, Persona

logger = logging.getLogger(__name__)

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


# ── world context: now-context, follow-topics feed, news digest ───────────
#
# Three design rules shape what follows:
#
#   - The renderers are in-process; nothing here shells out to a login command
#     or writes `context/now.md`. One shared file carrying a per-account line
#     races under five-way parallel rounds, so the now-context is rendered in
#     memory per account.
#   - `news_today.md` keeps its file and Python shells out to `news-fetch.sh`.
#     That script is a pure cache-filler (no auth, idempotent, owns its own
#     staleness and lock) shared by every account; reimplementing it here
#     would add a second writer.
#   - The rendered wording is pinned by literal-text tests; only the freshness
#     of the content changes between rounds.

WORLD_CONTEXT_UNAVAILABLE: Final = "（无法获取）"
"""Placeholder for both the platform-activity block and the news digest.
Placeholder-class, not vanish-class: the section heading stays and says the
read failed."""

NEWS_FETCH_SCRIPT: Final = "news-fetch.sh"
NEWS_CACHE_FILENAME: Final = "news_today.md"

NEWS_FETCH_TIMEOUT: Final = 180.0
"""Backstop for the `news-fetch.sh` subprocess, not a policy knob.

It must sit ABOVE the script's own worst case, because firing it is strictly
worse than waiting: `SubprocessRunner` enforces a timeout by SIGKILLing the
child, `SIGKILL` does not run the script's `trap ... EXIT`, and that trap is
what removes `$STATE_DIR/news_fetch.lock`. A timeout that fires therefore
ORPHANS the lock this constant exists to respect, and every later account
spins on it until `_lock`'s 120s steal window expires.

Derived from `news-fetch.sh`, so re-derive it when that script changes:

    _lock()'s spinlock cap   120s   `(( waited > 120 )) && return 1`, one
                                    `sleep 1` per iteration (:70, :74)
    curl --max-time           45s   `NEWS_TIMEOUT` default (:42, :88)
    -------------------------------
    script ceiling           165s   the reachable path is wait-then-fetch:
                                    the cap only ABORTS the wait, so a lock
                                    released at 120s is followed by a full
                                    45s download
    jq + mktemp + mv           ~     seconds, over a ~1.8 MB payload

180 is that ceiling plus the render tail. The previous value, 90, was derived
from the 45s download alone and was reachable by any account that waited ~50s
for the lock and then fetched slowly.
`test_the_news_fetch_timeout_clears_the_scripts_own_ceiling` pins the
RELATIONSHIP against the script read at test time, not this literal.
"""

_NOW_FEED_TEXT_CAP: Final = 120
_TOPIC_FEED_TEXT_CAP: Final = 200

_NOW_BOARD_LIMIT: Final = 12
_NOW_FALLBACK_LIMIT: Final = 15
# Equal to `_NOW_BOARD_LIMIT` by coincidence: two independent numbers on two
# different endpoints.
_TOPIC_SEARCH_LIMIT: Final = 12

NOW_CONTEXT_TEMPLATE: Final = """\
# 当前时间上下文

**今日日期：** {today}
**当前 Agent：** {username}

## 平台最新动态（用于校准时间感知）
{activity}

## 今日真实世界新闻（swil-news 日报，含各话题要点与总结）
{news}

（完整日报可访问：https://swil-news.vercel.app/api/news/{{topic}}/{{date}}）

## 注意事项
- 以上日期是系统真实时间，优先于模型自身的时间估计
- 发帖时涉及"最近""今天""当前"等表述，请以此日期为准
- 训练截止日之后的世界事件，如无用户提供的信息，请明确说明不确定性，不要臆造
- 上面这些新闻是**真实世界当天发生的事**，不是虚构素材。你可以据此发帖、评论、
  或完全忽略——取决于它是否落在你关心的领域里。引用时按你自己的视角解读，
  不要复述标题，也不要为了蹭热点去谈一个你的人设根本不关心的话题。
"""
"""The now-context prompt text.

The `{{topic}}` / `{{date}}` in the swil-news URL are LITERAL braces that
survive `str.format` -- they are part of the sentence the model reads, not
placeholders. Un-escaping either one turns a documentation URL into a
`KeyError` at render time for `topic`, and into the rendered date for
`date`. Only `today`, `username`, `activity` and `news` are substituted.
"""

_NOW_DATE_FORMAT: Final = "%Y年%m月%d日 %H:%M"
_FEED_DATE_FORMAT: Final = "%Y-%m-%d %H:%M"


def format_now_feed(items: list[dict[str, Any]]) -> str:
    """The now-context's platform-activity rows.

    A DIFFERENT line shape and a different cap from `format_global_feed`
    above, which renders the act path's own feed block: this one is keyed on
    the author's DISPLAY name (not `@username`), carries no like/comment
    counts, uses a full-width colon, and truncates at 120 rather than 220.
    The two blocks sit in the same prompt, so collapsing them onto one
    formatter would silently rewrite one of them -- which would change the prompt wording.
    """
    return "\n".join(
        f"- [{item.get('id', '')}] {_author(item).get('displayName', '')}"
        f"（{_day(item)}）：{_flat(item.get('text'), _NOW_FEED_TEXT_CAP)}"
        for item in items
    )


def format_topic_feed(items: list[dict[str, Any]]) -> str:
    """One `## #<topic>` block's rows. Cap is 200 here, not the now-feed's 120."""
    return "\n".join(
        f"- [{item.get('id', '')}] @{_author(item).get('username', '')}"
        f"（{_author(item).get('displayName', '')}）: "
        f"{_flat(item.get('text'), _TOPIC_FEED_TEXT_CAP)}"
        for item in items
    )


def _feed_or_blank(items: Callable[[], list[dict[str, Any]]], *, era_start: datetime | None) -> str:
    """One login-time feed read, era-filtered and rendered; `""` on any API
    failure, so a failed read costs its lines and never the login."""
    try:
        return format_now_feed(_within_era(items(), era_start))
    except ApiError:
        return ""


def platform_activity(
    resources: Resources,
    persona: Persona,
    *,
    now: datetime,
    era_start: datetime | None = None,
) -> str:
    """The 平台最新动态 block of the now-context.

    The home board at `limit=12`; when that yields nothing (empty, all
    pre-era, failed, or no board), the global feed at `limit=15`; when that
    is blank too, the placeholder. `now` is unused by the reads and kept for
    the caller's single-clock contract.
    """
    since = _since(era_start)
    home = persona.board.strip()

    activity = ""
    if home:
        activity = _feed_or_blank(
            lambda: resources.feed_board(home, limit=_NOW_BOARD_LIMIT, sort="latest", since=since),
            era_start=era_start,
        )
    if not activity.strip():
        activity = _feed_or_blank(
            lambda: resources.feed_global(limit=_NOW_FALLBACK_LIMIT, sort="latest", since=since),
            era_start=era_start,
        )
    return activity if activity.strip() else WORLD_CONTEXT_UNAVAILABLE


def read_news_digest(
    agent_root: Path, runner: Runner, *, timeout: float = NEWS_FETCH_TIMEOUT
) -> str:
    """Refresh the shared news cache, then read it (R27).

    `news-fetch.sh` owns the staleness check, the inter-process lock, and the
    fallback to the previous day's digest, so this is a two-line wrapper and
    not a port. Everything about it is best-effort:

      * A missing script is skipped silently rather than spawning `bash` on a
        path that does not exist. Every test `agent_root` is a `tmp_path`
        with no `scripts/` in it, and spawning a doomed subprocess 23 times a
        round buys nothing.
      * A subprocess that fails, times out, or cannot start at all costs a
        WARN and nothing else. `SubprocessRunner` signals the first two by
        returning `""` and the third by raising `BackendBinaryMissingError`,
        so both shapes have to be handled; R27 is explicit that a news
        outage must not fail the round, and the script is explicit about the
        same thing (`set -uo pipefail`, no `-e`: "a news outage must never
        abort a round").

    Trailing newlines are stripped. A cache that is empty or nothing but
    whitespace reads as unavailable.
    """
    script = agent_root / "scripts" / NEWS_FETCH_SCRIPT
    # EQUIVALENT MUTANT today (§7): production always has this file, so
    # `if True` behaves identically -- `SubprocessRunner` would raise
    # `BackendBinaryMissingError` only for a missing `bash`, and a `bash` on a
    # path that does not exist just exits non-zero into the `except` below.
    # The guard is here for the SUITE, where every `agent_root` is a
    # `tmp_path` with no `scripts/`, and it expires as a no-op the day this
    # function is called with an agent_root that legitimately has no
    # `news-fetch.sh` -- a worktree, a partial checkout -- at which point it
    # is the difference between one skip and 23 doomed subprocesses a round.
    if script.is_file():
        try:
            runner.run(["bash", str(script)], stdin=None, env=None, timeout=timeout)
        except (OSError, RuntimeError) as exc:
            logger.warning(
                "news refresh failed (%s: %s) -- using the cached digest", type(exc).__name__, exc
            )

    try:
        digest = (agent_root / "context" / NEWS_CACHE_FILENAME).read_text(encoding="utf-8")
    # `UnicodeDecodeError` is a `ValueError`, so `except OSError` alone does
    # NOT catch it -- the trap `locks.py:69-73` documents by name. This cache
    # is SHARED state that `news-fetch.sh` rewrites, so a single truncated
    # multi-byte write used to escape a function whose every other
    # degradation fails open, and take every account in the round with it.
    # Decoded, not `errors="replace"`: mojibake in the world context reaches
    # every persona prompt, and "unavailable" is the honest degradation.
    except (OSError, UnicodeDecodeError):
        return WORLD_CONTEXT_UNAVAILABLE
    # `rstrip("\n")`, deliberately not `.strip()`: only TRAILING newlines go,
    # so a leading blank line or an indented first line survives into the
    # prompt.
    digest = digest.rstrip("\n")
    return digest if digest.strip() else WORLD_CONTEXT_UNAVAILABLE


def render_now_context(*, username: str, now: datetime, activity: str, news: str) -> str:
    """`context/now.md`'s content, in memory (R26).

    `username` is the CALLER's -- the parameter, never a module-level value.
    That distinction is the entire defect: the file this replaces carried one
    account's name for all 23, because five parallel rounds wrote it in turn.
    """
    return NOW_CONTEXT_TEMPLATE.format(
        today=now.strftime(_NOW_DATE_FORMAT),
        username=username,
        activity=activity,
        news=news,
    )


def render_follow_topics_feed(
    resources: Resources,
    persona: Persona,
    *,
    now: datetime,
    era_start: datetime | None = None,
) -> str:
    """The 关联话题动态 feed: one `/posts/search` per `persona.topics` entry, in
    the persona's declared order, `limit=12`, era-filtered.

    A topic that returned nothing (or failed) contributes no heading. A
    persona with no topics gets `""`, which makes the planner drop the block.
    """
    if not persona.topics:
        return ""

    since = _since(era_start)
    text = f"# 关联话题动态 ({now.strftime(_FEED_DATE_FORMAT)})\n\n"
    for topic in persona.topics:
        try:
            found = resources.search_posts(topic, limit=_TOPIC_SEARCH_LIMIT, since=since)
        except ApiError:
            continue
        rows = format_topic_feed(_within_era(found, era_start))
        if rows:
            text += f"## #{topic}\n{rows}\n\n"
    return text


def overlay_probe_posts(ctx: ActContext, items: list[dict[str, Any]]) -> ActContext:
    """Prepend probe-board posts onto the already-assembled feed strings."""
    if not items:
        return ctx
    block = format_global_feed(items)
    if block:
        ctx.global_feed = f"{block}\n{ctx.global_feed}"
    # Only overlay the following-timeline block when the account already has
    # one. An empty string is load-bearing: the planner prompt drops that
    # heading, and filling it here would invent a timeline the field study
    # never assembled.
    if ctx.timeline_feed:
        time_block = format_timeline_feed(items)
        if time_block:
            ctx.timeline_feed = f"{time_block}\n{ctx.timeline_feed}"
    ctx.probe_post_ids = [str(item["id"]) for item in items if item.get("id")]
    return ctx


# ── build_context (contract 01 §4 — the asymmetry, enforced) ───────────────


def build_context(
    resources: Resources,
    persona: Persona,
    *,
    memory_text: str,
    now: datetime,
    budget: int,
    context_now: str = "(no context file)",
    feed_context: str = "",
    era_start: datetime | None = None,
) -> ActContext:
    """Assemble every prompt block, degrading per block.

    `context_now` and `feed_context` arrive already rendered (the caller
    builds them with `render_now_context` / `render_follow_topics_feed`).
    Both feed passes read the global feed; with `era_start` set, both ask for
    `since` and drop older items, so thread targets come only from this era.
    This function writes nothing.
    """
    since = _since(era_start)
    today = now.strftime("%Y-%m-%d")
    ctx = ActContext(
        context_now=context_now,
        feed_context=feed_context,
        recent_memory="",
        engaged_ids=engaged_post_ids(memory_text),
        today=today,
        today_post_count=posts_today(memory_text, today),
        last_post=last_post_line(memory_text),
        action_budget=budget,
        backend_action_constraint="",
    )

    recommended: list[dict[str, Any]] = []
    try:
        recommended = _within_era(
            resources.feed_global(limit=40, sort="recommended", since=since), era_start
        )
        ctx.global_feed = format_global_feed(recommended[:25]) or "(could not fetch feed)"
    except ApiError:
        pass  # placeholder-class: the default already reads "(could not fetch feed)"

    # vanish-class: on ApiError, timeline_feed stays "", so the whole section disappears.
    timeline: list[dict[str, Any]] = []
    with contextlib.suppress(ApiError):
        timeline = _within_era(
            resources.feed_global(limit=18, sort="latest", since=since), era_start
        )
        ctx.timeline_feed = format_timeline_feed(timeline)

    with contextlib.suppress(ApiError):
        ctx.notification_context = (
            format_notifications(resources.notifications(limit=8, unread_only=True))
            or "（暂无新互动）"
        )

    blocks: list[str] = []
    for post_id in select_thread_targets(recommended, engaged=ctx.engaged_ids):
        try:
            blocks.append(
                format_thread(
                    resources.get_post(post_id),
                    resources.get_comments(post_id, limit=_THREAD_COMMENT_LIMIT),
                )
            )
        except ApiError:
            continue  # one bad thread contributes nothing; the others still render
    ctx.thread_context = "\n\n".join(blocks)

    try:
        ctx.contacts = resources.contacts()
        ctx.contacts_list = "\n".join(ctx.contacts)
    except ApiError:
        pass

    conversations: list[dict[str, Any]] = []
    with contextlib.suppress(ApiError):
        conversations = resources.conversations(limit=6)
        ctx.dm_context = format_conversations(conversations)

    # The planner sees a retrieved slice, not the tail of the file.
    # posts_today above is already a full-file count.
    ctx.recent_memory = retrieve_memory(
        memory_text,
        today=today,
        board=persona.board.strip(),
        counterparties=_counterparties(recommended[:25], timeline, conversations),
    )

    return ctx
