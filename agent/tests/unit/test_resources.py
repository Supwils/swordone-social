import json as _json
import logging
from collections.abc import Callable
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from swil_agent.api.auth import ApiKeyAuth
from swil_agent.api.client import ApiClient, ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources, VectorFiling, WriteNotVerifiedError


def _resources(handler) -> Resources:
    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    return Resources(client)


# ── create_post ──────────────────────────────────────────────────────────


def test_create_post_returns_server_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/posts"
        return httpx.Response(201, json={"data": {"post": {"id": "post-1"}}})

    assert _resources(handler).create_post("hello") == "post-1"


def test_create_post_without_id_raises_write_not_verified() -> None:
    """A 200 with no created resource is the codex silent-fail signature."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).create_post("hello")


def test_create_post_sends_board_id_when_given() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(_json.loads(request.content))
        return httpx.Response(201, json={"data": {"post": {"id": "p"}}})

    _resources(handler).create_post("hi", board_id="board-9")
    assert seen["boardId"] == "board-9"


def test_create_post_omits_board_id_when_absent() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(_json.loads(request.content))
        return httpx.Response(201, json={"data": {"post": {"id": "p"}}})

    _resources(handler).create_post("hi")
    assert "boardId" not in seen


def test_create_post_sends_echo_of_when_given() -> None:
    """Added for Task 6's `echo` action kind: a repost is a normal post with
    `echoOf` set (posts.schemas.ts), routed through this same endpoint."""
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(_json.loads(request.content))
        return httpx.Response(201, json={"data": {"post": {"id": "p"}}})

    _resources(handler).create_post("nice take", echo_of="p" * 24)
    assert seen["echoOf"] == "p" * 24
    assert seen["text"] == "nice take"


def test_create_post_omits_echo_of_when_absent() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(_json.loads(request.content))
        return httpx.Response(201, json={"data": {"post": {"id": "p"}}})

    _resources(handler).create_post("hi")
    assert "echoOf" not in seen


def test_create_post_with_no_text_omits_the_text_key_entirely() -> None:
    """A quote-less echo (`echo_of` set, `text=""`) must produce a wire body
    with no `text` key at all -- byte for byte matching swil.sh:602-617's
    `else BODY='{"echoOf":...}'` branch (no `text` key), not an approximation
    of it via an explicit empty string. `posts.schemas.ts`'s
    `text: z.string().trim().max(5000).default('')` normalises both shapes
    to the same server-side value, so this is a wire-fidelity assertion, not
    a behavior one -- see the docstring on `create_post` for why the literal
    shape still matters even though the effective behavior was already
    identical."""
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(_json.loads(request.content))
        return httpx.Response(201, json={"data": {"post": {"id": "p"}}})

    _resources(handler).create_post("", echo_of="p" * 24)
    assert "text" not in seen
    assert seen["echoOf"] == "p" * 24


def test_create_post_with_image_uses_plural_images_multipart_field() -> None:
    """Regression guard for the brief's wrong assumption: multer is
    configured with the plural field name "images"
    (posts.routes.ts: upload.fields([{ name: 'images', maxCount: 4 }, ...]))
    and the controller reads fields['images']. A body that instead posts the
    singular "image" would still 201 (multer just sees zero files under
    'images') — losing the picture silently. This asserts the actual bytes
    landed under the "images" multipart field."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["content-type"].startswith("multipart/form-data")
        body = request.content
        assert b'name="images"' in body
        assert b"raw-image-bytes" in body
        assert b'name="image"' not in body
        return httpx.Response(201, json={"data": {"post": {"id": "p-img"}}})

    result = _resources(handler).create_post("hi", image=("photo.jpg", b"raw-image-bytes"))
    assert result == "p-img"


# ── create_comment ───────────────────────────────────────────────────────


def test_create_comment_returns_server_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/posts/p1/comments"
        return httpx.Response(201, json={"data": {"comment": {"id": "c-1"}}})

    assert _resources(handler).create_comment("p1", "text") == "c-1"


def test_create_comment_sends_parent_id_when_given() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(_json.loads(request.content))
        return httpx.Response(201, json={"data": {"comment": {"id": "c"}}})

    _resources(handler).create_comment("p1", "text", parent_id="c0")
    assert seen["parentId"] == "c0"


def test_create_comment_omits_parent_id_when_absent() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(_json.loads(request.content))
        return httpx.Response(201, json={"data": {"comment": {"id": "c"}}})

    _resources(handler).create_comment("p1", "text")
    assert "parentId" not in seen


def test_create_comment_without_id_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"ok": True}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).create_comment("p1", "text")


