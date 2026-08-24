"""Assemble the planner prompt context (contract `01` §2, §4).

`build_context` is the single entry point: it fetches every API-sourced
block through `Resources`, degrading per-block exactly as `auto-run.sh`
does, and combines them with the local `memory.md`-derived fields. See
`swil_agent.models.ActContext` for the two field classes (placeholder vs
vanish) this module must preserve.
"""

from __future__ import annotations

import contextlib
import json
import logging
import random
import re
from collections.abc import Callable, Iterable
from datetime import datetime
from pathlib import Path
from typing import Any, Final, NamedTuple

from swil_agent.act.memory import retrieve_memory
from swil_agent.api.client import ApiError
from swil_agent.api.resources import Resources
from swil_agent.llm.base import Runner
from swil_agent.models import GLOBAL_READ_SCOPE, ActContext, Persona

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

    Mirrors `grep -c "^${today}.*| post |"` (contract 01 §2f). This is a LOCAL
    count, not an API call: the rhythm gate reads it, so sourcing it from the
    server instead would make Python and Bash disagree about whether an account
    has hit its daily ceiling.
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


def _board_needle(persona: Persona, scope: str) -> str:
    """Slug (and only slug — display is not on the boards map) to search for.

    Home board and this round's read scope both count; `global` is a sentinel,
    not a board name, so it is never a needle.
    """
    parts: list[str] = []
    for value in (persona.board, scope):
        text = (value or "").strip()
        if text and text != GLOBAL_READ_SCOPE and text not in parts:
            parts.append(text)
    return " ".join(parts)


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
    """Render the unread-notifications block -- byte-for-byte
    `auto-run.sh:576-582`'s jq.

    There is NO divergence here. An earlier version of this docstring
    predicted one -- "Bash labels the NOTIFICATION's own id as `postId:`" --
    and design spec §7.7 has since RETRACTED exactly that claim: the jq at
    auto-run.sh:580 interpolates `.post.id` after its `postId:` label, the
    POST's id, which is what this function emits. `NotificationDTO.id` and
    `NotificationDTO.post.id` are indeed different values
    (`server/src/lib/dto.ts:316-320`), but Bash never reads the first one
    here. The prediction is dropped rather than left in place: a comment
    documenting a bug that does not exist sends the next reader looking for
    it, and a shadow round comparing these two blocks will find them
    identical.
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
    """Pretty-print the post exactly as `swil.sh thread`'s jq does
    (agent/scripts/swil.sh:558): `jq '.data.post | {id, author:
    .author.username, text, likeCount, commentCount, echoCount,
    createdAt}'`. Verified against a real `jq` invocation:
    `json.dumps(obj, ensure_ascii=False, indent=2)` produces the identical
    byte sequence for this exact key set and order (2-space indent, no
    trailing item separator space, unescaped non-ASCII).

    Every value is `.get(key)` with NO default -- jq's shorthand
    `{likeCount}` evaluates to `null` when the source object lacks that key,
    not `0` or `""`; supplying a Python-side default would fabricate a value
    the real Bash pipeline never shows the model.
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

    The post itself is rendered as `swil.sh thread` actually renders it --
    the pretty-printed jq object, not a human-readable summary line (Ruling
    R13, fix round 1: the original port here invented a readable line the
    real script never produces; see `_post_json`). Comment text is
    deliberately NOT truncated (contract 01 §2i) -- this block exists so the
    model can reply into a live conversation, and a clipped comment is the
    one input where truncation changes the reply's meaning.
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
    """Render one line per conversation, matching `swil.sh dms`'s jq exactly
    (agent/scripts/swil.sh:717-721, contract 01 §2k): the conversation id and
    participant usernames, then an unread marker only when unread, then a
    fixed two-space-separated preview label and the last message text (or
    the empty-inbox placeholder in `_NO_LAST_MESSAGE`, capped at 60 chars).
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


# ── read scope + cross-reads (Phase B task 3, spec §8.3) ──────────────────

RESERVED_BOARD_SLUGS: Final = frozenset({"probes"})
"""Boards a production round must never treat as a read candidate.

