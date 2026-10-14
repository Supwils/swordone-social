"""Population-cohesion trigger, ported from `agent/scripts/population-metric.sh`.

Two independent halves, and the split matters: choosing an account here is
choosing a CREDENTIAL (the route is global and takes no username), so
`find_account_with_api_key` is filesystem-only and `run_population_metric`
never sees a directory at all.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx
import pytest

from swil_agent.analysis.population_metric import (
    PopulationMetricResult,
    find_account_with_api_key,
    run_population_metric,
)
from swil_agent.api.auth import ApiKeyAuth
from swil_agent.api.client import ApiClient
from swil_agent.api.resources import Resources


def _keyed(root: Path, cohort: str, name: str, *, key: bool = True) -> Path:
    directory = root / cohort / name
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(f"- **Username:** {name}\n", encoding="utf-8")
    if key:
        (directory / "api_key.txt").write_text("k\n", encoding="utf-8")
    return directory


# ── find_account_with_api_key ────────────────────────────────────────────


def test_a_named_account_is_found_under_agents(tmp_path: Path) -> None:
    wanted = _keyed(tmp_path, "agents", "zenith")
    assert find_account_with_api_key(tmp_path, "zenith") == wanted


def test_a_named_account_under_humans_is_not_found(tmp_path: Path) -> None:
    """Era 3 has one cohort: a leftover `humans/` tree holds no credentials."""
    _keyed(tmp_path, "humans", "mangniu")
    assert find_account_with_api_key(tmp_path, "mangniu") is None


def test_a_named_account_without_a_key_is_not_found(tmp_path: Path) -> None:
    """`find_key` tests `-f .../api_key.txt`, NOT `-d .../<name>`: a real
    account with no key resolves to nothing, exactly like a name nobody has.
    The account directory and its personality.md both exist here."""
    _keyed(tmp_path, "agents", "keyless", key=False)
    assert find_account_with_api_key(tmp_path, "keyless") is None


def test_an_unknown_name_is_not_found(tmp_path: Path) -> None:
    _keyed(tmp_path, "agents", "zenith")
    assert find_account_with_api_key(tmp_path, "ghost") is None


def test_an_empty_name_is_a_name_not_an_absent_one(tmp_path: Path) -> None:
    """The script branches on `$# -ge 1`, so an empty first argument is still
    an argument: `find_key ""` looks for `agents//api_key.txt` and finds
    nothing, and the run fails. Treating `""` as "no name" would instead
    fall through to the scan and silently authenticate as some arbitrary
    account -- a wrong-credential bug that looks like success."""
    _keyed(tmp_path, "agents", "zenith")
    assert find_account_with_api_key(tmp_path, "") is None


def test_without_a_name_the_first_sorted_agent_wins(tmp_path: Path) -> None:
    """`for d in "$ROOT_DIR/$base"/*/` expands sorted, and `break 2` takes
    the first hit. Created in reverse so insertion order cannot be what is
    actually being observed."""
    _keyed(tmp_path, "agents", "zenith")
    first = _keyed(tmp_path, "agents", "aardvark")
    assert find_account_with_api_key(tmp_path) == first


def test_without_a_name_a_keyless_agent_is_skipped(tmp_path: Path) -> None:
    """`aardvark` sorts first but has no key, so the scan continues rather
    than stopping at the first DIRECTORY."""
    _keyed(tmp_path, "agents", "aardvark", key=False)
    keyed = _keyed(tmp_path, "agents", "zenith")
    assert find_account_with_api_key(tmp_path) == keyed


def test_without_a_name_humans_are_never_searched(tmp_path: Path) -> None:
    _keyed(tmp_path, "agents", "keyless", key=False)
    _keyed(tmp_path, "humans", "mangniu")
    assert find_account_with_api_key(tmp_path) is None


def test_a_missing_agents_directory_is_not_an_error(tmp_path: Path) -> None:
    (tmp_path / "logs").mkdir()
    assert find_account_with_api_key(tmp_path) is None


def test_an_empty_root_yields_none(tmp_path: Path) -> None:
    """The script's `exit 1` path. Returning None rather than raising keeps
    the exit-code decision with the CLI."""
    assert find_account_with_api_key(tmp_path) is None
    assert find_account_with_api_key(tmp_path, "anyone") is None


def test_a_loose_file_beside_the_accounts_is_not_mistaken_for_one(tmp_path: Path) -> None:
    (tmp_path / "agents").mkdir()
    (tmp_path / "agents" / "README.md").write_text("x", encoding="utf-8")
    keyed = _keyed(tmp_path, "agents", "zenith")
    assert find_account_with_api_key(tmp_path) == keyed


# ── run_population_metric ────────────────────────────────────────────────


def _resources(handler: object, requests: list[httpx.Request]) -> Resources:
    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert callable(handler)
        response = handler(request)
        assert isinstance(response, httpx.Response)
        return response

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(record)
    )
    return Resources(client)


# The three numbers are deliberately all different and none of them is a
# default: swapping persona for behavior, or reading `n` off the wrong key,
# changes the assertion.
_SAMPLE = {
    "capturedAt": "2026-08-19T02:00:00.000Z",
    "personaCohesion": 0.11,
    "behaviorCohesion": 0.92,
    "n": 17,
}


def test_a_successful_sample_is_reported_field_by_field() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": _SAMPLE})

    result = run_population_metric(_resources(handler, seen))

    assert result == PopulationMetricResult(
        ok=True,
        captured_at="2026-08-19T02:00:00.000Z",
        persona_cohesion=0.11,
        behavior_cohesion=0.92,
        n=17,
    )


def test_the_route_is_global_and_carries_no_body() -> None:
    """`/agents/population-metric`, not `/agents/<name>/...`: the literal
    path is registered BEFORE the `/:username/*` routes precisely so it is
    not read as a username. And `curl -X POST` with no `-d` sends no body --
    a `null` or `{}` body would be a different request."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": _SAMPLE})

    run_population_metric(_resources(handler, seen))

    assert [r.method for r in seen] == ["POST"]
    assert seen[0].url.path == "/api/v1/agents/population-metric"
    assert seen[0].content == b""