# ── like_post ────────────────────────────────────────────────────────────


def test_like_post_accepts_confirmed_liked_true() -> None:
    """Real shape (likes.controller.ts wrapping likes.service.ts's `like()`)
    is {"data": {"likeCount": N, "liked": true}} — richer than the brief's
    "just a parseable envelope" assumption, and this asserts on the actual
    state field per the task's own instruction to do so when one exists."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/posts/p1/like"
        return httpx.Response(200, json={"data": {"likeCount": 4, "liked": True}})

    _resources(handler).like_post("p1")  # must not raise


def test_like_post_raises_when_liked_flag_missing() -> None:
    """A 2xx envelope that parses fine but never confirms the like landed —
    exactly the shape swil.sh's `_curl ... | jq .` could not detect."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).like_post("p1")


def test_like_post_raises_when_liked_is_false() -> None:
    """A response shaped like the *unlike* endpoint's (`liked: false`) must
    not be accepted as a successful like."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"likeCount": 3, "liked": False}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).like_post("p1")


# ── follow ───────────────────────────────────────────────────────────────


def test_follow_succeeds_on_204_no_content() -> None:
    """follows.controller.ts returns `noContent(res)` -> a bare 204, not a
    JSON envelope at all. This is the real shape — the brief assumed a
    postable JSON body existed to check."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/users/ada/follow"
        return httpx.Response(204)

    _resources(handler).follow("ada")  # must not raise


def test_follow_raises_on_already_following_conflict(caplog: pytest.LogCaptureFixture) -> None:
    """RULING R20 — this method must NOT swallow the 409, and the inverted
    assertion is the point of this test.

    `follows.service.ts` throws `AppError.conflict('Already following this
    user')` -> 409 `{"error": {"code": "CONFLICT", …}}`. This method used to
    `return` on it, on the reasoning that "treating CONFLICT as success
    matches the Bash contract". It does not. `swil.sh` runs under
    `set -euo pipefail` and `_curl` returns 1 for any status >= 400
    (swil.sh:132-135), so `swil.sh follow` exits NON-ZERO on a 409 and
    `auto-run.sh:243-252` takes its `else` branch: a `WARN` line, a `warn`
    lab event, and (one level down, in the aborted `swil.sh` case) no
    `_remember` call at all.

    Swallowing it here mislabelled all three at once. Raising is also the
    only shape a caller cannot ignore silently -- a returned flag can be
    dropped on the floor, which is how the defect survived three reviews.

    Mutation this catches: restoring `if exc.code == "CONFLICT": return`.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409, json={"error": {"code": "CONFLICT", "message": "Already following this user"}}
        )

    with pytest.raises(ApiError) as excinfo:
        _resources(handler).follow("ada")
    assert excinfo.value.status == 409
    assert excinfo.value.code == "CONFLICT"
    # And it is not downgraded to a log line on the way out either.
    assert caplog.records == []


def test_follow_propagates_non_conflict_errors() -> None:
    """A 404 (target user does not exist) propagates too — after R20 every
    non-2xx does, and this test's value is now that CONFLICT and NOT_FOUND
    behave identically, exactly as they do in Bash (whose own message says
    "likely already following" precisely because it cannot tell them
    apart)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404, json={"error": {"code": "NOT_FOUND", "message": "User not found"}}
        )

    with pytest.raises(ApiError) as excinfo:
        _resources(handler).follow("ghost")
    assert excinfo.value.status == 404


