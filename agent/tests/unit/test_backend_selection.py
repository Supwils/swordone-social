"""Which backend a round runs, and where that answer came from.

The precedence ladder here is the drift experiment's safety catch: each
account's backend is the independent variable, so an environment variable that
outranked `personality.md` would silently re-assign every arm at once and split
every account's series in two at the round it was exported. These tests pin the
direction of that ranking, not just its existence.
"""

from __future__ import annotations

import pytest

from swil_agent.config import Settings
from swil_agent.llm.errors import BackendConfigurationError
from swil_agent.llm.selection import (
    WIRE_LABEL_MAX_LENGTH,
    apply_choice,
    normalize_kind,
    resolve_backend_choice,
)
from swil_agent.models import Persona

from ._runners import make_persona


def _persona(
    *,
    declared_backend: str | None = "claude",
    model: str | None = None,
    raw: str = "- **Username:** zenith\n",
) -> Persona:
    return make_persona(
        backend=declared_backend or "claude",
        declared_backend=declared_backend,
        model=model,
        raw=raw,
    )


def _settings(**kwargs: object) -> Settings:
    return Settings(swil_url="https://example.test", **kwargs)  # type: ignore[arg-type]


# ── the ladder ────────────────────────────────────────────────────────────


def test_persona_bullet_outranks_the_environment() -> None:
    """The half that protects the experiment. `SWIL_LLM_BACKEND` is a default
    for accounts that declare nothing, never an override for accounts that do."""
    choice, warnings = resolve_backend_choice(
        _persona(declared_backend="codex"),
        _settings(swil_llm_backend="api", swil_llm_model="grok-4.6"),
    )
    assert (choice.kind, choice.kind_source) == ("codex_cli", "persona")
    assert warnings == []


def test_environment_applies_only_when_the_file_declares_nothing() -> None:
    """hodlge, lvchuang and zaofan ship no `AI Backend:` bullet, which is why
    `declared_backend` exists as something separate from `backend`."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend=None),
        _settings(
            swil_llm_backend="api",
            swil_llm_provider="xai",
            swil_llm_model="grok-4.6",
            swil_llm_api_key="k",
        ),
    )
    assert (choice.kind, choice.kind_source) == ("api", "env")


def test_flag_outranks_the_persona_file() -> None:
    """One account, one command, one operator: the only thing allowed to
    outrank the roster is an instruction typed about this exact round."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend="claude", model="opus"),
        _settings(),
        backend_override="codex",
        model_override="gpt-5",
    )
    assert (choice.kind, choice.kind_source) == ("codex_cli", "flag")
    assert (choice.model, choice.model_source) == ("gpt-5", "flag")


def test_nothing_declared_anywhere_is_the_historical_default() -> None:
    choice, _ = resolve_backend_choice(_persona(declared_backend=None), _settings())
    assert (choice.kind, choice.kind_source) == ("claude_cli", "default")
    assert (choice.model, choice.model_source) == (None, "default")


