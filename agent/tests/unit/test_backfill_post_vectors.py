"""`analysis/backfill_post_vectors.py` -- vectors for posts that landed
before the act path filed them (S2 §4).

Pinned: the own-posts read pages to the end with `since=ERA_START`; posts
before the era are dropped client-side too; `[card, *texts]` goes to the
embedder in batches of at most 64; every post is filed with `roundId: null`,
`maxSim: null` and its cosine against the card; a dry run embeds and files
nothing; an embedder or ingest failure costs those posts, never the run.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from swil_agent.analysis.backfill_post_vectors import (
    EMBED_BATCH_MAX,
    INGESTS_PER_MINUTE,
    MAX_RATE_LIMIT_RETRIES,
    PAGE_LIMIT,
    RATE_LIMIT_FALLBACK_SECONDS,
    list_era_posts,
    run_backfill_post_vectors,
)
from swil_agent.api.client import ApiError
from swil_agent.api.resources import VectorFiling
from swil_agent.embedder.client import EmbedderUnavailable

ERA_START = datetime(2026, 10, 14, 0, 0, tzinfo=UTC)
SINCE = "2026-10-14T00:00:00+00:00"
CARD = "成都社区医院的夜班护士。"


def _post(n: int, *, created: str = "2026-10-15T08:00:00.000Z", **extra: Any) -> dict[str, Any]:
    return {"id": f"{n:024x}", "text": f"post {n}", "createdAt": created, **extra}


class PagedResources:
    """`user_posts_page` over fixed pages, plus a recording `post_vector`."""

    def __init__(
        self,
        pages: list[list[dict[str, Any]]],
        *,
        ok: bool = True,
        outcomes: list[VectorFiling] | None = None,
        clock: FakeClock | None = None,
    ) -> None:
        self._pages = pages
        self._ok = ok
        self._outcomes = list(outcomes or [])
        self._clock = clock
        self.attempt_times: list[float] = []
        self.page_calls: list[tuple[str, int, str | None, str | None]] = []
        self.filed: list[tuple[str, dict[str, Any]]] = []
        self.fail_list = False

    def user_posts_page(
        self,
        username: str,
        *,
        limit: int,
        since: str | None = None,
        cursor: str | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        self.page_calls.append((username, limit, since, cursor))
        if self.fail_list:
            raise ApiError(500, "boom", None)
        index = 0 if cursor is None else int(cursor)
        next_cursor = str(index + 1) if index + 1 < len(self._pages) else None
        return self._pages[index], next_cursor

    def file_post_vector(
        self,
        username: str,
        *,
        post_id: str,
        round_id: str | None,
        embedding: list[float],
        card_sim: float | None,
        max_sim: float | None,
    ) -> VectorFiling:
        if self._clock is not None:
            self.attempt_times.append(self._clock.now)
        if self._outcomes:
            outcome = self._outcomes.pop(0)
            if outcome.status != "filed":
                return outcome
        elif not self._ok:
            return VectorFiling("failed")
        self.filed.append(
            (
                username,
                {
                    "post_id": post_id,
                    "round_id": round_id,
                    "embedding": embedding,
                    "card_sim": card_sim,
                    "max_sim": max_sim,
                },
            )
        )
        return VectorFiling("filed")


class FakeClock:
    """A monotonic clock that only moves when the code under test sleeps
    (or a test advances it), so throttle tests never sleep for real."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class BatchEmbedder:
    """Card -> [1.0, 0.0]; every post -> [0.6, 0.8] (cosine 0.6 with the card)."""

    def __init__(self, *, fail_on_call: int | None = None) -> None:
        self.batches: list[list[str]] = []
        self._fail_on_call = fail_on_call

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.batches.append(list(texts))
        if self._fail_on_call == len(self.batches):
            raise EmbedderUnavailable("down")
        return [[1.0, 0.0] if t == CARD else [0.6, 0.8] for t in texts]


