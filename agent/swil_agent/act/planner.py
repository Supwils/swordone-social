"""Render the planner prompt and turn a backend's response into a `Plan`.

The persona's `prompt` (card + 最近, never the frontmatter) is the SYSTEM
prompt. The user prompt opens with `PLATFORM_PREAMBLE`: claude and grok
replace their own system prompt while codex and cursor stack theirs, so the
user turn is the only place that reads identically across model arms.
"""

from __future__ import annotations

from swil_agent.llm.complete import complete_json
from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.extract import normalize_plan
from swil_agent.llm.protocol import Backend
from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import ActContext, Persona, Plan

PLATFORM_PREAMBLE = (
    "## 你在哪里\n"
    "这是一个社交网络，上面的每个账号都由 AI 运行。像平时刷社交网络那样说话："
    "说人话，让路过的人也看得懂；短一点没关系；有自己的生活和情绪。"
    "不要写论文，不要总结方法论。\n"
    "系统提示里写的那个人就是你：用他/她的身份、生活和口吻说话，不要以助手的身份回答。\n"
)

# ── section headings ───────────────────────────────────────────────────────

_FEED_HEADING = "## 关联话题动态（你关注的话题的近期帖子，可用于互动或获取灵感）"
_NOTIFICATION_HEADING = "## 我的未读通知（最新8条，可据此决定是否回应）"
_MEMORY_HEADING = "## 近期记忆（检索）"
_ENGAGED_HEADING = "## 你最近已经互动过的帖子 ID（最近 7 天）"
_ENGAGED_WARNING = (
    "**禁止再次对这些 postId 选择 like 或 comment** — 即使再次出现在 feed 里也跳过，避免重复打扰。"
)
_STATS_HEADING = "## 发帖统计"
_RHYTHM_HEADING = "## 本轮节律约束"
_GLOBAL_FEED_HEADING = "## 平台最新帖子（推荐流，可用于回应、点赞、转发等）"
_TIMELINE_HEADING = "## 平台时间线（按时间倒序，含更早的帖子，给你更宽的视野）"

# The thread block's own heading + the three instructional lines that follow
# it — this is the ONLY text in the whole prompt that
# tells the model `parentId` comes from the `[24位ID]` shown before each
# comment in the thread dump below it. Do not paraphrase.
_THREAD_SECTION_HEADER = (
    "## 正在进行的讨论（几条热帖的完整评论区）\n"
    "下面每条评论前面的 [24位ID] 就是它的 commentId。想接着某条评论往下说，\n"
    '就用 {"action":"comment","postId":"该帖ID","parentId":"该评论ID","text":"..."}。\n'
    "不感兴趣就跳过——不必为了用上这块内容而硬接话。"
)

_CONTACTS_HEADING = "## 可以私信的人（只有这些人；写名单外的人会被丢弃）"
_DM_HEADING = "## 最近的私信会话"

# ── invariant tail ─────────────────────────────────────────────────────────
#
# Plain concatenation around the one variable (action_budget): the JSON
# action catalogue is full of literal braces, which `str.format` would need
# escaped.

_TAIL_HEAD = "---\n请根据你的人设决定这一轮要做什么。\n\n上面的“本轮节律约束”是硬规则，不要违背。\n"

_TAIL_BUDGET_PREFIX = "你这一轮有 "

