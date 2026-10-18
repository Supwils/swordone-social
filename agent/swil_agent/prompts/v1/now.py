"""Prompt v1's now-context template (moved verbatim from `act/context.py`)."""

from __future__ import annotations

from typing import Final

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