def _run(
    resources: Any,
    embedder: Any = None,
    *,
    dry_run: bool = False,
    card: str = CARD,
    clock: FakeClock | None = None,
) -> Any:
    clock = clock or FakeClock()
    return run_backfill_post_vectors(
        resources,
        username="xiaoman",
        card=card,
        embedder=embedder if embedder is not None else BatchEmbedder(),
        era_start=ERA_START,
        dry_run=dry_run,
        clock=clock.monotonic,
        sleep=clock.sleep,
    )


def test_the_read_pages_to_the_end_with_since_and_the_largest_limit() -> None:
    resources = PagedResources([[_post(1), _post(2)], [_post(3)]])

    posts = list_era_posts(resources, "xiaoman", era_start=ERA_START)  # type: ignore[arg-type]

    assert [p.post_id for p in posts] == [f"{n:024x}" for n in (1, 2, 3)]
    assert resources.page_calls == [
        ("xiaoman", PAGE_LIMIT, SINCE, None),
        ("xiaoman", PAGE_LIMIT, SINCE, "1"),
    ]
    assert PAGE_LIMIT == 100


def test_posts_before_the_era_or_without_a_body_or_id_are_dropped() -> None:
    resources = PagedResources(
        [
            [
                _post(1),
                _post(2, created="2026-10-13T23:59:59.000Z"),
                _post(3, created="not a date"),
                {"id": "x" * 24, "text": "  ", "createdAt": "2026-10-15T00:00:00Z"},
                {"text": "no id", "createdAt": "2026-10-15T00:00:00Z"},
                _post(4, originalText="原文"),
            ]
        ]
    )

    posts = list_era_posts(resources, "xiaoman", era_start=ERA_START)  # type: ignore[arg-type]

    assert [(p.post_id, p.text) for p in posts] == [
        (f"{1:024x}", "post 1"),
        (f"{4:024x}", "原文"),
    ]


def test_a_repeated_cursor_ends_the_read_instead_of_looping() -> None:
    class StuckResources(PagedResources):
        def user_posts_page(self, username: str, **kwargs: Any) -> Any:
            self.page_calls.append((username, kwargs["limit"], kwargs.get("since"), None))
            return [_post(len(self.page_calls))], "same"

    resources = StuckResources([])

    posts = list_era_posts(resources, "xiaoman", era_start=ERA_START)  # type: ignore[arg-type]

    assert len(resources.page_calls) == 2
    assert len(posts) == 2


def test_every_post_is_filed_with_a_null_round_null_max_sim_and_its_card_sim() -> None:
    resources = PagedResources([[_post(1), _post(2)]])
    embedder = BatchEmbedder()

    result = _run(resources, embedder)

    assert embedder.batches == [[CARD, "post 1", "post 2"]]
    assert [name for name, _ in resources.filed] == ["xiaoman", "xiaoman"]
    for (_, body), n in zip(resources.filed, (1, 2), strict=True):
        assert body["post_id"] == f"{n:024x}"
        assert body["round_id"] is None
        assert body["max_sim"] is None
        assert body["card_sim"] == pytest.approx(0.6)
        assert body["embedding"] == [0.6, 0.8]
    assert (result.posts, result.filed, result.failed) == (2, 2, 0)
    assert result.ok is True


def test_batches_never_exceed_the_embedder_limit_and_each_carries_the_card() -> None:
    posts = [_post(n) for n in range(1, 131)]
    resources = PagedResources([posts[:100], posts[100:]])
    embedder = BatchEmbedder()

    result = _run(resources, embedder)

    assert EMBED_BATCH_MAX == 64
    assert all(len(batch) <= EMBED_BATCH_MAX for batch in embedder.batches)
    assert all(batch[0] == CARD for batch in embedder.batches)
    assert sum(len(batch) - 1 for batch in embedder.batches) == 130
    assert result.filed == 130


def test_a_dry_run_embeds_and_files_nothing_but_counts() -> None:
    resources = PagedResources([[_post(1), _post(2)]])
    embedder = BatchEmbedder()

    result = _run(resources, embedder, dry_run=True)

    assert embedder.batches == []
    assert resources.filed == []
    assert (result.posts, result.filed, result.failed) == (2, 0, 0)
    assert result.ok is True


