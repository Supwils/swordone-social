"""`get_backend`: one construction site, and the contract it must not change.

The point of routing every act/dream/cycle path through this function is that
swapping a backend changes WHERE a call goes and nothing else. The last group
of tests below is the one that actually holds that line: identical model output
through two different backends must produce an identical `Plan`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from swil_agent.act.planner import plan_round
from swil_agent.config import Settings
from swil_agent.llm.api_backend import ApiBackend
from swil_agent.llm.base import (
    BackendConfigurationError,
    ClaudeCLIBackend,
    CodexCLIBackend,
    DeepSeekCLIBackend,
)
from swil_agent.llm.factory import get_backend
from swil_agent.llm.selection import resolve_backend_choice
from swil_agent.models import ActContext, Persona

from ._runners import RecordingRunner

PLAN_JSON = '{"plan":[{"action":"post","text":"hello world"}]}'


def _persona(*, declared_backend: str | None = "claude", model: str | None = None) -> Persona:
    return Persona(
        username="zenith",
        directory=Path("/tmp/zenith"),
        backend=declared_backend or "claude",
        declared_backend=declared_backend,
        model=model,
        raw="PERSONA",
    )


def _settings(**kwargs: Any) -> Settings:
    return Settings(swil_url="https://example.test", **kwargs)


def _api_settings(**kwargs: Any) -> Settings:
    base = {
        "swil_llm_backend": "api",
        "swil_llm_provider": "xai",
        "swil_llm_model": "grok-4.6",
        "swil_llm_api_key": "k",
    }
    base.update(kwargs)
    return _settings(**base)


def _build(persona: Persona, settings: Settings, **kwargs: Any) -> Any:
    choice, _ = resolve_backend_choice(persona, settings)
    return get_backend(choice, RecordingRunner(PLAN_JSON), settings, **kwargs)


# ── the four kinds ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("declared", "expected"),
    [
        ("claude", ClaudeCLIBackend),
        ("codex", CodexCLIBackend),
        ("haiku", ClaudeCLIBackend),  # mangniu's model-name-in-the-backend-slot
        (None, ClaudeCLIBackend),
    ],
)
def test_cli_kinds_build_the_class_they_always_did(declared: str | None, expected: type) -> None:
    assert isinstance(_build(_persona(declared_backend=declared), _settings()), expected)


def test_deepseek_still_reads_its_injected_key() -> None:
    """The injection seam exists so the deepseek path is testable without a
    file in the developer's home directory -- see `build_backend`'s docstring.
    `get_backend` has to forward it or that seam closes."""
    backend = _build(
        _persona(declared_backend="deepseek"), _settings(), deepseek_api_key="test-key"
    )
    assert isinstance(backend, DeepSeekCLIBackend)


def test_api_kind_builds_an_api_backend() -> None:
    backend = _build(_persona(declared_backend=None), _api_settings())
    assert isinstance(backend, ApiBackend)
    assert backend.name == "xai"


def test_api_without_a_key_in_settings_is_a_configuration_error() -> None:
    """`resolve_backend_choice` catches this first, so reaching it requires a
    hand-built choice -- but the factory is the last gate before a request is
    sent with `Authorization: Bearer None`, and defence here costs one branch."""
    choice, _ = resolve_backend_choice(_persona(declared_backend=None), _api_settings())
    with pytest.raises(BackendConfigurationError, match="SWIL_LLM_API_KEY"):
        get_backend(choice, RecordingRunner(), _settings(), transport=None)


# ── what the factory must NOT do ──────────────────────────────────────────


def test_the_resolved_model_is_not_injected_as_a_cli_default() -> None:
    """`_diff_narrative` still passes `model=None` for claude/codex/deepseek
    so they use the CLI default. If the factory set `default_model` from
    the resolution, that call would silently become an opus call for every
    opus account -- a cost and latency change with no design decision
    behind it. Cursor threads the model on the request instead; this test
    pins the claude path.

    Asserted through observable behaviour: a request with `model=None` must
    produce an argv with no `--model` flag at all.
    """
    runner = RecordingRunner(PLAN_JSON)
    choice, _ = resolve_backend_choice(
        _persona(declared_backend="claude", model="opus"), _settings()
    )
    backend = get_backend(choice, runner, _settings())
    from swil_agent.llm.base import CompletionRequest

    backend.complete(CompletionRequest(system="S", user="U", model=None))
    assert "--model" not in runner.calls[0].argv


def test_the_resolved_model_still_reaches_the_cli_through_the_request() -> None:
    """The companion to the test above: the model is not lost, it travels the
    way it always has. Without this pair, "no default injected" would be
    satisfied by a factory that dropped the model entirely."""
    runner = RecordingRunner(PLAN_JSON)
    choice, _ = resolve_backend_choice(
        _persona(declared_backend="claude", model="opus"), _settings()
    )
    backend = get_backend(choice, runner, _settings())
    from swil_agent.llm.base import CompletionRequest

    backend.complete(CompletionRequest(system="S", user="U", model=choice.model))
    argv = runner.calls[0].argv
    assert argv[argv.index("--model") + 1] == "opus"


# ── the contract that must survive a backend swap ─────────────────────────


def _api_backend_returning(text: str) -> ApiBackend:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})

    choice, _ = resolve_backend_choice(_persona(declared_backend=None), _api_settings())
    return get_backend(  # type: ignore[return-value]
        choice, RecordingRunner(), _api_settings(), transport=httpx.MockTransport(handler)
    )


def test_switching_the_backend_changes_the_target_not_the_plan() -> None:
    """E3, the whole reason the seam is worth having.

    Two backends, two entirely different transports -- a subprocess argv and an
    HTTPS POST -- fed byte-identical model output. The `Plan` that comes out
    the other side must be indistinguishable, because `plan_round` parses the
    same JSON through the same `complete_json`/`normalize_plan` path regardless
    of which backend produced it. If a future backend ever pre-processed its
    own output (collapsing, trimming, unwrapping a provider envelope into the
    text), this is what would catch it.
    """
    persona = _persona(declared_backend="claude")
    ctx = ActContext()

    cli_choice, _ = resolve_backend_choice(persona, _settings())
    cli_plan = plan_round(
        get_backend(cli_choice, RecordingRunner(PLAN_JSON), _settings()),
        persona,
        ctx,
        rhythm_guidance="g",
    )
    api_plan = plan_round(_api_backend_returning(PLAN_JSON), persona, ctx, rhythm_guidance="g")

    assert cli_plan is not None and api_plan is not None
    assert cli_plan == api_plan
    assert [a.kind for a in cli_plan.actions] == ["post"]


def test_the_swap_test_can_actually_fail() -> None:
    """The assertion above is only worth having if a difference in model output
    would break it. Feed the API side a different plan and confirm the two stop
    matching -- without this, a `plan_round` that returned `None` for both
    would satisfy the test for the wrong reason."""
    persona = _persona(declared_backend="claude")
    cli_choice, _ = resolve_backend_choice(persona, _settings())
    cli_plan = plan_round(
        get_backend(cli_choice, RecordingRunner(PLAN_JSON), _settings()),
        persona,
        ActContext(),
        rhythm_guidance="g",
    )
    other = json.dumps({"plan": [{"action": "like", "id": "abc"}]})
    api_plan = plan_round(_api_backend_returning(other), persona, ActContext(), rhythm_guidance="g")
    assert cli_plan is not None and api_plan is not None
    assert cli_plan != api_plan


# ── the seam the CLI tests depend on ──────────────────────────────────────
#
# These four exist because the first version of `_select_backend` built the
# backend itself and left `_backend_for` orphaned. Roughly eighteen tests in
# `test_cli.py` replace `_backend_for` with a two-argument lambda, and that
# substitution is the ONLY thing stopping a unit test from spawning a real
# `claude -p`. Orphaning it did not fail those tests -- it made the suite hang
# for ten minutes on a live CLI call. A moved seam is invisible to the tests
# that depend on it, so it needs a test of its own.


def test_select_backend_builds_cli_kinds_through_the_patched_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from swil_agent import cli

    sentinel = object()
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: sentinel)
    _, backend = cli._select_backend(_persona(declared_backend="claude"), _settings())
    assert backend is sentinel


def test_the_patched_name_takes_exactly_two_positional_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A defaulted third parameter would still break every stub in
    `test_cli.py`, because they are all two-argument lambdas. Calling the real
    function with exactly two positional arguments is what pins the shape."""
    import inspect

    from swil_agent import cli

    params = list(inspect.signature(cli._backend_for).parameters.values())
    assert [p.name for p in params] == ["persona", "settings"]
    assert all(p.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD for p in params)


