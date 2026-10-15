"""The BYOK backend, exercised against a mock transport rather than a mock library.

`httpx.MockTransport` is the same injection seam `cli.py`'s `_health_check`
already uses, and it means these tests run the REAL request-building and
response-parsing code -- the two places a provider swap actually breaks.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from swil_agent.llm.api_backend import ApiBackend
from swil_agent.llm.errors import BackendConfigurationError, BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest

REQ = CompletionRequest(system="SYS", user="USR")


class Capture:
    """Records the one request the backend makes and replies with a canned body."""

    def __init__(self, payload: Any, status: int = 200, body: str | None = None) -> None:
        self._payload = payload
        self._status = status
        self._body = body
        self.request: httpx.Request | None = None

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            self.request = request
            if self._body is not None:
                return httpx.Response(self._status, text=self._body)
            return httpx.Response(self._status, json=self._payload)

        return httpx.MockTransport(handler)

    def sent(self) -> dict[str, Any]:
        assert self.request is not None
        parsed = json.loads(self.request.content)
        assert isinstance(parsed, dict)
        return parsed


def _backend(capture: Capture, *, provider: str = "xai", **kwargs: Any) -> ApiBackend:
    defaults: dict[str, Any] = {
        "provider": provider,
        "base_url": "https://api.x.ai/v1" if provider == "xai" else "https://api.anthropic.com",
        "api_key": "test-key",
        "model": "grok-4.6",
        "max_tokens": 1024,
        "transport": capture.transport(),
    }
    defaults.update(kwargs)
    return ApiBackend(**defaults)


# ── the OpenAI-shaped protocol ────────────────────────────────────────────


def test_openai_request_shape() -> None:
    capture = Capture({"choices": [{"message": {"content": "hello"}}]})
    assert _backend(capture).complete(REQ) == "hello"

    request = capture.request
    assert request is not None
    assert str(request.url) == "https://api.x.ai/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer test-key"
    body = capture.sent()
    assert body["model"] == "grok-4.6"
    assert body["messages"] == [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "USR"},
    ]


def test_no_tools_are_ever_requested() -> None:
    """The CLI backends carry `--tools ""` / `-s read-only` because a persona
    model with filesystem access can put its answer on disk instead of
    returning it, which turns the constitution layer into a suggestion. A chat
    completions call has no tools unless the body asks for them; this pins that
    the body never does."""
    capture = Capture({"choices": [{"message": {"content": "x"}}]})
    _backend(capture).complete(REQ)
    body = capture.sent()
    assert "tools" not in body
    assert "tool_choice" not in body
    assert "functions" not in body


def test_request_model_overrides_the_configured_one() -> None:
    """`CompletionRequest.model` is how the persona's own model reaches every
    backend today; the API backend must honour it identically."""
    capture = Capture({"choices": [{"message": {"content": "x"}}]})
    _backend(capture).complete(CompletionRequest(system="S", user="U", model="grok-mini"))
    assert capture.sent()["model"] == "grok-mini"


def test_configured_model_is_the_fallback_when_the_request_names_none() -> None:
    """`dream/round.py`'s `_diff_narrative` passes `model=None` on purpose to
    get the backend's own default. A CLI has one; an API backend's default is
    whatever it was configured with."""
    capture = Capture({"choices": [{"message": {"content": "x"}}]})
    _backend(capture).complete(CompletionRequest(system="S", user="U", model=None))
    assert capture.sent()["model"] == "grok-4.6"


def test_reasoning_content_is_not_used_as_the_answer() -> None:
    """Several reasoning models populate `reasoning_content` beside an empty
    `content`. That field is chain-of-thought: posting it would put a model's
    scratchpad into a persona's timeline AND into the drift series measuring
    that persona's voice."""
    capture = Capture(
        {"choices": [{"message": {"content": "", "reasoning_content": "let me think..."}}]}
    )
    with pytest.raises(BackendUnavailableError, match="produced no output"):
        _backend(capture).complete(REQ)


# ── the Anthropic protocol ────────────────────────────────────────────────


def test_anthropic_request_shape() -> None:
    capture = Capture({"content": [{"type": "text", "text": "hi"}]})
    backend = _backend(capture, provider="anthropic", model="claude-opus-4")
    assert backend.complete(REQ) == "hi"

    request = capture.request
    assert request is not None
    assert str(request.url) == "https://api.anthropic.com/v1/messages"
    assert request.headers["x-api-key"] == "test-key"
    assert request.headers["anthropic-version"] == "2023-06-01"
    body = capture.sent()
    # The system prompt is a TOP-LEVEL field here, not the first message. Sent
    # as a message it is silently demoted to user turn content.
    assert body["system"] == "SYS"
    assert body["messages"] == [{"role": "user", "content": "USR"}]
    assert body["max_tokens"] == 1024


def test_anthropic_joins_every_text_block() -> None:
    """A Messages response is a LIST of blocks. `content[0]["text"]` would drop
    everything after the first, which for a two-paragraph persona post is most
    of the post -- and the truncation would look like a terse model, not a bug."""
    capture = Capture(
        {
            "content": [
                {"type": "text", "text": "first. "},
                {"type": "thinking", "thinking": "ignored"},
                {"type": "text", "text": "second."},
            ]
        }
    )
    backend = _backend(capture, provider="anthropic", model="claude-opus-4")
    assert backend.complete(REQ) == "first. second."


# ── failure semantics ─────────────────────────────────────────────────────


