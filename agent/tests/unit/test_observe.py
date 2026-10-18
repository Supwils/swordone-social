"""`swil-agent observe` (lab v2 §5): one isolated claude-opus-5-5 note per round."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from typer.testing import CliRunner

from swil_agent import cli
from swil_agent.analysis import observe as observe_module
from swil_agent.analysis.observe import (
    OBSERVATION_MAX_UNITS,
    OBSERVER_DIGEST_MAX_BYTES,
    OBSERVER_TIMEOUT,
    OBSERVER_TOKEN_HEADER,
    ObserveError,
    build_observer_request,
    observation_body,
    observer_backend,
    run_observe,
    target_host,
)
from swil_agent.cli import compose
from swil_agent.config import Settings
from swil_agent.llm.backends.claude import CLAUDE_ISOLATION_FLAGS, ClaudeCLIBackend
from swil_agent.llm.errors import BackendBinaryMissingError
from swil_agent.llm.runner import DEFAULT_TIMEOUT, StatusRunner
from swil_agent.prompts.observer import OBSERVER_MODEL, OBSERVER_PROMPT_VERSION, OBSERVER_SYSTEM

from ._runners import RecordingRunner, StubBackend, assert_isolated_cwd

GOLDEN = Path(__file__).parent / "golden" / "observer_prompt.txt"
ROUND = "20261017T062000Z-r"
TOKEN = "o" * 40
HASH = "a" * 64
URL = "http://lab.test"
DIGEST: dict[str, Any] = {
    "round": {"roundId": ROUND, "kind": "sweep"},
    "posts": [{"postId": "p1", "username": "xiaoman", "excerpt": "夜班结束"}],
    "digestHash": HASH,
    "observation": {"text": "an old note"},
}


def _settings(token: str | None = TOKEN) -> Settings:
    return Settings(swil_url=URL, lab_observer_token=token)


def _backend(runner: StatusRunner) -> Any:
    """The production observer backend over a test runner."""
    return observer_backend(runner, _settings())


class Server:
    """A fake lab server: answers the digest GET and records every request."""

    def __init__(self, *, get_status: int = 200, put_status: int = 200) -> None:
        self.get_status = get_status
        self.put_status = put_status
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "GET":
            return httpx.Response(self.get_status, json={"data": DIGEST})
        return httpx.Response(self.put_status, json={"data": {"roundId": ROUND}})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def puts(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "PUT"]


def test_the_prompt_is_the_golden_and_the_constants_are_pinned() -> None:
    assert GOLDEN.read_text(encoding="utf-8").rstrip("\n") == OBSERVER_SYSTEM
    assert OBSERVER_MODEL == "claude-opus-5-5"
    assert OBSERVER_PROMPT_VERSION == "observer-v1"


def test_the_request_is_the_digest_without_any_previous_note() -> None:
    req = build_observer_request(DIGEST)
    assert req.system == OBSERVER_SYSTEM
    assert req.model == OBSERVER_MODEL
    sent = json.loads(req.user)
    assert "observation" not in sent
    assert sent["digestHash"] == HASH
    assert "夜班结束" in req.user  # not \u-escaped


def test_one_isolated_tool_less_claude_call_then_the_put() -> None:
    runner = RecordingRunner("  这一轮 @xiaoman 写了夜班。 \n")
    server = Server()
    result = run_observe(_settings(), ROUND, _backend(runner), transport=server.transport())

    assert result.written is True
    assert result.text == "这一轮 @xiaoman 写了夜班。"
    (call,) = runner.calls
    assert call.argv[:4] == ["claude", "-p", "--tools", ""]
    flags = call.argv[4 : 4 + len(CLAUDE_ISOLATION_FLAGS)]
    assert tuple(flags) == CLAUDE_ISOLATION_FLAGS
    assert call.argv[call.argv.index("--model") + 1] == "claude-opus-5-5"
    assert call.timeout == OBSERVER_TIMEOUT == 300.0
    assert_isolated_cwd(call)
    assert json.loads(call.stdin or "") == {k: v for k, v in DIGEST.items() if k != "observation"}

    (put,) = server.puts()
    assert str(put.url) == f"{URL}/api/v1/agents/rounds/{ROUND}/observation"
    assert put.headers["X-Lab-Observer-Token"] == TOKEN
    assert json.loads(put.content) == {
        "text": "这一轮 @xiaoman 写了夜班。",
        "model": "claude-opus-5-5",
        "digestHash": HASH,
        "promptVersion": "observer-v1",
    }
    assert json.loads(put.content) == observation_body(result.text, HASH)


def test_the_observer_backend_is_the_claude_cli_backend_on_a_300s_budget() -> None:
    assert isinstance(_backend(RecordingRunner()), ClaudeCLIBackend)
    assert DEFAULT_TIMEOUT == OBSERVER_TIMEOUT == 300.0


@pytest.mark.parametrize(("returncode", "timed_out"), [(1, False), (2, False), (0, True)])
def test_a_failed_cli_call_is_never_published(returncode: int, timed_out: bool) -> None:
    """`claude -p` can exit non-zero AND print a sentence; that is not a note."""
    server = Server()
    runner = RecordingRunner("Error: not logged in", returncode=returncode, timed_out=timed_out)
    with pytest.raises(ObserveError) as err:
        run_observe(_settings(), ROUND, _backend(runner), transport=server.transport())
    assert err.value.kind == "setup"
    assert "not logged in" not in str(err.value)
    (call,) = runner.calls
    assert_isolated_cwd(call)  # same isolated cwd, removed although the call raised
    assert server.puts() == []


def _full_roster_digest() -> dict[str, Any]:
    """Every one of the 20 accounts posts and dreams, each 最近 list full on
    both sides (5 x 60 CJK code points), with 140-char excerpts."""
    item = "梦" * 60
    return {
        **DIGEST,
        "posts": [
            {"postId": f"p{i}", "username": f"u{i}", "excerpt": "字" * 140} for i in range(20)
        ],
        "changes": {
            "dreams": [
                {"username": f"u{i}", "recent": {"before": [item] * 5, "after": [item] * 5}}
                for i in range(20)
            ]
            * 2,  # headroom: twice the roster's dreams
            "newWords": [],
        },
    }


def test_a_full_roster_digest_with_every_dream_diff_reaches_the_model() -> None:
    assert OBSERVER_DIGEST_MAX_BYTES == 128 * 1024
    big = _full_roster_digest()
    size = len(build_observer_request(big).user.encode("utf-8"))
    assert 64 * 1024 < size <= OBSERVER_DIGEST_MAX_BYTES  # over the old cap, under this one

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"data": big})
        return httpx.Response(200, json={"data": {"roundId": ROUND}})

    runner = RecordingRunner("note")
    result = run_observe(
        _settings(), ROUND, _backend(runner), transport=httpx.MockTransport(handler)
    )
    assert result.written is True
    (call,) = runner.calls
    # the lists stay in the observer's copy
    assert json.loads(call.stdin or "")["changes"] == big["changes"]


def test_a_digest_over_128_kb_never_reaches_the_model() -> None:
    big = {**DIGEST, "posts": [{"postId": "p1", "username": "x", "excerpt": "字" * 50_000}]}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": big})

    runner = RecordingRunner("note")
    with pytest.raises(ObserveError) as err:
        run_observe(_settings(), ROUND, _backend(runner), transport=httpx.MockTransport(handler))
    assert err.value.kind == "setup"
    assert str(OBSERVER_DIGEST_MAX_BYTES) in str(err.value)
    assert runner.calls == []


def test_the_target_host_never_carries_userinfo() -> None:
    assert target_host("https://swil-social-api-production.up.railway.app") == (
        "swil-social-api-production.up.railway.app"
    )
    assert target_host("http://user:pw@127.0.0.1:3001") == "127.0.0.1:3001"


def test_the_requests_carry_no_session_and_no_api_key() -> None:
    """The observer is not an account: the token header is its only credential."""
    server = Server()
    run_observe(_settings(), ROUND, _backend(RecordingRunner("note")), transport=server.transport())

    get, put = server.requests
    for request in (get, put):
        assert "authorization" not in request.headers
        assert "cookie" not in request.headers
        assert "x-api-key" not in request.headers
    assert OBSERVER_TOKEN_HEADER.lower() not in get.headers
    assert put.headers["content-type"] == "application/json"


def test_dry_run_writes_nothing_and_needs_no_token() -> None:
    server = Server()
    result = run_observe(
        _settings(token=None),
        ROUND,
        _backend(RecordingRunner("note")),
        dry_run=True,
        transport=server.transport(),
    )
    assert result.written is False
    assert result.text == "note"
    assert server.puts() == []


def test_an_unset_token_fails_before_any_request_or_model_call() -> None:
    runner = RecordingRunner("note")
    server = Server()
    with pytest.raises(ObserveError) as err:
        run_observe(_settings(token=None), ROUND, _backend(runner), transport=server.transport())
    assert err.value.kind == "setup"
    assert server.requests == []
    assert runner.calls == []


@pytest.mark.parametrize(("status", "kind"), [(404, "missing"), (400, "usage"), (503, "setup")])
def test_a_failed_digest_read_never_reaches_the_model(status: int, kind: str) -> None:
    runner = RecordingRunner("note")
    with pytest.raises(ObserveError) as err:
        run_observe(
            _settings(),
            ROUND,
            _backend(runner),
            transport=Server(get_status=status).transport(),
        )
    assert err.value.kind == kind
    assert runner.calls == []


def test_an_unreachable_server_or_a_digest_without_a_hash_is_a_setup_failure() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    def hashless(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"round": {}}})

    for handler in (down, hashless):
        runner = RecordingRunner("note")
        with pytest.raises(ObserveError) as err:
            run_observe(
                _settings(), ROUND, _backend(runner), transport=httpx.MockTransport(handler)
            )
        assert err.value.kind == "setup"
        assert runner.calls == []


def test_a_bad_round_id_is_a_usage_error_with_no_request() -> None:
    server = Server()
    with pytest.raises(ObserveError) as err:
        run_observe(
            _settings(),
            "yesterday",
            _backend(RecordingRunner()),
            transport=server.transport(),
        )
    assert err.value.kind == "usage"
    assert server.requests == []


def test_an_empty_model_reply_writes_nothing() -> None:
    server = Server()
    with pytest.raises(ObserveError) as err:
        run_observe(_settings(), ROUND, _backend(RecordingRunner("")), transport=server.transport())
    assert err.value.kind == "setup"
    assert server.puts() == []


def test_a_long_reply_is_capped_to_the_servers_limit() -> None:
    server = Server()
    result = run_observe(
        _settings(),
        ROUND,
        _backend(RecordingRunner("字" * 5000)),
        transport=server.transport(),
    )
    assert len(result.text) == OBSERVATION_MAX_UNITS


def test_the_cap_counts_utf16_units_and_never_splits_a_surrogate() -> None:
    server = Server()
    result = run_observe(
        _settings(),
        ROUND,
        _backend(RecordingRunner("a" + "😀" * 700)),
        transport=server.transport(),
    )
    assert result.text == "a" + "😀" * 599  # 1199 units: the 600th emoji would be 1201
    assert len(result.text.encode("utf-16-le")) // 2 <= OBSERVATION_MAX_UNITS
    (put,) = server.puts()
    assert json.loads(put.content)["text"] == result.text


@pytest.mark.parametrize("status", [401, 404, 500])
def test_a_refused_put_is_a_setup_failure(status: int) -> None:
    with pytest.raises(ObserveError) as err:
        run_observe(
            _settings(),
            ROUND,
            _backend(RecordingRunner("note")),
            transport=Server(put_status=status).transport(),
        )
    assert err.value.kind == "setup"


def test_a_whitespace_only_reply_writes_nothing() -> None:
    server = Server()
    with pytest.raises(ObserveError) as err:
        run_observe(_settings(), ROUND, StubBackend(" \n\t "), transport=server.transport())
    assert err.value.kind == "setup"
    assert server.puts() == []


def test_a_digest_that_is_not_json_never_reaches_the_model() -> None:
    def garbled(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>")

    backend = StubBackend("note")
    with pytest.raises(ObserveError) as err:
        run_observe(_settings(), ROUND, backend, transport=httpx.MockTransport(garbled))
    assert err.value.kind == "setup"
    assert backend.calls == []


def test_an_unreachable_server_at_the_write_is_a_setup_failure() -> None:
    def put_down(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(200, json={"data": DIGEST})

    with pytest.raises(ObserveError) as err:
        run_observe(
            _settings(), ROUND, StubBackend("note"), transport=httpx.MockTransport(put_down)
        )
    assert err.value.kind == "setup"


def test_the_production_transport_is_httpx_default() -> None:
    assert observe_module.http_transport() is None


# ── the command ─────────────────────────────────────────────────────────────

runner_cli = CliRunner()


def _wire(
    monkeypatch: pytest.MonkeyPatch,
    server: Server,
    *,
    token: str | None = TOKEN,
    reply: str = "note",
) -> None:
    monkeypatch.setattr(compose, "load_settings", lambda: _settings(token))
    monkeypatch.setattr(compose, "runner_for", lambda settings: RecordingRunner(reply))
    monkeypatch.setattr(observe_module, "http_transport", server.transport)


def test_the_command_writes_the_note_and_exits_0(monkeypatch: pytest.MonkeyPatch) -> None:
    server = Server()
    _wire(monkeypatch, server)
    result = runner_cli.invoke(cli.app, ["observe", ROUND])
    assert result.exit_code == 0, result.output
    assert result.stdout == f"observe: observed {ROUND} → lab.test (hash {HASH[:12]})\n"
    assert TOKEN not in result.output
    assert len(server.puts()) == 1


def test_the_command_dry_run_prints_the_note(monkeypatch: pytest.MonkeyPatch) -> None:
    server = Server()
    _wire(monkeypatch, server, token=None, reply="一段观察")
    result = runner_cli.invoke(cli.app, ["observe", ROUND, "--dry-run"])
    assert result.exit_code == 0, result.output
    assert "一段观察" in result.stdout
    assert server.puts() == []


@pytest.mark.parametrize(
    ("args", "get_status", "token", "code"),
    [
        (["observe", "nope"], 200, TOKEN, 64),
        (["observe", ROUND], 404, TOKEN, 66),
        (["observe", ROUND], 200, None, 75),
        (["observe", ROUND], 503, TOKEN, 75),
    ],
)
def test_the_command_exit_codes(
    monkeypatch: pytest.MonkeyPatch, args: list[str], get_status: int, token: str | None, code: int
) -> None:
    _wire(monkeypatch, Server(get_status=get_status), token=token)
    result = runner_cli.invoke(cli.app, args)
    assert result.exit_code == code, result.output


def test_the_command_exits_75_when_the_claude_cli_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class NoClaude(RecordingRunner):
        def run(self, argv: list[str], *args: Any, **kwargs: Any) -> str:
            raise BackendBinaryMissingError(f"executable not found on PATH: {argv[0]!r}")

    server = Server()
    _wire(monkeypatch, server)
    monkeypatch.setattr(compose, "runner_for", lambda settings: NoClaude())
    result = runner_cli.invoke(cli.app, ["observe", ROUND])
    assert result.exit_code == 75, result.output
    assert server.puts() == []


@pytest.mark.parametrize(("returncode", "puts"), [(1, 0), (0, 1)])
def test_the_command_publishes_only_a_clean_exit(
    monkeypatch: pytest.MonkeyPatch, returncode: int, puts: int
) -> None:
    server = Server()
    _wire(monkeypatch, server)
    monkeypatch.setattr(
        compose,
        "runner_for",
        lambda settings: RecordingRunner("Error: not logged in", returncode=returncode),
    )
    result = runner_cli.invoke(cli.app, ["observe", ROUND])
    assert result.exit_code == (75 if returncode else 0), result.output
    assert len(server.puts()) == puts


def test_the_command_exits_75_on_an_oversized_digest(monkeypatch: pytest.MonkeyPatch) -> None:
    big = {**DIGEST, "posts": [{"excerpt": "x" * (OBSERVER_DIGEST_MAX_BYTES + 1)}]}
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"data": big})

    runner = RecordingRunner("note")
    monkeypatch.setattr(compose, "load_settings", lambda: _settings())
    monkeypatch.setattr(compose, "runner_for", lambda settings: runner)
    monkeypatch.setattr(observe_module, "http_transport", lambda: httpx.MockTransport(handler))
    result = runner_cli.invoke(cli.app, ["observe", ROUND])
    assert result.exit_code == 75, result.output
    assert runner.calls == []
    assert [r.method for r in requests] == ["GET"]
