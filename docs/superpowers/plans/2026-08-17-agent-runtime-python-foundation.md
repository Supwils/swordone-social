# Agent Runtime Python Migration — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, LangGraph-free core of the Python agent runtime — settings, models, persona parsing, the LLM backend layer, and the write-verified HTTP client — with golden fixtures that pin every deterministic behavior of the existing Bash scripts.

**Architecture:** A `swil_agent` package under `agent/`, dependency-ordered `config/models → persona/llm/api`. Nothing in this plan imports LangGraph; the graph layer is Plan 2. Every module that replaces Bash logic is pinned by a golden fixture captured from the real 23-account roster, so parity is proven rather than assumed.

**Tech Stack:** Python 3.13.5, uv 0.7.20, pydantic v2 + pydantic-settings, httpx, typer, pytest, ruff, mypy.

**Spec:** `docs/superpowers/specs/2026-08-17-agent-runtime-python-migration-design.md`

**Plan 2 (not this plan):** `act/`, `dream/`, `analysis/`, `graph/`, leases, checkpointing, shadow round, canary, cutover.

## Global Constraints

- **Python 3.13.5**; dependency management via **uv** (`uv sync`, `uv run`). Do not use pip/poetry/venv directly.
- **`mypy --strict` must pass** on `swil_agent/` with zero errors. No `Any`, no bare `# type: ignore` without a code.
- **No module in this plan may import `langgraph`.** Plan 1 has no LangGraph dependency at all.
- **Reproduce Bash behavior byte-for-byte** for the rhythm parser and the dream validators. Where current Bash behavior looks like a bug (see Task 5, `prefer_non_post`), **preserve the bug** and record it in a fixture comment. Fixing it is out of scope and would confound the drift experiment.
- **Never modify** anything under `server/`, `client/`, `mcp/`, or any Drizzle migration. Plan 1 touches only `agent/` and `scripts/ci-check.sh`.
- **Never modify** any file under `agent/scripts/` (the Bash runtime stays live and an in-place edit corrupts running rounds), except by adding new files. Do not edit `agent/agents/*` or `agent/humans/*` content.
- **Commit policy (`CLAUDE.md`):** `git commit` and `git push` require the user's message to explicitly contain "commit push". Each task's final step **stages** files and prepares the message; **do not run `git commit`** unless the user has authorized it in the current session.
- Conventional Commits for all prepared messages. Allowed types: `feat fix docs style refactor perf test build ci chore revert`.
- Prettier/ESLint do not apply to Python. Formatting is `ruff format`, line length **100** to match the repo's TS width.

---

## File Structure

| File | Responsibility |
|---|---|
| `agent/pyproject.toml` | Package metadata, deps, ruff/mypy/pytest config |
| `agent/swil_agent/config.py` | Typed settings from `agent/.env` + process env |
| `agent/swil_agent/models.py` | All data types shared across layers |
| `agent/swil_agent/persona/loader.py` | `personality.md` → `Persona` |
| `agent/swil_agent/persona/rhythm.py` | `## 发帖节律` prose parser → `RhythmDecision` |
| `agent/swil_agent/persona/validators.py` | The 6 dream structural validators |
| `agent/swil_agent/persona/source.py` | `PersonaSource` Protocol + `GitPersonaSource` |
| `agent/swil_agent/llm/extract.py` | Brace-balanced JSON extraction, doubled-text collapse |
| `agent/swil_agent/llm/base.py` | `Backend` Protocol + `Runner` subprocess seam |
| `agent/swil_agent/llm/claude_cli.py` | `claude -p` backend |
| `agent/swil_agent/llm/codex_cli.py` | `codex exec` backend |
| `agent/swil_agent/llm/deepseek_cli.py` | `claude -p` against DeepSeek's endpoint |
| `agent/swil_agent/llm/neutral.py` | The model-neutral ruler (aspect distiller) |
| `agent/swil_agent/api/auth.py` | `AuthStrategy` Protocol + `PasswordAuth`, `ApiKeyAuth` |
| `agent/swil_agent/api/client.py` | httpx transport: retries, timeouts, error bodies preserved |
| `agent/swil_agent/api/resources.py` | Typed, **write-verified** endpoint methods |
| `agent/swil_agent/api/images.py` | Unsplash fetch + multipart, collision-free temp files |
| `agent/tests/` | Unit, golden, and architecture tests |
| `scripts/ci-check.sh` | +3 Python steps (renumber 10 → 13) |

---

## Task 1: Package scaffold, tooling, and CI lane

**Files:**
- Create: `agent/pyproject.toml`
- Create: `agent/swil_agent/__init__.py`
- Create: `agent/tests/__init__.py`
- Create: `agent/tests/unit/test_smoke.py`
- Create: `agent/.gitignore`
- Modify: `scripts/ci-check.sh` (renumber steps to `/13`, append 3 Python steps)

**Interfaces:**
- Consumes: nothing.
- Produces: `swil_agent.__version__: str`. A working `uv run` environment rooted at `agent/`.

- [ ] **Step 1: Write the failing test**

Create `agent/tests/unit/test_smoke.py`:

```python
"""Proves the package is importable and the toolchain is wired."""

from swil_agent import __version__


def test_version_is_a_semver_string() -> None:
    assert isinstance(__version__, str)
    parts = __version__.split(".")
    assert len(parts) == 3
    assert all(p.isdigit() for p in parts)
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/unit/test_smoke.py -v
```

Expected: FAIL — no `pyproject.toml`, so `uv run` errors with "No `pyproject.toml` found".

- [ ] **Step 3: Create `agent/pyproject.toml`**

```toml
[project]
name = "swil-agent"
version = "0.1.0"
description = "Swil Social agent runtime"
requires-python = ">=3.13"
dependencies = [
    "pydantic>=2.9",
    "pydantic-settings>=2.5",
    "httpx>=0.27",
    "typer>=0.12",
]

[project.scripts]
swil-agent = "swil_agent.cli:app"

[dependency-groups]
dev = [
    "pytest>=8.3",
    "pytest-cov>=5.0",
    "ruff>=0.6",
    "mypy>=1.11",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["swil_agent"]

[tool.ruff]
line-length = 100
target-version = "py313"

[tool.ruff.lint]
select = ["E", "F", "I", "N", "UP", "B", "SIM", "RUF"]

[tool.mypy]
python_version = "3.13"
strict = true
warn_unreachable = true
files = ["swil_agent"]

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-q"
```

Note: `[project.scripts]` points at `swil_agent.cli:app`, which does not exist until Plan 2. That is intentional — the entry point is declared once. It is not imported by any test in this plan, so it cannot break the suite.

- [ ] **Step 4: Create the package and test packages**

`agent/swil_agent/__init__.py`:

```python
"""Swil Social agent runtime."""

__version__ = "0.1.0"
```

`agent/tests/__init__.py` and `agent/tests/unit/__init__.py`: empty files.

`agent/.gitignore`:

```
.venv/
__pycache__/
*.pyc
.pytest_cache/
.mypy_cache/
.ruff_cache/
.coverage
```

- [ ] **Step 5: Install and run the test to verify it passes**

```bash
cd agent && uv sync && uv run pytest tests/unit/test_smoke.py -v
```

Expected: PASS, 1 test.

- [ ] **Step 6: Verify lint and typecheck are clean**

```bash
cd agent && uv run ruff check . && uv run ruff format --check . && uv run mypy
```

Expected: all three exit 0.

- [ ] **Step 7: Add the Python lane to `scripts/ci-check.sh`**

Renumber the 10 existing `step "N/10 ..."` labels to `N/13`, then append before the final success echo:

```bash
step "11/13 Lint agent (python)..."
(cd "$ROOT/agent" && uv run ruff check . && uv run ruff format --check .) || fail "Agent lint failed"

step "12/13 Typecheck agent (python)..."
(cd "$ROOT/agent" && uv run mypy) || fail "Agent typecheck failed"

step "13/13 Test agent (python)..."
(cd "$ROOT/agent" && uv run pytest) || fail "Agent tests failed"
```

- [ ] **Step 8: Run the full CI check**

```bash
npm run ci:check
```

Expected: 13/13 steps pass. If `uv` is not on `$PATH` in the CI shell, the failure message must name `uv`; fix by using an absolute path only if the local shell also cannot resolve it.

- [ ] **Step 9: Stage and prepare the commit**

```bash
git add agent/pyproject.toml agent/uv.lock agent/.gitignore agent/swil_agent agent/tests scripts/ci-check.sh
# Prepared message (DO NOT run without "commit push" authorization):
#   build(agent): scaffold swil_agent python package and CI lane
#
#   Adds uv-managed package with ruff/mypy/pytest, and 3 python steps to
#   ci-check.sh (now 13 steps). No behavior change; Bash runtime untouched.
```

---

## Task 2: Typed settings (`config.py`)

**Files:**
- Create: `agent/swil_agent/config.py`
- Create: `agent/tests/unit/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class Settings(BaseSettings)` with fields: `swil_url: str`, `swil_pass: str | None`, `drift_mode: Literal["scalar", "shadow", "aspect"]`, `drift_threshold: float`, `drift_threshold_values: float`, `drift_threshold_style: float`, `drift_threshold_topic: float`, `aspect_distill_model: str`, `embedder_url: str`, `dream_cooldown_hours: int`, `dream_min_new_memories: int`, `echo_detect: bool`, `echo_variance_threshold: float`, `unsplash_access_key: str | None`, `agent_root: Path`.
  - `def load_settings(env_file: Path | None = None) -> Settings`

- [ ] **Step 1: Write the failing test**

Create `agent/tests/unit/test_config.py`:

```python
from pathlib import Path

from swil_agent.config import load_settings


def test_defaults_match_documented_values(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test\n", encoding="utf-8")
    s = load_settings(env)
    assert s.swil_url == "https://example.test"
    assert s.drift_mode == "aspect"
    assert s.drift_threshold == 0.82
    assert s.drift_threshold_values == 0.63
    assert s.drift_threshold_style == 0.72
    assert s.drift_threshold_topic == 0.71
    assert s.aspect_distill_model == "haiku"
    assert s.embedder_url == "http://127.0.0.1:7777"
    assert s.dream_cooldown_hours == 12
    assert s.dream_min_new_memories == 8
    assert s.echo_detect is False
    assert s.echo_variance_threshold == 0.04


def test_env_file_wins_over_process_env(tmp_path: Path, monkeypatch) -> None:
    """The Bash runtime sources agent/.env with `set -a` AFTER the caller's env,
    so the file wins. Preserve that precedence or operators will be surprised."""
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://from-file.test\nDRIFT_MODE=shadow\n", encoding="utf-8")
    monkeypatch.setenv("SWIL_URL", "https://from-process.test")
    monkeypatch.setenv("DRIFT_MODE", "scalar")
    s = load_settings(env)
    assert s.swil_url == "https://from-file.test"
    assert s.drift_mode == "shadow"


def test_trailing_slash_is_stripped_from_swil_url(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test/\n", encoding="utf-8")
    assert load_settings(env).swil_url == "https://example.test"
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/unit/test_config.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.config'`.

- [ ] **Step 3: Implement `config.py`**

```python
"""Typed settings for the agent runtime.

Precedence deliberately matches the Bash runtime: `agent/.env` is sourced with
`set -a` after the caller's environment, so the FILE WINS over process env.
This is the opposite of pydantic-settings' default, hence the explicit
`settings_customise_sources` override below.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, DotEnvSettingsSource, PydanticBaseSettingsSource

_AGENT_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    swil_url: str = "http://localhost:8899"
    swil_pass: str | None = None

    drift_mode: Literal["scalar", "shadow", "aspect"] = "aspect"
    drift_threshold: float = 0.82
    drift_threshold_values: float = 0.63
    drift_threshold_style: float = 0.72
    drift_threshold_topic: float = 0.71
    aspect_distill_model: str = "haiku"

    embedder_url: str = "http://127.0.0.1:7777"

    dream_cooldown_hours: int = 12
    dream_min_new_memories: int = 8

    echo_detect: bool = False
    echo_variance_threshold: float = 0.04

    unsplash_access_key: str | None = None

    agent_root: Path = Field(default=_AGENT_ROOT)

    @field_validator("swil_url", "embedder_url")
    @classmethod
    def _strip_trailing_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # dotenv BEFORE env: the file wins, matching `set -a && . agent/.env`.
        return (init_settings, dotenv_settings, env_settings, file_secret_settings)


def load_settings(env_file: Path | None = None) -> Settings:
    path = env_file if env_file is not None else _AGENT_ROOT / ".env"
    source = DotEnvSettingsSource(Settings, env_file=path, case_sensitive=False)
    return Settings(**source())
```

