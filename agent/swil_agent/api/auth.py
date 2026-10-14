"""Credential strategies.

Two coexist today and both are required:
  * PasswordAuth — session cookie from SWIL_PASS; used for act writes.
  * ApiKeyAuth   — Bearer from <dir>/api_key.txt; used for lab events,
                   snapshots, notifications, and the analysis scripts.

Owner-created agents (BYOA, shipped) have NO password at all, so ApiKeyAuth is
the forward-looking primary.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from swil_agent.api.client import ApiClient


class AuthStrategy(Protocol):
    def headers(self) -> dict[str, str]: ...
    def cookies(self) -> dict[str, str]: ...


class ApiKeyAuth:
    """Bearer-token auth, backed by a persisted ``api_key.txt``.

    The key is validated non-empty at construction — not only in
    ``from_file`` — so a blank or whitespace-only key file fails loudly here
    with a clear message, rather than silently sending
    ``Authorization: Bearer `` and surfacing later as an unexplained 401 far
    from the real cause (the classic 3am debugging trap).
    """

    def __init__(self, key: str) -> None:
        stripped = key.strip()
        if not stripped:
            raise ValueError("api key must not be empty")
        self._key = stripped

    @classmethod
    def from_file(cls, path: Path) -> ApiKeyAuth:
        if not path.is_file():
            raise FileNotFoundError(f"api key file not found: {path}")
        return cls(path.read_text(encoding="utf-8"))

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._key}"}

    def cookies(self) -> dict[str, str]:
        return {}


class PasswordAuth:
    """Logs in once and holds the session cookie for the rest of the run.

    KNOWN STALENESS, not a bug to fix here: `self._session_id` — and
    therefore `cookies()` — is only ever written inside `login()`. Once an
    `ApiClient` has taken this value, its own httpx cookie jar becomes the
    source of truth (see `ApiClient._seed_cookie_jar`): every response's
    `Set-Cookie` updates the jar directly, bypassing this object entirely.
    The server's session middleware is `rolling: true`
    (server/src/config/session.ts), so `sid` typically rotates on every
    authenticated response — meaning `cookies()` reports the *login-time*
    value for the rest of the run, not the live one, even though the
    correct rotated cookie is what actually goes out on the wire (the jar
    wins). This is fine as long as the same `ApiClient`/`PasswordAuth` pair
    keeps living for the whole run. It stops being fine the moment anything
    persists a session across a process restart: whoever builds that must
    read the *client's cookie jar*, not `PasswordAuth.cookies()` — this
    method is a construction-time seed, not a live view of the session.
    """

    def __init__(self, username: str, password: str, session_id: str | None = None) -> None:
        self._username = username
        self._password = password
        self._session_id = session_id

    def headers(self) -> dict[str, str]:
        return {}

    def cookies(self) -> dict[str, str]:
        return {"sid": self._session_id} if self._session_id else {}

    def login(self, client: ApiClient) -> None:
        # Real server route: POST /api/v1/auth/login (server/src/modules/auth/
        # auth.routes.ts mounted at /api/v1/auth in server/src/app.ts), body
        # {"usernameOrEmail", "password"} — verified against
        # server/src/modules/auth/auth.schemas.ts's loginSchema, which is
        # NOT {"username", "password"}. Session cookie name is "sid",
        # verified against server/src/config/session.ts's SESSION_COOKIE_NAME.
        response = client.raw_post(
            "/auth/login",
            json={"usernameOrEmail": self._username, "password": self._password},
        )
        sid = response.cookies.get("sid")
        if not sid:
            raise RuntimeError("login succeeded but no sid cookie was returned")
        self._session_id = sid


def resolve_auth(directory: Path, *, username: str, password: str | None) -> AuthStrategy:
    """Pick the auth strategy for an account, Bearer or session cookie.

    Bearer wins when `api_key.txt` is usable; the session cookie is the
    fallback (contract 02 §2.9). Both exception types from
    `ApiKeyAuth.from_file` are caught deliberately — see the design spec
    §15.1 row 3: a present-but-blank key file raises ValueError, not
    FileNotFoundError, and catching only the latter turns a recoverable
    fallback into a crash.
    """
    try:
        return ApiKeyAuth.from_file(directory / "api_key.txt")
    except (FileNotFoundError, ValueError):
        pass
    if password is None:
        raise ValueError(f"no api_key.txt in {directory} and no SWIL_PASS to fall back on")
    return PasswordAuth(username=username, password=password)
