"""Runtime-health aggregation behind `swil-agent measure-status` (spec §11).

`GET /api/v1/agents/runtime` is a public lab read: no credentials, one
request. The server answers per-day points; this module picks the range
that covers the requested window, fetches it, and sums the points on or
after `since`. The command in `cli/ops.py` prints the result.

These are the CLI's second seam home (S3 §12.13): `cli/ops.py` calls each
function as an attribute of this module, so a test replaces the fetch with
`monkeypatch.setattr(measure_status, "fetch_runtime_health", fake)`. The
clock is the caller's: `today` is passed in, never read here.
"""

from __future__ import annotations

from datetime import UTC, date
from typing import Any, Final, NamedTuple

import httpx

from swil_agent.config import Settings

DEFAULT_MEASURE_SINCE: Final = "2026-07-25"

_HTTP_TIMEOUT = 10.0


class RuntimeTotals(NamedTuple):
    rounds: int
    missing_samples: int
    landed: int
    # `None` when the server does not report the field (a server before S2).
    missing_post_vectors: int | None


def parse_iso_date(raw: str) -> date:
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"--since={raw!r} is not YYYY-MM-DD") from exc


def range_covering(since: date, today: date) -> str:
    days = max(0, (today - since).days)
    if days <= 7:
        return "7d"
    if days <= 30:
        return "30d"
    return "90d"


def fetch_runtime_health(
    settings: Settings,
    *,
    since: date,
    today: date,
    transport: httpx.BaseTransport | None = None,
) -> dict[str, Any]:
    """GET /api/v1/agents/runtime — public lab read, no credentials.

    `transport` is an injection seam for tests (`httpx.MockTransport`), as on
    `doctor.since_probe`; the command never passes it.
    """
    range_ = range_covering(since, today)
    try:
        with httpx.Client(transport=transport, timeout=_HTTP_TIMEOUT) as client:
            response = client.get(
                f"{settings.swil_url}/api/v1/agents/runtime",
                params={"range": range_},
            )
            response.raise_for_status()
            parsed: Any = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError(str(exc)) from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"unexpected runtime payload: {parsed!r}")
    data = parsed.get("data", parsed)
    if not isinstance(data, dict):
        raise RuntimeError(f"unexpected runtime payload: {parsed!r}")
    data.setdefault("range", range_)
    return data


def runtime_totals(payload: dict[str, Any], *, since: date) -> RuntimeTotals:
    """Sum points on/after `since`. Falls back to the DTO totals when the
    payload has no points (a fake/summary-only body)."""
    points = payload.get("points")
    if isinstance(points, list) and points:
        rounds = missing = landed = vectors = 0
        vectors_reported = "missingPostVectors" in payload
        since_s = since.isoformat()
        for point in points:
            if not isinstance(point, dict):
                continue
            vectors_reported = vectors_reported or "missingPostVectors" in point
            day = point.get("date")
            if not isinstance(day, str) or day < since_s:
                continue
            rounds += int(point.get("rounds") or 0)
            missing += int(point.get("missingSamples") or 0)
            landed += int(point.get("landed") or 0)
            vectors += int(point.get("missingPostVectors") or 0)
        return RuntimeTotals(rounds, missing, landed, vectors if vectors_reported else None)
    return RuntimeTotals(
        int(payload.get("rounds") or 0),
        int(payload.get("missingSamples") or 0),
        int(payload.get("landedActions") or 0),
        (int(payload.get("missingPostVectors") or 0) if "missingPostVectors" in payload else None),
    )


def measure_since_default(settings: Settings) -> str:
    """The ERA_START date (UTC, the server's day boundary) when an era is
    open, else the design date."""
    if settings.era_start is None:
        return DEFAULT_MEASURE_SINCE
    start = settings.era_start
    if start.tzinfo is not None:
        start = start.astimezone(UTC)
    return start.date().isoformat()