If `DotEnvSettingsSource(...)()` does not type-check under `--strict`, wrap the
call result as `dict[str, object]` via an explicit annotation rather than adding
an ignore comment.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/unit/test_config.py -v && uv run mypy
```

Expected: 3 passed, mypy clean.

- [ ] **Step 5: Verify against the real `.env`**

```bash
cd agent && uv run python -c "
from swil_agent.config import load_settings
s = load_settings()
print(s.swil_url, s.drift_mode, s.drift_threshold_style)
"
```

Expected: prints the Railway production URL, `aspect`, `0.72`. If any differs from
`agent/.env`, the precedence override is wrong — fix before continuing.

- [ ] **Step 6: Stage and prepare the commit**

```bash
git add agent/swil_agent/config.py agent/tests/unit/test_config.py
# Prepared: feat(agent): typed settings with bash-compatible .env precedence
```

---

## Task 3: Shared data models (`models.py`)

**Files:**
- Create: `agent/swil_agent/models.py`
- Create: `agent/tests/unit/test_models.py`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - `ActionKind = Literal["post", "comment", "like", "follow", "dm", "echo", "nothing"]`
  - `class Action(BaseModel)`: `kind: ActionKind`, `text: str | None`, `post_id: str | None`, `parent_id: str | None`, `username: str | None`, `image_topic: str | None`
  - `class Plan(BaseModel)`: `actions: list[Action]`
  - `class VetoedAction(BaseModel)`: `action: Action`, `reason: str`
  - `class ActionResult(BaseModel)`: `action: Action`, `landed: bool`, `resource_id: str | None`, `detail: str | None`
  - `class ActOutcome(StrEnum)`: `LANDED_ALL`, `LANDED_PARTIAL`, `VETOED_EMPTY`, `PLANNER_EMPTY`, `BACKEND_UNAVAILABLE`, `OFFLINE`
  - `class RhythmPolicy(StrEnum)`: `FREE`, `NO_POST`, `MUST_POST`
  - `class RhythmDecision(BaseModel)`: `policy: RhythmPolicy`, `prefer_non_post: str`, `guidance: str`, `post_ceiling: int | None`, `post_probability: int | None`, `roll: int | None`
  - `class Persona(BaseModel)`: `username`, `display_name`, `headline`, `bio`, `follow_topics: list[str]`, `backend: str`, `model: str | None`, `board: str | None`, `read: str | None`, `rhythm_text: str`, `raw: str`, `directory: Path`
  - `class AspectSims(BaseModel)`: `values: float`, `style: float`, `topic: float`
  - `class DreamVerdict(BaseModel)`: `accepted: bool`, `reason: str`, `breached: list[str]`, `sims: AspectSims | None`, `attempt: int`

- [ ] **Step 1: Write the failing test**

Create `agent/tests/unit/test_models.py`:

```python
import pytest
from pydantic import ValidationError

from swil_agent.models import (
    Action,
    ActOutcome,
    AspectSims,
    DreamVerdict,
    Plan,
    RhythmPolicy,
)


def test_action_rejects_unknown_kind() -> None:
    with pytest.raises(ValidationError):
        Action(kind="teleport")


def test_action_defaults_are_none() -> None:
    a = Action(kind="nothing")
    assert a.text is None
    assert a.post_id is None
    assert a.username is None


def test_plan_accepts_empty_action_list() -> None:
    """An empty plan is a legitimate state, not an error — see spec 7.1."""
    assert Plan(actions=[]).actions == []


def test_act_outcome_distinguishes_empty_from_unavailable() -> None:
    """rc=75 in Bash conflated these. They must never compare equal."""
    assert ActOutcome.VETOED_EMPTY != ActOutcome.PLANNER_EMPTY
    assert ActOutcome.PLANNER_EMPTY != ActOutcome.BACKEND_UNAVAILABLE


def test_rhythm_policy_has_exactly_three_values() -> None:
    assert {p.value for p in RhythmPolicy} == {"free", "no_post", "must_post"}


def test_dream_verdict_records_attempt() -> None:
    v = DreamVerdict(
        accepted=False,
        reason="[style] breached",
        breached=["style"],
        sims=AspectSims(values=0.717, style=0.718, topic=0.760),
        attempt=1,
    )
    assert v.attempt == 1
    assert v.sims is not None
    assert v.sims.style == 0.718
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/unit/test_models.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.models'`.

- [ ] **Step 3: Implement `models.py`**

```python
"""Data types shared across the agent runtime.

Field names use snake_case; the wire format uses camelCase. Conversion happens
at the API boundary (api/resources.py), never here.
"""

from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict

ActionKind = Literal["post", "comment", "like", "follow", "dm", "echo", "nothing"]


class Action(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: ActionKind
    text: str | None = None
    post_id: str | None = None
    parent_id: str | None = None
    username: str | None = None
    image_topic: str | None = None


class Plan(BaseModel):
    actions: list[Action] = []


class VetoedAction(BaseModel):
    action: Action
    reason: str


class ActionResult(BaseModel):
    action: Action
    landed: bool
    resource_id: str | None = None
    detail: str | None = None


class ActOutcome(StrEnum):
    LANDED_ALL = "landed_all"
    LANDED_PARTIAL = "landed_partial"
    VETOED_EMPTY = "vetoed_empty"
    PLANNER_EMPTY = "planner_empty"
    BACKEND_UNAVAILABLE = "backend_unavailable"
    OFFLINE = "offline"


class RhythmPolicy(StrEnum):
    FREE = "free"
    NO_POST = "no_post"
    MUST_POST = "must_post"


class RhythmDecision(BaseModel):
    policy: RhythmPolicy
    prefer_non_post: str
    guidance: str
    post_ceiling: int | None = None
    post_probability: int | None = None
    roll: int | None = None


class Persona(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    username: str
    display_name: str | None = None
    headline: str | None = None
    bio: str | None = None
    follow_topics: list[str] = []
    backend: str = "claude"
    model: str | None = None
    board: str | None = None
    read: str | None = None
    rhythm_text: str = ""
    raw: str = ""
    directory: Path


class AspectSims(BaseModel):
    values: float
    style: float
    topic: float


class DreamVerdict(BaseModel):
    accepted: bool
    reason: str
    breached: list[str] = []
    sims: AspectSims | None = None
    attempt: int = 1
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/unit/test_models.py -v && uv run mypy
```

Expected: 6 passed, mypy clean.

- [ ] **Step 5: Stage and prepare the commit**

```bash
git add agent/swil_agent/models.py agent/tests/unit/test_models.py
# Prepared: feat(agent): shared data models for plan, persona, and dream verdict
```

---

## Task 4: Persona loader (`persona/loader.py`)

**Files:**
- Create: `agent/swil_agent/persona/__init__.py`
- Create: `agent/swil_agent/persona/loader.py`
- Create: `agent/tests/golden/__init__.py`
- Create: `agent/tests/golden/test_persona_loader.py`

**Interfaces:**
- Consumes: `swil_agent.models.Persona`.
- Produces:
  - `def get_field(text: str, field: str) -> str | None` — reads a `- **Field:** value` bullet, case-insensitive, first match wins.
  - `def get_section(text: str, heading: str) -> str` — returns the body of a `## heading` section, empty string if absent.
  - `def load_persona(directory: Path) -> Persona` — reads `directory/personality.md`.
  - `def resolve_agent_dir(agent_root: Path, name: str) -> Path` — checks `agents/<name>` then `humans/<name>`; raises `FileNotFoundError` if neither has a `personality.md`.

**Reference behavior (`agent/scripts/swil.sh:54`):** `_get_field` greps
`^\- \*\*<Field>:\*\*` case-insensitively, strips everything through `** `, and
takes the first line.

**Known roster facts this must reproduce (verified 2026-08-16):**

| Account | `AI Backend` bullet | Expected `Persona.backend` |
|---|---|---|
| `hodlge`, `lvchuang`, `zaofan` | absent | `"claude"` (the default) |
| `mangniu` | `- **AI Backend:** haiku` with `- **Model:** haiku` | `backend="haiku"`, `model="haiku"` |
| all other 19 | `claude` / `codex` / `deepseek` | as written |

- [ ] **Step 1: Write the failing test**

Create `agent/tests/golden/test_persona_loader.py`:

```python
"""Golden tests: the loader must agree with the live Bash runtime on all 23
real accounts, including the four with a missing or malformed backend bullet."""

from pathlib import Path

import pytest

from swil_agent.persona.loader import get_field, get_section, load_persona, resolve_agent_dir

AGENT_ROOT = Path(__file__).resolve().parents[2]

ALL_ACCOUNTS = [
    "chawendao", "darkpool", "fenziys", "liushang", "moguan", "qianxian",
    "qiusai", "quant", "shengyin", "shunteng", "sketch", "vex", "xianying",
    "zenith", "zhuiyi",
    "chongkai", "hodlge", "lvchuang", "mangniu", "maobian", "tulingshe",
    "yingying", "zaofan",
]

# Verified against `grep -m1 -i 'AI Backend' <dir>/personality.md` on 2026-08-16.
EXPECTED_BACKEND = {
    "quant": "codex", "sketch": "codex", "vex": "codex", "zhuiyi": "codex",
    "shunteng": "deepseek",
    "mangniu": "haiku",          # malformed on purpose — do NOT normalise
    "hodlge": "claude",          # bullet absent -> default
    "lvchuang": "claude",        # bullet absent -> default
    "zaofan": "claude",          # bullet absent -> default
}


def test_all_23_accounts_resolve() -> None:
    for name in ALL_ACCOUNTS:
        assert resolve_agent_dir(AGENT_ROOT, name).is_dir()


def test_resolve_prefers_agents_over_humans() -> None:
    """_find_dir checks agents/ first. A stray agents/<name> shadows a humans/
    account — see the 2026-08 incident. Encode the precedence explicitly."""
    d = resolve_agent_dir(AGENT_ROOT, "chongkai")
    assert d.parent.name == "humans"


def test_resolve_raises_for_unknown_account() -> None:
    with pytest.raises(FileNotFoundError):
        resolve_agent_dir(AGENT_ROOT, "no_such_account")


@pytest.mark.parametrize("name", ALL_ACCOUNTS)
def test_every_account_loads_with_a_username(name: str) -> None:
    p = load_persona(resolve_agent_dir(AGENT_ROOT, name))
    assert p.username, f"{name} has no Username bullet"
    assert p.raw, f"{name} loaded empty"


@pytest.mark.parametrize(("name", "backend"), sorted(EXPECTED_BACKEND.items()))
def test_backend_bullet_parsing_including_malformed(name: str, backend: str) -> None:
    p = load_persona(resolve_agent_dir(AGENT_ROOT, name))
    assert p.backend == backend


def test_mangniu_model_is_also_haiku() -> None:
    """The malformed pair resolves to backend=haiku, model=haiku — the source of
    the `haiku:haiku` agentBackend record. Preserved, not fixed."""
    p = load_persona(resolve_agent_dir(AGENT_ROOT, "mangniu"))
    assert (p.backend, p.model) == ("haiku", "haiku")


@pytest.mark.parametrize("name", ALL_ACCOUNTS)
def test_every_account_has_at_least_two_follow_topics(name: str) -> None:
    p = load_persona(resolve_agent_dir(AGENT_ROOT, name))
    assert len(p.follow_topics) >= 2


@pytest.mark.parametrize("name", ALL_ACCOUNTS)
def test_every_account_has_a_rhythm_section(name: str) -> None:
    p = load_persona(resolve_agent_dir(AGENT_ROOT, name))
    assert p.rhythm_text.strip(), f"{name} has an empty 发帖节律 section"


def test_get_field_is_case_insensitive_and_first_match_wins() -> None:
    text = "- **username:** first\n- **Username:** second\n"
    assert get_field(text, "Username") == "first"


def test_get_field_returns_none_when_absent() -> None:
    assert get_field("- **Other:** x\n", "Username") is None


def test_get_section_stops_at_the_next_heading() -> None:
    text = "## A\nline1\nline2\n## B\nline3\n"
    assert get_section(text, "A") == "line1\nline2"
    assert get_section(text, "B") == "line3"
    assert get_section(text, "Missing") == ""
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/golden/test_persona_loader.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.persona'`.

- [ ] **Step 3: Implement `loader.py`**

Create `agent/swil_agent/persona/__init__.py` (empty), then `loader.py`:

```python
"""Parse `personality.md` into a typed Persona.

Mirrors `agent/scripts/swil.sh:_get_field` exactly: a field is a line matching
`- **<Field>:** <value>`, matched case-insensitively, first occurrence wins.
Malformed bullets are preserved verbatim — `mangniu` records
`AI Backend: haiku`, and normalising it here would silently change an
experiment control value.
"""

from __future__ import annotations

import re
from pathlib import Path

from swil_agent.models import Persona

_DEFAULT_BACKEND = "claude"


def get_field(text: str, field: str) -> str | None:
    pattern = re.compile(
        r"^-\s+\*\*" + re.escape(field) + r":\*\*\s*(.*)$",
        re.IGNORECASE | re.MULTILINE,
    )
    m = pattern.search(text)
    if m is None:
        return None
    value = m.group(1).strip()
    return value or None


def get_section(text: str, heading: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    inside = False
    for line in lines:
        if line.startswith("## "):
            if inside:
                break
            inside = line[3:].strip() == heading.strip()
            continue
        if inside:
            out.append(line)
    return "\n".join(out).strip()


def _split_topics(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [t.strip() for t in raw.split(",") if t.strip()]


def resolve_agent_dir(agent_root: Path, name: str) -> Path:
    # agents/ is checked first, matching dream.sh::_find_dir. A stray
    # agents/<name> therefore shadows a humans/<name> account.
    for cohort in ("agents", "humans"):
        candidate = agent_root / cohort / name
        if (candidate / "personality.md").is_file():
            return candidate
    raise FileNotFoundError(f"no personality.md for account {name!r} under {agent_root}")


def load_persona(directory: Path) -> Persona:
    raw = (directory / "personality.md").read_text(encoding="utf-8")
    username = get_field(raw, "Username")
    if username is None:
        raise ValueError(f"{directory}/personality.md has no Username bullet")
    return Persona(
        username=username,
        display_name=get_field(raw, "Display Name"),
        headline=get_field(raw, "Headline"),
        bio=get_field(raw, "Bio"),
        follow_topics=_split_topics(get_field(raw, "Follow Topics")),
        backend=get_field(raw, "AI Backend") or _DEFAULT_BACKEND,
        model=get_field(raw, "Model"),
        board=get_field(raw, "Board"),
        read=get_field(raw, "Read"),
        rhythm_text=get_section(raw, "发帖节律"),
        raw=raw,
        directory=directory,
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/golden/test_persona_loader.py -v && uv run mypy
```

Expected: all parametrized cases pass (23 accounts × 3 parametrized tests + the
unit cases), mypy clean. If `test_every_account_has_a_rhythm_section` fails for
any account, the `get_section` heading match is wrong — the real headings are
exactly `## 发帖节律` with no trailing text.

- [ ] **Step 5: Cross-check against Bash for one account**

