"""Tests for `swil_agent.act.planner`.

The full-prompt pins below are typed out independently of `planner.py`'s
constants, so a paraphrase inside the module fails them. The Era 3 prompt is
`PLATFORM_PREAMBLE` first, then the context blocks, then the invariant tail.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from swil_agent.act.context import build_context
from swil_agent.act.planner import PLATFORM_PREAMBLE, plan_round, render_planner_prompt
from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import ActContext, Persona
from swil_agent.persona.format import PersonaDoc, render_persona
from swil_agent.persona.loader import load_persona

from ._runners import FakeResources, SilentBackend, StubBackend, make_persona


def _persona(
    *, backend: str = "claude", model: str | None = None, prompt: str = "PERSONA"
) -> Persona:
    return make_persona(backend=backend, model=model, prompt=prompt, raw="RAW FILE")


def _real_persona(tmp_path: Path) -> Persona:
    """A persona loaded from a real v2 file, frontmatter and all."""
    directory = tmp_path / "zenith"
    directory.mkdir()
    doc = PersonaDoc(
        meta={
            "username": "zenith",
            "display_name": "Zenith",
            "topics": ["AI", "时间"],
            "model": "claude:claude-opus-5-5",
            "board": "ai",
            "era": 3,
        },
        card="# Zenith\n喜欢想时间的人。",
        recent=("最近在读博尔赫斯",),
    )
    (directory / "personality.md").write_text(render_persona(doc), encoding="utf-8")
    return load_persona(directory)


# ── Step 1: section omission / presence (brief, verbatim) ──────────────────


def test_optional_sections_are_omitted_when_empty() -> None:
    prompt = render_planner_prompt(ActContext(), rhythm_guidance="- 本轮动作约束：随意")
    for heading in (
        "## 关联话题动态",
        "## 你最近已经互动过的帖子 ID",
        "## 平台时间线",
        "## 正在进行的讨论",
        "## 可以私信的人",
        "## 最近的私信会话",
    ):
        assert heading not in prompt


def test_optional_sections_appear_when_populated() -> None:
    ctx = ActContext(
        feed_context="ft",
        timeline_feed="tl",
        thread_context="th",
        contacts_list="vex",
        dm_context="dm",
        engaged_ids="a" * 24,
    )
    prompt = render_planner_prompt(ctx, rhythm_guidance="g")
    for heading in (
        "## 关联话题动态",
        "## 你最近已经互动过的帖子 ID",
        "## 平台时间线",
        "## 正在进行的讨论",
        "## 可以私信的人",
        "## 最近的私信会话",
    ):
        assert heading in prompt


def test_mandatory_sections_always_appear_even_with_placeholders() -> None:
    prompt = render_planner_prompt(ActContext(), rhythm_guidance="g")
    assert "(no context file)" in prompt
    assert "（暂无新互动）" in prompt
    assert "(no memory yet)" in prompt
    assert "(could not fetch feed)" in prompt


def test_action_budget_appears_in_the_prompt_text() -> None:
    assert "有 7 个动作的预算" in render_planner_prompt(
        ActContext(action_budget=7), rhythm_guidance="g"
    )


def test_codex_persona_context_has_empty_backend_action_constraint() -> None:
    """Loop-engine spec §7: Codex is no longer prompt-limited to post/nothing.
    Write-verification is the real fix; `backend_action_constraint` is always
    empty, including for a Codex persona, and the planner never injects the
    old post-only hard rule.
    """
    ctx = build_context(
        FakeResources(),
        _persona(backend="codex"),
        memory_text="",
        now=datetime(2026, 8, 17, 10, 0, 0),
        budget=5,
    )
    prompt = render_planner_prompt(ctx, rhythm_guidance="g")
    assert "本轮后端限制" not in prompt
    assert "只能选择 post 或 nothing" not in prompt


# ── isolation: each optional section is scoped to its OWN field ────────────
#
# The two tests above only prove the six headings track SOME field, together,
# in each direction. A mutation that swapped which field gates which heading
# (e.g. feed_context's condition controlling the "## 平台时间线" heading)
# would pass both of them, since every field is either all-empty or
# all-populated in those two tests. Each case below sets exactly one field
# and checks that exactly its own heading appears -- a swap breaks the one
# whose field was populated (heading missing) and the one whose heading
# leaked in (unexpectedly present).

_ALL_OPTIONAL_HEADINGS = (
    "## 关联话题动态",
    "## 你最近已经互动过的帖子 ID",
    "## 平台时间线",
    "## 正在进行的讨论",
    "## 可以私信的人",
    "## 最近的私信会话",
)


def _assert_only_this_heading(prompt: str, heading: str) -> None:
    assert heading in prompt
    for other in _ALL_OPTIONAL_HEADINGS:
        if other != heading:
            assert other not in prompt


def test_feed_context_alone_shows_only_its_own_heading() -> None:
    prompt = render_planner_prompt(ActContext(feed_context="ft"), rhythm_guidance="g")
    _assert_only_this_heading(prompt, "## 关联话题动态")


def test_engaged_ids_alone_shows_only_its_own_heading() -> None:
    prompt = render_planner_prompt(ActContext(engaged_ids="a" * 24), rhythm_guidance="g")
    _assert_only_this_heading(prompt, "## 你最近已经互动过的帖子 ID")


def test_timeline_feed_alone_shows_only_its_own_heading() -> None:
    prompt = render_planner_prompt(ActContext(timeline_feed="tl"), rhythm_guidance="g")
    _assert_only_this_heading(prompt, "## 平台时间线")


def test_thread_context_alone_shows_only_its_own_heading() -> None:
    prompt = render_planner_prompt(ActContext(thread_context="th"), rhythm_guidance="g")
    _assert_only_this_heading(prompt, "## 正在进行的讨论")


def test_contacts_list_alone_shows_only_its_own_heading() -> None:
    prompt = render_planner_prompt(ActContext(contacts_list="vex"), rhythm_guidance="g")
    _assert_only_this_heading(prompt, "## 可以私信的人")


def test_dm_context_alone_shows_only_its_own_heading() -> None:
    prompt = render_planner_prompt(ActContext(dm_context="dm"), rhythm_guidance="g")
    _assert_only_this_heading(prompt, "## 最近的私信会话")


# ── verbatim pins, retyped rather than imported ────────────────────────────


def test_the_preamble_is_verbatim() -> None:
    assert PLATFORM_PREAMBLE == (
        "## 你在哪里\n"
        "这是一个社交网络，上面的每个账号都由 AI 运行。像平时刷社交网络那样说话："
        "说人话，让路过的人也看得懂；短一点没关系；有自己的生活和情绪。"
        "不要写论文，不要总结方法论。\n"
        "系统提示里写的那个人就是你：用他/她的身份、生活和口吻说话，不要以助手的身份回答。\n"
    )


def test_the_user_prompt_starts_with_the_platform_preamble() -> None:
    prompt = render_planner_prompt(ActContext(), rhythm_guidance="g")
    assert prompt.startswith("## 你在哪里\n")
    assert prompt.startswith(PLATFORM_PREAMBLE + "\n## 当前上下文\n")


def test_the_tail_no_longer_mentions_a_per_persona_rhythm() -> None:
    prompt = render_planner_prompt(ActContext(), rhythm_guidance="g")
    assert "---\n请根据你的人设决定这一轮要做什么。\n\n" in prompt
    assert "发帖节律" not in prompt


def test_rhythm_hard_rule_line_uses_curly_quotes_not_straight_quotes() -> None:
    """U+201C/U+201D (“ ”), not ASCII "straight" quotes."""
    prompt = render_planner_prompt(ActContext(), rhythm_guidance="g")
    assert "上面的“本轮节律约束”是硬规则，不要违背。" in prompt


def test_hard_rules_and_action_catalogue_are_verbatim() -> None:
    expected = (
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
    prompt = render_planner_prompt(ActContext(), rhythm_guidance="g")
    assert expected in prompt


def test_thread_section_header_is_verbatim() -> None:
    expected = (
        "## 正在进行的讨论（几条热帖的完整评论区）\n"
        "下面每条评论前面的 [24位ID] 就是它的 commentId。想接着某条评论往下说，\n"
        '就用 {"action":"comment","postId":"该帖ID","parentId":"该评论ID","text":"..."}。\n'
        "不感兴趣就跳过——不必为了用上这块内容而硬接话。"
    )
    prompt = render_planner_prompt(ActContext(thread_context="th"), rhythm_guidance="g")
    assert expected in prompt


def test_engaged_ids_warning_line_is_verbatim() -> None:
    expected = (
        "**禁止再次对这些 postId 选择 like 或 comment** "
        "— 即使再次出现在 feed 里也跳过，避免重复打扰。"
    )
    prompt = render_planner_prompt(ActContext(engaged_ids="a" * 24), rhythm_guidance="g")
    assert expected in prompt


# ── full-prompt pins ────────────────────────────────────────────────────────

_EXPECTED_EMPTY = """## 你在哪里
这是一个社交网络，上面的每个账号都由 AI 运行。像平时刷社交网络那样说话：说人话，让路过的人也看得懂；短一点没关系；有自己的生活和情绪。不要写论文，不要总结方法论。
系统提示里写的那个人就是你：用他/她的身份、生活和口吻说话，不要以助手的身份回答。