def test_follow_raises_write_not_verified_on_unexpected_2xx_status() -> None:
    """If the server ever answered 200 instead of 204 (e.g. a future body was
    added), this must not be silently treated as success without inspection
    — it must fail loudly until the code is updated to read that body."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).follow("ada")


# ── send_dm ──────────────────────────────────────────────────────────────


def test_send_dm_creates_conversation_then_sends_message() -> None:
    """Real flow, derived from messages.routes.ts and matching swil.sh:694-713's
    own `dm` case, is two calls: POST /conversations {recipientUsername} ->
    conversation id, then POST /conversations/{id}/messages {text} ->
    message id. The brief's `POST /messages` with `{"username","text"}` does
    not exist on the server at all.

    (An earlier version of this docstring said swil.sh's `dm` case was
    uncommitted and absent from this checkout. That was true when written --
    it was uncommitted work in the main checkout -- and false since 9b9d3a7
    landed it.)"""

    calls: list[tuple[str, dict[str, object]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.url.path, _json.loads(request.content)))
        if request.url.path == "/api/v1/conversations":
            assert _json.loads(request.content) == {"recipientUsername": "someone"}
            return httpx.Response(201, json={"data": {"conversation": {"id": "conv-1"}}})
        assert request.url.path == "/api/v1/conversations/conv-1/messages"
        assert _json.loads(request.content) == {"text": "hi"}
        return httpx.Response(201, json={"data": {"message": {"id": "m-1"}}})

    result = _resources(handler).send_dm("someone", "hi")

    assert result == ("conv-1", "m-1")
    assert [path for path, _ in calls] == [
        "/api/v1/conversations",
        "/api/v1/conversations/conv-1/messages",
    ]


def test_send_dm_raises_when_message_has_no_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/conversations":
            return httpx.Response(201, json={"data": {"conversation": {"id": "conv-1"}}})
        return httpx.Response(200, json={"data": {"message": {}}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).send_dm("someone", "hi")


def test_send_dm_does_not_send_message_when_conversation_creation_fails() -> None:
    """This is the test that isolates the conversation-id check specifically
    (a prior sibling test asserted only `pytest.raises(WriteNotVerifiedError)`
    against a handler that returns the same conversation-shaped body for
    every path — that could not tell "the conversation-id check caught it"
    apart from "the downstream message-id check caught it on a second call
    the code should never have made," so it was removed as misleading).
    Here, `calls` proves there was no second call at all: if the
    conversation-id check were deleted, `send_dm` would proceed to call
    `POST /conversations/None/messages`, this same handler would answer
    that too, and `calls` would have two entries instead of one — that is
    the mutation this test is built to catch."""

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json={"data": {"conversation": {}}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).send_dm("someone", "hi")
    assert calls == ["/api/v1/conversations"]


# ── get_boards ───────────────────────────────────────────────────────────


def test_get_boards_maps_slug_to_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "items": [
                        {"slug": "perception", "id": "b1"},
                        {"slug": "making", "id": "b2"},
                    ]
                }
            },
        )

    assert _resources(handler).get_boards() == {"perception": "b1", "making": "b2"}


def test_get_boards_returns_empty_mapping_when_items_missing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {}})

    assert _resources(handler).get_boards() == {}


# ── me ───────────────────────────────────────────────────────────────────


def test_me_reads_auth_me_not_bare_me_or_users_me() -> None:
    """authRouter.get('/me', ...) is mounted at /api/v1/auth
    (server/src/app.ts: app.use('/api/v1/auth', authRouter)) — the real path
    is /auth/me, not /me and not /users/me."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/auth/me"
        return httpx.Response(200, json={"data": {"user": {"username": "ada"}}})

    assert _resources(handler).me() == {"username": "ada"}


def test_me_raises_when_user_object_missing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {}})

    with pytest.raises(RuntimeError):
        _resources(handler).me()


# ── read endpoints ───────────────────────────────────────────────────────


def test_feed_global_requests_limit_and_sort() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {"items": [{"id": "p1"}]}})

    result = _resources(handler).feed_global(limit=40, sort="recommended")

    assert seen[0].endswith("/api/v1/feed/global?limit=40&sort=recommended")
    assert result == [{"id": "p1"}]


def test_feed_board_requests_slug_limit_and_sort() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {"items": []}})

    _resources(handler).feed_board("perception", limit=12, sort="latest")

    assert seen[0].endswith("/api/v1/feed/board/perception?limit=12&sort=latest")


SINCE = "2026-10-15T00:00:00+00:00"


def _captured_query(call: Callable[[Resources], object]) -> dict[str, list[str]]:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {"items": []}})

    call(_resources(handler))
    return parse_qs(urlsplit(seen[0]).query)


def test_feed_global_forwards_since_when_given() -> None:
    query = _captured_query(lambda r: r.feed_global(limit=18, sort="latest", since=SINCE))
    assert query == {"limit": ["18"], "sort": ["latest"], "since": [SINCE]}


def test_feed_board_forwards_since_when_given() -> None:
    query = _captured_query(lambda r: r.feed_board("ai", limit=12, sort="latest", since=SINCE))
    assert query["since"] == [SINCE]


def test_search_posts_forwards_since_when_given() -> None:
    query = _captured_query(lambda r: r.search_posts("AI", limit=12, since=SINCE))
    assert query == {"q": ["AI"], "limit": ["12"], "since": [SINCE]}


def test_feed_and_search_send_no_since_by_default() -> None:
    for call in (
        lambda r: r.feed_global(),
        lambda r: r.feed_board("ai"),
        lambda r: r.search_posts("AI"),
    ):
        assert "since" not in _captured_query(call)


