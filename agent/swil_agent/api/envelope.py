"""The response-envelope helpers every `Resources` method shares, and the
write-verification error.

Moved out of `api/resources.py` verbatim (S3 §9) so the read class and its
`api/writes.py` / `api/lab.py` mixins can all use them without a cycle;
`api/resources.py` re-exports `WriteNotVerifiedError`, the name its callers
catch.
"""

from __future__ import annotations

from typing import Any


class WriteNotVerifiedError(RuntimeError):
    """A 2xx response carried no server-assigned id, or no provable write
    state, for an operation that is supposed to have one.

    This is the class of failure a status-code check cannot detect: a parseable,
    even well-formed, JSON envelope that nonetheless proves nothing was
    created or changed.
    """


def _items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Unwrap the `{data: {items: [...]}}` envelope every list endpoint uses.

    Returns [] rather than raising on a shape mismatch: these are the READ
    endpoints that build prompt context, and the Bash contract (01 §2g-k) is
    that a bad read degrades the prompt block, never the round.
    """
    data = payload.get("data")
    if not isinstance(data, dict):
        return []
    items = data.get("items")
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def _nested_id(payload: dict[str, Any], *path: str) -> str | None:
    """Walk `path` through nested dicts and return the value only if it is a
    non-empty string. Any missing key, wrong type, or empty string along the
    way yields None rather than raising — the caller turns that into a loud
    `WriteNotVerifiedError` instead of an opaque KeyError/TypeError."""
    node: Any = payload
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node if isinstance(node, str) and node else None