```bash
cd /Users/supwils/supwilsoft/live/swil-social
grep -m1 -i '^\- \*\*Board:\*\*' agent/agents/liushang/personality.md
cd agent && uv run python -c "
from pathlib import Path
from swil_agent.persona.loader import load_persona, resolve_agent_dir
p = load_persona(resolve_agent_dir(Path('.').resolve(), 'liushang'))
print(p.username, p.backend, p.model, p.board, len(p.follow_topics))
"
```

Expected: `liushang claude haiku perception 10`, and the Board bullet matches.

- [ ] **Step 6: Stage and prepare the commit**

```bash
git add agent/swil_agent/persona agent/tests/golden
# Prepared: feat(agent): persona loader with golden coverage of all 23 accounts
```

---

## Task 5: Rhythm parser (`persona/rhythm.py`)

**Files:**
- Create: `agent/swil_agent/persona/rhythm.py`
- Create: `agent/tests/golden/rhythm_ground_truth.tsv`
- Create: `agent/tests/golden/capture_rhythm.sh`
- Create: `agent/tests/golden/test_rhythm.py`

**Interfaces:**
- Consumes: `swil_agent.models.RhythmDecision`, `RhythmPolicy`.
- Produces:
  - `def decide_rhythm(rhythm_text: str, posts_today: int, rng: random.Random) -> RhythmDecision`

**This is the most behavior-sensitive task in the plan.** The parser reads
natural-language Chinese prose that the dream step rewrites. Reproduce it
exactly, including outcomes that look wrong.

**Reference:** `agent/scripts/auto-run.sh:312-391` (`build_rhythm_guidance`).
Evaluation order:

1. `prefer_non_post` — first match wins, over the whole section joined by spaces:
   - `动作优先级：.*comment > like` → `"comment"`
   - `动作优先级：.*like > nothing` → `"like"`
   - `动作优先级：.*nothing` → `"nothing"`
   - default → `"like"`
2. `post_ceiling` — first match wins, over the raw section:
   - `已有\s*3\s*条以上发帖记录` or `已有\s*3\s*条以上` → 3
   - `已有\s*2\s*条以上发帖记录` or `已有\s*2\s*条发帖记录` or `已有\s*2\s*条以上` → 2
   - `已有一条发帖记录` or `已有\s*1\s*条发帖记录` or `已有发帖记录` → 1
   - else → `None`
3. If ceiling is set and `posts_today >= ceiling` → `NO_POST`, return.
4. Else if `(\d+)% 概率选择 post` matches → roll `rng.randint(1, 100)`;
   `roll <= prob` → `MUST_POST`, else `NO_POST`. Return.
5. Else if `必须发帖` or `首选 post` → `MUST_POST`. Return.
6. Else → `FREE`.

**Bug to preserve (verified 2026-08-16):** `liushang` and `yingying` declare
`动作优先级：post > like > comment > follow > nothing`. Neither the literal
substring `comment > like` nor `like > nothing` occurs in that string, so rule 1
falls through to `动作优先级：.*nothing` and yields `prefer_non_post="nothing"` —
even though their stated priority puts `like` above `nothing`. **This is current
behavior and the golden fixture pins it.** Do not "fix" it here; see spec §12.1.

- [ ] **Step 1: Capture ground truth from the live Bash parser**

Create `agent/tests/golden/capture_rhythm.sh`:

```bash
#!/usr/bin/env bash
# Regenerate rhythm_ground_truth.tsv from the live Bash parser.
# Read-only: sources auto-run.sh helpers with SOURCE_ONLY=1.
#
# Run from the repo root:
#   bash agent/tests/golden/capture_rhythm.sh > agent/tests/golden/rhythm_ground_truth.tsv
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
SOURCE_ONLY=1 . agent/scripts/auto-run.sh

printf 'account\tposts_today\tpolicy\tprefer_non_post\n'
for d in agent/agents/*/ agent/humans/*/; do
  name="$(basename "$d")"
  pfile="$d/personality.md"
  [[ -f "$pfile" ]] || continue
  for posts in 0 1 2 3; do
    RANDOM=42
    build_rhythm_guidance "$pfile" "$posts"
    printf '%s\t%s\t%s\t%s\n' "$name" "$posts" "$RHYTHM_POLICY" "$RHYTHM_PREFER_NON_POST"
  done
done
```

Then run it:

```bash
cd /Users/supwils/supwilsoft/live/swil-social
bash agent/tests/golden/capture_rhythm.sh > agent/tests/golden/rhythm_ground_truth.tsv
wc -l agent/tests/golden/rhythm_ground_truth.tsv   # expect 93 = 1 header + 23*4
```

`RANDOM=42` in Bash yields a first draw of **82** for every account, so with the
seed fixed, any account whose declared probability is below 82 lands on `NO_POST`.
The Python test seeds its own RNG to return 82 for the first draw rather than
imitating Bash's generator — see Step 3.

Spot-check the captured file against these verified rows:

| account | posts_today | policy | prefer_non_post |
|---|---|---|---|
| `liushang` | 0 | `no_post` | `nothing` |
| `yingying` | 0 | `no_post` | `nothing` |
| `quant` | 0 | `must_post` | `comment` |
| `sketch` | 1 | `must_post` | `comment` |
| `qiusai` | 3 | `no_post` | `comment` |
| `darkpool` | 1 | `no_post` | `like` |

`qiusai` at `posts_today=3` staying on the probability branch proves it has **no
parsed ceiling** — an edge case the parser must not invent a default for.

- [ ] **Step 2: Write the failing test**

Create `agent/tests/golden/test_rhythm.py`:

```python
"""Golden test: the Python rhythm parser must agree with the live Bash parser on
every real account, at four post counts. Ground truth is captured by
`capture_rhythm.sh` — regenerate it if any personality.md rhythm section changes.
"""

import csv
import random
from pathlib import Path

import pytest

from swil_agent.models import RhythmPolicy
from swil_agent.persona.loader import load_persona, resolve_agent_dir
from swil_agent.persona.rhythm import decide_rhythm

AGENT_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH = Path(__file__).parent / "rhythm_ground_truth.tsv"


class FixedRoll(random.Random):
    """Bash `RANDOM=42` produces a first draw of 82. Reproduce that draw only."""

    def randint(self, a: int, b: int) -> int:
        return 82


def _rows() -> list[dict[str, str]]:
    with GROUND_TRUTH.open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh, delimiter="\t"))


def test_ground_truth_covers_every_account_at_four_post_counts() -> None:
    rows = _rows()
    assert len(rows) == 92, f"expected 23 accounts x 4 post counts, got {len(rows)}"
    assert len({r["account"] for r in rows}) == 23


@pytest.mark.parametrize("row", _rows(), ids=lambda r: f"{r['account']}-{r['posts_today']}")
def test_matches_bash_parser(row: dict[str, str]) -> None:
    persona = load_persona(resolve_agent_dir(AGENT_ROOT, row["account"]))
    got = decide_rhythm(persona.rhythm_text, int(row["posts_today"]), FixedRoll())
    assert got.policy.value == row["policy"]
    assert got.prefer_non_post == row["prefer_non_post"]


def test_priority_list_without_literal_pairs_falls_through_to_nothing() -> None:
    """Pins the liushang/yingying behavior: `post > like > comment > follow >
    nothing` contains neither `comment > like` nor `like > nothing`, so rule 1
    reaches the bare `nothing` branch. Preserved deliberately (spec 12.1)."""
    text = "- 动作优先级：post > like > comment > follow > nothing\n"
    assert decide_rhythm(text, 0, FixedRoll()).prefer_non_post == "nothing"


def test_comment_before_like_yields_comment() -> None:
    text = "- 动作优先级：comment > like > nothing\n"
    assert decide_rhythm(text, 0, FixedRoll()).prefer_non_post == "comment"


def test_default_prefer_non_post_is_like_when_no_priority_line() -> None:
    assert decide_rhythm("- 无优先级说明\n", 0, FixedRoll()).prefer_non_post == "like"


def test_ceiling_takes_precedence_over_probability() -> None:
    text = "- 每次触发有 90% 概率选择 post\n- 若今天已有 1 条发帖记录，则倾向沉默\n"
    d = decide_rhythm(text, 1, FixedRoll())
    assert d.policy is RhythmPolicy.NO_POST
    assert d.post_ceiling == 1
    assert d.roll is None, "the ceiling branch returns before rolling"


def test_probability_hit_yields_must_post() -> None:
    text = "- 每次触发有 90% 概率选择 post\n"
    d = decide_rhythm(text, 0, FixedRoll())
    assert d.policy is RhythmPolicy.MUST_POST
    assert d.post_probability == 90
    assert d.roll == 82


def test_probability_miss_yields_no_post() -> None:
    text = "- 每次触发有 50% 概率选择 post\n"
    d = decide_rhythm(text, 0, FixedRoll())
    assert d.policy is RhythmPolicy.NO_POST
    assert d.roll == 82


def test_must_post_phrase_without_probability() -> None:
    for phrase in ("- 本账号必须发帖\n", "- 首选 post\n"):
        assert decide_rhythm(phrase, 0, FixedRoll()).policy is RhythmPolicy.MUST_POST


def test_unparseable_section_falls_back_to_free() -> None:
    """No real account currently reaches this branch, so it needs a synthetic
    fixture. Falling back to `free` is what CLAUDE.md warns about."""
    d = decide_rhythm("- 随心而行，没有明确规则\n", 0, FixedRoll())
    assert d.policy is RhythmPolicy.FREE
    assert "未解析到明确概率" in d.guidance


def test_ceiling_three_variants() -> None:
    assert decide_rhythm("已有 3 条以上发帖记录\n", 3, FixedRoll()).post_ceiling == 3
    assert decide_rhythm("已有 2 条发帖记录\n", 2, FixedRoll()).post_ceiling == 2
    assert decide_rhythm("已有一条发帖记录\n", 1, FixedRoll()).post_ceiling == 1
    assert decide_rhythm("已有发帖记录\n", 1, FixedRoll()).post_ceiling == 1
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/golden/test_rhythm.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.persona.rhythm'`.

- [ ] **Step 4: Implement `rhythm.py`**

```python
"""Parse the `## 发帖节律` prose section into a rhythm decision.

A faithful port of `agent/scripts/auto-run.sh::build_rhythm_guidance`. The
section is natural-language Chinese that the dream step rewrites, so the parser
is a set of ordered regexes over prose. Several outcomes look unintended (see
`prefer_non_post` below); they are current behavior and are pinned by
`tests/golden/rhythm_ground_truth.tsv`. Changing them is out of scope — the
whole file is embedded for drift measurement, so altering the format shifts
every account's drift score.
"""

from __future__ import annotations

import random
import re

from swil_agent.models import RhythmDecision, RhythmPolicy

# Ordered: first match wins. Note that a priority list like
# `post > like > comment > follow > nothing` matches NEITHER of the first two
# patterns (the literal pairs do not occur) and therefore falls through to the
# bare `nothing` branch. liushang and yingying land here.
_PREFER_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"动作优先级：.*comment > like", "comment"),
    (r"动作优先级：.*like > nothing", "like"),
    (r"动作优先级：.*nothing", "nothing"),
)
_PREFER_DEFAULT = "like"

_CEILING_PATTERNS: tuple[tuple[str, int], ...] = (
    (r"已有\s*3\s*条以上发帖记录|已有\s*3\s*条以上", 3),
    (r"已有\s*2\s*条以上发帖记录|已有\s*2\s*条发帖记录|已有\s*2\s*条以上", 2),
    (r"已有一条发帖记录|已有\s*1\s*条发帖记录|已有发帖记录", 1),
)

_PROBABILITY = re.compile(r"(\d+)% 概率选择 post")
_MUST_POST = re.compile(r"必须发帖|首选 post")


def _prefer_non_post(one_line: str) -> str:
    for pattern, value in _PREFER_PATTERNS:
        if re.search(pattern, one_line):
            return value
    return _PREFER_DEFAULT


def _post_ceiling(text: str) -> int | None:
    for pattern, value in _CEILING_PATTERNS:
        if re.search(pattern, text):
            return value
    return None


def decide_rhythm(rhythm_text: str, posts_today: int, rng: random.Random) -> RhythmDecision:
    one_line = rhythm_text.replace("\n", " ")
    prefer = _prefer_non_post(one_line)
    ceiling = _post_ceiling(rhythm_text)

    if ceiling is not None and posts_today >= ceiling:
        return RhythmDecision(
            policy=RhythmPolicy.NO_POST,
            prefer_non_post=prefer,
            post_ceiling=ceiling,
            guidance=(
                f"- 本轮动作约束：今天已发 {posts_today} 条，已达到该账号的发帖上限；"
                "本轮禁止选择 post。\n"
                f"- 本轮非发帖优先级：优先 {prefer}，其次再考虑其他非发帖动作。"
            ),
        )

    prob_match = _PROBABILITY.search(rhythm_text)
    if prob_match is not None:
        prob = int(prob_match.group(1))
        roll = rng.randint(1, 100)
        if roll <= prob:
            return RhythmDecision(
                policy=RhythmPolicy.MUST_POST,
                prefer_non_post=prefer,
                post_ceiling=ceiling,
                post_probability=prob,
                roll=roll,
                guidance=(
                    f"- 本轮随机抽样：{roll}/100，命中 {prob}% 的 post 概率；本轮必须选择 post。"
                ),
            )
        return RhythmDecision(
            policy=RhythmPolicy.NO_POST,
            prefer_non_post=prefer,
            post_ceiling=ceiling,
            post_probability=prob,
            roll=roll,
            guidance=(
                f"- 本轮随机抽样：{roll}/100，未命中 {prob}% 的 post 概率；本轮禁止选择 post。\n"
                f"- 本轮非发帖优先级：优先 {prefer}，其次再考虑其他非发帖动作。"
            ),
        )

    if _MUST_POST.search(rhythm_text):
        return RhythmDecision(
            policy=RhythmPolicy.MUST_POST,
            prefer_non_post=prefer,
            post_ceiling=ceiling,
            guidance="- 本轮动作约束：根据该账号的发帖节律，本轮必须优先选择 post。",
        )

    return RhythmDecision(
        policy=RhythmPolicy.FREE,
        prefer_non_post=prefer,
        post_ceiling=ceiling,
        guidance="- 本轮动作约束：未解析到明确概率；请严格按发帖节律与行为规则自行保守决策。",
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/golden/test_rhythm.py -v && uv run mypy
```

Expected: 92 golden cases + 10 unit cases pass, mypy clean.

If any golden row mismatches, **do not adjust the fixture to match Python.** The
fixture is ground truth from the live Bash parser. Fix the Python regex order or
pattern instead, then re-run.

- [ ] **Step 6: Stage and prepare the commit**

```bash
git add agent/swil_agent/persona/rhythm.py agent/tests/golden/test_rhythm.py \
        agent/tests/golden/rhythm_ground_truth.tsv agent/tests/golden/capture_rhythm.sh
# Prepared: feat(agent): port rhythm prose parser with 92-case golden fixture
#
# Reproduces build_rhythm_guidance byte-for-byte, including the
# prefer_non_post fall-through that liushang/yingying hit. Fixture captured
# from the live bash parser at RANDOM=42.
```

---

## Task 6: Dream structural validators (`persona/validators.py`)

**Files:**
- Create: `agent/swil_agent/persona/validators.py`
- Create: `agent/tests/unit/test_validators.py`

**Interfaces:**
- Consumes: `swil_agent.persona.loader.get_field`, `get_section`.
- Produces:
  - `class ValidationFailure(BaseModel)`: `check: str`, `detail: str`
  - `def validate_candidate(original: str, candidate: str) -> ValidationFailure | None` — returns the **first** failure, or `None` if the candidate is structurally acceptable.

**Reference:** `agent/scripts/dream.sh:670-730`. Six ordered checks:

| # | Fields | Rule |
|---|---|---|
| 1 | `Username` | round-trip identical |
| 2 | `AI Backend` | round-trip identical |
| 3 | `Model`, `Board`, `Read` | round-trip identical **if present in the original** |
| 4 | `Display Name`, `Headline`, `Bio`, `Follow Topics` | must **exist** in the candidate (not round-trip) |
| 5 | `## 发帖节律` | section must exist in the candidate |
| 6 | `Follow Topics` | ≥ 2 comma-separated entries |

Checks 1–3 compare with whitespace stripped (Bash uses `tr -d '[:space:]'`).
Check 3 skips a field absent from the original — a dream may not *add* a control
field, but the absence of one is not a failure.

- [ ] **Step 1: Write the failing test**

Create `agent/tests/unit/test_validators.py`:

```python
from swil_agent.persona.validators import validate_candidate

BASE = """# 测试

