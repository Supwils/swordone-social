"""Shared `Runner`-, `Backend`-, and `Embedder`-protocol test doubles.

Single home for these so `test_backends.py`, `test_embedder.py`, and any later
task's tests (act/dream) import the same fakes instead of each hand-rolling
one. All classes conform structurally to `swil_agent.llm.runner.Runner` /
`swil_agent.llm.protocol.Backend` / `swil_agent.dream.round.Embedder` /
`swil_agent.dream.candidate.DreamState`.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Final

from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import VectorFiling, WriteNotVerifiedError
from swil_agent.config import Settings
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.graph.deps import CycleDeps
from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest, RunResult
from swil_agent.models import Persona


def make_persona(
    *,
    username: str = "zenith",
    directory: Path | None = None,
    **overrides: Any,
) -> Persona:
    """An Era 3 `Persona` with every required field filled; override any of them."""
    fields: dict[str, Any] = {
        "username": username,
        "display_name": username,
        "topics": ["AI"],
        "backend": "claude",
        "board": "ai",
        "era": 3,
        "card": "CARD",
        "prompt": "CARD\n\n## 最近\n（暂无）",
        "raw": "",
        "directory": directory if directory is not None else Path(f"/tmp/{username}"),
    }
    fields.update(overrides)
    return Persona(**fields)


@dataclass(frozen=True)
class RunnerCall:
    """One recorded invocation of `Runner.run`.

    `cwd_entries` is what the working directory held AT CALL TIME (`None`
    when no `cwd` was passed or it did not exist) -- the isolation tests
    assert it existed and was empty, then that it is gone afterwards."""

    argv: list[str]
    stdin: str | None
    env: dict[str, str] | None
    timeout: float
    cwd: str | None = None
    cwd_entries: tuple[str, ...] | None = None


def record_call(
    argv: list[str],
    stdin: str | None,
    env: dict[str, str] | None,
    timeout: float,
    cwd: str | None,
) -> RunnerCall:
    entries = (
        tuple(sorted(p.name for p in Path(cwd).iterdir()))
        if cwd is not None and Path(cwd).is_dir()
        else None
    )
    return RunnerCall(
        argv=list(argv), stdin=stdin, env=env, timeout=timeout, cwd=cwd, cwd_entries=entries
    )


# The repository this test suite lives in; an isolated persona call must
# never start inside it.
_REPO_ROOT: Final = Path(__file__).resolve().parents[3]


def assert_isolated_cwd(call: RunnerCall, *, expected: tuple[str, ...] = ()) -> None:
    """The call ran in a fresh temp directory outside the repository that
    held exactly `expected` at call time and is gone now."""
    assert call.cwd is not None, "the call inherited the caller's working directory"
    cwd = Path(call.cwd).resolve()
    assert _REPO_ROOT not in (cwd, *cwd.parents), f"{cwd} is inside the repository"
    assert call.cwd_entries == expected, f"cwd held {call.cwd_entries} at call time"
    assert not Path(call.cwd).exists(), f"{call.cwd} was not removed after the call"


class RecordingRunner:
    """Records every call and always returns the same fixed string.

    Also a `StatusRunner`: `run_result` answers `run`'s stdout (so a subclass
    that overrides `run` still drives it) with `returncode` / `timed_out`."""

    def __init__(self, output: str = "ok", *, returncode: int = 0, timed_out: bool = False) -> None:
        self.output = output
        self.returncode = returncode
        self.timed_out = timed_out
        self.calls: list[RunnerCall] = []

    def run_result(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
        cwd: str | None = None,
    ) -> RunResult:
        stdout = self.run(argv, stdin, env, timeout, cwd)
        if self.timed_out:
            return RunResult(stdout="", returncode=None, timed_out=True)
        return RunResult(stdout=stdout, returncode=self.returncode)

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
        cwd: str | None = None,
    ) -> str:
        self.calls.append(record_call(argv, stdin, env, timeout, cwd))
        return self.output


class ScriptedRunner:
    """Returns queued responses in call order.

    Raises `RuntimeError` if called more times than it has scripted
    responses -- a test that over-calls this fake is exercising a path the
    test author did not account for, and a silent extra "ok" would mask that.
    """

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.calls: list[RunnerCall] = []
        self.call_count = 0

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
        cwd: str | None = None,
    ) -> str:
        self.calls.append(record_call(argv, stdin, env, timeout, cwd))
        if self.call_count >= len(self._responses):
            raise RuntimeError(
                f"ScriptedRunner called {self.call_count + 1} time(s) but only "
                f"{len(self._responses)} response(s) were scripted"
            )
        response = self._responses[self.call_count]
        self.call_count += 1
        return response


# Module-level (not a class attribute) so it isn't a mutable default shared
# across instances (RUF012) -- `FakeEmbedder.embed` always copies it via
# `list(...)` before returning, so callers never see or mutate this list.
_PLACEHOLDER_VECTOR: Final[list[float]] = [0.0, 0.0, 0.0]


class FakeEmbedder:
    """An `Embedder` double: no HTTP, no daemon.

    `vectors` is served one entry per `.embed` call, in order; calls past the
    end get a placeholder vector. `fail_on_call` makes that 1-indexed call
    raise `EmbedderUnavailable`; `fail_always` makes every call raise.
    `embedded` records every batch asked for, before the failure check, so a
    test can assert WHAT was embedded rather than only what came back.
    """

    def __init__(
        self,
        vectors: list[list[float]] | None = None,
        *,
        fail_on_call: int | None = None,
        fail_always: bool = False,
    ) -> None:
        self._vectors: list[list[float]] = [list(v) for v in vectors] if vectors else []
        self._fail_on_call = fail_on_call
        self._fail_always = fail_always
        self.call_count = 0
        # Every batch this fake was ASKED to embed, in call order, recorded
        # BEFORE the failure check so a raising call still shows its input.
        # Without it this double answers the same vector whatever it is
        # given, which lets "embed the wrong document" pass a test that
        # asserts only on the vector it handed back (task-6 review, item 2):
        # `/lab`'s drift vector would then describe the version being
        # REPLACED while `contentHash` still looked right. Assert on
        # `embedded` when WHAT was embedded is the property under test.
        self.embedded: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.call_count += 1
        self.embedded.append(list(texts))
        if self._fail_always or self._fail_on_call == self.call_count:
            raise EmbedderUnavailable(f"fake embedder failing on call {self.call_count}")
        index = self.call_count - 1
        if index < len(self._vectors):
            return [self._vectors[index]]
        return [list(_PLACEHOLDER_VECTOR)]


class StubBackend:
    """A `Backend` double that returns a fixed response and records requests.

    Conforms structurally to `swil_agent.llm.protocol.Backend`. Used by planner
    tests to inspect what `plan_round` sends as the system/user prompt
    without invoking a real CLI.
    """

    name = "stub"

    def __init__(self, response: str) -> None:
        self.response = response
        self.calls: list[CompletionRequest] = []
        self.last: CompletionRequest | None = None

    def complete(self, req: CompletionRequest) -> str:
        self.calls.append(req)
        self.last = req
        return self.response


class SilentBackend:
    """Mirrors a real backend producing no output at all.

    Every concrete `Backend` (`ClaudeCLIBackend`, `CodexCLIBackend`,
    `DeepSeekCLIBackend`) signals "nothing came back" by raising
    `BackendUnavailableError` from `complete`, not by returning an empty
    string -- see `llm/runner.py`. A fake that just returned `""` would not be
    exercising the path a real backend actually takes.
    """

    name = "silent"

    def complete(self, req: CompletionRequest) -> str:
        raise BackendUnavailableError("silent backend produced no output")


class ExplodingBackend:
    """Raises a plain (non-`BackendUnavailableError`) exception from
    `complete` -- unlike `SilentBackend`, whose exception `plan_round`
    catches and turns into `None`. `plan_round` only ever catches
    `BackendUnavailableError` (see `act/planner.py`), so this is what a
    genuinely broken step looks like from `run_act`'s point of view: used to
    prove a mid-round failure still propagates out of `run_act` and still
    releases the account lock (`act/round.py`, task 7).
    """

    name = "exploding"

    def complete(self, req: CompletionRequest) -> str:
        raise RuntimeError("exploding backend: boom")


class ScriptedBackend:
    """Answers each `complete` call from a fixed script, in call order.

    A whole CYCLE spends two backend calls on ONE backend object -- the plan,
    then the dream's new 最近 list -- so `StubBackend` (one fixed answer for
    everything) cannot drive one. Calls past the end of the script repeat its
    last entry.
    """

    name = "scripted"

    def __init__(self, *responses: str) -> None:
        self._responses = list(responses)
        self.calls: list[CompletionRequest] = []

    def complete(self, req: CompletionRequest) -> str:
        self.calls.append(req)
        index = len(self.calls) - 1
        if index < len(self._responses):
            return self._responses[index]
        return self._responses[-1] if self._responses else ""


# ── FakeResources (act/executor.py, task 6; extended for act/round.py, task 7) ──


@dataclass(frozen=True)
class RecordedPost:
    """One `Resources.create_post` call `FakeResources` captured.

    `image_topic` is NOT a real `create_post` parameter — the real method
    only ever sees `image: tuple[str, bytes] | None`, a (filename, bytes)
    pair already resolved from a topic string by an `ImageFetcher`. This
    field is derived from that pair's filename half (`image[0]`) purely so
    executor tests can assert "the topic string that reached the image
    fetcher was never run through `collapse_doubled_text`" without adding a
    field to the real API surface. Tests that care about this pin their own
    fake `ImageFetcher` to return `(topic, ...)` verbatim, making
    `image_topic` equal the original topic exactly when nothing mangled it
    in transit.
    """

    text: str
    board_id: str | None
    image_topic: str | None
    echo_of: str | None


@dataclass(frozen=True)
class RecordedComment:
    post_id: str
    text: str
    parent_id: str | None


@dataclass(frozen=True)
class RecordedDM:
    username: str
    text: str


class FakeResources:
    """Records every write call `execute_action` (act/executor.py) attempts.

    Duck-types `swil_agent.api.resources.Resources`'s write surface rather
    than subclassing it — `[tool.mypy] files = ["swil_agent"]` in
    pyproject.toml never type-checks `tests/`, so there is nothing to gain
    from a real subclass, only a matching call shape at runtime.

    Failure knobs, each `None`/`False` by default (every call succeeds):
      - `fail_first_comment`: the FIRST `create_comment` call raises an
        `ApiError` shaped like the server's real "parentId does not belong
        to postId" 404 (`comments.service.ts`), regardless of whether a
        `parent_id` was given; every later call succeeds. This is what lets
        one instance drive both the comment-retry-succeeds and the
        plain-top-level-failure tests from the same fake.
      - `comment_returns_no_id`: EVERY `create_comment` call raises
        `WriteNotVerifiedError` — the codex silent-fail shape (a 2xx with no
        id) this task exists to close off. Also useful for exercising "the
        retry attempt itself fails".
      - `post_raises` / `like_raises` / `dm_raises`: if set, the
        corresponding method raises this exact exception on every call.
      - `follow_raises`: if set, `.follow()` raises this exact exception
        instead of recording a follow. Since ruling R20 this faithfully
        models a 409 too: `Resources.follow` no longer swallows CONFLICT, so
        every non-2xx reaches the caller as an `ApiError` exactly as this
        fake delivers it. Before R20 it did NOT -- the real method returned
        on CONFLICT, so any test passing a 409 here was driving a state
        production could not reach.
      - `post_id`: if set, `create_post` always returns this exact string
        instead of the auto-incrementing `f"post-{n}"` — added for
        `act/round.py`'s memory-line tests, which pin an exact resource id
        (`task-7-brief.md`'s own literal `"newpost0000000000000000"`) into
        the expected memory.md line and need a deterministic id to match it
        against, not merely a stable-shaped one.

    Extended for `act/round.py` (task 7) with `build_context`'s READ surface
    (`feed_global`, `notifications`, `get_post`, `get_comments`, `contacts`,
    `conversations`) — duck-typed identically to the local `FakeResources` in
    `test_act_context.py` (that file is untouched; this is a parallel,
    merged copy so a single instance can drive a full `run_act` round, which
    needs both halves of `Resources` at once). Every read method returns an
    empty/default result unless populated via the plain public attributes
    below (`recommended`, `latest`, `notification_items`, `contacts_result`,
    `conversation_items`, `posts`, `thread_comments`), or raises `ApiError`
    for a name passed to `fail()` / a post id passed to `fail_post()`. Read
    calls are NOT recorded into `self.calls` — that list stays scoped to
    writes, matching its existing use by `test_missing_fields_skip_...`.

    Extended again for `dream/round.py` (task 12) with `create_snapshot`.
    `snapshot_raises`, if set, is raised on every call instead of recording
    one -- used to pin that a snapshot failure is a WARN, not a rollback
    (contract `03` §4.9). `order`, if given, gets `"snapshot_upload"`
    appended on every `create_snapshot` call -- the same shared-list
    mechanism `FakePersonaSource` uses, so a single list threaded through
    both fakes lets a test observe `run_dream`'s full write order without a
    `recorder=` parameter on `run_dream` itself (ruling R8).

    Extended a third time (task 12, fix round 1, item 1) with
    `lab_event_raises`: if set, `lab_event` raises instead of recording --
    a fake that BREAKS `Resources.lab_event`'s never-raises contract, for the
    callers that defend against any `Resources` anyway.
    """

    def __init__(
        self,
        *,
        fail_first_comment: bool = False,
        comment_returns_no_id: bool = False,
        post_raises: ApiError | WriteNotVerifiedError | None = None,
        like_raises: ApiError | WriteNotVerifiedError | None = None,
        dm_raises: ApiError | WriteNotVerifiedError | None = None,
        follow_raises: ApiError | WriteNotVerifiedError | None = None,
        update_profile_raises: ApiError | None = None,
        post_id: str | None = None,
        snapshot_raises: ApiError | WriteNotVerifiedError | None = None,
        behavior_snapshot_raises: ApiError | WriteNotVerifiedError | None = None,
        population_metric_raises: ApiError | WriteNotVerifiedError | None = None,
        intervention_raises: ApiError | WriteNotVerifiedError | None = None,
        lab_event_raises: Exception | None = None,
        order: list[str] | None = None,
        post_vector_ok: bool = True,
    ) -> None:
        self._fail_first_comment = fail_first_comment
        self._comment_returns_no_id = comment_returns_no_id
        self._post_raises = post_raises
        self._snapshot_raises = snapshot_raises
        self._behavior_snapshot_raises = behavior_snapshot_raises
        self._population_metric_raises = population_metric_raises
        self._intervention_raises = intervention_raises
        self._lab_event_raises = lab_event_raises
        self._order = order
        self._post_vector_ok = post_vector_ok
        self._like_raises = like_raises
        self._dm_raises = dm_raises
        self._follow_raises = follow_raises
        self._update_profile_raises = update_profile_raises
        self._post_id_override = post_id
        self._comment_call_count = 0

        self.calls: list[str] = []
        self.created_posts: list[RecordedPost] = []
        self.comments: list[RecordedComment] = []
        self.liked: list[str] = []
        self.followed: list[str] = []
        self.dms: list[RecordedDM] = []
        self.lab_events: list[LabEvent] = []
        self.lab_event_usernames: list[str] = []
        # Kept apart from `lab_events`: `record_intervention` is the LOUD twin
        # of `lab_event` (it raises rather than swallowing), and a test that
        # could not tell which method a caller used could not tell a
        # fire-and-forget observability write from a deliberate human record.
        self.interventions: list[tuple[str, LabEvent]] = []
        self.snapshots: list[tuple[str, dict[str, Any]]] = []
        # S2 post-vector ingests, as (username, kwargs). Kept out of `calls`
        # like the other non-executor writes; `post_vector_ok=False` makes
        # the fake answer the way `Resources.post_vector` does on a rejection.
        self.post_vectors: list[tuple[str, dict[str, Any]]] = []

        # Read surface (act/context.py's build_context) — see class
        # docstring's "Extended for act/round.py" note.
        self._fail: set[str] = set()
        self._fail_posts: set[str] = set()
        self.recommended: list[dict[str, Any]] = []
        self.latest: list[dict[str, Any]] = []
        self.notification_items: list[dict[str, Any]] = []
        self.contacts_result: list[str] = []
        self.conversation_items: list[dict[str, Any]] = []
        self.posts: dict[str, dict[str, Any]] = {}
        self.thread_comments: dict[str, list[dict[str, Any]]] = {}

        # Board resolution (act/round.py, task 7 fix round 1 item 5):
        # slug -> id, mirroring Resources.get_boards()'s real shape.
        self.board_lookup: dict[str, str] = {}
        self.get_boards_calls = 0

        # Board-scoped reads (act/context.py, Phase B task 3). `board_feeds`
        # is slug -> items; a slug with no entry returns [], which is a real
        # production state (`making` carried 4 posts roster-wide at the last
        # count). `feed_board_calls` records (slug, limit, sort) so a test can
        # pin WHICH board a round read and with what pass -- kept apart from
        # `calls`, which is scoped to writes.
        self.board_feeds: dict[str, list[dict[str, Any]]] = {}
        self.feed_board_calls: list[tuple[str, int, str]] = []
        # Era 3: every feed/search read's `since`, as (endpoint, since).
        self.since_calls: list[tuple[str, str | None]] = []

        # Topic search (act/context.py's follow-topics world-context block).
        # `search_results` is topic -> items; `search_calls` records
        # (query, limit) so a test can pin WHICH topics a round searched.
        self.search_results: dict[str, list[dict[str, Any]]] = {}
        self.search_calls: list[tuple[str, int]] = []

        # agentBackend sync + smart mark-read (task 13 fix wave, F8/F3).
        # Recorded in their OWN lists, not in `self.calls`: that list is
        # scoped to the writes `execute_action` attempts (see the class
        # docstring), and several tests assert it is exactly empty to prove
        # a plan never reached the executor. Neither of these two calls
        # comes from the executor.
        self.profile_patches: list[dict[str, Any]] = []
        self.marked_read: list[list[str] | None] = []

        # analysis/ surface (Plan 4). `user_post_items` seeds what
        # `user_posts` returns; `user_posts_calls` records (username, limit)
        # so a test can pin WHICH account was sampled and with what window --
        # the folder name and the `Username` bullet differ on this roster.
        self.user_post_items: list[dict[str, Any]] = []
        self.user_posts_calls: list[tuple[str, int]] = []
        self.behavior_snapshots: list[tuple[str, dict[str, Any]]] = []
        self.population_metric_data: dict[str, Any] = {
            "capturedAt": "2026-08-19T00:00:00.000Z",
            "personaCohesion": 0.71,
            "behaviorCohesion": 0.63,
            "n": 23,
        }

    def fail(self, name: str) -> None:
        """Make the named read call raise `ApiError`. `name` is one of
        `"feed_global_recommended"`, `"feed_global_latest"`,
        `"notifications"`, `"contacts"`, `"conversations"`, `"get_boards"`,
        `"user_posts"` — matching `test_act_context.py`'s local fake, plus
        `get_boards` and `analysis/`'s one read. `"feed_board_<slug>"` fails
        the board-scoped read for one slug (Phase B task 3)."""
        self._fail.add(name)

    def get_boards(self) -> dict[str, str]:
        self.get_boards_calls += 1
        if "get_boards" in self._fail:
            raise ApiError(500, "boom", None)
        return self.board_lookup

    def fail_post(self, post_id: str) -> None:
        """Make `get_post`/`get_comments` raise `ApiError` for this one id."""
        self._fail_posts.add(post_id)

    def feed_global(self, limit: int, sort: str, since: str | None = None) -> list[dict[str, Any]]:
        self.since_calls.append(("feed_global", since))
        if f"feed_global_{sort}" in self._fail:
            raise ApiError(500, "boom", None)
        return self.recommended if sort == "recommended" else self.latest

    def feed_board(
        self, slug: str, limit: int = 12, sort: str = "latest", since: str | None = None
    ) -> list[dict[str, Any]]:
        self.feed_board_calls.append((slug, limit, sort))
        self.since_calls.append((f"feed_board:{slug}", since))
        if f"feed_board_{slug}" in self._fail:
            raise ApiError(500, "boom", None)
        return self.board_feeds.get(slug, [])

    def notifications(self, limit: int, unread_only: bool = True) -> list[dict[str, Any]]:
        if "notifications" in self._fail:
            raise ApiError(500, "boom", None)
        return self.notification_items

    def get_post(self, post_id: str) -> dict[str, Any]:
        if post_id in self._fail_posts:
            raise ApiError(500, "boom", None)
        return self.posts.get(post_id, {"id": post_id})

    def get_comments(self, post_id: str, limit: int = 6) -> list[dict[str, Any]]:
        if post_id in self._fail_posts:
            raise ApiError(500, "boom", None)
        return self.thread_comments.get(post_id, [])

    def search_posts(
        self, q: str, limit: int = 12, since: str | None = None
    ) -> list[dict[str, Any]]:
        """`/posts/search`, the follow-topics world-context read.

        Recorded in its OWN list rather than in `self.calls`, which is scoped
        to the writes `execute_action` attempts -- several tests assert that
        list is exactly empty to prove a plan never reached the executor, and
        this call comes from the context build.
        """
        self.search_calls.append((q, limit))
        self.since_calls.append(("search_posts", since))
        if f"search_{q}" in self._fail:
            raise ApiError(500, "boom", None)
        return self.search_results.get(q, [])

    def contacts(self) -> list[str]:
        if "contacts" in self._fail:
            raise ApiError(500, "boom", None)
        return self.contacts_result

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        if "conversations" in self._fail:
            raise ApiError(500, "boom", None)
        return self.conversation_items

    def create_post(
        self,
        text: str,
        board_id: str | None = None,
        image: tuple[str, bytes] | None = None,
        echo_of: str | None = None,
    ) -> str:
        self.calls.append("create_post")
        self.created_posts.append(
            RecordedPost(
                text=text,
                board_id=board_id,
                image_topic=image[0] if image is not None else None,
                echo_of=echo_of,
            )
        )
        if self._post_raises is not None:
            raise self._post_raises
        if self._post_id_override is not None:
            return self._post_id_override
        return f"post-{len(self.created_posts)}"

    def create_comment(self, post_id: str, text: str, parent_id: str | None = None) -> str:
        self.calls.append("create_comment")
        self.comments.append(RecordedComment(post_id=post_id, text=text, parent_id=parent_id))
        self._comment_call_count += 1
        if self._comment_returns_no_id:
            raise WriteNotVerifiedError(
                f"comment created no id; response={{}} (call {self._comment_call_count})"
            )
        if self._fail_first_comment and self._comment_call_count == 1:
            raise ApiError(
                404,
                '{"error":{"code":"NOT_FOUND","message":"Parent comment not found"}}',
                "NOT_FOUND",
            )
        return f"comment-{len(self.comments)}"

    def like_post(self, post_id: str) -> None:
        self.calls.append("like_post")
        if self._like_raises is not None:
            raise self._like_raises
        self.liked.append(post_id)

    def follow(self, username: str) -> None:
        self.calls.append("follow")
        if self._follow_raises is not None:
            raise self._follow_raises
        self.followed.append(username)

    def send_dm(self, username: str, text: str) -> tuple[str, str]:
        self.calls.append("send_dm")
        if self._dm_raises is not None:
            raise self._dm_raises
        self.dms.append(RecordedDM(username=username, text=text))
        n = len(self.dms)
        return f"conv-{n}", f"dm-{n}"

    def update_profile(self, patch: dict[str, Any]) -> None:
        """`act/round.py`'s `agentBackend` sync (task 13 fix wave, F8).
        `update_profile_raises`, if set, is raised on every call -- used to
        pin that a failed sync is a WARN, not a failed round."""
        if self._update_profile_raises is not None:
            raise self._update_profile_raises
        self.profile_patches.append(patch)

    def mark_notifications_read(self, ids: list[str] | None = None) -> None:
        """`act/round.py`'s smart mark-read (task 13 fix wave, F3). Records
        `None` for the `{"all": true}` shape and the id list otherwise, so a
        test can tell the two branches apart -- they are different server
        endpoints' bodies, not two spellings of one.

        MIRRORS the real method's empty-list guard (ruling R20's fake-fidelity
        audit): `Resources.mark_notifications_read([])` returns without any
        HTTP call, because the server's `ids` branch is `.min(1)` and would
        400. `act/round.py` DOES reach that call with `[]` -- a plan with a
        comment whose notifications none of match -- so a fake that recorded
        it would show a wire call production never makes, and a test asserting
        on `marked_read` would be describing the fake rather than the code."""
        if ids is not None and not ids:
            return
        self.marked_read.append(list(ids) if ids is not None else None)

    def lab_event(self, username: str, event: LabEvent) -> None:
        if self._lab_event_raises is not None:
            raise self._lab_event_raises
        # The username is recorded alongside the event, in call order, so a
        # test can pin WHICH account a row was filed under. The folder name
        # and the `Username` bullet differ for four accounts on this roster,
        # and every fake whose two names match makes that slip invisible
        # (standing constraint §4).
        self.lab_event_usernames.append(username)
        self.lab_events.append(event)

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
        self.post_vectors.append(
            (
                username,
                {
                    "post_id": post_id,
                    "round_id": round_id,
                    "embedding": list(embedding),
                    "card_sim": card_sim,
                    "max_sim": max_sim,
                },
            )
        )
        return self._post_vector_ok

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
        """The backfill's outcome-carrying twin, over the same recording."""
        ok = self.post_vector(
            username,
            post_id=post_id,
            round_id=round_id,
            embedding=embedding,
            card_sim=card_sim,
            max_sim=max_sim,
        )
        return VectorFiling("filed" if ok else "failed")

    def create_snapshot(self, username: str, payload: dict[str, Any]) -> str:
        self.calls.append("create_snapshot")
        self.snapshots.append((username, payload))
        if self._order is not None:
            self._order.append("snapshot_upload")
        if self._snapshot_raises is not None:
            raise self._snapshot_raises
        return "snap-1"

    # ── analysis/ surface (Plan 4) ────────────────────────────────────────
    #
    # `user_posts` is a READ and therefore stays out of `self.calls`, like
    # every other read above. `create_behavior_snapshot` is a WRITE to a
    # DIFFERENT endpoint from `create_snapshot` -- the behavior half of the
    # /lab fidelity pair -- and records into its own list so a test can tell
    # a personality snapshot from a behaviour one without inspecting bodies.

    def user_posts(self, username: str, limit: int = 12) -> list[dict[str, Any]]:
        self.user_posts_calls.append((username, limit))
        if "user_posts" in self._fail:
            raise ApiError(500, "boom", None)
        return list(self.user_post_items)

    def create_behavior_snapshot(
        self, username: str, payload: dict[str, Any]
    ) -> tuple[str, float | None]:
        self.calls.append("create_behavior_snapshot")
        self.behavior_snapshots.append((username, payload))
        if self._behavior_snapshot_raises is not None:
            raise self._behavior_snapshot_raises
        return "behavior-1", 0.77

    def record_population_metric(self) -> dict[str, Any]:
        self.calls.append("record_population_metric")
        if self._population_metric_raises is not None:
            raise self._population_metric_raises
        return dict(self.population_metric_data)

    def record_intervention(self, username: str, event: LabEvent) -> str:
        self.calls.append("record_intervention")
        self.interventions.append((username, event))
        if self._intervention_raises is not None:
            raise self._intervention_raises
        return f"evt-{len(self.interventions)}"


