"""Behavior-snapshot ingest, ported from `agent/scripts/behavior-snapshot.sh`.

The central fixture decision here is standing constraint §4, and it is the
whole reason this file is shaped the way it is: a `FakeEmbedder` that returns
its scripted vector regardless of the text it is handed cannot tell WHICH
document was embedded. That exact defect shipped once in this migration and
would have made `/lab`'s drift vector describe the version being replaced
while `contentHash` still looked right.

So `RecordingEmbedder` below does two things instead of one:

  * it records every `embed()` INPUT, and the tests assert on that input;
  * its vector is DERIVED from the input, so the `embedding` field that
    reaches the wire independently proves which text produced it.

Either assertion alone kills "embed the personality instead of the posts";
having both means a port that embeds the right text but ships a stale vector
also dies.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from swil_agent.analysis.behavior_snapshot import (
    DEFAULT_POST_LIMIT,
    EXCERPT_MAX_CHARS,
    POST_SEPARATOR,
    BehaviorSnapshotResult,
    build_behavior_payload,
    count_posts,
    run_behavior_snapshot,
    select_post_texts,
)
from swil_agent.api.auth import ApiKeyAuth
from swil_agent.api.client import ApiClient
from swil_agent.api.resources import Resources
from swil_agent.embedder.client import EmbedderUnavailable

# Deliberately NOT "now", and not any value the module could reach for on its
# own -- constraint §4's `CAPTURED_AT == NOW` trap. A port that called
# `datetime.now(UTC)` instead of using this argument would format a 2026 date
# where every assertion below expects 2019.
FROZEN = datetime(2019, 3, 4, 5, 6, 7, tzinfo=UTC)
FROZEN_WIRE = "2019-03-04T05:06:07Z"


class RecordingEmbedder:
    """Records inputs; returns a vector that encodes its own input.

    `[float(len(text)), <hash-derived>]` means two different documents can
    never produce the same vector, so the payload's `embedding` field is by
    itself evidence of which text was embedded.
    """

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [self.vector_for(t) for t in texts]

    @staticmethod
    def vector_for(text: str) -> list[float]:
        digest = hashlib.sha256(text.encode()).digest()
        return [float(len(text)), float(digest[0]), float(digest[1])]


class DeadEmbedder:
    """Every call raises, the way `EmbedderClient` does when the daemon is
    down (`embedder/client.py`)."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        raise EmbedderUnavailable("connection refused")


class EmptyVectorEmbedder:
    """Answers, but with nothing usable -- the `.embeddings[0] | length > 0`
    branch of behavior-snapshot.sh:85, which is a SEPARATE failure from an
    unreachable daemon and is the one an arbitrary `Embedder` can produce
    without raising."""

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[] for _ in texts]


# ── select_post_texts: jq `//` is not Python `or` ─────────────────────────


def test_original_text_is_preferred_over_the_rendered_text() -> None:
    """The script's own stated reason (:57-58): the behavior vector must
    never be polluted by the translation layer."""
    assert select_post_texts([{"originalText": "原文", "text": "translated"}]) == ["原文"]


def test_a_missing_original_text_falls_back_to_text() -> None:
    assert select_post_texts([{"text": "only"}]) == ["only"]


def test_a_null_original_text_falls_back_to_text() -> None:
    """jq's `//` fires on `null`, which is what a missing column serialises
    to."""
    assert select_post_texts([{"originalText": None, "text": "fallback"}]) == ["fallback"]


def test_an_empty_original_text_does_not_fall_back_to_text() -> None:
    """THE divergence from `rule_check.extract_posts`, and it is jq's, not
    ours: `"" // .text` yields `""` because an empty string is TRUTHY in jq.
    The blank filter then drops the item entirely.

    `rule-check.sh:59` is embedded Python (`it.get("originalText") or
    it.get("text")`) and genuinely does fall back here. The two frozen
    scripts disagree; a shared helper would have silently picked a winner --
    with `or` semantics this post would be embedded as "translated", quietly
    feeding the translation layer into the fidelity series the script's own
    comment says to keep it out of.
    """
    assert select_post_texts([{"originalText": "", "text": "translated"}]) == []


def test_a_false_original_text_falls_back_to_text() -> None:
    """jq's `//` has TWO falsy values, `null` and `false`. Dropping the
    `false` half looks harmless because the server never sends it -- but the
    predicate is what the port is claiming to reproduce, and half a
    reproduction is what nobody notices."""
    assert select_post_texts([{"originalText": False, "text": "fallback"}]) == ["fallback"]


