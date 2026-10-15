"""`Resources`' social writes: posts, comments, likes, follows, DMs, the
mark-read and the profile PATCH -- each one verified (see `api/resources.py`'s
module docstring).

A mixin composed into `Resources` (S3 §9); it reaches the API only through
`self._client`, which `Resources.__init__` sets. Logs under
`swil_agent.api.resources`, the name these lines had before the split.
"""

from __future__ import annotations

import logging
from typing import Any

from swil_agent.api.client import ApiClient, ApiError
from swil_agent.api.envelope import WriteNotVerifiedError, _nested_id

logger = logging.getLogger("swil_agent.api.resources")


class SocialWrites:
    """The platform writes an act round performs."""

    _client: ApiClient

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