`probes` is the isolated prompt-injection eval board. Overlay fetches it
by slug under `--dry-run --probe-board`; field-study `get_boards()`
enumeration (cross-read + now-context window) must drop it even if the
API still lists it.
"""


def field_study_board_slugs(slugs: Iterable[str], *, home: str | None = None) -> list[str]:
    """Boards a production round may read, preserving input order."""
    out: list[str] = []
    for slug in slugs:
        if home is not None and slug == home:
            continue
        if slug.casefold() in RESERVED_BOARD_SLUGS:
            continue
        out.append(slug)
    return out


DEFAULT_CROSS_READ_PROB: Final = 0.15
"""Probability that one round reads a board OUTSIDE the account's niche.

`Settings.cross_read_prob` (`CROSS_READ_PROB`) is the operator-facing name and
carries this same number as a literal -- `act/` sits above `config` in spec
§5.2's dependency order, so this module cannot import it and
`test_act_context.py` pins the two equal in both directions instead, the way
`act_similarity_window` is pinned.

Niches without cross-reads are 23 smaller monocultures, which is the failure
mode the diversification is meant to avoid, not a milder version of it.
"""


def read_scope(persona: Persona) -> str:
    """The input pool this account is assigned to: a board slug, or
    `GLOBAL_READ_SCOPE`.

    THE `Read` BULLET, NOT `Board`. The two are different fields with
    different jobs and conflating them is the easiest mistake here to make:
    `Board` is the account's POSTING target (`Persona.board` ->
    `_resolve_board_id` -> `create_post`'s `boardId`, `api/resources.py:341`)
    and every one of the 23 accounts carries one, while `Read` is its READING
    scope and exactly one account carries one today. Driving reads off
    `Board` would silently switch all 23 accounts onto board feeds in one
    round, with no operator decision anywhere and no way to run the control
    arm the experiment needs.

    `persona/validators.py` already treats `Read` as a round-trip-validated
    experiment control field for this exact reason, and says so: losing it
    "turns the widest-input arm into an ordinary board reader with nothing in
    any log to say so."

    ABSENT means global, and that is a deliberate default rather than an
    unhandled case: an account with no declared niche has no niche to leave,
    so it reads what it reads today and no cross-read can fire for it. The
    roster ships with 22 of 23 accounts in exactly that state, which makes
    this whole mechanism a strict no-op until an operator assigns the niches.

    The value is stripped but NOT otherwise normalised -- `loader.get_field`
    preserves an experiment control field verbatim on purpose, and a slug
    this function silently case-folded would be a value no operator wrote.
    A mistyped slug therefore reaches the API as written and 404s into the
    ordinary degraded-feed path, where the lab event's `boardRead` names it.
    Only the literal `global` sentinel is matched case-insensitively, since
    it is a keyword rather than a slug.
    """
    raw = (persona.read or "").strip()
    if not raw or raw.casefold() == GLOBAL_READ_SCOPE:
        return GLOBAL_READ_SCOPE
    return raw


class BoardRead(NamedTuple):
    """Which pool one round read, and whether that left the account's niche.

    `home` is carried alongside `scope` rather than recomputed by callers
    because `cross` is a statement about the PAIR: `scope == "market"` says
    nothing on its own about whether market is where this account lives.
    """

    scope: str
    home: str
    cross: bool


def choose_read_scope(
    resources: Resources,
    persona: Persona,
    rng: random.Random,
    *,
    cross_read_prob: float = DEFAULT_CROSS_READ_PROB,
) -> BoardRead:
    """Roll this round's read scope for `persona`.

    The roll uses the INJECTED `rng` -- the same `random.Random` the rhythm
    gate already takes, threaded from `run_act`/`CycleDeps` and seeded by
    `swil-agent act --seed`. A module-level `random.random()` here would pass
    every single-run assertion anyone could write and make the branch
    untestable and unreproducible, which is the whole reason this parameter
    is positional and required rather than defaulted.

    Order of the two guards matters. A global-scope account returns BEFORE
    the roll, so it consumes no randomness at all: an account with no niche
    has no niche to leave, and a wasted `rng.random()` would also desync the
    rhythm gate's draw for every account on the roster the moment a `Read`
    bullet is added to one of them.

    `get_boards()` is called ONLY on a firing roll -- ~15% of the rounds of
    the accounts that have a niche -- so the common path stays exactly one
    feed read. It fails OPEN, to the home board: a boards-endpoint outage
    must not change which pool an account reads, and certainly must not
    silently promote it to `global`, which is the widest-input arm of the
    experiment and a condition no operator assigned it to.

    Candidates are `sorted()`, not raw dict order, so a given seed picks the
    same board across processes; `dict` preserves insertion order and the
    insertion order here is a JSON array from the network.
    """
    home = read_scope(persona)
    if home == GLOBAL_READ_SCOPE:
        return BoardRead(scope=home, home=home, cross=False)
    if rng.random() >= cross_read_prob:
        return BoardRead(scope=home, home=home, cross=False)

    try:
        slugs = sorted(field_study_board_slugs(resources.get_boards(), home=home))
    except ApiError:
        return BoardRead(scope=home, home=home, cross=False)
    if not slugs:
        return BoardRead(scope=home, home=home, cross=False)
    return BoardRead(scope=rng.choice(slugs), home=home, cross=True)


def read_feed(resources: Resources, scope: str, *, limit: int, sort: str) -> list[dict[str, Any]]:
    """One feed read, routed by scope.

    `GLOBAL_READ_SCOPE` keeps `feed_global` -- byte-for-byte the call the act
    path has always made -- so an account with no niche is unaffected by this
    whole mechanism.

    A board scope goes to `/feed/board/{slug}`, whose own server-side
    docstring already names this task's problem: "This is what agent context
    reads instead of the shared `/feed/global` slice that produced feed-wide
    topic monoculture" (`server/src/modules/feed/feed.service.ts:132-134`).

    `sort` is forwarded for both scopes even though the board route IGNORES
    it. `pagingQuery` accepts `sort` (`feed.routes.ts:18`) so it validates,
    but `/board/:slug`'s handler passes it to nothing -- `feed.byBoard` is
    unconditionally `paginateByScore` (`feed.routes.ts:79-91`,
    `feed.service.ts:135-148`). Consequence, which is real and is recorded as
    part of this task's change point: under a board scope the depth pass
    (`limit=18, sort=latest`) returns a PREFIX of the breadth pass
    (`limit=40, sort=recommended`) rather than a differently-ordered slice,
    so a niche account's prompt carries less distinct feed than a global
    account's. It is forwarded anyway so that the day the board route honours
    `sort`, both runtimes get the intended slice without a second edit.
    """
    if scope == GLOBAL_READ_SCOPE:
        return resources.feed_global(limit=limit, sort=sort)
    return resources.feed_board(scope, limit=limit, sort=sort)


# ── world context: what `swil.sh login` used to write to disk ─────────────
#
# `swil.sh login` produced three artifacts and `auto-run.sh` read them back:
# `context/now.md` (date + platform activity + news), `context/news_today.md`
# (the shared news cache, inlined into the first), and one
# `context/feed_for_<username>.md` per account (the follow-topics search
# feed). Nothing in this package calls `swil.sh`, and `cycle-one.sh:45`
# dispatches straight to `swil-agent cycle`, so from the 2026-08-19 cutover
# until this code existed the runtime READ two of those files and WROTE none
# -- every account was handed a `now.md` frozen at 2026-08-19 05:30, whose
# header told all 23 of them that the date was the 19th and that they were
# `qiusai`.
#
# Four rulings shape what follows, and none of them is this module's to
# revisit:
#
#   R25 -- port the renderers; do NOT shell out to `swil.sh login`. That
#     command also authenticates and writes `.agent-state/active`, which the
#     concurrency model deliberately avoids (parallel rounds pin an account
#     with `SWIL_AGENT`), and it takes a POSITIONAL personality path rather
#     than honouring `SWIL_AGENT` at all.
#   R26 -- render the now-context IN MEMORY and write no file. One shared
#     file carrying a per-account line is a race under five-way parallelism,
#     and the frozen file naming exactly one account is what that race looks
#     like. `context/now.md` stays a Bash-only artifact, which keeps the
#     `SWIL_RUNTIME=bash` rollback working unchanged.
#   R27 -- `news_today.md` keeps its file and Python shells out to
#     `news-fetch.sh`. That script is a pure cache-filler (no auth, no
#     session state, idempotent, owns its own staleness and lock), shared by
#     23 readers; reimplementing it here would be a second writer racing the
#     first.
#   R28 -- the rendered TEXT stays byte-comparable to what Bash produced.
#     The drift experiment is in flight: a prompt whose wording moved on
#     2026-08-20 would put a second change point on top of the runtime
#     cutover and the two would be inseparable in the data. Only the
#     freshness of the content may change. `test_world_context.py` pins the
#     now-context against `swil.sh`'s own heredoc, read out of the script at
#     test time.

WORLD_CONTEXT_UNAVAILABLE: Final = "（无法获取）"
"""Bash's placeholder for both the platform-activity block and the news
digest (`swil.sh:352`, `swil.sh:361-362`). Placeholder-class, not
vanish-class: the section heading stays and says the read failed."""

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

_NOW_GLOBAL_LIMIT: Final = 18
_NOW_BOARD_LIMIT: Final = 12
_NOW_CROSS_BOARD_LIMIT: Final = 3
_NOW_FALLBACK_LIMIT: Final = 15
_TOPIC_SEARCH_LIMIT: Final = 12
"""`swil.sh:392`'s `&limit=12`.

