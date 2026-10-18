"""Arithmetic on the daemon's bge-m3 vectors, shared by every caller that
compares two of them (the act path's duplicate guard, the post-vector
backfill, `prompt-ab`)."""

from __future__ import annotations

from collections.abc import Sequence


def clamped_cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Dot product of two L2-normalised bge-m3 vectors, clamped to [-1, 1].

    Callers check the vectors first: a length mismatch raises `ValueError`.
    Unlike `dream/drift.py`'s `cosine_sim` this has no fail-open-to-1.0
    fallback: on the act path a HIGH value drops a post, so such a fallback
    would turn every broken embed into a veto.
    """
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return max(-1.0, min(1.0, dot))
