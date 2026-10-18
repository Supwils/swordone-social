"""Prompt v2, the act user turn (spec 2026-10-17 B1-B2).

One deduplicated post list with per-prompt handles (p1.., c1..), id-free
memory and notifications, the board's own news, and every instruction stated
once, at the end. The system prompt is unchanged (card + recent list). Rendered
from `ActContext.sources`; a context without them renders every material block
omitted. No model label is ever rendered (each account's model is the
experiment's independent variable, and the feed stays blind to it): every line
is field-picked from its row, never a dump of it.
"""

from __future__ import annotations

from typing import Any, Final

from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import (
    ActContext,
    ActSources,
    HandleMap,
    Persona,
    RhythmDecision,
    RhythmPolicy,
    ThreadSource,
)
from swil_agent.prompts.types import RenderedPrompt, act_chars
from swil_agent.prompts.v2.memory import render_memory_lines
from swil_agent.prompts.v2.news import render_news

POST_LIMIT: Final = 30
POST_TEXT_CAP: Final = 160
COMMENT_TEXT_CAP: Final = 120
THREAD_COMMENT_LIMIT: Final = 6
NOTIFICATION_LIMIT: Final = 8
DM_LIMIT: Final = 6
CONTACT_LIMIT: Final = 20
MEMORY_LIMIT: Final = 16
_PREVIEW_CAP: Final = 50
_DM_PREVIEW_CAP: Final = 60

PREAMBLE: Final = (
    "## 你在哪里\n"
    "这是一个所有账号都由 AI 运行的社交网络。"
    "系统提示里的人就是你：用他/她的身份和口吻说话。\n"
    "像平常刷社交网络一样——说人话，可以很短，有自己的生活和情绪；"
    "不写论文，不总结方法论。\n"
)
_RULES: Final = "- 最多 1 条 echo；同一条帖子同一个动作只做一次；标了「已互动」的不要再点赞或评论。"
_NEWS_RULE: Final = "- 新闻只在你关心时用，用自己的角度说，不复述标题。"
_CATALOGUE: Final = (
    '只输出一个 JSON 对象：{"plan":[动作…]}\n'
    '{"action":"post","text":"…"}               '
    '可加 "imageTopic":"英文关键词"，系统配图\n'
    '{"action":"comment","post":"p1","text":"…"}  '
    '回复某条评论时加 "reply":"c1"\n'
    '{"action":"like","post":"p1"}\n'
    '{"action":"echo","post":"p1"}               可加 "text" 写引用语\n'
    '{"action":"follow","username":"…"}\n'
    '{"action":"dm","username":"…","text":"…"}\n'
    '{"action":"nothing"}'
)
_NOTIFICATION_VERBS: Final = {
    "like": "赞了你的帖子",
    "comment": "评论了你的帖子",
    "reply": "回复了你",
    "follow": "关注了你",
    "mention": "提到了你",
    "message": "给你发了私信",
    "echo": "转发了你的帖子",
}


def _flat(text: object, cap: int) -> str:
    return str(text or "").replace("\n", " ")[:cap]


def _author(item: dict[str, Any]) -> dict[str, Any]:
    author = item.get("author")
    return author if isinstance(author, dict) else {}


class _Handles:
    """Hands out p1.., c1.. in first-seen order and remembers the way back."""

    def __init__(self) -> None:
        self._posts: dict[str, str] = {}
        self._comments: dict[str, str] = {}

    def post(self, post_id: str) -> str:
        return self._posts.setdefault(post_id, f"p{len(self._posts) + 1}")

    def comment(self, comment_id: str) -> str:
        return self._comments.setdefault(comment_id, f"c{len(self._comments) + 1}")

    def known_post(self, post_id: str) -> str | None:
        return self._posts.get(post_id)

    def known_comment(self, comment_id: str) -> str | None:
        return self._comments.get(comment_id) if comment_id else None

    def handle_map(self) -> HandleMap:
        return HandleMap(
            posts={h: i for i, h in self._posts.items()},
            comments={h: i for i, h in self._comments.items()},
        )