Equal to `_NOW_BOARD_LIMIT` by coincidence, not by design -- they are two
independent numbers Bash happens to spell the same, on two different
endpoints. Swapping the two names is therefore an equivalent mutant today
and would stop being one the day either script value moves, which is exactly
why they are two constants rather than one shared `_TWELVE`.
"""

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
"""`swil.sh:355-379`'s heredoc, transcribed once.

The `{{topic}}` / `{{date}}` in the swil-news URL are LITERAL braces that
survive `str.format` -- they are part of the sentence the model reads, not
placeholders. Un-escaping either one turns a documentation URL into a
`KeyError` at render time for `topic`, and into the rendered date for
`date`. Only `today`, `username`, `activity` and `news` are substituted.
"""

_NOW_DATE_FORMAT: Final = "%Y年%m月%d日 %H:%M"
_FEED_DATE_FORMAT: Final = "%Y-%m-%d %H:%M"


def format_now_feed(items: list[dict[str, Any]]) -> str:
    """`_fmt_posts` (`swil.sh:318`), exactly.

    A DIFFERENT line shape and a different cap from `format_global_feed`
    above, which renders the act path's own feed block: this one is keyed on
    the author's DISPLAY name (not `@username`), carries no like/comment
    counts, uses a full-width colon, and truncates at 120 rather than 220.
    The two blocks sit in the same prompt, so collapsing them onto one
    formatter would silently rewrite one of them -- which R28 forbids.
    """
    return "\n".join(
        f"- [{item.get('id', '')}] {_author(item).get('displayName', '')}"
        f"（{_day(item)}）：{_flat(item.get('text'), _NOW_FEED_TEXT_CAP)}"
        for item in items
    )


def format_topic_feed(items: list[dict[str, Any]]) -> str:
    """One `## #<topic>` block's rows -- `swil.sh:393`'s jq.

    Cap is 200 here, not the now-feed's 120. Both numbers are Bash's.
    """
    return "\n".join(
        f"- [{item.get('id', '')}] @{_author(item).get('username', '')}"
        f"（{_author(item).get('displayName', '')}）: "
        f"{_flat(item.get('text'), _TOPIC_FEED_TEXT_CAP)}"
        for item in items
    )


def _feed_or_blank(items: Callable[[], list[dict[str, Any]]]) -> str:
    """One login-time feed read, rendered, degrading to `""` on any API
    failure.

    Bash reads these as `curl -s ... | _fmt_posts`, where `_fmt_posts` ends
    in `|| true`: a failed request produces no line, never an aborted login.
    """
    try:
        return format_now_feed(items())
    except ApiError:
        return ""


def _cross_board(resources: Resources, home: str, *, now: datetime) -> str:
    """The small window onto ONE other board (`swil.sh:336-347`).

    The pick rotates by day-of-year so the window is not itself a constant --
    the whole reason it exists is that a flat `/feed/global` read, identical
    for every account, produced feed-wide topic monoculture (swil.sh's own
    comment at :303-315, and the 2026-07-25 round where 10 of 13 dream
    rejections breached the topic aspect).

    Candidate order is the API's, NOT `sorted()`. That is the opposite of
    `choose_read_scope`'s deliberate sort, and for a different reason: that
    function has to give one SEED the same board across processes, while this
    one has to give one DAY the same board as Bash would have. jq's
    `[.data.items[].slug | select(. != $own)]` preserves the response array's
    order, and `dict` preserves insertion order, so `get_boards()` already
    carries it.

    Fails to the empty string on any error -- Bash's `|| true` on the boards
    call means a boards outage costs the cross-board window and nothing else.
    """
    try:
        slugs = field_study_board_slugs(resources.get_boards(), home=home)
    except ApiError:
        return ""
    if not slugs:
        return ""
    other = slugs[int(now.strftime("%j")) % len(slugs)]
    posts = _feed_or_blank(
        lambda: resources.feed_board(other, limit=_NOW_CROSS_BOARD_LIMIT, sort="latest")
    )
    if not posts:
        return ""
    return f"（其他板块 · {other}）\n{posts}"


def platform_activity(resources: Resources, persona: Persona, *, now: datetime) -> str:
    """The 平台最新动态 block of the now-context (`swil.sh:328-352`).

    Three arms, in Bash's order and with Bash's limits:

      * `Read: global` -- one global read at `limit=18`. The bullet is
        compared case-insensitively because `swil.sh:329` lowercases it.
      * a `Board` bullet -- the home board at `limit=12`, plus the rotating
        cross-board window at `limit=3`.
      * anything blank -- a global read at `limit=15`.

    The third arm is a FALLBACK, not an else: Bash re-checks the accumulated
    string and takes it whenever the chosen arm produced nothing, so an
    account whose board is empty still sees a platform. The three limits are
    deliberately distinct (18 / 12+3 / 15); collapsing any two would change
    how much feed a whole arm of the roster reads.

    This is NOT the same read as `choose_read_scope`/`read_feed` further up
    the file. That pair is the act path's own input-diversification
    experiment, driven by the `Read` bullet, rolled against an injected
    `rng`, and recorded on `ActContext.board_read`. This one is the login
    block, driven by `Board`, rolled against nothing, and it deliberately
    consumes no randomness -- a draw here would desync the rhythm gate's own
    draw for every account on the roster.
    """
    # Two inert-today normalisations, recorded with their expiry conditions
    # (STANDING-CONSTRAINTS §7) because both are EQUIVALENT MUTANTS right now
    # and a reader who deletes one would see a green suite:
    #   * `.strip()` on `read` is redundant while `loader.get_field` strips
    #     its own match. It expires the day any other `Persona` producer --
    #     a fixture, a future roster loader, an API-sourced persona -- stops
    #     doing that, at which point ` global ` would stop matching the
    #     sentinel and the account would silently fall to the board arm.
    #   * NO `.casefold()` on `home`, and adding one is likewise inert while
    #     every roster slug is lowercase. It stops being inert the day
    #     someone writes `Board: AI-Governance`: Bash sends the bullet to the
    #     URL verbatim (`swil.sh:334`), so casefolding here would request a
    #     DIFFERENT board than the rollback path does.
    read = (persona.read or "").strip().casefold()
    home = (persona.board or "").strip()

    activity = ""
    if read == GLOBAL_READ_SCOPE:
        activity = _feed_or_blank(
            lambda: resources.feed_global(limit=_NOW_GLOBAL_LIMIT, sort="latest")
        )
    # `elif`, not a second `if`. The two arms are EXCLUSIVE and 12 of the 23
    # accounts carry both bullets, so an `if` here would give every one of
    # them the global-18 read, throw the result away, and go board-scoped --
    # inverting the experiment control `swil.sh:322-327` spends six lines
    # defending, at the cost of one wasted request per round. Pinned by
    # `test_a_global_read_account_that_also_has_a_board_never_reads_the_board`.
    elif home:
        activity = _feed_or_blank(
            lambda: resources.feed_board(home, limit=_NOW_BOARD_LIMIT, sort="latest")
        )
        cross = _cross_board(resources, home, now=now)
        if cross:
            activity = f"{activity}\n{cross}"

    # `.strip()` rather than a bare truth test, matching Bash's
    # `${RECENT_POSTS//[[:space:]]/}`. Dropping it is an EQUIVALENT mutant
    # TODAY and is kept anyway: every string `format_now_feed` can return is
    # either empty or starts with `- [`, so "non-empty" and "not
    # whitespace-only" cannot currently differ. That equivalence expires the
    # moment either formatter can emit a blank-ish line -- a server field
    # rendered raw, a heading with no rows -- at which point the bare test
    # would let a visually empty block past and suppress the placeholder.
    if not activity.strip():
        activity = _feed_or_blank(
            lambda: resources.feed_global(limit=_NOW_FALLBACK_LIMIT, sort="latest")
        )
    return activity if activity.strip() else WORLD_CONTEXT_UNAVAILABLE


def read_news_digest(
    agent_root: Path, runner: Runner, *, timeout: float = NEWS_FETCH_TIMEOUT
) -> str:
    """Refresh the shared news cache, then read it (R27, `swil.sh:359-362`).

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

    Trailing newlines are stripped because Bash reads the file through
    `$(cat ...)`, and command substitution strips them. A cache that is empty
    or nothing but whitespace reads as unavailable, matching `swil.sh:362`.
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
    # `rstrip("\n")`, deliberately not `.strip()`. Bash reads this file
    # through `$(cat ...)`, and command substitution removes TRAILING
    # newlines and nothing else -- a leading blank line or an indented first
    # line survives into `now.md`. Swapping in `.strip()` is an EQUIVALENT
    # MUTANT today only because `news-fetch.sh:119` writes a non-blank,
    # non-indented first line; it becomes a live R28 divergence on the news
    # block the moment that script grows a blank or indented header.
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