def test_search_posts_url_encodes_the_query() -> None:
    """`q` must round-trip through httpx's own URL-encoding, so this decodes
    the captured URL's query string rather than asserting on the raw
    (encoded) bytes — the brief's table notes "q is URL-encoded by httpx"."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {"items": []}})

    _resources(handler).search_posts("语言 边界", limit=12)

    assert seen[0].startswith("https://example.test/api/v1/posts/search?q=")
    parsed = parse_qs(urlsplit(seen[0]).query)
    assert parsed["q"] == ["语言 边界"]
    assert parsed["limit"] == ["12"]


def test_get_post_returns_the_post_dict() -> None:
    """Real envelope, per posts.controller.ts:23-28 (`getById`):
    `ok(res, { post: toPostDTO(post, ctx) })` -> `{"data": {"post": {...}}}`.
    A prior version of `get_post` stopped at `data`, returning the wrapper
    `{"post": {...}}` instead of the post's own fields — this is a
    regression guard against reintroducing that, not a hand-rolled shape."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/posts/p1"
        return httpx.Response(200, json={"data": {"post": {"id": "p1", "text": "hi"}}})

    assert _resources(handler).get_post("p1") == {"id": "p1", "text": "hi"}


def test_get_post_returns_empty_dict_when_data_is_not_an_object() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": []})

    assert _resources(handler).get_post("p1") == {}


def test_get_post_returns_empty_dict_when_post_key_is_missing() -> None:
    """Covers the narrower shape `get_post` itself guards against: `data` IS
    an object, but carries no `post` key (distinct from `data` itself being
    the wrong type, above)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {}})

    assert _resources(handler).get_post("p1") == {}


def test_get_post_returns_empty_dict_when_post_is_not_an_object() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"post": "not-a-post"}})

    assert _resources(handler).get_post("p1") == {}


def test_get_comments_requests_limit() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {"items": [{"id": "c1"}]}})

    result = _resources(handler).get_comments("p1", limit=6)

    assert seen[0].endswith("/api/v1/posts/p1/comments?limit=6")
    assert result == [{"id": "c1"}]


def test_notifications_requests_unread_only() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {"items": []}})

    _resources(handler).notifications(limit=8, unread_only=True)

    assert seen[0].endswith("/api/v1/notifications?limit=8&unreadOnly=true")


def test_notifications_omits_unread_only_when_false() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {"items": []}})

    _resources(handler).notifications(limit=8, unread_only=False)

    assert seen[0].endswith("/api/v1/notifications?limit=8")
    assert "unreadOnly" not in seen[0]


def test_conversations_requests_limit() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {"items": [{"id": "conv-1"}]}})

    result = _resources(handler).conversations(limit=6)

    assert seen[0].endswith("/api/v1/conversations?limit=6")
    assert result == [{"id": "conv-1"}]


def test_user_posts_requests_username_and_limit() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {"items": []}})

    _resources(handler).user_posts("zenith", limit=12)

    assert seen[0].endswith("/api/v1/users/zenith/posts?limit=12")


def test_update_profile_patches_users_me_with_the_body() -> None:
    seen: list[dict[str, object]] = []
    seen_methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_methods.append(request.method)
        assert request.url.path == "/api/v1/users/me"
        seen.append(_json.loads(request.content))
        return httpx.Response(200, json={"data": {}})

    _resources(handler).update_profile({"agentBackend": "claude:haiku"})

    assert seen_methods == ["PATCH"]
    assert seen == [{"agentBackend": "claude:haiku"}]


def test_items_returns_empty_list_on_shape_mismatch() -> None:
    """The READ endpoints degrade the prompt, not the round — a malformed
    envelope must yield [] rather than raise."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"items": "not-a-list"}})

    assert _resources(handler).feed_global() == []