def test_select_backend_returns_the_resolved_persona(monkeypatch: pytest.MonkeyPatch) -> None:
    """The persona travelling back out is how `agentBackend`,
    `CompletionRequest.model` and the two `== "codex"` branches all see the
    override without a new parameter on `run_act`."""
    from swil_agent import cli

    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: object())
    resolved, _ = cli._select_backend(
        _persona(declared_backend="claude", model="opus"),
        _settings(),
        backend_override="codex",
    )
    assert (resolved.backend, resolved.model) == ("codex", "opus")


def test_select_backend_does_not_route_api_through_the_cli_seam(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`_backend_for` maps a persona's `backend` string to a CLI kind. After
    `apply_choice` an api round's `backend` is the PROVIDER wire name (`xai`),
    which that mapping does not recognise -- so sending it there would take the
    `*)` fallback and quietly run the round on the claude CLI instead of xAI."""
    from swil_agent import cli

    def _explode(persona: Any, settings: Any) -> Any:
        raise AssertionError("an api round must not be built through the CLI seam")

    monkeypatch.setattr(cli, "_backend_for", _explode)
    _, backend = cli._select_backend(_persona(declared_backend=None), _api_settings())
    assert isinstance(backend, ApiBackend)


def test_cli_choice_for_refuses_a_provider_wire_name() -> None:
    """The guard underneath the test above, asserted directly."""
    from swil_agent.llm.selection import cli_choice_for

    persona = _persona(declared_backend=None)
    with pytest.raises(BackendConfigurationError, match="provider wire name"):
        cli_choice_for(persona.model_copy(update={"backend": "xai"}))


def test_cli_choice_for_still_forgives_an_unknown_bullet() -> None:
    """`mangniu`'s `haiku` must keep taking `llm.sh`'s `*)` branch -- the guard
    above must not have turned the forgiving path into an error."""
    from swil_agent.llm.selection import cli_choice_for

    assert cli_choice_for(_persona(declared_backend="haiku")).kind == "claude_cli"


def test_an_unhandled_kind_is_refused_rather_than_defaulted() -> None:
    """The factory's final branch. A kind added to `BackendKind` but not to the
    factory must fail loudly; falling through to a default would run every
    account of the new arm on the claude CLI while reporting the new name."""
    from swil_agent.llm.selection import BackendChoice

    bogus = BackendChoice(
        kind="mystery",  # type: ignore[arg-type]
        model=None,
        kind_source="env",
        model_source="default",
    )
    with pytest.raises(BackendConfigurationError, match="unhandled backend kind"):
        get_backend(bogus, RecordingRunner(), _settings())


def test_cli_choice_for_refuses_the_literal_api_kind() -> None:
    """Distinct from the provider-wire-name guard: this is a persona whose
    `backend` reads `api` verbatim, which `normalize_kind` DOES recognise."""
    from swil_agent.llm.selection import cli_choice_for

    persona = _persona().model_copy(update={"backend": "api"})
    with pytest.raises(BackendConfigurationError, match="CLI backends only"):
        cli_choice_for(persona)