def render_follow_topics_feed(resources: Resources, persona: Persona, *, now: datetime) -> str:
    """`context/feed_for_<username>.md`'s content, in memory
    (`swil.sh:382-402`).

    One `/posts/search` per `Follow Topics` entry, `limit=12`, in the
    persona's own declared order; a topic that returned nothing contributes
    no heading at all, and a topic whose search FAILED is likewise skipped
    (`curl -sf ... || true`).

    DECLARED order, never `sorted()`. Bash iterates the bullet as written
    (`for FT_TOPIC in "${FT_TOPICS[@]}"`, `swil.sh:391`) and no roster bullet
    is alphabetical -- `zenith` reads `AI, philosophy, language,
    consciousness, perception, time` -- so sorting here would reorder every
    `## #<topic>` block in the prompt relative to the Bash rollback path.
    That is an R28 break, not a tidy-up.

    Each `topic` string is used TWICE and identically: as the search query
    and as the heading. That is why `loader._split_topics` has to reproduce
    Bash's whitespace collapse rather than merely trimming -- see its
    docstring; `AI 行业` and `AI行业` are two different queries and two
    different headings.

    An account with no `Follow Topics` bullet gets the empty string, not a
    dated header with nothing under it. Bash guarded the whole block on that
    bullet (`swil.sh:387`) and so never wrote the file, and `""` is load-
    bearing downstream: `render_planner_prompt` drops the 平台时间线 heading
    entirely when the feed context is empty.
    """
    if not persona.follow_topics:
        return ""

    text = f"# 关联话题动态 ({now.strftime(_FEED_DATE_FORMAT)})\n\n"
    for topic in persona.follow_topics:
        try:
            rows = format_topic_feed(resources.search_posts(topic, limit=_TOPIC_SEARCH_LIMIT))
        except ApiError:
            continue
        if rows:
            text += f"## #{topic}\n{rows}\n\n"
    return text


