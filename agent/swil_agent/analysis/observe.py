"""`swil-agent observe <roundId>`: one machine-written note per round (lab v2 §5).

GET the round's digest (a public lab read), make ONE completion through the
isolated, tool-less claude backend on the observer's fixed model, and PUT the
note with the operator's observer token. Not a persona: no persona file, no
feed -- nothing a persona reads changes. The note is presentation, never data;
the round script runs this with `|| true`, so a failed note never fails a round.

The digest is sent WITHOUT any stored `observation`: a note never reads the
previous note. Re-running replaces the note on the server.

The model's stdout is published, so it is trusted only after a clean exit:
`observer_backend` puts `ExitCheckedRunner` between the claude backend and the
runner (the bench judge's rule, `bench/judge.py`). A `claude` that exits
non-zero can still print "not logged in" or a quota notice, and that sentence
must never become the public note.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Final

import httpx

from swil_agent.api.dto import cap_utf16
from swil_agent.config import Settings
from swil_agent.llm.backends import build_backend
from swil_agent.llm.complete import complete_text
from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.protocol import Backend
from swil_agent.llm.runner import CompletionRequest, StatusRunner
from swil_agent.prompts.observer import OBSERVER_MODEL, OBSERVER_PROMPT_VERSION, OBSERVER_SYSTEM
from swil_agent.round_id import is_valid_round_id

logger = logging.getLogger(__name__)

OBSERVER_TOKEN_HEADER: Final = "X-Lab-Observer-Token"
# The server's `text.max(1200)`, which counts UTF-16 units.
OBSERVATION_MAX_UNITS: Final = 1200
# The round runner's `DEFAULT_TIMEOUT`, passed explicitly so a change there
# cannot silently change the observer's budget. No retry.
OBSERVER_TIMEOUT: Final = 300.0
# A round's digest is tens of KB: 20 accounts each dreaming carry two 最近
# lists of up to 5 x 60 code points (~36 KB of CJK), on top of the posts. One
# over 128 KB is a server fault, not something to hand a model.
OBSERVER_DIGEST_MAX_BYTES: Final = 128 * 1024
_HTTP_TIMEOUT: Final = 30.0
_HEX: Final = frozenset("0123456789abcdef")


class ObserveError(RuntimeError):
    """A note that was not written. `kind`: `usage` (bad round id), `missing`
    (no such round), `setup` (token, server, model, or a refused write)."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class Observation:
    round_id: str
    text: str
    digest_hash: str
    written: bool


def http_transport() -> httpx.BaseTransport | None:
    """The command's transport seam: `None` in production; a test returns a mock."""
    return None


class ExitCheckedRunner:
    """A `Runner` that hands the backend stdout only after a clean exit.

    A timeout or a non-zero exit raises `ObserveError("setup")` from inside the
    backend's call (its isolated cwd is still removed on the way out), so
    nothing the failed CLI printed reaches the note. Every call runs under
    `OBSERVER_TIMEOUT`, whatever the backend asked for."""

    def __init__(self, inner: StatusRunner) -> None:
        self._inner = inner

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = OBSERVER_TIMEOUT,
        cwd: str | None = None,
    ) -> str:
        _ = timeout  # the observer's own budget replaces the backend's default
        result = self._inner.run_result(argv, stdin, env, OBSERVER_TIMEOUT, cwd)
        if result.timed_out:
            raise ObserveError("setup", f"observer model timed out after {OBSERVER_TIMEOUT:.0f}s")
        if result.returncode != 0:
            raise ObserveError(
                "setup", f"observer model exited {result.returncode}; its output was discarded"
            )
        return result.stdout


def observer_backend(runner: StatusRunner, settings: Settings) -> Backend:
    """The isolated, tool-less claude backend, calling through `ExitCheckedRunner`."""
    return build_backend("claude", ExitCheckedRunner(runner), settings)


def target_host(swil_url: str) -> str:
    """`host[:port]` of `SWIL_URL` for the success line -- never its userinfo."""
    url = httpx.URL(swil_url)
    return f"{url.host}:{url.port}" if url.port is not None else url.host


