import json
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from swil_agent.api.auth import ApiKeyAuth, PasswordAuth, resolve_auth
from swil_agent.api.client import ApiClient, ApiError, TransportError

# ApiError.__str__ truncates to 300 chars. Both long-body fixtures below are
# deliberately well over that, with a distinctive tail marker, so a
# regression that stored only `body[:300]` (or any other truncation) fails
# the tests that use them — a short fixture couldn't tell the two apart.
_LONG_JSON_TAIL_MARKER = "TAIL_MARKER_JSON_789"
_LONG_TEXT_TAIL_MARKER = "TAIL_MARKER_TEXT_XYZ"


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> ApiClient:
    """Shared fixture builder — mirrors test_resources.py's `_resources(handler)`."""
    return ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )


def test_api_key_auth_sets_bearer_header(tmp_path: Path) -> None:
    key_file = tmp_path / "api_key.txt"
    key_file.write_text("  sk-test-123\n", encoding="utf-8")
    auth = ApiKeyAuth.from_file(key_file)
    assert auth.headers() == {"Authorization": "Bearer sk-test-123"}
    assert auth.cookies() == {}


def test_api_key_auth_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        ApiKeyAuth.from_file(tmp_path / "nope.txt")


def test_api_key_auth_blank_key_raises_on_direct_construction() -> None:
    """Guards the construction path, not just from_file — see auth.py docstring."""
    with pytest.raises(ValueError, match="empty"):
        ApiKeyAuth("   ")


def test_api_key_auth_whitespace_only_file_raises(tmp_path: Path) -> None:
    """A key file that exists but is blank must fail loudly, not send a hollow
    `Authorization: Bearer ` header that later reads as a generic 401."""
    key_file = tmp_path / "api_key.txt"
    key_file.write_text("   \n", encoding="utf-8")
    with pytest.raises(ValueError, match="empty"):
        ApiKeyAuth.from_file(key_file)


def test_password_auth_sends_no_header_until_login() -> None:
    auth = PasswordAuth(username="tester", password="pw")
    assert auth.headers() == {}
    assert auth.cookies() == {}


def test_password_auth_stores_session_cookie_after_login() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/auth/login"
        payload = json.loads(request.content)
        # Real server schema (server/src/modules/auth/auth.schemas.ts) is
        # {usernameOrEmail, password} — NOT {username, password}.
        assert payload == {"usernameOrEmail": "tester", "password": "pw"}
        return httpx.Response(
            200,
            json={"data": {"user": {"username": "tester"}}},
            headers={"set-cookie": "sid=abc123; Path=/; HttpOnly"},
        )

    auth = PasswordAuth(username="tester", password="pw")
    client = ApiClient("https://example.test", auth, transport=httpx.MockTransport(handler))
    auth.login(client)
    assert auth.cookies() == {"sid": "abc123"}