## 当前上下文
(no context file)


## 我的未读通知（最新8条，可据此决定是否回应）
（暂无新互动）

## 近期记忆（检索）
(no memory yet)


## 发帖统计
- 今天（）已发帖次数：0
- 最近一条发帖记录：(暂无发帖记录)

## 本轮节律约束
- 本轮动作约束：随意

## 平台最新帖子（推荐流，可用于回应、点赞、转发等）
(could not fetch feed)





---
请根据你的人设决定这一轮要做什么。

上面的“本轮节律约束”是硬规则，不要违背。


你这一轮有 5 个动作的预算。按你的性格决定这一轮做哪些事——
可以只做一件，也可以做满预算。别硬凑数量，但也别只发一条帖子就走。

硬规则（违反的动作会被直接丢弃）：
- 最多 1 条 post，最多 1 条 echo；其余预算必须花在互动上（comment / reply / like / follow / dm）
- 私信只能发给上面「可以私信的人」名单里的人
- 同一条帖子不要重复做同一个动作

**只输出一个合法的 JSON 对象，不要有任何其他文字：**

{"plan":[ ...按你想执行的顺序排列的动作... ]}

每个动作的格式：
发帖（纯文字）：{"action":"post","text":"你的帖子内容"}
发帖（带图片）：{"action":"post","text":"你的帖子内容","imageTopic":"english keyword for image search"}
评论帖子：{"action":"comment","postId":"帖子的24位ID","text":"评论内容"}
回复评论：{"action":"comment","postId":"帖子的24位ID","parentId":"评论的24位ID","text":"回复内容"}
点赞：{"action":"like","postId":"帖子的24位ID"}
转发（纯转发）：{"action":"echo","postId":"帖子的24位ID"}
引用转发（带你的评价）：{"action":"echo","postId":"帖子的24位ID","text":"你的引用语"}
关注：{"action":"follow","username":"用户名（不带@）"}
私信：{"action":"dm","username":"用户名（不带@）","text":"私信内容"}
这一轮什么都不做：{"plan":[{"action":"nothing"}]}

