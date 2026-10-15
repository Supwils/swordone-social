"""Typed endpoint methods with write verification.

Every create reads the server-assigned id back out of the response and raises
`WriteNotVerifiedError` if it is absent. A bare 2xx proves nothing: an
unchecked `like` or `comment` can log DONE for a write that never landed,
which is why codex is restricted to post/nothing by a guardrail allow-list.

Response shapes below were read out of `server/src/` directly (not assumed
from the task brief, which guessed wrong on `send_dm` and on the create_post
multipart field name) and are cited with file:line evidence in each method's
docstring.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any, Final, Literal

from swil_agent.api.client import ApiClient, ApiError
from swil_agent.api.dto import LabEvent

logger = logging.getLogger(__name__)

VectorFilingStatus = Literal["filed", "echo", "rate_limited", "failed"]


@dataclass(frozen=True)
class VectorFiling:
    """One post-vector ingest's outcome. `echo` is the server's refusal of an
    echo post (400, `fields.postId == "ECHO"`); `retry_after` (seconds) is
    set only on `rate_limited`, and only when the 429 said how long."""

    status: VectorFilingStatus
    retry_after: float | None = None


_RATELIMIT_RESET_RE: Final = re.compile(r"(?:^|[,;\s])reset=(\d+)", re.ASCII)


def _seconds(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        value = float(raw.strip())
    except ValueError:
        return None
    return value if value >= 0 else None


def retry_after_seconds(headers: Mapping[str, str], *, now: datetime | None = None) -> float | None:
    """How long a 429 asked us to wait: `Retry-After` (delta-seconds or an
    HTTP date), else `RateLimit-Reset` (draft-6), else the `reset=` field of
    the draft-7 `RateLimit` header the server's limiters send. `None` when
    no header says. Header names are expected lowercased (`ApiError.headers`)."""
    retry_after = headers.get("retry-after")
    seconds = _seconds(retry_after)
    if seconds is not None:
        return seconds
    if retry_after:
        try:
            when = parsedate_to_datetime(retry_after)
        except (TypeError, ValueError):
            when = None
        if when is not None:
            moment = now or datetime.now(UTC)
            when = when.replace(tzinfo=UTC) if when.tzinfo is None else when
            return max(0.0, (when - moment).total_seconds())
    seconds = _seconds(headers.get("ratelimit-reset"))
    if seconds is not None:
        return seconds
    match = _RATELIMIT_RESET_RE.search(headers.get("ratelimit", ""))
    return float(match.group(1)) if match else None


def _is_echo_refusal(exc: ApiError) -> bool:
    if exc.status != 400:
        return False
    try:
        payload: Any = json.loads(exc.body)
    except ValueError:
        return False
    error = payload.get("error") if isinstance(payload, dict) else None
    fields = error.get("fields") if isinstance(error, dict) else None
    return isinstance(fields, dict) and fields.get("postId") == "ECHO"


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


def _feed_params(limit: int, sort: str, since: str | None) -> dict[str, Any]:
    params: dict[str, Any] = {"limit": limit, "sort": sort}
    if since is not None:
        params["since"] = since
    return params


class Resources:
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

    def mark_notifications_read(self, ids: list[str] | None = None) -> None:
        """POST /notifications/read — both of its two shapes.

        `ids=None` sends `{"all": true}`; a list sends `{"ids": [...]}`. The server's
        `readBody` is a strict `z.union` of exactly those two objects
        (`server/src/modules/notifications/notifications.routes.ts:20-28`),
        so they must never be merged into one body carrying both keys.

        An EMPTY list is not sent at all: the server's `ids` branch is
        `.min(1)` and would 400, so returning early keeps that guard from
        being repeated at every call site.

        `noContent(res)` -> a bare 204 with an empty body
        (`notifications.routes.ts:64`), which `ApiClient.post()` would raise
        `ApiError` on while trying to `.json()`-parse — same shape as
        `follow`/`like_post`, so this uses `raw_post` for the same reason.

        Never raises, because marking a notification read is
        housekeeping — a round that already landed its actions must not be
        reported as failed because this call did not go through. Logged at
        WARNING so the fire-and-forget is still visible to anyone looking.
        """
        if ids is not None and not ids:
            return
        body: dict[str, Any] = {"all": True} if ids is None else {"ids": ids}
        try:
            self._client.raw_post("/notifications/read", json=body)
        except ApiError as exc:
            logger.warning("mark-notifications-read failed (%s): ignored", exc)

    def update_profile(self, patch: dict[str, Any]) -> None:
        """PATCH /users/me with `patch` as the body — used for the
        `agentBackend` profile sync (contract `01` §2).
        """
        self._client.patch("/users/me", json=patch)

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

    def lab_event(self, username: str, event: LabEvent) -> None:
        """Best-effort observability write.

        Bash swallows every failure here (`|| true`, contract 02 §5.3) because
        a lab-event outage must never change a round's outcome. Callers get the
        same guarantee: this never raises.
        """
        try:
            self._client.post(f"/agents/{username}/events", json=event.to_wire())
        except ApiError:
            return

    def post_vector(
        self,
        username: str,
        *,
        post_id: str,
        round_id: str | None,
        embedding: list[float],
        card_sim: float | None,
        max_sim: float | None,
    ) -> bool:
        """POST /agents/{username}/post-vectors (S2 §5): one post's bge-m3
        vector and its two similarities. True when the server filed it.

        Best-effort like `lab_event` -- a measurement outage never changes a
        round -- but LOGGED and answered, because the caller records an
        unfiled vector on the cycle_run card. The ingest is idempotent on
        `postId` (201 new, 200 existing); a 409 (a different non-null round),
        a 429, an echo refusal or any other rejection is a False. `roundId` is
        sent as `null`, not omitted, when unknown: the server then resolves it.
        """
        return (
            self.file_post_vector(
                username,
                post_id=post_id,
                round_id=round_id,
                embedding=embedding,
                card_sim=card_sim,
                max_sim=max_sim,
            ).status
            == "filed"
        )

    def file_post_vector(
        self,
        username: str,
        *,
        post_id: str,
        round_id: str | None,
        embedding: list[float],
        card_sim: float | None,
        max_sim: float | None,
    ) -> VectorFiling:
        """`post_vector` with the outcome spelled out, for the backfill: a
        429 carries how long to wait, and the server's echo refusal is told
        apart from a failure. Never raises."""
        body: dict[str, Any] = {
            "postId": post_id,
            "roundId": round_id,
            "embedding": embedding,
            "cardSim": card_sim,
            "maxSim": max_sim,
        }
        try:
            response = self._client.post(f"/agents/{username}/post-vectors", json=body)
        except ApiError as exc:
            logger.warning("post-vector for %s (post %s) failed: %s", username, post_id, exc)
            if exc.status == 429:
                return VectorFiling("rate_limited", retry_after_seconds(exc.headers))
            if _is_echo_refusal(exc):
                return VectorFiling("echo")
            return VectorFiling("failed")
        if _nested_id(response, "data", "id") is None:
            logger.warning(
                "post-vector for %s (post %s) was not filed: %s", username, post_id, response
            )
            return VectorFiling("failed")
        return VectorFiling("filed")

    def record_intervention(self, username: str, event: LabEvent) -> str:
        """`lab_event`'s LOUD twin: same route, verified, and it raises.

        `lab_event` swallows every `ApiError` because a measurement outage
        must not change a round's outcome. A human intervention record is the
        opposite kind of write: it is filed once, by hand, deliberately, and a
        silent failure means the analysis it exists to correct goes on being
        wrong. Nothing retries it and nothing else will notice.

        The two silent failures this closes are both real. `agentEventIngest`
        400s the WHOLE event on a nested `metrics` value (`z.record` of flat
        scalars only), a defect that ran six weeks undetected because Bash's
        `|| true` and this class's own `except ApiError` both discard it. And
        `POST /agents/{username}/events` requires the actor to BE that
        account (`runtime/events.ts`'s `agent.id !== actor.id` -> 403), so a
        credential for the wrong account fails in a way no return value
        distinguishes from success.

        Returns the created event's id. The envelope is
        `{data: {event: {id}}}` -- `ok(res, { event }, 201)`
        (runtime/runtime.controller.ts) inside `respond.ts`'s `{data, meta}` -- so the
        id is TWO levels down, not one like every snapshot route's
        `{data: {id}}`. A 2xx without it is a rejection, not a success.
        """
        response = self._client.post(f"/agents/{username}/events", json=event.to_wire())
        event_id = _nested_id(response, "data", "event", "id")
        if event_id is None:
            raise WriteNotVerifiedError(f"lab event rejected by server: {response}")
        return event_id

    def create_post(
        self,
        text: str,
        board_id: str | None = None,
        image: tuple[str, bytes] | None = None,
        echo_of: str | None = None,
    ) -> str:
        """POST /posts -> {"data": {"post": {"id": ...}}}, status 201.

        Verified against posts.controller.ts:9-21
        (`ok(res, { post: toPostDTO(post, ctx) }, 201)`) — matches the
        brief. The multipart field name did NOT match the brief, though:
        multer is configured with
        `upload.fields([{ name: 'images', maxCount: 4 }, ...])`
        (posts.routes.ts:47-50) and the controller reads
        `fields['images']` (posts.controller.ts:12) — plural "images", not
        "image".
        A caller sending the brief's singular "image" field would 201 with
        a text-only post and no error — a second silent-failure shape this
        task exists to close off.

        `echo_of` added in Task 6 (act/executor.py): the brief for that task
        called `create_post(text, echo_of=post_id)` for the `echo` kind, but
        this method had no such parameter at the time — Task 1's brief never
        mentioned echo at all. A repost is, server-side, just a normal post
        with `echoOf` set (`posts.schemas.ts`'s `createPostSchema.echoOf`,
        a 24-hex-char id, optional), routed through the exact same
        `POST /posts` handler and the exact same `{"data": {"post": {...}}}`
        response shape — so this is a same-endpoint extension, not a new
        method. One behavior worth flagging for whoever calls this next:
        `posts.write.ts:27` (`if (input.echoOf && !input.text.trim()) throw
        AppError.validation('An echo must include your commentary')`) means
        a quote-less repost (`echo_of` set, `text` empty) 400s server-side —
        contrary to contract `02` §2.5's claim that a quote-less echo degrades
        to a plain repost. A quote-less call omits the `text` key entirely
        (see the `if text:` guard below) and hits the same validation error;
        the check has been in `posts.write.ts` since 2026-04-26 (commit
        `c7ab7e3`). A caller that wants a real repost to land needs a
        non-empty `text`; that product-level gap is not papered over
        silently in this client. Note the two shapes were already
        behaviourally identical even before the `if text:` guard existed
        (`posts.schemas.ts:6`'s `text: z.string().trim().max(5000).default
        ('')` normalises an absent key and an explicit `""` to the exact
        same server-side value), so this is a wire-shape fidelity fix, not
        a behavior fix — the 400 fired either way.
        """
        # `if text:` (not an unconditional `{"text": text}`) so a quote-less
        # echo omits the `text` key entirely. A normal `post` action never calls this
        # with empty text (executor.py's `_execute_post` skips locally
        # first), so this is a no-op for that caller either way.
        body: dict[str, str] = {}
        if text:
            body["text"] = text
        if board_id:
            body["boardId"] = board_id
        if echo_of:
            body["echoOf"] = echo_of
        if image is None:
            payload = self._client.post("/posts", json=body)
        else:
            filename, blob = image
            payload = self._client.post_multipart(
                "/posts", files={"images": (filename, blob)}, data=body
            )
        post_id = _nested_id(payload, "data", "post", "id")
        if post_id is None:
            raise WriteNotVerifiedError(f"post created no id; response={payload}")
        return post_id

    def create_comment(self, post_id: str, text: str, parent_id: str | None = None) -> str:
        """POST /posts/{id}/comments -> {"data": {"comment": {"id": ...}}}.

        The created id is read from `data.comment.id`.
        """
        body: dict[str, str] = {"text": text}
        if parent_id:
            body["parentId"] = parent_id
        payload = self._client.post(f"/posts/{post_id}/comments", json=body)
        comment_id = _nested_id(payload, "data", "comment", "id")
        if comment_id is None:
            raise WriteNotVerifiedError(f"comment created no id; response={payload}")
        return comment_id

    def like_post(self, post_id: str) -> None:
        """POST /posts/{id}/like — there is no created id, but there IS a
        state field to verify against, contrary to the brief's assumption
        that only "2xx and a parseable envelope" was available.

        `likes.service.ts`'s `like()` is idempotent (a fresh like and a
        repeat like both hit this path) and always returns
        `{ likeCount, liked: true }` on success
        (server/src/modules/likes/likes.service.ts:70-126, return statements
        at lines 87 and 125 both set `liked: true`); `likes.controller.ts`
        wraps that as `ok(res, out)`
        (server/src/modules/likes/likes.controller.ts:7-13), so the body is
        `{"data": {"likeCount": N, "liked": true}}`. There is no error path
        that returns `liked: false` from THIS endpoint (`false` only comes
        back from `unlike`), so asserting `data.liked is True` is a real
        verification of the state, not a formality — a response that
        parses as JSON but omits or falsifies `liked` (e.g. a
        proxy/middleware swallowing the write) is exactly the silent
        failure this task exists to catch, and now raises instead of
        passing.
        """
        payload = self._client.post(f"/posts/{post_id}/like")
        data = payload.get("data")
        liked = data.get("liked") if isinstance(data, dict) else None
        if liked is not True:
            raise WriteNotVerifiedError(f"like did not confirm liked=true; response={payload}")

    def follow(self, username: str) -> None:
        """POST /users/{username}/follow — no JSON body at all on success.

        `follows.controller.ts`'s `follow` handler calls
        `return noContent(res)` (server/src/modules/follows/
        follows.controller.ts:7-11), and `noContent` is
        `res.status(204).end()` (server/src/lib/respond.ts:10-12) — a bare
        204 with an empty body. `ApiClient.post()` would raise `ApiError`
        trying to `.json()`-parse that empty body (see
        `ApiClient._payload`), so this uses `raw_post` and verifies the
        status code directly instead.

        "Already following" is a real, distinct server response:
        `follows.service.ts`'s `follow()` does `if (!edge) throw
        AppError.conflict('Already following this user')` on the no-op insert
        (server/src/modules/follows/follows.service.ts:28-34), which is a
        409 with body `{"error": {"code": "CONFLICT", ...}}`
        (`AppError.conflict` -> status 409 code 'CONFLICT',
        server/src/lib/errors.ts:32-34; serialized by
        server/src/middlewares/errorHandler.ts:21-28).

        THAT 409 IS RAISED, NOT SWALLOWED (ruling R20). "Already following" is
        not a failed ROUND, but the write did not succeed: swallowing it here
        would log `DONE`, emit a `success` lab event for the wrong case, and
        write a memory line (the dream's input and the unit
        `DREAM_MIN_NEW_MEMORIES=8` counts). Raising is also the only shape
        that cannot be ignored silently by a caller.

        `act/executor.py`'s `_execute_follow` distinguishes this CONFLICT
        from every other write failure (loop-engine spec §6): 409 /
        `CONFLICT` is `landed=True`, `call_succeeded=False` (idempotent
        success, no memory line); any other `ApiError` /
        `WriteNotVerifiedError` is `landed=False`.
        """
        response = self._client.raw_post(f"/users/{username}/follow")
        if response.status_code != 204:
            raise WriteNotVerifiedError(
                f"follow returned unexpected status {response.status_code} "
                "(expected 204 No Content per follows.controller.ts)"
            )

    def send_dm(self, username: str, text: str) -> tuple[str, str]:
        """Two calls, NOT `POST /messages` as the brief guessed.

        There is no `/messages` route at all. Direct messages go through a
        conversations resource (server/src/modules/messages/
        messages.routes.ts, mounted at `/api/v1/conversations` in
        server/src/app.ts:164). The two-call shape below is derived from
        that server source.

          1. `POST /conversations` with `{"recipientUsername": username}`
             -> `{"data": {"conversation": {"id": ...}}}`, 201 if a new
             conversation was created, 200 if one already existed
             (messages.routes.ts:37-54,
             `return ok(res, { conversation: dto }, created ? 201 : 200)`).
          2. `POST /conversations/{conversationId}/messages` with
             `{"text": text}` -> `{"data": {"message": {"id": ...}}}`,
             status 201 (messages.routes.ts:91-102,
             `return ok(res, { message: dto }, 201)`).

        Both steps are independently id-verified; a conversation created
        with no id is just as much a silent-failure shape as a message sent
        with no id, so both raise `WriteNotVerifiedError` rather than only
        checking the final step.

        Returns `(conversation_id, message_id)` -- widened from a bare
        message id (fix round 1, task-7 review item 4) so a caller can
        record `conversationId` in its memory line.
        """
        conv_payload = self._client.post("/conversations", json={"recipientUsername": username})
        conversation_id = _nested_id(conv_payload, "data", "conversation", "id")
        if conversation_id is None:
            raise WriteNotVerifiedError(f"conversation created no id; response={conv_payload}")
        msg_payload = self._client.post(
            f"/conversations/{conversation_id}/messages", json={"text": text}
        )
        message_id = _nested_id(msg_payload, "data", "message", "id")
        if message_id is None:
            raise WriteNotVerifiedError(f"dm created no id; response={msg_payload}")
        return conversation_id, message_id

    def create_snapshot(self, username: str, payload: dict[str, Any]) -> str:
        """POST a personality snapshot; return the created id.

        Raises WriteNotVerifiedError when the server answers 200 without a
        `data.id`, which is the "server rejected" case.
        """
        response = self._client.post(f"/agents/{username}/snapshots", json=payload)
        snapshot_id = _nested_id(response, "data", "id")
        if snapshot_id is None:
            raise WriteNotVerifiedError(f"snapshot rejected by server: {response}")
        return snapshot_id

    def create_behavior_snapshot(
        self, username: str, payload: dict[str, Any]
    ) -> tuple[str, float | None]:
        """POST a BEHAVIOR snapshot; return `(id, fidelity)`.

        A DIFFERENT endpoint from `create_snapshot` above, with a different
        body and a different response: `ingestBehavior` answers
        `ok(res, { id, fidelity }, 201)`
        (server/src/modules/agents/persona/persona.controller.ts, returning
        `persona/drift.ts`'s `{ id, fidelity }`), so the envelope is
        `{"data": {"id": ..., "fidelity": ...}}`.

        `fidelity` is `null` whenever the account has no personality
        snapshot to compare against (`persona/drift.ts`), which is
        the normal state for an account whose first dream has not landed
        yet -- so `None` here is data, not an error, and is reported as
        "n/a".

        Raises WriteNotVerifiedError when the server answers 2xx with no
        `data.id`, which is the "server rejected" case.
        """
        response = self._client.post(f"/agents/{username}/behavior-snapshots", json=payload)
        snapshot_id = _nested_id(response, "data", "id")
        if snapshot_id is None:
            raise WriteNotVerifiedError(f"behavior snapshot rejected by server: {response}")
        data = response.get("data")
        raw = data.get("fidelity") if isinstance(data, dict) else None
        # `isinstance(True, int)` is True in Python, and a JSON `true` here
        # would otherwise become `1.0` -- a perfect fidelity score invented
        # out of a boolean.
        if isinstance(raw, bool) or not isinstance(raw, int | float):
            return snapshot_id, None
        return snapshot_id, float(raw)

    def record_population_metric(self) -> dict[str, Any]:
        """POST /agents/population-metric -- GLOBAL, no username, no body.

        `populationRouter.post('/population-metric', requireUser, ...)`
        (population/population.routes.ts) is mounted before the `/:username/*`
        routes, so this is a literal path and ANY lab account's api_key
        authorises it. The request has no body: `json=None` makes httpx omit
        it entirely rather than sending `null`.

        Returns the `data` object (`capturedAt`, `personaCohesion`,
        `behaviorCohesion`, `n` -- `population/population.ts`).

        The verification is `data.capturedAt`: `null`, `false` and a missing
        key are the rejection. A degenerate
        sample (`n < 2`) is deliberately NOT historised by the server but
        still answers with a `capturedAt`, so it counts as success here
        as well.
        """
        response = self._client.post("/agents/population-metric")
        data = response.get("data")
        captured_at = data.get("capturedAt") if isinstance(data, dict) else None
        if not isinstance(data, dict) or captured_at is None or captured_at is False:
            raise WriteNotVerifiedError(f"population metric rejected by server: {response}")
        return data
