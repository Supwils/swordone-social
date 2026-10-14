"""`swil-agent register <username>` -- create one Era 3 account on a server.

Creates or recovers an account's API key and profile. Idempotent: every step
checks what already exists, so a run that died halfway (embedder down, rate
limit) is finished by running the same command again.

Request sequence for a brand-new account (Bearer from step 5 on):

    1. GET   /users/{u}            404 -> new; 200 -> skip 2
    2. POST  /auth/register        {username, email, password, displayName, isAgent, token?}
    3. POST  /auth/login           session cookie (only when no api_key.txt yet)
    4. POST  /auth/api-keys        {name}
    5. (write agents/{u}/api_key.txt, mode 0600)
    6. PATCH /users/me             {displayName[, bio]}
    7. PATCH /users/me             {agentBackend}  (act's `sync_backend_step`)
    8. POST  /agents/{u}/snapshots anchor snapshot (card + empty 最近, bge-m3 vector)

An existing user with no local `api_key.txt` is somebody's account -- maybe
another era's, maybe a stranger's -- so taking it over needs `--adopt`
(`adopt=True`). A non-blank local key proves the account is this roster's own
(a re-run after the key step), and that re-run needs no flag.

Nothing here runs a round or touches `personality.md`.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final, Protocol

import httpx

from swil_agent.act.round import sync_backend_step
from swil_agent.api.auth import ApiKeyAuth, PasswordAuth
from swil_agent.api.client import ApiClient, ApiError
from swil_agent.api.resources import Resources, WriteNotVerifiedError
from swil_agent.config import Settings
from swil_agent.dream.round import build_snapshot_payload
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.models import Persona
from swil_agent.persona.format import PersonaDoc, prompt_text
from swil_agent.persona.source import PersonaSource

API_KEY_FILENAME: Final = "api_key.txt"
API_KEY_NAME: Final = "agent"


class RegisterError(RuntimeError):
    """A known, remediable failure; the message is the full remedy."""


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


@dataclass
class RegisterResult:
    username: str
    registered: bool = False
    key_written: bool = False
    anchor_posted: bool = False
    dry_run: bool = False
    # "METHOD /path" for every request made (or, in a dry run, planned).
    requests: list[str] = field(default_factory=list)


class _RecordingTransport(httpx.BaseTransport):
    """Delegates to `inner` and records `METHOD /path` of every request."""

    def __init__(self, inner: httpx.BaseTransport, log: list[str]) -> None:
        self._inner = inner
        self._log = log

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1")
        self._log.append(f"{request.method} {path}")
        return self._inner.handle_request(request)


def anchor_text(persona: Persona) -> str:
    """The anchor baseline: the card with an empty 最近, never the frontmatter."""
    return prompt_text(PersonaDoc(meta={}, card=persona.card, recent=()))


def _write_key(path: Path, key: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(key + "\n")
    path.chmod(0o600)  # O_CREAT's mode does not apply to a pre-existing file


def _user_exists(client: ApiClient, username: str) -> bool:
    try:
        client.get(f"/users/{username}")
    except ApiError as exc:
        if exc.status == 404:
            return False
        raise
    return True


def _planned_requests(username: str) -> list[str]:
    return [
        f"GET /users/{username}",
        "POST /auth/register",
        "POST /auth/login",
        "POST /auth/api-keys",
        "PATCH /users/me  (displayName, bio)",
        "PATCH /users/me  (agentBackend)",
        f"POST /agents/{username}/snapshots  (anchor)",
    ]


def register_account(
    settings: Settings,
    source: PersonaSource,
    username: str,
    *,
    http: httpx.BaseTransport | None = None,
    embedder: Embedder | None = None,
    dry_run: bool = False,
    adopt: bool = False,
    emit: Callable[[str], None] = lambda _line: None,
) -> RegisterResult:
    """Register `username`, mint its key, set its profile, post the anchor.

    The persona is loaded (and so validated) before any request. `http` is the
    transport seam tests use; `embedder` is required unless `dry_run`.
    `adopt` allows continuing on a user that already exists without a local key.
    """
    persona = source.load(username)
    result = RegisterResult(username=username, dry_run=dry_run)
    key_path = persona.directory / API_KEY_FILENAME

    if dry_run:
        result.requests = _planned_requests(username)
        for line in result.requests:
            emit(f"[dry-run] {line}")
        return result

    if embedder is None:
        raise RegisterError("an embedder is required to post the anchor snapshot")

    transport = _RecordingTransport(http or httpx.HTTPTransport(), result.requests)
    password = settings.swil_pass
    setup_token = (
        settings.swil_agent_setup_token.get_secret_value()
        if settings.swil_agent_setup_token
        else None
    )

    have_key = key_path.is_file() and bool(key_path.read_text(encoding="utf-8").strip())
    with ApiClient(settings.swil_url, PasswordAuth(username, password or ""), transport) as anon:
        exists = _user_exists(anon, username)
        if exists and not have_key and not adopt:
            raise RegisterError(
                f"@{username} already exists on the server and there is no local "
                f"{API_KEY_FILENAME}. Pass --adopt to take it over (only if it is this "
                "roster's account, e.g. a register that died before minting the key)."
            )
        if exists:
            emit(f"@{username} already exists, skipping register")
        else:
            if not password:
                raise RegisterError("SWIL_PASS is not set in agent/.env; cannot register")
            body: dict[str, Any] = {
                "username": username,
                "email": f"{username}@agents.swil",
                "password": password,
                "displayName": persona.display_name,
                "isAgent": True,
            }
            if setup_token:
                body["agentSetupToken"] = setup_token
            anon.post("/auth/register", json=body)
            result.registered = True
            emit(f"@{username} registered")

        if have_key:
            emit(f"{API_KEY_FILENAME} exists, reusing")
        else:
            if not password:
                raise RegisterError(
                    f"no {API_KEY_FILENAME} for @{username} and SWIL_PASS is not set"
                )
            auth = PasswordAuth(username, password)
            with ApiClient(settings.swil_url, auth, transport) as session:
                try:
                    auth.login(session)
                    created = session.post("/auth/api-keys", json={"name": API_KEY_NAME})
                except (ApiError, RuntimeError) as exc:
                    raise RegisterError(
                        f"could not mint an api key for @{username}: {exc}"
                    ) from exc
            key = (created.get("data") or {}).get("key")
            if not isinstance(key, str) or not key:
                raise RegisterError(f"api key response carried no key: {created}")
            _write_key(key_path, key)
            result.key_written = True
            emit(f"{API_KEY_FILENAME} written (0600)")

    with ApiClient(settings.swil_url, ApiKeyAuth.from_file(key_path), transport) as client:
        resources = Resources(client)
        profile: dict[str, Any] = {"displayName": persona.display_name}
        if persona.bio:
            profile["bio"] = persona.bio
        try:
            resources.update_profile(profile)
        except ApiError as exc:
            raise RegisterError(f"profile update failed for @{username}: {exc}") from exc
        sync_backend_step(resources=resources, persona=persona, agent_name=username)

        text = anchor_text(persona)
        try:
            vector = embedder.embed([text])[0]
        except EmbedderUnavailable as exc:
            raise RegisterError(
                f"@{username} and its key exist, but the anchor snapshot was NOT posted: "
                f"embedder unavailable ({exc}). Start the embedder and re-run register."
            ) from exc
        payload = build_snapshot_payload(
            text=text,
            directory=persona.directory,
            agent_root=settings.agent_root,
            embedding=vector,
            captured_at=datetime.now(UTC),
        )
        payload["snapshotType"] = "anchor"
        try:
            resources.create_snapshot(username, payload)
        except (ApiError, WriteNotVerifiedError) as exc:
            raise RegisterError(f"anchor snapshot rejected for @{username}: {exc}") from exc
        result.anchor_posted = True
        emit("anchor snapshot posted")
    return result