def test_items_returns_empty_list_when_data_is_not_an_object() -> None:
    """Covers the other shape-mismatch branch: `data` itself missing or not
    an object (distinct from `data.items` being the wrong type, above)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": "not-an-object"})

    assert _resources(handler).feed_global() == []


# ── contacts ─────────────────────────────────────────────────────────────


def test_contacts_unions_following_followers_and_conversation_participants() -> None:
    """Contract 01 §2k: self resolves via /auth/me (not /users/me — the
    follows sub-router rejects "me" as too short a username), then the
    result is the union of following, followers, and conversation
    participants, minus self, sorted.

    The handler records the FULL url (path + query), not just the path, for
    every GET it sees, and the assertions below pin the exact query strings
    the contract requires (`limit=100` on following/followers, `limit=50` on
    conversations) — a prior version of this test only ever branched on
    `request.url.path`, so it could not tell a correct `limit` apart from
    any other value; changing `contacts()`'s `params={"limit": 100}` to
    `{"limit": 5}` left it passing."""

    seen_urls: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        seen_urls[path] = str(request.url)
        if path == "/api/v1/auth/me":
            return httpx.Response(200, json={"data": {"user": {"username": "ada"}}})
        if path == "/api/v1/users/ada/following":
            return httpx.Response(200, json={"data": {"items": [{"username": "bob"}]}})
        if path == "/api/v1/users/ada/followers":
            return httpx.Response(200, json={"data": {"items": [{"username": "carl"}]}})
        assert path == "/api/v1/conversations"
        return httpx.Response(
            200,
            json={
                "data": {
                    "items": [
                        {"participants": [{"username": "ada"}, {"username": "dee"}]},
                        {"participants": [{"username": "bob"}, {"username": "ada"}]},
                    ]
                }
            },
        )

    assert _resources(handler).contacts() == ["bob", "carl", "dee"]

    assert seen_urls["/api/v1/users/ada/following"].endswith("?limit=100")
    assert seen_urls["/api/v1/users/ada/followers"].endswith("?limit=100")
    assert seen_urls["/api/v1/conversations"].endswith("?limit=50")


def test_contacts_returns_empty_list_when_self_username_is_missing() -> None:
    """`me()` itself already raises on a missing *user object*
    (test_me_raises_when_user_object_missing above); this covers the
    narrower shape contacts() itself guards against — a user object that
    exists but carries no (or a blank) `username` field."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/auth/me"
        return httpx.Response(200, json={"data": {"user": {}}})

    assert _resources(handler).contacts() == []


# ── lab_event ────────────────────────────────────────────────────────────


def test_lab_event_omits_empty_optional_fields() -> None:
    bodies: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(_json.loads(request.content))
        return httpx.Response(200, json={"data": {}})

    _resources(handler).lab_event(
        "zenith",
        LabEvent(type="cycle", phase="act", outcome="success", action="-", summary="hi"),
    )

    assert bodies[0] == {
        "type": "cycle",
        "phase": "act",
        "outcome": "success",
        "summary": "hi",
        "metrics": {},
    }
    assert "action" not in bodies[0]
    assert "reason" not in bodies[0]
    assert "targetId" not in bodies[0]


def test_lab_event_includes_reason_and_target_id_when_present() -> None:
    """Complements the omission test above: when the optional fields ARE
    populated (and `action` is a real action, not the "-" placeholder),
    they must actually appear on the wire — an implementation that always
    omits them would pass the omission test above vacuously."""
    bodies: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(_json.loads(request.content))
        return httpx.Response(200, json={"data": {}})

    _resources(handler).lab_event(
        "zenith",
        LabEvent(
            type="cycle",
            phase="act",
            outcome="warn",
            action="follow",
            summary="follow request failed",
            reason="ghost",
            target_id="t1",
        ),
    )

    assert bodies[0] == {
        "type": "cycle",
        "phase": "act",
        "outcome": "warn",
        "summary": "follow request failed",
        "metrics": {},
        "action": "follow",
        "reason": "ghost",
        "targetId": "t1",
    }


def test_lab_event_never_raises_on_api_error() -> None:
    """Contract 02 §5.3: swil.sh's `_lab_event` is `|| true`'d — a lab-event
    outage must never change a round's outcome."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"code": "INTERNAL", "message": "boom"}})

    _resources(handler).lab_event(
        "zenith", LabEvent(type="cycle", phase="act", outcome="success", summary="hi")
    )  # must not raise


# ── create_snapshot ──────────────────────────────────────────────────────


def test_create_snapshot_returns_server_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/agents/zenith/snapshots"
        return httpx.Response(200, json={"data": {"id": "snap-1"}})

    assert _resources(handler).create_snapshot("zenith", {"contentHash": "abc"}) == "snap-1"


def test_create_snapshot_raises_write_not_verified_without_id() -> None:
    """snapshot.sh:177-187's "server rejected" branch: a 2xx response that
    carries no `.data.id` — the canary this task's criterion (b) exists to
    catch."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).create_snapshot("zenith", {"contentHash": "abc"})


# ── create_behavior_snapshot (behavior-snapshot.sh:109-122) ───────────────