def build_observer_request(digest: dict[str, Any]) -> CompletionRequest:
    body = {k: v for k, v in digest.items() if k != "observation"}
    return CompletionRequest(
        system=OBSERVER_SYSTEM,
        user=json.dumps(body, ensure_ascii=False, sort_keys=True),
        model=OBSERVER_MODEL,
    )


def observation_body(text: str, digest_hash: str) -> dict[str, str]:
    return {
        "text": text,
        "model": OBSERVER_MODEL,
        "digestHash": digest_hash,
        "promptVersion": OBSERVER_PROMPT_VERSION,
    }


def _is_hash(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= _HEX


def _fetch_digest(client: httpx.Client, settings: Settings, round_id: str) -> dict[str, Any]:
    try:
        response = client.get(f"{settings.swil_url}/api/v1/agents/rounds/{round_id}")
    except httpx.HTTPError as exc:
        raise ObserveError("setup", f"digest read failed: {exc}") from exc
    if response.status_code == 404:
        raise ObserveError("missing", f"no round {round_id} on {settings.swil_url}")
    if response.status_code == 400:
        raise ObserveError("usage", f"the server refused round id {round_id!r}")
    if response.status_code >= 400:
        raise ObserveError("setup", f"digest read failed: HTTP {response.status_code}")
    try:
        parsed: Any = response.json()
    except ValueError as exc:
        raise ObserveError("setup", "the digest is not JSON") from exc
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, dict) or not _is_hash(data.get("digestHash")):
        raise ObserveError("setup", "the digest carries no digestHash")
    return data


def _write(
    client: httpx.Client, settings: Settings, round_id: str, body: dict[str, str], token: str
) -> None:
    try:
        response = client.put(
            f"{settings.swil_url}/api/v1/agents/rounds/{round_id}/observation",
            json=body,
            headers={OBSERVER_TOKEN_HEADER: token},
        )
    except httpx.HTTPError as exc:
        raise ObserveError("setup", f"observation write failed: {exc}") from exc
    if response.status_code == 404:
        raise ObserveError(
            "setup", "observation write answered 404: LAB_OBSERVER_TOKEN is unset on the server"
        )
    if response.status_code == 401:
        raise ObserveError("setup", "observation write refused: the observer token does not match")
    if response.status_code >= 400:
        raise ObserveError(
            "setup", f"observation write failed: HTTP {response.status_code} {response.text[:200]}"
        )


def run_observe(
    settings: Settings,
    round_id: str,
    backend: Backend,
    *,
    dry_run: bool = False,
    transport: httpx.BaseTransport | None = None,
) -> Observation:
    if not is_valid_round_id(round_id):
        raise ObserveError("usage", f"{round_id!r} is not a round id (YYYYMMDDTHHMMSSZ-r|m)")
    token = settings.lab_observer_token
    secret = token.get_secret_value() if token is not None else None
    if secret is None and not dry_run:
        raise ObserveError("setup", "LAB_OBSERVER_TOKEN is unset in agent/.env")

    with httpx.Client(transport=transport, timeout=_HTTP_TIMEOUT) as client:
        digest = _fetch_digest(client, settings, round_id)
        request = build_observer_request(digest)
        size = len(request.user.encode("utf-8"))
        if size > OBSERVER_DIGEST_MAX_BYTES:
            raise ObserveError(
                "setup",
                f"the digest is {size} bytes (> {OBSERVER_DIGEST_MAX_BYTES}); not sent",
            )
        try:
            raw = complete_text(backend, request)
        except BackendUnavailableError as exc:
            raise ObserveError("setup", f"observer model unavailable: {exc}") from exc
        text = cap_utf16(raw.strip(), OBSERVATION_MAX_UNITS).strip()
        if not text:
            raise ObserveError("setup", "the observer model returned nothing")
        digest_hash = str(digest["digestHash"])
        if dry_run or secret is None:
            return Observation(round_id, text, digest_hash, written=False)
        _write(client, settings, round_id, observation_body(text, digest_hash), secret)
    logger.info("observer note written for %s (digest %s)", round_id, digest_hash[:12])
    return Observation(round_id, text, digest_hash, written=True)
