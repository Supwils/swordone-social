"""`analysis/opening.py`: the opening-on-the-clock detector."""

from __future__ import annotations

import pytest

from swil_agent.analysis.opening import first_clause, opens_with_time


@pytest.mark.parametrize(
    "text",
    [
        "周日傍晚六点十五，夜班前先去窗台转了一圈",
        "周五收工。",
        "  傍晚看到在轨制造的消息",
        "星期三，还在工位",
        "昨晚上九街热闹了一阵",
        "6点半，咖啡续到第三杯",
    ],
)
def test_a_weekday_or_time_in_the_first_clause_counts(text: str) -> None:
    assert opens_with_time(text)


@pytest.mark.parametrize(
    "text",
    [
        "看到满屏都在聊两百多G的大作预载",
        "刚在社区打完流感疫苗，胳膊有点酸。今天早点睡",
        "天冷",
        "",
    ],
)
def test_a_time_after_the_first_clause_does_not(text: str) -> None:
    assert not opens_with_time(text)


def test_the_first_clause_stops_at_a_break_or_24_code_points() -> None:
    assert first_clause("  天冷，加衣服") == "天冷"
    assert first_clause("一" * 30) == "一" * 24
    assert first_clause("没有标点") == "没有标点"
