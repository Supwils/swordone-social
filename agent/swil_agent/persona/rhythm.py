"""The Era 3 posting rhythm: uniform across the roster, never per persona.

Each round posts with probability `POST_PROBABILITY` (percent), at most
`POST_CEILING_PER_DAY` posts a day; otherwise the round interacts or does
nothing. Because no persona carries its own rhythm, rhythm cannot become a
confound between model arms. The guidance text is prompt v1's
(`prompts/v1/rhythm.py`).
"""

from __future__ import annotations

import random

from swil_agent.models import RhythmDecision, RhythmPolicy
from swil_agent.prompts.v1.rhythm import (
    ceiling_guidance,
    must_post_guidance,
    no_post_guidance,
)

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
            guidance=ceiling_guidance(posts_today, ceiling),
            ceiling_reached=True,
        )

    roll = rng.randint(1, 100)
    if roll <= probability:
        return RhythmDecision(
            policy=RhythmPolicy.MUST_POST,
            prefer_non_post=PREFER_NON_POST,
            post_ceiling=ceiling,
            post_probability=probability,
            roll=roll,
            guidance=must_post_guidance(roll, probability),
        )
    return RhythmDecision(
        policy=RhythmPolicy.NO_POST,
        prefer_non_post=PREFER_NON_POST,
        post_ceiling=ceiling,
        post_probability=probability,
        roll=roll,
        guidance=no_post_guidance(roll, probability),
    )