# ── FakeState (dream/candidate.py) ──────────────────────────────────────────


class FakeState:
    """An in-memory `dream.candidate.DreamState` double for cooldown tests.

    Production's `FilesystemDreamState` reads `<state_dir>/last_dream_<name>`.
    This fake skips the filesystem so a test can pin an exact elapsed-seconds
    value at a cooldown boundary. `order`, if given, gets `"marker_last_dream"`
    appended on every `record_dream`, so a write-order test can thread one list
    through this fake, `FakePersonaSource` and `FakeResources`.
    """

    def __init__(self, *, order: list[str] | None = None) -> None:
        self._ts: dict[str, int] = {}
        self._order = order

    def set_last_dream(
        self,
        *,
        hours_ago: float = 0,
        minutes_ago: float = 0,
        name: str = "zenith",
        at: int | None = None,
    ) -> None:
        seconds_ago = hours_ago * 3600 + minutes_ago * 60
        self._ts[name] = at if at is not None else int(time.time() - seconds_ago)

    def last_dream_ts(self, name: str) -> int | None:
        return self._ts.get(name)

    def record_dream(self, name: str, *, at: int) -> None:
        if self._order is not None:
            self._order.append("marker_last_dream")
        self._ts[name] = at


# ── FakePersonaSource (persona/source.py's PersonaSource) ───────────────────