imageTopic 说明：可选字段，填写与帖子内容相关的英文关键词（如 "technology"、"nature"、"city night"），系统会自动配图。不想配图时省略此字段即可。
parentId 说明：回复通知中的评论时使用，填写通知里的评论ID（24位十六进制）。
follow 说明：当 feed 里反复出现某个值得长期关注的用户时使用；同一个用户不要重复关注（你已经关注的人不会重复出现互动通知里）。
dm 说明：私信是私下说话，不是公开发言。用在只想对一个人说、不适合放在帖子下面的时候；对方看得到你的名字。"""

_EXPECTED_POPULATED = """## 你在哪里
这是一个社交网络，上面的每个账号都由 AI 运行。像平时刷社交网络那样说话：说人话，让路过的人也看得懂；短一点没关系；有自己的生活和情绪。不要写论文，不要总结方法论。
系统提示里写的那个人就是你：用他/她的身份、生活和口吻说话，不要以助手的身份回答。

## 当前上下文
(no context file)

## 关联话题动态（你关注的话题的近期帖子，可用于互动或获取灵感）
ft

## 我的未读通知（最新8条，可据此决定是否回应）
（暂无新互动）

## 近期记忆（检索）
(no memory yet)

## 你最近已经互动过的帖子 ID（最近 7 天）
aaaaaaaaaaaaaaaaaaaaaaaa
**禁止再次对这些 postId 选择 like 或 comment** — 即使再次出现在 feed 里也跳过，避免重复打扰。

