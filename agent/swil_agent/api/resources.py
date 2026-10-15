"""Typed endpoint methods with write verification.

Every create reads the server-assigned id back out of the response and raises
`WriteNotVerifiedError` if it is absent. A bare 2xx proves nothing: an
unchecked `like` or `comment` can log DONE for a write that never landed,
which is why codex is restricted to post/nothing by a guardrail allow-list.

Response shapes below were read out of `server/src/` directly (not assumed
from the task brief, which guessed wrong on `send_dm` and on the create_post
multipart field name) and are cited with file:line evidence in each method's
docstring.

`Resources` is composed of three parts (S3 §9): the reads, defined here; the
social writes, `SocialWrites` in `api/writes.py`; and the lab writes,
`LabWrites` in `api/lab.py`. The envelope helpers they share are in
`api/envelope.py`.
"""

from __future__ import annotations

from typing import Any

from swil_agent.api.client import ApiClient
from swil_agent.api.envelope import WriteNotVerifiedError as WriteNotVerifiedError
from swil_agent.api.envelope import _items
from swil_agent.api.lab import LabWrites
from swil_agent.api.lab import VectorFiling as VectorFiling
from swil_agent.api.writes import SocialWrites


def _feed_params(limit: int, sort: str, since: str | None) -> dict[str, Any]:
    params: dict[str, Any] = {"limit": limit, "sort": sort}
    if since is not None:
        params["since"] = since
    return params


