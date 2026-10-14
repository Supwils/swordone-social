"""HTTP client for the local bge-m3 embedder daemon (contract 04 §1).

Every failure surfaces as EmbedderUnavailable. The FAIL-OPEN decision is the
CALLER's: `dream/gate.py` catches this and skips the drift check with a WARN,
so a dream never blocks on the embedder. This module never decides to fail open on its
own, because a silent 1.0 similarity is indistinguishable from a real one --
that conflation is what made the echo-variance bug invisible for months.
"""

from __future__ import annotations

from typing import Any

import httpx

DEFAULT_TIMEOUT = 60.0
MAX_BATCH = 64


class EmbedderUnavailable(RuntimeError):  # noqa: N818 -- mandated name, see task-2-brief.md interfaces
    """The embedder could not produce vectors for this request."""


class EmbedderClient:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"), timeout=timeout, transport=transport
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> EmbedderClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def health(self) -> dict[str, Any]:
        try:
            response = self._client.get("/health")
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise EmbedderUnavailable(f"health check failed: {exc}") from exc
        return payload if isinstance(payload, dict) else {}

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            raise ValueError("embed() needs at least one text; the server rejects an empty batch")
        if len(texts) > MAX_BATCH:
            raise ValueError(f"embed() takes at most {MAX_BATCH} texts, got {len(texts)}")
        try:
            response = self._client.post("/embed", json={"texts": texts})
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise EmbedderUnavailable(f"embed failed: {exc}") from exc
        vectors = payload.get("embeddings") if isinstance(payload, dict) else None
        if not isinstance(vectors, list) or len(vectors) != len(texts):
            raise EmbedderUnavailable(f"embedder returned no usable vectors: {payload!r}")
        out: list[list[float]] = []
        for vector in vectors:
            if not isinstance(vector, list) or not vector:
                raise EmbedderUnavailable(f"embedder returned an empty vector: {payload!r}")
            out.append([float(x) for x in vector])
        return out