def test_a_degenerate_sample_is_still_a_success() -> None:
    """The server declines to historise `n < 2` (cohesion over one vector is
    a placeholder 1.0 that would poison the trend) but still answers with a
    capturedAt, so Bash reports ok -- and a port that treated `n < 2` as a
    failure would make the FIRST run of a fresh database look broken."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            201,
            json={
                "data": {
                    "capturedAt": "2026-08-19T02:00:00.000Z",
                    "personaCohesion": 1,
                    "behaviorCohesion": 1,
                    "n": 1,
                }
            },
        )

    result = run_population_metric(_resources(handler, seen))
    assert result.ok is True
    assert result.n == 1


def test_the_success_log_line_names_all_three_numbers(caplog: pytest.LogCaptureFixture) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": _SAMPLE})

    with caplog.at_level(logging.INFO, logger="swil_agent.analysis.population_metric"):
        run_population_metric(_resources(handler, seen))
    assert (
        "population-metric: ok personaCohesion=0.11 behaviorCohesion=0.92 n=17" in caplog.messages
    )


def test_a_response_without_captured_at_is_a_rejection() -> None:
    """`jq -e '.data.capturedAt'` (:63). A 2xx envelope that proves nothing
    was sampled must not be reported as a sample."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {"personaCohesion": 0.5, "n": 4}})

    result = run_population_metric(_resources(handler, seen))
    assert result.ok is False
    assert result.persona_cohesion is None
    assert "rejected" in str(result.reason)


def test_a_five_hundred_is_reported_not_raised(caplog: pytest.LogCaptureFixture) -> None:
    """Bash exits 1 here; this reports and lets the CLI decide the exit code.
    Nothing in `analysis/` may raise at a caller."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    with caplog.at_level(logging.WARNING, logger="swil_agent.analysis.population_metric"):
        result = run_population_metric(_resources(handler, seen))
    assert result == PopulationMetricResult(ok=False, reason=result.reason)
    assert result.ok is False
    assert "500" in str(result.reason)
    assert any("server rejected" in m for m in caplog.messages)


def test_an_unreachable_platform_is_reported_not_raised() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    result = run_population_metric(_resources(handler, seen))
    assert result.ok is False
    assert result.captured_at is None


def test_a_boolean_cohesion_is_not_read_as_one_point_zero() -> None:
    """`isinstance(True, int)` is True in Python. A perfect cohesion is the
    single most alarming reading this series can carry (total homogenization),
    so it must never be conjured out of a flag."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            201,
            json={
                "data": {
                    "capturedAt": "2026-08-19T02:00:00.000Z",
                    "personaCohesion": True,
                    "behaviorCohesion": None,
                    "n": True,
                }
            },
        )

    result = run_population_metric(_resources(handler, seen))
    assert result.ok is True
    assert result.persona_cohesion is None
    assert result.behavior_cohesion is None
    assert result.n is None


def test_an_integer_cohesion_is_coerced_to_float() -> None:
    """A cosine of exactly 1 serialises as JSON `1`."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = dict(_SAMPLE, personaCohesion=1, behaviorCohesion=0)
        return httpx.Response(201, json={"data": payload})

    result = run_population_metric(_resources(handler, seen))
    assert result.persona_cohesion == 1.0
    assert result.behavior_cohesion == 0.0


def test_the_response_body_is_json_parsed_not_echoed() -> None:
    """Guard against a port that reported the raw text: the reason field on
    a rejection carries the server's body, but a success must carry parsed
    numbers."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, content=json.dumps({"data": _SAMPLE}).encode())

    assert run_population_metric(_resources(handler, seen)).persona_cohesion == 0.11