class FakePersonaSource:
    """An in-memory `persona.source.PersonaSource` double.

    `write_recent` records the call and appends `"write_recent"` to a shared
    `order` list (when one is supplied); `append_memory` appends
    `"memory_append"`. Tests that need real bytes on disk use the real
    `GitPersonaSource` against a `tmp_path` roster instead.
    """

    def __init__(
        self, personas: dict[str, Persona] | None = None, *, order: list[str] | None = None
    ) -> None:
        self._personas = personas or {}
        self._order = order
        self.memory: dict[str, str] = {}
        self.written: list[tuple[str, list[str], datetime]] = []
        self.appended: list[tuple[str, str]] = []

    def load(self, name: str) -> Persona:
        return self._personas[name]

    def write_recent(self, name: str, recent: Sequence[str], when: datetime) -> str:
        if self._order is not None:
            self._order.append("write_recent")
        self.written.append((name, list(recent), when))
        return ""

    def read_memory(self, name: str) -> str:
        return self.memory.get(name, "")

    def append_memory(self, name: str, line: str) -> None:
        if self._order is not None:
            self._order.append("memory_append")
        self.appended.append((name, line))


def make_cycle_deps(agent_root: Path, **overrides: Any) -> CycleDeps:
    """THE `CycleDeps` builder for tests: every collaborator a harmless
    double, a planner that answers `nothing`, settings rooted at
    `agent_root`. Override any field; a test file's own `_deps` passes only
    what differs for that file."""
    fields: dict[str, Any] = {
        "resources": FakeResources(),
        "backend": StubBackend('{"plan":[{"action":"nothing"}]}'),
        "persona_source": FakePersonaSource(),
        "embedder": FakeEmbedder(),
        "dream_state": FakeState(),
        "settings": Settings(agent_root=agent_root),
        "agent_root": agent_root,
        "health_check": lambda: True,
        "memory_text": "",
        "llm_backend": "claude",
        "llm_model": None,
    }
    fields.update(overrides)
    return CycleDeps(**fields)