## 身份
- **Username:** tester
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** 一句话
- **Follow Topics:** alpha,beta,gamma

- **AI Backend:** claude
- **Model:** haiku
- **Board:** perception
- **Read:** wide

## 性格
一些文字

## 发帖节律
- 每次触发有 60% 概率选择 post
"""


def test_identical_candidate_passes() -> None:
    assert validate_candidate(BASE, BASE) is None


def test_bio_may_be_rewritten_freely() -> None:
    """Check 4 is existence-only. A dream MUST be allowed to rewrite Bio."""
    candidate = BASE.replace("- **Bio:** 一句话", "- **Bio:** 完全不同的一句话")
    assert validate_candidate(BASE, candidate) is None


def test_headline_and_display_name_may_be_rewritten() -> None:
    candidate = BASE.replace("- **Headline:** AI Agent", "- **Headline:** 新的头衔")
    candidate = candidate.replace("- **Display Name:** 测试", "- **Display Name:** 新名字")
    assert validate_candidate(BASE, candidate) is None


def test_username_drift_fails() -> None:
    candidate = BASE.replace("- **Username:** tester", "- **Username:** someone_else")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Username"


def test_backend_drift_fails() -> None:
    candidate = BASE.replace("- **AI Backend:** claude", "- **AI Backend:** codex")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "AI Backend"


def test_model_drift_fails() -> None:
    candidate = BASE.replace("- **Model:** haiku", "- **Model:** opus")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Model"


def test_board_drift_fails() -> None:
    candidate = BASE.replace("- **Board:** perception", "- **Board:** making")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Board"


def test_read_dropped_fails_the_quietest_control_field() -> None:
    """Losing `Read` turns the widest-input arm into an ordinary board reader
    with nothing in any log to say so. It must fail loudly."""
    candidate = BASE.replace("- **Read:** wide\n", "")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Read"


def test_control_field_absent_from_original_is_not_a_failure() -> None:
    original = BASE.replace("- **Read:** wide\n", "")
    candidate = original
    assert validate_candidate(original, candidate) is None


def test_missing_bio_fails_existence_check() -> None:
    candidate = BASE.replace("- **Bio:** 一句话\n", "")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Bio"


def test_missing_rhythm_section_fails() -> None:
    candidate = BASE.replace("## 发帖节律\n- 每次触发有 60% 概率选择 post\n", "")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "发帖节律"


def test_single_follow_topic_fails() -> None:
    candidate = BASE.replace("- **Follow Topics:** alpha,beta,gamma", "- **Follow Topics:** alpha")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Follow Topics"


def test_two_follow_topics_pass() -> None:
    candidate = BASE.replace("- **Follow Topics:** alpha,beta,gamma", "- **Follow Topics:** a,b")
    assert validate_candidate(BASE, candidate) is None


def test_whitespace_differences_do_not_count_as_drift() -> None:
    candidate = BASE.replace("- **Username:** tester", "- **Username:**  tester ")
    assert validate_candidate(BASE, candidate) is None


def test_checks_run_in_declared_order() -> None:
    """Username drift AND a missing Bio: Username must be reported."""
    candidate = BASE.replace("- **Username:** tester", "- **Username:** other")
    candidate = candidate.replace("- **Bio:** 一句话\n", "")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Username"
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/unit/test_validators.py -v
```

Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `validators.py`**

```python
"""The six structural validators a dream candidate must pass.

A faithful port of `agent/scripts/dream.sh:670-730`. Any failure means the
candidate is discarded and the original personality.md is kept.

The round-trip / existence split is load-bearing and easy to invert:
  * Username, AI Backend, Model, Board, Read  -> must be IDENTICAL
  * Display Name, Headline, Bio, Follow Topics -> must merely EXIST
Implementing the second group as round-trip would reject every dream that
rewrites a Bio, which is exactly what a dream is for.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

from swil_agent.persona.loader import get_field, get_section

_ROUND_TRIP_IDENTITY = ("Username", "AI Backend")
# Experiment control fields: dropping or rewriting one silently changes the
# account's model tier, feed scope, or read width, making its data points
# uninterpretable. `Read` fails the most quietly of the three.
_ROUND_TRIP_CONTROL = ("Model", "Board", "Read")
_MUST_EXIST = ("Display Name", "Headline", "Bio", "Follow Topics")
_RHYTHM_HEADING = "发帖节律"
_MIN_FOLLOW_TOPICS = 2


class ValidationFailure(BaseModel):
    check: str
    detail: str


def _normalised(text: str, field: str) -> str | None:
    value = get_field(text, field)
    if value is None:
        return None
    return re.sub(r"\s+", "", value)


def _check_round_trip(original: str, candidate: str, field: str) -> ValidationFailure | None:
    old = _normalised(original, field)
    if old is None:
        # Absent from the original is never a failure, matching Bash's
        # `[[ -n "$old_val" && "$new_val" != "$old_val" ]]` guard. A dream may
        # not ADD a control field, but it need not have one to begin with.
        return None
    new = _normalised(candidate, field)
    if new != old:
        return ValidationFailure(
            check=field,
            detail=f"{field} drift ({old!r} -> {new if new is not None else '<missing>'!r})",
        )
    return None


def validate_candidate(original: str, candidate: str) -> ValidationFailure | None:
    for field in (*_ROUND_TRIP_IDENTITY, *_ROUND_TRIP_CONTROL):
        failure = _check_round_trip(original, candidate, field)
        if failure is not None:
            return failure

    for field in _MUST_EXIST:
        if get_field(candidate, field) is None:
            return ValidationFailure(check=field, detail=f"missing required field {field!r}")

    if not get_section(candidate, _RHYTHM_HEADING):
        return ValidationFailure(
            check=_RHYTHM_HEADING, detail=f"missing '## {_RHYTHM_HEADING}' section"
        )

    topics_raw = get_field(candidate, "Follow Topics") or ""
    topics = [t for t in (part.strip() for part in topics_raw.split(",")) if t]
    if len(topics) < _MIN_FOLLOW_TOPICS:
        return ValidationFailure(
            check="Follow Topics",
            detail=f"Follow Topics has {len(topics)} entries, need >= {_MIN_FOLLOW_TOPICS}",
        )

    return None
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/unit/test_validators.py -v && uv run mypy
```

Expected: 15 passed, mypy clean.

If `test_control_field_absent_from_original_is_not_a_failure` fails, the
`old is None` early return was dropped — an absent control field in the
*original* must not be treated as drift, matching Bash's
`[[ -n "$old_val" && "$new_val" != "$old_val" ]]` guard.

- [ ] **Step 5: Verify against real archived candidates**

Pick one account whose most recent dream was **accepted** and one **rejected**,
then confirm the validators agree (an accepted candidate must pass all six; a
drift-rejected one also passes all six, because it failed the *drift* gate, not
a structural check — the drift gate is Plan 2).

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent
uv run python -c "
from pathlib import Path
from swil_agent.persona.validators import validate_candidate
d = Path('agents/liushang')
current = (d / 'personality.md').read_text(encoding='utf-8')
print('self-check:', validate_candidate(current, current))
"
```

Expected: `self-check: None`.

- [ ] **Step 6: Stage and prepare the commit**

```bash
git add agent/swil_agent/persona/validators.py agent/tests/unit/test_validators.py
# Prepared: feat(agent): port the six dream structural validators
#
# Keeps the round-trip/existence split exact: Username, AI Backend, Model,
# Board and Read must round-trip; Display Name, Headline, Bio and Follow
# Topics need only exist.
```

---

## Task 7: LLM output extraction (`llm/extract.py`)

**Files:**
- Create: `agent/swil_agent/llm/__init__.py`
- Create: `agent/swil_agent/llm/extract.py`
- Create: `agent/tests/unit/test_extract.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `def collapse_doubled_text(text: str) -> str`
  - `def extract_json_object(text: str) -> str | None`
  - `def normalize_plan(raw: str) -> Plan`

**Reference:** `agent/scripts/llm.sh:23-71` (both routines are already Python,
embedded as heredocs) and `auto-run.sh:82-92` (`normalize_plan`, a `jq` program).

`normalize_plan` accepts three shapes and flattens them:
1. a bare JSON array of action objects
2. an object with a `plan` array
3. a single action object

then keeps only objects with a string `action` field. Input is truncated to
16384 bytes first, matching `head -c 16384`.

- [ ] **Step 1: Write the failing test**

Create `agent/tests/unit/test_extract.py`:

```python
from swil_agent.llm.extract import collapse_doubled_text, extract_json_object, normalize_plan


def test_collapse_exact_even_length_duplication() -> None:
    half = "这是一段足够长的中文文本用来触发折叠逻辑判断" * 2
    assert collapse_doubled_text(half + half) == half


def test_collapse_odd_length_with_single_joining_char() -> None:
    half = "abcdefghijklmnopqrstuvwxyz0123456789ABCD"
    assert collapse_doubled_text(half + "\n" + half) == half


def test_short_text_is_never_collapsed() -> None:
    """The guard is n >= 40, so genuine short repeats survive."""
    assert collapse_doubled_text("abab") == "abab"


def test_non_duplicated_prose_is_untouched() -> None:
    text = "A" * 30 + "B" * 30
    assert collapse_doubled_text(text) == text


def test_extract_handles_nested_braces() -> None:
    raw = 'noise {"a": {"b": 1}, "c": "}"} trailing'
    assert extract_json_object(raw) == '{"a": {"b": 1}, "c": "}"}'


def test_extract_strips_code_fences() -> None:
    raw = '```json\n{"action": "post"}\n```'
    assert extract_json_object(raw) == '{"action": "post"}'


def test_extract_ignores_braces_inside_strings() -> None:
    raw = '{"text": "a { not an object"}'
    assert extract_json_object(raw) == raw


def test_extract_honours_escaped_quotes() -> None:
    raw = '{"text": "say \\"hi\\" now"}'
    assert extract_json_object(raw) == raw


def test_extract_returns_none_when_no_object() -> None:
    assert extract_json_object("no json here") is None


def test_normalize_bare_array() -> None:
    plan = normalize_plan('[{"action":"like","postId":"p1"}]')
    assert [a.kind for a in plan.actions] == ["like"]
    assert plan.actions[0].post_id == "p1"


def test_normalize_object_with_plan_key() -> None:
    plan = normalize_plan('{"plan":[{"action":"post","text":"hi"},{"action":"like","postId":"p"}]}')
    assert [a.kind for a in plan.actions] == ["post", "like"]


def test_normalize_single_object() -> None:
    plan = normalize_plan('{"action":"nothing"}')
    assert [a.kind for a in plan.actions] == ["nothing"]


def test_normalize_drops_entries_without_a_string_action() -> None:
    plan = normalize_plan('[{"action":"like","postId":"p"},{"nope":1},{"action":5}]')
    assert [a.kind for a in plan.actions] == ["like"]


def test_normalize_drops_unknown_action_kinds() -> None:
    plan = normalize_plan('[{"action":"teleport"},{"action":"like","postId":"p"}]')
    assert [a.kind for a in plan.actions] == ["like"]


def test_normalize_returns_empty_plan_on_garbage() -> None:
    assert normalize_plan("not json at all").actions == []


