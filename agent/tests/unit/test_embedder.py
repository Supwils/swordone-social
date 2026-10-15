import json
import re
from pathlib import Path

import httpx
import pytest

from swil_agent.embedder.client import MAX_BATCH, EmbedderClient, EmbedderUnavailable
from swil_agent.embedder.guard import DEFAULT_TIMEOUT, EmbedderGuard
from tests.unit._runners import RecordingRunner

# --- EmbedderClient.embed --------------------------------------------------


def test_embed_posts_texts_and_returns_vectors_in_order() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body == {"texts": ["a", "b"]}
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0], [0.0, 1.0]], "dim": 2})

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    assert client.embed(["a", "b"]) == [[1.0, 0.0], [0.0, 1.0]]


def test_embed_raises_embedder_unavailable_on_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    with pytest.raises(EmbedderUnavailable):
        client.embed(["a"])


def test_embed_raises_embedder_unavailable_on_missing_embeddings() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"dim": 2})

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    with pytest.raises(EmbedderUnavailable):
        client.embed(["a"])


def test_embed_raises_embedder_unavailable_when_a_vector_is_empty() -> None:
    """The server declares `dim: 1024` fixed; an empty inner list is not a
    "no embeddings key" failure (covered above) but is equally unusable —
    a caller computing cosine similarity against `[]` would crash or,
    worse, silently produce a nonsense number."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [[]]})

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    with pytest.raises(EmbedderUnavailable):
        client.embed(["a"])


def test_embed_rejects_an_empty_batch_without_calling_the_server() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"embeddings": []})

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError):
        client.embed([])
    assert calls == []


def test_embed_rejects_a_batch_larger_than_max_batch_without_calling_the_server() -> None:
    """Contract 04 §1: the server declares `max_length=64` on `texts`, so a
    request above that would be a guaranteed 422. Refuse it locally instead
    of round-tripping."""
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"embeddings": []})

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError):
        client.embed(["x"] * (MAX_BATCH + 1))
    assert calls == []


def test_client_closes_the_underlying_transport_as_a_context_manager() -> None:
    closed: list[bool] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})

    with EmbedderClient("http://e", transport=httpx.MockTransport(handler)) as client:
        assert client.health() == {"ok": True}
        closed.append(client._client.is_closed)
    assert closed == [False]
    assert client._client.is_closed is True


# --- EmbedderClient.health --------------------------------------------------


def test_health_returns_the_daemon_payload() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/health"
        return httpx.Response(200, json={"ok": True, "model": "BAAI/bge-m3", "dim": 1024})

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    assert client.health() == {"ok": True, "model": "BAAI/bge-m3", "dim": 1024}


def test_health_raises_embedder_unavailable_on_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    with pytest.raises(EmbedderUnavailable):
        client.health()


# --- EmbedderGuard -----------------------------------------------------------


def test_guard_up_invokes_the_bash_script_with_up() -> None:
    runner = RecordingRunner(output="started\n")
    EmbedderGuard(Path("/agent"), runner=runner).up()
    assert runner.calls[0].argv == ["bash", "/agent/scripts/embedder-guard.sh", "up"]


def test_guard_up_never_raises_when_the_script_fails() -> None:
    """The Bash script's own comment: 'a guard must never abort its caller.'
    `SubprocessRunner` signals a failed/timed-out subprocess by returning
    `""` (see `llm/runner.py`) -- that must not become a raised exception
    here, since `up()` runs before the actual act/dream work and a raise
    would abort the round over what is meant to be best-effort plumbing."""
    runner = RecordingRunner(output="")
    EmbedderGuard(Path("/agent"), runner=runner).up()  # must not raise


def test_guard_down_never_raises_when_the_script_fails() -> None:
    runner = RecordingRunner(output="")
    EmbedderGuard(Path("/agent"), runner=runner).down()  # must not raise


def test_guard_down_invokes_the_bash_script_with_down() -> None:
    runner = RecordingRunner(output="")
    EmbedderGuard(Path("/agent"), runner=runner).down()
    assert runner.calls[0].argv == ["bash", "/agent/scripts/embedder-guard.sh", "down"]


def test_guard_status_returns_the_stripped_script_output() -> None:
    runner = RecordingRunner(output="count=1 owner=self health=up url=http://127.0.0.1:7777\n")
    status = EmbedderGuard(Path("/agent"), runner=runner).status()
    assert status == "count=1 owner=self health=up url=http://127.0.0.1:7777"
    assert runner.calls[0].argv == ["bash", "/agent/scripts/embedder-guard.sh", "status"]


def test_guard_passes_the_default_timeout_to_the_runner() -> None:
    runner = RecordingRunner(output="")
    EmbedderGuard(Path("/agent"), runner=runner).up()
    assert runner.calls[0].timeout == DEFAULT_TIMEOUT


def test_guard_honors_an_injected_timeout() -> None:
    """The default must be safe for a cold boot (see the ordering test
    below), but a caller with a good reason -- e.g. a test, or a caller that
    already knows the daemon is warm -- can still override it."""
    runner = RecordingRunner(output="")
    EmbedderGuard(Path("/agent"), runner=runner, timeout=5.0).up()
    assert runner.calls[0].timeout == 5.0


def _script_worst_case_seconds() -> int:
    """Parse `EMBEDDER_START_TIMEOUT`'s default and the mkdir-spinlock steal
    window straight out of the live `embedder-guard.sh` (never edited by
    this migration -- see CLAUDE.md), so this test breaks if either number
    changes there without a matching bump to `DEFAULT_TIMEOUT` here, rather
    than trusting a hardcoded copy of today's values to stay in sync."""
    script = Path(__file__).resolve().parents[2] / "scripts" / "embedder-guard.sh"
    text = script.read_text(encoding="utf-8")
    start_match = re.search(r'START_TIMEOUT="\$\{EMBEDDER_START_TIMEOUT:-(\d+)\}"', text)
    steal_match = re.search(r"age > (\d+)", text)
    assert start_match and steal_match, "could not parse embedder-guard.sh's timeout constants"
    return int(start_match.group(1)) + int(steal_match.group(1))


def test_default_timeout_exceeds_the_scripts_own_worst_case() -> None:
    """Finding 1 (fix round 1): `embedder-guard.sh` self-bounds a cold boot
    at its own START_TIMEOUT (150s default -- "cold MPS model load can be
    slow") before a caller can additionally lose up to 300s to the script's
    own mkdir-spinlock steal window. If `DEFAULT_TIMEOUT` does not clear that
    combined worst case, `SubprocessRunner` can SIGKILL the script
    mid-critical-section: `cmd_up`/`cmd_down` hold the spinlock for their
    entire body, so a kill there leaves `$LOCKDIR` un-rmdir'd (wedging every
    other up/down call in a parallel round for up to that same 300s), and
    drops the refcount update the killed call was making -- while the
    nohup'd daemon process itself likely survives the kill, undisowned by
    anyone's bookkeeping. This is the exact race the ruling exists to
    prevent, so the Python timeout must stay ABOVE the script's own ceiling,
    never tuned down to it or below."""
    assert _script_worst_case_seconds() < DEFAULT_TIMEOUT
