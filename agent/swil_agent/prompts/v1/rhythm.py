"""Prompt v1's rhythm lines (moved verbatim from `persona/rhythm.py`)."""

from __future__ import annotations


def ceiling_guidance(posts_today: int, ceiling: int) -> str:
    return (
        f"- 本轮动作约束：今天已发 {posts_today} 条，已达到每日上限 {ceiling} 条；"
        "本轮禁止选择 post，优先评论或其他互动。"
    )


def must_post_guidance(roll: int, probability: int) -> str:
    return f"- 本轮随机抽样：{roll}/100，命中 {probability}% 的发帖概率；本轮必须选择 post。"


def no_post_guidance(roll: int, probability: int) -> str:
    return (
        f"- 本轮随机抽样：{roll}/100，未命中 {probability}% 的发帖概率；"
        "本轮禁止选择 post，优先评论或其他互动，也可以什么都不做。"
    )
