"""Tests for `swil_agent.register` -- fake HTTP layer only, never a real socket."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from swil_agent.config import Settings
from swil_agent.persona.format import PersonaFormatError
from swil_agent.persona.source import GitPersonaSource
from swil_agent.register import RegisterError, anchor_text, register_account

from ._runners import FakeEmbedder

PERSONALITY = """---
username: xiaoman
display_name: 小满
bio: 夜班护士，白天睡觉。
model: claude:claude-haiku-5-5
board: life-science
topics: [health, plants]
era: 3
---
# 小满

夜班护士，醒着的时候养多肉。说话很短，对新手很耐心。

## 最近
- 多肉又死了一盆
"""


class FakeServer:
    """Records requests; answers like the real routes."""

    def __init__(self, *, exists: bool = False, fail: dict[str, int] | None = None) -> None:
        self.exists = exists
        self.fail = fail or {}
        self.calls: list[tuple[str, str, dict[str, object] | None, str | None]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1")
        key = f"{request.method} {path}"
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body, request.headers.get("authorization")))
        if key in self.fail:
            return httpx.Response(self.fail[key], json={"error": {"code": "X", "message": "x"}})
        if key == "GET /users/xiaoman":
            return httpx.Response(200 if self.exists else 404, json={"data": {}})
        if key == "POST /auth/register":
            return httpx.Response(201, json={"data": {}})
        if key == "POST /auth/login":
            return httpx.Response(200, json={"data": {}}, headers={"set-cookie": "sid=abc; Path=/"})
        if key == "POST /auth/api-keys":
            return httpx.Response(201, json={"data": {"key": "swk_secret"}})
        if key == "POST /agents/xiaoman/snapshots":
            return httpx.Response(201, json={"data": {"id": "snap1"}})
        return httpx.Response(200, json={"data": {}})

    @property
    def keys(self) -> list[str]:
        return [f"{m} {p}" for m, p, _, _ in self.calls]


@pytest.fixture
def root(tmp_path: Path) -> Path:
    directory = tmp_path / "agents" / "xiaoman"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(PERSONALITY, encoding="utf-8")
    return tmp_path


def _settings(root: Path, **kw: object) -> Settings:
    base: dict[str, object] = {
        "agent_root": root,
        "swil_url": "http://localhost:8899",
        "swil_pass": "pw",
    }
    base.update(kw)
    return Settings(**base)  # type: ignore[arg-type]


def _run(
    root: Path,
    server: FakeServer,
    embedder: FakeEmbedder | None = None,
    *,
    adopt: bool = False,
    **kw: object,
):
    return register_account(
        _settings(root, **kw),  # type: ignore[arg-type]
        GitPersonaSource(root),
        "xiaoman",
        http=httpx.MockTransport(server),
        embedder=embedder or FakeEmbedder(vectors=[[0.1, 0.2]]),
        adopt=adopt,
    )


def test_new_account_exact_request_sequence(root: Path) -> None:
    server = FakeServer()
    result = _run(root, server, swil_agent_setup_token=SecretStr("tok"))
    assert server.keys == [
        "GET /users/xiaoman",
        "POST /auth/register",
        "POST /auth/login",
        "POST /auth/api-keys",
        "PATCH /users/me",
        "PATCH /users/me",
        "POST /agents/xiaoman/snapshots",
    ]
    assert result.requests == server.keys
    assert result.registered and result.key_written and result.anchor_posted

    register_body = server.calls[1][2]
    assert register_body == {
        "username": "xiaoman",
        "email": "xiaoman@agents.swil",
        "password": "pw",
        "displayName": "小满",
        "isAgent": True,
        "agentSetupToken": "tok",
    }
    assert server.calls[4][2] == {"displayName": "小满", "bio": "夜班护士，白天睡觉。"}
    assert server.calls[5][2] == {"agentBackend": "claude:claude-haiku-5-5"}
    # Bearer from the key on every call after the key exists.
    assert all(call[3] == "Bearer swk_secret" for call in server.calls[4:])


def test_key_file_is_written_0600(root: Path) -> None:
    _run(root, FakeServer())
    key = root / "agents" / "xiaoman" / "api_key.txt"
    assert key.read_text(encoding="utf-8").strip() == "swk_secret"
    assert stat.S_IMODE(key.stat().st_mode) == 0o600


def test_setup_token_omitted_when_unset(root: Path) -> None:
    server = FakeServer()
    _run(root, server)
    assert "agentSetupToken" not in (server.calls[1][2] or {})


def test_anchor_snapshot_payload(root: Path) -> None:
    server = FakeServer()
    embedder = FakeEmbedder(vectors=[[0.5, 0.25]])
    _run(root, server, embedder)
    payload = server.calls[-1][2]
    assert payload is not None
    assert payload["snapshotType"] == "anchor"
    assert payload["embedding"] == [0.5, 0.25]
    expected = anchor_text(GitPersonaSource(root).load("xiaoman"))
    assert embedder.embedded == [[expected]]
    assert "多肉又死了一盆" not in expected
    assert payload["archivePath"] == "agents/xiaoman/personality.md"


def test_existing_account_without_a_key_is_refused_without_adopt(root: Path) -> None:
    server = FakeServer(exists=True)
    with pytest.raises(RegisterError, match="--adopt"):
        _run(root, server)
    assert server.keys == ["GET /users/xiaoman"]
    assert not (root / "agents" / "xiaoman" / "api_key.txt").exists()


def test_existing_account_with_adopt_skips_register_but_makes_key(root: Path) -> None:
    server = FakeServer(exists=True)
    result = _run(root, server, adopt=True)
    assert "POST /auth/register" not in server.keys
    assert "POST /auth/api-keys" in server.keys
    assert not result.registered and result.key_written


def test_rerun_reuses_key_and_skips_login(root: Path) -> None:
    key = root / "agents" / "xiaoman" / "api_key.txt"
    key.write_text("swk_old\n", encoding="utf-8")
    server = FakeServer(exists=True)
    result = _run(root, server)
    assert server.keys == [
        "GET /users/xiaoman",
        "PATCH /users/me",
        "PATCH /users/me",
        "POST /agents/xiaoman/snapshots",
    ]
    assert key.read_text(encoding="utf-8").strip() == "swk_old"
    assert not result.key_written


def test_dry_run_sends_nothing_and_prints_plan(root: Path) -> None:
    server = FakeServer()
    lines: list[str] = []
    result = register_account(
        _settings(root),
        GitPersonaSource(root),
        "xiaoman",
        http=httpx.MockTransport(server),
        dry_run=True,
        emit=lines.append,
    )
    assert server.calls == []
    assert result.dry_run and len(result.requests) == 7
    assert len(lines) == 7 and all(line.startswith("[dry-run]") for line in lines)
    assert not (root / "agents" / "xiaoman" / "api_key.txt").exists()


def test_invalid_persona_fails_before_any_request(root: Path) -> None:
    path = root / "agents" / "xiaoman" / "personality.md"
    path.write_text(PERSONALITY.replace("era: 3", "era: 2"), encoding="utf-8")
    server = FakeServer()
    with pytest.raises(PersonaFormatError):
        _run(root, server)
    assert server.calls == []


def test_embedder_down_fails_loudly_after_account_and_key_exist(root: Path) -> None:
    server = FakeServer()
    with pytest.raises(RegisterError, match="re-run"):
        _run(root, server, FakeEmbedder(fail_always=True))
    assert (root / "agents" / "xiaoman" / "api_key.txt").is_file()
    assert "POST /auth/register" in server.keys
    assert "POST /agents/xiaoman/snapshots" not in server.keys


def test_missing_embedder_is_an_error(root: Path) -> None:
    with pytest.raises(RegisterError, match="embedder"):
        register_account(
            _settings(root),
            GitPersonaSource(root),
            "xiaoman",
            http=httpx.MockTransport(FakeServer()),
        )


def test_missing_password_stops_before_register(root: Path) -> None:
    server = FakeServer()
    with pytest.raises(RegisterError, match="SWIL_PASS"):
        _run(root, server, swil_pass=None)
    assert server.keys == ["GET /users/xiaoman"]


def test_missing_password_with_existing_user_and_no_key(root: Path) -> None:
    with pytest.raises(RegisterError, match="SWIL_PASS"):
        _run(root, FakeServer(exists=True), adopt=True, swil_pass=None)


def test_user_lookup_server_error_propagates(root: Path) -> None:
    from swil_agent.api.client import ApiError

    with pytest.raises(ApiError):
        _run(root, FakeServer(fail={"GET /users/xiaoman": 500}))


def test_register_rate_limit_propagates(root: Path) -> None:
    from swil_agent.api.client import ApiError

    with pytest.raises(ApiError) as info:
        _run(root, FakeServer(fail={"POST /auth/register": 429}))
    assert info.value.status == 429


def test_login_failure_is_a_register_error(root: Path) -> None:
    with pytest.raises(RegisterError, match="api key"):
        _run(root, FakeServer(exists=True, fail={"POST /auth/login": 401}), adopt=True)


def test_keyless_response_is_a_register_error(root: Path) -> None:
    class NoKey(FakeServer):
        def __call__(self, request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/auth/api-keys"):
                return httpx.Response(201, json={"data": {}})
            return super().__call__(request)

    with pytest.raises(RegisterError, match="no key"):
        _run(root, NoKey())
    assert not (root / "agents" / "xiaoman" / "api_key.txt").exists()


def test_profile_failure_is_a_register_error(root: Path) -> None:
    with pytest.raises(RegisterError, match="profile"):
        _run(root, FakeServer(fail={"PATCH /users/me": 500}))


def test_snapshot_rejection_is_a_register_error(root: Path) -> None:
    with pytest.raises(RegisterError, match="anchor"):
        _run(root, FakeServer(fail={"POST /agents/xiaoman/snapshots": 400}))


def test_blank_key_file_is_replaced(root: Path) -> None:
    key = root / "agents" / "xiaoman" / "api_key.txt"
    key.write_text("  \n", encoding="utf-8")
    with pytest.raises(RegisterError, match="--adopt"):
        _run(root, FakeServer(exists=True))
    result = _run(root, FakeServer(exists=True), adopt=True)
    assert result.key_written and key.read_text(encoding="utf-8").strip() == "swk_secret"


def test_bio_omitted_when_persona_has_none(root: Path) -> None:
    path = root / "agents" / "xiaoman" / "personality.md"
    path.write_text(PERSONALITY.replace("bio: 夜班护士，白天睡觉。\n", ""), encoding="utf-8")
    server = FakeServer()
    _run(root, server)
    assert server.calls[4][2] == {"displayName": "小满"}
