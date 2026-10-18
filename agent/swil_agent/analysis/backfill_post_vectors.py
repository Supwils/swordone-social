"""Post vectors for an account's Era 3 posts that have none (S2 §4).

The act path files a vector for every post it lands. This fills the gap for
posts that landed without one -- an embedder outage, a rejected ingest, posts
from before the ingest existed: list the account's own posts since
`ERA_START`, embed `[card, *texts]` in batches, and file each with
`roundId: null` (the server resolves it from the next cycle_run card),
`maxSim: null` (the duplicate guard's window is not reconstructed) and its
cosine against the card. The ingest is idempotent on `postId`, so re-running
is safe and a post the act path already filed answers 200.

An echo is not a post for fidelity (a) or convergence (c): an item carrying
a non-null `echoOf` (the DTO's spelling; `echo_of` too) is never listed, and
the server's ECHO refusal -- the DTO omits `echoOf` when the original is not
viewable -- counts the post as skipped, not failed.

Every ingest is one hit on the server's per-user `snapshotIngestLimiter`
(20/min, shared with the account's other lab writes), so the backfill keeps
itself to `INGESTS_PER_MINUTE` attempts in any 60 s, and on a 429 waits what
`Retry-After` / `RateLimit-Reset` says (`RATE_LIMIT_FALLBACK_SECONDS` when
nothing does) and retries that post up to `MAX_RATE_LIMIT_RETRIES` times --
the shared policy in `api/ingest_throttle.py`, which the bench's run ingest
uses too. One POST per post even when already filed: the idempotent replay is the only
way to learn that, and the throttle prices it in. Clock and sleep are
injected so tests never sleep.

Fail-soft per batch and per post: an embedder outage or a rejected ingest is
counted, never raised. This package must not import `act/`, `dream/` or
`graph/` (architecture test), hence the local `Embedder`; the cosine is
`embedder/vectors.py`'s, shared with the act path.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, Protocol

from swil_agent.api.client import ApiError
from swil_agent.api.ingest_throttle import (
    INGESTS_PER_MINUTE,
    MAX_RATE_LIMIT_RETRIES,
    THROTTLE_WINDOW_SECONDS,
    IngestThrottle,
    RateLimited,
    retry_rate_limited,
)
from swil_agent.api.resources import Resources, VectorFiling
from swil_agent.embedder.client import MAX_BATCH, EmbedderUnavailable
from swil_agent.embedder.vectors import clamped_cosine

logger = logging.getLogger(__name__)

PAGE_LIMIT: Final = 100
"""The own-posts route's `limit` ceiling (`feed.routes.ts`'s `pagingQuery`)."""

EMBED_BATCH_MAX: Final = MAX_BATCH
"""Texts per `/embed` call, the card included (the daemon client's limit)."""

MAX_PAGES: Final = 200
"""A runaway-cursor backstop: 20k posts is far beyond any Era 3 account."""


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


@dataclass(frozen=True)
class EraPost:
    post_id: str
    text: str


@dataclass(frozen=True)
class BackfillResult:
    """One account's backfill. `ok` is False when the read failed or any
    post was not filed; `posts` counts the era posts found; `skipped` the
    ones the server refused as echoes."""

    ok: bool
    posts: int = 0
    filed: int = 0
    failed: int = 0
    skipped: int = 0
    reason: str | None = None


def _as_utc(moment: datetime) -> datetime:
    """A naive datetime is read as UTC, the server's clock."""
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment


def _created_at(item: dict[str, Any]) -> datetime | None:
    raw = item.get("createdAt")
    if not isinstance(raw, str):
        return None
    try:
        return _as_utc(datetime.fromisoformat(raw.replace("Z", "+00:00")))
    except ValueError:
        return None


def _post_text(item: dict[str, Any]) -> str | None:
    """`originalText // text` (jq semantics, as the act path reads priors),
    `None` when blank or not a string."""
    raw: Any = item.get("originalText")
    if raw is None or raw is False:
        raw = item.get("text")
    return raw if isinstance(raw, str) and raw.strip() else None


def _is_echo(item: dict[str, Any]) -> bool:
    """An echo re-shares another post; the DTO carries the original as
    `echoOf` (only when it is viewable -- the ingest refuses the rest)."""
    return item.get("echoOf") is not None or item.get("echo_of") is not None


def list_era_posts(resources: Resources, username: str, *, era_start: datetime) -> list[EraPost]:
    """Every own post (echoes excluded) created at or after `era_start`,
    paging until the route's `nextCursor` runs out (or repeats). The server
    filters on `since`; items are filtered again client-side, as every Era 3
    read is."""
    start = _as_utc(era_start)
    since = start.isoformat()
    posts: list[EraPost] = []
    seen: set[str] = set()
    cursor: str | None = None
    for _ in range(MAX_PAGES):
        items, cursor = resources.user_posts_page(
            username, limit=PAGE_LIMIT, since=since, cursor=cursor
        )
        for item in items:
            if _is_echo(item):
                continue
            post_id = item.get("id")
            text = _post_text(item)
            created = _created_at(item)
            if isinstance(post_id, str) and post_id and text and created and created >= start:
                posts.append(EraPost(post_id=post_id, text=text))
        if cursor is None or cursor in seen:
            break
        seen.add(cursor)
    return posts


def _embed_batch(embedder: Embedder, batch: list[str]) -> list[list[float]] | None:
    """The batch's vectors, or `None` on any outage or malformed answer."""
    try:
        vectors = embedder.embed(batch)
    except (EmbedderUnavailable, ValueError):
        return None
    if len(vectors) != len(batch) or not vectors[0]:
        return None
    if any(len(v) != len(vectors[0]) for v in vectors):
        return None
    return vectors


def run_backfill_post_vectors(
    resources: Resources,
    *,
    username: str,
    card: str,
    embedder: Embedder | None,
    era_start: datetime,
    dry_run: bool = False,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> BackfillResult:
    """List, embed and file one account's era posts. Never raises on a read,
    embed or ingest failure. `card` is `card_text(persona.card)`; an empty
    card is left out of every batch and files `cardSim: null`. `embedder`
    may be `None` only on a dry run, which embeds nothing. `clock` (monotonic
    seconds) and `sleep` drive the ingest throttle and the 429 waits."""
    if embedder is None and not dry_run:
        raise ValueError("an embedder is required unless dry_run")
    try:
        posts = list_era_posts(resources, username, era_start=era_start)
    except ApiError as exc:
        logger.warning("backfill-post-vectors: %s — could not list posts (%s)", username, exc)
        return BackfillResult(ok=False, reason="could not list posts")
    if embedder is None or dry_run or not posts:
        return BackfillResult(ok=True, posts=len(posts))

    throttle = IngestThrottle(
        limit=INGESTS_PER_MINUTE, window=THROTTLE_WINDOW_SECONDS, clock=clock, sleep=sleep
    )
    head = [card] if card else []
    size = EMBED_BATCH_MAX - len(head)
    filed = failed = skipped = 0
    for offset in range(0, len(posts), size):
        chunk = posts[offset : offset + size]
        vectors = _embed_batch(embedder, [*head, *(post.text for post in chunk)])
        if vectors is None:
            logger.warning(
                "backfill-post-vectors: %s — embedder failed for %d posts", username, len(chunk)
            )
            failed += len(chunk)
            continue
        card_vector = vectors[0] if head else None
        for post, vector in zip(chunk, vectors[len(head) :], strict=True):
            outcome = _file_with_retries(
                resources,
                throttle,
                sleep,
                username=username,
                post_id=post.post_id,
                embedding=vector,
                card_sim=clamped_cosine(vector, card_vector) if card_vector is not None else None,
            )
            if outcome == "filed":
                filed += 1
            elif outcome == "echo":
                skipped += 1
            else:
                failed += 1
    return BackfillResult(
        ok=failed == 0, posts=len(posts), filed=filed, failed=failed, skipped=skipped
    )


def _file_with_retries(
    resources: Resources,
    throttle: IngestThrottle,
    sleep: Callable[[float], None],
    *,
    username: str,
    post_id: str,
    embedding: list[float],
    card_sim: float | None,
) -> str:
    """One post's ingest: every attempt through the throttle, a 429 waited
    out and retried up to `MAX_RATE_LIMIT_RETRIES` times. Answers the final
    `VectorFiling.status` (`rate_limited` once the retries are spent)."""

    def attempt() -> VectorFiling | RateLimited:
        filing = resources.file_post_vector(
            username,
            post_id=post_id,
            round_id=None,
            embedding=embedding,
            card_sim=card_sim,
            max_sim=None,
        )
        return RateLimited(filing.retry_after) if filing.status == "rate_limited" else filing

    def on_retry(wait: float) -> None:
        logger.warning(
            "backfill-post-vectors: %s — post %s rate-limited; retrying in %.0f s",
            username,
            post_id,
            wait,
        )

    outcome = retry_rate_limited(attempt, throttle=throttle, sleep=sleep, on_retry=on_retry)
    if isinstance(outcome, RateLimited):
        logger.warning(
            "backfill-post-vectors: %s — post %s still rate-limited after %d retries",
            username,
            post_id,
            MAX_RATE_LIMIT_RETRIES,
        )
        return "rate_limited"
    return outcome.status