def test_password_auth_login_raises_when_no_cookie_returned() -> None:
    """If the server ever answers 200 without setting sid, fail loudly instead
    of silently proceeding with an empty/stale cookie."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"user": {"username": "tester"}}})

    auth = PasswordAuth(username="tester", password="pw")
    client = ApiClient("https://example.test", auth, transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match="sid"):
        auth.login(client)


def test_login_cookie_is_not_duplicated_on_subsequent_requests() -> None:
    """Regression test for a real bug: httpx.Client auto-captures Set-Cookie
    from the login response into its own jar. `_send` used to *also* write
    `auth.cookies()` into that jar on every call, adding a second,
    domain-unqualified `sid` entry alongside the auto-captured one — so two
    `sid=...` pairs went out on every request after login. Asserting mere
    *presence* of "sid=abc123" in the header would pass even with the
    duplicate bug in place (Cookie: sid=abc123; sid=abc123 still contains
    that substring), so this counts occurrences instead."""
    seen_cookie_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/login":
            return httpx.Response(
                200,
                json={"data": {"user": {"username": "tester"}}},
                headers={"set-cookie": "sid=abc123; Path=/; HttpOnly"},
            )
        seen_cookie_headers.append(request.headers.get("cookie"))
        return httpx.Response(200, json={"data": {}})

    auth = PasswordAuth(username="tester", password="pw")
    client = ApiClient("https://example.test", auth, transport=httpx.MockTransport(handler))
    auth.login(client)
    client.get("/me")
    client.get("/me")

    assert len(seen_cookie_headers) == 2
    for header in seen_cookie_headers:
        assert header is not None
        assert header.count("sid=") == 1, f"expected exactly one sid cookie, got: {header!r}"
        assert header == "sid=abc123"


def test_restored_session_cookie_is_sent_exactly_once() -> None:
    """Mirror of the login-flow test above, for the flow that must keep
    working: `PasswordAuth` constructed with a caller-supplied `session_id`
    (session restored from a prior run) never calls `login()`, so there is
    no Set-Cookie response for httpx to auto-capture — the jar must be
    seeded from `auth.cookies()` instead, exactly once, not duplicated on
    every subsequent call either."""
    seen_cookie_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_cookie_headers.append(request.headers.get("cookie"))
        return httpx.Response(200, json={"data": {}})

    auth = PasswordAuth(username="tester", password="pw", session_id="restored")
    client = ApiClient("https://example.test", auth, transport=httpx.MockTransport(handler))
    client.get("/me")
    client.get("/me")

    assert len(seen_cookie_headers) == 2
    for header in seen_cookie_headers:
        assert header is not None
        assert header.count("sid=") == 1, f"expected exactly one sid cookie, got: {header!r}"
        assert header == "sid=restored"


def test_cookie_rotation_after_login_does_not_raise_or_duplicate() -> None:
    """The server's session middleware is `rolling: true`
    (server/src/config/session.ts), so `sid` rotates on nearly every
    authenticated response. A stale-snapshot comparison (an earlier version
    of the fix) reintroduced the duplicate-cookie bug on the request right
    after a rotation (writing the frozen pre-rotation value back alongside
    the live one), and then crashed with `httpx.CookieConflict` on the
    request after *that* (`Cookies.get()` raises once two same-named
    cookies exist in the jar). Neither may happen: the jar must track the
    rotation in place, and no request may ever raise from cookie
    bookkeeping."""
    seen_cookie_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/login":
            return httpx.Response(
                200,
                json={"data": {"user": {"username": "tester"}}},
                headers={"set-cookie": "sid=abc123; Path=/; HttpOnly"},
            )
        seen_cookie_headers.append(request.headers.get("cookie"))
        if len(seen_cookie_headers) == 1:
            # Simulate the rolling-session middleware re-issuing Set-Cookie
            # with a rotated value on this post-login response.
            return httpx.Response(
                200, json={"data": {}}, headers={"set-cookie": "sid=rotated; Path=/; HttpOnly"}
            )
        return httpx.Response(200, json={"data": {}})

    auth = PasswordAuth(username="tester", password="pw")
    client = ApiClient("https://example.test", auth, transport=httpx.MockTransport(handler))
    auth.login(client)

    client.get("/me")  # pre-rotation cookie goes out; this response rotates it
    client.get("/me")  # further request 1 — must see exactly one, rotated, sid
    client.get("/me")  # further request 2 — the one that used to raise CookieConflict

    assert len(seen_cookie_headers) == 3
    assert seen_cookie_headers[0] == "sid=abc123"
    for header in seen_cookie_headers[1:]:
        assert header is not None
        assert header.count("sid=") == 1, f"expected exactly one sid cookie, got: {header!r}"
        assert header == "sid=rotated"


def test_cookie_rotation_after_restore_does_not_raise_or_duplicate() -> None:
    """Mirror of the login-rotation test above for the constructor-restore
    flow: the rotated value must win over the originally seeded one, with no
    duplicate cookie and no CookieConflict on later requests."""
    seen_cookie_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_cookie_headers.append(request.headers.get("cookie"))
        if len(seen_cookie_headers) == 1:
            return httpx.Response(
                200, json={"data": {}}, headers={"set-cookie": "sid=rotated; Path=/; HttpOnly"}
            )
        return httpx.Response(200, json={"data": {}})

    auth = PasswordAuth(username="tester", password="pw", session_id="seeded")
    client = ApiClient("https://example.test", auth, transport=httpx.MockTransport(handler))

    client.get("/me")  # seeded cookie goes out; this response rotates it
    client.get("/me")  # further request 1 — must see exactly one, rotated, sid
    client.get("/me")  # further request 2 — the one that used to raise CookieConflict

    assert len(seen_cookie_headers) == 3
    assert seen_cookie_headers[0] == "sid=seeded"
    for header in seen_cookie_headers[1:]:
        assert header is not None
        assert header.count("sid=") == 1, f"expected exactly one sid cookie, got: {header!r}"
        assert header == "sid=rotated"


def test_restored_session_cookie_against_localhost_is_sent_exactly_once() -> None:
    """The regression this round exists to fix: `http.cookiejar` computes an
    "effective request host" that appends a synthetic `.local` suffix for
    any dotless hostname (RFC 2965). Seeding the jar with the literal host
    `"localhost"` (an earlier version of the fix did exactly that) lands
    under a *different* jar key than `"localhost.local"`, where a real
    request's cookie-matching actually happens — so the seeded cookie
    silently never gets sent, with no exception and no log line anywhere.
    `agent/.env.example` ships `SWIL_URL=http://localhost:8899` as this
    project's own documented local-dev default, so this is not an edge
    case."""
    seen_cookie_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_cookie_headers.append(request.headers.get("cookie"))
        return httpx.Response(200, json={"data": {}})

    auth = PasswordAuth(username="tester", password="pw", session_id="restored")
    client = ApiClient("http://localhost:8899", auth, transport=httpx.MockTransport(handler))
    client.get("/me")

    assert len(seen_cookie_headers) == 1
    header = seen_cookie_headers[0]
    assert header is not None
    assert header.count("sid=") == 1, f"expected exactly one sid cookie, got: {header!r}"
    assert header == "sid=restored"

    # A header-only assertion can't see a second jar entry that happens not
    # to match the outgoing request — inspect the jar directly too.
    sid_cookies = [c for c in client._client.cookies.jar if c.name == "sid"]
    assert len(sid_cookies) == 1, f"expected one sid cookie in the jar, got: {sid_cookies!r}"
    assert sid_cookies[0].value == "restored"
    assert sid_cookies[0].domain == "localhost.local"


def test_restored_session_cookie_against_ipv4_host_is_sent_exactly_once() -> None:
    """IPv4 literals always contain a dot, so they never hit the dotless-host
    `.local` rule — but this asserts on the jar directly too (not just the
    header), matching this round's acceptance criteria for host-class
    coverage rather than assuming "has a dot" is close enough."""
    seen_cookie_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_cookie_headers.append(request.headers.get("cookie"))
        return httpx.Response(200, json={"data": {}})

    auth = PasswordAuth(username="tester", password="pw", session_id="restored")
    client = ApiClient("http://127.0.0.1:8899", auth, transport=httpx.MockTransport(handler))
    client.get("/me")

    assert len(seen_cookie_headers) == 1
    header = seen_cookie_headers[0]
    assert header is not None
    assert header.count("sid=") == 1, f"expected exactly one sid cookie, got: {header!r}"
    assert header == "sid=restored"

    sid_cookies = [c for c in client._client.cookies.jar if c.name == "sid"]
    assert len(sid_cookies) == 1, f"expected one sid cookie in the jar, got: {sid_cookies!r}"
    assert sid_cookies[0].value == "restored"
    assert sid_cookies[0].domain == "127.0.0.1"


def test_cookie_rotation_after_restore_against_localhost_does_not_raise_or_duplicate() -> None:
    """The two requirements from this round collide exactly here: the seed
    must land under the cookiejar-normalized `.local` domain for a dotless
    host (or it's silently orphaned, per the test above), AND a later
    rotation must update that same jar entry in place (or the duplicate /
    CookieConflict bug from the previous round comes back for dotless
    hosts). This is the closing criterion for this round."""
    seen_cookie_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_cookie_headers.append(request.headers.get("cookie"))
        if len(seen_cookie_headers) == 1:
            return httpx.Response(
                200, json={"data": {}}, headers={"set-cookie": "sid=rotated; Path=/; HttpOnly"}
            )
        return httpx.Response(200, json={"data": {}})

    auth = PasswordAuth(username="tester", password="pw", session_id="seeded")
    client = ApiClient("http://localhost:8899", auth, transport=httpx.MockTransport(handler))

    client.get("/me")  # seeded cookie goes out; this response rotates it
    client.get("/me")  # further request 1 — must see exactly one, rotated, sid
    client.get("/me")  # further request 2 — the one that used to raise CookieConflict

    assert len(seen_cookie_headers) == 3
    assert seen_cookie_headers[0] == "sid=seeded"
    for header in seen_cookie_headers[1:]:
        assert header is not None
        assert header.count("sid=") == 1, f"expected exactly one sid cookie, got: {header!r}"
        assert header == "sid=rotated"

    sid_cookies = [c for c in client._client.cookies.jar if c.name == "sid"]
    assert len(sid_cookies) == 1, f"expected one sid cookie in the jar, got: {sid_cookies!r}"
    assert sid_cookies[0].value == "rotated"
    assert sid_cookies[0].domain == "localhost.local"


def test_get_returns_parsed_json() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"items": [1, 2]}})

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    assert client.get("/posts") == {"data": {"items": [1, 2]}}


def test_error_preserves_status_body_and_code() -> None:
    """Uses a body well over ApiError.__str__'s 300-char truncation point, and
    asserts exact equality (not just a substring near the head), so a
    regression that stored only `body[:300]` — plausible since `__str__`
    already truncates there — would still be caught. A short fixture
    couldn't tell "preserved in full" apart from "silently truncated"."""
    long_message = "Invalid id: " + ("x" * 340) + " " + _LONG_JSON_TAIL_MARKER
    payload_text = json.dumps({"error": {"code": "BAD_REQUEST", "message": long_message}})
    assert len(payload_text) > 300  # sanity: fixture must exceed the truncation point

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text=payload_text, headers={"content-type": "application/json"})

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    with pytest.raises(ApiError) as excinfo:
        client.post("/posts", json={"text": "x"})
    err = excinfo.value
    assert err.status == 400
    assert err.code == "BAD_REQUEST"
    assert err.body == payload_text
    assert _LONG_JSON_TAIL_MARKER in err.body