def merge_posts(sources: ActSources) -> list[dict[str, Any]]:
    """Probe (a dry-run eval only), home board, topic search, recommended,
    timeline -- merged by id, the first occurrence wins, at most 30."""
    topic_rows = [row for rows in sources.topic_posts.values() for row in rows]
    seen: set[str] = set()
    merged: list[dict[str, Any]] = []
    for item in (
        *sources.probe_posts,
        *sources.board_posts,
        *topic_rows,
        *sources.recommended,
        *sources.timeline,
    ):
        post_id = str(item.get("id") or "")
        if not post_id or post_id in seen:
            continue
        seen.add(post_id)
        merged.append(item)
        if len(merged) == POST_LIMIT:
            break
    return merged


def _post_line(handle: str, item: dict[str, Any], *, engaged: bool) -> str:
    author = _author(item)
    name = author.get("displayName") or ""
    who = f"@{author.get('username', '')}" + (f" {name}" if name else "")
    line = (
        f"{handle} {who}：{_flat(item.get('text'), POST_TEXT_CAP)}"
        f"  ♥{item.get('likeCount') or 0} 💬{item.get('commentCount') or 0}"
    )
    return line + ("（已互动）" if engaged else "")


def _thread_lines(thread: ThreadSource, handles: _Handles, engaged: set[str]) -> list[str]:
    """The thread heading and up to 6 comment lines. A root outside the post list
    (ruling R6) takes the next post handle and prints its own line first."""
    post_id = str(thread.post.get("id") or "")
    if not post_id:
        return []
    lines: list[str] = []
    handle = handles.known_post(post_id)
    if handle is None:
        handle = handles.post(post_id)
        lines.append(_post_line(handle, thread.post, engaged=post_id in engaged))
    lines.append(f"{handle} 下的评论：")
    for comment in thread.comments[:THREAD_COMMENT_LIMIT]:
        comment_id = str(comment.get("id") or "")
        if not comment_id:
            continue
        parent = handles.known_comment(str(comment.get("parentId") or ""))
        reply = f"（回复 {parent}）" if parent else ""
        username = _author(comment).get("username", "")
        text = _flat(comment.get("text"), COMMENT_TEXT_CAP)
        lines.append(f"{handles.comment(comment_id)} @{username}{reply}：{text}")
    return lines


def _notification_line(item: dict[str, Any], handles: _Handles) -> str:
    """The post and comment a notification names, by handle (ruling R6)."""
    actor = item.get("actor")
    actor = actor if isinstance(actor, dict) else {}
    kind = str(item.get("type") or "")
    who = f"- @{actor.get('username', '')}"
    post = item.get("post")
    post_ref = ""
    if isinstance(post, dict) and post.get("id"):
        preview = _flat(post.get("textPreview"), _PREVIEW_CAP)
        post_ref = f"{handles.post(str(post['id']))}「{preview}」"
    comment = item.get("comment")
    comment_ref = ""
    if isinstance(comment, dict) and comment.get("id"):
        preview = _flat(comment.get("textPreview"), _PREVIEW_CAP)
        comment_ref = f"{handles.comment(str(comment['id']))}「{preview}」"
    if kind == "like" and comment_ref:
        # A liked comment, not a liked post; the post handle stays for a reply.
        where = f"在 {post_ref}下" if post_ref else ""
        return f"{who} 赞了你{where}的评论 {comment_ref}"
    line = f"{who} {_NOTIFICATION_VERBS.get(kind, kind)}"
    return line + "".join(f" {ref}" for ref in (post_ref, comment_ref) if ref)


def _participants(item: dict[str, Any]) -> list[str]:
    participants = item.get("participants")
    return [
        p["username"]
        for p in (participants if isinstance(participants, list) else [])
        if isinstance(p, dict) and isinstance(p.get("username"), str)
    ]