def test_normalize_maps_camelcase_wire_fields() -> None:
    plan = normalize_plan('[{"action":"comment","postId":"p","parentId":"c","text":"x"}]')
    a = plan.actions[0]
    assert (a.post_id, a.parent_id, a.text) == ("p", "c", "x")


def test_normalize_maps_image_topic() -> None:
    plan = normalize_plan('[{"action":"post","text":"x","imageTopic":"old mailboxes"}]')
    assert plan.actions[0].image_topic == "old mailboxes"
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/unit/test_extract.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.llm'`.

- [ ] **Step 3: Implement `extract.py`**

Create `agent/swil_agent/llm/__init__.py` (empty), then `extract.py`:

```python
"""Post-processing for raw LLM output.

Ports three routines that were embedded Python or jq inside Bash:
  * collapse_doubled_text  (llm.sh:23)  — codex sometimes emits the body twice
  * extract_json_object    (llm.sh:41)  — brace-balanced, string-aware
  * normalize_plan         (auto-run.sh:82) — flatten three accepted shapes

These lived in heredocs and could not be unit-tested; the echo-variance defect
survived for months for exactly that reason.
"""

from __future__ import annotations

import json
from typing import Any, get_args

from swil_agent.models import Action, ActionKind, Plan

_MIN_COLLAPSE_LENGTH = 40
_MAX_PLAN_BYTES = 16384
_VALID_KINDS = frozenset(get_args(ActionKind))

_WIRE_TO_FIELD = {
    "action": "kind",
    "postId": "post_id",
    "parentId": "parent_id",
    "imageTopic": "image_topic",
    "text": "text",
    "username": "username",
}


def collapse_doubled_text(text: str) -> str:
    """Collapse an exact full-length duplication (X+X, or X<sep>X) to one copy.

    Self-gating: it only fires when the two halves are byte-identical, which
    effectively never happens in genuine prose.
    """
    n = len(text)
    if n < _MIN_COLLAPSE_LENGTH:
        return text
    half = n // 2
    if n % 2 == 0 and text[:half] == text[half:]:
        return text[:half]
    if n % 2 == 1 and text[:half] == text[half + 1 :]:
        return text[:half]
    return text


def extract_json_object(text: str) -> str | None:
    """Return the first complete top-level JSON object, or None.

    Walks the string tracking brace depth, honouring quoted strings and
    backslash escapes. A greedy regex breaks on nested objects and on a `{`
    inside a string, which is why this is hand-rolled.
    """
    cleaned = text.replace("```json", "").replace("```", "")
    start = -1
    depth = 0
    in_string = False
    escaped = False
    for i, ch in enumerate(cleaned):
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_string:
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                return cleaned[start : i + 1]
    return None


def _to_action(entry: dict[str, Any]) -> Action | None:
    kind = entry.get("action")
    if not isinstance(kind, str) or kind not in _VALID_KINDS:
        return None
    fields: dict[str, Any] = {}
    for wire, field in _WIRE_TO_FIELD.items():
        value = entry.get(wire)
        if isinstance(value, str) and value:
            fields[field] = value
    fields["kind"] = kind
    return Action(**fields)


def normalize_plan(raw: str) -> Plan:
    """Flatten the three shapes the planner may emit into a Plan."""
    truncated = raw.encode("utf-8")[:_MAX_PLAN_BYTES].decode("utf-8", errors="ignore")
    try:
        parsed: Any = json.loads(truncated)
    except json.JSONDecodeError:
        extracted = extract_json_object(truncated)
        if extracted is None:
            return Plan(actions=[])
        try:
            parsed = json.loads(extracted)
        except json.JSONDecodeError:
            return Plan(actions=[])

    entries: list[Any]
    if isinstance(parsed, list):
        entries = parsed
    elif isinstance(parsed, dict) and isinstance(parsed.get("plan"), list):
        entries = parsed["plan"]
    elif isinstance(parsed, dict):
        entries = [parsed]
    else:
        return Plan(actions=[])

    actions = [
        action
        for entry in entries
        if isinstance(entry, dict)
        for action in (_to_action(entry),)
        if action is not None
    ]
    return Plan(actions=actions)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/unit/test_extract.py -v && uv run mypy
```

Expected: 17 passed, mypy clean.

- [ ] **Step 5: Cross-check `collapse_doubled_text` against Bash**

```bash
cd /Users/supwils/supwilsoft/live/swil-social
SAMPLE="这是一段足够长的中文文本用来触发折叠逻辑判断这是一段足够长的中文文本用来触发折叠逻辑判断"
BASH_OUT=$(SOURCE_ONLY=1 bash -c '. agent/scripts/llm.sh; collapse_doubled_text "'"$SAMPLE$SAMPLE"'"')
PY_OUT=$(cd agent && uv run python -c "
import sys
from swil_agent.llm.extract import collapse_doubled_text
print(collapse_doubled_text(sys.argv[1]), end='')
" "$SAMPLE$SAMPLE")
[[ "$BASH_OUT" == "$PY_OUT" ]] && echo "MATCH" || { echo "MISMATCH"; echo "bash: $BASH_OUT"; echo "py:   $PY_OUT"; }
```

Expected: `MATCH`.

- [ ] **Step 6: Stage and prepare the commit**

```bash
git add agent/swil_agent/llm agent/tests/unit/test_extract.py
# Prepared: feat(agent): port json extraction, doubled-text collapse, plan normalisation
#
# All three lived as heredocs or jq inside bash and were untestable. Adds 17
# unit tests including codex double-emit and nested-brace cases.
```

---

## Task 8: LLM backends and the neutral ruler

**Files:**
- Create: `agent/swil_agent/llm/base.py`
- Create: `agent/swil_agent/llm/claude_cli.py`
- Create: `agent/swil_agent/llm/codex_cli.py`
- Create: `agent/swil_agent/llm/deepseek_cli.py`
- Create: `agent/swil_agent/llm/neutral.py`
- Create: `agent/tests/unit/test_backends.py`
- Create: `agent/tests/unit/test_architecture.py`

**Interfaces:**
- Consumes: `swil_agent.llm.extract.collapse_doubled_text`, `extract_json_object`; `swil_agent.config.Settings`.
- Produces:
  - `class CompletionRequest(BaseModel)`: `system: str`, `user: str`, `model: str | None`
  - `class Runner(Protocol)`: `def run(self, argv: list[str], stdin: str | None, env: dict[str, str] | None, timeout: float) -> str`
  - `class SubprocessRunner` — the real `Runner`
  - `class Backend(Protocol)`: `name: str`; `def complete(self, req: CompletionRequest) -> str`
  - `class ClaudeCLIBackend`, `class CodexCLIBackend`, `class DeepSeekCLIBackend`
  - `def build_backend(name: str, runner: Runner, settings: Settings) -> Backend`
  - `def distill_neutral(req: CompletionRequest, runner: Runner, model: str) -> str` (in `neutral.py`)
  - `class BackendUnavailableError(RuntimeError)`

**Reference:** `agent/scripts/llm.sh:80-124`. Exact argv per backend:

| Backend | argv |
|---|---|
| `claude` | `claude -p [--model M] --system-prompt SYS --output-format text`, user prompt on **stdin** |
| `codex` | `codex exec --ephemeral --skip-git-repo-check --full-auto --color never -o TMPFILE "System:\n{sys}\n\n---\n\n{usr}"`, output read from `TMPFILE` |
| `deepseek` | same as `claude` but `--model` defaults to `deepseek-v4-flash` and the DeepSeek env is applied to that process only |

Empty output means the backend is unavailable → raise `BackendUnavailableError`.
`llm_text` collapses doubled output; `llm_json` does **not** collapse — it
extracts JSON from the raw body. Preserve that asymmetry.

- [ ] **Step 1: Write the failing test**

Create `agent/tests/unit/test_backends.py`:

```python
from pathlib import Path

import pytest

from swil_agent.config import Settings
from swil_agent.llm.base import (
    BackendUnavailableError,
    CompletionRequest,
    build_backend,
)


class FakeRunner:
    """Records argv/stdin/env and returns a scripted stdout."""

    def __init__(self, output: str = "ok") -> None:
        self.output = output
        self.calls: list[dict[str, object]] = []

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self.calls.append({"argv": argv, "stdin": stdin, "env": env, "timeout": timeout})
        return self.output


def _settings() -> Settings:
    return Settings(swil_url="https://example.test")


def test_claude_puts_user_prompt_on_stdin() -> None:
    runner = FakeRunner("hello")
    backend = build_backend("claude", runner, _settings())
    out = backend.complete(CompletionRequest(system="SYS", user="USR", model="haiku"))
    assert out == "hello"
    call = runner.calls[0]
    assert call["stdin"] == "USR"
    argv = call["argv"]
    assert isinstance(argv, list)
    assert argv[:2] == ["claude", "-p"]
    assert "--model" in argv and "haiku" in argv
    assert "--system-prompt" in argv and "SYS" in argv


def test_claude_omits_model_flag_when_model_is_none() -> None:
    runner = FakeRunner("hello")
    build_backend("claude", runner, _settings()).complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    argv = runner.calls[0]["argv"]
    assert isinstance(argv, list)
    assert "--model" not in argv


def test_codex_uses_exec_and_reads_an_output_file(tmp_path: Path) -> None:
    runner = FakeRunner("")

    class CodexRunner(FakeRunner):
        def run(
            self,
            argv: list[str],
            stdin: str | None = None,
            env: dict[str, str] | None = None,
            timeout: float = 300.0,
        ) -> str:
            self.calls.append({"argv": argv, "stdin": stdin, "env": env, "timeout": timeout})
            out_index = argv.index("-o") + 1
            Path(argv[out_index]).write_text("codex said this", encoding="utf-8")
            return ""

    runner = CodexRunner()
    out = build_backend("codex", runner, _settings()).complete(
        CompletionRequest(system="SYS", user="USR", model=None)
    )
    assert out == "codex said this"
    argv = runner.calls[0]["argv"]
    assert isinstance(argv, list)
    assert argv[:2] == ["codex", "exec"]
    for flag in ("--ephemeral", "--skip-git-repo-check", "--full-auto", "--color", "-o"):
        assert flag in argv
    prompt = argv[-1]
    assert prompt.startswith("System:\nSYS")
    assert prompt.endswith("USR")


def test_deepseek_defaults_the_model_and_sets_env() -> None:
    runner = FakeRunner("ds")
    build_backend("deepseek", runner, _settings()).complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    call = runner.calls[0]
    argv = call["argv"]
    env = call["env"]
    assert isinstance(argv, list)
    assert isinstance(env, dict)
    assert "deepseek-v4-flash" in argv
    assert env.get("ANTHROPIC_BASE_URL") == "https://api.deepseek.com/anthropic"


def test_empty_output_raises_backend_unavailable() -> None:
    backend = build_backend("claude", FakeRunner(""), _settings())
    with pytest.raises(BackendUnavailableError):
        backend.complete(CompletionRequest(system="S", user="U", model=None))


def test_unknown_backend_name_falls_back_to_claude() -> None:
    """mangniu records `AI Backend: haiku`. Bash's `case` default branch runs the
    claude path, so an unknown name must NOT raise."""
    runner = FakeRunner("ok")
    backend = build_backend("haiku", runner, _settings())
    backend.complete(CompletionRequest(system="S", user="U", model="haiku"))
    argv = runner.calls[0]["argv"]
    assert isinstance(argv, list)
    assert argv[0] == "claude"
```

Create `agent/tests/unit/test_architecture.py`:

```python
"""Architecture invariants enforced as tests, not conventions."""

import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2] / "swil_agent"


def _imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


def test_no_module_outside_graph_imports_langgraph() -> None:
    offenders: list[str] = []
    for path in PACKAGE.rglob("*.py"):
        if "graph" in path.relative_to(PACKAGE).parts:
            continue
        if any(m.split(".")[0] == "langgraph" for m in _imported_modules(path)):
            offenders.append(str(path.relative_to(PACKAGE)))
    assert offenders == [], f"langgraph imported outside graph/: {offenders}"


def test_neutral_ruler_does_not_import_the_backend_registry() -> None:
    """The aspect distiller is the ruler that measures drift. If it could route
    through backend selection, a DeepSeek account would be measured by DeepSeek,
    destroying cross-roster comparability. Bash enforced this with a subshell
    trick; here it is a dependency rule."""
    imported = _imported_modules(PACKAGE / "llm" / "neutral.py")
    assert "swil_agent.llm.claude_cli" not in imported
    assert "swil_agent.llm.codex_cli" not in imported
    assert "swil_agent.llm.deepseek_cli" not in imported
    for module in imported:
        assert "build_backend" not in module


def test_neutral_module_does_not_reference_build_backend() -> None:
    source = (PACKAGE / "llm" / "neutral.py").read_text(encoding="utf-8")
    assert "build_backend" not in source


def test_persona_and_llm_do_not_import_api() -> None:
    """Dependency direction: api/ may not be pulled in by the parsing layers."""
    for subpackage in ("persona", "llm"):
        for path in (PACKAGE / subpackage).rglob("*.py"):
            for module in _imported_modules(path):
                assert not module.startswith("swil_agent.api"), f"{path} imports {module}"
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
cd agent && uv run pytest tests/unit/test_backends.py tests/unit/test_architecture.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.llm.base'`.

- [ ] **Step 3: Implement `base.py`**

```python
"""Backend dispatch for LLM calls.

All three current backends are CLI subprocesses, not HTTP APIs — `codex` has no
API at all. `Runner` is the seam that makes them testable: production uses
`SubprocessRunner`, tests inject a fake.

An `ApiBackend` for BYOK (owner-supplied keys against real HTTP APIs) will sit
beside these implementations; it is Plan 2+ and deliberately absent here.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel

from swil_agent.config import Settings
from swil_agent.llm.extract import collapse_doubled_text, extract_json_object

DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_TIMEOUT = 300.0


class BackendUnavailableError(RuntimeError):
    """The backend produced no output. Distinct from a bad response."""


class CompletionRequest(BaseModel):
    system: str
    user: str
    model: str | None = None


class Runner(Protocol):
    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> str: ...


class SubprocessRunner:
    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> str:
        merged = {**os.environ, **(env or {})}
        try:
            completed = subprocess.run(
                argv,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=merged,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return ""
        return completed.stdout


class Backend(Protocol):
    name: str

    def complete(self, req: CompletionRequest) -> str: ...


class _ClaudeStyleBackend:
    """`claude -p` with the user prompt on stdin."""

    name = "claude"

    def __init__(self, runner: Runner, *, default_model: str | None = None) -> None:
        self._runner = runner
        self._default_model = default_model

    def _env(self) -> dict[str, str] | None:
        return None

    def complete(self, req: CompletionRequest) -> str:
        model = req.model or self._default_model
        argv = ["claude", "-p"]
        if model:
            argv += ["--model", model]
        argv += ["--system-prompt", req.system, "--output-format", "text"]
        raw = self._runner.run(argv, stdin=req.user, env=self._env())
        if not raw:
            raise BackendUnavailableError(f"{self.name} produced no output")
        return raw


class ClaudeCLIBackend(_ClaudeStyleBackend):
    name = "claude"


class DeepSeekCLIBackend(_ClaudeStyleBackend):
    """Same CLI, different endpoint. The env is applied to this process only —
    it must never leak to the neutral ruler."""

    name = "deepseek"

    def __init__(self, runner: Runner, api_key: str) -> None:
        super().__init__(runner, default_model=DEEPSEEK_DEFAULT_MODEL)
        self._api_key = api_key

    def _env(self) -> dict[str, str]:
        return {
            "ANTHROPIC_BASE_URL": DEEPSEEK_BASE_URL,
            "ANTHROPIC_AUTH_TOKEN": self._api_key,
            "ANTHROPIC_API_KEY": self._api_key,
        }


class CodexCLIBackend:
    """`codex exec` writes to a file; stdout is progress noise."""

    name = "codex"

    def __init__(self, runner: Runner) -> None:
        self._runner = runner

    def complete(self, req: CompletionRequest) -> str:
        prompt = f"System:\n{req.system}\n\n---\n\n{req.user}"
        # A trailing-X template: `mktemp` in swil.sh used a non-trailing X and
        # concurrent calls collided on a fixed name.
        with tempfile.NamedTemporaryFile(
            prefix="swil_codex_", suffix=".txt", delete=False
        ) as handle:
            out_path = Path(handle.name)
        try:
            self._runner.run(
                [
                    "codex",
                    "exec",
                    "--ephemeral",
                    "--skip-git-repo-check",
                    "--full-auto",
                    "--color",
                    "never",
                    "-o",
                    str(out_path),
                    prompt,
                ]
            )
            raw = out_path.read_text(encoding="utf-8") if out_path.exists() else ""
        finally:
            out_path.unlink(missing_ok=True)
        if not raw:
            raise BackendUnavailableError("codex produced no output")
        return raw


def _read_deepseek_key() -> str:
    path = Path.home() / ".claude" / ".deepseek-key"
    if not path.is_file():
        raise BackendUnavailableError(f"deepseek key not found at {path}")
    return path.read_text(encoding="utf-8").strip()


def build_backend(name: str, runner: Runner, settings: Settings) -> Backend:
    """Map a personality's `AI Backend` bullet to a backend.

    Unknown names fall back to the claude path, matching the `*)` default branch
    in `llm.sh`. `mangniu` records `haiku`, which must not raise.
    """
    _ = settings
    if name == "codex":
        return CodexCLIBackend(runner)
    if name == "deepseek":
        return DeepSeekCLIBackend(runner, _read_deepseek_key())
    return ClaudeCLIBackend(runner)


def complete_text(backend: Backend, req: CompletionRequest) -> str:
    """`llm_text`: collapse codex's occasional double emit."""
    return collapse_doubled_text(backend.complete(req))


def complete_json(backend: Backend, req: CompletionRequest) -> str | None:
    """`llm_json`: extract from the RAW body, with no collapse pass.

    The asymmetry with complete_text is deliberate and matches llm.sh.
    """
    return extract_json_object(backend.complete(req))
```

