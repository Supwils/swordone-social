"""Pacing and 429 handling for the writes behind the server's per-user
`snapshotIngestLimiter` (20/min, shared by an account's lab writes): the
post-vector backfill (`analysis/backfill_post_vectors.py`) and the bench's run
ingest (`bench/runner.py`), one policy for both (S3 §12.24).

`IngestThrottle` keeps a process to `INGESTS_PER_MINUTE` attempts in any
rolling `THROTTLE_WINDOW_SECONDS`. `retry_rate_limited` sends one write
through it and, on a 429, waits what `retry_after_seconds` reads from the
response (`RATE_LIMIT_FALLBACK_SECONDS` when nothing says) and retries, up to
`MAX_RATE_LIMIT_RETRIES` times. Clock and sleep are injected so tests never
sleep.
"""

from __future__ import annotations

import re
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Final

INGESTS_PER_MINUTE: Final = 18
"""Ingest attempts per rolling 60 s, under the server's 20/min per-user
`snapshotIngestLimiter` with room for the account's other lab writes."""

THROTTLE_WINDOW_SECONDS: Final = 60.0

RATE_LIMIT_FALLBACK_SECONDS: Final = 60.0
"""The wait after a 429 that names no reset (the limiter's window)."""

MAX_RATE_LIMIT_RETRIES: Final = 3
"""Retries of one post after a 429; past that the post counts as failed."""


_RATELIMIT_RESET_RE: Final = re.compile(r"(?:^|[,;\s])reset=(\d+)", re.ASCII)


def _seconds(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        value = float(raw.strip())
    except ValueError:
        return None
    return value if value >= 0 else None


def retry_after_seconds(headers: Mapping[str, str], *, now: datetime | None = None) -> float | None:
    """How long a 429 asked us to wait: `Retry-After` (delta-seconds or an
    HTTP date), else `RateLimit-Reset` (draft-6), else the `reset=` field of
    the draft-7 `RateLimit` header the server's limiters send. `None` when
    no header says. Header names are expected lowercased (`ApiError.headers`)."""
    retry_after = headers.get("retry-after")
    seconds = _seconds(retry_after)
    if seconds is not None:
        return seconds
    if retry_after:
        try:
            when = parsedate_to_datetime(retry_after)
        except (TypeError, ValueError):
            when = None
        if when is not None:
            moment = now or datetime.now(UTC)
            when = when.replace(tzinfo=UTC) if when.tzinfo is None else when
            return max(0.0, (when - moment).total_seconds())
    seconds = _seconds(headers.get("ratelimit-reset"))
    if seconds is not None:
        return seconds
    match = _RATELIMIT_RESET_RE.search(headers.get("ratelimit", ""))
    return float(match.group(1)) if match else None


class IngestThrottle:
    """At most `limit` acquisitions in any rolling `window` seconds; an
    acquisition past that sleeps until the oldest one leaves the window."""

    def __init__(
        self,
        *,
        limit: int,
        window: float,
        clock: Callable[[], float],
        sleep: Callable[[float], None],
    ) -> None:
        self._limit = limit
        self._window = window
        self._clock = clock
        self._sleep = sleep
        self._stamps: deque[float] = deque()

    def acquire(self) -> None:
        now = self._clock()
        while self._stamps and now - self._stamps[0] >= self._window:
            self._stamps.popleft()
        if len(self._stamps) >= self._limit:
            self._sleep(self._stamps[0] + self._window - now)
            now = self._clock()
            while self._stamps and now - self._stamps[0] >= self._window:
                self._stamps.popleft()
        self._stamps.append(now)


@dataclass(frozen=True)
class RateLimited:
    """One attempt the server answered with a 429. `retry_after` is how long
    it asked for (`None` when no header said); `cause` is what the caller
    reports if the retries run out."""

    retry_after: float | None
    cause: object = None


def rate_limit_wait(retry_after: float | None) -> float:
    """The wait after a 429: what the server asked for, never negative, and
    `RATE_LIMIT_FALLBACK_SECONDS` when it did not say."""
    return RATE_LIMIT_FALLBACK_SECONDS if retry_after is None else max(0.0, retry_after)


def retry_rate_limited[T](
    attempt: Callable[[], T | RateLimited],
    *,
    throttle: IngestThrottle,
    sleep: Callable[[float], None],
    on_retry: Callable[[float], None] | None = None,
) -> T | RateLimited:
    """Run `attempt` through `throttle` until it answers something other
    than `RateLimited`, waiting each 429 out (`rate_limit_wait`) and retrying
    at most `MAX_RATE_LIMIT_RETRIES` times.

    Every attempt, a retry included, takes a throttle slot: a 429'd POST
    still counted against the server's window. Answers the last attempt's
    value -- a `RateLimited` once the retries are spent, with no wait after
    it. `on_retry(wait)` runs before each wait (the caller's log line)."""
    retries = 0
    while True:
        throttle.acquire()
        outcome = attempt()
        if not isinstance(outcome, RateLimited) or retries == MAX_RATE_LIMIT_RETRIES:
            return outcome
        wait = rate_limit_wait(outcome.retry_after)
        if on_retry is not None:
            on_retry(wait)
        sleep(wait)
        retries += 1