def test_create_behavior_snapshot_uses_its_own_endpoint() -> None:
    """A DIFFERENT path from `create_snapshot`'s `/snapshots`. Sending a
    behavior body to the personality route (or vice versa) would 400 on a
    field neither schema shares — and, worse, a body that happened to
    validate would land in the wrong collection, plotting posts as
    personality versions on /lab."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(201, json={"data": {"id": "beh-1", "fidelity": 0.5}})

    assert _resources(handler).create_behavior_snapshot("zenith", {"contentHash": "abc"}) == (
        "beh-1",
        0.5,
    )
    assert seen == ["/api/v1/agents/zenith/behavior-snapshots"]


def test_create_behavior_snapshot_sends_the_payload_unchanged() -> None:
    payload = {"contentHash": "abc", "postCount": 3, "commentCount": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert _json.loads(request.content) == payload
        return httpx.Response(201, json={"data": {"id": "beh-1", "fidelity": 0.5}})

    _resources(handler).create_behavior_snapshot("zenith", payload)


def test_create_behavior_snapshot_reports_a_null_fidelity_as_none() -> None:
    """`fidelity` is null until the account has a personality snapshot to
    compare against (persona/drift.ts) — the normal state before an
    account's first accepted dream. `0.0` would read as total infidelity."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {"id": "beh-1", "fidelity": None}})

    assert _resources(handler).create_behavior_snapshot("zenith", {}) == ("beh-1", None)


def test_create_behavior_snapshot_coerces_an_integer_fidelity() -> None:
    """A cosine of exactly 1 serialises as JSON `1`, which json.loads reads
    as an `int`."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {"id": "beh-1", "fidelity": 1}})

    assert _resources(handler).create_behavior_snapshot("zenith", {}) == ("beh-1", 1.0)


def test_create_behavior_snapshot_does_not_read_a_boolean_as_a_score() -> None:
    """`isinstance(True, int)` is True in Python, so a naive numeric check
    turns JSON `true` into a perfect 1.0 fidelity conjured from a flag."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {"id": "beh-1", "fidelity": True}})

    assert _resources(handler).create_behavior_snapshot("zenith", {}) == ("beh-1", None)


def test_create_behavior_snapshot_raises_write_not_verified_without_id() -> None:
    """behavior-snapshot.sh:115-121's "server rejected" branch."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {"fidelity": 0.9}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).create_behavior_snapshot("zenith", {})


# ── record_benchmark_run (benchmark-run.sh:178-180) ───────────────────────


def test_record_benchmark_run_posts_the_body_and_returns_the_row_id() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, json={"data": {"id": "run-1"}})

    body = {"batchId": "b", "persona": "aa", "model": "sonnet", "taskId": "free_post"}
    assert _resources(handler).record_benchmark_run(body) == "run-1"
    assert [(r.method, r.url.path) for r in seen] == [("POST", "/api/v1/agents/benchmark/runs")]
    assert _json.loads(seen[0].content) == body
    assert seen[0].headers["authorization"] == "Bearer k"


def test_record_benchmark_run_without_an_id_is_not_verified() -> None:
    """`jq -r '.data.id // "ERR"'` -- a 2xx with no id is a failed POST."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).record_benchmark_run({})


def test_record_benchmark_run_raises_the_429_with_its_headers() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "12"}, json={"error": {}})

    with pytest.raises(ApiError) as exc:
        _resources(handler).record_benchmark_run({})
    assert (exc.value.status, exc.value.headers["retry-after"]) == (429, "12")


# ── record_population_metric (population-metric.sh:58-70) ─────────────────


def test_record_population_metric_posts_to_the_global_route_with_no_body() -> None:
    """`/agents/population-metric` is registered BEFORE the `/:username/*`
    routes (population/population.routes.ts), so it is a literal path and not a username.
    `curl -X POST` with no `-d` sends no body at all — `json=None`, not
    `json={}`."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, json={"data": {"capturedAt": "2026-08-19T00:00:00.000Z"}})

    _resources(handler).record_population_metric()

    assert [(r.method, r.url.path) for r in seen] == [("POST", "/api/v1/agents/population-metric")]
    assert seen[0].content == b""


def test_record_population_metric_returns_the_data_object() -> None:
    sample = {
        "capturedAt": "2026-08-19T00:00:00.000Z",
        "personaCohesion": 0.11,
        "behaviorCohesion": 0.92,
        "n": 17,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": sample})

    assert _resources(handler).record_population_metric() == sample


def test_record_population_metric_rejects_a_response_without_captured_at() -> None:
    """`jq -e '.data.capturedAt'` (population-metric.sh:63) — a 2xx envelope
    that proves no sample was taken."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {"n": 4}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).record_population_metric()