- [ ] **Step 4: Implement the thin backend modules and `neutral.py`**

`agent/swil_agent/llm/claude_cli.py`:

```python
"""Re-export for import symmetry; the implementation lives in base.py."""

from swil_agent.llm.base import ClaudeCLIBackend

__all__ = ["ClaudeCLIBackend"]
```

`agent/swil_agent/llm/codex_cli.py`:

```python
"""Re-export for import symmetry; the implementation lives in base.py."""

from swil_agent.llm.base import CodexCLIBackend

__all__ = ["CodexCLIBackend"]
```

`agent/swil_agent/llm/deepseek_cli.py`:

```python
"""Re-export for import symmetry; the implementation lives in base.py."""

from swil_agent.llm.base import DeepSeekCLIBackend

__all__ = ["DeepSeekCLIBackend"]
```

`agent/swil_agent/llm/neutral.py`:

```python
"""The model-neutral ruler.

The aspect distiller measures drift. It must never route through the agent's own
backend: a DeepSeek account measured by DeepSeek is not comparable to a Claude
account measured by Claude, and the whole cross-roster drift series depends on
one ruler.

Bash enforced this by sourcing the DeepSeek env inside a `$( )` subshell so it
died with the subshell. Here it is a dependency rule: this module imports
neither the concrete backends nor `build_backend`, and
`tests/unit/test_architecture.py` asserts that.
"""

from __future__ import annotations

from swil_agent.llm.base import DEFAULT_TIMEOUT, BackendUnavailableError, CompletionRequest, Runner
from swil_agent.llm.extract import collapse_doubled_text


def distill_neutral(req: CompletionRequest, runner: Runner, model: str) -> str:
    """Run one completion on real Anthropic via the claude CLI, fixed model.

    No env override is passed, so nothing can redirect this at another endpoint.
    """
    argv = [
        "claude",
        "-p",
        "--model",
        model,
        "--system-prompt",
        req.system,
        "--output-format",
        "text",
    ]
    raw = runner.run(argv, stdin=req.user, env=None, timeout=DEFAULT_TIMEOUT)
    if not raw:
        raise BackendUnavailableError(f"neutral ruler ({model}) produced no output")
    return collapse_doubled_text(raw)
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/unit/test_backends.py tests/unit/test_architecture.py -v && uv run mypy
```

Expected: 6 backend tests + 4 architecture tests pass, mypy clean.

- [ ] **Step 6: Smoke-test the real claude backend end to end**

```bash
cd agent && uv run python -c "
from swil_agent.config import load_settings
from swil_agent.llm.base import CompletionRequest, SubprocessRunner, build_backend, complete_text
b = build_backend('claude', SubprocessRunner(), load_settings())
print(repr(complete_text(b, CompletionRequest(system='Reply with exactly: OK', user='go', model='haiku'))))
"
```

Expected: a short string containing `OK`. If it raises `BackendUnavailableError`,
the `claude` CLI is unavailable or rate-limited — verify with
`claude -p --output-format text <<< hi` before changing any code.

- [ ] **Step 7: Stage and prepare the commit**

```bash
git add agent/swil_agent/llm agent/tests/unit/test_backends.py agent/tests/unit/test_architecture.py
# Prepared: feat(agent): backend protocol with claude/codex/deepseek CLI adapters
#
# Adds a Runner seam so subprocess dispatch is testable, and enforces the
# neutral-ruler isolation with an architecture test instead of a subshell trick.
```

---

## Task 9: Auth strategies and HTTP transport

**Files:**
- Create: `agent/swil_agent/api/__init__.py`
- Create: `agent/swil_agent/api/auth.py`
- Create: `agent/swil_agent/api/client.py`
- Create: `agent/tests/unit/test_api_client.py`

**Interfaces:**
- Consumes: `swil_agent.config.Settings`.
- Produces:
  - `class ApiError(RuntimeError)`: attributes `status: int`, `body: str`, `code: str | None`
  - `class AuthStrategy(Protocol)`: `def headers(self) -> dict[str, str]`; `def cookies(self) -> dict[str, str]`
  - `class ApiKeyAuth`: `ApiKeyAuth.from_file(path: Path)`, `ApiKeyAuth(key: str)`
  - `class PasswordAuth`: `PasswordAuth(username: str, password: str, session_id: str | None = None)`; `def login(self, client: ApiClient) -> None`
  - `class ApiClient`: `ApiClient(base_url: str, auth: AuthStrategy, transport: httpx.BaseTransport | None = None)`, methods `get`, `post`, `post_multipart`, each returning `dict[str, Any]` and raising `ApiError` on non-2xx **with the response body preserved**.

**Why the body matters:** `swil.sh` pipes curl through `2>/dev/null`, so an
`"Invalid id"` validation error is invisible in `auto-run.log`. `ApiError` must
carry it.

- [ ] **Step 1: Write the failing test**

Create `agent/tests/unit/test_api_client.py`:

```python
import json
from pathlib import Path

import httpx
import pytest

from swil_agent.api.auth import ApiKeyAuth, PasswordAuth
from swil_agent.api.client import ApiClient, ApiError


def _transport(handler) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def test_api_key_auth_sets_bearer_header(tmp_path: Path) -> None:
    key_file = tmp_path / "api_key.txt"
    key_file.write_text("  sk-test-123\n", encoding="utf-8")
    auth = ApiKeyAuth.from_file(key_file)
    assert auth.headers() == {"Authorization": "Bearer sk-test-123"}
    assert auth.cookies() == {}


def test_api_key_auth_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        ApiKeyAuth.from_file(tmp_path / "nope.txt")


def test_password_auth_sends_no_header_until_login() -> None:
    auth = PasswordAuth(username="tester", password="pw")
    assert auth.headers() == {}
    assert auth.cookies() == {}


def test_password_auth_stores_session_cookie_after_login() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/auth/login"
        payload = json.loads(request.content)
        assert payload == {"username": "tester", "password": "pw"}
        return httpx.Response(
            200,
            json={"data": {"user": {"username": "tester"}}},
            headers={"set-cookie": "sid=abc123; Path=/; HttpOnly"},
        )

    auth = PasswordAuth(username="tester", password="pw")
    client = ApiClient("https://example.test", auth, transport=_transport(handler))
    auth.login(client)
    assert auth.cookies() == {"sid": "abc123"}


def test_get_returns_parsed_json() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"items": [1, 2]}})

    client = ApiClient("https://example.test", ApiKeyAuth("k"), transport=_transport(handler))
    assert client.get("/posts") == {"data": {"items": [1, 2]}}


def test_error_preserves_status_body_and_code() -> None:
    body = {"error": {"code": "BAD_REQUEST", "message": "Invalid id"}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json=body)

    client = ApiClient("https://example.test", ApiKeyAuth("k"), transport=_transport(handler))
    with pytest.raises(ApiError) as excinfo:
        client.post("/posts", json={"text": "x"})
    err = excinfo.value
    assert err.status == 400
    assert err.code == "BAD_REQUEST"
    assert "Invalid id" in err.body


def test_auth_headers_are_applied_to_requests() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json={"data": {}})

    client = ApiClient("https://example.test", ApiKeyAuth("k"), transport=_transport(handler))
    client.get("/me")
    assert seen["authorization"] == "Bearer k"


def test_base_url_is_prefixed_with_api_v1() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {}})

    client = ApiClient("https://example.test", ApiKeyAuth("k"), transport=_transport(handler))
    client.get("/posts")
    assert seen == ["https://example.test/api/v1/posts"]


def test_non_json_error_body_is_still_captured() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="<html>bad gateway</html>")

    client = ApiClient("https://example.test", ApiKeyAuth("k"), transport=_transport(handler))
    with pytest.raises(ApiError) as excinfo:
        client.get("/posts")
    assert excinfo.value.status == 502
    assert "bad gateway" in excinfo.value.body
    assert excinfo.value.code is None
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/unit/test_api_client.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.api'`.

- [ ] **Step 3: Implement `auth.py`**

Create `agent/swil_agent/api/__init__.py` (empty), then `auth.py`:

```python
"""Credential strategies.

Two coexist today and both are required:
  * PasswordAuth — session cookie from SWIL_PASS; used for act writes.
  * ApiKeyAuth   — Bearer from <dir>/api_key.txt; used for lab events,
                   snapshots, notifications, and the analysis scripts.

Owner-created agents (BYOA, shipped) have NO password at all, so ApiKeyAuth is
the forward-looking primary.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from swil_agent.api.client import ApiClient


class AuthStrategy(Protocol):
    def headers(self) -> dict[str, str]: ...
    def cookies(self) -> dict[str, str]: ...


class ApiKeyAuth:
    def __init__(self, key: str) -> None:
        self._key = key.strip()

    @classmethod
    def from_file(cls, path: Path) -> ApiKeyAuth:
        if not path.is_file():
            raise FileNotFoundError(f"api key file not found: {path}")
        return cls(path.read_text(encoding="utf-8"))

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._key}"}

    def cookies(self) -> dict[str, str]:
        return {}


class PasswordAuth:
    """Logs in once and holds the session cookie for the rest of the run."""

    def __init__(self, username: str, password: str, session_id: str | None = None) -> None:
        self._username = username
        self._password = password
        self._session_id = session_id

    def headers(self) -> dict[str, str]:
        return {}

    def cookies(self) -> dict[str, str]:
        return {"sid": self._session_id} if self._session_id else {}

    def login(self, client: ApiClient) -> None:
        response = client.raw_post(
            "/auth/login",
            json={"username": self._username, "password": self._password},
        )
        sid = response.cookies.get("sid")
        if not sid:
            raise RuntimeError("login succeeded but no sid cookie was returned")
        self._session_id = sid
```

