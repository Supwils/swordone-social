"""What an account actually posts, embedded and shipped to `/lab`.

It embeds the account's RECENT POSTS and
POSTs the vector; the SERVER computes persona fidelity =
cosine(personality, behavior) against the newest `personalitysnapshots` row
(`server/src/modules/agents/persona/drift.ts`). Nothing here computes
a similarity.

This is the "revealed self" half of `/lab`'s fidelity pair -- the dream's
`snapshot_step` (`dream/round.py`) supplies the "stated self". The two are
DIFFERENT endpoints with DIFFERENT bodies and must not be derived from one
another:

  * `/agents/{u}/snapshots`           <- personality.md, 6 fields including
                                        `snapshotType` and `archivePath`
  * `/agents/{u}/behavior-snapshots`  <- recent posts, 6 DIFFERENT fields
                                        including `postCount`/`commentCount`
                                        and neither of those two

Fail-soft is a hard requirement, not a quality bar: the cycle calls this
after every act phase and a failure must not change the round. No
`api_key.txt`, no posts, a dead platform, a dead embedder and a server
rejection all return cleanly. This function takes `directory` and `username`
already resolved, so a missing account is its caller's problem.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any, Final, Protocol

from pydantic import BaseModel, ConfigDict

from swil_agent.api.client import ApiError
from swil_agent.api.dto import EXCERPT_MAX_UNITS, cap_utf16
from swil_agent.api.resources import Resources, WriteNotVerifiedError
from swil_agent.embedder.client import EmbedderUnavailable

logger = logging.getLogger(__name__)

# Default sample size. A
# parameter with this default, rather than this module reaching into
# `os.environ` behind its caller's back; callers pass `limit=` from Settings.
DEFAULT_POST_LIMIT: Final = 12

# `[:280]`, applied to CODEPOINTS, so a multibyte CJK character is never split.
# The server's own ceiling is 320 (`behaviorSnapshotIngest.excerpt`,
# persona/persona.schemas.ts), so 280 leaves headroom rather than sitting on it.
EXCERPT_MAX_CHARS: Final = 280

# ONE document, blank-line
# separated, embedded as a single text. Not one vector per post: fidelity is
# a claim about the account's whole recent voice.
POST_SEPARATOR: Final = "\n\n"

API_KEY_FILENAME: Final = "api_key.txt"


class Embedder(Protocol):
    """The one method this module needs from the bge-m3 daemon.

    Declared HERE rather than imported from `dream/round.py` to keep the
    dependency direction in spec §5.2 (`graph -> act, dream, analysis ->
    api, llm, persona, embedder`): `analysis` and `dream` are PEERS, so
    importing one from the other would be the first sideways edge in that
    graph. Protocols are structural, so `EmbedderClient` and every existing
    test double satisfy both declarations without knowing either exists.
    """

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class BehaviorSnapshotResult(BaseModel):
    """What one `run_behavior_snapshot` call did.

    `ok` is true only when the server actually stored a snapshot. Every
    other terminal state carries a distinct `reason` -- the script prints a
    different line for each and they mean genuinely different things to
    whoever reads `/lab` afterwards (an account that posted nothing this
    week vs. an embedder that was down all week produce the SAME flat
    fidelity series, and `reason` is the only thing that tells them apart
    after the fact).

    `post_count` is the value SENT as `postCount`, which is the count of
    items the API returned, NOT the number of texts that survived the blank
    filter -- see `count_posts`.
    """

    model_config = ConfigDict(frozen=True)

    ok: bool
    reason: str | None = None
    snapshot_id: str | None = None
    fidelity: float | None = None
    post_count: int = 0


def select_post_texts(items: Iterable[dict[str, Any]]) -> list[str]:
    """The bodies to embed, in the order the API returned them.

    `originalText`, falling back to `text` -- the ORIGINAL-language text, so
    the behavior vector is never polluted by the translation layer.

    Reproduces jq's `//`, which is NOT Python's `or`, and the difference is
    observable: jq falls back only when the left side is `null` or `false`,
    and an EMPTY STRING is truthy in jq. So an item with
    `originalText: ""` and `text: "hello"` yields `""` here -- which the
    blank filter then drops entirely -- where `originalText or text` would
    have embedded `"hello"`.

    The blank filter is `(. | gsub("\\s";"")) != ""` -- removing every
    whitespace character and comparing to empty, which is true exactly when
    the string is not all-whitespace, i.e. `raw.strip() != ""`.

    A non-string body is dropped rather than raising. Bash would abort the
    whole jq pipeline on one (`gsub` on a number is an error), losing the
    entire sample to `|| echo ''`; dropping the one bad item keeps the other
    eleven measurable, and this module may never turn a surprising payload
    into a round failure.
    """
    texts: list[str] = []
    for item in items:
        raw: Any = item.get("originalText")
        if raw is None or raw is False:
            raw = item.get("text")
        if isinstance(raw, str) and raw.strip():
            texts.append(raw)
    return texts


def count_posts(items: Iterable[dict[str, Any]]) -> int:
    """The number of returned items.

    The RAW item count, deliberately not `len(select_post_texts(items))`:
    the two differ whenever a returned post has an empty or whitespace-only
    body, and `postCount` is a statement about how much activity the sample
    covers, not about how many characters got embedded.
    """
    return sum(1 for _ in items)


def build_behavior_payload(
    *,
    text: str,
    post_count: int,
    embedding: list[float],
    captured_at: datetime,
) -> dict[str, Any]:
    """The POST body. Six fields, exactly.

    `commentCount` is a hardcoded 0: comments are never
    sampled, and the field exists because the server's schema
    (`behaviorSnapshotIngest`, persona/persona.schemas.ts) accepts one. Sending
    it explicitly rather than relying on the schema default keeps the wire
    body identical to Bash's.

    NOT present, and their absence is the contract: `snapshotType` and
    `archivePath`. Those belong to the personality-snapshot body
    (`dream/round.py`'s `build_snapshot_payload`); the
    server's behavior-snapshot schema has no such fields.

    `captured_at` must already be UTC-valued (production passes
    `datetime.now(UTC)`); this only formats, matching
    `date -u '+%Y-%m-%dT%H:%M:%SZ'` (:92).

    `excerpt` replaces `\\n` with a space and slices CODEPOINTS, matching
    the script's own `python3` one-liner (:91) -- which exists because the
    obvious `head -c 280` splits a multibyte CJK character mid-sequence.
    Then capped to the server's `excerpt.max(320)`, which counts UTF-16
    units: 280 code points with over 40 emoji would otherwise 400.
    """
    return {
        "contentHash": hashlib.sha256(text.encode()).hexdigest(),
        "capturedAt": captured_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "postCount": post_count,
        "commentCount": 0,
        "excerpt": cap_utf16(text.replace("\n", " ")[:EXCERPT_MAX_CHARS], EXCERPT_MAX_UNITS),
        "embedding": list(embedding),
    }


def run_behavior_snapshot(
    resources: Resources,
    *,
    directory: Path,
    username: str,
    embedder: Embedder,
    captured_at: datetime,
    limit: int = DEFAULT_POST_LIMIT,
) -> BehaviorSnapshotResult:
    """Fetch recent posts, embed them as ONE document, POST the vector.

    The embedder is INJECTED and this function is given no `Settings`, so it
    structurally cannot construct one of its own -- the failure standing
    constraint §4 records (an injected collaborator indistinguishable from a
    self-built one) is closed by the signature rather than by a test.

    `captured_at` is a parameter for the same reason `dream/round.py`'s is:
    the caller owns the clock, and a frozen value in a test is then
    distinguishable from `datetime.now(UTC)`.

    Every failure path returns a `BehaviorSnapshotResult` with `ok=False`;
    none raises. The cycle runs this after each act phase, and a
    measurement outage must never become a round failure.
    """
    name = directory.name
    if not (directory / API_KEY_FILENAME).is_file():
        # A key-less account is a no-op. Checked against the account
        # directory, not against `resources`: `resolve_auth` falls back to a
        # session cookie for a key-less account, which reaches the READ
        # endpoint but cannot authorise the ingest -- so the snapshot would
        # silently never land (CLAUDE.md, "new account needs API key").
        logger.info("behavior-snapshot: no api_key.txt for %s — skipping", name)
        return BehaviorSnapshotResult(ok=False, reason="no api_key.txt")

    try:
        items = resources.user_posts(username, limit=limit)
    except ApiError as exc:
        # `curl ... || echo ''` (:59-62) folds this into the "no recent
        # posts" message. Kept SEPARATE here on purpose: those two produce
        # an identical flat fidelity series on /lab, and "this account has
        # been quiet" vs "the platform was unreachable" is exactly the
        # distinction this plan exists to stop losing. Reported as a
        # divergence in task-2-3-report.md.
        logger.info("behavior-snapshot: %s — could not fetch posts; skipping (%s)", name, exc)
        return BehaviorSnapshotResult(ok=False, reason="could not fetch posts")

    texts = select_post_texts(items)
    if not texts:
        logger.info("behavior-snapshot: %s has no recent posts — skipping", name)
        return BehaviorSnapshotResult(ok=False, reason="no recent posts")

    text = POST_SEPARATOR.join(texts)
    post_count = count_posts(items)

    try:
        vectors = embedder.embed([text])
    except EmbedderUnavailable:
        vectors = []
    vector = vectors[0] if vectors else []
    if not vector:
        # `jq -e '.embeddings[0] | length > 0'` (:85-88), exit 0. An empty
        # vector is checked here and not left to `EmbedderClient`, because
        # the script checks it itself and any `Embedder` may be passed.
        logger.warning("behavior-snapshot: embedder unreachable/invalid — skipping (fail-open)")
        return BehaviorSnapshotResult(
            ok=False, reason="embedder unreachable", post_count=post_count
        )

    payload = build_behavior_payload(
        text=text,
        post_count=post_count,
        embedding=vector,
        captured_at=captured_at,
    )

    try:
        snapshot_id, fidelity = resources.create_behavior_snapshot(username, payload)
    except (ApiError, WriteNotVerifiedError) as exc:
        # `server rejected — $RESP` (:120-121), still exit 0.
        logger.warning("behavior-snapshot: server rejected — %s", exc)
        return BehaviorSnapshotResult(ok=False, reason=str(exc), post_count=post_count)

    logger.info(
        "behavior-snapshot: ok id=%s fidelity=%s posts=%d",
        snapshot_id,
        "n/a" if fidelity is None else fidelity,
        post_count,
    )
    return BehaviorSnapshotResult(
        ok=True,
        snapshot_id=snapshot_id,
        fidelity=fidelity,
        post_count=post_count,
    )