def test_an_embedder_outage_costs_that_batch_not_the_run() -> None:
    posts = [_post(n) for n in range(1, 71)]
    resources = PagedResources([posts])

    result = _run(resources, BatchEmbedder(fail_on_call=1))

    assert result.failed == 63
    assert result.filed == 7
    assert result.ok is False


def test_a_short_embedder_answer_fails_the_batch() -> None:
    class ShortEmbedder:
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[1.0, 0.0]]

    resources = PagedResources([[_post(1), _post(2)]])

    result = _run(resources, ShortEmbedder())

    assert resources.filed == []
    assert (result.filed, result.failed) == (0, 2)


def test_a_rejected_ingest_is_counted_as_failed() -> None:
    resources = PagedResources([[_post(1)]], ok=False)

    result = _run(resources)

    assert (result.filed, result.failed) == (0, 1)
    assert result.ok is False


def test_a_failed_read_is_reported_not_raised() -> None:
    resources = PagedResources([[_post(1)]])
    resources.fail_list = True

    result = _run(resources)

    assert result.ok is False
    assert result.reason == "could not list posts"
    assert resources.filed == []


def test_an_account_with_no_era_posts_is_ok_and_embeds_nothing() -> None:
    resources = PagedResources([[]])
    embedder = BatchEmbedder()

    result = _run(resources, embedder)

    assert embedder.batches == []
    assert (result.posts, result.filed, result.failed, result.ok) == (0, 0, 0, True)


def test_an_empty_card_files_vectors_without_a_card_sim() -> None:
    resources = PagedResources([[_post(1)]])
    embedder = BatchEmbedder()

    _run(resources, embedder, card="")

    assert embedder.batches == [["post 1"]]
    assert resources.filed[0][1]["card_sim"] is None


def test_a_real_run_needs_an_embedder_but_a_dry_run_does_not() -> None:
    resources = PagedResources([[_post(1)]])
    with pytest.raises(ValueError, match="embedder"):
        run_backfill_post_vectors(
            resources,  # type: ignore[arg-type]
            username="xiaoman",
            card=CARD,
            embedder=None,
            era_start=ERA_START,
        )

    result = run_backfill_post_vectors(
        resources,  # type: ignore[arg-type]
        username="xiaoman",
        card=CARD,
        embedder=None,
        era_start=ERA_START,
        dry_run=True,
    )
    assert (result.ok, result.posts) == (True, 1)


def test_a_post_without_a_created_at_cannot_be_shown_to_be_in_the_era() -> None:
    resources = PagedResources([[_post(1), {"id": "y" * 24, "text": "无日期"}]])

    posts = list_era_posts(resources, "xiaoman", era_start=ERA_START)  # type: ignore[arg-type]

    assert [p.post_id for p in posts] == [f"{1:024x}"]


def test_a_ragged_embedder_answer_fails_the_batch() -> None:
    class RaggedEmbedder:
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[1.0, 0.0], [0.6]]

    resources = PagedResources([[_post(1)]])

    result = _run(resources, RaggedEmbedder())

    assert resources.filed == []
    assert (result.filed, result.failed) == (0, 1)


# ── I1: an echo is not a post ────────────────────────────────────────────


def test_an_echo_is_never_listed_whichever_key_spelling_carries_it() -> None:
    resources = PagedResources(
        [
            [
                _post(1),
                _post(2, echoOf={"id": "o" * 24, "text": "原帖"}),
                _post(3, echo_of="o" * 24),
                _post(4, echoOf=None),
            ]
        ]
    )

    posts = list_era_posts(resources, "xiaoman", era_start=ERA_START)  # type: ignore[arg-type]

    assert [p.post_id for p in posts] == [f"{1:024x}", f"{4:024x}"]


