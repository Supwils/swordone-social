"""Which backend, which model, and where each answer came from.

One place resolves the question, so that every path -- act, dream, cycle --
runs the same model for the same reason, and so the round can SAY which model
it ran. `llm/backends/` knows how to talk to a backend; this module knows which
one to build.

**Precedence, highest first:**

    kind:  --backend flag  >  personality.md `AI Backend:`  >  SWIL_LLM_BACKEND  >  claude
    model: --model flag    >  personality.md `Model:`       >  SWIL_LLM_MODEL    >  backend default

The persona file sitting ABOVE the environment is the load-bearing half. Each
account's backend is the drift experiment's independent variable: an env var
that silently outranked the roster would re-assign every arm at once, and the
series either side of that round would be two experiments wearing one name. So
`SWIL_LLM_BACKEND` is a DEFAULT for accounts that declare nothing, not an
override -- and the explicit CLI flag, where the operator has named one
account and one model in one command, is the only thing that outranks the file.

That distinction needs "the file declares nothing" to be representable, which
is why `Persona` carries `declared_backend` (the raw bullet, `None` when
absent) beside `backend` (the same value defaulted to `"claude"`). Through
2026-08-25 that was a live case for hodlge / lvchuang / zaofan; they now
declare `codex`. The field stays, because a new account can still ship
without the bullet.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

from swil_agent.config import Settings
from swil_agent.llm.errors import BackendConfigurationError
from swil_agent.models import Persona

BackendKind = Literal["claude_cli", "codex_cli", "deepseek_cli", "cursor_cli", "grok_cli", "api"]
ChoiceSource = Literal["flag", "persona", "env", "default"]

DEFAULT_KIND: Final[BackendKind] = "claude_cli"

# What a personality.md bullet or an env var may spell, and the kind it means.
# Both the short form the roster actually writes (`claude`) and the long form
# the settings document (`claude_cli`) resolve to the same kind, so an operator
# never has to remember which spelling a given surface wanted.
_KIND_ALIASES: Final[dict[str, BackendKind]] = {
    "claude": "claude_cli",
    "claude_cli": "claude_cli",
    "codex": "codex_cli",
    "codex_cli": "codex_cli",
    "deepseek": "deepseek_cli",
    "deepseek_cli": "deepseek_cli",
    "cursor": "cursor_cli",
    "cursor_cli": "cursor_cli",
    "cursor_agent": "cursor_cli",
    "grok": "grok_cli",
    "grok_cli": "grok_cli",
    "api": "api",
}

# The label half that goes on the wire, i.e. into `agentBackend`. It is NOT
# the kind: the roster has recorded `claude` / `codex` / `deepseek` for the
# whole life of the drift series, `act/round.py` and `act/context.py` both
# branch on the literal string `"codex"`, and `/lab` groups by this value.
# Renaming it to the internal kind would silently split every account's series
# in two at the cutover round.
_KIND_WIRE_NAME: Final[dict[BackendKind, str]] = {
    "claude_cli": "claude",
    "codex_cli": "codex",
    "deepseek_cli": "deepseek",
    "cursor_cli": "cursor",
    "grok_cli": "grok",
    "api": "api",  # replaced by the provider's wire name; see `resolve_backend_choice`
}


@dataclass(frozen=True)
class Provider:
    """One HTTP vendor: how to frame a request, and what to call it."""

    protocol: Literal["anthropic", "openai"]
    wire: str
    base_url: str | None


# `openai_compatible` is the generic escape hatch -- Groq, Together, vLLM,
# DeepSeek's own OpenAI-shaped endpoint, anything that speaks
# POST {base}/chat/completions. It ships no default base URL precisely because
# there is no such thing as a default for "some OpenAI-compatible server", and
# guessing one would turn a missing setting into a call against the wrong host.
PROVIDERS: Final[dict[str, Provider]] = {
    "anthropic": Provider("anthropic", "anthropic", "https://api.anthropic.com"),
    "xai": Provider("openai", "xai", "https://api.x.ai/v1"),
    "openai": Provider("openai", "openai", "https://api.openai.com/v1"),
    "openai_compatible": Provider("openai", "openai-compat", None),
}

# `agentBackend` is `z.string().trim().min(1).max(40)` on the server
# (`users.schemas.ts`). Over that, the PATCH 400s -- and `sync_backend_step`
# logs a WARN and carries on (`act/round.py`), by design, because a profile
# sync must not be able to fail a round. The two behaviours compose badly: a
# too-long label loses the experiment's independent variable for that account,
# every round, with nothing louder than one line in the act log to say so.
# Checked here instead, where the operator is still holding the config that
# caused it.
WIRE_LABEL_MAX_LENGTH: Final = 40


@dataclass(frozen=True)
class BackendChoice:
    """The resolved answer, plus the provenance of each half.

    `kind_source` / `model_source` exist for the log line and the round record.
    "Which model did this round use" and "why that one" are different
    questions, and an experiment notebook needs both: `claude:opus` because the
    persona file says so is a data point; `claude:opus` because someone left
    `SWIL_LLM_MODEL` exported is a contaminated round.
    """

    kind: BackendKind
    model: str | None
    kind_source: ChoiceSource
    model_source: ChoiceSource
    provider: str | None = None
    base_url: str | None = None

    @property
    def wire_name(self) -> str:
        """The backend half of `agentBackend` -- `claude`, `codex`, `xai`, ..."""
        if self.kind == "api" and self.provider is not None:
            return PROVIDERS[self.provider].wire
        return _KIND_WIRE_NAME[self.kind]

    @property
    def wire_label(self) -> str:
        """The full `agentBackend` value: `<wire_name>[:<model>]`.

        Same shape as always
        (`"${ai_backend}${ai_model:+:$ai_model}"`), so existing rows and new
        ones stay comparable and `/lab` needs no migration.
        """
        return f"{self.wire_name}:{self.model}" if self.model else self.wire_name

    def describe(self) -> str:
        """One line for the round log. Never carries a key or a full URL."""
        parts = [f"backend={self.wire_name}({self.kind_source})"]
        parts.append(f"model={self.model or '<backend default>'}({self.model_source})")
        if self.provider is not None:
            parts.append(f"provider={self.provider}")
        return " ".join(parts)


def normalize_kind(raw: str) -> BackendKind | None:
    """Map a spelling to a kind, or `None` if it is not one.

    `None` rather than a raise: `mangniu`'s `AI Backend:` bullet says `haiku`,
    which is a MODEL name in the backend slot. Bash's `llm.sh` sent every
    unrecognised name down its `*)` default branch to the claude CLI, and this
    runtime has always matched that (`build_backend`'s docstring). Turning it
    into an error now would fail an account that has been running fine for
    months; the caller warns instead.
    """
    return _KIND_ALIASES.get(raw.strip().lower().replace("-", "_"))


def resolve_backend_choice(
    persona: Persona,
    settings: Settings,
    *,
    backend_override: str | None = None,
    model_override: str | None = None,
) -> tuple[BackendChoice, list[str]]:
    """Resolve one account's backend and model. Returns the choice and warnings.

    Warnings are returned rather than logged so this stays a pure function --
    the composition root owns the logger, and a test can assert on the text
    without capturing log records.
    """
    warnings: list[str] = []

    kind, kind_source = _resolve_kind(persona, settings, backend_override, warnings)
    model, model_source = _resolve_model(persona, settings, model_override)

    if kind == "cursor_cli" and model is None:
        # `cursor-agent` with no `--model` silently uses its `auto` router,
        # which re-picks whenever Cursor changes routing -- while
        # `agentBackend` would still read a flat `cursor`. An experiment whose
        # independent variable can move on someone else's deploy is not
        # measuring what it claims to. The CLI backends that DO have a stable
        # default of their own (claude, codex) are deliberately not subject to
        # this.
        raise BackendConfigurationError(
            "the cursor backend requires an explicit model -- set SWIL_LLM_MODEL, "
            "pass --model, or give the account a `- **Model:**` bullet "
            "(`cursor-agent --list-models` shows the ids)"
        )

    if kind == "grok_cli" and model is None:
        # Same shape as cursor, even though the grok CLI's current default
        # (`grok-4.6`) is a real named model rather than a router. A missing
        # Model bullet would still record a flat `grok` while that default
        # can move on a grok.com deploy.
        raise BackendConfigurationError(
            "the grok backend requires an explicit model -- set SWIL_LLM_MODEL, "
            "pass --model, or give the account a `- **Model:**` bullet "
            "(`grok models` shows the ids)"
        )

    provider: str | None = None
    base_url: str | None = None
    if kind == "api":
        provider, base_url = _resolve_provider(settings)
        if model is None:
            raise BackendConfigurationError(
                "the api backend has no default model -- set SWIL_LLM_MODEL, pass "
                "--model, or give the account a `- **Model:**` bullet"
            )
        if settings.swil_llm_api_key is None:
            raise BackendConfigurationError(
                f"the api backend needs a key -- set SWIL_LLM_API_KEY (provider={provider})"
            )

    choice = BackendChoice(
        kind=kind,
        model=model,
        kind_source=kind_source,
        model_source=model_source,
        provider=provider,
        base_url=base_url,
    )
    _check_wire_label(choice)
    return choice, warnings


def _resolve_kind(
    persona: Persona,
    settings: Settings,
    override: str | None,
    warnings: list[str],
) -> tuple[BackendKind, ChoiceSource]:
    for raw, source in (
        (override, "flag"),
        (persona.declared_backend, "persona"),
        (settings.swil_llm_backend, "env"),
    ):
        if raw is None:
            continue
        kind = normalize_kind(raw)
        if kind is not None:
            return kind, source  # type: ignore[return-value]
        if source == "flag":
            # An operator who typed `--backend gork` gets told, not defaulted.
            # The forgiving path below exists for the roster's own historical
            # spellings, not for a typo made ten seconds ago.
            raise BackendConfigurationError(
                f"unknown backend {raw!r} -- expected one of "
                f"{', '.join(sorted(set(_KIND_ALIASES)))}"
            )
        warnings.append(
            f"{persona.username}: {source} declares backend {raw!r}, which is not a "
            f"backend name -- falling back to {DEFAULT_KIND} (matching llm.sh's `*)` branch)"
        )
        return DEFAULT_KIND, source  # type: ignore[return-value]
    return DEFAULT_KIND, "default"


def _resolve_model(
    persona: Persona, settings: Settings, override: str | None
) -> tuple[str | None, ChoiceSource]:
    for raw, source in (
        (override, "flag"),
        (persona.model, "persona"),
        (settings.swil_llm_model, "env"),
    ):
        if raw:
            return raw, source  # type: ignore[return-value]
    return None, "default"


def _resolve_provider(settings: Settings) -> tuple[str, str]:
    name = (settings.swil_llm_provider or "openai_compatible").strip().lower()
    provider = PROVIDERS.get(name)
    if provider is None:
        raise BackendConfigurationError(
            f"unknown provider {name!r} -- expected one of {', '.join(sorted(PROVIDERS))}"
        )
    base_url = settings.swil_llm_base_url or provider.base_url
    if not base_url:
        raise BackendConfigurationError(
            f"provider {name!r} has no default base URL -- set SWIL_LLM_BASE_URL "
            "(as the vendor documents it, including any /v1 suffix)"
        )
    return name, base_url.rstrip("/")


def _check_wire_label(choice: BackendChoice) -> None:
    label = choice.wire_label
    if len(label) > WIRE_LABEL_MAX_LENGTH:
        raise BackendConfigurationError(
            f"agentBackend label {label!r} is {len(label)} characters; the server "
            f"accepts at most {WIRE_LABEL_MAX_LENGTH}, and a rejected sync is only a "
            "WARN -- the round would run with its backend unrecorded. Use a shorter "
            "model alias."
        )


def apply_choice(persona: Persona, choice: BackendChoice) -> Persona:
    """Return `persona` with `backend`/`model` set to what will actually run.

    This is what makes the resolution visible to the whole round without
    threading a new parameter through `CycleDeps` and every graph node.
    Three existing readers pick it up for free, and all three want the
    resolved value rather than the file's:

      * `act/round.py`'s `_agent_backend_value` -- builds the `agentBackend`
        the profile sync PATCHes, i.e. the drift experiment's independent
        variable. It must name the model the round RAN, not the one the file
        happened to declare.
      * `act/planner.py` and `dream/round.py` -- pass `persona.model` into
        `CompletionRequest.model`, which is how `--model` gets to win over the
        file at all.
      * `act/round.py` and `act/context.py` -- both branch on
        `persona.backend == "codex"` to apply the codex action constraint. An
        account moved off codex should stop carrying it, and one moved onto it
        should start.

    `raw` is untouched, so the dream's structural validators still round-trip
    the file's own `AI Backend` bullet (`persona/validators.py`) and a dream
    can never write an overridden backend back into personality.md.
    """
    return persona.model_copy(update={"backend": choice.wire_name, "model": choice.model})


def cli_choice_for(persona: Persona) -> BackendChoice:
    """The `BackendChoice` an already-resolved CLI persona implies.

    Exists for one narrow caller: `backend_for` (defined in
    `cli/compose_backend.py`, re-bound as `compose.backend_for`), whose signature is
    frozen at `(persona, settings)` because ~18 tests replace that exact name
    with a two-argument lambda. It receives the resolved Persona but not the
    choice that produced it, and this reconstructs the half it needs.

    Refuses an api persona rather than defaulting one. `persona.backend` for an
    api round is the PROVIDER's wire name (`xai`), which `normalize_kind` does
    not recognise -- so the forgiving `*)`-style fallback that is correct for
    `mangniu`'s `haiku` bullet would here silently route an xAI round to the
    claude CLI. Loud is the only safe answer.
    """
    kind = normalize_kind(persona.backend)
    if kind == "api":
        raise BackendConfigurationError(
            "cli_choice_for is for CLI backends only; an api round is built from "
            "its own resolved choice"
        )
    if kind is None:
        if persona.backend not in _KIND_ALIASES and any(
            PROVIDERS[name].wire == persona.backend for name in PROVIDERS
        ):
            raise BackendConfigurationError(
                f"{persona.backend!r} is a provider wire name, not a CLI backend -- "
                "an api round is built from its own resolved choice"
            )
        kind = DEFAULT_KIND
    return BackendChoice(
        kind=kind,
        model=persona.model,
        kind_source="persona",
        model_source="persona",
    )
