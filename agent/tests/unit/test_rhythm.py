"""Uniform Era 3 rhythm: one roll against `POST_PROBABILITY`, capped by
`POST_CEILING_PER_DAY`. Rhythm is not a property of a persona any more, so it
cannot differ between arms."""

from __future__ import annotations

import random

import pytest

from swil_agent.models import RhythmDecision, RhythmPolicy
from swil_agent.persona.rhythm import decide_rhythm


class FixedRoll(random.Random):
    """Returns one fixed `randint` draw and counts how many were taken."""

    def __init__(self, roll: int) -> None:
        super().__init__(0)
        self.roll = roll
        self.draws = 0

    def randint(self, a: int, b: int) -> int:
        assert (a, b) == (1, 100)
        self.draws += 1
        return self.roll


def test_ceiling_reached_is_no_post_regardless_of_the_roll() -> None:
    for roll in (1, 60, 100):
        rng = FixedRoll(roll)
        decision = decide_rhythm(1, rng, probability=100, ceiling=1)
        assert decision.policy is RhythmPolicy.NO_POST
        assert decision.post_ceiling == 1
        assert rng.draws == 0


def test_over_the_ceiling_is_still_no_post() -> None:
    decision = decide_rhythm(3, FixedRoll(1), probability=60, ceiling=1)
    assert decision.policy is RhythmPolicy.NO_POST


def test_a_roll_equal_to_the_probability_must_post() -> None:
    decision = decide_rhythm(0, FixedRoll(60), probability=60, ceiling=1)
    assert decision.policy is RhythmPolicy.MUST_POST
    assert decision.roll == 60
    assert decision.post_probability == 60
    assert decision.post_ceiling == 1


def test_a_roll_one_above_the_probability_is_no_post() -> None:
    decision = decide_rhythm(0, FixedRoll(61), probability=60, ceiling=1)
    assert decision.policy is RhythmPolicy.NO_POST
    assert decision.roll == 61


@pytest.mark.parametrize("roll", [1, 50, 100])
def test_probability_zero_never_must_post(roll: int) -> None:
    decision = decide_rhythm(0, FixedRoll(roll), probability=0, ceiling=1)
    assert decision.policy is RhythmPolicy.NO_POST


@pytest.mark.parametrize("roll", [1, 50, 100])
def test_probability_hundred_always_must_post_below_the_ceiling(roll: int) -> None:
    decision = decide_rhythm(0, FixedRoll(roll), probability=100, ceiling=1)
    assert decision.policy is RhythmPolicy.MUST_POST


def test_probability_hundred_still_yields_to_the_ceiling() -> None:
    decision = decide_rhythm(1, FixedRoll(1), probability=100, ceiling=1)
    assert decision.policy is RhythmPolicy.NO_POST


def test_ceiling_zero_forbids_posting_entirely() -> None:
    decision = decide_rhythm(0, FixedRoll(1), probability=100, ceiling=0)
    assert decision.policy is RhythmPolicy.NO_POST


def test_every_decision_prefers_comment_and_never_returns_free() -> None:
    decisions = [
        decide_rhythm(1, FixedRoll(1), probability=60, ceiling=1),
        decide_rhythm(0, FixedRoll(1), probability=60, ceiling=1),
        decide_rhythm(0, FixedRoll(99), probability=60, ceiling=1),
    ]
    assert {d.prefer_non_post for d in decisions} == {"comment"}
    assert RhythmPolicy.FREE not in {d.policy for d in decisions}


def test_guidance_is_one_chinese_line_naming_the_decision() -> None:
    ceiling = decide_rhythm(1, FixedRoll(1), probability=60, ceiling=1)
    must = decide_rhythm(0, FixedRoll(42), probability=60, ceiling=1)
    no = decide_rhythm(0, FixedRoll(77), probability=60, ceiling=1)
    for decision in (ceiling, must, no):
        assert "\n" not in decision.guidance
        assert decision.guidance.startswith("- 本轮")
    assert "上限" in ceiling.guidance and "禁止选择 post" in ceiling.guidance
    assert "42/100" in must.guidance and "必须选择 post" in must.guidance
    assert "77/100" in no.guidance and "禁止选择 post" in no.guidance


def test_a_seeded_rng_reproduces_the_same_decision() -> None:
    first = decide_rhythm(0, random.Random(7), probability=60, ceiling=1)
    second = decide_rhythm(0, random.Random(7), probability=60, ceiling=1)
    assert first == second


def test_only_the_ceiling_branch_reports_ceiling_reached() -> None:
    assert decide_rhythm(1, FixedRoll(1), probability=60, ceiling=1).ceiling_reached is True
    assert decide_rhythm(0, FixedRoll(1), probability=60, ceiling=1).ceiling_reached is False
    assert decide_rhythm(0, FixedRoll(99), probability=60, ceiling=1).ceiling_reached is False


def test_the_guidance_text_comes_from_the_v1_prompt_module() -> None:
    from swil_agent.prompts.v1 import rhythm as v1

    assert decide_rhythm(1, FixedRoll(1), probability=60, ceiling=1).guidance == (
        v1.ceiling_guidance(1, 1)
    )
    assert decide_rhythm(0, FixedRoll(42), probability=60, ceiling=1).guidance == (
        v1.must_post_guidance(42, 60)
    )
    assert decide_rhythm(0, FixedRoll(77), probability=60, ceiling=1).guidance == (
        v1.no_post_guidance(77, 60)
    )


def test_a_decision_checkpointed_before_the_flag_loads_with_it_false() -> None:
    old = {"policy": "no_post", "prefer_non_post": "comment", "guidance": "g", "roll": None}
    assert RhythmDecision.model_validate(old).ceiling_reached is False