class Resources(SocialWrites, LabWrites):
    """Every endpoint the runtime calls. The reads are defined here; the
    social writes come from `SocialWrites` (`api/writes.py`) and the lab
    writes from `LabWrites` (`api/lab.py`)."""

    def __init__(self, client: ApiClient) -> None:
        self._client = client

    def me(self) -> dict[str, Any]:
        """GET /auth/me — NOT `/me` and NOT `/users/me`.

        `authRouter.get('/me', requireUser, asyncHandler(ctrl.me))`
        (server/src/modules/auth/auth.routes.ts:22) is mounted at
        `/api/v1/auth` (server/src/app.ts:151), so the real path is
        `/auth/me`. `/users/:username` is a different router (the follow
        sub-router) whose username validator requires >= 3 chars
        (server/src/modules/follows/follows.routes.ts:9-15) and would 400 on
        the literal string "me" — so self-lookup is /auth/me, NOT /users/me.

        `auth.controller.ts`'s `me` handler returns
        `ok(res, { user: toUserDTO(req.user, { self: true }) })`
        (server/src/modules/auth/auth.controller.ts:47-50), so the response
        is `{"data": {"user": {...}}}`. Returns the unwrapped user object.
        """
        payload = self._client.get("/auth/me")
        data = payload.get("data")
        user = data.get("user") if isinstance(data, dict) else None
        if not isinstance(user, dict):
            raise RuntimeError(f"/auth/me returned no user object; response={payload}")
        return user

    def get_boards(self) -> dict[str, str]:
        """GET /boards -> {"data": {"items": [{"id", "slug", ...}, ...]}}.

        Verified against boards.routes.ts:13-19
        (`ok(res, { items: items.map(toBoardDTO) })`) and `toBoardDTO`
        (server/src/lib/dto.ts:285-294), which emits `id` and `slug` as
        plain strings. Matches the brief's assumed shape exactly.
        """
        payload = self._client.get("/boards")
        data = payload.get("data")
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return {}
        mapping: dict[str, str] = {}
        for item in items:
            if isinstance(item, dict):
                slug = item.get("slug")
                board_id = item.get("id")
                if isinstance(slug, str) and isinstance(board_id, str):
                    mapping[slug] = board_id
        return mapping

    def feed_global(
        self, limit: int = 40, sort: str = "recommended", since: str | None = None
    ) -> list[dict[str, Any]]:
        """GET /feed/global?limit=&sort=[&since=] -- breadth/depth feed passes.

        The act path reads this twice: `limit=40&sort=recommended` (breadth,
        first 25 used) and `limit=18&sort=latest` (depth). `since` (ISO 8601)
        asks the server for posts created at or after that moment only.
        """
        payload = self._client.get("/feed/global", params=_feed_params(limit, sort, since))
        return _items(payload)

    def feed_board(
        self, slug: str, limit: int = 12, sort: str = "latest", since: str | None = None
    ) -> list[dict[str, Any]]:
        """GET /feed/board/{slug}?limit=&sort=[&since=] -- board-scoped feed."""
        payload = self._client.get(f"/feed/board/{slug}", params=_feed_params(limit, sort, since))
        return _items(payload)

    def search_posts(
        self, q: str, limit: int = 12, since: str | None = None
    ) -> list[dict[str, Any]]:
        """GET /posts/search?q=&limit=[&since=] -- topic-keyed search.

        `q` is passed through httpx's own query-param encoder; callers do
        not need to URL-encode it themselves.
        """
        params: dict[str, Any] = {"q": q, "limit": limit}
        if since is not None:
            params["since"] = since
        payload = self._client.get("/posts/search", params=params)
        return _items(payload)

    def get_post(self, post_id: str) -> dict[str, Any]:
        """GET /posts/{id} -> {"data": {"post": {...}}} — single post, used by
        the thread-context block (contract `01` §2i; the first of the two
        thread calls).

        `getById` returns `ok(res, { post: toPostDTO(post, ctx) })`
        (server/src/modules/posts/posts.controller.ts:23-28) — the post is
        nested one level deeper than `create_post`'s sibling shape might
        suggest. A prior version of this method stopped at `data`, returning
        `{"post": {...}}` instead of the post's own fields: every thread
        block rendered `=== POST  ===` with an empty author and zero counts,
        because every `.get(...)` downstream missed on a key that lived one
        level too deep. Caught in review, not by any test — see
        `test_get_post_returns_the_post_dict`'s real-envelope regression
        guard.
        """
        payload = self._client.get(f"/posts/{post_id}")
        data = payload.get("data")
        post = data.get("post") if isinstance(data, dict) else None
        return post if isinstance(post, dict) else {}

    def get_comments(self, post_id: str, limit: int = 6) -> list[dict[str, Any]]:
        """GET /posts/{id}/comments?limit= — the second of the two thread
        calls (contract `01` §2i).
        """
        payload = self._client.get(f"/posts/{post_id}/comments", params={"limit": limit})
        return _items(payload)

    def notifications(self, limit: int = 8, unread_only: bool = True) -> list[dict[str, Any]]:
        """GET /notifications?limit=&unreadOnly= — contract `01` §2j.

        `unreadOnly` is only sent (as the literal string `"true"`) when
        `unread_only` is true; the parameter is omitted entirely rather than
        sent as `"false"` when it is not, since there is no observed caller that ever passes false.
        """
        params: dict[str, Any] = {"limit": limit}
        if unread_only:
            params["unreadOnly"] = "true"
        return _items(self._client.get("/notifications", params=params))

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        """GET /conversations?limit= — contract `01` §2k."""
        return _items(self._client.get("/conversations", params={"limit": limit}))

    def user_posts(self, username: str, limit: int = 12) -> list[dict[str, Any]]:
        """GET /users/{username}/posts?limit=."""
        return _items(self._client.get(f"/users/{username}/posts", params={"limit": limit}))

    def user_posts_page(
        self,
        username: str,
        *,
        limit: int,
        since: str | None = None,
        cursor: str | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        """GET /users/{username}/posts?limit=[&since=][&cursor=] -> one page
        and its `nextCursor` (`None` at the end).

        The route (`feed.routes.ts`'s `userPostsRouter`) pages by an opaque
        time cursor and caps `limit` at 100; `since` is ISO 8601. Active
        posts only -- a deleted post is not listed.
        """
        params: dict[str, Any] = {"limit": limit}
        if since is not None:
            params["since"] = since
        if cursor is not None:
            params["cursor"] = cursor
        payload = self._client.get(f"/users/{username}/posts", params=params)
        data = payload.get("data")
        raw_next = data.get("nextCursor") if isinstance(data, dict) else None
        next_cursor = raw_next if isinstance(raw_next, str) and raw_next else None
        return _items(payload), next_cursor

    def contacts(self) -> list[str]:
        """DM-eligible usernames: the union of following, followers, and
        conversation participants, minus self — contract `01` §2k.

        Self resolves via `me()` (`/auth/me`), **not** `/users/me` — the
        follows sub-router rejects `"me"` as too short a username. Returns
        `[]` (rather than raising) if `me()`'s user object carries no usable
        `username`, matching this method's status as prompt-context input:
        a bad self-lookup degrades the DM list, not the round. `me()`
        itself still raises on a missing user object entirely — this only
        guards the narrower "object present, field absent" shape.
        """
        me = self.me().get("username")
        if not isinstance(me, str) or not me:
            return []
        names: set[str] = set()
        for path in (f"/users/{me}/following", f"/users/{me}/followers"):
            for row in _items(self._client.get(path, params={"limit": 100})):
                name = row.get("username")
                if isinstance(name, str) and name:
                    names.add(name)
        for convo in _items(self._client.get("/conversations", params={"limit": 50})):
            participants = convo.get("participants")
            if isinstance(participants, list):
                for p in participants:
                    name = p.get("username") if isinstance(p, dict) else None
                    if isinstance(name, str) and name:
                        names.add(name)
        names.discard(me)
        return sorted(names)