def test_model_ladder_is_independent_of_the_backend_ladder() -> None:
    """A file that declares a backend but no model still picks the model up
    from the environment -- the two halves rank separately, so setting
    `SWIL_LLM_MODEL` for a sweep does not require touching the roster."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend="claude", model=None),
        _settings(swil_llm_model="sonnet"),
    )
    assert (choice.kind_source, choice.model, choice.model_source) == ("persona", "sonnet", "env")


# ── spellings ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("claude", "claude_cli"),
        ("claude_cli", "claude_cli"),
        ("Claude", "claude_cli"),
        ("claude-cli", "claude_cli"),
        ("codex", "codex_cli"),
        ("deepseek", "deepseek_cli"),
        ("grok", "grok_cli"),
        ("grok_cli", "grok_cli"),
        ("api", "api"),
        ("haiku", None),
        ("", None),
    ],
)
def test_normalize_kind_accepts_both_spellings(raw: str, expected: str | None) -> None:
    """The roster writes `claude`; the settings document `claude_cli`. Both
    have to mean the same thing or an operator has to remember which surface
    wanted which."""
    assert normalize_kind(raw) == expected


def test_unknown_persona_bullet_warns_and_falls_back() -> None:
    """`mangniu` records `AI Backend: haiku` -- a MODEL name in the backend
    slot. Bash's `llm.sh` sent every unrecognised name down its `*)` branch to
    the claude CLI and the account has run that way for months, so this must
    not become an error. It must, however, stop being silent."""
    choice, warnings = resolve_backend_choice(
        _persona(declared_backend="haiku", model="haiku"), _settings()
    )
    assert choice.kind == "claude_cli"
    assert len(warnings) == 1
    assert "haiku" in warnings[0]


def test_unknown_flag_is_an_error_not_a_fallback() -> None:
    """The forgiving path above exists for the roster's historical spellings.
    A flag typed ten seconds ago is a typo, and defaulting it would run the
    wrong model while reporting success."""
    with pytest.raises(BackendConfigurationError, match="unknown backend 'gork'"):
        resolve_backend_choice(_persona(), _settings(), backend_override="gork")


# ── the wire label ────────────────────────────────────────────────────────


def test_cli_wire_labels_are_unchanged_from_bash() -> None:
    """`auto-run.sh:492` produced `<backend>[:<model>]` for the entire life of
    the drift series, and `/lab` groups by it. The internal kind
    (`claude_cli`) must never reach the wire."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend="claude", model="opus"), _settings()
    )
    assert choice.wire_name == "claude"
    assert choice.wire_label == "claude:opus"


def test_grok_without_a_model_is_a_configuration_error() -> None:
    with pytest.raises(BackendConfigurationError, match="grok backend requires an explicit model"):
        resolve_backend_choice(_persona(declared_backend="grok"), _settings())


def test_grok_wire_label_names_the_cli_not_xai() -> None:
    """`grok:grok-4.6` is the grok.com CLI. `xai:grok-4.6` is the HTTP API.
    Collapsing them would mix two quota pools under one independent variable."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend="grok", model="grok-4.6"), _settings()
    )
    assert choice.kind == "grok_cli"
    assert choice.wire_label == "grok:grok-4.6"


def test_a_backend_with_no_model_has_no_colon() -> None:
    """`${ai_model:+:$ai_model}` expands to nothing for an empty model, so a
    modelless account never grew a trailing colon. quant/sketch/vex/zhuiyi are
    all in this shape."""
    choice, _ = resolve_backend_choice(_persona(declared_backend="codex"), _settings())
    assert choice.wire_label == "codex"


def test_api_label_names_the_provider_not_the_word_api() -> None:
    """`xai:grok-4.6` keeps the existing two-part shape, so old rows and new
    ones stay comparable and `/lab` needs no migration. `api` is an internal
    kind; the experimentally meaningful name is the vendor."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend=None),
        _settings(
            swil_llm_backend="api",
            swil_llm_provider="xai",
            swil_llm_model="grok-4.6",
            swil_llm_api_key="k",
        ),
    )
    assert choice.wire_label == "xai:grok-4.6"
    assert choice.base_url == "https://api.x.ai/v1"


def test_an_oversized_label_is_rejected_at_resolution_time() -> None:
    """`agentBackend` is `max(40)` server-side, and `sync_backend_step` only
    WARNs on a rejected PATCH -- so an over-long label would cost the account
    its independent variable every round, with one swallowed line to show for
    it. Caught here, while the operator still holds the config."""
    long_model = "m" * WIRE_LABEL_MAX_LENGTH
    with pytest.raises(BackendConfigurationError, match="at most 40"):
        resolve_backend_choice(
            _persona(declared_backend=None),
            _settings(
                swil_llm_backend="api",
                swil_llm_provider="xai",
                swil_llm_model=long_model,
                swil_llm_api_key="k",
            ),
        )