def test_a_whitespace_only_body_is_dropped() -> None:
    assert select_post_texts([{"text": "  \n\t "}]) == []


def test_a_body_containing_whitespace_is_kept_whole() -> None:
    """`gsub("\\s";"") != ""` asks "is anything left", not "strip it"."""
    assert select_post_texts([{"text": "  a b  "}]) == ["  a b  "]


def test_both_fields_null_drops_the_item() -> None:
    assert select_post_texts([{"originalText": None, "text": None}]) == []


def test_a_non_string_body_is_dropped_rather_than_raising() -> None:
    """Bash loses the WHOLE sample to one of these (`gsub` on a number is a
    jq error, and `|| echo ''` swallows it into "no recent posts"). Dropping
    the single bad item keeps the other eleven measurable."""
    assert select_post_texts([{"text": 7}, {"text": "kept"}]) == ["kept"]


def test_order_is_the_order_the_api_returned() -> None:
    """`.data.items[]?` does not sort. The API's own recency order is the
    document order, and reversing it changes the embedded text."""
    items = [{"text": "first"}, {"text": "second"}, {"text": "third"}]
    assert select_post_texts(items) == ["first", "second", "third"]


# ── count_posts: the RAW item count ──────────────────────────────────────


def test_post_count_counts_items_not_embedded_texts() -> None:
    """`(.data.items // []) | length` (:67) counts what the API returned; the
    blank filter runs only on the TEXT side. A port reusing
    `len(select_post_texts(items))` reports 1 here."""
    items: list[dict[str, Any]] = [{"text": "a"}, {"text": "   "}, {"originalText": None}]
    assert count_posts(items) == 3
    assert len(select_post_texts(items)) == 1


def test_post_count_of_an_empty_sample_is_zero() -> None:
    assert count_posts([]) == 0


# ── build_behavior_payload ───────────────────────────────────────────────


def test_the_payload_carries_exactly_the_six_fields_the_script_sends() -> None:
    """Six, and the set matters in both directions: `snapshotType` and
    `archivePath` belong to the PERSONALITY snapshot body and must not appear
    here, while dropping any of these six changes what /lab stores."""
    payload = build_behavior_payload(
        text="hello", post_count=3, embedding=[0.5], captured_at=FROZEN
    )
    assert set(payload) == {
        "contentHash",
        "capturedAt",
        "postCount",
        "commentCount",
        "excerpt",
        "embedding",
    }


def test_the_content_hash_is_sha256_of_the_joined_text() -> None:
    payload = build_behavior_payload(text="你好", post_count=1, embedding=[1.0], captured_at=FROZEN)
    assert payload["contentHash"] == hashlib.sha256("你好".encode()).hexdigest()
    assert len(payload["contentHash"]) == 64  # the server's `.length(64)` gate


def test_captured_at_is_formatted_not_regenerated() -> None:
    payload = build_behavior_payload(text="x", post_count=1, embedding=[1.0], captured_at=FROZEN)
    assert payload["capturedAt"] == FROZEN_WIRE


def test_comment_count_is_a_hardcoded_zero() -> None:
    """Comments are never sampled. The field is sent explicitly rather than
    left to the server's schema default so the wire body matches Bash's."""
    payload = build_behavior_payload(text="x", post_count=9, embedding=[1.0], captured_at=FROZEN)
    assert payload["commentCount"] == 0
    assert payload["postCount"] == 9


def test_the_excerpt_flattens_newlines_to_spaces() -> None:
    payload = build_behavior_payload(
        text="a\nb\n\nc", post_count=1, embedding=[1.0], captured_at=FROZEN
    )
    assert payload["excerpt"] == "a b  c"


def test_the_excerpt_is_capped_at_280_characters_not_bytes() -> None:
    """`head -c 280` split a multibyte CJK character and crashed the
    downstream `jq --arg`, which is why the script decodes in python3 first
    (:91). 280 CJK characters are 840 bytes; a byte-based slice would return
    93 characters and could end mid-sequence."""
    payload = build_behavior_payload(
        text="字" * 400, post_count=1, embedding=[1.0], captured_at=FROZEN
    )
    assert payload["excerpt"] == "字" * 280
    assert EXCERPT_MAX_CHARS == 280


