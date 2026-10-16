import json

import pytest

from swil_agent.act.executor import execute_action
from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.images import ImageFetchError
from swil_agent.api.resources import WriteNotVerifiedError
from swil_agent.models import Action

from ._runners import FakeResources

CTX = {"agent_name": "testagent", "username": "testuser"}


def _fake_image_fetcher(topic: str, access_key: str, transport: object = None) -> tuple[str, bytes]:
    """Returns the topic verbatim as the "filename" so
    `FakeResources.created_posts[...].image_topic` can prove whether the
    original (uncollapsed) topic string reached the fetcher unchanged."""
    return topic, b"fake-image-bytes"


CTX_WITH_IMAGES = {**CTX, "images": _fake_image_fetcher}


def _failing_image_fetcher(
    topic: str, access_key: str, transport: object = None
) -> tuple[str, bytes]:
    raise ImageFetchError("unsplash and picsum both failed")


def run_and_collect_events(action: Action) -> list[LabEvent]:
    """Execute `action` against a fresh `FakeResources` and return every
    `LabEvent` it recorded via `Resources.lab_event`."""
    resources = FakeResources()
    execute_action(resources, action, **CTX_WITH_IMAGES)
    return resources.lab_events


# ── model-written path targets (S6 AG-F5) ───────────────────────────────


@pytest.mark.parametrize(
    "action",
    [
        Action(kind="comment", post_id="../conversations/" + "a" * 24 + "/messages?", text="hi"),
        Action(kind="comment", post_id="..", text="hi"),
        Action(kind="comment", post_id="A" * 24, text="hi"),
        Action(kind="like", post_id="../../users/vex/follow"),
        Action(kind="like", post_id="a" * 23),
        Action(kind="follow", username="../posts/" + "a" * 24 + "/like"),
        Action(kind="follow", username="ab"),
        Action(kind="follow", username="v" * 25),
    ],
)
def test_an_invalid_path_target_is_a_skip_before_any_request(
    action: Action, caplog: pytest.LogCaptureFixture
) -> None:
    resources = FakeResources()
    with caplog.at_level("WARNING", logger="swil_agent.act.executor"):
        result = execute_action(resources, action, **CTX)
    assert result.landed is False
    assert "invalid" in (result.detail or "")
    assert resources.calls == []
    assert resources.lab_events[-1].outcome == "skip"
    assert resources.lab_events[-1].target_id is None
    assert any(r.getMessage().startswith(f"SKIP testagent {action.kind}") for r in caplog.records)


# ── text cleaning (contract 02, "cross-cutting facts") ──────────────────


