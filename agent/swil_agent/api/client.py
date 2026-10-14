"""HTTP transport for the Swil API.

Properties that are the point of this module:
  * Error bodies are preserved on ApiError, so a "HTTP 400: Invalid id"
    validation error is visible in the logs instead of a write that looks
    successful but never happened.
  * Non-2xx raises; it never silently returns a body that could be mistaken
    for success. A 2xx response with an unparseable or non-object body also
    raises, for the same reason: better a loud ApiError than a caller trying
    to index into `None` or a list.
  * A raw httpx exception is never allowed to escape `_send` either — a
    connection failure or timeout is wrapped into `TransportError`, an
    `ApiError` subclass, matching the contract `api/images.py` already
    documents for itself. Retries are deliberately NOT implemented here:
    spec §5.4 assigns retry policy to LangGraph's per-node `RetryPolicy` in
    Plan 2, and a retry loop at this layer too would double up.
"""

from __future__ import annotations

import json
from http.cookiejar import eff_request_host  # type: ignore[attr-defined]
from types import TracebackType
from typing import Any
from urllib.request import Request as UrllibRequest

import httpx

from swil_agent.api.auth import AuthStrategy

DEFAULT_TIMEOUT = 30.0
API_PREFIX = "/api/v1"


def _effective_cookie_domain(url: httpx.URL) -> str:
    """The domain key httpx's own Set-Cookie auto-capture will use for `url`.

    httpx feeds a response's `Set-Cookie` headers through `http.cookiejar`:
    `Cookies.extract_cookies` wraps the request in a
    `urllib.request.Request`-compatible adapter and hands it to
    `CookieJar.extract_cookies`, which resolves a host-only cookie's storage
    domain via `http.cookiejar.eff_request_host`. Calling that exact stdlib
    function here — rather than reimplementing RFC 2965's domain rule by
    hand — keeps this in lockstep with whatever CPython's cookiejar actually
    does, including host classes (IPv4 literals, in particular) it already
    special-cases.

    The rule this makes visible: cookiejar treats a bare hostname with no
    dot (`localhost`, any bare intranet name) as needing a synthetic
    `.local` suffix, so it isn't accidentally domain-matched as a TLD-less
    name; a dotted hostname or an IPv4 literal (which always contains dots)
    is used as-is. `agent/.env.example` ships `SWIL_URL=http://localhost:8899`
    as the project's own documented local-dev default, so getting the
    dotless case right is not an edge case here.
    """
    request = UrllibRequest(str(url))
    _, effective_host = eff_request_host(request)
    # eff_request_host isn't in typeshed's http.cookiejar stub (hence the
    # import-level ignore above), so mypy sees its result as `Any`; coerce
    # explicitly rather than silencing a second warning with another ignore.
    return str(effective_host)


class ApiError(RuntimeError):
    """A non-2xx response, or a 2xx response with an unusable body.

    `status`, `body`, and `code` are always populated so a caller (or a log
    line) can show exactly what the server said — the detail a bare
    status code would lose.
    """

    def __init__(self, status: int, body: str, code: str | None) -> None:
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body
        self.code = code


class TransportError(ApiError):
    """A request that never got an HTTP response at all — DNS failure,
    refused connection, timeout, or any other `httpx.HTTPError` raised
    below the HTTP layer.

    Subclasses `ApiError` so existing `except ApiError` handlers (including
    the contract `api/images.py` documents for itself: "a raw httpx
    exception is never allowed to escape this module") keep working
    unchanged without needing to know about this type specifically.
    `status=0` is a value no real HTTP response can ever produce, so a
    caller inspecting `.status` can tell "never reached the server" apart
    from a genuine 4xx/5xx. Always raised with `raise TransportError(exc)
    from exc`, so `__cause__` carries the original httpx exception.
    """

    def __init__(self, exc: httpx.HTTPError) -> None:
        super().__init__(status=0, body=str(exc), code=None)


def _error_code(body: str) -> str | None:
    """Best-effort extraction of `{"error": {"code": "..."}}` from a body.

    Returns None for non-JSON bodies, JSON that isn't an object, or JSON
    objects without a recognizable `error.code` string — never raises.
    """
    try:
        parsed: Any = json.loads(body)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        error = parsed.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            if isinstance(code, str):
                return code
    return None