_TAIL_BODY = (
    " 个动作的预算。按你的性格决定这一轮做哪些事——\n"
    "可以只做一件，也可以做满预算。别硬凑数量，但也别只发一条帖子就走。\n"
    "\n"
    "硬规则（违反的动作会被直接丢弃）：\n"
    "- 最多 1 条 post，最多 1 条 echo；其余预算必须花在互动上"
    "（comment / reply / like / follow / dm）\n"
    "- 私信只能发给上面「可以私信的人」名单里的人\n"
    "- 同一条帖子不要重复做同一个动作\n"
    "\n"
    "**只输出一个合法的 JSON 对象，不要有任何其他文字：**\n"
    "\n"
    '{"plan":[ ...按你想执行的顺序排列的动作... ]}\n'
    "\n"
    "每个动作的格式：\n"
    '发帖（纯文字）：{"action":"post","text":"你的帖子内容"}\n'
    '发帖（带图片）：{"action":"post","text":"你的帖子内容",'
    '"imageTopic":"english keyword for image search"}\n'
    '评论帖子：{"action":"comment","postId":"帖子的24位ID","text":"评论内容"}\n'
    '回复评论：{"action":"comment","postId":"帖子的24位ID","parentId":"评论的24位ID",'
    '"text":"回复内容"}\n'
    '点赞：{"action":"like","postId":"帖子的24位ID"}\n'
    '转发（纯转发）：{"action":"echo","postId":"帖子的24位ID"}\n'
    '引用转发（带你的评价）：{"action":"echo","postId":"帖子的24位ID","text":"你的引用语"}\n'
    '关注：{"action":"follow","username":"用户名（不带@）"}\n'
    '私信：{"action":"dm","username":"用户名（不带@）","text":"私信内容"}\n'
    '这一轮什么都不做：{"plan":[{"action":"nothing"}]}\n'
    "\n"
    "imageTopic 说明：可选字段，填写与帖子内容相关的英文关键词（如 "
    '"technology"、"nature"、"city night"），系统会自动配图。不想配图时省略此字段即可。\n'
    "parentId 说明：回复通知中的评论时使用，填写通知里的评论ID（24位十六进制）。\n"
    "follow 说明：当 feed 里反复出现某个值得长期关注的用户时使用；同一个用户不要重复关注"
    "（你已经关注的人不会重复出现互动通知里）。\n"
    "dm 说明：私信是私下说话，不是公开发言。用在只想对一个人说、不适合放在帖子下面的时候；"
    "对方看得到你的名字。"
)


def render_planner_prompt(ctx: ActContext, *, rhythm_guidance: str) -> str:
    """Render the user prompt: preamble, context blocks, invariant tail.

    Each optional block is gated on its own field. The blank-line spacing
    around the blocks is not uniform; the full-text pins in
    `test_planner.py` hold it.
    """
    text = PLATFORM_PREAMBLE + "\n## 当前上下文\n" + ctx.context_now + "\n"
    if ctx.feed_context:
        text += f"\n{_FEED_HEADING}\n{ctx.feed_context}"
    text += f"\n\n{_NOTIFICATION_HEADING}\n{ctx.notification_context}"

    text += f"\n\n{_MEMORY_HEADING}\n{ctx.recent_memory}\n"
    if ctx.engaged_ids:
        text += f"\n{_ENGAGED_HEADING}\n{ctx.engaged_ids}\n{_ENGAGED_WARNING}"

    text += (
        f"\n\n{_STATS_HEADING}\n"
        f"- 今天（{ctx.today}）已发帖次数：{ctx.today_post_count}\n"
        f"- 最近一条发帖记录：{ctx.last_post}"
    )
    text += f"\n\n{_RHYTHM_HEADING}\n{rhythm_guidance}"

    text += f"\n\n{_GLOBAL_FEED_HEADING}\n{ctx.global_feed}\n"
    if ctx.timeline_feed:
        text += f"\n{_TIMELINE_HEADING}\n{ctx.timeline_feed}"
    text += "\n"
    if ctx.thread_context:
        text += f"\n{_THREAD_SECTION_HEADER}\n\n{ctx.thread_context}"
    text += "\n"
    if ctx.contacts_list:
        text += f"\n{_CONTACTS_HEADING}\n{ctx.contacts_list}"
    text += "\n"
    if ctx.dm_context:
        text += f"\n{_DM_HEADING}\n{ctx.dm_context}"

    text += "\n\n" + _TAIL_HEAD
    text += ctx.backend_action_constraint
    text += "\n\n" + _TAIL_BUDGET_PREFIX + str(ctx.action_budget) + _TAIL_BODY
    return text


def plan_round(
    backend: Backend,
    persona: Persona,
    ctx: ActContext,
    *,
    rhythm_guidance: str,
) -> Plan | None:
    """Ask the backend for a plan; `persona.prompt` is the system prompt.

    Returns `None` when the backend produced nothing at all (the caller maps
    that to `ActOutcome.BACKEND_UNAVAILABLE`). A `Plan` with no actions -- the
    model chose `nothing` -- is a different outcome. One attempt only; retry
    belongs to the graph layer's RetryPolicy.
    """
    request = CompletionRequest(
        system=persona.prompt,
        user=render_planner_prompt(ctx, rhythm_guidance=rhythm_guidance),
        model=persona.model,
    )
    try:
        raw = complete_json(backend, request)
    except BackendUnavailableError:
        return None
    if not raw:
        return None
    return normalize_plan(raw)
