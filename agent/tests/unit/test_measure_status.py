"""`measure-status`'s aggregation, below the CLI (S3 §6).

The command tests in `test_cli.py` replace `fetch_runtime_health`; this
drives the real fetch over `httpx.MockTransport` and the pure helpers.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, timezone

import httpx
import pytest

from swil_agent.analysis.measure_status import (
    DEFAULT_MEASURE_SINCE,
    fetch_runtime_health,
    measure_since_default,
    parse_iso_date,
    range_covering,
)
from swil_agent.config import Settings


@pytest.mark.parametrize(
    ("days", "expected"), [(-3, "7d"), (0, "7d"), (7, "7d"), (8, "30d"), (30, "30d"), (31, "90d")]
)
def test_the_range_is_the_smallest_window_covering_since(days: int, expected: str) -> None:
    today = date(2026, 10, 14)
    assert range_covering(today - timedelta(days=days), today) == expected


def test_a_bad_since_names_the_flag() -> None:
    assert parse_iso_date("2026-10-14") == date(2026, 10, 14)
    with pytest.raises(ValueError, match="--since='14/10/2026' is not YYYY-MM-DD"):
        parse_iso_date("14/10/2026")


def test_the_default_since_is_the_era_start_utc_date_else_the_design_date(tmp_path) -> None:
    assert measure_since_default(Settings(agent_root=tmp_path, era_start=None)) == (
        DEFAULT_MEASURE_SINCE
    )
    late = datetime(2026, 10, 14, 20, 30, tzinfo=timezone(timedelta(hours=-7)))
    assert measure_since_default(Settings(agent_root=tmp_path, era_start=late)) == "2026-10-15"
    naive = datetime(2026, 10, 14, 20, 30)
    assert measure_since_default(Settings(agent_root=tmp_path, era_start=naive)) == "2026-10-14"


def _settings(tmp_path) -> Settings:
    return Settings(agent_root=tmp_path, swil_url="https://example.test", era_start=None)


def test_the_fetch_asks_for_the_range_covering_since_and_unwraps_data(tmp_path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": {"rounds": 3}})

    payload = fetch_runtime_health(
        _settings(tmp_path),
        since=date(2026, 10, 1),
        today=date(2026, 10, 14),
        transport=httpx.MockTransport(handler),
    )
    assert payload == {"rounds": 3, "range": "30d"}
    assert str(seen[0].url) == "https://example.test/api/v1/agents/runtime?range=30d"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, json={}),
        httpx.Response(200, content=b"not json"),
        httpx.Response(200, json=[1, 2]),
        httpx.Response(200, json={"data": [1]}),
    ],
)
def test_every_fetch_failure_is_a_runtime_error(tmp_path, response: httpx.Response) -> None:
    with pytest.raises(RuntimeError):
        fetch_runtime_health(
            _settings(tmp_path),
            since=date(2026, 10, 1),
            today=datetime.now(UTC).date(),
            transport=httpx.MockTransport(lambda request: response),
        )