def test_an_echo_the_dto_did_not_mark_is_skipped_on_the_servers_refusal() -> None:
    """The DTO omits `echoOf` when the original is not viewable, so the
    server's ECHO refusal is the backstop -- skipped, not a failure."""
    resources = PagedResources([[_post(1), _post(2)]], outcomes=[VectorFiling("echo")])

    result = _run(resources)

    assert [body["post_id"] for _, body in resources.filed] == [f"{2:024x}"]
    assert (result.filed, result.failed, result.skipped, result.ok) == (1, 0, 1, True)


# ── I2: the backfill stays under the shared 20/min ingest bucket ─────────


def test_the_backfill_never_files_more_than_18_a_minute() -> None:
    clock = FakeClock()
    posts = [_post(n) for n in range(1, 41)]
    resources = PagedResources([posts], clock=clock)

    result = _run(resources, clock=clock)

    assert INGESTS_PER_MINUTE == 18
    assert result.filed == 40
    times = resources.attempt_times
    assert len(times) == 40
    for i in range(len(times) - INGESTS_PER_MINUTE):
        assert times[i + INGESTS_PER_MINUTE] - times[i] >= 60.0
    # The first 18 go at once; it only waits when a window is full.
    assert times[:INGESTS_PER_MINUTE] == [0.0] * INGESTS_PER_MINUTE
    assert clock.sleeps and all(s > 0 for s in clock.sleeps)


def test_a_short_backfill_never_sleeps() -> None:
    clock = FakeClock()
    resources = PagedResources([[_post(n) for n in range(1, 6)]], clock=clock)

    _run(resources, clock=clock)

    assert clock.sleeps == []


def test_a_429_sleeps_per_retry_after_and_retries_the_same_post() -> None:
    clock = FakeClock()
    resources = PagedResources(
        [[_post(1), _post(2)]],
        outcomes=[VectorFiling("rate_limited", retry_after=7.0)],
        clock=clock,
    )

    result = _run(resources, clock=clock)

    assert clock.sleeps == [7.0]
    assert [body["post_id"] for _, body in resources.filed] == [f"{1:024x}", f"{2:024x}"]
    assert (result.filed, result.failed, result.ok) == (2, 0, True)


def test_a_429_without_a_reset_header_waits_the_fallback() -> None:
    clock = FakeClock()
    resources = PagedResources([[_post(1)]], outcomes=[VectorFiling("rate_limited")], clock=clock)

    result = _run(resources, clock=clock)

    assert RATE_LIMIT_FALLBACK_SECONDS == 60.0
    assert clock.sleeps == [60.0]
    assert result.filed == 1


def test_a_post_still_rate_limited_after_3_retries_is_counted_failed() -> None:
    clock = FakeClock()
    limited = VectorFiling("rate_limited", retry_after=5.0)
    resources = PagedResources(
        [[_post(1), _post(2)]],
        outcomes=[limited] * (MAX_RATE_LIMIT_RETRIES + 1),
        clock=clock,
    )

    result = _run(resources, clock=clock)

    assert MAX_RATE_LIMIT_RETRIES == 3
    assert clock.sleeps == [5.0] * MAX_RATE_LIMIT_RETRIES
    assert len(resources.attempt_times) == MAX_RATE_LIMIT_RETRIES + 1 + 1
    assert [body["post_id"] for _, body in resources.filed] == [f"{2:024x}"]
    assert (result.filed, result.failed, result.ok) == (1, 1, False)


def test_a_retry_after_attempt_still_counts_against_the_window() -> None:
    """Every POST is one hit on the server's bucket, a 429'd one included."""
    clock = FakeClock()
    posts = [_post(n) for n in range(1, INGESTS_PER_MINUTE + 1)]
    resources = PagedResources(
        [posts], outcomes=[VectorFiling("rate_limited", retry_after=0.0)], clock=clock
    )

    _run(resources, clock=clock)

    times = resources.attempt_times
    assert len(times) == INGESTS_PER_MINUTE + 1
    assert times[INGESTS_PER_MINUTE] - times[0] >= 60.0