class ApiClient:
    """Thin httpx wrapper: applies AuthStrategy, prefixes /api/v1, raises ApiError."""

    def __init__(
        self,
        base_url: str,
        auth: AuthStrategy,
        transport: httpx.BaseTransport | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._auth = auth
        self._client = httpx.Client(
            base_url=base_url.rstrip("/") + API_PREFIX,
            transport=transport,
            timeout=timeout,
            follow_redirects=True,
        )
        self._seed_cookie_jar()

    def _seed_cookie_jar(self) -> None:
        """Seed `auth.cookies()` into the client's own jar, once, at construction.

        This exists for exactly one flow: `PasswordAuth` restored from a
        prior run via a caller-supplied `session_id`, which has no
        `Set-Cookie` response for httpx to auto-capture. Fresh logins need
        no seed at all — `auth.cookies()` is `{}` until `login()` runs, and
        from that point on httpx.Client already extracts every response's
        `Set-Cookie` into this same jar, which is the entire reason to use
        one long-lived `Client` per session.

        After this one-time seed, `_send()` never touches cookies again.
        An earlier version instead compared `auth.cookies()` against the jar
        on *every* request and rewrote the jar on any mismatch. That was
        wrong in both directions once the session middleware started
        rotating `sid` on every response (`rolling: true`,
        server/src/config/session.ts): the jar had the live value, the
        comparison found it "different" from the stale snapshot in `auth`,
        and wrote the stale value back — producing a duplicate `sid` cookie
        that on the *next* comparison made `httpx.Cookies.get()` raise
        `CookieConflict`, crashing every request from then on. The jar is
        the only thing that stays current post-login; nothing should ever
        write over it again.

        Seeding with an explicit domain (rather than the domain-less default
        `Cookies.set()` would otherwise use, which matches *any* host and
        reintroduces the duplicate the moment httpx auto-captures a real,
        host-qualified `Set-Cookie`) matters, and it has to be the *correct*
        domain: an even earlier version used the literal hostname
        (`self._client.base_url.host`), which is wrong for any dotless host
        — `http://localhost:8899` in particular, this project's own
        documented local-dev default — because `http.cookiejar` stores
        `Set-Cookie` from a dotless host under a synthetic `<host>.local`
        key, not the bare host. A seed seeking `domain="localhost"` and a
        real capture landing at `domain="localhost.local"` never collide,
        so the seeded cookie silently never matches an outgoing request and
        is never sent again — exactly the invisible-failure class this
        module exists to eliminate. `_effective_cookie_domain()` replicates
        cookiejar's own normalization so the seeded jar key is identical to
        the one a same-host `Set-Cookie` will use, so a later rotation
        *replaces* this entry in place instead of adding a second one next
        to it, for dotted hosts, IPv4 literals, and dotless hosts alike.
        """
        domain = _effective_cookie_domain(self._client.base_url)
        for name, value in self._auth.cookies().items():
            self._client.cookies.set(name, value, domain=domain)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> ApiClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def _send(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        data: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        merged_headers = {**self._auth.headers(), **(headers or {})}
        # No cookie bookkeeping here on purpose — see _seed_cookie_jar's
        # docstring. Cookies are seeded once at construction; from then on
        # the jar (populated by our one-time seed, and by httpx's own
        # Set-Cookie auto-capture on every response since) is authoritative
        # and untouched by this method.
        try:
            response = self._client.request(
                method,
                path,
                json=json,
                params=params,
                files=files,
                data=data,
                headers=merged_headers,
            )
        except httpx.HTTPError as exc:
            # Connection failures, timeouts, etc. — no HTTP response exists
            # to inspect a status code from. Never let this raw httpx
            # exception escape; wrap it so every caller can keep catching
            # just ApiError. No retry here on purpose — see the module
            # docstring.
            raise TransportError(exc) from exc
        if response.status_code >= 400:
            body = response.text
            raise ApiError(response.status_code, body, _error_code(body))
        return response

    @staticmethod
    def _payload(response: httpx.Response) -> dict[str, Any]:
        try:
            parsed: Any = response.json()
        except ValueError as exc:
            # Includes json.JSONDecodeError, a ValueError subclass raised by
            # httpx.Response.json() on an unparseable body.
            raise ApiError(response.status_code, response.text, None) from exc
        if not isinstance(parsed, dict):
            raise ApiError(response.status_code, response.text, None)
        return parsed

    def raw_post(
        self,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """POST returning the raw response — needed for Set-Cookie on login."""
        return self._send("POST", path, json=json, headers=headers)

    def get(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        return self._payload(self._send("GET", path, params=params, headers=headers))

    def patch(
        self,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        return self._payload(self._send("PATCH", path, json=json, headers=headers))

    def post(
        self,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        return self._payload(self._send("POST", path, json=json, headers=headers))

    def post_multipart(
        self,
        path: str,
        files: dict[str, Any],
        data: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        return self._payload(self._send("POST", path, files=files, data=data or {}))