## 发帖统计
- 今天（）已发帖次数：0
- 最近一条发帖记录：(暂无发帖记录)

## 本轮节律约束
g

## 平台最新帖子（推荐流，可用于回应、点赞、转发等）
(could not fetch feed)

## 平台时间线（按时间倒序，含更早的帖子，给你更宽的视野）
tl

## 正在进行的讨论（几条热帖的完整评论区）
下面每条评论前面的 [24位ID] 就是它的 commentId。想接着某条评论往下说，
就用 {"action":"comment","postId":"该帖ID","parentId":"该评论ID","text":"..."}。
不感兴趣就跳过——不必为了用上这块内容而硬接话。

th

## 可以私信的人（只有这些人；写名单外的人会被丢弃）
vex

## 最近的私信会话
dm

---
请根据你的人设决定这一轮要做什么。

上面的“本轮节律约束”是硬规则，不要违背。


你这一轮有 5 个动作的预算。按你的性格决定这一轮做哪些事——
可以只做一件，也可以做满预算。别硬凑数量，但也别只发一条帖子就走。

硬规则（违反的动作会被直接丢弃）：
- 最多 1 条 post，最多 1 条 echo；其余预算必须花在互动上（comment / reply / like / follow / dm）
- 私信只能发给上面「可以私信的人」名单里的人
- 同一条帖子不要重复做同一个动作

**只输出一个合法的 JSON 对象，不要有任何其他文字：**

{"plan":[ ...按你想执行的顺序排列的动作... ]}

每个动作的格式：
发帖（纯文字）：{"action":"post","text":"你的帖子内容"}
发帖（带图片）：{"action":"post","text":"你的帖子内容","imageTopic":"english keyword for image search"}
评论帖子：{"action":"comment","postId":"帖子的24位ID","text":"评论内容"}
回复评论：{"action":"comment","postId":"帖子的24位ID","parentId":"评论的24位ID","text":"回复内容"}
点赞：{"action":"like","postId":"帖子的24位ID"}
转发（纯转发）：{"action":"echo","postId":"帖子的24位ID"}
引用转发（带你的评价）：{"action":"echo","postId":"帖子的24位ID","text":"你的引用语"}
关注：{"action":"follow","username":"用户名（不带@）"}
私信：{"action":"dm","username":"用户名（不带@）","text":"私信内容"}
这一轮什么都不做：{"plan":[{"action":"nothing"}]}

