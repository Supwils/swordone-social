"""The Era 3 posting rhythm: uniform across the roster, never per persona.

Each round posts with probability `POST_PROBABILITY` (percent), at most
`POST_CEILING_PER_DAY` posts a day; otherwise the round interacts or does
nothing. Because no persona carries its own rhythm, rhythm cannot become a
confound between model arms.
"""

from __future__ import annotations

import random

from swil_agent.models import RhythmDecision, RhythmPolicy

PREFER_NON_POST = "comment"


def decide_rhythm(
    posts_today: int,
    rng: random.Random,
    *,
    probability: int,
    ceiling: int,
) -> RhythmDecision:
    # At the ceiling no roll is drawn: the answer cannot depend on it.
    if posts_today >= ceiling:
        return RhythmDecision(
            policy=RhythmPolicy.NO_POST,
            prefer_non_post=PREFER_NON_POST,
            post_ceiling=ceiling,
            post_probability=probability,
            guidance=(
                f"- 本轮动作约束：今天已发 {posts_today} 条，已达到每日上限 {ceiling} 条；"
                "本轮禁止选择 post，优先评论或其他互动。"
            ),
        )

    roll = rng.randint(1, 100)
    if roll <= probability:
        return RhythmDecision(
            policy=RhythmPolicy.MUST_POST,
            prefer_non_post=PREFER_NON_POST,
            post_ceiling=ceiling,
            post_probability=probability,
            roll=roll,
            guidance=(
                f"- 本轮随机抽样：{roll}/100，命中 {probability}% 的发帖概率；本轮必须选择 post。"
            ),
        )
    return RhythmDecision(
        policy=RhythmPolicy.NO_POST,
        prefer_non_post=PREFER_NON_POST,
        post_ceiling=ceiling,
        post_probability=probability,
        roll=roll,
        guidance=(
            f"- 本轮随机抽样：{roll}/100，未命中 {probability}% 的发帖概率；"
            "本轮禁止选择 post，优先评论或其他互动，也可以什么都不做。"
        ),
    )