def test_record_population_metric_rejects_a_null_captured_at() -> None:
    """`jq -e` fails on `null` as well as on a missing key."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {"capturedAt": None, "n": 4}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).record_population_metric()


def test_record_population_metric_rejects_a_missing_data_envelope() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"ok": True})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).record_population_metric()


# ── mark_notifications_read (swil.sh:657-664) ─────────────────────────────


def test_mark_notifications_read_without_ids_sends_the_all_body() -> None:
    """`swil.sh mark-notifications-read` -> `POST /notifications/read
    {"all":true}`. The server's `readBody` is a strict `z.union` of
    `{all: true}` XOR `{ids: [...]}`, so the two bodies must never merge."""
    seen: list[dict[str, object]] = []
    methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        assert request.url.path == "/api/v1/notifications/read"
        seen.append(_json.loads(request.content))
        return httpx.Response(204)

    _resources(handler).mark_notifications_read()

    assert methods == ["POST"]
    assert seen == [{"all": True}]


def test_mark_notifications_read_with_ids_sends_the_ids_body() -> None:
    seen: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(_json.loads(request.content))
        return httpx.Response(204)

    _resources(handler).mark_notifications_read(["a" * 24, "b" * 24])

    assert seen == [{"ids": ["a" * 24, "b" * 24]}]


def test_mark_notifications_read_with_an_empty_list_sends_nothing() -> None:
    """The server's `ids` branch is `.min(1)` and would 400; `auto-run.sh:800`
    guards the call the same way. Mutation this catches: dropping the early
    return, which turns an idle round into a logged 400 every time."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        calls.append(request.method)
        return httpx.Response(204)

    _resources(handler).mark_notifications_read([])

    assert calls == []


def test_mark_notifications_read_tolerates_the_bare_204(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """`noContent(res)` is `res.status(204).end()` -- an EMPTY body
    (`notifications.routes.ts:64`). `ApiClient.post()` would raise `ApiError`
    trying to `.json()`-parse that, so this must use `raw_post`.

    Asserting on the LOG, not merely on "did not raise": this method's own
    `except ApiError` swallows everything, so a `post`-based implementation
    would still not raise -- it would just log a bogus
    "mark-notifications-read failed (HTTP 204: )" on every single healthy
    round, which is worse than the bug it hides. Mutation this catches:
    swapping `raw_post` for `post`."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(204)

    with caplog.at_level(logging.WARNING, logger="swil_agent.api.resources"):
        _resources(handler).mark_notifications_read()

    assert caplog.records == []


def test_mark_notifications_read_never_raises_on_an_api_error() -> None:
    """`auto-run.sh` ends both calls with `|| true`: housekeeping must never
    fail a round whose actions already landed."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"code": "INTERNAL"}})

    _resources(handler).mark_notifications_read(["a" * 24])  # must not raise


# ── post_vector (S2 §4/§5) ───────────────────────────────────────────────


def _post_vector(resources: Resources, **overrides: object) -> bool:
    kwargs: dict[str, object] = {
        "post_id": "p" * 24,
        "round_id": "20261014T091500Z-r",
        "embedding": [0.25, 0.5],
        "card_sim": 0.31,
        "max_sim": None,
    }
    kwargs.update(overrides)
    return resources.post_vector("zenith", **kwargs)  # type: ignore[arg-type]


def test_post_vector_posts_the_wire_body_to_the_accounts_route() -> None:
    seen: list[tuple[str, str, dict[str, object]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, _json.loads(request.content)))
        return httpx.Response(201, json={"data": {"id": "pv-1"}})

    assert _post_vector(_resources(handler)) is True
    assert seen == [
        (
            "POST",
            "/api/v1/agents/zenith/post-vectors",
            {
                "postId": "p" * 24,
                "roundId": "20261014T091500Z-r",
                "embedding": [0.25, 0.5],
                "cardSim": 0.31,
                "maxSim": None,
            },
        )
    ]


def test_post_vector_sends_a_null_round_id_explicitly() -> None:
    bodies: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(_json.loads(request.content))
        return httpx.Response(200, json={"data": {"id": "pv-existing"}})

    assert _post_vector(_resources(handler), round_id=None, card_sim=None) is True
    assert bodies[0]["roundId"] is None
    assert bodies[0]["cardSim"] is None


def test_post_vector_swallows_and_logs_an_api_error(caplog: pytest.LogCaptureFixture) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"error": {"code": "CONFLICT", "message": "round"}})

    with caplog.at_level(logging.WARNING, logger="swil_agent.api.resources"):
        assert _post_vector(_resources(handler)) is False
    assert "post-vector" in caplog.text
    assert "zenith" in caplog.text


def test_post_vector_without_an_id_is_not_filed(caplog: pytest.LogCaptureFixture) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {}})

    with caplog.at_level(logging.WARNING, logger="swil_agent.api.resources"):
        assert _post_vector(_resources(handler)) is False
    assert "post-vector" in caplog.text


def test_post_vector_survives_a_transport_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    assert _post_vector(_resources(handler)) is False