@pytest.mark.parametrize("status", [401, 403, 404])
def test_auth_and_model_errors_are_configuration_errors(status: int) -> None:
    """These three are setup problems an operator fixes in a config file. As
    `BackendUnavailableError` they would be caught by every "the LLM said
    nothing" handler and degrade into a quiet no-action round -- the exact
    shape of the "no response from codex" incidents, where a whole backend's
    accounts dropped out of a round with nothing loud to say why."""
    capture = Capture({"error": "nope"}, status=status)
    with pytest.raises(BackendConfigurationError) as excinfo:
        _backend(capture).complete(REQ)
    assert str(status) in str(excinfo.value)


@pytest.mark.parametrize("status", [429, 500, 503])
def test_transient_statuses_degrade_like_a_dead_cli(status: int) -> None:
    capture = Capture({"error": "later"}, status=status)
    with pytest.raises(BackendUnavailableError):
        _backend(capture).complete(REQ)


def test_the_error_body_reaches_the_message() -> None:
    """`swil.sh` sent curl's stderr to /dev/null, which made "HTTP 400: Invalid
    id" invisible in auto-run.log for months. A provider's error body is where
    "model not found" and "insufficient quota" actually say so."""
    capture = Capture(None, status=404, body='{"error":{"message":"model xyz not found"}}')
    with pytest.raises(BackendConfigurationError, match="model xyz not found"):
        _backend(capture).complete(REQ)


def test_a_transport_failure_is_unavailable_not_a_crash() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    backend = ApiBackend(
        provider="xai",
        base_url="https://api.x.ai/v1",
        api_key="k",
        model="grok-4.6",
        max_tokens=16,
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(BackendUnavailableError, match="request failed"):
        backend.complete(REQ)


def test_a_non_json_body_is_unavailable() -> None:
    capture = Capture(None, status=200, body="<html>502 Bad Gateway</html>")
    with pytest.raises(BackendUnavailableError, match="non-JSON"):
        _backend(capture).complete(REQ)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"choices": []},
        {"choices": [{"message": {}}]},
        {"choices": [{"message": "not a dict"}]},
        {"choices": ["not a dict"]},
        {"content": "not a list"},
    ],
)
def test_a_shapeless_body_says_nothing_rather_than_raising_keyerror(payload: Any) -> None:
    """A provider that answers 200 with an unexpected shape must reach the
    callers as "said nothing", the case they all already handle -- not as a
    `KeyError`/`TypeError` escaping through the round."""
    capture = Capture(payload)
    with pytest.raises(BackendUnavailableError, match="produced no output"):
        _backend(capture).complete(REQ)


def test_whitespace_only_output_counts_as_nothing() -> None:
    capture = Capture({"choices": [{"message": {"content": "   \n  "}}]})
    with pytest.raises(BackendUnavailableError, match="produced no output"):
        _backend(capture).complete(REQ)


def test_an_unknown_provider_cannot_be_constructed() -> None:
    with pytest.raises(BackendConfigurationError, match="unknown provider"):
        ApiBackend(
            provider="gemini",
            base_url="https://example.test",
            api_key="k",
            model="m",
            max_tokens=16,
        )


def test_a_trailing_slash_on_the_base_url_does_not_double_up() -> None:
    """Operators paste base URLs out of vendor docs, and half of those end in
    a slash. `//chat/completions` 404s at most providers."""
    capture = Capture({"choices": [{"message": {"content": "x"}}]})
    backend = _backend(capture, base_url="https://api.x.ai/v1/")
    backend.complete(REQ)
    assert capture.request is not None
    assert str(capture.request.url) == "https://api.x.ai/v1/chat/completions"


# ── the defensive branches ────────────────────────────────────────────────
#
# Each of these is unreachable through `resolve_backend_choice`, which is
# exactly why they need direct tests: they are the guards that catch a FUTURE
# caller building a choice by hand or a new provider returning an unfamiliar
# shape, and an untested guard is a guess about what it does.


def test_an_incomplete_choice_is_refused_rather_than_sent() -> None:
    from swil_agent.llm.selection import BackendChoice

    incomplete = BackendChoice(
        kind="api", model=None, kind_source="env", model_source="default", provider="xai"
    )
    with pytest.raises(BackendConfigurationError, match="incomplete"):
        ApiBackend.from_choice(incomplete, api_key="k", max_tokens=16)


def test_a_json_array_body_is_unavailable_not_a_typeerror() -> None:
    """A 200 whose body is a JSON array rather than an object. `payload.get`
    would raise `AttributeError` and escape the round as a crash."""
    capture = Capture(None, status=200, body="[1, 2, 3]")
    with pytest.raises(BackendUnavailableError, match="non-object"):
        _backend(capture).complete(REQ)


def test_anthropic_with_a_non_list_content_says_nothing() -> None:
    """The openai-shaped shapeless-body cases above never reach this branch,
    because they run against the xai provider. Same defect, other protocol."""
    capture = Capture({"content": {"type": "text", "text": "x"}})
    backend = _backend(capture, provider="anthropic", model="claude-opus-4")
    with pytest.raises(BackendUnavailableError, match="produced no output"):
        backend.complete(REQ)


def test_openai_with_structured_content_blocks_says_nothing() -> None:
    """Some providers return `content` as a list of parts rather than a string.
    Treated as "said nothing" rather than stringified -- a `str(list)` would put
    `[{'type': 'text', ...}]` into a persona's post."""
    capture = Capture({"choices": [{"message": {"content": [{"type": "text", "text": "x"}]}}]})
    with pytest.raises(BackendUnavailableError, match="produced no output"):
        _backend(capture).complete(REQ)