def test_the_excerpt_stays_inside_the_servers_own_ceiling() -> None:
    """`behaviorSnapshotIngest.excerpt` is `.max(320)`; a 321-char excerpt is
    a 400 that reads as "the ingest is broken"."""
    payload = build_behavior_payload(
        text="x" * 1000, post_count=1, embedding=[1.0], captured_at=FROZEN
    )
    assert len(str(payload["excerpt"])) <= 320


def test_the_embedding_is_copied_not_aliased() -> None:
    vector = [1.0, 2.0]
    payload = build_behavior_payload(text="x", post_count=1, embedding=vector, captured_at=FROZEN)
    vector.append(3.0)
    assert payload["embedding"] == [1.0, 2.0]


# ── run_behavior_snapshot ────────────────────────────────────────────────


def _account(tmp_path: Path, *, key: bool = True) -> Path:
    # The folder name is deliberately NOT the username: `agent/agents/<dir>`
    # and the `Username` bullet genuinely differ on live accounts, and every
    # HTTP call below is keyed on the username, never on the folder.
    directory = tmp_path / "quant-dir"
    directory.mkdir()
    (directory / "personality.md").write_text("- **Username:** quantum\n", encoding="utf-8")
    if key:
        (directory / "api_key.txt").write_text("secret-key\n", encoding="utf-8")
    return directory


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


def _posts_payload(*texts: str) -> dict[str, object]:
    return {"data": {"items": [{"originalText": t} for t in texts]}}


def _ingest_ok(fidelity: object = 0.77) -> dict[str, object]:
    return {"data": {"id": "beh-1", "fidelity": fidelity}}


def _full_run_handler(
    posts: dict[str, object], ingest: dict[str, object]
) -> object:  # pragma: no cover - trivial factory
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=posts)
        return httpx.Response(201, json=ingest)

    return handler