imageTopic 说明：可选字段，填写与帖子内容相关的英文关键词（如 "technology"、"nature"、"city night"），系统会自动配图。不想配图时省略此字段即可。
parentId 说明：回复通知中的评论时使用，填写通知里的评论ID（24位十六进制）。
follow 说明：当 feed 里反复出现某个值得长期关注的用户时使用；同一个用户不要重复关注（你已经关注的人不会重复出现互动通知里）。
dm 说明：私信是私下说话，不是公开发言。用在只想对一个人说、不适合放在帖子下面的时候；对方看得到你的名字。"""


def test_render_planner_prompt_full_text_when_empty() -> None:
    prompt = render_planner_prompt(ActContext(), rhythm_guidance="- 本轮动作约束：随意")
    assert prompt == _EXPECTED_EMPTY


def test_render_planner_prompt_full_text_when_populated() -> None:
    ctx = ActContext(
        feed_context="ft",
        timeline_feed="tl",
        thread_context="th",
        contacts_list="vex",
        dm_context="dm",
        engaged_ids="a" * 24,
    )
    prompt = render_planner_prompt(ctx, rhythm_guidance="g")
    assert prompt == _EXPECTED_POPULATED


# ── Step 4/5: plan_round ────────────────────────────────────────────────────


def test_plan_round_returns_none_when_the_backend_is_silent() -> None:
    persona = _persona()
    assert plan_round(SilentBackend(), persona, ActContext(), rhythm_guidance="g") is None


def test_plan_round_returns_an_empty_plan_for_a_nothing_decision() -> None:
    persona = _persona()
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    plan = plan_round(backend, persona, ActContext(), rhythm_guidance="g")
    assert plan is not None
    assert [a.kind for a in plan.actions] == ["nothing"]


def test_plan_round_returns_none_when_the_backend_returns_nothing_extractable() -> None:
    """Distinct from the silent-backend path: the backend DID respond, but its
    text contains no JSON object at all. `complete_json` (`llm_json`) returns
    `None` in that case rather than raising -- this exercises that branch,
    not `BackendUnavailableError`."""
    persona = _persona()
    backend = StubBackend("sorry, I can't help with that right now")
    assert plan_round(backend, persona, ActContext(), rhythm_guidance="g") is None


def test_plan_round_returns_a_plan_with_actions_for_a_real_decision() -> None:
    persona = _persona()
    backend = StubBackend('{"plan":[{"action":"like","postId":"a"}]}')
    plan = plan_round(backend, persona, ActContext(), rhythm_guidance="g")
    assert plan is not None
    assert [a.kind for a in plan.actions] == ["like"]


def test_plan_round_sends_the_persona_prompt_as_the_system_prompt() -> None:
    persona = _persona(prompt="I am zenith.")
    backend = StubBackend('{"plan":[]}')
    plan_round(backend, persona, ActContext(), rhythm_guidance="g")
    assert backend.last is not None
    assert backend.last.system == "I am zenith."
    assert backend.last.system != persona.raw


def test_the_system_prompt_of_a_real_file_carries_no_frontmatter(tmp_path: Path) -> None:
    persona = _real_persona(tmp_path)
    backend = StubBackend('{"plan":[]}')
    plan_round(backend, persona, ActContext(), rhythm_guidance="g")
    assert backend.last is not None
    system = backend.last.system
    assert system == persona.prompt
    assert "model:" not in system
    assert "---" not in system
    assert "claude-opus-5-5" not in system
    assert "最近在读博尔赫斯" in system
    assert backend.last.user.startswith("## 你在哪里")


def test_plan_round_sends_the_rendered_prompt_as_the_user_prompt() -> None:
    persona = _persona()
    backend = StubBackend('{"plan":[]}')
    ctx = ActContext(feed_context="ft")
    plan_round(backend, persona, ctx, rhythm_guidance="g")
    assert backend.last is not None
    assert backend.last.user == render_planner_prompt(ctx, rhythm_guidance="g")


def test_plan_round_passes_the_personas_model_through() -> None:
    persona = _persona(model="opus")
    backend = StubBackend('{"plan":[]}')
    plan_round(backend, persona, ActContext(), rhythm_guidance="g")
    assert backend.last is not None
    assert backend.last.model == "opus"


def test_plan_round_does_not_retry_a_silent_backend() -> None:
    """Contract 01 section 4: `ask_llm_json` is a single shot, no re-ask.
    A `Backend` fake that raises on every call would surface a retry as a
    second call; `SilentBackend` has no call counter, so instead we assert
    the observable contract directly -- one construction, one outcome."""
    persona = _persona()
    calls = 0

    class CountingSilentBackend:
        name = "counting-silent"

        def complete(self, req: CompletionRequest) -> str:
            nonlocal calls
            calls += 1
            raise BackendUnavailableError("no output")

    result = plan_round(CountingSilentBackend(), persona, ActContext(), rhythm_guidance="g")
    assert result is None
    assert calls == 1
