"""Round ids: one shared id per sweep, a manual id otherwise (S2 spec §3)."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta, timezone

import pytest

from swil_agent.round_id import (
    ROUND_ID_RE,
    is_valid_round_id,
    manual_round_id,
    round_kind,
    round_sort_key,
    sweep_or_manual_round_id,
)

NOW = datetime(2026, 10, 14, 9, 30, 5, tzinfo=UTC)
SWEEP = "20261014T091500Z-r"


def _never(_round_id: str) -> bool:
    return False


def test_the_regex_is_the_pre_registered_one() -> None:
    assert ROUND_ID_RE.pattern == r"^\d{8}T\d{6}Z-[rm]$"
    assert ROUND_ID_RE.flags & re.ASCII


@pytest.mark.parametrize(
    "value",
    [
        "\u0662\u0660\u0662\u0666\u0661\u0660\u0661\u0664T\u0660\u0669\u0661\u0665\u0660\u0660Z-r",
        "2026101\u0664T091500Z-m",  # one Arabic-Indic digit is enough
        "20261014T09150\uff10Z-r",  # a fullwidth zero
    ],
)
def test_non_ascii_digits_are_not_a_round_id(value: str) -> None:
    """`\\d` without `re.ASCII` matches any Unicode decimal digit; the stamp
    must stay sortable and `strptime`-able, so only 0-9 count."""
    assert not is_valid_round_id(value)


@pytest.mark.parametrize("value", ["20261014T091500Z-r", "20261014T091500Z-m"])
def test_valid_ids(value: str) -> None:
    assert is_valid_round_id(value)


@pytest.mark.parametrize(
    "value",
    [
        "",
        "20261014T091500",  # Era 2 checkpoint key: no suffix
        "20261014T091500Z-x",
        "20261014T091500Z-r\n",
        "2026-10-14T09:15:00Z-r",
        " 20261014T091500Z-r",
        "r1",
    ],
)
def test_invalid_ids(value: str) -> None:
    assert not is_valid_round_id(value)


def test_round_kind() -> None:
    assert round_kind("20261014T091500Z-r") == "sweep"
    assert round_kind("20261014T091500Z-m") == "manual"
    with pytest.raises(ValueError, match="not a round id"):
        round_kind("20261014T091500")


def test_a_manual_id_is_the_utc_moment_with_the_m_suffix() -> None:
    assert manual_round_id(NOW) == "20261014T093005Z-m"


def test_a_manual_id_from_a_non_utc_clock_is_converted_to_utc() -> None:
    plus8 = NOW.astimezone(timezone(timedelta(hours=8)))
    assert manual_round_id(plus8) == "20261014T093005Z-m"


def test_a_valid_env_sweep_id_is_used(caplog: pytest.LogCaptureFixture) -> None:
    seen: list[str] = []

    def exists(round_id: str) -> bool:
        seen.append(round_id)
        return False

    with caplog.at_level(logging.WARNING):
        assert sweep_or_manual_round_id(SWEEP, now=NOW, thread_exists=exists) == SWEEP
    assert seen == [SWEEP]
    assert caplog.records == []


@pytest.mark.parametrize("env_value", [None, "", "   "])
def test_unset_falls_back_to_manual_without_a_warning(
    env_value: str | None, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        chosen = sweep_or_manual_round_id(env_value, now=NOW, thread_exists=_never)
    assert chosen == "20261014T093005Z-m"
    assert ROUND_ID_RE.match(chosen)
    assert caplog.records == []


def test_an_invalid_env_id_warns_and_falls_back_to_manual(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def exists(_round_id: str) -> bool:
        raise AssertionError("an invalid id must not be looked up")

    with caplog.at_level(logging.WARNING):
        chosen = sweep_or_manual_round_id("20261013T070600", now=NOW, thread_exists=exists)
    assert chosen == "20261014T093005Z-m"
    assert len(caplog.records) == 1
    assert caplog.records[0].levelno == logging.WARNING
    assert "20261013T070600" in caplog.text
    assert "not a valid round id" in caplog.text


def test_an_env_id_whose_thread_exists_warns_and_falls_back_to_manual(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Review Focus 1: a stale exported id in an operator shell must never
    re-enter the thread a finished sweep left behind."""
    with caplog.at_level(logging.WARNING):
        chosen = sweep_or_manual_round_id(SWEEP, now=NOW, thread_exists=lambda _r: True)
    assert chosen == "20261014T093005Z-m"
    assert len(caplog.records) == 1
    assert SWEEP in caplog.text
    assert "already has a checkpointed thread" in caplog.text


def test_surrounding_whitespace_on_the_env_value_is_tolerated() -> None:
    assert sweep_or_manual_round_id(f" {SWEEP}\n", now=NOW, thread_exists=_never) == SWEEP


def test_sort_key_orders_new_ids_by_time_then_kind() -> None:
    ids = ["20261014T091500Z-r", "20261014T091500Z-m", "20261015T000000Z-m", "20261013T235959Z-r"]
    assert max(ids, key=round_sort_key) == "20261015T000000Z-m"
    assert sorted(ids, key=round_sort_key)[0] == "20261013T235959Z-r"


def test_sort_key_ranks_an_era_2_key_older_than_any_new_id() -> None:
    """Old `%Y%m%dT%H%M%S` keys may still sit in a dev checkpoint DB. They must
    not crash the ordering, and they rank below every new-format id even when
    their stamp is later."""
    ids = ["20991231T235959", "20261014T091500Z-m", "garbage"]
    assert max(ids, key=round_sort_key) == "20261014T091500Z-m"
    assert sorted(ids, key=round_sort_key) == ["20991231T235959", "garbage", "20261014T091500Z-m"]
