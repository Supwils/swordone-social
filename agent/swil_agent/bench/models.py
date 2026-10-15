"""What a bench `<model>` argument means, and the backend that runs it.

Three spellings from `benchmark-run.sh:92-99`, kept exactly (S3 §12.23):

  * `codex`    -- the codex CLI with its own default model (no `-m`);
  * `ds-flash` -- DeepSeek V4 Flash on the Anthropic-compatible endpoint,
    the DeepSeek env applied to that subprocess only;
  * any other bare word -- a claude CLI alias (`claude --model <word>`).
    That includes `grok` or `cursor`: in Bash a bare word was always a
    claude alias, and the rows already recorded under those names mean that.

And one new spelling, the roster's own: `<backend>:<model>` (`grok:grok-4.6`,
`codex:gpt-5.6-luna`), resolved through `llm.selection` and
`llm.factory.get_backend` exactly as a persona's `model:` frontmatter is, so an
Era 3 arm can be benched on the backend it runs on in the round.

Every backend built here is a tool-less CLI call (`--tools ""` / `-s
read-only` / cursor's ask mode), because they are the same backend classes the
round uses; the bench adds no call site of its own except the judge.

The results directory is the model string with `:` replaced by `_`; the row's
`model` field keeps the string as typed.

**Timeout.** The model under test runs under the bench's own limit
(`--timeout` / `BENCH_TIMEOUT`, default 1200 s), not the round's 300 s
`DEFAULT_TIMEOUT`: the Bash `llm_text` had none, and real codex rows took up to
333 s -- a 300 s cut would silently drop the slowest runs from the series. A
call that still times out is reported as `TIMEOUT`, not `EMPTY`
(`TimedRunner.timed_out`). The round's callers keep 300 s.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

from swil_agent.bench.errors import EXIT_NO_ACTION, EXIT_USAGE, BenchStop
from swil_agent.config import Settings
from swil_agent.llm.backends import build_backend
from swil_agent.llm.backends.claude import DEEPSEEK_DEFAULT_MODEL, ClaudeCLIBackend
from swil_agent.llm.backends.codex import CodexCLIBackend
from swil_agent.llm.errors import BackendConfigurationError, BackendUnavailableError
from swil_agent.llm.factory import get_backend
from swil_agent.llm.protocol import Backend
from swil_agent.llm.runner import DEFAULT_TIMEOUT, StatusRunner
from swil_agent.llm.selection import normalize_kind, resolve_backend_choice
from swil_agent.models import Persona
from swil_agent.persona.loader import split_model

CODEX: Final = "codex"
DS_FLASH: Final = "ds-flash"
# `benchmark-run.sh:96` passed this literal, which is also the backend default.
DS_FLASH_MODEL: Final = DEEPSEEK_DEFAULT_MODEL

# `benchmarkRunIngest.model` is `z.string().trim().min(1).max(40)`.
MAX_MODEL_LENGTH: Final = 40

DEFAULT_BENCH_TIMEOUT: Final = 1200.0


class TimedRunner:
    """The model under test's `Runner`: every call runs under the bench's
    timeout (whatever the backend asked for), and a timeout since the last
    `reset()` is remembered so the bench can say `TIMEOUT` rather than
    `EMPTY` -- `SubprocessRunner` answers a timed-out call with `""`, which a
    backend reports exactly like a model with nothing to say."""

    def __init__(self, inner: StatusRunner, timeout: float) -> None:
        self._inner = inner
        self.timeout = timeout
        self.timed_out = False

    def reset(self) -> None:
        self.timed_out = False

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> str:
        _ = timeout  # the bench's own limit replaces the backend's default
        result = self._inner.run_result(argv, stdin, env, self.timeout)
        if result.timed_out:
            self.timed_out = True
        return result.stdout


@dataclass(frozen=True)
class ModelUnderTest:
    """`spec` is the argument as typed (the row's `model`); `model` is what
    travels on `CompletionRequest.model` (`None` = the CLI's own default).
    `watch` is the `TimedRunner` the backend calls through (`None` for a
    backend built without one, e.g. in tests)."""

    spec: str
    backend: Backend
    model: str | None
    watch: TimedRunner | None = field(default=None, compare=False)

    @property
    def dir_name(self) -> str:
        return model_dir_name(self.spec)


def model_dir_name(spec: str) -> str:
    return spec.replace(":", "_")


def is_codex(spec: str) -> bool:
    """`--codex-k` applies to every model whose backend is codex: the bare
    word, and any `codex:<model>` (Bash knew only the bare word)."""
    if spec == CODEX:
        return True
    backend, sep, _ = spec.partition(":")
    return bool(sep) and normalize_kind(backend) == "codex_cli"


def check_model_spec(spec: str) -> None:
    """Refuse (64) a model string the server or the results path cannot take:
    empty, over 40 characters, a path separator, or a `<backend>:<model>`
    with an unknown backend or no model. An empty model half would fall
    through to `SWIL_LLM_MODEL` -- an exported env var silently choosing the
    model under test."""
    if not spec.strip() or len(spec) > MAX_MODEL_LENGTH:
        raise BenchStop(
            EXIT_USAGE, f"bench: model {spec!r} must be 1-{MAX_MODEL_LENGTH} characters"
        )
    if "/" in spec or "\\" in spec or spec in {".", ".."}:
        raise BenchStop(EXIT_USAGE, f"bench: model {spec!r} cannot name a results directory")
    if ":" not in spec:
        return
    backend, model = split_model(spec)
    if normalize_kind(backend) is None:
        raise BenchStop(EXIT_USAGE, f"bench: model {spec!r} names no known backend")
    if model is None:
        raise BenchStop(EXIT_USAGE, f"bench: model {spec!r} has no model after the ':'")


def _selection_persona(backend: str, model: str) -> Persona:
    """The minimal `Persona` `resolve_backend_choice` reads. Both halves go
    in as FLAG overrides, so neither the (absent) file nor `SWIL_LLM_*`
    can outrank what the operator typed."""
    return Persona(
        username="bench",
        display_name="bench",
        topics=["bench"],
        backend=backend,
        model=model,
        board="bench",
        era=3,
        card="",
        prompt="",
        directory=Path("."),
    )


def resolve_model(
    spec: str,
    runner: StatusRunner,
    settings: Settings,
    *,
    timeout: float = DEFAULT_BENCH_TIMEOUT,
    deepseek_api_key: str | None = None,
) -> ModelUnderTest:
    """Build the backend `spec` names, calling through a `TimedRunner` over
    `runner` with `timeout`. A backend that cannot be built -- no DeepSeek
    key, an api provider with no key, a cursor/grok spelling the selection
    refuses -- stops the run with 75 and the reason.

    `deepseek_api_key` is the same test-only seam `build_backend` has."""
    check_model_spec(spec)
    timed = TimedRunner(runner, timeout)
    try:
        if spec == CODEX:
            return ModelUnderTest(spec, CodexCLIBackend(timed), None, timed)
        if spec == DS_FLASH:
            backend = build_backend("deepseek", timed, settings, deepseek_api_key=deepseek_api_key)
            return ModelUnderTest(spec, backend, DS_FLASH_MODEL, timed)
        if ":" in spec:
            backend_name, model = split_model(spec)
            assert model is not None  # check_model_spec refused a bare `<backend>:`
            choice, _ = resolve_backend_choice(
                _selection_persona(backend_name, model),
                settings,
                backend_override=backend_name,
                model_override=model,
            )
            built = get_backend(choice, timed, settings, deepseek_api_key=deepseek_api_key)
            return ModelUnderTest(spec, built, choice.model, timed)
        return ModelUnderTest(spec, ClaudeCLIBackend(timed), spec, timed)
    except (BackendConfigurationError, BackendUnavailableError) as exc:
        raise BenchStop(EXIT_NO_ACTION, f"bench: model {spec!r} cannot run -- {exc}") from exc