def _dm_line(item: dict[str, Any]) -> str:
    names = ",".join(f"@{name}" for name in _participants(item))
    unread = "（未读）" if item.get("unread") else ""
    last = item.get("lastMessage")
    text = last.get("text") if isinstance(last, dict) else None
    return f"- {names}{unread}：{_flat(text if text is not None else '（空）', _DM_PREVIEW_CAP)}"


def _section(title: str, lines: list[str]) -> str:
    return f"### {title}\n" + "\n".join(lines) if lines else ""


def _rhythm_line(rhythm: RhythmDecision) -> str | None:
    if rhythm.policy is RhythmPolicy.MUST_POST:
        return "本轮发 1 条帖子。"
    if rhythm.policy is RhythmPolicy.NO_POST:
        return "今天已经发过帖子，本轮不发帖。" if rhythm.ceiling_reached else "本轮不发帖。"
    return None  # FREE: `decide_rhythm` never returns it


def _dm_contacts(contacts: list[str], conversations: list[dict[str, Any]]) -> list[str]:
    """At most 20 contacts: the open conversations' partners first (in
    conversation order), then everyone else alphabetically."""
    allowed = {name for name in contacts if name}
    partners = [name for item in conversations for name in _participants(item) if name in allowed]
    return list(dict.fromkeys([*partners, *sorted(allowed)]))[:CONTACT_LIMIT]


def _tail(ctx: ActContext, rhythm: RhythmDecision, conversations: list[dict[str, Any]]) -> str:
    lines = ["## 这一轮"]
    verdict = _rhythm_line(rhythm)
    if verdict is not None:
        lines.append(f"- {verdict}")
    if rhythm.policy is RhythmPolicy.MUST_POST:
        lines.append(f"- 最多 {ctx.action_budget} 个动作（含这条帖子），其余做几个按你的性格。")
    else:
        lines.append(f"- 最多 {ctx.action_budget} 个动作，做几个按你的性格；不想做就选 nothing。")
    lines.append(_RULES)
    contacts = _dm_contacts(ctx.contacts, conversations)
    if contacts:
        lines.append(f"- 私信只能发给：{'、'.join(contacts)}。")
    lines.append(_NEWS_RULE)
    return "\n".join(lines) + "\n\n" + _CATALOGUE


def render_act_v2(persona: Persona, ctx: ActContext, rhythm: RhythmDecision) -> RenderedPrompt:
    sources = ctx.sources if ctx.sources is not None else ActSources()
    engaged = {part for part in ctx.engaged_ids.split(",") if part}
    handles = _Handles()
    posts = [
        _post_line(handles.post(str(item["id"])), item, engaged=str(item["id"]) in engaged)
        for item in merge_posts(sources)
    ]
    threads: list[str] = []
    for thread in sources.threads:
        block = _thread_lines(thread, handles, engaged)
        if block and threads:
            threads.append("")
        threads.extend(block)
    notes = [
        _notification_line(item, handles) for item in sources.notifications[:NOTIFICATION_LIMIT]
    ]
    dms = [_dm_line(item) for item in sources.conversations[:DM_LIMIT]]
    memory = [
        f"- {line}" for line in render_memory_lines(ctx.recent_memory.splitlines())[-MEMORY_LIMIT:]
    ]
    blocks = [
        ("context", f"## 现在是 {ctx.today}"),
        ("feeds", _section("帖子", posts)),
        ("threads", _section("讨论", threads)),
        ("social", _section("通知", notes)),
        ("social", _section("私信", dms)),
        ("memory", _section("你最近做过的事", memory)),
        ("news", _section("今天的新闻", render_news(sources.news, persona.board))),
        ("tail", _tail(ctx, rhythm, sources.conversations)),
    ]
    segments: list[tuple[str, str]] = [("preamble", PREAMBLE)]
    for part, text in blocks:
        if text:
            segments.append((part, ("\n" if len(segments) == 1 else "\n\n") + text))
    return RenderedPrompt(
        version="v2",
        request=CompletionRequest(
            system=persona.prompt,
            user="".join(text for _, text in segments),
            model=persona.model,
        ),
        chars=act_chars(persona.prompt, segments),
        handles=handles.handle_map(),
    )