# ── file_post_vector: the backfill's outcome-carrying twin ───────────────


def _file(resources: Resources) -> VectorFiling:
    return resources.file_post_vector(
        "zenith",
        post_id="p" * 24,
        round_id=None,
        embedding=[0.25, 0.5],
        card_sim=None,
        max_sim=None,
    )


def test_file_post_vector_answers_filed_on_a_2xx_with_an_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"id": "pv-1"}})

    assert _file(_resources(handler)) == VectorFiling("filed")


def test_file_post_vector_reads_retry_after_on_a_429() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            headers={"Retry-After": "17", "RateLimit": "limit=20, remaining=0, reset=17"},
            json={"error": {"code": "RATE_LIMITED", "message": "Too many requests"}},
        )

    assert _file(_resources(handler)) == VectorFiling("rate_limited", retry_after=17.0)


def test_file_post_vector_falls_back_to_the_ratelimit_reset_headers() -> None:
    def draft6(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"RateLimit-Reset": "9"}, json={})

    def draft7(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"RateLimit": "limit=20, remaining=0, reset=4"}, json={})

    def bare(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={})

    assert _file(_resources(draft6)).retry_after == 9.0
    assert _file(_resources(draft7)).retry_after == 4.0
    assert _file(_resources(bare)) == VectorFiling("rate_limited", retry_after=None)


def test_file_post_vector_names_the_servers_echo_refusal() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "This post is an echo; an echo is not a post",
                    "fields": {"postId": "ECHO"},
                }
            },
        )

    assert _file(_resources(handler)) == VectorFiling("echo")


def test_file_post_vector_answers_failed_on_any_other_rejection() -> None:
    def conflict(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"error": {"code": "CONFLICT"}})

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    assert _file(_resources(conflict)) == VectorFiling("failed")
    assert _file(_resources(down)) == VectorFiling("failed")


def test_retry_after_reads_an_http_date_relative_to_now() -> None:
    from datetime import UTC, datetime

    from swil_agent.api.ingest_throttle import retry_after_seconds

    now = datetime(2026, 10, 14, 6, 0, 0, tzinfo=UTC)
    assert retry_after_seconds(
        {"retry-after": "Wed, 14 Oct 2026 06:00:30 GMT"}, now=now
    ) == pytest.approx(30.0)
    assert retry_after_seconds({"retry-after": "Wed, 14 Oct 2026 05:59:00 GMT"}, now=now) == 0.0
    # Unparseable or negative values fall through to the next header.
    assert retry_after_seconds({"retry-after": "soon", "ratelimit-reset": "3"}) == 3.0
    assert retry_after_seconds({"retry-after": "-5"}) is None
    assert retry_after_seconds({"ratelimit": "limit=20, remaining=0"}) is None


def test_a_400_that_is_not_the_echo_refusal_is_a_plain_failure() -> None:
    def text(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="not json")

    def other(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"fields": {"embedding": "too_small"}}})

    def listed(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json=["x"])

    for handler in (text, other, listed):
        assert _file(_resources(handler)) == VectorFiling("failed")


def test_post_vector_is_false_on_a_429_and_an_echo_refusal() -> None:
    def limited(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={})

    def echo(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"fields": {"postId": "ECHO"}}})

    assert _post_vector(_resources(limited)) is False
    assert _post_vector(_resources(echo)) is False


# ── user_posts_page: the backfill's paged own-posts read ─────────────────


def test_user_posts_page_sends_limit_since_and_cursor_and_returns_the_next_cursor() -> None:
    seen: list[dict[str, list[str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/users/zenith/posts"
        seen.append(parse_qs(urlsplit(str(request.url)).query))
        return httpx.Response(
            200, json={"data": {"items": [{"id": "a"}, "junk"], "nextCursor": "c2"}}
        )

    items, cursor = _resources(handler).user_posts_page(
        "zenith", limit=100, since="2026-10-14T00:00:00+00:00", cursor="c1"
    )

    assert items == [{"id": "a"}]
    assert cursor == "c2"
    assert seen == [{"limit": ["100"], "since": ["2026-10-14T00:00:00+00:00"], "cursor": ["c1"]}]


def test_user_posts_page_omits_an_absent_cursor_and_reads_a_missing_one_as_the_end() -> None:
    seen: list[dict[str, list[str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(parse_qs(urlsplit(str(request.url)).query))
        return httpx.Response(200, json={"data": {"items": [], "nextCursor": None}})

    items, cursor = _resources(handler).user_posts_page("zenith", limit=5)

    assert (items, cursor) == ([], None)
    assert seen == [{"limit": ["5"]}]
