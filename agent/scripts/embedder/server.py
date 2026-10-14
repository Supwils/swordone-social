"""Local sentence-embedding daemon for the swil-social agent runtime.

Loads BAAI/bge-m3 (multilingual, 1024-dim, 8K context) once at startup, exposes
a single /embed endpoint. Caches by sha256(text) in a sibling SQLite file so
re-embedding the same personality.md or post text is free.

Runs on Apple Silicon (M-series) via PyTorch's MPS backend by default; falls
back to CPU on other hardware. The daemon is managed by launchd:
  ~/Library/LaunchAgents/com.swil.embedder.plist
See agent/MAINTENANCE.md for install / pause / restart commands.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import struct
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

MODEL_NAME = os.environ.get("EMBEDDER_MODEL", "BAAI/bge-m3")
DEVICE = os.environ.get("EMBEDDER_DEVICE", "auto")  # auto | mps | cpu | cuda

# Forward-pass sub-batch. bge-m3 is XLM-RoBERTa-large (24 layers / 16 heads) with
# an 8192-token window, so activation memory scales with batch × seq². The
# sentence-transformers default of 32 means one 64-text request can put 32
# max-length sequences on the GPU at once; 4 keeps the worst case bounded.
BATCH_SIZE = int(os.environ.get("EMBEDDER_BATCH_SIZE", "4"))

# 0 = keep whatever the model config declares (8192 for bge-m3).
#
# Deliberately NOT lowered by default: the drift experiment compares cosine
# similarities across snapshots recorded over months, and shortening the window
# would silently change the ruler mid-experiment — new vectors would not be
# comparable to stored ones. Truncation is instead made *visible* (see
# `truncated` in EmbedResp and the startup//health reporting) so the four
# personalities that already exceed 8192 tokens stop being silently clipped
# without anyone knowing.
MAX_SEQ_LEN = int(os.environ.get("EMBEDDER_MAX_SEQ_LEN", "0"))

HERE = Path(__file__).resolve().parent
CACHE_PATH = HERE / "cache.sqlite"

_state: dict[str, object] = {}
_cache_lock = Lock()

# Serialises the forward pass. `/embed` is a sync endpoint, so FastAPI dispatches
# it on anyio's threadpool — without this lock the N parallel cycle-one.sh
# processes of a round all call model.encode() concurrently. On 2026-08-13 five
# of them drove this daemon to 27.8 GB of unified memory (measured: 7.7 GB
# resident / 16 GB peak footprint for ONE max-length pass), pushed the machine
# into swap, and made the dream's 8 s health probe time out — which fail-opened
# the drift gate and let three dreams through unvetted. `_cache_lock` only ever
# guarded SQLite; it never covered the model.
_model_lock = Lock()


def _pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _release_device_cache(device: str) -> None:
    """Hand cached GPU blocks back to the OS after a forward pass.

    PyTorch's MPS/CUDA caching allocators keep freed blocks for reuse and never
    shrink on their own, so on Apple Silicon's unified memory the daemon's
    footprint only ever ratchets upward — it sat at 7.7 GB resident after a
    single full-personality embed. Without this the process looks like a leak.
    """
    if device not in ("mps", "cuda"):
        return
    try:
        import torch

        if device == "mps":
            torch.mps.empty_cache()
        else:
            torch.cuda.empty_cache()
    except Exception:
        # Never fail a request over cache hygiene.
        pass


def _count_tokens(model: object, text: str) -> int:
    """Token length under the model's own tokenizer, or -1 if unavailable."""
    try:
        tok = model.tokenizer  # type: ignore[attr-defined]
        return len(tok.encode(text, add_special_tokens=True, truncation=False))
    except Exception:
        return -1