def test_auth_headers_are_applied_to_requests() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json={"data": {}})

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    client.get("/me")
    assert seen["authorization"] == "Bearer k"


def test_base_url_is_prefixed_with_api_v1() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {}})

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    client.get("/posts")
    assert seen == ["https://example.test/api/v1/posts"]


def test_non_json_error_body_is_still_captured() -> None:
    """Same truncation concern as the JSON case above, for a non-JSON body."""
    long_body = "<html>bad gateway " + ("z" * 320) + " " + _LONG_TEXT_TAIL_MARKER + "</html>"
    assert len(long_body) > 300  # sanity: fixture must exceed the truncation point

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text=long_body)

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    with pytest.raises(ApiError) as excinfo:
        client.get("/posts")
    assert excinfo.value.status == 502
    assert excinfo.value.body == long_body
    assert _LONG_TEXT_TAIL_MARKER in excinfo.value.body
    assert excinfo.value.code is None


def test_success_response_with_non_json_body_raises_api_error() -> None:
    """A 2xx status alone must not be treated as success — this exercises the
    `_payload` branch that a >=400-status test can never reach, since `_send`
    would already have raised before `_payload` runs."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json at all")

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    with pytest.raises(ApiError) as excinfo:
        client.get("/posts")
    assert excinfo.value.status == 200
    assert "not json at all" in excinfo.value.body


def test_success_response_with_non_object_json_raises_api_error() -> None:
    """A 200 with a JSON array (not an object) must also raise, per the
    contract that `get`/`post`/`post_multipart` always return dict[str, Any]."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1, 2, 3])

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    with pytest.raises(ApiError) as excinfo:
        client.get("/posts")
    assert excinfo.value.status == 200
    assert excinfo.value.code is None


