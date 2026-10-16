"""Path segments for every `Resources` URL: validated, then percent-encoded.

A post id or a username the PLANNER wrote reaches a URL path. Interpolated
raw, `postId: "../conversations/<id>/messages?"` became a DM that skipped the
contacts guardrail (httpx collapses `..`), and a `like` became any bodiless
POST. Encoding alone is not enough -- `.` and `..` are unreserved characters
that `quote` leaves alone -- so ids and usernames are also checked against the
server's own rules before any request is built:

  * `ID_RE` -- `server/src/contract/common.ts` `ID_RE` (ObjectId hex, 24
    lowercase hex chars; `lib/id.ts` `newId`).
  * `USERNAME_RE` -- `USERNAME_RE` plus `LIMITS.usernameMin`/`usernameMax`
    (`usernameLookupSchema`, the path-param schema of `/users/:username/*`
    and `/agents/:username/*`).

The server 400s anything outside those rules, so refusing it locally changes
no request that could have succeeded. A valid id or username encodes to
itself, so every valid request's bytes are unchanged.

`InvalidPathSegmentError` is an `ApiError` (status 0, like `TransportError`:
nothing was sent), so every caller's existing `except ApiError` degrades the
same way it would for the server's 400.
"""

from __future__ import annotations

import re
from typing import Final
from urllib.parse import quote

from swil_agent.api.client import ApiError

ID_RE: Final = re.compile(r"[a-f0-9]{24}")
USERNAME_RE: Final = re.compile(r"[a-zA-Z0-9_]{3,24}")

INVALID_PATH_SEGMENT: Final = "INVALID_PATH_SEGMENT"


class InvalidPathSegmentError(ApiError):
    """A path value that fails the server's id/username rule (or is a dot
    segment). Raised before any request is built."""

    def __init__(self, what: str, value: str) -> None:
        super().__init__(status=0, body=f"invalid {what} {value!r}", code=INVALID_PATH_SEGMENT)


def is_id(value: str) -> bool:
    return ID_RE.fullmatch(value) is not None


def is_username(value: str) -> bool:
    return USERNAME_RE.fullmatch(value) is not None


def _encode(value: str) -> str:
    return quote(value, safe="")


def id_segment(value: str, what: str = "id") -> str:
    if not is_id(value):
        raise InvalidPathSegmentError(what, value)
    return _encode(value)


def username_segment(value: str) -> str:
    if not is_username(value):
        raise InvalidPathSegmentError("username", value)
    return _encode(value)


def segment(value: str, what: str = "path segment") -> str:
    """Any other segment (a board slug): percent-encoded, and never empty or
    a dot segment, which a client would resolve against the path."""
    if value in {"", ".", ".."}:
        raise InvalidPathSegmentError(what, value)
    return _encode(value)