def test_post_text_is_collapsed_when_the_model_double_emits() -> None:
    doubled = "这是一段足够长的正文用来触发折叠逻辑需要至少四十个字符" * 2
    resources = FakeResources()
    execute_action(resources, Action(kind="post", text=doubled), **CTX)
    assert resources.created_posts[0].text == doubled[: len(doubled) // 2]


def test_image_topic_is_not_collapsed() -> None:
    topic = "citynight" * 6  # >= 40 chars and an exact self-duplicate
    resources = FakeResources()
    execute_action(
        resources,
        Action(kind="post", text="hi", image_topic=topic),
        **CTX_WITH_IMAGES,
    )
    assert resources.created_posts[0].image_topic == topic


def test_username_is_stripped_of_at_and_whitespace() -> None:
    resources = FakeResources()
    execute_action(resources, Action(kind="follow", username=" @vex \n"), **CTX)
    assert resources.followed == ["vex"]


def test_comment_text_is_collapsed_when_the_model_double_emits() -> None:
    doubled = "这是一段足够长的评论内容用来触发折叠逻辑需要四十字符以上" * 2
    resources = FakeResources()
    execute_action(resources, Action(kind="comment", post_id="f" * 24, text=doubled), **CTX)
    assert resources.comments[0].text == doubled[: len(doubled) // 2]


def test_dm_text_is_collapsed_when_the_model_double_emits() -> None:
    doubled = "这是一段足够长的私信内容用来触发折叠逻辑需要四十字符以上" * 2
    resources = FakeResources()
    execute_action(resources, Action(kind="dm", username="vex", text=doubled), **CTX)
    assert resources.dms[0].text == doubled[: len(doubled) // 2]


# ── skip conditions (contract 02 §2: per-kind field validation, per-action) ──


@pytest.mark.parametrize(
    ("action", "detail"),
    [
        (Action(kind="post", text="   "), "empty text"),
        (Action(kind="comment", text="hi"), "missing postId or text"),
        (Action(kind="comment", post_id="a" * 24), "missing postId or text"),
        (Action(kind="like"), "missing postId"),
        (Action(kind="follow"), "missing username"),
        (Action(kind="echo"), "missing postId"),
        (Action(kind="dm", text="hi"), "missing username or text"),
        (Action(kind="dm", username="vex"), "missing username or text"),
    ],
)
def test_missing_fields_skip_without_calling_the_api(action: Action, detail: str) -> None:
    resources = FakeResources()
    result = execute_action(resources, action, **CTX)
    assert result.landed is False
    assert detail in (result.detail or "")
    assert resources.calls == []


# ── comment parent-id fallback (contract 02 §2.2, spec §6.6) ────────────


def test_comment_retries_top_level_when_the_parent_is_unusable() -> None:
    resources = FakeResources(fail_first_comment=True)
    action = Action(kind="comment", post_id="f" * 24, parent_id="c" * 24, text="hi")
    result = execute_action(resources, action, **CTX)

    assert result.landed is True
    assert result.detail == "parent unusable — posted top-level"
    assert [c.parent_id for c in resources.comments] == ["c" * 24, None]


def test_a_top_level_comment_failure_is_not_retried() -> None:
    resources = FakeResources(fail_first_comment=True)
    action = Action(kind="comment", post_id="f" * 24, text="hi")
    result = execute_action(resources, action, **CTX)

    assert result.landed is False
    assert len(resources.comments) == 1


def test_comment_with_parent_succeeds_without_a_retry() -> None:
    """The plain-success path with a parent_id: no failure, so the retry
    branch never fires and only one comment is recorded."""
    resources = FakeResources()
    action = Action(kind="comment", post_id="f" * 24, parent_id="c" * 24, text="hi")
    result = execute_action(resources, action, **CTX)

    assert result.landed is True
    assert result.detail is None
    assert len(resources.comments) == 1


def test_comment_retry_that_also_fails_reports_the_retry_error() -> None:
    """Both the primary attempt AND the top-level retry fail (e.g. the whole
    endpoint is down): the retry's own error is what reaches ActionResult,
    not the primary's.

    `FakeResources(comment_returns_no_id=True)` raises a distinct
    `WriteNotVerifiedError` on every call, its message tagged with the call
    number ("... (call 1)", "... (call 2)") specifically so this test can
    tell WHICH of the two failures supplied `result.detail` -- a bare
    `"not verified" in detail` check (both messages carry that substring)
    cannot distinguish "the retry's error reached the result" from "the
    primary's error did", so it cannot fail for the reason this test names.
    Asserting on "call 2" (present) and "call 1" (absent) is what actually
    pins the retry's error, not the primary's, as the value that survived.
    """
    resources = FakeResources(comment_returns_no_id=True)
    action = Action(kind="comment", post_id="f" * 24, parent_id="c" * 24, text="hi")
    result = execute_action(resources, action, **CTX)

    assert result.landed is False
    assert len(resources.comments) == 2
    assert "call 2" in (result.detail or "")
    assert "call 1" not in (result.detail or "")


# ── write verification (design spec §7.2 — the point of this module) ────


def test_a_200_without_a_resource_id_does_not_count_as_landed() -> None:
    resources = FakeResources(comment_returns_no_id=True)
    action = Action(kind="comment", post_id="f" * 24, text="hi")
    result = execute_action(resources, action, **CTX)
    assert result.landed is False
    assert "not verified" in (result.detail or "")


def test_post_write_not_verified_does_not_count_as_landed() -> None:
    resources = FakeResources(post_raises=WriteNotVerifiedError("post created no id"))
    result = execute_action(resources, Action(kind="post", text="hello world"), **CTX)
    assert result.landed is False
    assert "not verified" in (result.detail or "")


def test_an_api_error_response_body_survives_into_detail() -> None:
    """`2>/dev/null` is why `"Invalid id"` is invisible in today's bash
    logs (design spec §7.6) -- the response body must reach `detail`."""
    resources = FakeResources(like_raises=ApiError(400, "Invalid id", None))
    result = execute_action(resources, Action(kind="like", post_id="f" * 24), **CTX)
    assert result.landed is False
    assert "Invalid id" in (result.detail or "")


# ── follow landed (loop-engine spec §6) ──────────────────────────────────


def test_verified_follow_lands_and_the_call_succeeds() -> None:
    resources = FakeResources()
    result = execute_action(resources, Action(kind="follow", username="vex"), **CTX)
    assert result.landed is True
    assert result.call_succeeded is True
    assert result.detail is None
    assert resources.followed == ["vex"]


def test_follow_409_conflict_is_idempotent_success_with_no_memory_line() -> None:
    resources = FakeResources(
        follow_raises=ApiError(409, "Already following this user", "CONFLICT")
    )
    result = execute_action(resources, Action(kind="follow", username="vex"), **CTX)
    assert result.landed is True
    assert result.call_succeeded is False
    assert resources.lab_events[-1].outcome == "warn"


def test_follow_missing_username_skips_and_does_not_land() -> None:
    resources = FakeResources()
    result = execute_action(resources, Action(kind="follow"), **CTX)
    assert result.landed is False
    assert result.call_succeeded is False
    assert resources.calls == []
    assert resources.lab_events[-1].outcome == "skip"


@pytest.mark.parametrize(
    "exc",
    [
        ApiError(500, "boom", None),
        ApiError(400, "bad", None),
        WriteNotVerifiedError("follow returned unexpected status 200"),
    ],
)
def test_follow_other_write_failures_do_not_land(exc: ApiError | WriteNotVerifiedError) -> None:
    resources = FakeResources(follow_raises=exc)
    result = execute_action(resources, Action(kind="follow", username="vex"), **CTX)
    assert result.landed is False
    assert result.call_succeeded is False
    assert "likely already following" not in (result.detail or "")


# ── per-kind happy paths (contract 02 §2, "each kind maps to one call") ──


def test_like_success() -> None:
    resources = FakeResources()
    result = execute_action(resources, Action(kind="like", post_id="f" * 24), **CTX)
    assert result.landed is True
    assert resources.liked == ["f" * 24]


def test_like_failure_is_not_swallowed() -> None:
    resources = FakeResources(like_raises=ApiError(500, "boom", None))
    result = execute_action(resources, Action(kind="like", post_id="f" * 24), **CTX)
    assert result.landed is False
    assert resources.liked == []


def test_echo_success_carries_the_quote_and_the_echoed_post_id() -> None:
    resources = FakeResources()
    result = execute_action(
        resources, Action(kind="echo", post_id="f" * 24, text="nice take"), **CTX
    )
    assert result.landed is True
    assert resources.created_posts[0].echo_of == "f" * 24
    assert resources.created_posts[0].text == "nice take"


def test_echo_without_a_quote_is_a_plain_repost() -> None:
    """Empty text is fine for echo -- only postId gates the skip."""
    resources = FakeResources()
    result = execute_action(resources, Action(kind="echo", post_id="f" * 24), **CTX)
    assert result.landed is True
    assert resources.created_posts[0].text == ""
    assert resources.created_posts[0].echo_of == "f" * 24


def test_a_bom_only_quote_falls_back_to_the_plain_echo_summary() -> None:
    """JS `trim()` removes U+FEFF but Python `strip()` keeps it; the server would
    refuse a BOM-only summary, so the fallback must apply."""
    resources = FakeResources()
    result = execute_action(
        resources, Action(kind="echo", post_id="f" * 24, text="\ufeff\u00a0\ufeff"), **CTX
    )
    assert result.landed is True
    assert resources.lab_events[-1].summary == "echoed post"


def test_echo_failure_is_not_swallowed() -> None:
    resources = FakeResources(post_raises=ApiError(404, "not found", None))
    result = execute_action(resources, Action(kind="echo", post_id="f" * 24), **CTX)
    assert result.landed is False


def test_dm_success_reaches_resources_with_the_full_text() -> None:
    resources = FakeResources()
    result = execute_action(resources, Action(kind="dm", username="vex", text="hey there"), **CTX)
    assert result.landed is True
    assert resources.dms[0].username == "vex"
    assert resources.dms[0].text == "hey there"


def test_dm_success_records_the_conversation_id() -> None:
    """`ActionResult.conversation_id` (fix round 1, task-7 review item 4):
    `Resources.send_dm` now returns `(conversation_id, message_id)`, and
    `resource_id` must keep meaning "id of the thing I created" (the
    message) while `conversation_id` carries the second id separately —
    proving the two are not swapped or collapsed into one field."""
    resources = FakeResources()
    result = execute_action(resources, Action(kind="dm", username="vex", text="hey"), **CTX)
    assert result.resource_id == "dm-1"
    assert result.conversation_id == "conv-1"


def test_a_failed_dm_never_records_a_conversation_id() -> None:
    resources = FakeResources(dm_raises=ApiError(500, "boom", None))
    result = execute_action(resources, Action(kind="dm", username="vex", text="hey"), **CTX)
    assert result.conversation_id is None


def test_non_dm_actions_never_populate_conversation_id() -> None:
    resources = FakeResources()
    result = execute_action(resources, Action(kind="like", post_id="f" * 24), **CTX)
    assert result.conversation_id is None


def test_dm_failure_is_not_swallowed() -> None:
    resources = FakeResources(dm_raises=ApiError(500, "boom", None))
    result = execute_action(resources, Action(kind="dm", username="vex", text="hey"), **CTX)
    assert result.landed is False
    assert resources.dms == []


def test_nothing_never_touches_the_api() -> None:
    resources = FakeResources()
    result = execute_action(resources, Action(kind="nothing"), **CTX)
    assert result.landed is True
    assert result.detail is None
    assert resources.calls == []


def test_post_request_failure_is_not_swallowed() -> None:
    resources = FakeResources(post_raises=ApiError(500, "boom", None))
    result = execute_action(resources, Action(kind="post", text="hello world"), **CTX)
    assert result.landed is False


def test_board_id_is_passed_through_to_create_post() -> None:
    resources = FakeResources()
    execute_action(resources, Action(kind="post", text="hello"), **CTX, board_id="board-9")
    assert resources.created_posts[0].board_id == "board-9"


# ── image handling (contract 02 §2.1) ────────────────────────────────────


def test_post_with_image_topic_fetches_and_attaches_the_image() -> None:
    resources = FakeResources()
    result = execute_action(
        resources,
        Action(kind="post", text="hello", image_topic="sunset over water"),
        **CTX_WITH_IMAGES,
    )
    assert result.landed is True
    assert result.detail is None
    assert resources.created_posts[0].image_topic == "sunset over water"


def test_image_fetch_failure_degrades_to_a_text_only_post() -> None:
    """Bash degrades silently here (empty IMGFILE -> text-only, no error
    surfaced) -- contract 02 §2.1. This module keeps the degrade but records
    it in detail instead of staying silent."""
    resources = FakeResources()
    result = execute_action(
        resources,
        Action(kind="post", text="hello", image_topic="sunset"),
        agent_name="testagent",
        username="testuser",
        images=_failing_image_fetcher,
    )
    assert result.landed is True
    assert "image fetch failed" in (result.detail or "")
    assert resources.created_posts[0].image_topic is None  # no image reached create_post


# ── lab events (contract 02 §5.3 — exact per-call-site tuples) ──────────


def test_dm_lab_event_never_carries_the_message_body() -> None:
    events = run_and_collect_events(Action(kind="dm", username="vex", text="secret words"))
    assert events[-1].summary == "→@vex"
    assert "secret" not in json.dumps([e.to_wire() for e in events])


def test_post_lab_event_truncates_the_summary_to_200_chars() -> None:
    events = run_and_collect_events(Action(kind="post", text="y" * 500))
    assert events[-1].summary == "y" * 200


def test_comment_lab_event_carries_the_post_id_as_target() -> None:
    events = run_and_collect_events(Action(kind="comment", post_id="f" * 24, text="hi"))
    assert events[-1].target_id == "f" * 24


def test_like_lab_event_is_pinned_to_the_exact_summary() -> None:
    events = run_and_collect_events(Action(kind="like", post_id="f" * 24))
    assert events[-1].outcome == "success"
    assert events[-1].summary == "liked post"
    assert events[-1].target_id == "f" * 24


def test_follow_lab_event_carries_the_followed_username() -> None:
    events = run_and_collect_events(Action(kind="follow", username="vex"))
    assert events[-1].outcome == "success"
    assert events[-1].summary == "followed @vex"


def test_nothing_lab_event_is_pinned_to_the_exact_summary() -> None:
    events = run_and_collect_events(Action(kind="nothing"))
    assert events[-1].outcome == "success"
    assert events[-1].action == "nothing"
    assert events[-1].summary == "chose to do nothing"


def test_skip_lab_event_never_carries_an_action_field_for_missing_fields() -> None:
    """Sanity check that the skip path still emits a well-formed LabEvent --
    `LabEvent.to_wire()` omits action/reason/targetId when empty (api/dto.py),
    but `action` here is a real, non-empty kind, so it must be present."""
    events = run_and_collect_events(Action(kind="like"))
    assert events[-1].outcome == "skip"
    assert events[-1].to_wire()["action"] == "like"