def test_post_multipart_sends_files_and_form_fields() -> None:
    seen_files: dict[str, bytes] = {}
    seen_form: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        # httpx encodes multipart/form-data; decode via the request stream is
        # overkill here — assert on the raw content-type and that both the
        # file bytes and the form field ended up in the body.
        assert request.headers["content-type"].startswith("multipart/form-data")
        body = request.content
        assert b"hello-image-bytes" in body
        assert b"boardId" in body
        seen_files["images"] = body
        seen_form["boardId"] = "abc123"
        return httpx.Response(200, json={"data": {"post": {"id": "p1"}}})

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    result = client.post_multipart(
        "/posts",
        files={"images": ("photo.jpg", b"hello-image-bytes", "image/jpeg")},
        data={"boardId": "abc123"},
    )
    assert result == {"data": {"post": {"id": "p1"}}}
    assert seen_files["images"]
    assert seen_form["boardId"] == "abc123"


def test_transport_error_wraps_a_raw_httpx_exception_and_stays_catchable_as_api_error() -> None:
    """`api/images.py` documents "a raw httpx exception is never allowed to
    escape this module" as its own contract; `ApiClient` must hold to the
    same contract for every caller, not just images.py. `TransportError`
    subclasses `ApiError` so a caller written against `except ApiError`
    (the documented failure type) still catches this without change."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    with pytest.raises(ApiError) as excinfo:
        client.get("/posts")
    assert isinstance(excinfo.value, TransportError)
    assert excinfo.value.status == 0
    assert isinstance(excinfo.value.__cause__, httpx.ConnectError)


def test_client_is_a_context_manager_that_closes() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {}})

    with ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    ) as client:
        assert client.get("/me") == {"data": {}}
    # Closed clients raise on further use — proves __exit__ actually closed it.
    with pytest.raises(RuntimeError, match="closed"):
        client.get("/me")


def test_get_passes_query_params() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {}})

    with _client(handler) as client:
        client.get("/feed/global", params={"limit": 40, "sort": "recommended"})

    assert "limit=40" in seen[0]
    assert "sort=recommended" in seen[0]


def test_patch_sends_patch_method() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.method)
        return httpx.Response(200, json={"data": {}})

    with _client(handler) as client:
        client.patch("/users/me", json={"agentBackend": "claude:haiku"})

    assert seen == ["PATCH"]


def test_resolve_auth_falls_back_when_key_file_is_blank(tmp_path: Path) -> None:
    (tmp_path / "api_key.txt").write_text("   \n", encoding="utf-8")
    auth = resolve_auth(tmp_path, username="zenith", password="pw")
    assert isinstance(auth, PasswordAuth)


def test_resolve_auth_falls_back_when_key_file_is_absent(tmp_path: Path) -> None:
    auth = resolve_auth(tmp_path, username="zenith", password="pw")
    assert isinstance(auth, PasswordAuth)


def test_resolve_auth_prefers_the_key_file(tmp_path: Path) -> None:
    (tmp_path / "api_key.txt").write_text("sk-live\n", encoding="utf-8")
    auth = resolve_auth(tmp_path, username="zenith", password="pw")
    assert isinstance(auth, ApiKeyAuth)


def test_resolve_auth_raises_when_no_key_file_and_no_password(tmp_path: Path) -> None:
    """Neither auth strategy is constructible: no usable api_key.txt and no
    SWIL_PASS fallback."""
    with pytest.raises(ValueError, match=r"no api_key\.txt"):
        resolve_auth(tmp_path, username="zenith", password=None)


def test_error_keeps_the_response_headers_lowercased() -> None:
    """The backfill reads `Retry-After` off a 429, so the error carries them."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "12"}, json={})

    with pytest.raises(ApiError) as excinfo:
        _client(handler).post("/x", json={})
    assert excinfo.value.status == 429
    assert excinfo.value.headers["retry-after"] == "12"


def test_an_error_built_without_headers_has_an_empty_mapping() -> None:
    assert ApiError(500, "boom", None).headers == {}