def test_a_label_exactly_at_the_limit_is_accepted() -> None:
    """The boundary is `<=`, not `<`. Without this the test above passes for a
    resolver that rejects everything."""
    model = "m" * (WIRE_LABEL_MAX_LENGTH - len("xai:"))
    choice, _ = resolve_backend_choice(
        _persona(declared_backend=None),
        _settings(
            swil_llm_backend="api",
            swil_llm_provider="xai",
            swil_llm_model=model,
            swil_llm_api_key="k",
        ),
    )
    assert len(choice.wire_label) == WIRE_LABEL_MAX_LENGTH


# ── api-specific configuration errors ─────────────────────────────────────


def test_api_without_a_model_is_rejected() -> None:
    """A CLI has its own default model; an HTTP API has none. Left unchecked
    this reaches the provider as `"model": null`."""
    with pytest.raises(BackendConfigurationError, match="no default model"):
        resolve_backend_choice(
            _persona(declared_backend=None),
            _settings(swil_llm_backend="api", swil_llm_provider="xai", swil_llm_api_key="k"),
        )


def test_api_without_a_key_is_rejected() -> None:
    with pytest.raises(BackendConfigurationError, match="SWIL_LLM_API_KEY"):
        resolve_backend_choice(
            _persona(declared_backend=None),
            _settings(swil_llm_backend="api", swil_llm_provider="xai", swil_llm_model="grok-4.6"),
        )


def test_unknown_provider_is_rejected() -> None:
    with pytest.raises(BackendConfigurationError, match="unknown provider"):
        resolve_backend_choice(
            _persona(declared_backend=None),
            _settings(
                swil_llm_backend="api",
                swil_llm_provider="gemini",
                swil_llm_model="x",
                swil_llm_api_key="k",
            ),
        )


def test_openai_compatible_demands_an_explicit_base_url() -> None:
    """There is no default host for "some OpenAI-compatible server", and
    guessing one turns a missing setting into a call against the wrong vendor."""
    with pytest.raises(BackendConfigurationError, match="SWIL_LLM_BASE_URL"):
        resolve_backend_choice(
            _persona(declared_backend=None),
            _settings(
                swil_llm_backend="api",
                swil_llm_provider="openai_compatible",
                swil_llm_model="x",
                swil_llm_api_key="k",
            ),
        )


def test_an_explicit_base_url_overrides_the_providers_default() -> None:
    """Proxies and regional endpoints are the point of the setting."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend=None),
        _settings(
            swil_llm_backend="api",
            swil_llm_provider="xai",
            swil_llm_base_url="https://proxy.internal/v1/",
            swil_llm_model="grok-4.6",
            swil_llm_api_key="k",
        ),
    )
    assert choice.base_url == "https://proxy.internal/v1"


def test_a_blank_env_value_means_unset_not_empty_string() -> None:
    """`SWIL_LLM_BACKEND=` is how a shell spells "off". Left as `""` it would
    be a declared source that resolves to nothing."""
    settings = _settings(swil_llm_backend="", swil_llm_model="  ")
    assert settings.swil_llm_backend is None
    assert settings.swil_llm_model is None


# ── applying the answer ───────────────────────────────────────────────────


def test_apply_choice_rewrites_what_the_round_reads() -> None:
    """`agentBackend`, `CompletionRequest.model`, and both `== "codex"` branches
    all read these two fields, which is how one resolution reaches all of them
    without a tenth parameter on `run_act`."""
    persona = _persona(declared_backend="claude", model="opus", raw="- **AI Backend:** claude\n")
    choice, _ = resolve_backend_choice(persona, _settings(), backend_override="codex")
    resolved = apply_choice(persona, choice)
    assert (resolved.backend, resolved.model) == ("codex", "opus")


def test_apply_choice_leaves_raw_alone() -> None:
    """`raw` is what the dream's structural validators round-trip
    (`persona/validators.py` pins `Username` and `AI Backend` as identical
    across a rewrite). If an override leaked into it, a `--backend` flag could
    make a dream write a backend the file never declared."""
    raw = "- **Username:** zenith\n- **AI Backend:** claude\n"
    persona = _persona(declared_backend="claude", raw=raw)
    choice, _ = resolve_backend_choice(persona, _settings(), backend_override="codex")
    assert apply_choice(persona, choice).raw == raw
    assert "codex" not in apply_choice(persona, choice).raw


def test_describe_names_the_source_of_each_half() -> None:
    """ "Which model" and "why that model" are different questions, and an
    experiment notebook that can only answer the first cannot tell a
    configured round from a contaminated one."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend="claude"), _settings(swil_llm_model="sonnet")
    )
    line = choice.describe()
    assert "backend=claude(persona)" in line
    assert "model=sonnet(env)" in line


