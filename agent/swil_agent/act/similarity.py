"""The act path's self-similarity sample and near-duplicate guard.

Moved out of `act/round.py` verbatim (S3 §9); `execute_step` there runs
`similarity_step` then `apply_duplicate_guard` before any write. The logger
keeps the `swil_agent.act.round` name, so these WARN lines still route to
the act log and still match every `caplog` filter written against it.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any, Final, Protocol

from swil_agent.act.memory_log import _memory_text
from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.embedder.vectors import clamped_cosine
from swil_agent.models import Action, ActSimilarity, Persona, VetoedAction
from swil_agent.persona.format import card_text

logger = logging.getLogger("swil_agent.act.round")

# ── near-duplicate guard ─────────────────────────────────────────────────
#
# Before a post executes it is embedded and compared with the account's own
# last `window` posts; at max cosine >= `threshold` the post is dropped.


class Embedder(Protocol):
    """The one method this module needs from the bge-m3 daemon. Declared here
    rather than imported from a peer package (`dream`, `analysis`)."""

    def embed(self, texts: list[str]) -> list[list[float]]: ...


DEFAULT_POST_DUPLICATE_WINDOW: Final = 12
"""How many of the account's own recent posts a candidate is compared
against. Mirrors `Settings.post_duplicate_window`; pinned equal by test."""

DEFAULT_POST_DUPLICATE_THRESHOLD: Final = 0.92
"""Max cosine similarity at which a candidate post is dropped. Mirrors
`Settings.post_duplicate_threshold`; pinned equal by test."""

MIN_COMPARISON_CORPUS: Final = 2
"""Fewer prior posts than this and `max_sim` is `None` (not computed), so a
new account is never measured against a one-post sample."""


def candidate_post_text(actions: Sequence[Action]) -> str | None:
    """The text this round would post, or `None`.

    The first `post` action only (guardrails cap a round at one); an `echo` is
    commentary on someone else's post and is not a candidate. Normalised the
    way the executor puts it on the wire, so the measured string is the one
    that would be published. Blank yields `None`: the executor would skip it.
    """
    for action in actions:
        if action.kind == "post":
            return _memory_text(action.text) or None
    return None


def prior_post_texts(items: Sequence[dict[str, Any]]) -> list[str]:
    """The account's own recent post bodies, in API order.

    `originalText`, falling back to `text` only when it is null/false (an empty
    `originalText` is kept as-is, then dropped as blank). Non-string and
    whitespace-only bodies are dropped.
    """
    texts: list[str] = []
    for item in items:
        raw: Any = item.get("originalText")
        if raw is None or raw is False:
            raw = item.get("text")
        if isinstance(raw, str) and raw.strip():
            texts.append(raw)
    return texts


def measure_act_similarity(
    *,
    candidate_text: str,
    # Shadows the imported `card_text()` helper inside this function; the
    # caller passes its already-stripped result.
    card_text: str,
    prior_texts: Sequence[str],
    embedder: Embedder,
) -> ActSimilarity:
    """How close `candidate_text` sits to the closest of `prior_texts`, and to
    the account's card.

    One embed call: `[candidate, card, *prior]`, or `[candidate, card]` when
    the corpus is below `MIN_COMPARISON_CORPUS` (S2 §4) -- the card is
    measured on every candidate, a new account's included, and the candidate
    vector is kept for the post-vector ingest. The card is never a prior: it
    enters `card_sim`, never `max_sim`. An empty card is left out of the
    batch and has no `card_sim`.

    Any embedder failure, short or mismatched batch, or unusable vector
    yields `max_sim`, `card_sim` and `vector` all `None` with
    `embedder_ok=False`. `ValueError` is caught too: `EmbedderClient.embed`
    raises it for a batch above `MAX_BATCH`.
    """
    corpus = list(prior_texts)
    compared = corpus if len(corpus) >= MIN_COMPARISON_CORPUS else []
    card = [card_text] if card_text else []
    batch = [candidate_text, *card, *compared]
    failed = ActSimilarity(max_sim=None, compared_against=len(corpus), embedder_ok=False)
    try:
        vectors = embedder.embed(batch)
    except (EmbedderUnavailable, ValueError):
        return failed

    if len(vectors) != len(batch):
        return failed
    candidate_vector, *rest = vectors
    if not candidate_vector or any(len(v) != len(candidate_vector) for v in rest):
        return failed
    card_vectors, prior_vectors = rest[: len(card)], rest[len(card) :]

    return ActSimilarity(
        max_sim=(
            max(clamped_cosine(candidate_vector, v) for v in prior_vectors)
            if prior_vectors
            else None
        ),
        compared_against=len(corpus),
        embedder_ok=True,
        card_sim=clamped_cosine(candidate_vector, card_vectors[0]) if card_vectors else None,
        vector=list(candidate_vector),
    )


_SIMILARITY_FETCH_FAILED: Final = "could not fetch prior posts"
_SIMILARITY_EMBEDDER_DOWN: Final = "embedder unreachable"
_SIMILARITY_CORPUS_TOO_SMALL: Final = f"fewer than {MIN_COMPARISON_CORPUS} prior posts"


def _similarity_event(
    sim: ActSimilarity,
    *,
    window: int,
    threshold: float,
    reason: str | None,
    round_id: str | None,
) -> LabEvent:
    """The `/lab` row for one post candidate, dropped or not.

    `cycle`/`act` moves no `/lab` counter. `action` is unset: this row is a
    measurement, the executor files the real `post` event. The measured
    summary is a contract with `server/src/modules/agents/persona/collapse.ts`,
    which selects on it, so a dropped candidate keeps it and says `dropped`
    in `metrics`. `metrics` stays flat (the ingest schema rejects nested
    values), and `maxSim` is `null`, never `0.0`, when it was not computed.

    `cardSim` (S2 §4) is `null` when not computed. `roundId` is omitted when
    the cycle has none (a resumed thread checkpointed before S2).
    """
    measured = sim.max_sim is not None
    metrics: dict[str, Any] = {
        "maxSim": sim.max_sim,
        "comparedAgainst": sim.compared_against,
        "embedderOk": sim.embedder_ok,
        "window": window,
        "threshold": threshold,
        "dropped": sim.dropped,
        "cardSim": sim.card_sim,
    }
    if round_id is not None:
        metrics["roundId"] = round_id
    return LabEvent(
        type="cycle",
        phase="act",
        outcome="success" if measured else "skip",
        summary=(
            "act self-similarity measured" if measured else "act self-similarity not computed"
        ),
        reason=reason,
        metrics=metrics,
    )


def _similarity_reason(sim: ActSimilarity) -> str | None:
    if sim.max_sim is not None:
        return None
    return _SIMILARITY_EMBEDDER_DOWN if not sim.embedder_ok else _SIMILARITY_CORPUS_TOO_SMALL


def _warn_embedder_unreachable(username: str) -> None:
    logger.warning("act-similarity: %s — embedder unreachable; skipping (fail-open)", username)


def similarity_step(
    *,
    resources: Resources,
    persona: Persona,
    actions: Sequence[Action],
    embedder: Embedder | None,
    window: int = DEFAULT_POST_DUPLICATE_WINDOW,
    threshold: float = DEFAULT_POST_DUPLICATE_THRESHOLD,
    round_id: str | None = None,
) -> ActSimilarity | None:
    """Measure this round's candidate post against the account's OWN recent
    posts and its card, decide whether it is a near-duplicate, and record one
    lab event.

    Returns `None` when there is nothing to measure (no embedder, no post).
    `dropped` is true only for a computed `max_sim >= threshold`; a failed
    fetch, a down embedder or too small a corpus fails open (`dropped`
    false). A failed fetch still embeds `[candidate, card]` (S2 §4), so the
    card similarity and the post's vector survive it. Never raises: any
    unexpected error is logged and yields `None`, which also fails open.
    """
    try:
        if embedder is None:
            return None
        candidate = candidate_post_text(actions)
        if candidate is None:
            return None
        card = card_text(persona.card)

        try:
            items = resources.user_posts(persona.username, limit=window)
        except ApiError as exc:
            logger.warning(
                "act-similarity: %s — could not fetch prior posts (%s); skipping",
                persona.username,
                exc,
            )
            sim = measure_act_similarity(
                candidate_text=candidate, card_text=card, prior_texts=[], embedder=embedder
            )
            if not sim.embedder_ok:
                _warn_embedder_unreachable(persona.username)
            resources.lab_event(
                persona.username,
                _similarity_event(
                    sim,
                    window=window,
                    threshold=threshold,
                    reason=_SIMILARITY_FETCH_FAILED,
                    round_id=round_id,
                ),
            )
            return sim

        sim = measure_act_similarity(
            candidate_text=candidate,
            card_text=card,
            prior_texts=prior_post_texts(items),
            embedder=embedder,
        )
        if not sim.embedder_ok:
            _warn_embedder_unreachable(persona.username)
        if sim.max_sim is not None and sim.max_sim >= threshold:
            sim = sim.model_copy(update={"dropped": True})
            logger.warning(
                "act-similarity: %s — post dropped as a near-duplicate (max_sim %.3f >= %s)",
                persona.username,
                sim.max_sim,
                threshold,
            )
        resources.lab_event(
            persona.username,
            _similarity_event(
                sim,
                window=window,
                threshold=threshold,
                reason=_similarity_reason(sim),
                round_id=round_id,
            ),
        )
        return sim
    except Exception as exc:
        logger.debug("act-similarity failed for %s", persona.username, exc_info=exc)
        logger.warning(
            "act-similarity: %s — sampling failed (%s: %s); the round is unaffected",
            persona.username,
            type(exc).__name__,
            exc,
        )
        return None


def duplicate_veto_reason(sim: ActSimilarity, threshold: float) -> str:
    return f"near-duplicate of a recent post (max_sim {sim.max_sim:.3f} >= {threshold})"


def apply_duplicate_guard(
    actions: Sequence[Action], sim: ActSimilarity | None, *, threshold: float
) -> tuple[list[Action], list[VetoedAction]]:
    """Remove the candidate post when `sim` says it is a near-duplicate.

    A plan left empty becomes a single `nothing`, so the round still records
    that it did nothing.
    """
    if sim is None or not sim.dropped:
        return list(actions), []
    kept = list(actions)
    index = next(i for i, action in enumerate(kept) if action.kind == "post")
    vetoed = [VetoedAction(action=kept.pop(index), reason=duplicate_veto_reason(sim, threshold))]
    if not kept:
        kept = [Action(kind="nothing")]
    return kept, vetoed