def test_a_full_run_embeds_the_joined_posts_and_posts_the_vector(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []
    embedder = RecordingEmbedder()

    result = run_behavior_snapshot(
        _resources(_full_run_handler(_posts_payload("alpha", "beta"), _ingest_ok()), seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=embedder,
        captured_at=FROZEN,
    )

    # THE assertion of this file: what went INTO the embedder. One call, one
    # text, the two posts joined by a blank line, in API order.
    assert embedder.calls == [["alpha\n\nbeta"]]

    assert seen[0].method == "GET"
    assert seen[0].url.path == "/api/v1/users/quantum/posts"
    assert seen[1].method == "POST"
    assert seen[1].url.path == "/api/v1/agents/quantum/behavior-snapshots"

    body = json.loads(seen[1].content)
    assert body == {
        "contentHash": hashlib.sha256(b"alpha\n\nbeta").hexdigest(),
        "capturedAt": FROZEN_WIRE,
        "postCount": 2,
        "commentCount": 0,
        "excerpt": "alpha  beta",
        # Independent of `embedder.calls`: the vector itself encodes its
        # input, so a stale or substituted vector fails here even if the
        # right text was handed to the embedder.
        "embedding": RecordingEmbedder.vector_for("alpha\n\nbeta"),
    }
    assert result == BehaviorSnapshotResult(
        ok=True, snapshot_id="beh-1", fidelity=0.77, post_count=2
    )


def test_an_empty_original_text_is_dropped_by_the_whole_behaviour_path(
    tmp_path: Path,
) -> None:
    """Spec §15.5, pinned at the CALL SITE rather than at the helper.

    `test_an_empty_original_text_does_not_fall_back_to_text` above pins
    `select_post_texts`. That is not where the mistake happens: the refactor
    §15.5 exists to prevent is swapping the CALL --
    `select_post_texts(items)` -> `rule_check.extract_posts(items)` -- inside
    `run_behavior_snapshot`, which leaves the helper untouched and every
    helper-level test green while quietly feeding TRANSLATED text into the
    behaviour vector. Reported by review as a live 1386-test survivor.

    So this drives the whole function and asserts on what reached the
    embedder and the wire: with `originalText: ""` as the only item, the
    behaviour path has NOTHING to embed. With `extract_posts` substituted it
    would embed `"translated"` and POST a snapshot.

    Its mirror is `test_an_empty_original_text_reaches_the_whole_rule_path`
    in `test_rule_check.py`: the same item, the opposite answer. Neither test
    means much alone -- the asymmetry is the property.
    """
    seen: list[httpx.Request] = []
    embedder = RecordingEmbedder()

    result = run_behavior_snapshot(
        _resources(
            _full_run_handler(
                {"data": {"items": [{"originalText": "", "text": "translated"}]}}, _ingest_ok()
            ),
            seen,
        ),
        directory=_account(tmp_path),
        username="quantum",
        embedder=embedder,
        captured_at=FROZEN,
    )

    assert embedder.calls == [], "the translation layer reached the behaviour vector"
    assert [r.method for r in seen] == ["GET"], "a snapshot was POSTed for a dropped post"
    assert result == BehaviorSnapshotResult(ok=False, reason="no recent posts")


def test_the_personality_is_never_what_gets_embedded(tmp_path: Path) -> None:
    """The required mutation, pinned from the input side. `personality.md`
    sits in the same directory and a port that read it would produce a
    perfectly well-formed snapshot describing the STATED self -- i.e. it
    would upload the other half of the fidelity pair and compute
    cosine(personality, personality) ~= 1.0 forever."""
    seen: list[httpx.Request] = []
    embedder = RecordingEmbedder()
    directory = _account(tmp_path)
    personality = (directory / "personality.md").read_text(encoding="utf-8")

    run_behavior_snapshot(
        _resources(_full_run_handler(_posts_payload("only post"), _ingest_ok()), seen),
        directory=directory,
        username="quantum",
        embedder=embedder,
        captured_at=FROZEN,
    )

    assert embedder.calls == [["only post"]]
    assert personality not in embedder.calls[0][0]


def test_the_content_hash_covers_the_whole_document_not_the_excerpt(
    tmp_path: Path,
) -> None:
    """Every other hash assertion in this file uses a document SHORTER than
    `EXCERPT_MAX_CHARS`, where `sha256(text)` and `sha256(excerpt)` are the
    same bytes -- so hashing the excerpt (or a constant) survives them all.

    The server dedupes behaviour snapshots by `contentHash`, so an excerpt-
    derived hash would collide across every round whose first 280 characters
    happen to match -- an account whose posts open the same way would stop
    producing new fidelity points and its series would flatten, which is the
    exact failure mode this whole plan exists to make impossible to
    misread.
    """
    long_post = "x" * (EXCERPT_MAX_CHARS + 120)
    assert len(long_post) > EXCERPT_MAX_CHARS
    seen: list[httpx.Request] = []

    run_behavior_snapshot(
        _resources(_full_run_handler(_posts_payload(long_post), _ingest_ok()), seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=RecordingEmbedder(),
        captured_at=FROZEN,
    )

    body = json.loads(seen[1].content)
    assert body["contentHash"] == hashlib.sha256(long_post.encode()).hexdigest()
    # ...and the two really are different values here, which is what makes
    # the assertion above discriminating rather than merely correct.
    assert body["excerpt"] == long_post[:EXCERPT_MAX_CHARS]
    assert body["contentHash"] != hashlib.sha256(body["excerpt"].encode()).hexdigest()


def test_the_injected_embedder_is_the_one_used(tmp_path: Path) -> None:
    """`run_behavior_snapshot` takes no `Settings`, so it structurally cannot
    build an `EmbedderClient` of its own -- but a future edit could add one.
    A recording double that is asked exactly once is what makes that visible
    (constraint §4's collaborator corollary)."""
    seen: list[httpx.Request] = []
    embedder = RecordingEmbedder()

    run_behavior_snapshot(
        _resources(_full_run_handler(_posts_payload("p"), _ingest_ok()), seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=embedder,
        captured_at=FROZEN,
    )
    assert len(embedder.calls) == 1


def test_the_post_fetch_uses_the_default_limit_of_twelve(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    run_behavior_snapshot(
        _resources(_full_run_handler(_posts_payload("p"), _ingest_ok()), seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=RecordingEmbedder(),
        captured_at=FROZEN,
    )
    assert seen[0].url.params["limit"] == "12"
    assert DEFAULT_POST_LIMIT == 12


def test_an_explicit_limit_reaches_the_wire(tmp_path: Path) -> None:
    """5 is neither this module's default nor `Resources.user_posts`'s own
    default, so a dropped argument shows up here rather than coinciding with
    one."""
    seen: list[httpx.Request] = []

    run_behavior_snapshot(
        _resources(_full_run_handler(_posts_payload("p"), _ingest_ok()), seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=RecordingEmbedder(),
        captured_at=FROZEN,
        limit=5,
    )
    assert seen[0].url.params["limit"] == "5"


def test_the_post_count_sent_is_the_api_item_count(tmp_path: Path) -> None:
    """Three items returned, one of them blank: `postCount` is 3 and the
    embedded document is the single usable body. The required "change the
    post count" mutation dies here in both directions."""
    seen: list[httpx.Request] = []
    embedder = RecordingEmbedder()
    posts = {"data": {"items": [{"text": "kept"}, {"text": "  "}, {"originalText": None}]}}

    result = run_behavior_snapshot(
        _resources(_full_run_handler(posts, _ingest_ok()), seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=embedder,
        captured_at=FROZEN,
    )

    assert embedder.calls == [["kept"]]
    assert json.loads(seen[1].content)["postCount"] == 3
    assert result.post_count == 3


def test_a_null_fidelity_is_reported_as_none_not_zero(tmp_path: Path) -> None:
    """`fidelity` is null until the account's first personality snapshot
    lands (`persona/drift.ts`). Coercing that to 0.0 would plot a
    brand-new account as maximally unfaithful."""
    seen: list[httpx.Request] = []

    result = run_behavior_snapshot(
        _resources(_full_run_handler(_posts_payload("p"), _ingest_ok(None)), seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=RecordingEmbedder(),
        captured_at=FROZEN,
    )
    assert result.ok is True
    assert result.fidelity is None


def test_the_success_log_line_names_id_fidelity_and_post_count(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """behavior-snapshot.sh:118. `fidelity=n/a` (not `fidelity=None`) is what
    an operator greps for."""
    seen: list[httpx.Request] = []

    with caplog.at_level(logging.INFO, logger="swil_agent.analysis.behavior_snapshot"):
        run_behavior_snapshot(
            _resources(_full_run_handler(_posts_payload("p"), _ingest_ok(None)), seen),
            directory=_account(tmp_path),
            username="quantum",
            embedder=RecordingEmbedder(),
            captured_at=FROZEN,
        )
    assert "behavior-snapshot: ok id=beh-1 fidelity=n/a posts=1" in caplog.messages


# ── the fail-soft exits, one per script branch ───────────────────────────


def test_a_missing_api_key_skips_the_account_without_any_request(tmp_path: Path) -> None:
    """behavior-snapshot.sh:51-54, exit 0. `personality.md` IS present, so a
    gate checking the wrong filename would sail past this. The embedder is
    never consulted either."""
    seen: list[httpx.Request] = []
    embedder = RecordingEmbedder()

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        raise AssertionError("no request may be made without an api key")

    result = run_behavior_snapshot(
        _resources(handler, seen),
        directory=_account(tmp_path, key=False),
        username="quantum",
        embedder=embedder,
        captured_at=FROZEN,
    )
    assert result == BehaviorSnapshotResult(ok=False, reason="no api_key.txt")
    assert seen == []
    assert embedder.calls == []


def test_an_account_with_no_recent_posts_skips(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    seen: list[httpx.Request] = []
    embedder = RecordingEmbedder()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_posts_payload())

    with caplog.at_level(logging.INFO, logger="swil_agent.analysis.behavior_snapshot"):
        result = run_behavior_snapshot(
            _resources(handler, seen),
            directory=_account(tmp_path),
            username="quantum",
            embedder=embedder,
            captured_at=FROZEN,
        )
    assert result == BehaviorSnapshotResult(ok=False, reason="no recent posts")
    assert [r.method for r in seen] == ["GET"]
    assert embedder.calls == []
    assert "behavior-snapshot: quant-dir has no recent posts — skipping" in caplog.messages


def test_a_sample_of_only_blank_posts_skips(tmp_path: Path) -> None:
    """`join` over an empty array is `""`, so the script's `-z "$TEXT"`
    branch catches this too -- even though `postCount` would have been 2."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_posts_payload("", "   "))

    result = run_behavior_snapshot(
        _resources(handler, seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=RecordingEmbedder(),
        captured_at=FROZEN,
    )
    assert result.ok is False
    assert result.reason == "no recent posts"


def test_an_unreachable_platform_is_told_apart_from_a_quiet_account(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """DIVERGENCE, deliberate and reported: `curl ... || echo ''` (:59-62)
    folds a dead platform into the SAME "no recent posts" line. Both produce
    an identical flat fidelity series on /lab, and this whole plan exists
    because a flat series reads as "fidelity collapsed" rather than "not
    sampled". The reason string and the log line separate them."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    with caplog.at_level(logging.INFO, logger="swil_agent.analysis.behavior_snapshot"):
        result = run_behavior_snapshot(
            _resources(handler, seen),
            directory=_account(tmp_path),
            username="quantum",
            embedder=RecordingEmbedder(),
            captured_at=FROZEN,
        )
    assert result == BehaviorSnapshotResult(ok=False, reason="could not fetch posts")
    assert len(seen) == 1
    assert any("could not fetch posts" in m for m in caplog.messages)


def test_a_five_hundred_on_the_post_fetch_does_not_raise(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    result = run_behavior_snapshot(
        _resources(handler, seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=RecordingEmbedder(),
        captured_at=FROZEN,
    )
    assert result.reason == "could not fetch posts"
    assert [r.method for r in seen] == ["GET"]


def test_a_dead_embedder_fails_open_without_posting(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """`jq -e '.embeddings[0] | length > 0'` failing is exit 0 (:85-88). The
    ingest must not be attempted with no vector -- the server's schema
    requires >= 64 numbers and would 400."""
    seen: list[httpx.Request] = []
    embedder = DeadEmbedder()

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET", "no ingest may follow a failed embed"
        return httpx.Response(200, json=_posts_payload("p"))

    with caplog.at_level(logging.WARNING, logger="swil_agent.analysis.behavior_snapshot"):
        result = run_behavior_snapshot(
            _resources(handler, seen),
            directory=_account(tmp_path),
            username="quantum",
            embedder=embedder,
            captured_at=FROZEN,
        )
    assert result == BehaviorSnapshotResult(ok=False, reason="embedder unreachable", post_count=1)
    assert embedder.calls == [["p"]]
    assert [r.method for r in seen] == ["GET"]
    assert (
        "behavior-snapshot: embedder unreachable/invalid — skipping (fail-open)" in caplog.messages
    )


def test_an_empty_vector_is_treated_as_an_embedder_failure(tmp_path: Path) -> None:
    """The `length > 0` half of the same check, reachable without an
    exception: this module verifies the vector itself rather than trusting
    whichever `Embedder` it was handed."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        return httpx.Response(200, json=_posts_payload("p"))

    result = run_behavior_snapshot(
        _resources(handler, seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=EmptyVectorEmbedder(),
        captured_at=FROZEN,
    )
    assert result.reason == "embedder unreachable"
    assert [r.method for r in seen] == ["GET"]


def test_a_server_rejection_is_reported_not_raised(tmp_path: Path) -> None:
    """`server rejected — $RESP` is still exit 0 (:120-121)."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=_posts_payload("p"))
        return httpx.Response(503, text="ingest down")

    result = run_behavior_snapshot(
        _resources(handler, seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=RecordingEmbedder(),
        captured_at=FROZEN,
    )
    assert result.ok is False
    assert result.reason is not None
    assert "503" in result.reason
    assert result.post_count == 1


def test_a_two_hundred_with_no_id_is_a_rejection_not_a_success(tmp_path: Path) -> None:
    """The `jq -e '.data.id'` branch: a well-formed envelope that proves
    nothing was stored. This is the class `WriteNotVerifiedError` exists for,
    and it must arrive as a reason, never as a raised exception."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=_posts_payload("p"))
        return httpx.Response(201, json={"data": {}})

    result = run_behavior_snapshot(
        _resources(handler, seen),
        directory=_account(tmp_path),
        username="quantum",
        embedder=RecordingEmbedder(),
        captured_at=FROZEN,
    )
    assert result.ok is False
    assert result.snapshot_id is None
    assert "behavior snapshot rejected" in str(result.reason)


def test_the_separator_constant_is_a_blank_line() -> None:
    """Pinned as a value: `join("\\n\\n")` (:66). Joining with a single
    newline changes every `contentHash` at cutover, which the server dedupes
    on -- the whole roster would re-ingest once and then look normal, with
    the discontinuity invisible."""
    assert POST_SEPARATOR == "\n\n"