def test_describe_never_carries_the_key() -> None:
    """This string goes into auto-run.log and dream.log, both of which are
    committed by the opportunistic round driver."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend=None),
        _settings(
            swil_llm_backend="api",
            swil_llm_provider="xai",
            swil_llm_model="grok-4.6",
            swil_llm_api_key="super-secret-key",
        ),
    )
    assert "super-secret-key" not in choice.describe()
    assert "provider=xai" in choice.describe()


# ── the cursor kind ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "spelling", ["cursor", "cursor_cli", "cursor-cli", "Cursor", "cursor_agent"]
)
def test_cursor_spellings_all_resolve(spelling: str) -> None:
    assert normalize_kind(spelling) == "cursor_cli"


def test_cursor_wire_label_names_cursor_not_the_vendor() -> None:
    """One credential reaches five vendors, so the wire name cannot be the
    vendor -- `cursor:<model>` keeps the two-part shape `/lab` already groups
    by, and the model id is where the vendor actually shows up."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend="cursor", model="cursor-grok-4.6-high"), _settings()
    )
    assert choice.kind == "cursor_cli"
    assert choice.wire_label == "cursor:cursor-grok-4.6-high"


def test_cursor_without_a_model_is_refused() -> None:
    """Unlike claude/codex, cursor-agent's no-model default is a ROUTER
    (`auto`) whose choice can change on Cursor's deploy while `agentBackend`
    still reads a flat `cursor`."""
    with pytest.raises(BackendConfigurationError, match="requires an explicit model"):
        resolve_backend_choice(_persona(declared_backend="cursor"), _settings())


def test_cursor_takes_its_model_from_the_environment_too() -> None:
    """The requirement is that a model be RESOLVED, not that the persona file
    carry it -- otherwise a global sweep could not set one."""
    choice, _ = resolve_backend_choice(
        _persona(declared_backend="cursor"), _settings(swil_llm_model="gemini-3.7-flash-high")
    )
    assert choice.wire_label == "cursor:gemini-3.7-flash-high"


def test_claude_and_codex_are_not_subject_to_the_model_requirement() -> None:
    """They have stable defaults of their own; quant/sketch/vex/zhuiyi run
    modelless today and must keep working."""
    choice, _ = resolve_backend_choice(_persona(declared_backend="codex"), _settings())
    assert choice.wire_label == "codex"


def test_the_longest_cursor_model_ids_overflow_the_server_limit() -> None:
    """Measured 2026-08-21: the longest id `cursor-agent --list-models` offers
    is 36 characters, and `cursor:` + 36 = 43 > 40. The guard fires rather than
    letting the PATCH 400 and the account run with its backend unrecorded --
    raising the server's `z.string().max(40)` is what would unblock these."""
    with pytest.raises(BackendConfigurationError, match="at most 40"):
        resolve_backend_choice(
            _persona(declared_backend="cursor", model="claude-opus-4-8-thinking-medium-fast"),
            _settings(),
        )