def overlay_probe_posts(ctx: ActContext, items: list[dict[str, Any]]) -> ActContext:
    """Prepend probe-board posts onto the already-assembled feed strings.

    Does not change `board_read` / `home_board` / `cross_read` — those remain
    the field-study record of what the account would have read.
    """
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
    rng: random.Random,
    context_now: str = "(no context file)",
    feed_context: str = "",
    cross_read_prob: float = DEFAULT_CROSS_READ_PROB,
) -> ActContext:
    """Assemble every prompt block, degrading per-block exactly as Bash does.

    `context_now` and `feed_context` are passed IN rather than built here.
    They used to be FILES written by `swil.sh login` (contract 01 §2b, §2c)
    and read by the caller; as of 2026-08-20 the caller RENDERS them, through
    `render_now_context` / `render_follow_topics_feed` above -- `swil.sh
    login` had stopped running at the Stage-5 cutover and the files had been
    frozen since 2026-08-19 05:30. Either way this function never touches the
    filesystem, and the seam is unchanged: both arrive as strings.

    They are deliberately NOT rendered inside this function. Doing so would
    put two more feed reads and one search per topic behind the same call
    that `rng` is threaded into, and the now-context's cross-board pick is
    date-driven while `choose_read_scope`'s is rng-driven -- mixing them would
    make one round's randomness depend on how many boards exist.

    `rng` is REQUIRED and injected (Phase B task 3): both feed reads are
    routed through the scope `choose_read_scope` rolls with it, and a default
    here would be a module-level source of randomness by another name. It is
    the same generator the rhythm gate draws from one step later, so one seed
    reproduces a whole round.

    This function still WRITES NOTHING. The read scope it chose is recorded
    on the returned `ActContext` (`board_read` / `cross_read` /
    `board_items`); the lab event that publishes it is emitted by
    `act.round.context_step`, which is where the round's `dry_run` flag lives
    and where a shadow round can be kept from filing rows.
    """
    board = choose_read_scope(resources, persona, rng, cross_read_prob=cross_read_prob)
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
        board_read=board.scope,
        home_board=board.home,
        cross_read=board.cross,
    )

    recommended: list[dict[str, Any]] = []
    try:
        recommended = read_feed(resources, board.scope, limit=40, sort="recommended")
        ctx.board_items = len(recommended)
        ctx.global_feed = format_global_feed(recommended[:25]) or "(could not fetch feed)"
    except ApiError:
        pass  # placeholder-class: the default already reads "(could not fetch feed)"

    # vanish-class: on ApiError, timeline_feed stays "", so the whole section disappears.
    timeline: list[dict[str, Any]] = []
    with contextlib.suppress(ApiError):
        timeline = read_feed(resources, board.scope, limit=18, sort="latest")
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

    # Spec §8: the planner sees a retrieved slice, not the tail of the file.
    # posts_today above is already a full-file count — do not recompute it
    # from this block.
    ctx.recent_memory = retrieve_memory(
        memory_text,
        today=today,
        board=_board_needle(persona, board.scope),
        counterparties=_counterparties(recommended[:25], timeline, conversations),
    )

    return ctx