def _init_cache() -> sqlite3.Connection:
    conn = sqlite3.connect(CACHE_PATH, check_same_thread=False, isolation_level=None)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS embeddings (
            sha TEXT PRIMARY KEY,
            dim INTEGER NOT NULL,
            vec BLOB NOT NULL
        )"""
    )
    return conn


def _vec_to_blob(vec: np.ndarray) -> bytes:
    # float32 little-endian, length-prefixed by `dim` column
    arr = vec.astype(np.float32, copy=False)
    return arr.tobytes()


def _blob_to_vec(blob: bytes, dim: int) -> list[float]:
    return list(struct.unpack(f"<{dim}f", blob))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Import here so `--help` and import-time tooling don't pull torch.
    from sentence_transformers import SentenceTransformer

    device = _pick_device(DEVICE)
    print(f"[embedder] loading {MODEL_NAME} on device={device}", flush=True)
    model = SentenceTransformer(MODEL_NAME, device=device)
    if MAX_SEQ_LEN > 0:
        model.max_seq_length = MAX_SEQ_LEN
    # Warm the GPU + cache one round-trip
    _ = model.encode(["warmup"], normalize_embeddings=True)
    _release_device_cache(device)
    _state["model"] = model
    _state["device"] = device
    _state["dim"] = int(model.get_sentence_embedding_dimension() or 0)
    _state["max_seq_length"] = int(getattr(model, "max_seq_length", 0) or 0)
    _state["cache"] = _init_cache()
    print(
        f"[embedder] ready · dim={_state['dim']} "
        f"max_seq_length={_state['max_seq_length']} batch_size={BATCH_SIZE}",
        flush=True,
    )
    try:
        yield
    finally:
        cache = _state.get("cache")
        if isinstance(cache, sqlite3.Connection):
            cache.close()


app = FastAPI(lifespan=lifespan, title="swil-embedder", version="0.1.0")


class EmbedReq(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=64)
    # If true, returns the same vector twice for an empty string. Most callers
    # should just filter empty strings client-side, but supplying default=False
    # lets us reject ambiguous calls instead of silently caching "".
    allow_empty: bool = False


class EmbedResp(BaseModel):
    model: str
    device: str
    dim: int
    embeddings: list[list[float]]
    cache_hits: int
    cache_misses: int
    # How many of this request's texts were longer than max_seq_length and so
    # had their tail dropped before embedding. Non-zero means the vector does
    # not represent the whole document.
    truncated: int = 0


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": _state.get("device"),
        "dim": _state.get("dim"),
        "max_seq_length": _state.get("max_seq_length"),
        "batch_size": BATCH_SIZE,
    }


@app.post("/embed", response_model=EmbedResp)
def embed(req: EmbedReq) -> EmbedResp:
    model = _state.get("model")
    cache = _state.get("cache")
    dim = int(_state.get("dim") or 0)
    if model is None or not isinstance(cache, sqlite3.Connection) or dim == 0:
        raise HTTPException(503, "embedder not initialised")

    if not req.allow_empty and any(not t.strip() for t in req.texts):
        raise HTTPException(422, "blank text in input (set allow_empty=true to override)")

    shas = [hashlib.sha256(t.encode("utf-8")).hexdigest() for t in req.texts]
    placeholders = ",".join(["?"] * len(shas))
    with _cache_lock:
        rows = cache.execute(
            f"SELECT sha, vec FROM embeddings WHERE sha IN ({placeholders})",
            shas,
        ).fetchall()
    found = {sha: blob for sha, blob in rows}

    misses_idx = [i for i, s in enumerate(shas) if s not in found]
    miss_texts = [req.texts[i] for i in misses_idx]

    # Truncation is reported for EVERY requested text, not just cache misses. A
    # cached vector was built from the same clipped input, so scoping this to
    # misses would make `truncated: 0` mean "not truncated" on one call and
    # "cached, unknown" on the next — the caller cannot tell which.
    truncated = 0
    max_seq = int(_state.get("max_seq_length") or 0)
    if max_seq:
        for t in req.texts:
            n = _count_tokens(model, t)
            if n > max_seq:
                truncated += 1
                # Loud on purpose: everything past this point is dropped from
                # the vector, so a drift score for such a document is measured
                # on a clipped persona. Four accounts already cross this line
                # and nothing said so until now.
                print(
                    f"[embedder] WARN input truncated: {n} tokens > "
                    f"max_seq_length={max_seq} ({n - max_seq} dropped)",
                    flush=True,
                )

    new_vecs: list[np.ndarray] = []
    if miss_texts:
        # One forward pass at a time — see _model_lock.
        with _model_lock:
            new_vecs_raw = model.encode(  # type: ignore[union-attr]
                miss_texts,
                batch_size=BATCH_SIZE,
                normalize_embeddings=True,
                show_progress_bar=False,
                convert_to_numpy=True,
            )
            _release_device_cache(str(_state.get("device")))
        new_vecs = [np.asarray(v, dtype=np.float32) for v in new_vecs_raw]
        with _cache_lock:
            cache.executemany(
                "INSERT OR REPLACE INTO embeddings(sha, dim, vec) VALUES (?,?,?)",
                [
                    (shas[misses_idx[i]], dim, _vec_to_blob(new_vecs[i]))
                    for i in range(len(misses_idx))
                ],
            )
            # Refresh `found` so the assembly below reads them uniformly.
            for i, vec in zip(misses_idx, new_vecs):
                found[shas[i]] = _vec_to_blob(vec)

    embeddings = [_blob_to_vec(found[sha], dim) for sha in shas]
    return EmbedResp(
        model=MODEL_NAME,
        device=str(_state.get("device")),
        dim=dim,
        embeddings=embeddings,
        cache_hits=len(req.texts) - len(misses_idx),
        cache_misses=len(misses_idx),
        truncated=truncated,
    )