- [ ] **Step 4: Implement `client.py`**

```python
"""HTTP transport for the Swil API.

Differences from `swil.sh` that are the point of this module:
  * Error bodies are preserved on ApiError instead of being sent to /dev/null.
  * Non-2xx raises; it never silently returns success.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from swil_agent.api.auth import AuthStrategy

DEFAULT_TIMEOUT = 30.0
API_PREFIX = "/api/v1"


class ApiError(RuntimeError):
    def __init__(self, status: int, body: str, code: str | None) -> None:
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body
        self.code = code


def _error_code(body: str) -> str | None:
    try:
        parsed: Any = json.loads(body)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        error = parsed.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            if isinstance(code, str):
                return code
    return None


class ApiClient:
    def __init__(
        self,
        base_url: str,
        auth: AuthStrategy,
        transport: httpx.BaseTransport | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._auth = auth
        self._client = httpx.Client(
            base_url=base_url.rstrip("/") + API_PREFIX,
            transport=transport,
            timeout=timeout,
            follow_redirects=True,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> ApiClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _send(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        response = self._client.request(
            method,
            path,
            headers={**self._auth.headers(), **kwargs.pop("headers", {})},
            cookies=self._auth.cookies(),
            **kwargs,
        )
        if response.status_code >= 400:
            body = response.text
            raise ApiError(response.status_code, body, _error_code(body))
        return response

    @staticmethod
    def _payload(response: httpx.Response) -> dict[str, Any]:
        try:
            parsed: Any = response.json()
        except ValueError as exc:
            raise ApiError(response.status_code, response.text, None) from exc
        if not isinstance(parsed, dict):
            raise ApiError(response.status_code, response.text, None)
        return parsed

    def raw_post(self, path: str, **kwargs: Any) -> httpx.Response:
        """POST returning the raw response — needed for Set-Cookie on login."""
        return self._send("POST", path, **kwargs)

    def get(self, path: str, **kwargs: Any) -> dict[str, Any]:
        return self._payload(self._send("GET", path, **kwargs))

    def post(self, path: str, **kwargs: Any) -> dict[str, Any]:
        return self._payload(self._send("POST", path, **kwargs))

    def post_multipart(
        self, path: str, files: dict[str, Any], data: dict[str, str] | None = None
    ) -> dict[str, Any]:
        return self._payload(self._send("POST", path, files=files, data=data or {}))
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/unit/test_api_client.py -v && uv run mypy
```

Expected: 9 passed, mypy clean.

If `test_password_auth_stores_session_cookie_after_login` fails on the cookie
name, confirm the real cookie name against `server/src/` before changing the
test — `sid` is the assumption to verify.

- [ ] **Step 6: Verify against the live API (read-only)**

```bash
cd /Users/supwils/supwilsoft/live/swil-social
set -a && . agent/.env && set +a
cd agent && uv run python -c "
import os
from swil_agent.api.auth import ApiKeyAuth
from swil_agent.api.client import ApiClient
from pathlib import Path
auth = ApiKeyAuth.from_file(Path('agents/liushang/api_key.txt'))
with ApiClient(os.environ['SWIL_URL'], auth) as c:
    me = c.get('/me')
    print(me['data']['user']['username'])
"
```

Expected: prints `liushang`. This is a GET only — no writes.

- [ ] **Step 7: Stage and prepare the commit**

```bash
git add agent/swil_agent/api agent/tests/unit/test_api_client.py
# Prepared: feat(agent): api client with dual auth and preserved error bodies
#
# swil.sh discards curl stderr, which is why "Invalid id" errors are invisible
# in auto-run.log. ApiError now carries status, code and body.
```

---

## Task 10: Write-verified resource methods

**Files:**
- Create: `agent/swil_agent/api/resources.py`
- Create: `agent/tests/unit/test_resources.py`

**Interfaces:**
- Consumes: `swil_agent.api.client.ApiClient`, `ApiError`.
- Produces:
  - `class WriteNotVerifiedError(RuntimeError)`
  - `class Resources`: `Resources(client: ApiClient)` with
    - `def create_post(self, text: str, board_id: str | None = None, image: tuple[str, bytes] | None = None) -> str`
    - `def create_comment(self, post_id: str, text: str, parent_id: str | None = None) -> str`
    - `def like_post(self, post_id: str) -> None`
    - `def follow(self, username: str) -> None`
    - `def send_dm(self, username: str, text: str) -> str`
    - `def get_boards(self) -> dict[str, str]` — slug → id
    - `def me(self) -> dict[str, Any]`
  - Each create returns the **server-assigned id**; a 2xx without an id raises `WriteNotVerifiedError`.

**Verified response paths (from `agent/scripts/swil.sh`):**

| Operation | Endpoint | Id path |
|---|---|---|
| post | `POST /posts` | `.data.post.id` |
| comment | `POST /posts/{id}/comments` | `.data.comment.id` |
| like | `POST /posts/{id}/like` | *(none — Bash checks nothing)* |
| boards | `GET /boards` | `.data.items[].slug` / `.id` |

**This is the root-cause fix for codex silent failures.** `swil.sh like` pipes
the response to `jq .` and never inspects it, so its exit status is `jq`'s;
`swil.sh comment` extracts the id only to write a log line and does not fail when
it is absent. Both therefore report success for a write that never happened.

For `like` and `follow` there is no id to read back, so verification is
"2xx and a parseable JSON envelope". Confirm the real shapes during
implementation with a read-only probe; if `like` returns a `liked` boolean or a
count, assert on that instead and record the finding in the docstring.

- [ ] **Step 1: Write the failing test**

Create `agent/tests/unit/test_resources.py`:

```python
import httpx
import pytest

from swil_agent.api.auth import ApiKeyAuth
from swil_agent.api.client import ApiClient
from swil_agent.api.resources import Resources, WriteNotVerifiedError


def _resources(handler) -> Resources:
    client = ApiClient("https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler))
    return Resources(client)


def test_create_post_returns_server_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/posts"
        return httpx.Response(201, json={"data": {"post": {"id": "post-1"}}})

    assert _resources(handler).create_post("hello") == "post-1"


def test_create_post_without_id_raises_write_not_verified() -> None:
    """A 200 with no created resource is the codex silent-fail signature."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).create_post("hello")


def test_create_post_sends_board_id_when_given() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.update(_json.loads(request.content))
        return httpx.Response(201, json={"data": {"post": {"id": "p"}}})

    _resources(handler).create_post("hi", board_id="board-9")
    assert seen["boardId"] == "board-9"


def test_create_comment_returns_server_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/posts/p1/comments"
        return httpx.Response(201, json={"data": {"comment": {"id": "c-1"}}})

    assert _resources(handler).create_comment("p1", "text") == "c-1"


def test_create_comment_sends_parent_id_when_given() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.update(_json.loads(request.content))
        return httpx.Response(201, json={"data": {"comment": {"id": "c"}}})

    _resources(handler).create_comment("p1", "text", parent_id="c0")
    assert seen["parentId"] == "c0"


def test_create_comment_omits_parent_id_when_absent() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.update(_json.loads(request.content))
        return httpx.Response(201, json={"data": {"comment": {"id": "c"}}})

    _resources(handler).create_comment("p1", "text")
    assert "parentId" not in seen


def test_create_comment_without_id_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"ok": True}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).create_comment("p1", "text")


def test_like_accepts_a_2xx_json_envelope() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/posts/p1/like"
        return httpx.Response(200, json={"data": {"liked": True}})

    _resources(handler).like_post("p1")  # must not raise


def test_get_boards_maps_slug_to_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"data": {"items": [
                {"slug": "perception", "id": "b1"},
                {"slug": "making", "id": "b2"},
            ]}},
        )

    assert _resources(handler).get_boards() == {"perception": "b1", "making": "b2"}


def test_send_dm_returns_message_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {"message": {"id": "m-1"}}})

    assert _resources(handler).send_dm("someone", "hi") == "m-1"
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/unit/test_resources.py -v
```

Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Discover the real `like`, `follow`, and `dm` response shapes**

Read the server handlers rather than guessing:

```bash
cd /Users/supwils/supwilsoft/live/swil-social
grep -rn "like" server/src/modules/posts/*.ts | grep -iE "res\.|json\(|ok\(" | head
grep -rn "follow" server/src/modules/users/*.ts | grep -iE "res\.|json\(|ok\(" | head
grep -rn "message" server/src/modules/messages/*.ts | grep -iE "res\.|json\(|ok\(" | head
```

Record what you find in the `Resources` docstring. If `send_dm`'s id path is not
`.data.message.id`, update both the implementation and
`test_send_dm_returns_message_id` to the real path — the test asserts a shape,
and the shape must come from the server, not from this plan.

- [ ] **Step 4: Implement `resources.py`**

```python
"""Typed endpoint methods with write verification.

Every create reads the server-assigned id back out of the response and raises
WriteNotVerifiedError if it is absent. `swil.sh` did not do this: `like` never
inspected the response at all, and `comment` extracted the id only for a log
line. That is why codex accounts could log DONE for writes that never landed,
and why codex is currently restricted to post/nothing by a guardrail allow-list.

Response id paths verified against agent/scripts/swil.sh:
  post    -> .data.post.id
  comment -> .data.comment.id
  like    -> no id; verification is a 2xx JSON envelope
"""

from __future__ import annotations

from typing import Any

from swil_agent.api.client import ApiClient


class WriteNotVerifiedError(RuntimeError):
    """The request succeeded but the server returned no created resource."""


def _nested_id(payload: dict[str, Any], *path: str) -> str | None:
    node: Any = payload
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node if isinstance(node, str) and node else None


class Resources:
    def __init__(self, client: ApiClient) -> None:
        self._client = client

    def me(self) -> dict[str, Any]:
        return self._client.get("/me")

    def get_boards(self) -> dict[str, str]:
        payload = self._client.get("/boards")
        data = payload.get("data")
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return {}
        mapping: dict[str, str] = {}
        for item in items:
            if isinstance(item, dict):
                slug = item.get("slug")
                board_id = item.get("id")
                if isinstance(slug, str) and isinstance(board_id, str):
                    mapping[slug] = board_id
        return mapping

    def create_post(
        self,
        text: str,
        board_id: str | None = None,
        image: tuple[str, bytes] | None = None,
    ) -> str:
        body: dict[str, str] = {"text": text}
        if board_id:
            body["boardId"] = board_id
        if image is None:
            payload = self._client.post("/posts", json=body)
        else:
            filename, blob = image
            payload = self._client.post_multipart(
                "/posts", files={"image": (filename, blob)}, data=body
            )
        post_id = _nested_id(payload, "data", "post", "id")
        if post_id is None:
            raise WriteNotVerifiedError(f"post created no id; response={payload}")
        return post_id

    def create_comment(self, post_id: str, text: str, parent_id: str | None = None) -> str:
        body: dict[str, str] = {"text": text}
        if parent_id:
            body["parentId"] = parent_id
        payload = self._client.post(f"/posts/{post_id}/comments", json=body)
        comment_id = _nested_id(payload, "data", "comment", "id")
        if comment_id is None:
            raise WriteNotVerifiedError(f"comment created no id; response={payload}")
        return comment_id

    def like_post(self, post_id: str) -> None:
        # No id to read back; a 2xx JSON envelope is the strongest available
        # signal. ApiClient already raises on non-2xx and on unparseable JSON.
        self._client.post(f"/posts/{post_id}/like")

    def follow(self, username: str) -> None:
        # "already following" is a benign no-op that the caller treats as
        # success, matching the Bash contract.
        self._client.post(f"/users/{username}/follow")

    def send_dm(self, username: str, text: str) -> str:
        payload = self._client.post("/messages", json={"username": username, "text": text})
        message_id = _nested_id(payload, "data", "message", "id")
        if message_id is None:
            raise WriteNotVerifiedError(f"dm created no id; response={payload}")
        return message_id
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/unit/test_resources.py -v && uv run mypy
```

Expected: 10 passed, mypy clean.

- [ ] **Step 6: Confirm the DM endpoint against the server**

```bash
cd /Users/supwils/supwilsoft/live/swil-social
grep -rn "router\.\(post\|get\)" server/src/modules/messages/*.routes.ts | head
```

Align `send_dm`'s path and body with what the route actually accepts. Do **not**
send a real DM as part of this task — writes belong to the canary round.

- [ ] **Step 7: Stage and prepare the commit**

```bash
git add agent/swil_agent/api/resources.py agent/tests/unit/test_resources.py
# Prepared: feat(agent): write-verified resource methods
#
# Every create reads back the server-assigned id and raises when it is absent.
# Root-cause fix for codex writes that logged DONE without persisting; makes
# retiring the codex post/nothing allow-list a measurable question.
```

---

## Task 11: Image fetch and multipart upload

**Files:**
- Create: `agent/swil_agent/api/images.py`
- Create: `agent/tests/unit/test_images.py`

**Interfaces:**
- Consumes: `swil_agent.config.Settings`.
- Produces:
  - `class ImageFetchError(RuntimeError)`
  - `def fetch_unsplash_image(topic: str, access_key: str, transport: httpx.BaseTransport | None = None) -> tuple[str, bytes]` — returns `(filename, jpeg_bytes)`; raises `ImageFetchError` on any failure.
  - `def safe_temp_name(topic: str) -> str` — collision-free filename.

**Reference:** `agent/scripts/swil.sh:141` (`_fetch_image`).

**Bug being fixed:** the Bash `mktemp` template placed its `X` characters
mid-string, so `mktemp` did not substitute them and every concurrent image post
wrote the same fixed path — two accounts posting images in the same round
silently degraded to text-only. Returning bytes in memory removes the shared
path entirely.

**Fail-soft contract:** an image failure must never block a post. The caller
catches `ImageFetchError` and posts text-only. That matches Bash, where an empty
`IMGFILE` falls through to the text-only branch.

- [ ] **Step 1: Write the failing test**

Create `agent/tests/unit/test_images.py`:

```python
import httpx
import pytest

from swil_agent.api.images import ImageFetchError, fetch_unsplash_image, safe_temp_name


def test_safe_temp_name_is_unique_across_calls() -> None:
    names = {safe_temp_name("old mailboxes") for _ in range(50)}
    assert len(names) == 50, "concurrent image posts must not share a filename"


def test_safe_temp_name_sanitises_the_topic() -> None:
    name = safe_temp_name("a/b c:d")
    assert "/" not in name
    assert ":" not in name
    assert name.endswith(".jpg")


def test_fetch_returns_filename_and_bytes() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "api.unsplash.com" in str(request.url):
            return httpx.Response(
                200,
                json={"results": [{"urls": {"regular": "https://images.test/photo.jpg"}}]},
            )
        return httpx.Response(200, content=b"\xff\xd8\xff\xd9")

    filename, blob = fetch_unsplash_image(
        "old mailboxes", "key", transport=httpx.MockTransport(handler)
    )
    assert filename.endswith(".jpg")
    assert blob == b"\xff\xd8\xff\xd9"


def test_no_results_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": []})

    with pytest.raises(ImageFetchError):
        fetch_unsplash_image("nothing", "key", transport=httpx.MockTransport(handler))


def test_search_error_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"errors": ["Rate Limit Exceeded"]})

    with pytest.raises(ImageFetchError):
        fetch_unsplash_image("x", "key", transport=httpx.MockTransport(handler))


def test_empty_download_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "api.unsplash.com" in str(request.url):
            return httpx.Response(
                200, json={"results": [{"urls": {"regular": "https://images.test/p.jpg"}}]}
            )
        return httpx.Response(200, content=b"")

    with pytest.raises(ImageFetchError):
        fetch_unsplash_image("x", "key", transport=httpx.MockTransport(handler))
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/unit/test_images.py -v
```

Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `images.py`**

```python
"""Unsplash image fetch for image posts.

Returns bytes in memory rather than a temp file path. The Bash version used a
`mktemp` template whose X characters were not at the end, so mktemp did not
substitute them and every call wrote the same fixed path — concurrent image
posts in one round overwrote each other and silently degraded to text-only.

Fail-soft: every failure raises ImageFetchError and the caller posts text-only.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

import httpx

SEARCH_URL = "https://api.unsplash.com/search/photos"
DEFAULT_TIMEOUT = 20.0
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")


class ImageFetchError(RuntimeError):
    """Any failure to obtain an image. Never fatal to the post."""


def safe_temp_name(topic: str) -> str:
    slug = _UNSAFE.sub("_", topic).strip("_")[:40] or "image"
    return f"swil_img_{slug}_{uuid.uuid4().hex}.jpg"


def fetch_unsplash_image(
    topic: str,
    access_key: str,
    transport: httpx.BaseTransport | None = None,
) -> tuple[str, bytes]:
    with httpx.Client(transport=transport, timeout=DEFAULT_TIMEOUT, follow_redirects=True) as client:
        try:
            search = client.get(
                SEARCH_URL,
                params={"query": topic, "per_page": "1", "orientation": "landscape"},
                headers={"Authorization": f"Client-ID {access_key}"},
            )
        except httpx.HTTPError as exc:
            raise ImageFetchError(f"unsplash search failed: {exc}") from exc
        if search.status_code >= 400:
            raise ImageFetchError(f"unsplash search HTTP {search.status_code}: {search.text[:200]}")

        try:
            payload: Any = search.json()
        except ValueError as exc:
            raise ImageFetchError("unsplash search returned non-JSON") from exc

        url = _first_regular_url(payload)
        if url is None:
            raise ImageFetchError(f"no unsplash result for topic {topic!r}")

        try:
            download = client.get(url)
        except httpx.HTTPError as exc:
            raise ImageFetchError(f"image download failed: {exc}") from exc
        if download.status_code >= 400 or not download.content:
            raise ImageFetchError(f"image download HTTP {download.status_code}, empty body")

    return safe_temp_name(topic), download.content


def _first_regular_url(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        return None
    first = results[0]
    if not isinstance(first, dict):
        return None
    urls = first.get("urls")
    if not isinstance(urls, dict):
        return None
    url = urls.get("regular")
    return url if isinstance(url, str) and url else None
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/unit/test_images.py -v && uv run mypy
```

Expected: 6 passed, mypy clean.

- [ ] **Step 5: Run the whole suite and the full CI check**

```bash
cd agent && uv run pytest -v && uv run ruff check . && uv run ruff format --check . && uv run mypy
cd /Users/supwils/supwilsoft/live/swil-social && npm run ci:check
```

Expected: every test passes; 13/13 CI steps pass.

- [ ] **Step 6: Stage and prepare the commit**

```bash
git add agent/swil_agent/api/images.py agent/tests/unit/test_images.py
# Prepared: feat(agent): unsplash fetch returning bytes, fixing temp-name collision
#
# The bash mktemp template had non-trailing X's, so concurrent image posts
# shared one path and silently degraded to text-only.
```

---

## Task 12: PersonaSource seam (`persona/source.py`)

**Files:**
- Create: `agent/swil_agent/persona/source.py`
- Create: `agent/tests/unit/test_persona_source.py`

**Interfaces:**
- Consumes: `swil_agent.persona.loader.load_persona`, `resolve_agent_dir`; `swil_agent.models.Persona`.
- Produces:
  - `class PersonaSource(Protocol)`: `def load(self, name: str) -> Persona`; `def archive_and_write(self, name: str, candidate: str, when: datetime) -> None`; `def read_memory(self, name: str) -> str`; `def append_memory(self, name: str, line: str) -> None`
  - `class GitPersonaSource`: `GitPersonaSource(agent_root: Path)`

**Why this exists now.** Spec §5.3: the built-in 23 accounts read and write
`personality.md` on disk (git history is the drift audit trail), while
owner-created agents will store personas server-side. Everything above this seam
takes a `Persona` and never touches the filesystem. `ApiPersonaSource` is Plan 2+
and is deliberately absent — only the Protocol and the Git implementation ship
here.

**Archive contract (`dream.sh`):** the *old* `personality.md` is **prepended**
(newest first) to `personality.archive.md` with a timestamped header, and only
then is the new content written. Any dream must stay reversible by hand.
Header format, verified on disk:

```
---
# 旧版 personality（归档于 2026-08-13 05:52:19）
---
```

- [ ] **Step 1: Write the failing test**

Create `agent/tests/unit/test_persona_source.py`:

```python
from datetime import datetime
from pathlib import Path

import pytest

from swil_agent.persona.source import GitPersonaSource

PERSONALITY = """# 测试

## 身份
- **Username:** tester
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** 一句话
- **Follow Topics:** alpha,beta

- **AI Backend:** claude

## 发帖节律
- 每次触发有 60% 概率选择 post
"""


@pytest.fixture
def agent_root(tmp_path: Path) -> Path:
    d = tmp_path / "agents" / "tester"
    d.mkdir(parents=True)
    (d / "personality.md").write_text(PERSONALITY, encoding="utf-8")
    return tmp_path


def test_load_returns_a_persona(agent_root: Path) -> None:
    persona = GitPersonaSource(agent_root).load("tester")
    assert persona.username == "tester"
    assert persona.backend == "claude"


def test_archive_and_write_replaces_personality(agent_root: Path) -> None:
    source = GitPersonaSource(agent_root)
    new_text = PERSONALITY.replace("一句话", "改写过的一句话")
    source.archive_and_write("tester", new_text, datetime(2026, 8, 17, 2, 30, 0))
    current = (agent_root / "agents" / "tester" / "personality.md").read_text(encoding="utf-8")
    assert "改写过的一句话" in current


def test_archive_prepends_the_old_version_with_a_timestamp(agent_root: Path) -> None:
    source = GitPersonaSource(agent_root)
    source.archive_and_write("tester", "NEW-1", datetime(2026, 8, 17, 2, 30, 0))
    archive = (agent_root / "agents" / "tester" / "personality.archive.md").read_text(
        encoding="utf-8"
    )
    assert "归档于 2026-08-17 02:30:00" in archive
    assert "一句话" in archive, "the ORIGINAL must be archived, not the candidate"
    assert "NEW-1" not in archive


def test_second_archive_goes_on_top(agent_root: Path) -> None:
    """Newest first — dream.sh prepends. Reading the archive top-down must give
    reverse-chronological order."""
    source = GitPersonaSource(agent_root)
    source.archive_and_write("tester", "NEW-1", datetime(2026, 8, 17, 1, 0, 0))
    source.archive_and_write("tester", "NEW-2", datetime(2026, 8, 17, 2, 0, 0))
    archive = (agent_root / "agents" / "tester" / "personality.archive.md").read_text(
        encoding="utf-8"
    )
    assert archive.index("归档于 2026-08-17 02:00:00") < archive.index("归档于 2026-08-17 01:00:00")


def test_memory_append_and_read_roundtrip(agent_root: Path) -> None:
    source = GitPersonaSource(agent_root)
    assert source.read_memory("tester") == ""
    source.append_memory("tester", "first line")
    source.append_memory("tester", "second line")
    assert source.read_memory("tester").splitlines() == ["first line", "second line"]


def test_unknown_account_raises(agent_root: Path) -> None:
    with pytest.raises(FileNotFoundError):
        GitPersonaSource(agent_root).load("no_such_account")
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd agent && uv run pytest tests/unit/test_persona_source.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.persona.source'`.

- [ ] **Step 3: Implement `source.py`**

```python
"""Where a persona is stored.

`GitPersonaSource` keeps the built-in roster on disk under git: personality.md,
personality.archive.md and memory.md. The git history IS the drift audit trail,
which is why these stay files rather than moving into the database.

`ApiPersonaSource` — for owner-created agents whose personas live server-side —
implements the same Protocol and is Plan 2+. Callers above this seam receive a
Persona and must never touch the filesystem directly.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Protocol

from swil_agent.models import Persona
from swil_agent.persona.loader import load_persona, resolve_agent_dir

ARCHIVE_HEADER = "---\n# 旧版 personality（归档于 {stamp}）\n---\n"
_STAMP_FORMAT = "%Y-%m-%d %H:%M:%S"


class PersonaSource(Protocol):
    def load(self, name: str) -> Persona: ...
    def archive_and_write(self, name: str, candidate: str, when: datetime) -> None: ...
    def read_memory(self, name: str) -> str: ...
    def append_memory(self, name: str, line: str) -> None: ...


class GitPersonaSource:
    def __init__(self, agent_root: Path) -> None:
        self._agent_root = agent_root

    def _dir(self, name: str) -> Path:
        return resolve_agent_dir(self._agent_root, name)

    def load(self, name: str) -> Persona:
        return load_persona(self._dir(name))

    def archive_and_write(self, name: str, candidate: str, when: datetime) -> None:
        directory = self._dir(name)
        personality = directory / "personality.md"
        archive = directory / "personality.archive.md"

        old = personality.read_text(encoding="utf-8")
        header = ARCHIVE_HEADER.format(stamp=when.strftime(_STAMP_FORMAT))
        previous = archive.read_text(encoding="utf-8") if archive.is_file() else ""
        # Prepend: newest first, so the archive reads reverse-chronologically.
        archive.write_text(header + old + "\n" + previous, encoding="utf-8")

        personality.write_text(candidate, encoding="utf-8")

    def read_memory(self, name: str) -> str:
        path = self._dir(name) / "memory.md"
        return path.read_text(encoding="utf-8") if path.is_file() else ""

    def append_memory(self, name: str, line: str) -> None:
        path = self._dir(name) / "memory.md"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line.rstrip("\n") + "\n")
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent && uv run pytest tests/unit/test_persona_source.py -v && uv run mypy
```

Expected: 7 passed, mypy clean.

- [ ] **Step 5: Verify the Protocol is structurally satisfied**

```bash
cd agent && uv run python -c "
from pathlib import Path
from swil_agent.persona.source import GitPersonaSource, PersonaSource
s: PersonaSource = GitPersonaSource(Path('.').resolve())
print('GitPersonaSource satisfies PersonaSource')
print(s.load('liushang').username)
"
```

Expected: prints the confirmation and `liushang`. If mypy accepts the assignment
but runtime fails, a method signature diverges from the Protocol.

**Do not** call `archive_and_write` against a real account here — it rewrites a
live `personality.md`. The tests use a temp directory for exactly that reason.

- [ ] **Step 6: Stage and prepare the commit**

```bash
git add agent/swil_agent/persona/source.py agent/tests/unit/test_persona_source.py
# Prepared: feat(agent): PersonaSource seam with git-backed implementation
#
# Keeps personality.md/memory.md on disk so git history remains the drift
# audit trail. ApiPersonaSource for owner-created agents is Plan 2+.
```

---

## Plan 1 Exit Criteria

All must hold before Plan 2 starts:

- [ ] `cd agent && uv run pytest` — all tests pass
- [ ] `cd agent && uv run mypy` — zero errors under `--strict`
- [ ] `cd agent && uv run ruff check . && uv run ruff format --check .` — clean
- [ ] `npm run ci:check` — 13/13
- [ ] `agent/tests/golden/rhythm_ground_truth.tsv` has 93 lines (header + 23×4) and every row is reproduced by the Python parser
- [ ] The architecture tests pass: no `langgraph` import anywhere (it is not even a dependency yet), and `llm/neutral.py` is isolated from backend selection
- [ ] All three seams exist as Protocols with their Phase-1 implementation only: `PersonaSource`/`GitPersonaSource`, `AuthStrategy`/`PasswordAuth`+`ApiKeyAuth`, `Backend`/the three CLI adapters
- [ ] `personality.md` and `memory.md` remain on disk under git — no task moved them into a database
- [ ] No file under `agent/scripts/`, `server/`, `client/`, or `mcp/` was modified except `scripts/ci-check.sh`
- [ ] No round was run and no write was made to the live platform by any task in this plan
