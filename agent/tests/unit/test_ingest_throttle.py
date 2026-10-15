"""`api/ingest_throttle.py`: the one pacing + 429 policy the post-vector
backfill and the bench's run ingest share (S3 §12.24).

The two callers' own suites pin their end-to-end behaviour
(`test_backfill_post_vectors.py`, `test_bench_runner.py`); these pin the
helper itself, so a change to the shared loop fails here first and names
the helper rather than one caller.
"""

from __future__ import annotations

from swil_agent.api.ingest_throttle import (
    INGESTS_PER_MINUTE,
    MAX_RATE_LIMIT_RETRIES,
    RATE_LIMIT_FALLBACK_SECONDS,
    THROTTLE_WINDOW_SECONDS,
    IngestThrottle,
    RateLimited,
    rate_limit_wait,
    retry_rate_limited,
)


class FakeClock:
    """Monotonic seconds that only `sleep` advances; records every sleep."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def _throttle(clock: FakeClock, *, limit: int = INGESTS_PER_MINUTE) -> IngestThrottle:
    return IngestThrottle(
        limit=limit, window=THROTTLE_WINDOW_SECONDS, clock=clock, sleep=clock.sleep
    )


def test_the_policy_numbers_stay_under_the_servers_limiter() -> None:
    assert INGESTS_PER_MINUTE == 18
    assert THROTTLE_WINDOW_SECONDS == 60.0
    assert RATE_LIMIT_FALLBACK_SECONDS == 60.0
    assert MAX_RATE_LIMIT_RETRIES == 3


def test_the_throttle_sleeps_only_once_the_window_is_full() -> None:
    clock = FakeClock()
    throttle = _throttle(clock, limit=2)
    throttle.acquire()
    throttle.acquire()
    assert clock.sleeps == []
    clock.now = 10.0
    throttle.acquire()
    # The oldest stamp (0.0) leaves the window at 60.0.
    assert clock.sleeps == [50.0]
    assert clock.now == 60.0


def test_the_throttle_forgets_stamps_that_left_the_window() -> None:
    clock = FakeClock()
    throttle = _throttle(clock, limit=1)
    throttle.acquire()
    clock.now = 60.0
    throttle.acquire()
    assert clock.sleeps == []


def test_rate_limit_wait_uses_the_server_value_never_negative_else_the_fallback() -> None:
    assert rate_limit_wait(7.5) == 7.5
    assert rate_limit_wait(-3.0) == 0.0
    assert rate_limit_wait(None) == RATE_LIMIT_FALLBACK_SECONDS


def test_a_first_answer_that_is_not_rate_limited_returns_at_once() -> None:
    clock = FakeClock()
    calls: list[int] = []
    retried: list[float] = []

    def attempt() -> str:
        calls.append(1)
        return "id-1"

    outcome = retry_rate_limited(
        attempt, throttle=_throttle(clock), sleep=clock.sleep, on_retry=retried.append
    )
    assert outcome == "id-1"
    assert calls == [1]
    assert clock.sleeps == []
    assert retried == []


def test_a_429_is_waited_out_and_retried_through_the_throttle() -> None:
    clock = FakeClock()
    answers: list[str | RateLimited] = [RateLimited(7.0), RateLimited(None), "id-1"]
    attempt_times: list[float] = []
    retried: list[float] = []

    def attempt() -> str | RateLimited:
        attempt_times.append(clock.now)
        return answers.pop(0)

    outcome = retry_rate_limited(
        attempt, throttle=_throttle(clock), sleep=clock.sleep, on_retry=retried.append
    )
    assert outcome == "id-1"
    # `on_retry` hears each wait before it is slept.
    assert retried == [7.0, RATE_LIMIT_FALLBACK_SECONDS]
    assert clock.sleeps == [7.0, RATE_LIMIT_FALLBACK_SECONDS]
    assert attempt_times == [0.0, 7.0, 67.0]


def test_every_retry_takes_a_throttle_slot() -> None:
    """A 429'd POST still counted against the server's window, so a retry
    is throttled like any other attempt."""
    clock = FakeClock()
    throttle = _throttle(clock, limit=2)
    answers: list[str | RateLimited] = [RateLimited(0.0), RateLimited(0.0), "id-1"]

    outcome = retry_rate_limited(lambda: answers.pop(0), throttle=throttle, sleep=clock.sleep)
    assert outcome == "id-1"
    # Two zero waits, then the third attempt waits for the window.
    assert clock.sleeps == [0.0, 0.0, THROTTLE_WINDOW_SECONDS]


def test_spent_retries_return_the_last_rate_limited_answer_without_a_final_wait() -> None:
    clock = FakeClock()
    cause = RuntimeError("HTTP 429")
    calls: list[int] = []

    def attempt() -> str | RateLimited:
        calls.append(1)
        return RateLimited(5.0, cause=cause)

    outcome = retry_rate_limited(attempt, throttle=_throttle(clock), sleep=clock.sleep)
    assert isinstance(outcome, RateLimited)
    assert outcome.cause is cause
    assert len(calls) == MAX_RATE_LIMIT_RETRIES + 1
    assert clock.sleeps == [5.0] * MAX_RATE_LIMIT_RETRIES
