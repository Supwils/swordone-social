# Runtime Prompt v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every persona-facing prompt behind one versioned seam (v1 byte-identical, its size measured on the `cycle_run` card), build the lean handle-based prompt v2 behind a two-key switch that defaults off, and add an offline `swil-agent prompt-ab` harness that compares the two without posting.

**Architecture:** A new leaf package `agent/swil_agent/prompts/` owns all prompt text: `v1/` is today's text moved verbatim, `v2/` is the spec §4 prompt. `prompts.act_prompt` / `prompts.dream_prompt` return a `RenderedPrompt` (request + per-part char counts + v2 handle map). The act path first starts keeping the raw rows it renders (`ActContext.sources`, byte-neutral), because v2 needs rows rather than v1's pre-rendered strings. v2 handles (`p1`, `c1`) are mapped back to ids in `guardrail_step` before the existing six guardrail stages.

**Tech Stack:** Python 3.13, uv, pydantic v2 + pydantic-settings, LangGraph (only inside `graph/`), Typer, pytest (`--cov-fail-under=97` at the gate), ruff (E501 at 100 columns, CJK counts as width 2), mypy `--strict`.

**Spec:** `docs/superpowers/specs/2026-10-17-runtime-prompt-v2-design.md`

---

## Rulings on the spec (read before Task 1)

The spec was written before these were checked against the code. Each ruling is binding for this plan.

- **R1 — the goldens record the cycle_run card.** 7 of the 16 golden files (`cycle_auto_post`, `cycle_auto_interact`, `cycle_auto_dream_granted`, `cycle_auto_dream_not_due`, `cycle_offline`, `cycle_backend_unavailable`, `cycle_guardrail_emptied`) journal the `cycle_run` lab event, so adding `promptVersion`/`promptChars` (spec A3) cannot leave them byte-identical. Tasks 1–6 change zero golden bytes. Task 7 alone re-records exactly those 7 files and proves with a script that every byte except the new card keys (every backend request included) is unchanged. The spec's "19 golden runs" is 16 files.
- **R2 — `promptChars` is flattened.** The server's `agentEventIngest.metrics` is `z.record(string | number | boolean | null)` and the agent's contract schema has `additionalProperties: {type: [string, number, boolean, null]}`: a nested object is a 400. So the card carries scalar keys `promptCharsSystem … promptCharsTotal` and `dreamPromptCharsSystem`, `dreamPromptCharsUser`, `null` when that phase rendered nothing. No server or contract change, no `contract:sync`.
- **R3 — seam signatures.** The system prompt is `persona.prompt`, so the seam takes the persona: `act_prompt(version, persona, ctx, rhythm) -> RenderedPrompt` and `dream_prompt(version, persona, *, memory_tail, group_memory) -> RenderedPrompt`. There is no `MemoryLine` type; v2 parses the memory tail itself.
- **R4 — raw rows are kept on `ActContext.sources`.** `ActContext` holds only rendered strings and the world context (`context_now`, `feed_context`) is pre-rendered in `cli/compose.py`. Task 2 keeps the rows each block was rendered from, with no change to any fetch or byte. That is what lets `prompt-ab` render one fetched context through both versions.
- **R5 — `prompt-ab` has no `--rounds`.** Spec §5.1 rebuilds contexts live with `act --dry-run` semantics, and no past context is stored that could be replayed. The flags are `--accounts`, `--k`, `--phase`, `--seed`. The report is `agent/bench/results/prompt-ab/<YYYYMMDDTHHMMSSZ>-<phase>.json`, so two runs on one day do not overwrite each other.
- **R6 — notifications and off-list thread roots get handles.** Rendering notifications "without ids" would leave no way to reply to one. v2 shows a notification's post and comment as handles (`p…`, `c…`) and never as raw ids. A thread root that is not in the 30-post list gets the next `p` handle, and its line is printed above its comments.
- **R7 — `PROMPT_VERSION=v2` without `PROMPT_V2_ENABLED` is a settings validation error.** It fails loudly, like any other out-of-range setting. `PROMPT_V2_ENABLED` fails closed: only `1/true/yes/on` turn it on. `prompt-ab` renders both versions whatever the setting says, because it is offline and never runs inside a round.
- **R8 — `RhythmDecision.guidance` stays.** It is checkpointed state and `test_rhythm.py` pins it. The strings move to `prompts/v1/rhythm.py`, and the typed decision gains `ceiling_reached`.
- **R9 — news "summary" means the digest's `→` takeaway line**, or the `###` title when a topic has none. The 2,000-char cap applies to the block's content lines and excludes its `###` heading.

## Global Constraints

- Phase A (Tasks 1–7) changes no persona-visible byte. Tasks 1–6: `git diff --exit-code -- agent/tests/unit/golden` and every full-text pin (`test_planner.py` `_EXPECTED_EMPTY`/`_EXPECTED_POPULATED`, `test_dream_candidate.py`, `test_world_context.py`, `test_rhythm.py`) must stay unchanged. Task 7 is the R1 exception.
- v2 is reachable at runtime only with `PROMPT_VERSION=v2` **and** `PROMPT_V2_ENABLED=1`. The default is `v1`. v2 goldens live in `agent/tests/unit/golden/v2/`, and v1 goldens are never re-recorded by a v2 task.
- Do not touch `agent/swil_agent/llm/backends/*` or `agent/swil_agent/llm/isolation.py`. Every persona call stays tool-less and isolated. `prompt-ab` reuses `compose.select_backend` and never executes, posts, PATCHes or files a lab event.
- No model label may appear in any v2 prompt: no backend name (`claude`, `codex`, `cursor`, `grok`) and no model id or family from any roster `model:` line.
- The on-disk format of `memory.md` does not change.
- v2 numbers, copied from the spec: posts merged in the order home board → topic search → recommended → timeline (probe posts first in a probe eval), by id, first occurrence wins, **≤ 30**. Post text **≤ 160**, comment text **≤ 120**, **≤ 6** comments per thread, **≤ 3** threads (chosen as today). News is the board topics plus `general`, summary plus **≤ 3** highlights per topic, content **≤ 2,000** chars. Notifications **≤ 8**, DMs **≤ 6**, contacts **≤ 20**, memory **≤ 16** lines. Dream reads the last **30** memory lines, and parsing and clamping (**5 × 60**) are unchanged.
- Board → news topics: `making` → supply-chain, auto-mobility; `living` → (general only); `life-science` → science, sports-health-nutrition; `perception` → gaming; `ai-governance` → ai-tech; `market` → finance, crypto. `general` is always added.
- Every `agent/swil_agent/**/*.py` file stays ≤ 600 lines (`test_no_module_exceeds_600_lines`). `cli/compose.py` is **already at 600**, and `act/round.py` is at 568.
- `agent/swil_agent/analysis/` must not import `graph`, `act` or `dream`. `prompts/` imports only `swil_agent.models`, `swil_agent.llm.runner` and itself (the test is added in Task 3).
- ruff: lines ≤ 100 columns, where a CJK character counts as 2. Wrap long Chinese literals with implicit concatenation. RUF001 is ignored for string literals, but RUF002/RUF003 are not, so docstrings and comments use ASCII punctuation only.
- Do not edit frozen docs: `docs/superpowers/specs/*` (this spec included), any pre-registration, `agent/archive/**`, `agent/agents/**`.
- Work on the local branch `feat/runtime-prompt-v2`. Each task ends with one Conventional Commit with a one-line subject. They are squashed to 2–3 before landing. **Never push.** Stage explicit paths only: the tree has unrelated untracked files (`agent/Untitled`, two specs).
- Agent gate (from `scripts/ci-check.sh`): `cd agent && uv lock --check --offline && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest --cov-fail-under=97`.

## Review Focus

1. **A thread checkpointed before this work, resumed after the switch.** Its `ActContext` has no `sources`, its `RhythmDecision` has no `ceiling_reached`, and its state has no `handles`. Expected: v2 still renders, with the material blocks omitted. Guardrails resolve nothing when `handles` is absent, so v1 raw ids still pass. Tests are in Tasks 4, 8 and 10.
2. **A reply to a notification, or to a thread whose root is not among the 30 posts.** Expected: the target has a handle in the prompt and that handle resolves to the real id. Tests are in Task 10 (unit) and Task 12 (golden `cycle_auto_interact_handle`).
3. **A messy news cache.** That covers the `（无法获取）` placeholder, a digest with no `### [topic]` lines, a board missing from the table, and a CJK-heavy digest far over 2,000 chars. Expected: the block is omitted or capped, and nothing raises. Tests are in Task 9.
4. **Operator spellings of the two keys:** `V2`, ` v2 `, an empty `PROMPT_VERSION=`, and `PROMPT_V2_ENABLED=yes|maybe|`. Expected: `v2` alone is refused, only an on-word enables, and a blank version means `v1`. Tests are in Task 1.
5. **`prompt-ab` against the production host with one broken account in the roster.** Expected: the other accounts are still sampled, and the platform receives no post, comment, like, PATCH, post vector or lab event. Tests are in Task 13.

---

## File structure

| Path | Responsibility |
|---|---|
| `agent/swil_agent/prompts/__init__.py` (new) | The seam: `act_prompt`, `dream_prompt`, dispatch by version |
| `agent/swil_agent/prompts/types.py` (new) | `RenderedPrompt`, `ACT_PROMPT_PARTS`, `DREAM_PROMPT_PARTS`, `act_chars`, `dream_chars` |
| `agent/swil_agent/prompts/v1/{act,dream,rhythm,now}.py` (new) | Today's text, moved verbatim |
| `agent/swil_agent/prompts/v2/{act,dream,memory,news}.py` (new) | The spec §4 prompt |
| `agent/swil_agent/models.py` | `PromptVersion`, `ThreadSource`, `ActSources`, `HandleMap`, `ActContext.sources`, `RhythmDecision.ceiling_reached`, drop `backend_action_constraint` |
| `agent/swil_agent/config.py` | `prompt_version`, `prompt_v2_enabled`, two-key validator |
| `agent/swil_agent/act/context.py` | Row-returning world reads, `read_world_context`, `build_context(world=…)` keeps rows |
| `agent/swil_agent/act/planner.py` | Text removed (re-exports kept); `plan_request` |
| `agent/swil_agent/act/guardrails.py` | `resolve_handles` (`unknown_handle`) |
| `agent/swil_agent/act/round.py` | `context_step(world=…)`, `plan_step(prompt=…)`, `guardrail_step(handles=…)` |
| `agent/swil_agent/llm/extract.py` | `normalize_plan(raw, *, handle_keys=False)` |
| `agent/swil_agent/persona/rhythm.py` | Text from `prompts/v1/rhythm.py`, `ceiling_reached` |
| `agent/swil_agent/dream/candidate.py`, `dream/round.py` | Text moved out; `dream_step(version=…)` returns prompt size |
| `agent/swil_agent/graph/{deps,state,nodes_act,nodes_dream,nodes_tail}.py` | Wiring: `world`, `prompt_version`, `act_prompt_chars`, `dream_prompt_chars`, `handles`, card |
| `agent/swil_agent/analysis/cycle_run.py` | `promptVersion` + flattened `promptChars*` keys |
| `agent/swil_agent/cli/compose.py` | `world_context_for` replaces `context_now_for` + `feed_context_for` |
| `agent/swil_agent/bench/prompt_ab.py` (new) | A/B sampling, aggregation, pass bar, report, table |
| `agent/swil_agent/cli/prompt_ab.py` (new), `cli/__init__.py` | The `prompt-ab` command and its registration |
| `agent/tests/unit/golden/v2/*.json` (new) | v2 goldens |

---

### Task 1: The two-key `PROMPT_VERSION` setting

**Files:**
- Modify: `agent/swil_agent/models.py` (add `PromptVersion` next to `ActionKind`)
- Modify: `agent/swil_agent/config.py`
- Modify: `agent/tests/unit/test_golden_runs.py` (`_settings` lists the two new fields explicitly)
- Test: `agent/tests/unit/test_config.py` (append)

**Interfaces:**
- Produces: `swil_agent.models.PromptVersion = Literal["v1", "v2"]`; `Settings.prompt_version: PromptVersion` (default `"v1"`); `Settings.prompt_v2_enabled: bool` (default `False`). `Settings(...)` raises `pydantic.ValidationError` for `v2` without the enable flag.

- [ ] **Step 0: Branch**

```bash
cd /Users/supwils/supwilsoft/live/swil-social && git switch -c feat/runtime-prompt-v2
```

- [ ] **Step 1: Write the failing tests** (append to `agent/tests/unit/test_config.py`; `pytest`, `ValidationError`, `Path`, `Settings`, `load_settings` are already imported there)

```python
# ── prompt version (spec 2026-10-17 A2) ──────────────────────────────────────


def _prompt_settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> Settings:
    for key in ("PROMPT_VERSION", "PROMPT_V2_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return Settings()


def test_prompt_version_defaults_to_v1(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _prompt_settings(monkeypatch)
    assert settings.prompt_version == "v1"
    assert settings.prompt_v2_enabled is False


def test_v2_without_the_enable_flag_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError, match="PROMPT_V2_ENABLED"):
        _prompt_settings(monkeypatch, PROMPT_VERSION="v2")


def test_the_enable_flag_alone_changes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _prompt_settings(monkeypatch, PROMPT_V2_ENABLED="1").prompt_version == "v1"


@pytest.mark.parametrize("flag", ["1", "true", "YES", " on "])
def test_both_keys_switch_to_v2(monkeypatch: pytest.MonkeyPatch, flag: str) -> None:
    settings = _prompt_settings(monkeypatch, PROMPT_VERSION=" V2 ", PROMPT_V2_ENABLED=flag)
    assert settings.prompt_version == "v2"
    assert settings.prompt_v2_enabled is True


@pytest.mark.parametrize("flag", ["", "0", "off", "maybe"])
def test_only_an_on_word_enables_v2(monkeypatch: pytest.MonkeyPatch, flag: str) -> None:
    with pytest.raises(ValidationError):
        _prompt_settings(monkeypatch, PROMPT_VERSION="v2", PROMPT_V2_ENABLED=flag)


def test_a_blank_prompt_version_reads_as_v1(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _prompt_settings(monkeypatch, PROMPT_VERSION="").prompt_version == "v1"


def test_an_unknown_prompt_version_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError):
        _prompt_settings(monkeypatch, PROMPT_VERSION="v3")


def test_the_dot_env_file_can_switch_both_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for key in ("PROMPT_VERSION", "PROMPT_V2_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    env = tmp_path / ".env"
    env.write_text("PROMPT_VERSION=v2\nPROMPT_V2_ENABLED=1\n", encoding="utf-8")
    assert load_settings(env).prompt_version == "v2"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_config.py -q -k prompt`
Expected: FAIL (`AttributeError: 'Settings' object has no attribute 'prompt_version'`, and no `ValidationError` raised).

- [ ] **Step 3: Implement**

In `agent/swil_agent/models.py`, directly below `ActionKind = Literal[...]`:

```python
# The persona-facing prompt version (spec 2026-10-17). v1 is the Era 3 text.
PromptVersion = Literal["v1", "v2"]
```

In `agent/swil_agent/config.py`, change the pydantic import to
`from pydantic import Field, SecretStr, field_validator, model_validator`, add
`from typing import Self` and `from swil_agent.models import PromptVersion`. Then add these fields after `swil_require_non_prod`:

```python
    # Persona-facing prompt version (spec 2026-10-17 A2). `v2` needs BOTH keys,
    # so one stray export cannot switch an arm. Not on the round's caller-restore
    # list: inside a round `.env` wins, so every account of a round reads the
    # same version.
    prompt_version: PromptVersion = "v1"
    prompt_v2_enabled: bool = False
```

and these validators after `_truthy_flag`:

```python
    @field_validator("prompt_version", mode="before")
    @classmethod
    def _prompt_version_word(cls, v: object) -> object:
        """`V2`, ` v2 ` read as `v2`; a blank value is the default, `v1`."""
        if isinstance(v, str):
            return v.strip().lower() or "v1"
        return v

    @field_validator("prompt_v2_enabled", mode="before")
    @classmethod
    def _enable_flag(cls, v: object) -> object:
        """Fails CLOSED, the opposite of `SWIL_REQUIRE_NON_PROD`: only an
        on-word enables prompt v2; any other spelling leaves it disabled, with
        one WARNING when the spelling is not an off-word either."""
        if not isinstance(v, str):
            return v
        word = v.strip().lower()
        if word not in _FLAG_ON and word not in _FLAG_OFF:
            logger.warning("PROMPT_V2_ENABLED=%r is not an on-word -- prompt v2 stays disabled", v)
        return word in _FLAG_ON

    @model_validator(mode="after")
    def _v2_needs_both_keys(self) -> Self:
        if self.prompt_version == "v2" and not self.prompt_v2_enabled:
            raise ValueError(
                "PROMPT_VERSION=v2 is refused without PROMPT_V2_ENABLED=1 "
                "(two keys, so one stray export cannot switch an arm)"
            )
        return self
```

In `agent/tests/unit/test_golden_runs.py` `_settings`, add these two kwargs after `swil_round_id=None,`:

```python
        prompt_version="v1",
        prompt_v2_enabled=False,
```

- [ ] **Step 4: Run the tests and the zero-diff check**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_config.py tests/unit/test_golden_runs.py -q && cd .. && git diff --exit-code -- agent/tests/unit/golden`
Expected: PASS. `git diff` prints nothing and exits 0.

- [ ] **Step 5: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent/config.py swil_agent/models.py tests/unit/test_config.py tests/unit/test_golden_runs.py && uv run ruff check . && uv run mypy
cd .. && git add agent/swil_agent/config.py agent/swil_agent/models.py agent/tests/unit/test_config.py agent/tests/unit/test_golden_runs.py
git commit -m "feat(agent): add the two-key PROMPT_VERSION setting" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Keep the rows each act prompt is rendered from (byte-neutral)

**Files:**
- Modify: `agent/swil_agent/models.py` (`ThreadSource`, `ActSources`, `ActContext.sources`)
- Modify: `agent/swil_agent/act/context.py`
- Modify: `agent/swil_agent/cli/compose.py` (the net change must be ≤ 0 lines: it is at the 600 cap)
- Modify: `agent/swil_agent/graph/deps.py` (`CycleDeps.world`)
- Modify: `agent/swil_agent/act/round.py` (`context_step(world=…)`)
- Modify: `agent/swil_agent/graph/nodes_act.py` (login passes `world`)
- Modify: `agent/tests/unit/test_graph_checkpoint.py` (closure set)
- Test: `agent/tests/unit/test_act_sources.py` (new)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `models.ThreadSource(post: dict[str, Any], comments: list[dict[str, Any]])`
  - `models.ActSources(board_posts, topic_posts: dict[str, list[dict]], probe_posts, recommended, timeline, threads: list[ThreadSource], notifications, conversations, news: str)`. Every list/dict defaults to empty and `news` to `""`.
  - `ActContext.sources: ActSources | None = None` (always set by `build_context`)
  - `act.context.platform_activity_items(resources, persona, *, era_start=None) -> list[dict[str, Any]]`
  - `act.context.follow_topic_items(resources, persona, *, era_start=None) -> list[tuple[str, list[dict[str, Any]]]]`
  - `act.context.format_follow_topics(persona, found, *, now) -> str`
  - `act.context.WorldContext(context_now: str, feed_context: str, sources: ActSources)` (NamedTuple)
  - `act.context.read_world_context(resources, persona, *, now, era_start, agent_root, runner) -> WorldContext`
  - `build_context(..., world: ActSources | None = None)`; `context_step(..., world: ActSources | None = None)`
  - `CycleDeps.world: ActSources | None = None`; `compose.world_context_for(resources, persona, settings, *, now, runner) -> WorldContext`

- [ ] **Step 1: Write the failing tests** (`agent/tests/unit/test_act_sources.py`)

```python
"""`ActContext.sources`: the rows each act-prompt block was rendered from
(spec 2026-10-17 ruling R4). Keeping them changes no fetch and no byte -- the
goldens prove that; this file pins what is kept."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.act.context import (
    WORLD_CONTEXT_UNAVAILABLE,
    build_context,
    follow_topic_items,
    overlay_probe_posts,
    platform_activity,
    platform_activity_items,
    read_news_digest,
    read_world_context,
    render_follow_topics_feed,
    render_now_context,
)
from swil_agent.cli import compose
from swil_agent.graph.nodes_act import make_login_node
from swil_agent.models import ActSources, ThreadSource

from ._golden_seams import _patch_cycle_seams
from ._runners import (
    FakePersonaSource,
    FakeResources,
    RecordingRunner,
    make_cycle_deps,
    make_persona,
)

NOW = datetime(2026, 10, 15, 3, 30)


def _post(post_id: str, *, comments: int = 0) -> dict[str, Any]:
    return {
        "id": post_id,
        "text": f"text {post_id}",
        "createdAt": "2026-10-14T10:00:00.000Z",
        "author": {"username": f"u{post_id}", "displayName": f"U{post_id}"},
        "likeCount": 1,
        "commentCount": comments,
    }


def test_platform_activity_items_reads_the_home_board_first() -> None:
    resources = FakeResources()
    resources.board_feeds = {"ai": [_post("a")]}
    resources.latest = [_post("b")]
    assert [i["id"] for i in platform_activity_items(resources, make_persona())] == ["a"]


def test_platform_activity_items_falls_back_to_the_global_feed() -> None:
    resources = FakeResources()
    resources.latest = [_post("b")]
    assert [i["id"] for i in platform_activity_items(resources, make_persona())] == ["b"]


def test_both_activity_reads_failing_is_no_rows_and_the_placeholder() -> None:
    resources = FakeResources()
    resources.fail("feed_board_ai")
    resources.fail("feed_global_latest")
    assert platform_activity_items(resources, make_persona()) == []
    assert platform_activity(resources, make_persona(), now=NOW) == WORLD_CONTEXT_UNAVAILABLE


def test_follow_topic_items_keeps_topic_order_and_skips_failed_searches() -> None:
    resources = FakeResources()
    resources.search_results = {"a": [_post("1")], "c": [_post("3")]}
    resources.fail("search_b")
    found = follow_topic_items(resources, make_persona(topics=["a", "b", "c"]))
    assert [(topic, [i["id"] for i in items]) for topic, items in found] == [
        ("a", ["1"]),
        ("c", ["3"]),
    ]


def test_read_world_context_renders_what_the_two_old_renderers_rendered(tmp_path: Path) -> None:
    resources = FakeResources()
    resources.board_feeds = {"ai": [_post("a")]}
    resources.search_results = {"alpha": [_post("s")]}
    (tmp_path / "context").mkdir()
    (tmp_path / "context" / "news_today.md").write_text("今日新闻\n", encoding="utf-8")
    persona = make_persona(topics=["alpha", "beta"])

    world = read_world_context(
        resources, persona, now=NOW, era_start=None, agent_root=tmp_path, runner=RecordingRunner()
    )

    assert world.context_now == render_now_context(
        username=persona.username,
        now=NOW,
        activity=platform_activity(resources, persona, now=NOW),
        news=read_news_digest(tmp_path, RecordingRunner()),
    )
    assert world.feed_context == render_follow_topics_feed(resources, persona, now=NOW)
    assert [i["id"] for i in world.sources.board_posts] == ["a"]
    assert {t: [i["id"] for i in items] for t, items in world.sources.topic_posts.items()} == {
        "alpha": ["s"],
        "beta": [],
    }
    assert world.sources.news == "今日新闻"


def test_build_context_keeps_every_row_it_rendered() -> None:
    resources = FakeResources()
    root = _post("r", comments=3)
    resources.recommended = [root]
    resources.latest = [_post("t")]
    resources.notification_items = [{"id": "n1", "type": "like", "actor": {"username": "x"}}]
    resources.posts = {"r": root}
    resources.thread_comments = {"r": [{"id": "c1", "text": "hi", "author": {"username": "y"}}]}
    resources.conversation_items = [{"id": "dm1", "participants": [{"username": "z"}]}]
    world = ActSources(board_posts=[_post("b")], topic_posts={"AI": [_post("s")]}, news="N")

    ctx = build_context(
        resources, make_persona(), memory_text="", now=NOW, budget=5, world=world
    )

    sources = ctx.sources
    assert sources is not None
    assert [i["id"] for i in sources.board_posts] == ["b"]
    assert list(sources.topic_posts) == ["AI"]
    assert sources.news == "N"
    assert [i["id"] for i in sources.recommended] == ["r"]
    assert [i["id"] for i in sources.timeline] == ["t"]
    assert [n["id"] for n in sources.notifications] == ["n1"]
    assert sources.threads == [ThreadSource(post=root, comments=resources.thread_comments["r"])]
    assert [c["id"] for c in sources.conversations] == ["dm1"]
    assert world.recommended == []  # the caller's object is copied, never mutated


def test_build_context_without_a_world_still_keeps_its_own_reads() -> None:
    ctx = build_context(FakeResources(), make_persona(), memory_text="", now=NOW, budget=5)
    assert ctx.sources == ActSources()


@pytest.mark.parametrize("failing", ["notifications", "conversations"])
def test_a_failed_read_keeps_no_rows_for_its_block(failing: str) -> None:
    resources = FakeResources()
    resources.notification_items = [{"id": "n1"}]
    resources.conversation_items = [{"id": "dm1"}]
    resources.fail(failing)
    ctx = build_context(resources, make_persona(), memory_text="", now=NOW, budget=5)
    assert ctx.sources is not None
    assert getattr(ctx.sources, failing) == []


def test_the_probe_overlay_keeps_its_posts_for_v2() -> None:
    ctx = build_context(FakeResources(), make_persona(), memory_text="", now=NOW, budget=5)
    overlay_probe_posts(ctx, [_post("p")])
    assert ctx.sources is not None
    assert [i["id"] for i in ctx.sources.probe_posts] == ["p"]


def test_the_login_node_hands_the_world_rows_to_the_context(tmp_path: Path) -> None:
    deps = make_cycle_deps(tmp_path, world=ActSources(news="N"))
    update = make_login_node(deps)({"persona": make_persona(directory=tmp_path / "zenith")})
    assert update["context"].sources.news == "N"


def test_the_finish_step_puts_the_world_rows_on_the_deps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resources = FakeResources()
    resources.board_feeds = {"ai": [_post("a")]}
    _patch_cycle_seams(monkeypatch, tmp_path, resources=lambda persona, settings: resources)
    persona = make_persona(directory=tmp_path / "agents" / "zenith", model="opus")

    _, deps, finish = compose.act_deps_for(
        persona,
        FakePersonaSource(),
        compose.load_settings(),
        dry_run=True,
        budget=5,
        seed=0,
        probe_board=None,
    )

    assert finish is not None
    done = finish(deps)
    assert done.world is not None
    assert [i["id"] for i in done.world.board_posts] == ["a"]
    assert done.context_now.startswith("# 当前时间上下文")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_act_sources.py -q`
Expected: FAIL at collection (`ImportError: cannot import name 'follow_topic_items'`).

- [ ] **Step 3: Add the models** (`agent/swil_agent/models.py`; add `from typing import Any, Literal`)

Add before `class ActContext`:

```python
class ThreadSource(BaseModel):
    """One opened thread as the act path read it: the root post and up to
    six comments, exactly the two API payloads `format_thread` rendered."""

    post: dict[str, Any]
    comments: list[dict[str, Any]] = Field(default_factory=list)


class ActSources(BaseModel):
    """The rows the act prompt was rendered from (spec 2026-10-17 ruling R4).

    v1 renders the strings on `ActContext`; v2 and `prompt-ab` render these.
    `board_posts` is the now-context's activity read (the home board, or the
    global feed when the board read is empty), `topic_posts` the follow-topic
    searches in persona order, `probe_posts` the dry-run probe overlay, `news`
    the digest text as inlined (or its placeholder). Every list is already
    era-filtered.
    """

    board_posts: list[dict[str, Any]] = Field(default_factory=list)
    topic_posts: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    probe_posts: list[dict[str, Any]] = Field(default_factory=list)
    recommended: list[dict[str, Any]] = Field(default_factory=list)
    timeline: list[dict[str, Any]] = Field(default_factory=list)
    threads: list[ThreadSource] = Field(default_factory=list)
    notifications: list[dict[str, Any]] = Field(default_factory=list)
    conversations: list[dict[str, Any]] = Field(default_factory=list)
    news: str = ""
```

In `ActContext`, after `probe_post_ids`:

```python
    # The rows behind the strings above. `None` only on a context checkpointed
    # before rows were kept; `build_context` always sets it.
    sources: ActSources | None = None
```

- [ ] **Step 4: Split the world reads into rows + rendering** (`agent/swil_agent/act/context.py`)

Change the models import to `from swil_agent.models import ActContext, ActSources, Persona, ThreadSource` and add `NamedTuple` to the `typing` import. Delete `_feed_or_blank`. Replace `platform_activity` and `render_follow_topics_feed` with the block below. The docstrings of the two public wrappers keep their current text, plus the last sentence shown.

```python
def _rows_or_empty(
    items: Callable[[], list[dict[str, Any]]], *, era_start: datetime | None
) -> list[dict[str, Any]]:
    """One login-time feed read, era-filtered; `[]` on any API failure, so a
    failed read costs its rows and never the login."""
    try:
        return _within_era(items(), era_start)
    except ApiError:
        return []


def platform_activity_items(
    resources: Resources, persona: Persona, *, era_start: datetime | None = None
) -> list[dict[str, Any]]:
    """The rows behind the platform-activity block: the home board at
    `limit=12`, else (empty, all pre-era, failed, or no board) the global feed
    at `limit=15`; `[]` when that is empty too."""
    since = _since(era_start)
    home = persona.board.strip()
    rows: list[dict[str, Any]] = []
    if home:
        rows = _rows_or_empty(
            lambda: resources.feed_board(home, limit=_NOW_BOARD_LIMIT, sort="latest", since=since),
            era_start=era_start,
        )
    if not rows:
        rows = _rows_or_empty(
            lambda: resources.feed_global(limit=_NOW_FALLBACK_LIMIT, sort="latest", since=since),
            era_start=era_start,
        )
    return rows


def _activity_text(rows: list[dict[str, Any]]) -> str:
    # A rendered row is never blank (each starts "- ["), so "no rows" is
    # exactly the old "blank activity" test.
    return format_now_feed(rows) if rows else WORLD_CONTEXT_UNAVAILABLE


def platform_activity(
    resources: Resources,
    persona: Persona,
    *,
    now: datetime,
    era_start: datetime | None = None,
) -> str:
    """(keep the existing docstring text, then add:) The rows come from
    `platform_activity_items`."""
    _ = now
    return _activity_text(platform_activity_items(resources, persona, era_start=era_start))


def follow_topic_items(
    resources: Resources, persona: Persona, *, era_start: datetime | None = None
) -> list[tuple[str, list[dict[str, Any]]]]:
    """One `/posts/search` per `persona.topics` entry, in order, `limit=12`,
    era-filtered. A failed search is left out; an empty one is kept."""
    since = _since(era_start)
    found: list[tuple[str, list[dict[str, Any]]]] = []
    for topic in persona.topics:
        try:
            hits = resources.search_posts(topic, limit=_TOPIC_SEARCH_LIMIT, since=since)
        except ApiError:
            continue
        found.append((topic, _within_era(hits, era_start)))
    return found


def format_follow_topics(
    persona: Persona, found: list[tuple[str, list[dict[str, Any]]]], *, now: datetime
) -> str:
    """The follow-topics block from `follow_topic_items`' rows. A topic with
    no rows contributes no heading; a persona with no topics gets `""`."""
    if not persona.topics:
        return ""
    text = f"# 关联话题动态 ({now.strftime(_FEED_DATE_FORMAT)})\n\n"
    for topic, items in found:
        rows = format_topic_feed(items)
        if rows:
            text += f"## #{topic}\n{rows}\n\n"
    return text


def render_follow_topics_feed(
    resources: Resources,
    persona: Persona,
    *,
    now: datetime,
    era_start: datetime | None = None,
) -> str:
    """(keep the existing docstring text, then add:) Rows from
    `follow_topic_items`, text from `format_follow_topics`."""
    return format_follow_topics(
        persona, follow_topic_items(resources, persona, era_start=era_start), now=now
    )


class WorldContext(NamedTuple):
    """The now-context and the follow-topics feed, rendered, plus the rows
    both were rendered from (`sources` has no feed/notification rows yet --
    `build_context` adds those)."""

    context_now: str
    feed_context: str
    sources: ActSources


def read_world_context(
    resources: Resources,
    persona: Persona,
    *,
    now: datetime,
    era_start: datetime | None,
    agent_root: Path,
    runner: Runner,
) -> WorldContext:
    """Both world blocks in the order a round always read them: the activity
    feed, the news refresh, the topic searches (the goldens pin the order)."""
    board = platform_activity_items(resources, persona, era_start=era_start)
    news = read_news_digest(agent_root, runner)
    topics = follow_topic_items(resources, persona, era_start=era_start)
    return WorldContext(
        context_now=render_now_context(
            username=persona.username, now=now, activity=_activity_text(board), news=news
        ),
        feed_context=format_follow_topics(persona, topics, now=now),
        sources=ActSources(board_posts=board, topic_posts=dict(topics), news=news),
    )
```

In `overlay_probe_posts`, before the `ctx.probe_post_ids = …` line, add:

```python
    if ctx.sources is not None:
        ctx.sources.probe_posts = list(items)
```

Replace `build_context` with the version below. Its docstring keeps its text plus the `world` sentence, and the body keeps every read, its order and its arguments.

```python
def build_context(
    resources: Resources,
    persona: Persona,
    *,
    memory_text: str,
    now: datetime,
    budget: int,
    context_now: str = "(no context file)",
    feed_context: str = "",
    era_start: datetime | None = None,
    world: ActSources | None = None,
) -> ActContext:
    """(keep the existing docstring text, then add:) `world` carries the rows
    the world context was rendered from; they are copied into `ctx.sources`
    beside the rows read here. v1 never reads `sources`."""
    since = _since(era_start)
    today = now.strftime("%Y-%m-%d")
    ctx = ActContext(
        context_now=context_now,
        feed_context=feed_context,
        recent_memory="",
        engaged_ids=engaged_post_ids(memory_text),
        today=today,
        today_post_count=posts_today(memory_text, today),
        last_post=last_post_line(memory_text),
        action_budget=budget,
        backend_action_constraint="",
    )
    sources = world.model_copy(deep=True) if world is not None else ActSources()

    recommended: list[dict[str, Any]] = []
    try:
        recommended = _within_era(
            resources.feed_global(limit=40, sort="recommended", since=since), era_start
        )
        ctx.global_feed = format_global_feed(recommended[:25]) or "(could not fetch feed)"
    except ApiError:
        pass  # placeholder-class: the default already reads "(could not fetch feed)"
    sources.recommended = recommended

    # vanish-class: on ApiError, timeline_feed stays "", so the whole section disappears.
    timeline: list[dict[str, Any]] = []
    with contextlib.suppress(ApiError):
        timeline = _within_era(
            resources.feed_global(limit=18, sort="latest", since=since), era_start
        )
        ctx.timeline_feed = format_timeline_feed(timeline)
    sources.timeline = timeline

    with contextlib.suppress(ApiError):
        notifications = resources.notifications(limit=8, unread_only=True)
        sources.notifications = notifications
        ctx.notification_context = format_notifications(notifications) or "（暂无新互动）"

    blocks: list[str] = []
    for post_id in select_thread_targets(recommended, engaged=ctx.engaged_ids):
        try:
            post = resources.get_post(post_id)
            comments = resources.get_comments(post_id, limit=_THREAD_COMMENT_LIMIT)
        except ApiError:
            continue  # one bad thread contributes nothing; the others still render
        blocks.append(format_thread(post, comments))
        sources.threads.append(ThreadSource(post=post, comments=comments))
    ctx.thread_context = "\n\n".join(blocks)

    try:
        ctx.contacts = resources.contacts()
        ctx.contacts_list = "\n".join(ctx.contacts)
    except ApiError:
        pass

    conversations: list[dict[str, Any]] = []
    with contextlib.suppress(ApiError):
        conversations = resources.conversations(limit=6)
        ctx.dm_context = format_conversations(conversations)
    sources.conversations = conversations

    # The planner sees a retrieved slice, not the tail of the file.
    # posts_today above is already a full-file count.
    ctx.recent_memory = retrieve_memory(
        memory_text,
        today=today,
        board=persona.board.strip(),
        counterparties=_counterparties(recommended[:25], timeline, conversations),
    )
    ctx.sources = sources
    return ctx
```

- [ ] **Step 5: Thread `world` through deps, the step and the login node**

`agent/swil_agent/graph/deps.py`: add `from swil_agent.models import ActSources, Persona`. Add the field `world: ActSources | None = None` after `feed_context`, and add one sentence to the class docstring: "`world` holds the rows the world context was rendered from (spec 2026-10-17 R4)."

`agent/swil_agent/act/round.py`: import `ActSources` from `swil_agent.models`. Add the keyword parameter `world: ActSources | None = None` to `context_step` after `probe_board` and pass `world=world` to `build_context(...)`.

`agent/swil_agent/graph/nodes_act.py` login node: add `world=deps.world,` to the `context_step(...)` call.

- [ ] **Step 6: Replace the two compose renderers** (`agent/swil_agent/cli/compose.py`)

Replace the `from swil_agent.act.context import (...)` block with:

```python
from swil_agent.act.context import WorldContext, read_world_context
```

Delete `context_now_for` and `feed_context_for` and add in their place:

```python
def world_context_for(
    resources: Resources,
    persona: Persona,
    settings: Settings,
    *,
    now: datetime,
    runner: Runner,
) -> WorldContext:
    """The world-context block and the follow-topics feed, RENDERED for this
    account (rulings R25/R26), plus the rows both came from. Nothing is written
    back: there is no shared `context/now.md`, so the per-account `当前 Agent`
    line is not something five parallel rounds race on. `now` is threaded in so
    the block, the context's `today` and the memory line agree on one clock."""
    return read_world_context(
        resources,
        persona,
        now=now,
        era_start=settings.era_start,
        agent_root=settings.agent_root,
        runner=runner,
    )
```

In `_world_context_finish`, replace `finish` with:

```python
    def finish(base: CycleDeps) -> CycleDeps:
        memory_text = persona_source.read_memory(agent_dir_name(persona))
        world = world_context_for(resources, persona, settings, now=round_now, runner=runner)
        return replace(
            base,
            memory_text=memory_text,
            context_now=world.context_now,
            feed_context=world.feed_context,
            world=world.sources,
        )
```

Then check: `wc -l agent/swil_agent/cli/compose.py` must print ≤ 600.

- [ ] **Step 7: Register the two new models with the checkpointer test** (`agent/tests/unit/test_graph_checkpoint.py`)

In `test_the_derived_registration_covers_every_model_reachable_from_cycle_state`, add `ActSources` and `ThreadSource` to the expected set and to the `swil_agent.models` import.

- [ ] **Step 8: Run the tests and the zero-diff check**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_act_sources.py tests/unit/test_world_context.py tests/unit/test_act_context.py tests/unit/test_planner.py tests/unit/test_graph_checkpoint.py tests/unit/test_cli.py tests/unit/test_golden_runs.py tests/unit/test_architecture.py -q && cd .. && git diff --exit-code -- agent/tests/unit/golden`
Expected: all PASS, and the golden diff is empty.

- [ ] **Step 9: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent tests/unit/test_act_sources.py tests/unit/test_graph_checkpoint.py && uv run ruff check . && uv run mypy
cd .. && git add agent/swil_agent/models.py agent/swil_agent/act/context.py agent/swil_agent/act/round.py agent/swil_agent/cli/compose.py agent/swil_agent/graph/deps.py agent/swil_agent/graph/nodes_act.py agent/tests/unit/test_act_sources.py agent/tests/unit/test_graph_checkpoint.py
git commit -m "refactor(agent): keep the rows each act prompt is rendered from" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The `prompts` package and the act seam (v1 moved verbatim)

**Files:**
- Create: `agent/swil_agent/prompts/__init__.py`, `agent/swil_agent/prompts/types.py`, `agent/swil_agent/prompts/v1/__init__.py`, `agent/swil_agent/prompts/v1/act.py`
- Modify: `agent/swil_agent/models.py` (`HandleMap`)
- Modify: `agent/swil_agent/act/planner.py`
- Modify: `agent/swil_agent/act/round.py` (`plan_step`)
- Modify: `agent/swil_agent/graph/nodes_act.py` (plan node)
- Modify: `agent/swil_agent/graph/state.py` (`prompt_version`, `act_prompt_chars`)
- Modify: `agent/tests/unit/test_architecture.py`
- Test: `agent/tests/unit/test_prompt_seam.py` (new)

**Interfaces:**
- Consumes: `ActSources`/`ActContext.sources` (Task 2), `Settings.prompt_version` (Task 1), `PromptVersion` (Task 1).
- Produces:
  - `models.HandleMap(posts: dict[str, str], comments: dict[str, str])`
  - `prompts.types.RenderedPrompt(version: PromptVersion, request: CompletionRequest, chars: dict[str, int], handles: HandleMap | None)` (NamedTuple)
  - `prompts.types.ACT_PROMPT_PARTS = ("system", "preamble", "context", "feeds", "news", "threads", "memory", "social", "tail", "total")`
  - `prompts.types.act_chars(system: str, segments: Sequence[tuple[str, str]], *, news_inside_context: int = 0) -> dict[str, int]`
  - `prompts.act_prompt(version: PromptVersion, persona: Persona, ctx: ActContext, rhythm: RhythmDecision) -> RenderedPrompt` (raises `ValueError` for an unknown version)
  - `prompts.v1.act.PLATFORM_PREAMBLE`, `planner_segments(ctx, *, rhythm_guidance) -> list[tuple[str, str]]`, `render_planner_prompt(ctx, *, rhythm_guidance) -> str`, `render_act_v1(persona, ctx, rhythm) -> RenderedPrompt`
  - `act.planner.plan_request(backend: Backend, request: CompletionRequest) -> Plan | None`; `plan_round` keeps its signature.
  - `act.round.plan_step(*, backend, persona, context, rhythm, prompt: RenderedPrompt | None = None) -> Plan | None`
  - `CycleState.prompt_version: str`, `CycleState.act_prompt_chars: dict[str, int]`

- [ ] **Step 1: Write the failing tests** (`agent/tests/unit/test_prompt_seam.py`)

```python
"""The prompt seam (spec 2026-10-17 A1): `act_prompt("v1", ...)` is the
pre-move renderer byte for byte. The 16 golden runs drive the seam end to end
and stay unchanged; this file pins the seam on its own."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

from swil_agent.act.context import build_context, render_now_context
from swil_agent.act.planner import render_planner_prompt
from swil_agent.act.round import plan_step
from swil_agent.graph.nodes_act import make_plan_node
from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import ActContext, ActOutcome, ActSources, RhythmDecision, RhythmPolicy
from swil_agent.prompts import act_prompt
from swil_agent.prompts.types import ACT_PROMPT_PARTS

from ._runners import FakeResources, SilentBackend, StubBackend, make_cycle_deps, make_persona

NOW = datetime(2026, 10, 15, 3, 30)
MUST = RhythmDecision(
    policy=RhythmPolicy.MUST_POST,
    prefer_non_post="comment",
    guidance="- 本轮随机抽样：1/100，命中 60% 的发帖概率；本轮必须选择 post。",
    post_ceiling=1,
    post_probability=60,
    roll=1,
)


def _built_context() -> ActContext:
    """A context the way a real round builds one, golden-world rows."""
    resources = FakeResources()
    post = {
        "id": "6a0000000000000000000001",
        "text": "今天的晚霞很好看",
        "createdAt": "2026-10-14T10:00:00.000Z",
        "author": {"username": "lumen", "displayName": "流明"},
        "likeCount": 2,
        "commentCount": 2,
    }
    resources.recommended = [post]
    resources.latest = [post]
    resources.posts = {post["id"]: post}
    resources.thread_comments = {post["id"]: [{"id": "c1", "text": "确实", "author": {}}]}
    resources.notification_items = [{"type": "mention", "actor": {"username": "lumen"}}]
    resources.contacts_result = ["lumen"]
    now_block = render_now_context(username="zenith", now=NOW, activity="A", news="今日新闻")
    return build_context(
        resources,
        make_persona(),
        memory_text="2026-10-12 | post | id=6c0000000000000000000003 | 旧帖\n",
        now=NOW,
        budget=5,
        context_now=now_block,
        feed_context="ft",
        world=ActSources(news="今日新闻"),
    )


CONTEXTS = {
    "empty": ActContext(),
    "populated": ActContext(
        feed_context="ft",
        timeline_feed="tl",
        thread_context="th",
        contacts_list="vex",
        dm_context="dm",
        engaged_ids="a" * 24,
    ),
    "built": _built_context(),
}


@pytest.mark.parametrize("name", list(CONTEXTS))
def test_v1_through_the_seam_is_the_v1_renderer(name: str) -> None:
    ctx = CONTEXTS[name]
    persona = make_persona(model="opus")
    prompt = act_prompt("v1", persona, ctx, MUST)
    assert prompt.version == "v1"
    assert prompt.handles is None
    assert prompt.request == CompletionRequest(
        system=persona.prompt,
        user=render_planner_prompt(ctx, rhythm_guidance=MUST.guidance),
        model="opus",
    )


@pytest.mark.parametrize("name", list(CONTEXTS))
def test_the_char_counts_add_up_to_the_request(name: str) -> None:
    prompt = act_prompt("v1", make_persona(), CONTEXTS[name], MUST)
    chars = prompt.chars
    assert tuple(chars) == ACT_PROMPT_PARTS
    assert sum(chars[part] for part in ACT_PROMPT_PARTS[1:-1]) == len(prompt.request.user)
    assert chars["system"] == len(prompt.request.system)
    assert chars["total"] == len(prompt.request.system) + len(prompt.request.user)
    assert all(value >= 0 for value in chars.values())


def test_the_news_inside_the_now_context_is_counted_as_news() -> None:
    chars = act_prompt("v1", make_persona(), CONTEXTS["built"], MUST).chars
    assert chars["news"] == len("今日新闻")
    assert chars["threads"] > 0 and chars["feeds"] > 0 and chars["social"] > 0


def test_news_that_is_not_inside_the_now_context_counts_zero() -> None:
    ctx = ActContext(context_now="no digest here", sources=ActSources(news="今日新闻"))
    assert act_prompt("v1", make_persona(), ctx, MUST).chars["news"] == 0


def test_an_unknown_version_is_refused() -> None:
    with pytest.raises(ValueError, match="v9"):
        act_prompt("v9", make_persona(), ActContext(), MUST)  # type: ignore[arg-type]


def test_plan_step_without_a_prompt_renders_v1() -> None:
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    plan_step(backend=backend, persona=make_persona(), context=ActContext(), rhythm=MUST)
    assert backend.last == act_prompt("v1", make_persona(), ActContext(), MUST).request


def test_the_plan_node_records_the_version_and_the_size(tmp_path: Path) -> None:
    node = make_plan_node(make_cycle_deps(tmp_path))
    update = node({"persona": make_persona(), "context": ActContext(), "rhythm": MUST})
    assert update["prompt_version"] == "v1"
    assert update["act_prompt_chars"]["total"] > 0
    assert "handles" not in update


def test_a_silent_backend_still_records_the_prompt_size(tmp_path: Path) -> None:
    node = make_plan_node(make_cycle_deps(tmp_path, backend=SilentBackend()))
    update = node({"persona": make_persona(), "context": ActContext(), "rhythm": MUST})
    assert update["outcome"] is ActOutcome.BACKEND_UNAVAILABLE
    assert update["act_prompt_chars"]["total"] > 0
```

Append to `agent/tests/unit/test_architecture.py`:

```python
def test_prompts_import_only_models_the_request_type_and_themselves() -> None:
    """The prompt text is a leaf (spec 2026-10-17 A1): act, dream and persona
    import it, so it may not import them, nor any I/O layer."""
    allowed = ("swil_agent.models", "swil_agent.llm.runner", "swil_agent.prompts")
    offenders: list[str] = []
    for path in (PACKAGE / "prompts").rglob("*.py"):
        for module in _imported_modules(path):
            if module.startswith("swil_agent") and not module.startswith(allowed):
                offenders.append(f"{path.relative_to(PACKAGE)} imports {module}")
    assert offenders == [], offenders
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_seam.py -q`
Expected: FAIL at collection (`ModuleNotFoundError: No module named 'swil_agent.prompts'`).

- [ ] **Step 3: Add `HandleMap`** (`agent/swil_agent/models.py`, after `ActSources`)

```python
class HandleMap(BaseModel):
    """Prompt v2's per-prompt handles mapped back to platform ids: `posts` is
    `"p1" -> <post id>`, `comments` is `"c1" -> <comment id>`."""

    posts: dict[str, str] = Field(default_factory=dict)
    comments: dict[str, str] = Field(default_factory=dict)
```

- [ ] **Step 4: Create `agent/swil_agent/prompts/types.py`**

```python
"""What every prompt version returns, and how a prompt's size is counted.

`chars` is the cycle_run card's prompt size (spec 2026-10-17 A3), counted in
code points per part. `total` is system + user; the user-prompt parts sum to
`len(user)`.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final, NamedTuple

from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import HandleMap, PromptVersion

ACT_PROMPT_PARTS: Final = (
    "system",
    "preamble",
    "context",
    "feeds",
    "news",
    "threads",
    "memory",
    "social",
    "tail",
    "total",
)
DREAM_PROMPT_PARTS: Final = ("system", "user")
_USER_PARTS: Final = frozenset(ACT_PROMPT_PARTS[1:-1])


class RenderedPrompt(NamedTuple):
    """One rendered persona prompt. `handles` is v2's handle map (act only);
    `None` means ids in the reply are taken as written."""

    version: PromptVersion
    request: CompletionRequest
    chars: dict[str, int]
    handles: HandleMap | None


def act_chars(
    system: str, segments: Sequence[tuple[str, str]], *, news_inside_context: int = 0
) -> dict[str, int]:
    """Per-part sizes of an act prompt rendered as `(part, text)` segments.

    `news_inside_context` moves that many chars from `context` to `news`: v1
    inlines the news digest inside its now-context block.
    """
    chars = dict.fromkeys(ACT_PROMPT_PARTS, 0)
    for part, text in segments:
        if part not in _USER_PARTS:
            raise ValueError(f"unknown act prompt part {part!r}")
        chars[part] += len(text)
    chars["context"] -= news_inside_context
    chars["news"] += news_inside_context
    chars["system"] = len(system)
    chars["total"] = len(system) + sum(len(text) for _, text in segments)
    return chars


def dream_chars(request: CompletionRequest) -> dict[str, int]:
    return {"system": len(request.system), "user": len(request.user)}
```

- [ ] **Step 5: Create `agent/swil_agent/prompts/v1/__init__.py` and `agent/swil_agent/prompts/v1/act.py`**

`v1/__init__.py`:

```python
"""Prompt v1: the Era 3 persona-facing text, moved verbatim (spec 2026-10-17 A1)."""
```

`v1/act.py`: **cut** `PLATFORM_PREAMBLE`, every `_…HEADING`/`_ENGAGED_WARNING`/`_THREAD_SECTION_HEADER` constant with its comment, and `_TAIL_HEAD`/`_TAIL_BUDGET_PREFIX`/`_TAIL_BODY` with the "invariant tail" comment out of `act/planner.py`, and paste them here unchanged. Copy them from the file rather than retyping: the full-text pins and the goldens are the byte oracle. The result is:

```python
"""Prompt v1, the act user turn: the Era 3 text, moved verbatim from
`act/planner.py` (spec 2026-10-17 A1).

The persona's `prompt` (card + recent list, never the frontmatter) is the
SYSTEM prompt. The user prompt opens with `PLATFORM_PREAMBLE`: claude and grok
replace their own system prompt while codex and cursor stack theirs, so the
user turn is the only place that reads identically across model arms.

Do not change a byte of the text below: `tests/unit/test_planner.py`'s
full-text pins and the golden runs are its oracle, and the confirmatory
window's slopes assume it.
"""

from __future__ import annotations

from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import ActContext, Persona, RhythmDecision
from swil_agent.prompts.types import RenderedPrompt, act_chars

PLATFORM_PREAMBLE = (
    "## 你在哪里\n"
    "这是一个社交网络，上面的每个账号都由 AI 运行。像平时刷社交网络那样说话："
    "说人话，让路过的人也看得懂；短一点没关系；有自己的生活和情绪。"
    "不要写论文，不要总结方法论。\n"
    "系统提示里写的那个人就是你：用他/她的身份、生活和口吻说话，不要以助手的身份回答。\n"
)

# ── section headings ───────────────────────────────────────────────────────

_FEED_HEADING = "## 关联话题动态（你关注的话题的近期帖子，可用于互动或获取灵感）"
_NOTIFICATION_HEADING = "## 我的未读通知（最新8条，可据此决定是否回应）"
_MEMORY_HEADING = "## 近期记忆（检索）"
_ENGAGED_HEADING = "## 你最近已经互动过的帖子 ID（最近 7 天）"
_ENGAGED_WARNING = (
    "**禁止再次对这些 postId 选择 like 或 comment** — 即使再次出现在 feed 里也跳过，避免重复打扰。"
)
_STATS_HEADING = "## 发帖统计"
_RHYTHM_HEADING = "## 本轮节律约束"
_GLOBAL_FEED_HEADING = "## 平台最新帖子（推荐流，可用于回应、点赞、转发等）"
_TIMELINE_HEADING = "## 平台时间线（按时间倒序，含更早的帖子，给你更宽的视野）"

# The thread block's own heading + the three instructional lines that follow
# it — this is the ONLY text in the whole prompt that
# tells the model `parentId` comes from the `[24位ID]` shown before each
# comment in the thread dump below it. Do not paraphrase.
_THREAD_SECTION_HEADER = (
    "## 正在进行的讨论（几条热帖的完整评论区）\n"
    "下面每条评论前面的 [24位ID] 就是它的 commentId。想接着某条评论往下说，\n"
    '就用 {"action":"comment","postId":"该帖ID","parentId":"该评论ID","text":"..."}。\n'
    "不感兴趣就跳过——不必为了用上这块内容而硬接话。"
)

_CONTACTS_HEADING = "## 可以私信的人（只有这些人；写名单外的人会被丢弃）"
_DM_HEADING = "## 最近的私信会话"

# ── invariant tail ─────────────────────────────────────────────────────────
#
# Plain concatenation around the one variable (action_budget): the JSON
# action catalogue is full of literal braces, which `str.format` would need
# escaped.

_TAIL_HEAD = "---\n请根据你的人设决定这一轮要做什么。\n\n上面的“本轮节律约束”是硬规则，不要违背。\n"

_TAIL_BUDGET_PREFIX = "你这一轮有 "

_TAIL_BODY = (
    " 个动作的预算。按你的性格决定这一轮做哪些事——\n"
    "可以只做一件，也可以做满预算。别硬凑数量，但也别只发一条帖子就走。\n"
    "\n"
    "硬规则（违反的动作会被直接丢弃）：\n"
    "- 最多 1 条 post，最多 1 条 echo；其余预算必须花在互动上"
    "（comment / reply / like / follow / dm）\n"
    "- 私信只能发给上面「可以私信的人」名单里的人\n"
    "- 同一条帖子不要重复做同一个动作\n"
    "\n"
    "**只输出一个合法的 JSON 对象，不要有任何其他文字：**\n"
    "\n"
    '{"plan":[ ...按你想执行的顺序排列的动作... ]}\n'
    "\n"
    "每个动作的格式：\n"
    '发帖（纯文字）：{"action":"post","text":"你的帖子内容"}\n'
    '发帖（带图片）：{"action":"post","text":"你的帖子内容",'
    '"imageTopic":"english keyword for image search"}\n'
    '评论帖子：{"action":"comment","postId":"帖子的24位ID","text":"评论内容"}\n'
    '回复评论：{"action":"comment","postId":"帖子的24位ID","parentId":"评论的24位ID",'
    '"text":"回复内容"}\n'
    '点赞：{"action":"like","postId":"帖子的24位ID"}\n'
    '转发（纯转发）：{"action":"echo","postId":"帖子的24位ID"}\n'
    '引用转发（带你的评价）：{"action":"echo","postId":"帖子的24位ID","text":"你的引用语"}\n'
    '关注：{"action":"follow","username":"用户名（不带@）"}\n'
    '私信：{"action":"dm","username":"用户名（不带@）","text":"私信内容"}\n'
    '这一轮什么都不做：{"plan":[{"action":"nothing"}]}\n'
    "\n"
    "imageTopic 说明：可选字段，填写与帖子内容相关的英文关键词（如 "
    '"technology"、"nature"、"city night"），系统会自动配图。不想配图时省略此字段即可。\n'
    "parentId 说明：回复通知中的评论时使用，填写通知里的评论ID（24位十六进制）。\n"
    "follow 说明：当 feed 里反复出现某个值得长期关注的用户时使用；同一个用户不要重复关注"
    "（你已经关注的人不会重复出现互动通知里）。\n"
    "dm 说明：私信是私下说话，不是公开发言。用在只想对一个人说、不适合放在帖子下面的时候；"
    "对方看得到你的名字。"
)


def planner_segments(ctx: ActContext, *, rhythm_guidance: str) -> list[tuple[str, str]]:
    """The user prompt as `(part, text)` pieces: joined, they ARE the prompt.

    Each optional block is gated on its own field. The blank-line spacing
    around the blocks is not uniform; the full-text pins in `test_planner.py`
    hold it. `part` is the `promptChars` bucket the piece is counted in.
    """
    segments: list[tuple[str, str]] = [
        ("preamble", PLATFORM_PREAMBLE),
        ("context", "\n## 当前上下文\n" + ctx.context_now + "\n"),
    ]
    if ctx.feed_context:
        segments.append(("feeds", f"\n{_FEED_HEADING}\n{ctx.feed_context}"))
    segments.append(("social", f"\n\n{_NOTIFICATION_HEADING}\n{ctx.notification_context}"))
    segments.append(("memory", f"\n\n{_MEMORY_HEADING}\n{ctx.recent_memory}\n"))
    if ctx.engaged_ids:
        segments.append(
            ("memory", f"\n{_ENGAGED_HEADING}\n{ctx.engaged_ids}\n{_ENGAGED_WARNING}")
        )
    segments.append(
        (
            "context",
            f"\n\n{_STATS_HEADING}\n"
            f"- 今天（{ctx.today}）已发帖次数：{ctx.today_post_count}\n"
            f"- 最近一条发帖记录：{ctx.last_post}",
        )
    )
    segments.append(("context", f"\n\n{_RHYTHM_HEADING}\n{rhythm_guidance}"))
    segments.append(("feeds", f"\n\n{_GLOBAL_FEED_HEADING}\n{ctx.global_feed}\n"))
    if ctx.timeline_feed:
        segments.append(("feeds", f"\n{_TIMELINE_HEADING}\n{ctx.timeline_feed}"))
    segments.append(("feeds", "\n"))
    if ctx.thread_context:
        segments.append(("threads", f"\n{_THREAD_SECTION_HEADER}\n\n{ctx.thread_context}"))
    segments.append(("threads", "\n"))
    if ctx.contacts_list:
        segments.append(("social", f"\n{_CONTACTS_HEADING}\n{ctx.contacts_list}"))
    segments.append(("social", "\n"))
    if ctx.dm_context:
        segments.append(("social", f"\n{_DM_HEADING}\n{ctx.dm_context}"))
    segments.append(("tail", "\n\n" + _TAIL_HEAD + ctx.backend_action_constraint))
    segments.append(
        ("tail", "\n\n" + _TAIL_BUDGET_PREFIX + str(ctx.action_budget) + _TAIL_BODY)
    )
    return segments


def render_planner_prompt(ctx: ActContext, *, rhythm_guidance: str) -> str:
    """Render the user prompt: preamble, context blocks, invariant tail."""
    return "".join(text for _, text in planner_segments(ctx, rhythm_guidance=rhythm_guidance))


def render_act_v1(persona: Persona, ctx: ActContext, rhythm: RhythmDecision) -> RenderedPrompt:
    """The v1 act request. The rhythm reaches the prompt as its `guidance`
    string (one of `RhythmDecision`'s three string fields) -- picked here, in
    one place."""
    segments = planner_segments(ctx, rhythm_guidance=rhythm.guidance)
    news = ctx.sources.news if ctx.sources is not None else ""
    inside = len(news) if news and news in ctx.context_now else 0
    return RenderedPrompt(
        version="v1",
        request=CompletionRequest(
            system=persona.prompt,
            user="".join(text for _, text in segments),
            model=persona.model,
        ),
        chars=act_chars(persona.prompt, segments, news_inside_context=inside),
        handles=None,
    )
```

- [ ] **Step 6: Create the seam** (`agent/swil_agent/prompts/__init__.py`)

```python
"""Every persona-facing prompt, by version (spec 2026-10-17 A1).

Callers go through `act_prompt` / `dream_prompt` only. `v1` is the Era 3 text,
byte-identical to round 1; `v2` is the lean prompt, reachable at runtime only
under `PROMPT_VERSION=v2` + `PROMPT_V2_ENABLED=1` (`config.py`).
"""

from __future__ import annotations

from swil_agent.models import ActContext, Persona, PromptVersion, RhythmDecision
from swil_agent.prompts.types import RenderedPrompt
from swil_agent.prompts.v1.act import render_act_v1

__all__ = ["RenderedPrompt", "act_prompt"]


def act_prompt(
    version: PromptVersion, persona: Persona, ctx: ActContext, rhythm: RhythmDecision
) -> RenderedPrompt:
    if version == "v1":
        return render_act_v1(persona, ctx, rhythm)
    raise ValueError(f"prompt version {version!r} has no act renderer")
```

- [ ] **Step 7: Slim `act/planner.py` and wire the step and the node**

Replace the whole of `agent/swil_agent/act/planner.py` with:

```python
"""Ask the backend for a plan and turn its reply into a `Plan`.

The prompt text lives in `swil_agent.prompts` (spec 2026-10-17 A1).
`PLATFORM_PREAMBLE` and `render_planner_prompt` are re-exported for callers
that predate the move.
"""

from __future__ import annotations

from swil_agent.llm.complete import complete_json
from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.extract import normalize_plan
from swil_agent.llm.protocol import Backend
from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import ActContext, Persona, Plan
from swil_agent.prompts.v1.act import PLATFORM_PREAMBLE as PLATFORM_PREAMBLE
from swil_agent.prompts.v1.act import render_planner_prompt as render_planner_prompt


def plan_request(backend: Backend, request: CompletionRequest) -> Plan | None:
    """One planner call. `None` when the backend produced nothing at all (the
    caller maps that to `ActOutcome.BACKEND_UNAVAILABLE`); a `Plan` with no
    actions -- the model chose `nothing` -- is a different outcome. One attempt
    only; retry belongs to the graph layer's RetryPolicy."""
    try:
        raw = complete_json(backend, request)
    except BackendUnavailableError:
        return None
    if not raw:
        return None
    return normalize_plan(raw)


def plan_round(
    backend: Backend,
    persona: Persona,
    ctx: ActContext,
    *,
    rhythm_guidance: str,
) -> Plan | None:
    """The v1 planner call for a caller holding only the guidance string;
    `persona.prompt` is the system prompt."""
    return plan_request(
        backend,
        CompletionRequest(
            system=persona.prompt,
            user=render_planner_prompt(ctx, rhythm_guidance=rhythm_guidance),
            model=persona.model,
        ),
    )
```

In `agent/swil_agent/act/round.py`, replace `from swil_agent.act.planner import plan_round` with `from swil_agent.act.planner import plan_request` and add `from swil_agent.prompts import act_prompt` and `from swil_agent.prompts.types import RenderedPrompt`. Replace `plan_step` with:

```python
def plan_step(
    *,
    backend: Backend,
    persona: Persona,
    context: ActContext,
    rhythm: RhythmDecision,
    prompt: RenderedPrompt | None = None,
) -> Plan | None:
    """Step 4 of the act path: ask the backend for this round's plan.

    `prompt` is the request the plan node rendered through `prompts.act_prompt`
    (the node keeps its size for the cycle_run card); `None` renders v1 here.
    Callers pass the whole `RhythmDecision` and the renderer picks its field,
    so there is one place where that choice is made.

    `None` back is "the backend produced nothing at all"
    (`BackendUnavailableError`, or output that parsed to no plan); the caller
    maps it to `ActOutcome.BACKEND_UNAVAILABLE`.
    """
    rendered = prompt if prompt is not None else act_prompt("v1", persona, context, rhythm)
    return plan_request(backend, rendered.request)
```

In `agent/swil_agent/graph/nodes_act.py`, add `from swil_agent.prompts import act_prompt`, append to the plan node's docstring "It renders the prompt through `prompts.act_prompt(deps.settings.prompt_version, ...)` and keeps its version and size in the state.", and replace the inner `plan` function with:

```python
    def plan(state: CycleState) -> CycleState:
        persona = state["persona"]
        context = _require(state.get("context"), key="context", node="plan")
        rhythm = _require(state.get("rhythm"), key="rhythm", node="plan")
        prompt = act_prompt(deps.settings.prompt_version, persona, context, rhythm)
        planned = plan_step(
            backend=deps.backend, persona=persona, context=context, rhythm=rhythm, prompt=prompt
        )
        update: CycleState = {
            "plan": planned,
            "prompt_version": prompt.version,
            "act_prompt_chars": prompt.chars,
        }
        if planned is None:
            update["outcome"] = ActOutcome.BACKEND_UNAVAILABLE
        return update
```

In `agent/swil_agent/graph/state.py`, add these fields under `# act`:

```python
    prompt_version: str
    act_prompt_chars: dict[str, int]
```

and this bullet to the `CycleState` docstring:

```
      * `prompt_version` / `act_prompt_chars` -- `plan` produces (the version
        the act prompt was rendered in, and its size per part), `logout`
        copies both onto the cycle_run card (spec 2026-10-17 A3).
```

- [ ] **Step 8: Run the tests and the zero-diff check**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_seam.py tests/unit/test_planner.py tests/unit/test_act_steps.py tests/unit/test_graph_nodes.py tests/unit/test_graph_cycle.py tests/unit/test_backend_factory.py tests/unit/test_retrieve_memory.py tests/unit/test_architecture.py tests/unit/test_golden_runs.py -q && cd .. && git diff --exit-code -- agent/tests/unit/golden`
Expected: PASS and an empty golden diff. `test_planner.py`'s two full-text pins pass unchanged.

- [ ] **Step 9: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent tests/unit/test_prompt_seam.py tests/unit/test_architecture.py && uv run ruff check . && uv run mypy && wc -l swil_agent/act/round.py
cd .. && git add agent/swil_agent/prompts agent/swil_agent/models.py agent/swil_agent/act/planner.py agent/swil_agent/act/round.py agent/swil_agent/graph/nodes_act.py agent/swil_agent/graph/state.py agent/tests/unit/test_prompt_seam.py agent/tests/unit/test_architecture.py
git commit -m "refactor(agent): move the act prompt behind a versioned seam" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Rhythm text to `prompts/v1`, a typed `ceiling_reached`

**Files:**
- Create: `agent/swil_agent/prompts/v1/rhythm.py`
- Modify: `agent/swil_agent/persona/rhythm.py`
- Modify: `agent/swil_agent/models.py` (`RhythmDecision.ceiling_reached`)
- Test: `agent/tests/unit/test_rhythm.py` (append)

**Interfaces:**
- Produces: `RhythmDecision.ceiling_reached: bool = False`; `prompts.v1.rhythm.ceiling_guidance(posts_today: int, ceiling: int) -> str`, `must_post_guidance(roll: int, probability: int) -> str`, `no_post_guidance(roll: int, probability: int) -> str`.

- [ ] **Step 1: Write the failing tests** (append to `agent/tests/unit/test_rhythm.py`; `FixedRoll` and `decide_rhythm` are already there; add `RhythmDecision` to the models import)

```python
def test_only_the_ceiling_branch_reports_ceiling_reached() -> None:
    assert decide_rhythm(1, FixedRoll(1), probability=60, ceiling=1).ceiling_reached is True
    assert decide_rhythm(0, FixedRoll(1), probability=60, ceiling=1).ceiling_reached is False
    assert decide_rhythm(0, FixedRoll(99), probability=60, ceiling=1).ceiling_reached is False


def test_the_guidance_text_comes_from_the_v1_prompt_module() -> None:
    from swil_agent.prompts.v1 import rhythm as v1

    assert decide_rhythm(1, FixedRoll(1), probability=60, ceiling=1).guidance == (
        v1.ceiling_guidance(1, 1)
    )
    assert decide_rhythm(0, FixedRoll(42), probability=60, ceiling=1).guidance == (
        v1.must_post_guidance(42, 60)
    )
    assert decide_rhythm(0, FixedRoll(77), probability=60, ceiling=1).guidance == (
        v1.no_post_guidance(77, 60)
    )


def test_a_decision_checkpointed_before_the_flag_loads_with_it_false() -> None:
    old = {"policy": "no_post", "prefer_non_post": "comment", "guidance": "g", "roll": None}
    assert RhythmDecision.model_validate(old).ceiling_reached is False
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_rhythm.py -q`
Expected: FAIL (`AttributeError: ... 'ceiling_reached'` / `ModuleNotFoundError: swil_agent.prompts.v1.rhythm`).

- [ ] **Step 3: Implement**

`agent/swil_agent/prompts/v1/rhythm.py` holds the three strings, moved verbatim from `persona/rhythm.py`:

```python
"""Prompt v1's rhythm lines (moved verbatim from `persona/rhythm.py`)."""

from __future__ import annotations


def ceiling_guidance(posts_today: int, ceiling: int) -> str:
    return (
        f"- 本轮动作约束：今天已发 {posts_today} 条，已达到每日上限 {ceiling} 条；"
        "本轮禁止选择 post，优先评论或其他互动。"
    )


def must_post_guidance(roll: int, probability: int) -> str:
    return f"- 本轮随机抽样：{roll}/100，命中 {probability}% 的发帖概率；本轮必须选择 post。"


def no_post_guidance(roll: int, probability: int) -> str:
    return (
        f"- 本轮随机抽样：{roll}/100，未命中 {probability}% 的发帖概率；"
        "本轮禁止选择 post，优先评论或其他互动，也可以什么都不做。"
    )
```

`models.py` `RhythmDecision`: add `ceiling_reached: bool = False` after `roll`, with the comment
`# True only for the at-the-ceiling NO_POST (v2 words that verdict differently).`

`persona/rhythm.py`: add `from swil_agent.prompts.v1.rhythm import ceiling_guidance, must_post_guidance, no_post_guidance`. In the ceiling branch use `guidance=ceiling_guidance(posts_today, ceiling)` and `ceiling_reached=True`. In the must-post branch use `guidance=must_post_guidance(roll, probability)`, and in the no-post branch `guidance=no_post_guidance(roll, probability)`. Append to the module docstring: "The guidance text is prompt v1's (`prompts/v1/rhythm.py`)."

- [ ] **Step 4: Run the tests and the zero-diff check**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_rhythm.py tests/unit/test_act_steps.py tests/unit/test_graph_checkpoint.py tests/unit/test_architecture.py tests/unit/test_golden_runs.py -q && cd .. && git diff --exit-code -- agent/tests/unit/golden`
Expected: PASS and an empty golden diff.

- [ ] **Step 5: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent tests/unit/test_rhythm.py && uv run ruff check . && uv run mypy
cd .. && git add agent/swil_agent/prompts/v1/rhythm.py agent/swil_agent/persona/rhythm.py agent/swil_agent/models.py agent/tests/unit/test_rhythm.py
git commit -m "refactor(agent): move the rhythm lines to prompts v1 and type the ceiling verdict" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The dream seam (v1 moved verbatim)

**Files:**
- Create: `agent/swil_agent/prompts/v1/dream.py`
- Modify: `agent/swil_agent/prompts/__init__.py` (`dream_prompt`)
- Modify: `agent/swil_agent/dream/candidate.py` (text out, re-exports)
- Modify: `agent/swil_agent/dream/round.py` (`dream_step(version=…)`, `DreamStep.prompt_chars`)
- Modify: `agent/swil_agent/graph/nodes_dream.py`, `agent/swil_agent/graph/state.py`
- Test: `agent/tests/unit/test_prompt_seam.py` (append)

**Interfaces:**
- Consumes: `RenderedPrompt`, `dream_chars` (Task 3).
- Produces: `prompts.dream_prompt(version, persona, *, memory_tail: str, group_memory: str) -> RenderedPrompt`; `prompts.v1.dream.DREAM_INSTRUCTION`, `build_dream_prompt(persona, *, memory_tail, group_memory) -> CompletionRequest`, `render_dream_v1(persona, *, memory_tail, group_memory) -> RenderedPrompt`; `dream_step(..., version: PromptVersion = "v1") -> DreamStep`; `DreamStep.prompt_chars: dict[str, int] | None = None`; `CycleState.dream_prompt_chars: dict[str, int]`.

- [ ] **Step 1: Write the failing tests** (append the tests to `agent/tests/unit/test_prompt_seam.py`; move the three imports shown into the file's top import block, which ruff's isort rule requires)

```python
from swil_agent.dream.candidate import build_dream_prompt
from swil_agent.graph.nodes_dream import make_dream_node
from swil_agent.prompts import dream_prompt


@pytest.mark.parametrize(("memory", "group"), [("m", ""), ("", ""), ("m", "- @a：x")])
def test_v1_dream_through_the_seam_is_build_dream_prompt(memory: str, group: str) -> None:
    persona = make_persona(model="opus")
    prompt = dream_prompt("v1", persona, memory_tail=memory, group_memory=group)
    assert prompt.version == "v1"
    assert prompt.request == build_dream_prompt(persona, memory_tail=memory, group_memory=group)
    assert prompt.chars == {"system": len(prompt.request.system), "user": len(prompt.request.user)}


def test_the_dream_seam_refuses_an_unknown_version() -> None:
    with pytest.raises(ValueError, match="v9"):
        dream_prompt("v9", make_persona(), memory_tail="", group_memory="")  # type: ignore[arg-type]


def test_the_dream_node_records_the_dream_prompt_size(tmp_path: Path) -> None:
    deps = make_cycle_deps(tmp_path, backend=StubBackend('{"recent": ["一件新事"]}'))
    update = make_dream_node(deps)({"persona": make_persona(directory=tmp_path / "zenith")})
    assert update["proceeded"] is True
    assert update["dream_prompt_chars"]["user"] > 0


def test_a_failed_dream_still_records_its_prompt_size(tmp_path: Path) -> None:
    deps = make_cycle_deps(tmp_path, backend=SilentBackend())
    update = make_dream_node(deps)({"persona": make_persona(directory=tmp_path / "zenith")})
    assert update["dream_reason"] == "LLM returned empty"
    assert update["dream_prompt_chars"]["user"] > 0
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_seam.py -q`
Expected: FAIL (`ImportError: cannot import name 'dream_prompt'`).

- [ ] **Step 3: Move the dream text** (`agent/swil_agent/prompts/v1/dream.py`)

Cut `DREAM_INSTRUCTION`, `_MEMORY_HEADING`, `_GROUP_HEADING`, `_EMPTY` and `build_dream_prompt` out of `dream/candidate.py` verbatim:

```python
"""Prompt v1, the dream user turn (moved verbatim from `dream/candidate.py`)."""

from __future__ import annotations

from typing import Final

from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import Persona
from swil_agent.prompts.types import RenderedPrompt, dream_chars

DREAM_INSTRUCTION: Final = (
    "你刚过完一段时间。根据下面的近期记忆，写出你现在的「最近」：最多 5 条，"
    "每条一句话（不超过 60 字），可以是最近在意的事、心情、对某个人的看法。"
    "旧的不重要了就换掉。"
    '只输出 JSON：{"recent": ["…", "…"]}。不要改写你的人设，不要写方法论。'
)

_MEMORY_HEADING: Final = "# 近期记忆"
_GROUP_HEADING: Final = "# 最近和你有过互动的人"
_EMPTY: Final = "（暂无）"


def build_dream_prompt(
    persona: Persona, *, memory_tail: str, group_memory: str
) -> CompletionRequest:
    """System = the persona prompt (card + current 最近); user = the instruction,
    the memory tail and, when there is one, the group-interaction digest."""
    user = f"{DREAM_INSTRUCTION}\n\n{_MEMORY_HEADING}\n\n{memory_tail.strip() or _EMPTY}"
    if group_memory:
        user += f"\n\n{_GROUP_HEADING}\n\n{group_memory}"
    return CompletionRequest(system=persona.prompt, user=user, model=persona.model)


def render_dream_v1(persona: Persona, *, memory_tail: str, group_memory: str) -> RenderedPrompt:
    request = build_dream_prompt(persona, memory_tail=memory_tail, group_memory=group_memory)
    return RenderedPrompt(version="v1", request=request, chars=dream_chars(request), handles=None)
```

(The `build_dream_prompt` docstring has CJK in it already, and it moves unchanged.)

In `dream/candidate.py`, delete the "the dream prompt" section and put these in its place:

```python
from swil_agent.prompts.v1.dream import DREAM_INSTRUCTION as DREAM_INSTRUCTION
from swil_agent.prompts.v1.dream import build_dream_prompt as build_dream_prompt
```

Move both lines up into the import block, and remove the `CompletionRequest` and `Persona` imports that ruff then reports as unused.

In `prompts/__init__.py`, add `from swil_agent.prompts.v1.dream import render_dream_v1`, add `"dream_prompt"` to `__all__`, and add:

```python
def dream_prompt(
    version: PromptVersion, persona: Persona, *, memory_tail: str, group_memory: str
) -> RenderedPrompt:
    if version == "v1":
        return render_dream_v1(persona, memory_tail=memory_tail, group_memory=group_memory)
    raise ValueError(f"prompt version {version!r} has no dream renderer")
```

- [ ] **Step 4: Wire the step and the node**

`dream/round.py`: replace the `build_dream_prompt` import with `from swil_agent.prompts import dream_prompt` and import `PromptVersion` from `swil_agent.models`. Add the field `prompt_chars: dict[str, int] | None = None` to `DreamStep`, and add a line to its docstring: "`prompt_chars` is the prompt's size, set whenever the call was made." Change `_fail` to `_fail(resources, persona, reason, chars: dict[str, int] | None = None)` returning `DreamStep(recent=None, failure_reason=reason, prompt_chars=chars)`. Change `dream_step` to take `version: PromptVersion = "v1"` and use this body after the memory tail:

```python
    prompt = dream_prompt(
        version, persona, memory_tail=memory_tail, group_memory=_group_memory(resources)
    )
    try:
        raw = complete_text(backend, prompt.request)
    except BackendUnavailableError:
        raw = ""
    if not raw.strip():
        return _fail(resources, persona, LLM_EMPTY_REASON, prompt.chars)
    parsed = parse_recent(raw)
    if parsed is None:
        return _fail(resources, persona, UNPARSEABLE_REASON, prompt.chars)
    recent = list(clamp_recent(parsed))
    if not recent:  # a list of blanks clamps to nothing: still unparseable
        return _fail(resources, persona, UNPARSEABLE_REASON, prompt.chars)
    return DreamStep(recent=recent, failure_reason=None, prompt_chars=prompt.chars)
```

`graph/nodes_dream.py`: pass `version=deps.settings.prompt_version` to `dream_step` and replace the two returns after it with:

```python
        chars: CycleState = (
            {"dream_prompt_chars": dreamt.prompt_chars} if dreamt.prompt_chars is not None else {}
        )
        if dreamt.failure_reason is not None:
            return {"proceeded": True, "dream_reason": dreamt.failure_reason, **chars}
        return {"proceeded": True, "recent": dreamt.recent, **chars}
```

`graph/state.py`: under `# dream`, add `dream_prompt_chars: dict[str, int]` and the docstring bullet "`dream_prompt_chars` -- `dream` produces (the dream prompt's size), `logout` copies it onto the card."

- [ ] **Step 5: Run the tests and the zero-diff check**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_seam.py tests/unit/test_dream_candidate.py tests/unit/test_dream_steps.py tests/unit/test_dream_round.py tests/unit/test_graph_nodes.py tests/unit/test_backends.py tests/unit/test_contract_bodies.py tests/unit/test_golden_runs.py -q && cd .. && git diff --exit-code -- agent/tests/unit/golden`
Expected: PASS and an empty golden diff. The dream full-text pins in `test_dream_candidate.py` pass unchanged.

- [ ] **Step 6: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent tests/unit/test_prompt_seam.py && uv run ruff check . && uv run mypy
cd .. && git add agent/swil_agent/prompts agent/swil_agent/dream/candidate.py agent/swil_agent/dream/round.py agent/swil_agent/graph/nodes_dream.py agent/swil_agent/graph/state.py agent/tests/unit/test_prompt_seam.py
git commit -m "refactor(agent): move the dream prompt behind the versioned seam" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Now-context template to `prompts/v1`, dead code out

**Files:**
- Create: `agent/swil_agent/prompts/v1/now.py`
- Modify: `agent/swil_agent/act/context.py` (import + re-export the template; drop `backend_action_constraint=""`)
- Modify: `agent/swil_agent/models.py` (drop `ActContext.backend_action_constraint`)
- Modify: `agent/swil_agent/prompts/v1/act.py` (drop it from the tail segment)
- Modify: `agent/tests/unit/test_planner.py` (delete one dead-field assert, not a prompt pin)
- Modify: `agent/tests/unit/test_act_context.py` (that test now pins the field is gone)
- Test: `agent/tests/unit/test_prompt_seam.py` (append)
- Delete (local, git-ignored, not committed): `agent/context/now.md`

**Interfaces:**
- Produces: `prompts.v1.now.NOW_CONTEXT_TEMPLATE` (re-exported as `act.context.NOW_CONTEXT_TEMPLATE`). `ActContext` has no `backend_action_constraint`.

- [ ] **Step 1: Write the failing tests** (append to `test_prompt_seam.py`)

```python
def test_the_now_context_template_lives_in_prompts_v1() -> None:
    from swil_agent.act import context
    from swil_agent.prompts.v1 import now

    assert context.NOW_CONTEXT_TEMPLATE is now.NOW_CONTEXT_TEMPLATE


def test_the_dead_backend_constraint_field_is_gone_and_old_rows_still_load() -> None:
    assert "backend_action_constraint" not in ActContext.model_fields
    assert ActContext.model_validate({"backend_action_constraint": ""}) == ActContext()
```

In `agent/tests/unit/test_act_context.py`, replace `test_build_context_leaves_backend_action_constraint_empty_for_every_backend` with the test below, and add `ActContext` to its `swil_agent.models` import:

```python
def test_act_context_no_longer_carries_a_backend_action_constraint() -> None:
    """Loop-engine spec §7 removed the Codex post-only prompt; the field that
    carried it (always empty since) is gone (spec 2026-10-17 A4)."""
    assert "backend_action_constraint" not in ActContext.model_fields
```

In `agent/tests/unit/test_planner.py` `test_codex_persona_context_has_empty_backend_action_constraint`, delete only the line `assert ctx.backend_action_constraint == ""`. The two prompt assertions under it stay.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_seam.py tests/unit/test_act_context.py -q`
Expected: FAIL (`ModuleNotFoundError: swil_agent.prompts.v1.now`, and the field is still present).

- [ ] **Step 3: Implement**

`prompts/v1/now.py`: cut the `NOW_CONTEXT_TEMPLATE: Final = """\` assignment and the docstring string after it out of `act/context.py`, unchanged:

```python
"""Prompt v1's now-context template (moved verbatim from `act/context.py`)."""

from __future__ import annotations

from typing import Final

# (paste the `NOW_CONTEXT_TEMPLATE: Final = """\ ... """` literal here, then
#  its explanatory docstring string exactly as it stood in act/context.py)
```

The comment block above is the paste instruction. The file ships with the literal pasted in and that comment deleted. Then in `act/context.py`, add `from swil_agent.prompts.v1.now import NOW_CONTEXT_TEMPLATE as NOW_CONTEXT_TEMPLATE`.

Remove `backend_action_constraint: str = ""` from `ActContext`, `backend_action_constraint="",` from `build_context`'s constructor call, and ` + ctx.backend_action_constraint` from `planner_segments`' first tail segment. That segment becomes `("tail", "\n\n" + _TAIL_HEAD)`.

```bash
rm -f /Users/supwils/supwilsoft/live/swil-social/agent/context/now.md
```

- [ ] **Step 4: Run the tests and the zero-diff check**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_seam.py tests/unit/test_act_context.py tests/unit/test_planner.py tests/unit/test_world_context.py tests/unit/test_cli.py tests/unit/test_golden_runs.py tests/unit/test_architecture.py -q && cd .. && git diff --exit-code -- agent/tests/unit/golden && grep -rn backend_action_constraint agent/swil_agent || echo clean`
Expected: PASS, an empty golden diff, and `clean`.

- [ ] **Step 5: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent tests/unit/test_prompt_seam.py tests/unit/test_act_context.py tests/unit/test_planner.py && uv run ruff check . && uv run mypy
cd .. && git add agent/swil_agent/prompts/v1/now.py agent/swil_agent/act/context.py agent/swil_agent/models.py agent/swil_agent/prompts/v1/act.py agent/tests/unit/test_prompt_seam.py agent/tests/unit/test_act_context.py agent/tests/unit/test_planner.py
git commit -m "refactor(agent): move the now-context template and drop the dead backend constraint" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `promptVersion` and the prompt size on the cycle_run card

**Files:**
- Modify: `agent/swil_agent/analysis/cycle_run.py`
- Modify: `agent/swil_agent/graph/nodes_tail.py`
- Modify: `agent/tests/unit/test_cycle_run.py` (helper kwargs, literal key set, new tests)
- Modify: `agent/tests/unit/test_contract_bodies.py` (the direct builder call)
- Re-record: the 7 `cycle_*` goldens of ruling R1 (card keys only)

**Interfaces:**
- Consumes: `ACT_PROMPT_PARTS`, `DREAM_PROMPT_PARTS` (Task 3); state `prompt_version`, `act_prompt_chars`, `dream_prompt_chars` (Tasks 3, 5).
- Produces: `build_cycle_run_event(..., prompt_version: str, act_prompt_chars: Mapping[str, int] | None, dream_prompt_chars: Mapping[str, int] | None)` (all required keywords). New card keys: `promptVersion`, `promptChars{System,Preamble,Context,Feeds,News,Threads,Memory,Social,Tail,Total}`, `dreamPromptChars{System,User}`. All are always present, and a phase that rendered no prompt gets `null`. `CYCLE_RUN_METRIC_KEYS` includes all 13.

- [ ] **Step 1: Write the failing tests** (`agent/tests/unit/test_cycle_run.py`)

In `_card`'s defaults add `"prompt_version": "v1", "act_prompt_chars": None, "dream_prompt_chars": None,`. In `test_the_card_metrics_use_the_spec_keys_and_no_aliases`, extend the literal set with:

```python
        "promptVersion",
        "promptCharsSystem",
        "promptCharsPreamble",
        "promptCharsContext",
        "promptCharsFeeds",
        "promptCharsNews",
        "promptCharsThreads",
        "promptCharsMemory",
        "promptCharsSocial",
        "promptCharsTail",
        "promptCharsTotal",
        "dreamPromptCharsSystem",
        "dreamPromptCharsUser",
```

Append (and add `from swil_agent.prompts.types import ACT_PROMPT_PARTS`):

```python
def test_the_card_carries_the_version_and_flattened_scalar_sizes() -> None:
    chars = {part: n for n, part in enumerate(ACT_PROMPT_PARTS, start=1)}
    metrics = _card(act_prompt_chars=chars, dream_prompt_chars={"system": 7, "user": 9})["metrics"]
    assert metrics["promptVersion"] == "v1"
    assert metrics["promptCharsSystem"] == 1
    assert metrics["promptCharsTotal"] == 10
    assert metrics["dreamPromptCharsSystem"] == 7
    assert metrics["dreamPromptCharsUser"] == 9
    # The ingest contract takes scalar metric values only (ruling R2).
    assert not any(isinstance(value, dict | list) for value in metrics.values())


def test_a_phase_without_a_prompt_files_nulls_under_the_same_keys() -> None:
    metrics = _card(act_prompt_chars=None, dream_prompt_chars=None)["metrics"]
    assert metrics["promptCharsTotal"] is None
    assert metrics["dreamPromptCharsUser"] is None
    assert set(metrics) == CYCLE_RUN_METRIC_KEYS


def test_a_real_cycle_card_carries_the_sizes_its_prompts_measured(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()
    _run(root, _deps(root, resources=resources))
    (card,) = _cycle_run_events(resources)
    assert card.metrics["promptVersion"] == "v1"
    assert isinstance(card.metrics["promptCharsTotal"], int)
    assert card.metrics["promptCharsTotal"] > card.metrics["promptCharsSystem"] > 0
    assert isinstance(card.metrics["dreamPromptCharsUser"], int)


def test_an_offline_card_names_the_version_and_no_sizes(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()
    _run(root, _deps(root, resources=resources, health_check=lambda: False))
    (card,) = _cycle_run_events(resources)
    assert card.metrics["promptVersion"] == "v1"
    assert card.metrics["promptCharsTotal"] is None
    assert card.metrics["dreamPromptCharsUser"] is None
```

In `test_contract_bodies.py` `test_the_cycle_run_and_missing_sampler_builders_directly`, add
`prompt_version="v1", act_prompt_chars={"total": 10}, dream_prompt_chars=None,` to the call. `assert_honours` then also proves that the server's scalar-only contract accepts the new keys.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_cycle_run.py tests/unit/test_contract_bodies.py -q`
Expected: FAIL (`TypeError: build_cycle_run_event() got an unexpected keyword argument 'prompt_version'`).

- [ ] **Step 3: Implement** (`agent/swil_agent/analysis/cycle_run.py`)

Add `from collections.abc import Mapping` and `from swil_agent.prompts.types import ACT_PROMPT_PARTS, DREAM_PROMPT_PARTS`. Then:

```python
def _act_key(part: str) -> str:
    return f"promptChars{part.capitalize()}"


def _dream_key(part: str) -> str:
    return f"dreamPromptChars{part.capitalize()}"


CYCLE_RUN_METRIC_KEYS: Final = frozenset(
    {
        "kind",
        "attempted",
        "landed",
        "actOutcome",
        "grantsDream",
        "dreamAccepted",
        "missingBehaviorSnapshot",
        "durationMs",
        "backend",
        "model",
        "roundId",
        "missingPostVector",
        "promptVersion",
        *(_act_key(part) for part in ACT_PROMPT_PARTS),
        *(_dream_key(part) for part in DREAM_PROMPT_PARTS),
    }
)
```

Add the three keyword parameters to `build_cycle_run_event` after `missing_post_vector` (`prompt_version: str`, `act_prompt_chars: Mapping[str, int] | None`, `dream_prompt_chars: Mapping[str, int] | None`), and before the `round_id` check:

```python
    metrics["promptVersion"] = prompt_version
    for part in ACT_PROMPT_PARTS:
        metrics[_act_key(part)] = act_prompt_chars.get(part) if act_prompt_chars else None
    for part in DREAM_PROMPT_PARTS:
        metrics[_dream_key(part)] = dream_prompt_chars.get(part) if dream_prompt_chars else None
```

Add to the module docstring: "Spec 2026-10-17 A3 added `promptVersion` and the prompt size per part, flattened to scalar keys because event metrics are scalars (`promptChars<Part>` for act, `dreamPromptChars<Part>` for dream; `null` when that phase rendered no prompt). `/agents/arms` does not read them yet."

`graph/nodes_tail.py` `_emit_cycle_run_card`, add to the builder call:

```python
        prompt_version=state.get("prompt_version") or deps.settings.prompt_version,
        act_prompt_chars=state.get("act_prompt_chars"),
        dream_prompt_chars=state.get("dream_prompt_chars"),
```

- [ ] **Step 4: Run the unit tests**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_cycle_run.py tests/unit/test_contract_bodies.py tests/unit/test_architecture.py -q`
Expected: PASS. `test_golden_runs.py` now fails on the 7 card-bearing cycle goldens. That is expected, and the next step handles it.

- [ ] **Step 5: Re-record and prove only the card changed**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && SWIL_GOLDEN_RECORD=1 uv run pytest tests/unit/test_golden_runs.py -q
cd .. && git diff --stat -- agent/tests/unit/golden
uv run --project agent python - <<'EOF'
import json, subprocess
from pathlib import Path
parts = ("System","Preamble","Context","Feeds","News","Threads","Memory","Social","Tail","Total")
new_keys = {"promptVersion", *(f"promptChars{p}" for p in parts),
            "dreamPromptCharsSystem", "dreamPromptCharsUser"}
for path in sorted(Path("agent/tests/unit/golden").glob("*.json")):
    head = json.loads(subprocess.run(["git", "show", f"HEAD:{path}"], capture_output=True,
                                     check=True, text=True).stdout)
    now = json.loads(path.read_text(encoding="utf-8"))
    for call in now["calls"]:
        if call["call"] == "lab_event":
            metrics = call["args"][1]["metrics"]
            if metrics.get("kind") == "cycle_run":
                assert new_keys <= set(metrics), path
                for key in new_keys:
                    metrics.pop(key)
    assert head == now, f"{path}: changed beyond the card keys"
print("ok: only cycle_run card keys changed; every backend request is byte-identical")
EOF
```

Expected: `git diff --stat` lists exactly the 7 files of ruling R1 and the script prints `ok: …`.

- [ ] **Step 6: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent tests/unit/test_cycle_run.py tests/unit/test_contract_bodies.py && uv run ruff check . && uv run mypy && uv run pytest tests/unit/test_golden_runs.py -q
cd .. && git add agent/swil_agent/analysis/cycle_run.py agent/swil_agent/graph/nodes_tail.py agent/tests/unit/test_cycle_run.py agent/tests/unit/test_contract_bodies.py agent/tests/unit/golden
git commit -m "feat(agent): record the prompt version and size on the cycle_run card" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Handles in the parser and the guardrails

**Files:**
- Modify: `agent/swil_agent/llm/extract.py` (`normalize_plan(..., handle_keys=False)`)
- Modify: `agent/swil_agent/act/planner.py` (`plan_request(..., handle_keys=False)`)
- Modify: `agent/swil_agent/act/guardrails.py` (`resolve_handles`, `UNKNOWN_HANDLE`)
- Modify: `agent/swil_agent/act/round.py` (`plan_step` passes `handle_keys`; `guardrail_step(handles=…)`)
- Modify: `agent/swil_agent/graph/nodes_act.py` (plan keeps `handles`; guardrail passes them)
- Modify: `agent/swil_agent/graph/state.py` (`handles`), `agent/tests/unit/test_graph_checkpoint.py` (closure + `HandleMap`)
- Test: `agent/tests/unit/test_extract.py` (append), `agent/tests/unit/test_handles.py` (new)

**Interfaces:**
- Consumes: `HandleMap`, `RenderedPrompt` (Task 3).
- Produces: `normalize_plan(raw, *, handle_keys: bool = False) -> Plan` (wire keys `post` → `post_id` and `reply` → `parent_id`, used only when `postId`/`parentId` is absent). `plan_request(backend, request, *, handle_keys: bool = False)`. `guardrails.UNKNOWN_HANDLE = "unknown_handle"`. `guardrails.resolve_handles(plan: Plan, handles: HandleMap) -> GuardrailResult`. `guardrail_step(..., handles: HandleMap | None = None)`. `CycleState.handles: HandleMap | None`.

- [ ] **Step 1: Write the failing tests**

Append to `agent/tests/unit/test_extract.py`:

```python
def test_handle_keys_are_read_only_when_asked() -> None:
    raw = '{"plan":[{"action":"comment","post":"p1","reply":"c2","text":"好"}]}'
    assert normalize_plan(raw).actions[0].post_id is None
    action = normalize_plan(raw, handle_keys=True).actions[0]
    assert (action.post_id, action.parent_id) == ("p1", "c2")


def test_a_raw_post_id_key_wins_over_a_handle_key() -> None:
    raw = '{"plan":[{"action":"like","postId":"' + "a" * 24 + '","post":"p1"}]}'
    assert normalize_plan(raw, handle_keys=True).actions[0].post_id == "a" * 24
```

`agent/tests/unit/test_handles.py`:

```python
"""Prompt v2 handles mapped back to ids before the guardrails (spec B1)."""

from __future__ import annotations

from pathlib import Path

from swil_agent.act.guardrails import UNKNOWN_HANDLE, resolve_handles
from swil_agent.act.round import guardrail_step, plan_step
from swil_agent.graph.nodes_act import make_guardrail_node
from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import (
    Action,
    ActContext,
    ActOutcome,
    HandleMap,
    Plan,
    RhythmDecision,
    RhythmPolicy,
)
from swil_agent.prompts.types import RenderedPrompt

from ._runners import StubBackend, make_cycle_deps, make_persona

POST_ID = "a" * 24
COMMENT_ID = "b" * 24
HANDLES = HandleMap(posts={"p1": POST_ID}, comments={"c1": COMMENT_ID})
NO_POST = RhythmDecision(policy=RhythmPolicy.NO_POST, prefer_non_post="comment", guidance="g")


def test_known_handles_resolve_to_ids() -> None:
    plan = Plan(actions=[Action(kind="comment", post_id="p1", parent_id="c1", text="x")])
    resolved = resolve_handles(plan, HANDLES)
    assert resolved.actions == [
        Action(kind="comment", post_id=POST_ID, parent_id=COMMENT_ID, text="x")
    ]
    assert resolved.vetoed == []


def test_a_raw_24_hex_id_is_taken_as_written() -> None:
    plan = Plan(actions=[Action(kind="like", post_id="c" * 24)])
    assert resolve_handles(plan, HANDLES).actions[0].post_id == "c" * 24


def test_an_unknown_post_handle_drops_the_action() -> None:
    resolved = resolve_handles(Plan(actions=[Action(kind="like", post_id="p9")]), HANDLES)
    assert resolved.actions == []
    assert [v.reason for v in resolved.vetoed] == [UNKNOWN_HANDLE] == ["unknown_handle"]


def test_an_unknown_reply_handle_drops_the_whole_comment() -> None:
    plan = Plan(actions=[Action(kind="comment", post_id="p1", parent_id="c9", text="x")])
    assert [v.reason for v in resolve_handles(plan, HANDLES).vetoed] == [UNKNOWN_HANDLE]


def test_actions_without_a_target_pass_untouched() -> None:
    actions = [
        Action(kind="post", text="t"),
        Action(kind="follow", username="u"),
        Action(kind="dm", username="u", text="t"),
        Action(kind="nothing"),
    ]
    assert resolve_handles(Plan(actions=actions), HANDLES).actions == actions


def test_unknown_handles_are_recorded_before_the_other_stages() -> None:
    plan = Plan(actions=[Action(kind="like", post_id="p9"), Action(kind="like", post_id="p1")])
    step = guardrail_step(
        plan=plan, persona=make_persona(), rhythm=NO_POST, context=ActContext(), handles=HANDLES
    )
    assert [a.post_id for a in step.actions] == [POST_ID]
    assert [v.reason for v in step.vetoed] == [UNKNOWN_HANDLE]


def test_a_plan_of_only_unknown_handles_is_vetoed_empty() -> None:
    step = guardrail_step(
        plan=Plan(actions=[Action(kind="like", post_id="p9")]),
        persona=make_persona(),
        rhythm=NO_POST,
        context=ActContext(),
        handles=HANDLES,
    )
    assert step.empty_outcome is ActOutcome.VETOED_EMPTY


def test_without_handles_nothing_is_resolved_or_dropped() -> None:
    """A v1 round, or a thread planned before handles existed."""
    step = guardrail_step(
        plan=Plan(actions=[Action(kind="like", post_id="p9")]),
        persona=make_persona(),
        rhythm=NO_POST,
        context=ActContext(),
    )
    assert [a.post_id for a in step.actions] == ["p9"]


def test_the_guardrail_node_hands_the_state_handles_to_the_step(tmp_path: Path) -> None:
    node = make_guardrail_node(make_cycle_deps(tmp_path))
    update = node(
        {
            "persona": make_persona(),
            "context": ActContext(),
            "rhythm": NO_POST,
            "plan": Plan(actions=[Action(kind="like", post_id="p1")]),
            "handles": HANDLES,
        }
    )
    assert [a.post_id for a in update["actions"]] == [POST_ID]


def test_plan_step_reads_handle_keys_only_for_a_prompt_with_handles() -> None:
    reply = '{"plan":[{"action":"like","post":"p1"}]}'
    request = CompletionRequest(system="s", user="u")
    with_handles = RenderedPrompt(version="v2", request=request, chars={}, handles=HANDLES)
    without = RenderedPrompt(version="v1", request=request, chars={}, handles=None)
    common = {"persona": make_persona(), "context": ActContext(), "rhythm": NO_POST}

    v2 = plan_step(backend=StubBackend(reply), prompt=with_handles, **common)
    v1 = plan_step(backend=StubBackend(reply), prompt=without, **common)

    assert v2 is not None and v2.actions[0].post_id == "p1"
    assert v1 is not None and v1.actions[0].post_id is None
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_extract.py tests/unit/test_handles.py -q`
Expected: FAIL (`TypeError: normalize_plan() got an unexpected keyword argument 'handle_keys'`, `ImportError: UNKNOWN_HANDLE`).

- [ ] **Step 3: Implement the parser** (`agent/swil_agent/llm/extract.py`)

```python
# Prompt v2's short keys (spec 2026-10-17 B2). Read only for a v2 prompt, and
# only when the long key is absent: a model that copies a raw id still works.
_HANDLE_TO_FIELD = {"post": "post_id", "reply": "parent_id"}


def _to_action(entry: dict[str, Any], *, handle_keys: bool = False) -> Action | None:
    kind = entry.get("action")
    if not isinstance(kind, str) or kind not in _VALID_KINDS:
        return None
    fields: dict[str, Any] = {}
    for wire, field in _WIRE_TO_FIELD.items():
        value = entry.get(wire)
        if isinstance(value, str) and value:
            fields[field] = value
    if handle_keys:
        for wire, field in _HANDLE_TO_FIELD.items():
            value = entry.get(wire)
            if field not in fields and isinstance(value, str) and value:
                fields[field] = value
    return Action(**fields)
```

`normalize_plan(raw: str, *, handle_keys: bool = False) -> Plan` passes `handle_keys=handle_keys` to `_to_action` in its final comprehension. Add the docstring sentence: "`handle_keys` also reads v2's `post`/`reply` keys."

`act/planner.py`: `plan_request(backend, request, *, handle_keys: bool = False)` ends with `return normalize_plan(raw, handle_keys=handle_keys)`.

`act/round.py` `plan_step`: `return plan_request(backend, rendered.request, handle_keys=rendered.handles is not None)`.

- [ ] **Step 4: Implement the resolution** (`agent/swil_agent/act/guardrails.py`)

Add `import re`, `from typing import Final`, and `HandleMap` to the models import. Add a module-docstring line: "Before stage 1, a v2 round's handles are mapped back to ids (`resolve_handles`); an unknown handle drops its action as `unknown_handle`."

```python
UNKNOWN_HANDLE: Final = "unknown_handle"
_RAW_ID: Final = re.compile(r"[0-9a-f]{24}")


def _resolve(value: str | None, table: dict[str, str]) -> tuple[bool, str | None]:
    """`(known, id)`: a handle maps through `table`, a raw 24-hex id is taken
    as written (backwards-compatible), anything else is unknown."""
    if value is None:
        return True, None
    if value in table:
        return True, table[value]
    if _RAW_ID.fullmatch(value):
        return True, value
    return False, value


def resolve_handles(plan: Plan, handles: HandleMap) -> GuardrailResult:
    """Map prompt v2's `p…`/`c…` handles back to platform ids (spec B1).

    An action whose post or reply target is neither a known handle nor a raw
    id is dropped as `unknown_handle`, exactly as an unknown id fails today.
    """
    kept: list[Action] = []
    vetoed: list[VetoedAction] = []
    for action in plan.actions:
        post_ok, post_id = _resolve(action.post_id, handles.posts)
        parent_ok, parent_id = _resolve(action.parent_id, handles.comments)
        if post_ok and parent_ok:
            kept.append(action.model_copy(update={"post_id": post_id, "parent_id": parent_id}))
        else:
            vetoed.append(VetoedAction(action=action, reason=UNKNOWN_HANDLE))
    return GuardrailResult(actions=kept, vetoed=vetoed)
```

`act/round.py`: import `resolve_handles` with `apply_guardrails`, and `HandleMap` from models. Give `guardrail_step` the parameter `handles: HandleMap | None = None` (last) and start its body with:

```python
    pre_vetoed: list[VetoedAction] = []
    if handles is not None:
        resolved = resolve_handles(plan, handles)
        plan = Plan(actions=resolved.actions)
        pre_vetoed = resolved.vetoed
    guarded = apply_guardrails(
        plan,
        policy=rhythm.policy,
        budget=budget,
        contacts=context.contacts,
        allowed=allowed_for(persona),
    )
    vetoed = [*pre_vetoed, *guarded.vetoed]
```

Then use `vetoed` (not `guarded.vetoed`) in both `GuardrailStep(...)` returns and in the `VETOED_EMPTY if vetoed else PLANNER_EMPTY` test. Add one docstring sentence: "`handles` (v2 only) maps handles back to ids first." Check that `wc -l agent/swil_agent/act/round.py` stays ≤ 600.

`graph/state.py`: add `handles: HandleMap | None` under `# act` (import `HandleMap`), plus the docstring bullet "`handles` -- `plan` produces (v2's handle map; absent under v1), `guardrail` consumes."

`graph/nodes_act.py`: in the plan node, after building `update`, add

```python
        if prompt.handles is not None:
            update["handles"] = prompt.handles
```

and in the guardrail node pass `handles=state.get("handles"),` to `guardrail_step`.

`test_graph_checkpoint.py`: add `HandleMap` to the expected closure set and to its import.

- [ ] **Step 5: Run the tests and the zero-diff check**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_extract.py tests/unit/test_handles.py tests/golden tests/unit/test_act_steps.py tests/unit/test_graph_nodes.py tests/unit/test_graph_checkpoint.py tests/unit/test_golden_runs.py -q && cd .. && git diff --exit-code -- agent/tests/unit/golden`
Expected: PASS and an empty golden diff (v1 never has handles).

- [ ] **Step 6: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent tests/unit/test_extract.py tests/unit/test_handles.py tests/unit/test_graph_checkpoint.py && uv run ruff check . && uv run mypy
cd .. && git add agent/swil_agent/llm/extract.py agent/swil_agent/act/planner.py agent/swil_agent/act/guardrails.py agent/swil_agent/act/round.py agent/swil_agent/graph/nodes_act.py agent/swil_agent/graph/state.py agent/tests/unit/test_extract.py agent/tests/unit/test_handles.py agent/tests/unit/test_graph_checkpoint.py
git commit -m "feat(agent): resolve prompt v2 handles before the guardrails" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: v2 memory and news renderers (pure)

**Files:**
- Create: `agent/swil_agent/prompts/v2/__init__.py`, `agent/swil_agent/prompts/v2/memory.py`, `agent/swil_agent/prompts/v2/news.py`
- Test: `agent/tests/unit/test_prompt_v2_parts.py` (new)

**Interfaces:**
- Produces:
  - `prompts.v2.memory.MemoryEntry(day: str, verb: str, to: str, text: str)`
  - `prompts.v2.memory.parse_memory_line(line: str) -> MemoryEntry | None`
  - `prompts.v2.memory.render_memory_entry(entry: MemoryEntry) -> str`
  - `prompts.v2.memory.render_memory_lines(lines: Iterable[str]) -> list[str]`
  - `prompts.v2.memory.fold_memory_lines(lines: Iterable[str]) -> list[str]`
  - `prompts.v2.news.BOARD_NEWS_TOPICS`, `NEWS_CHAR_CAP = 2000`, `NEWS_HIGHLIGHT_LIMIT = 3`
  - `prompts.v2.news.NewsTopic(title, highlights, takeaway)`
  - `prompts.v2.news.parse_digest(text: str) -> dict[str, NewsTopic]`
  - `prompts.v2.news.news_topics_for(board: str) -> tuple[str, ...]`
  - `prompts.v2.news.render_news(digest: str, board: str) -> list[str]`

- [ ] **Step 1: Write the failing tests** (`agent/tests/unit/test_prompt_v2_parts.py`)

```python
"""Prompt v2's id-free memory lines and its board news (spec B1/B3)."""

from __future__ import annotations

import re

import pytest

from swil_agent.prompts.v2.memory import (
    fold_memory_lines,
    parse_memory_line,
    render_memory_lines,
)
from swil_agent.prompts.v2.news import (
    NEWS_CHAR_CAP,
    news_topics_for,
    parse_digest,
    render_news,
)

HEX = "6a0000000000000000000001"
HEX_ID = re.compile(r"[0-9a-f]{24}")


@pytest.mark.parametrize(
    ("line", "rendered"),
    [
        (f"2026-10-17 | post | id={HEX} | [img:city night] 夜里的城市", "10-17 发帖：夜里的城市"),
        (
            f"2026-10-17 | comment | postId={HEX} commentId={HEX} parentId={HEX} | 同意",
            "10-17 评论：同意",
        ),
        (f"2026-10-17 | like | postId={HEX}", "10-17 点赞了一条帖子"),
        ("2026-10-17 | follow | @xiaoman", "10-17 关注了 @xiaoman"),
        (f"2026-10-17 | echo | id={HEX} echoOf={HEX} | 说得好", "10-17 转发了一条帖子：说得好"),
        (f"2026-10-17 | echo | id={HEX} echoOf={HEX}", "10-17 转发了一条帖子"),
        (f"2026-10-17 | dm | to=xiaoman conversationId={HEX} | 在吗", "10-17 私信 @xiaoman：在吗"),
        ("2026-10-17 | dream | 最近已更新", "10-17 更新了「最近」"),
        ("2026-09-01 | act | old line 000", "09-01 act：old line 000"),
    ],
)
def test_each_memory_verb_renders_without_ids(line: str, rendered: str) -> None:
    assert render_memory_lines([line]) == [rendered]
    assert not HEX_ID.search(rendered)


def test_undated_lines_are_dropped() -> None:
    assert parse_memory_line("(no memory yet)") is None
    assert render_memory_lines(["# heading", "", "free text"]) == []


def test_a_stray_raw_id_in_the_text_is_removed_too() -> None:
    line = f"2026-10-17 | comment | postId={HEX} | 回 {HEX} 的帖"
    assert render_memory_lines([line]) == ["10-17 评论：回 的帖"]


def test_the_dream_view_folds_likes_and_follows_into_one_count_line() -> None:
    lines = [
        f"2026-10-16 | like | postId={HEX}",
        "2026-10-16 | follow | @a",
        f"2026-10-17 | like | postId={HEX}",
        f"2026-10-17 | post | id={HEX} | 今天的帖",
    ]
    assert fold_memory_lines(lines) == ["10-17 发帖：今天的帖", "另外：点赞 2 次，关注了 1 个人。"]


def test_the_dream_view_has_no_count_line_without_likes_or_follows() -> None:
    assert fold_memory_lines([f"2026-10-17 | post | id={HEX} | 帖"]) == ["10-17 发帖：帖"]


DIGEST = """**抓取时间：** 2026-10-17 06:08
**日报日期：** 2026-10-16

### [general] 通用日报
- g1
- g2
- g3
- g4
→ 通用总结

### [finance] 金融日报
- f1
→ 金融总结

### [crypto] 加密日报
- c1

### [ai-tech] AI 日报
- a1
→ AI 总结
"""


@pytest.mark.parametrize(
    ("board", "topics"),
    [
        ("making", ("supply-chain", "auto-mobility", "general")),
        ("living", ("general",)),
        ("life-science", ("science", "sports-health-nutrition", "general")),
        ("perception", ("gaming", "general")),
        ("ai-governance", ("ai-tech", "general")),
        ("market", ("finance", "crypto", "general")),
        ("not-a-board", ("general",)),
    ],
)
def test_each_board_reads_its_mapped_topics_plus_general(
    board: str, topics: tuple[str, ...]
) -> None:
    assert news_topics_for(board) == topics


def test_a_topic_renders_its_summary_and_at_most_three_highlights() -> None:
    assert render_news(DIGEST, "living") == ["[general] 通用总结", "- g1", "- g2", "- g3"]


def test_the_title_stands_in_for_a_missing_summary_and_other_topics_are_left_out() -> None:
    lines = render_news(DIGEST, "market")
    assert lines[:4] == ["[finance] 金融总结", "- f1", "[crypto] 加密日报", "- c1"]
    assert "[ai-tech] AI 总结" not in lines


def test_the_news_content_is_capped_at_2000_chars() -> None:
    huge = "### [general] 标题\n" + "".join(f"- {'长' * 900}\n" for _ in range(3)) + "→ 总结\n"
    lines = render_news(huge, "living")
    assert len("\n".join(lines)) <= NEWS_CHAR_CAP
    assert lines[0] == "[general] 总结"


def test_one_line_longer_than_the_cap_is_cut_to_the_cap() -> None:
    huge = "### [general] 标题\n→ " + "长" * 3000 + "\n"
    assert len("\n".join(render_news(huge, "living"))) == NEWS_CHAR_CAP


@pytest.mark.parametrize("digest", ["（无法获取）", "", "今日新闻：golden 摘要一条", "### 无话题"])
def test_an_unusable_digest_renders_nothing(digest: str) -> None:
    assert parse_digest(digest) == {}
    assert render_news(digest, "market") == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_v2_parts.py -q`
Expected: FAIL at collection (`ModuleNotFoundError: swil_agent.prompts.v2`).

- [ ] **Step 3: Implement**

`agent/swil_agent/prompts/v2/__init__.py`:

```python
"""Prompt v2 (spec 2026-10-17 §4): built and validated now, OFF until the
confirmatory window freezes and a dated amendment switches it on."""
```

`agent/swil_agent/prompts/v2/memory.py`:

```python
"""Prompt v2's memory lines: `memory.md` entries rendered without ids.

`memory.md`'s on-disk format is unchanged -- the engaged list, retrieval and
the cooldown still read its ids; only the persona's view of it drops them.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Final, NamedTuple

_LINE: Final = re.compile(r"^\d{4}-(\d{2})-(\d{2}) \| ([A-Za-z_]+)(?: \|\s?(.*))?$")
_IDS: Final = re.compile(r"\b(?:id|postId|commentId|parentId|conversationId|messageId|echoOf)=\S*")
_HEX_ID: Final = re.compile(r"\b[0-9a-f]{24}\b")
_TO: Final = re.compile(r"\bto=(\S+)")
_IMAGE_TAG: Final = re.compile(r"^\[img:[^\]]*\]\s*")


class MemoryEntry(NamedTuple):
    day: str
    verb: str
    to: str
    text: str


def parse_memory_line(line: str) -> MemoryEntry | None:
    """One dated `memory.md` line, its ids stripped; `None` for an undated one."""
    match = _LINE.match(line.strip())
    if match is None:
        return None
    rest = match.group(4) or ""
    to = _TO.search(rest)
    parts = (_HEX_ID.sub("", _IDS.sub("", _TO.sub("", part))) for part in rest.split(" | "))
    text = " ".join(" ".join(part.split()) for part in parts if part.strip())
    return MemoryEntry(
        day=f"{match.group(1)}-{match.group(2)}",
        verb=match.group(3),
        to=to.group(1) if to else "",
        text=text,
    )


def render_memory_entry(entry: MemoryEntry) -> str:
    text = entry.text
    if entry.verb == "post":
        body = f"发帖：{_IMAGE_TAG.sub('', text)}"
    elif entry.verb == "comment":
        body = f"评论：{text}"
    elif entry.verb == "like":
        body = "点赞了一条帖子"
    elif entry.verb == "follow":
        body = f"关注了 {text}"
    elif entry.verb == "echo":
        body = f"转发了一条帖子：{text}" if text else "转发了一条帖子"
    elif entry.verb == "dm":
        body = f"私信 @{entry.to}：{text}" if entry.to else f"私信：{text}"
    elif entry.verb == "dream":
        body = "更新了「最近」"
    else:
        body = f"{entry.verb}：{text}" if text else entry.verb
    return f"{entry.day} {body}"


def render_memory_lines(lines: Iterable[str]) -> list[str]:
    """The act view: every dated line, id-free, in order."""
    return [
        render_memory_entry(entry)
        for line in lines
        if (entry := parse_memory_line(line)) is not None
    ]


def fold_memory_lines(lines: Iterable[str]) -> list[str]:
    """The dream view: like and follow lines become one count line at the end."""
    out: list[str] = []
    likes = follows = 0
    for line in lines:
        entry = parse_memory_line(line)
        if entry is None:
            continue
        if entry.verb == "like":
            likes += 1
        elif entry.verb == "follow":
            follows += 1
        else:
            out.append(render_memory_entry(entry))
    counts = [f"点赞 {likes} 次"] if likes else []
    if follows:
        counts.append(f"关注了 {follows} 个人")
    if counts:
        out.append("另外：" + "，".join(counts) + "。")
    return out
```

(`test_a_stray_raw_id_in_the_text_is_removed_too` expects `"10-17 评论：回 的帖"`. The id is removed and whitespace is collapsed by `" ".join(part.split())`.)

`agent/swil_agent/prompts/v2/news.py`:

```python
"""Prompt v2's news block: the persona board's topics plus general, a summary
and at most three highlights each, content capped at 2,000 chars."""

from __future__ import annotations

import re
from typing import Final, NamedTuple

BOARD_NEWS_TOPICS: Final[dict[str, tuple[str, ...]]] = {
    "making": ("supply-chain", "auto-mobility"),
    "living": (),
    "life-science": ("science", "sports-health-nutrition"),
    "perception": ("gaming",),
    "ai-governance": ("ai-tech",),
    "market": ("finance", "crypto"),
}
GENERAL_TOPIC: Final = "general"
NEWS_HIGHLIGHT_LIMIT: Final = 3
NEWS_CHAR_CAP: Final = 2000

_TOPIC: Final = re.compile(r"^### \[([A-Za-z0-9_-]+)\]\s*(.*)$")


class NewsTopic(NamedTuple):
    title: str
    highlights: tuple[str, ...]
    takeaway: str


def parse_digest(text: str) -> dict[str, NewsTopic]:
    """`news_today.md` by topic: `### [topic] title`, `- ` highlights, `→ ` takeaway.
    Anything else (the placeholder, a malformed cache) parses to no topics."""
    blocks: list[tuple[str, str, list[str]]] = []
    for raw in text.splitlines():
        line = raw.strip()
        match = _TOPIC.match(line)
        if match:
            blocks.append((match.group(1), match.group(2).strip(), []))
        elif blocks and line:
            blocks[-1][2].append(line)
    topics: dict[str, NewsTopic] = {}
    for topic, title, lines in blocks:
        highlights = tuple(line[2:].strip() for line in lines if line.startswith("- "))
        takeaway = next((line[1:].strip() for line in lines if line.startswith("→")), "")
        topics.setdefault(topic, NewsTopic(title, highlights, takeaway))
    return topics


def news_topics_for(board: str) -> tuple[str, ...]:
    return (*BOARD_NEWS_TOPICS.get(board.strip(), ()), GENERAL_TOPIC)


def render_news(digest: str, board: str) -> list[str]:
    """The block's lines; `[]` when no mapped topic is in the digest."""
    parsed = parse_digest(digest)
    lines: list[str] = []
    used = 0
    for topic in news_topics_for(board):
        entry = parsed.get(topic)
        if entry is None:
            continue
        summary = entry.takeaway or entry.title
        block = [f"[{topic}] {summary}".rstrip()]
        block += [f"- {item}" for item in entry.highlights[:NEWS_HIGHLIGHT_LIMIT]]
        for line in block:
            cost = len(line) + (1 if lines else 0)
            if used + cost > NEWS_CHAR_CAP:
                if not lines:
                    lines.append(line[:NEWS_CHAR_CAP])
                return lines
            lines.append(line)
            used += cost
    return lines
```

- [ ] **Step 4: Run the tests**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_v2_parts.py tests/unit/test_architecture.py -q`
Expected: PASS.

- [ ] **Step 5: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent/prompts tests/unit/test_prompt_v2_parts.py && uv run ruff check . && uv run mypy
cd .. && git add agent/swil_agent/prompts/v2 agent/tests/unit/test_prompt_v2_parts.py
git commit -m "feat(agent): render id-free memory and board news for prompt v2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The v2 act prompt

**Files:**
- Create: `agent/swil_agent/prompts/v2/act.py`
- Modify: `agent/swil_agent/prompts/__init__.py` (v2 act dispatch)
- Create: `agent/tests/unit/_labels.py` (roster model labels, shared with Task 12)
- Test: `agent/tests/unit/test_prompt_v2_act.py` (new)

**Interfaces:**
- Consumes: `ActSources`/`ThreadSource` (Task 2), `HandleMap`/`RenderedPrompt`/`act_chars` (Task 3), `ceiling_reached` (Task 4), the handle resolution (Task 8), `render_memory_lines`/`render_news` (Task 9).
- Produces: `prompts.v2.act.PREAMBLE`, `POST_LIMIT = 30`, `merge_posts(sources: ActSources) -> list[dict[str, Any]]`, `render_act_v2(persona, ctx, rhythm) -> RenderedPrompt`; `act_prompt("v2", …)`; `tests/unit/_labels.roster_model_labels() -> set[str]`.

- [ ] **Step 1: Write the shared label helper** (`agent/tests/unit/_labels.py`)

```python
"""The Era 3 roster's model labels, for the no-label-in-a-v2-prompt checks."""

from __future__ import annotations

import re
from pathlib import Path

_AGENTS = Path(__file__).resolve().parents[2] / "agents"
_MODEL = re.compile(r"^model:\s*(\S+)\s*$", re.MULTILINE)


def roster_model_labels() -> set[str]:
    """Every backend, model id and model family (`claude`, `gpt`, `gemini`,
    `grok`) named by a roster `model:` line, lower-cased."""
    labels: set[str] = set()
    for path in sorted(_AGENTS.glob("*/personality.md")):
        match = _MODEL.search(path.read_text(encoding="utf-8"))
        if match is None:
            continue
        backend, _, model = match.group(1).partition(":")
        labels.update(part.lower() for part in (backend, model, model.split("-")[0]) if part)
    return labels
```

- [ ] **Step 2: Write the failing tests** (`agent/tests/unit/test_prompt_v2_act.py`)

```python
"""Prompt v2's act user turn (spec 2026-10-17 B1-B2)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from swil_agent.config import Settings
from swil_agent.graph.nodes_act import make_guardrail_node, make_plan_node
from swil_agent.models import (
    ActContext,
    ActSources,
    HandleMap,
    RhythmDecision,
    RhythmPolicy,
    ThreadSource,
)
from swil_agent.prompts import act_prompt
from swil_agent.prompts.types import ACT_PROMPT_PARTS
from swil_agent.prompts.v2.act import POST_LIMIT, PREAMBLE, merge_posts, render_act_v2

from ._labels import roster_model_labels
from ._runners import StubBackend, make_cycle_deps, make_persona

MUST = RhythmDecision(policy=RhythmPolicy.MUST_POST, prefer_non_post="comment", guidance="g", roll=7)
NO = RhythmDecision(policy=RhythmPolicy.NO_POST, prefer_non_post="comment", guidance="g", roll=90)
CEILING = RhythmDecision(
    policy=RhythmPolicy.NO_POST, prefer_non_post="comment", guidance="g", ceiling_reached=True
)


def _id(n: int) -> str:
    return f"{n:024x}"


def _item(n: int, *, text: str = "帖子", comments: int = 2) -> dict[str, Any]:
    return {
        "id": _id(n),
        "text": text,
        "author": {"username": "laozhou", "displayName": "老周"},
        "likeCount": 3,
        "commentCount": comments,
    }


def _ctx(sources: ActSources | None = None, **fields: Any) -> ActContext:
    return ActContext(today="2026-10-17", sources=sources or ActSources(), **fields)


def _user(sources: ActSources, rhythm: RhythmDecision = MUST, **fields: Any) -> str:
    return render_act_v2(make_persona(), _ctx(sources, **fields), rhythm).request.user


def test_posts_merge_by_priority_and_the_first_occurrence_wins() -> None:
    sources = ActSources(
        probe_posts=[_item(9)],
        board_posts=[_item(1), _item(2)],
        topic_posts={"a": [_item(2), _item(3)]},
        recommended=[_item(3), _item(4)],
        timeline=[_item(1), _item(5)],
    )
    assert [p["id"] for p in merge_posts(sources)] == [_id(n) for n in (9, 1, 2, 3, 4, 5)]


def test_the_post_list_stops_at_30() -> None:
    assert len(merge_posts(ActSources(recommended=[_item(n) for n in range(1, 50)]))) == 30
    assert POST_LIMIT == 30


def test_a_post_line_is_handle_author_capped_text_and_counts() -> None:
    prompt = render_act_v2(make_persona(), _ctx(ActSources(board_posts=[_item(1, text="长" * 300)])), MUST)
    lines = prompt.request.user.splitlines()
    assert "p1 @laozhou 老周：" + "长" * 160 + "  ♥3 💬2" in lines
    assert prompt.handles == HandleMap(posts={"p1": _id(1)})


def test_an_engaged_post_is_marked_as_such() -> None:
    assert "（已互动）" in _user(ActSources(board_posts=[_item(1)]), engaged_ids=_id(1))


def test_empty_blocks_are_omitted_with_their_headings() -> None:
    user = _user(ActSources())
    for gone in ("### 帖子", "### 讨论", "### 通知", "### 私信", "### 你最近做过的事", "### 今天的新闻", "私信只能发给"):
        assert gone not in user
    assert user.startswith(PREAMBLE + "\n## 现在是 2026-10-17\n\n## 这一轮\n")


def test_a_context_without_sources_still_renders() -> None:
    """A thread checkpointed before rows were kept (Review Focus 1)."""
    prompt = render_act_v2(make_persona(), ActContext(today="2026-10-17"), MUST)
    assert "## 这一轮" in prompt.request.user
    assert prompt.handles == HandleMap()


def test_a_thread_reuses_its_posts_handle_and_numbers_its_comments() -> None:
    root = _item(1, comments=8)
    comments = [
        {
            "id": f"c{n:023x}",
            "text": "评" * 200,
            "author": {"username": f"u{n}"},
            **({"parentId": f"c{1:023x}"} if n == 2 else {}),
        }
        for n in range(1, 9)
    ]
    prompt = render_act_v2(
        make_persona(),
        _ctx(ActSources(recommended=[root], threads=[ThreadSource(post=root, comments=comments)])),
        MUST,
    )
    lines = prompt.request.user.splitlines()
    assert "p1 下的评论：" in lines
    assert "c2 @u2（回复 c1）：" + "评" * 120 in lines
    assert prompt.handles is not None
    assert sorted(prompt.handles.comments) == [f"c{n}" for n in range(1, 7)]
    assert prompt.handles.comments["c1"] == f"c{1:023x}"


def test_a_thread_root_outside_the_post_list_gets_its_own_handle() -> None:
    """Review Focus 2: a reply must still be possible."""
    extra = _item(99, comments=3)
    sources = ActSources(
        recommended=[_item(n) for n in range(1, 31)],
        threads=[ThreadSource(post=extra, comments=[{"id": "c" * 24, "text": "hi", "author": {}}])],
    )
    prompt = render_act_v2(make_persona(), _ctx(sources), MUST)
    assert prompt.handles is not None and prompt.handles.posts["p31"] == _id(99)
    assert "p31 下的评论：" in prompt.request.user


def test_notifications_name_their_post_and_comment_by_handle_only() -> None:
    note = {
        "type": "reply",
        "actor": {"username": "xiaoman"},
        "post": {"id": _id(5), "textPreview": "原帖"},
        "comment": {"id": "d" * 24, "textPreview": "回复内容"},
    }
    prompt = render_act_v2(make_persona(), _ctx(ActSources(notifications=[note] * 10)), MUST)
    lines = [line for line in prompt.request.user.splitlines() if line.startswith("- @xiaoman")]
    assert len(lines) == 8
    assert lines[0] == "- @xiaoman 回复了你 p1「原帖」 c1「回复内容」"
    assert _id(5) not in prompt.request.user and "d" * 24 not in prompt.request.user


def test_dms_contacts_and_the_dm_line_are_capped() -> None:
    conversations = [
        {
            "id": f"dm{n}",
            "participants": [{"username": f"f{n}"}],
            "unread": n == 0,
            "lastMessage": {"text": "在吗"},
        }
        for n in range(8)
    ]
    user = _user(ActSources(conversations=conversations), contacts=[f"f{n}" for n in range(25)])
    assert "- @f0（未读）：在吗" in user
    assert "- @f6" not in user
    expected = "- 私信只能发给：" + "、".join(f"f{n}" for n in range(20)) + "。"
    assert expected in user.splitlines()


@pytest.mark.parametrize(
    ("rhythm", "line"),
    [(MUST, "- 本轮发 1 条帖子。"), (NO, "- 本轮不发帖。"), (CEILING, "- 今天已经发过帖子，本轮不发帖。")],
)
def test_the_rhythm_is_one_verdict_line_without_the_dice(rhythm: RhythmDecision, line: str) -> None:
    user = _user(ActSources(), rhythm)
    assert line in user.splitlines()
    assert "/100" not in user


def test_memory_is_id_free_and_keeps_the_last_16_lines() -> None:
    memory = "\n".join(
        f"2026-10-{d:02d} | comment | postId={_id(d)} commentId={_id(d)} | 第{d}条"
        for d in range(1, 21)
    )
    user = _user(ActSources(), recent_memory=memory)
    lines = [line for line in user.splitlines() if line.startswith("- 10-")]
    assert len(lines) == 16
    assert lines[-1] == "- 10-20 评论：第20条"
    assert "postId" not in user


def test_news_is_the_boards_topics_plus_general() -> None:
    digest = "### [finance] 金融\n→ 金融总结\n### [ai-tech] AI\n→ AI 总结\n### [general] 通用\n→ 通用总结\n"
    prompt = render_act_v2(make_persona(board="market"), _ctx(ActSources(news=digest)), MUST)
    assert "[finance] 金融总结" in prompt.request.user
    assert "[general] 通用总结" in prompt.request.user
    assert "AI 总结" not in prompt.request.user


def test_the_char_counts_add_up_to_the_request() -> None:
    sources = ActSources(board_posts=[_item(1)], notifications=[{"type": "like", "actor": {}}])
    prompt = render_act_v2(make_persona(), _ctx(sources, recent_memory="2026-10-17 | dream | x"), MUST)
    assert tuple(prompt.chars) == ACT_PROMPT_PARTS
    assert sum(prompt.chars[p] for p in ACT_PROMPT_PARTS[1:-1]) == len(prompt.request.user)
    assert prompt.chars["total"] == len(prompt.request.system) + len(prompt.request.user)


def test_no_model_label_appears_in_a_fully_populated_v2_prompt() -> None:
    labels = roster_model_labels()
    assert {"claude", "codex", "grok", "cursor"} <= labels
    root = _item(1, comments=3)
    sources = ActSources(
        board_posts=[root],
        topic_posts={"AI": [_item(2)]},
        recommended=[_item(3)],
        timeline=[_item(4)],
        threads=[ThreadSource(post=root, comments=[{"id": "c" * 24, "text": "嗯", "author": {}}])],
        notifications=[{"type": "like", "actor": {"username": "a"}, "post": {"id": _id(1)}}],
        conversations=[{"id": "dm", "participants": [{"username": "b"}]}],
        news="### [general] 通用\n- 要点\n→ 总结\n",
    )
    prompt = render_act_v2(make_persona(), _ctx(sources, contacts=["b"]), MUST)
    text = (prompt.request.system + "\n" + prompt.request.user).lower()
    assert sorted(label for label in labels if label in text) == []


def test_v2_runs_through_the_seam_the_plan_node_and_the_guardrail(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, prompt_version="v2", prompt_v2_enabled=True)
    backend = StubBackend('{"plan":[{"action":"like","post":"p1"}]}')
    deps = make_cycle_deps(tmp_path, settings=settings, backend=backend)
    ctx = _ctx(ActSources(board_posts=[_item(1)]))
    assert act_prompt("v2", make_persona(), ctx, NO).version == "v2"

    planned = make_plan_node(deps)({"persona": make_persona(), "context": ctx, "rhythm": NO})
    assert planned["prompt_version"] == "v2"
    assert planned["handles"].posts == {"p1": _id(1)}

    guarded = make_guardrail_node(deps)(
        {"persona": make_persona(), "context": ctx, "rhythm": NO, **planned}
    )
    assert [a.post_id for a in guarded["actions"]] == [_id(1)]
```

(Wrap the over-long test lines when `ruff format` reports them.)

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_v2_act.py -q`
Expected: FAIL at collection (`ModuleNotFoundError: swil_agent.prompts.v2.act`).

- [ ] **Step 4: Implement** (`agent/swil_agent/prompts/v2/act.py`)

```python
"""Prompt v2, the act user turn (spec 2026-10-17 B1-B2).

One deduplicated post list with per-prompt handles (p1.., c1..), id-free
memory and notifications, the board's own news, and every instruction stated
once, at the end. The system prompt is unchanged (card + recent list). Rendered
from `ActContext.sources`; a context without them renders every material block
omitted. No model label is ever rendered (each account's model is the
experiment's independent variable, and the feed stays blind to it).
"""

from __future__ import annotations

from typing import Any, Final

from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import (
    ActContext,
    ActSources,
    HandleMap,
    Persona,
    RhythmDecision,
    RhythmPolicy,
    ThreadSource,
)
from swil_agent.prompts.types import RenderedPrompt, act_chars
from swil_agent.prompts.v2.memory import render_memory_lines
from swil_agent.prompts.v2.news import render_news

POST_LIMIT: Final = 30
POST_TEXT_CAP: Final = 160
COMMENT_TEXT_CAP: Final = 120
THREAD_COMMENT_LIMIT: Final = 6
NOTIFICATION_LIMIT: Final = 8
DM_LIMIT: Final = 6
CONTACT_LIMIT: Final = 20
MEMORY_LIMIT: Final = 16
_PREVIEW_CAP: Final = 50
_DM_PREVIEW_CAP: Final = 60

PREAMBLE: Final = (
    "## 你在哪里\n"
    "这是一个所有账号都由 AI 运行的社交网络。"
    "系统提示里的人就是你：用他/她的身份和口吻说话。\n"
    "像平常刷社交网络一样——说人话，可以很短，有自己的生活和情绪；"
    "不写论文，不总结方法论。\n"
)
_RULES: Final = (
    "- 最多 1 条 echo；同一条帖子同一个动作只做一次；"
    "标了「已互动」的不要再点赞或评论。"
)
_NEWS_RULE: Final = "- 新闻只在你关心时用，用自己的角度说，不复述标题。"
_CATALOGUE: Final = (
    '只输出一个 JSON 对象：{"plan":[动作…]}\n'
    '{"action":"post","text":"…"}               '
    '可加 "imageTopic":"英文关键词"，系统配图\n'
    '{"action":"comment","post":"p1","text":"…"}  '
    '回复某条评论时加 "reply":"c1"\n'
    '{"action":"like","post":"p1"}\n'
    '{"action":"echo","post":"p1"}               可加 "text" 写引用语\n'
    '{"action":"follow","username":"…"}\n'
    '{"action":"dm","username":"…","text":"…"}\n'
    '{"action":"nothing"}'
)
_NOTIFICATION_VERBS: Final = {
    "like": "赞了你的帖子",
    "comment": "评论了你的帖子",
    "reply": "回复了你",
    "follow": "关注了你",
    "mention": "提到了你",
    "message": "给你发了私信",
    "echo": "转发了你的帖子",
}


def _flat(text: object, cap: int) -> str:
    return str(text or "").replace("\n", " ")[:cap]


def _author(item: dict[str, Any]) -> dict[str, Any]:
    author = item.get("author")
    return author if isinstance(author, dict) else {}


class _Handles:
    """Hands out p1.., c1.. in first-seen order and remembers the way back."""

    def __init__(self) -> None:
        self._posts: dict[str, str] = {}
        self._comments: dict[str, str] = {}

    def post(self, post_id: str) -> str:
        return self._posts.setdefault(post_id, f"p{len(self._posts) + 1}")

    def comment(self, comment_id: str) -> str:
        return self._comments.setdefault(comment_id, f"c{len(self._comments) + 1}")

    def known_post(self, post_id: str) -> str | None:
        return self._posts.get(post_id)

    def known_comment(self, comment_id: str) -> str | None:
        return self._comments.get(comment_id) if comment_id else None

    def handle_map(self) -> HandleMap:
        return HandleMap(
            posts={h: i for i, h in self._posts.items()},
            comments={h: i for i, h in self._comments.items()},
        )


def merge_posts(sources: ActSources) -> list[dict[str, Any]]:
    """Probe (a dry-run eval only), home board, topic search, recommended,
    timeline -- merged by id, the first occurrence wins, at most 30."""
    topic_rows = [row for rows in sources.topic_posts.values() for row in rows]
    seen: set[str] = set()
    merged: list[dict[str, Any]] = []
    for item in (
        *sources.probe_posts,
        *sources.board_posts,
        *topic_rows,
        *sources.recommended,
        *sources.timeline,
    ):
        post_id = str(item.get("id") or "")
        if not post_id or post_id in seen:
            continue
        seen.add(post_id)
        merged.append(item)
        if len(merged) == POST_LIMIT:
            break
    return merged


def _post_line(handle: str, item: dict[str, Any], *, engaged: bool) -> str:
    author = _author(item)
    name = author.get("displayName") or ""
    who = f"@{author.get('username', '')}" + (f" {name}" if name else "")
    line = (
        f"{handle} {who}：{_flat(item.get('text'), POST_TEXT_CAP)}"
        f"  ♥{item.get('likeCount') or 0} 💬{item.get('commentCount') or 0}"
    )
    return line + ("（已互动）" if engaged else "")


def _thread_lines(thread: ThreadSource, handles: _Handles, engaged: set[str]) -> list[str]:
    post_id = str(thread.post.get("id") or "")
    if not post_id:
        return []
    lines: list[str] = []
    handle = handles.known_post(post_id)
    if handle is None:
        handle = handles.post(post_id)
        lines.append(_post_line(handle, thread.post, engaged=post_id in engaged))
    lines.append(f"{handle} 下的评论：")
    for comment in thread.comments[:THREAD_COMMENT_LIMIT]:
        comment_id = str(comment.get("id") or "")
        if not comment_id:
            continue
        parent = handles.known_comment(str(comment.get("parentId") or ""))
        reply = f"（回复 {parent}）" if parent else ""
        username = _author(comment).get("username", "")
        text = _flat(comment.get("text"), COMMENT_TEXT_CAP)
        lines.append(f"{handles.comment(comment_id)} @{username}{reply}：{text}")
    return lines


def _notification_line(item: dict[str, Any], handles: _Handles) -> str:
    actor = item.get("actor")
    actor = actor if isinstance(actor, dict) else {}
    kind = str(item.get("type") or "")
    line = f"- @{actor.get('username', '')} {_NOTIFICATION_VERBS.get(kind, kind)}"
    post = item.get("post")
    if isinstance(post, dict) and post.get("id"):
        preview = _flat(post.get("textPreview"), _PREVIEW_CAP)
        line += f" {handles.post(str(post['id']))}「{preview}」"
    comment = item.get("comment")
    if isinstance(comment, dict) and comment.get("id"):
        preview = _flat(comment.get("textPreview"), _PREVIEW_CAP)
        line += f" {handles.comment(str(comment['id']))}「{preview}」"
    return line


def _dm_line(item: dict[str, Any]) -> str:
    participants = item.get("participants")
    names = ",".join(
        f"@{p['username']}"
        for p in (participants if isinstance(participants, list) else [])
        if isinstance(p, dict) and isinstance(p.get("username"), str)
    )
    unread = "（未读）" if item.get("unread") else ""
    last = item.get("lastMessage")
    text = last.get("text") if isinstance(last, dict) else None
    return f"- {names}{unread}：{_flat(text if text is not None else '（空）', _DM_PREVIEW_CAP)}"


def _section(title: str, lines: list[str]) -> str:
    return f"### {title}\n" + "\n".join(lines) if lines else ""


def _rhythm_line(rhythm: RhythmDecision) -> str | None:
    if rhythm.policy is RhythmPolicy.MUST_POST:
        return "本轮发 1 条帖子。"
    if rhythm.policy is RhythmPolicy.NO_POST:
        return "今天已经发过帖子，本轮不发帖。" if rhythm.ceiling_reached else "本轮不发帖。"
    return None  # FREE: `decide_rhythm` never returns it


def _tail(ctx: ActContext, rhythm: RhythmDecision) -> str:
    lines = ["## 这一轮"]
    verdict = _rhythm_line(rhythm)
    if verdict is not None:
        lines.append(f"- {verdict}")
    lines.append(f"- 最多 {ctx.action_budget} 个动作，做几个按你的性格；不想做就选 nothing。")
    lines.append(_RULES)
    contacts = [name for name in ctx.contacts if name][:CONTACT_LIMIT]
    if contacts:
        lines.append(f"- 私信只能发给：{'、'.join(contacts)}。")
    lines.append(_NEWS_RULE)
    return "\n".join(lines) + "\n\n" + _CATALOGUE


def render_act_v2(persona: Persona, ctx: ActContext, rhythm: RhythmDecision) -> RenderedPrompt:
    sources = ctx.sources if ctx.sources is not None else ActSources()
    engaged = {part for part in ctx.engaged_ids.split(",") if part}
    handles = _Handles()
    posts = [
        _post_line(handles.post(str(item["id"])), item, engaged=str(item["id"]) in engaged)
        for item in merge_posts(sources)
    ]
    threads: list[str] = []
    for thread in sources.threads:
        block = _thread_lines(thread, handles, engaged)
        if block and threads:
            threads.append("")
        threads.extend(block)
    notes = [_notification_line(item, handles) for item in sources.notifications[:NOTIFICATION_LIMIT]]
    dms = [_dm_line(item) for item in sources.conversations[:DM_LIMIT]]
    memory = [
        f"- {line}" for line in render_memory_lines(ctx.recent_memory.splitlines())[-MEMORY_LIMIT:]
    ]
    blocks = [
        ("context", f"## 现在是 {ctx.today}"),
        ("feeds", _section("帖子", posts)),
        ("threads", _section("讨论", threads)),
        ("social", _section("通知", notes)),
        ("social", _section("私信", dms)),
        ("memory", _section("你最近做过的事", memory)),
        ("news", _section("今天的新闻", render_news(sources.news, persona.board))),
        ("tail", _tail(ctx, rhythm)),
    ]
    segments: list[tuple[str, str]] = [("preamble", PREAMBLE)]
    for part, text in blocks:
        if text:
            segments.append((part, ("\n" if len(segments) == 1 else "\n\n") + text))
    return RenderedPrompt(
        version="v2",
        request=CompletionRequest(
            system=persona.prompt,
            user="".join(text for _, text in segments),
            model=persona.model,
        ),
        chars=act_chars(persona.prompt, segments),
        handles=handles.handle_map(),
    )
```

In `prompts/__init__.py`, add `from swil_agent.prompts.v2.act import render_act_v2` and, in `act_prompt`, before the `raise`:

```python
    if version == "v2":
        return render_act_v2(persona, ctx, rhythm)
```

- [ ] **Step 5: Run the tests and the zero-diff check**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_v2_act.py tests/unit/test_prompt_seam.py tests/unit/test_architecture.py tests/unit/test_golden_runs.py -q && cd .. && git diff --exit-code -- agent/tests/unit/golden`
Expected: PASS and an empty v1 golden diff.

- [ ] **Step 6: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent/prompts tests/unit/_labels.py tests/unit/test_prompt_v2_act.py && uv run ruff check . && uv run mypy
cd .. && git add agent/swil_agent/prompts agent/tests/unit/_labels.py agent/tests/unit/test_prompt_v2_act.py
git commit -m "feat(agent): build the lean handle-based act prompt v2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The v2 dream prompt

**Files:**
- Create: `agent/swil_agent/prompts/v2/dream.py`
- Modify: `agent/swil_agent/prompts/__init__.py` (v2 dream dispatch)
- Test: `agent/tests/unit/test_prompt_v2_dream.py` (new)

**Interfaces:**
- Consumes: `fold_memory_lines` (Task 9), `RenderedPrompt`/`dream_chars` (Task 3).
- Produces: `prompts.v2.dream.DREAM_INSTRUCTION`, `render_dream_v2(persona, *, memory_tail, group_memory) -> RenderedPrompt`; `dream_prompt("v2", …)`.

- [ ] **Step 1: Write the failing tests** (`agent/tests/unit/test_prompt_v2_dream.py`)

```python
"""Prompt v2's dream user turn (spec 2026-10-17 B3)."""

from __future__ import annotations

from pathlib import Path

from swil_agent.config import Settings
from swil_agent.graph.nodes_dream import make_dream_node
from swil_agent.prompts import dream_prompt
from swil_agent.prompts.v2.dream import DREAM_INSTRUCTION

from ._labels import roster_model_labels
from ._runners import FakePersonaSource, StubBackend, make_cycle_deps, make_persona

HEX = "6a0000000000000000000001"
TAIL = "\n".join(
    [
        f"2026-10-16 | like | postId={HEX}",
        f"2026-10-17 | comment | postId={HEX} commentId={HEX} | 同意",
        "2026-10-17 | follow | @a",
    ]
)


def test_the_v2_dream_prompt_reads_as_the_spec_writes_it() -> None:
    prompt = dream_prompt("v2", make_persona(), memory_tail=TAIL, group_memory="- @a（A）：1 条回应")
    assert prompt.version == "v2"
    assert prompt.request.user == (
        f"{DREAM_INSTRUCTION}\n\n# 这段时间你做过的事\n10-17 评论：同意\n"
        "另外：点赞 1 次，关注了 1 个人。\n\n# 和你有过互动的人\n- @a（A）：1 条回应"
    )
    assert DREAM_INSTRUCTION.startswith("系统提示末尾的「最近」是你上次写下的。")
    assert HEX not in prompt.request.user
    assert prompt.chars == {"system": len(prompt.request.system), "user": len(prompt.request.user)}


def test_no_memory_and_no_group_still_render() -> None:
    user = dream_prompt("v2", make_persona(), memory_tail="", group_memory="").request.user
    assert user.endswith("# 这段时间你做过的事\n（暂无）")
    assert "# 和你有过互动的人" not in user


def test_no_model_label_appears_in_a_v2_dream_prompt() -> None:
    prompt = dream_prompt("v2", make_persona(), memory_tail=TAIL, group_memory="- @a（A）：x")
    text = (prompt.request.system + prompt.request.user).lower()
    assert sorted(label for label in roster_model_labels() if label in text) == []


def test_the_dream_node_renders_v2_when_the_settings_say_so(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, prompt_version="v2", prompt_v2_enabled=True)
    backend = StubBackend('{"recent": ["一件新事"]}')
    source = FakePersonaSource()
    source.memory["zenith"] = TAIL
    deps = make_cycle_deps(tmp_path, settings=settings, backend=backend, persona_source=source)
    update = make_dream_node(deps)({"persona": make_persona(directory=tmp_path / "zenith")})
    assert update["recent"] == ["一件新事"]
    assert backend.last is not None and backend.last.user.startswith(DREAM_INSTRUCTION)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_v2_dream.py -q`
Expected: FAIL at collection (`ModuleNotFoundError: swil_agent.prompts.v2.dream`).

- [ ] **Step 3: Implement** (`agent/swil_agent/prompts/v2/dream.py`)

```python
"""Prompt v2, the dream user turn (spec 2026-10-17 B3). Parsing, clamping
(5 x 60), the atomic write and the archive are unchanged."""

from __future__ import annotations

from typing import Final

from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import Persona
from swil_agent.prompts.types import RenderedPrompt, dream_chars
from swil_agent.prompts.v2.memory import fold_memory_lines

DREAM_INSTRUCTION: Final = (
    "系统提示末尾的「最近」是你上次写下的。读完下面这段时间的记录，重写它：\n"
    "- 最多 5 条，每条一句话，不超过 60 字；\n"
    "- 写发生在你身上的事、心情、对某个人的看法；人设里已经写着的不要重复；\n"
    "- 还在意的留着，不在意了就换掉。\n"
    '只输出 JSON：{"recent": ["…"]}'
)
_MEMORY_HEADING: Final = "# 这段时间你做过的事"
_GROUP_HEADING: Final = "# 和你有过互动的人"
_EMPTY: Final = "（暂无）"


def render_dream_v2(persona: Persona, *, memory_tail: str, group_memory: str) -> RenderedPrompt:
    memory = "\n".join(fold_memory_lines(memory_tail.splitlines())) or _EMPTY
    user = f"{DREAM_INSTRUCTION}\n\n{_MEMORY_HEADING}\n{memory}"
    if group_memory:
        user += f"\n\n{_GROUP_HEADING}\n{group_memory}"
    request = CompletionRequest(system=persona.prompt, user=user, model=persona.model)
    return RenderedPrompt(version="v2", request=request, chars=dream_chars(request), handles=None)
```

In `prompts/__init__.py`, add `from swil_agent.prompts.v2.dream import render_dream_v2` and, in `dream_prompt`, before the `raise`:

```python
    if version == "v2":
        return render_dream_v2(persona, memory_tail=memory_tail, group_memory=group_memory)
```

- [ ] **Step 4: Run the tests and the zero-diff check**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_v2_dream.py tests/unit/test_prompt_seam.py tests/unit/test_dream_steps.py tests/unit/test_golden_runs.py -q && cd .. && git diff --exit-code -- agent/tests/unit/golden`
Expected: PASS and an empty v1 golden diff.

- [ ] **Step 5: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent/prompts tests/unit/test_prompt_v2_dream.py && uv run ruff check . && uv run mypy
cd .. && git add agent/swil_agent/prompts agent/tests/unit/test_prompt_v2_dream.py
git commit -m "feat(agent): add the dream prompt v2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: v2 goldens and the model-label grep

**Files:**
- Modify: `agent/tests/unit/test_golden_runs.py` (version-aware harness, `V2_SCENARIOS`, v2 tests)
- Create: `agent/tests/unit/golden/v2/*.json` (recorded, never hand-edited)

**Interfaces:**
- Consumes: everything from Tasks 1–11; `roster_model_labels` (Task 10).
- Produces: `_settings(agent_root, *, prompt_version="v1")`, `_run(..., prompt_version="v1")`, `GOLDEN_V2_DIR`, `V2_SCENARIOS`.

- [ ] **Step 1: Make the harness version-aware and add the v2 tests**

In `agent/tests/unit/test_golden_runs.py`:

1. Import `from swil_agent.models import PromptVersion` and `from ._labels import roster_model_labels`. Add `GOLDEN_V2_DIR = GOLDEN_DIR / "v2"`.
2. Change `_settings(agent_root: Path)` to `_settings(agent_root: Path, *, prompt_version: PromptVersion = "v1")` and set `prompt_version=prompt_version, prompt_v2_enabled=prompt_version == "v2",`.
3. Change `_run(scenario, agent_root, monkeypatch)` to take `*, prompt_version: PromptVersion = "v1"` and pass it on to `_settings(agent_root, prompt_version=prompt_version)`.
4. Replace the body of `test_golden_run` with a shared comparison, and add the v2 tests:

```python
def _check(
    scenario: Scenario,
    path: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    prompt_version: PromptVersion,
) -> None:
    actual = _serialise(_run(scenario, tmp_path, monkeypatch, prompt_version=prompt_version))
    if os.environ.get(RECORD_ENV) == "1":
        path.parent.mkdir(exist_ok=True)
        path.write_text(actual, encoding="utf-8")
        return
    if not path.is_file():
        pytest.fail(f"{path.name} is missing -- record it with {RECORD_ENV}=1")
    expected = path.read_text(encoding="utf-8")
    if actual != expected:
        diff = "".join(
            difflib.unified_diff(
                expected.splitlines(keepends=True),
                actual.splitlines(keepends=True),
                fromfile=f"golden/{path.relative_to(GOLDEN_DIR)}",
                tofile="actual",
            )
        )
        pytest.fail(f"{scenario.name} drifted from its golden file:\n{diff}", pytrace=False)


@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s.name for s in SCENARIOS])
def test_golden_run(
    scenario: Scenario,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    pinned_zone: None,
) -> None:
    # (keep the existing caplog comment here)
    caplog.set_level(logging.INFO)
    path = GOLDEN_DIR / f"{scenario.name}.json"
    _check(scenario, path, tmp_path, monkeypatch, prompt_version="v1")


# ── prompt v2 (spec 2026-10-17 §7): its own directory; v1 files never move ──

_HANDLE_COMMENT_PLAN = '{"plan":[{"action":"comment","post":"p1","text":"同意，写得很好"}]}'
_UNKNOWN_HANDLE_PLAN = '{"plan":[{"action":"like","post":"p99"}]}'
_V2_NEWS = (
    "**抓取时间：** 2026-10-15 03:00\n"
    "**日报日期：** 2026-10-14\n"
    "\n"
    "### [general] 2026年10月14日 · 日常通用新闻日报\n"
    "- 通用要点一\n"
    "- 通用要点二\n"
    "- 通用要点三\n"
    "- 通用要点四\n"
    "→ 今天是 golden 的一天。\n"
    "\n"
    "### [ai-tech] 2026年10月14日 · AI 与科技圈新闻日报\n"
    "- AI 要点一\n"
    "→ AI 总结。\n"
)


def _plant_v2_news(agent_root: Path) -> None:
    """A structured digest (the v1 fixture has no topics). The board `ai` maps
    to no topic, so only `general` renders and `ai-tech` must not."""
    (agent_root / "context" / "news_today.md").write_text(_V2_NEWS, encoding="utf-8")


def _plant_v2_news_and_probe(agent_root: Path) -> None:
    _plant_v2_news(agent_root)
    _plant_probe_battery(agent_root)


V2_SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        name="cycle_auto_post",
        argv=_CYCLE_AUTO,
        responses=(_POST_PLAN, _DREAM_REPLY),
        setup=_plant_v2_news,
    ),
    Scenario(
        name="cycle_auto_interact_handle",
        argv=_CYCLE_AUTO,
        responses=(_HANDLE_COMMENT_PLAN, _DREAM_REPLY),
        memory=_INITIAL_MEMORY + _ALREADY_POSTED_TODAY,
        setup=_plant_v2_news,
    ),
    Scenario(
        name="cycle_auto_interact_raw_id",
        argv=_CYCLE_AUTO,
        responses=(_COMMENT_PLAN, _DREAM_REPLY),
        memory=_INITIAL_MEMORY + _ALREADY_POSTED_TODAY,
        setup=_plant_v2_news,
    ),
    Scenario(
        name="cycle_unknown_handle",
        argv=_CYCLE_AUTO,
        responses=(_UNKNOWN_HANDLE_PLAN, _DREAM_REPLY),
        setup=_plant_v2_news,
    ),
    Scenario(
        name="act_dry_run_probe_board",
        argv=("act", _NAME, "--dry-run", "--seed", "0", "--probe-board", "probe-lab"),
        responses=(_PROBE_PLAN,),
        setup=_plant_v2_news_and_probe,
    ),
    Scenario(
        name="dream_forced",
        argv=("dream", _NAME),
        responses=(_DREAM_REPLY,),
        last_dream_hours_ago=1,
    ),
)


@pytest.mark.parametrize("scenario", V2_SCENARIOS, ids=[s.name for s in V2_SCENARIOS])
def test_golden_run_v2(
    scenario: Scenario,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    pinned_zone: None,
) -> None:
    caplog.set_level(logging.INFO)
    path = GOLDEN_V2_DIR / f"{scenario.name}.json"
    _check(scenario, path, tmp_path, monkeypatch, prompt_version="v2")


def test_every_v2_scenario_has_a_golden_file_and_no_file_is_orphaned() -> None:
    recorded = {path.stem for path in GOLDEN_V2_DIR.glob("*.json")}
    assert recorded == {scenario.name for scenario in V2_SCENARIOS}


def _v2_requests() -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    for path in sorted(GOLDEN_V2_DIR.glob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        out.extend((path.name, c["args"][0]) for c in record["calls"] if c["seam"] == "backend")
    return out


def test_no_model_label_reaches_a_v2_prompt() -> None:
    labels = roster_model_labels() | {"claude", "opus"}  # + the golden persona's own model
    assert {"claude", "codex", "grok", "cursor"} <= labels
    requests = _v2_requests()
    assert requests
    for name, request in requests:
        text = (request["system"] + "\n" + request["user"]).lower()
        assert sorted(label for label in labels if label in text) == [], name


def test_the_v2_goldens_are_v2_prompts_and_resolve_the_handle_to_the_real_id() -> None:
    users = [request["user"] for _, request in _v2_requests()]
    assert all("## 当前上下文" not in user for user in users)
    record = json.loads((GOLDEN_V2_DIR / "cycle_auto_interact_handle.json").read_text("utf-8"))
    comments = [c for c in record["calls"] if c["call"] == "create_comment"]
    assert comments and comments[0]["args"][0] == _OTHER_POST_ID
```

In the existing `test_every_scenario_has_a_golden_file_and_no_file_is_orphaned`, `GOLDEN_DIR.glob("*.json")` does not descend into `v2/`, so it is unaffected.

- [ ] **Step 2: Run to verify the v2 tests fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_golden_runs.py -q`
Expected: every v1 `test_golden_run[...]` PASSES. Every `test_golden_run_v2[...]` FAILS with "`<name>.json` is missing", and the orphan/label tests fail because there are no files.

- [ ] **Step 3: Record the v2 goldens only**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && SWIL_GOLDEN_RECORD=1 uv run pytest tests/unit/test_golden_runs.py -q -k "golden_run_v2"
cd .. && git diff --exit-code -- agent/tests/unit/golden && ls agent/tests/unit/golden/v2
```

Expected: `git diff` is empty (no v1 file changed) and `v2/` holds the 6 files. Open `v2/cycle_auto_interact_handle.json` and check by eye that its act request starts `## 你在哪里\n这是一个所有账号都由 AI 运行的社交网络。`, contains `p1 @lumen 流明：` and `- 今天已经发过帖子，本轮不发帖。`, and that `create_comment` received `6a0000000000000000000001`.

- [ ] **Step 4: Run the whole golden file again**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_golden_runs.py -q`
Expected: PASS (22 golden runs + the orphan, label and handle checks).

- [ ] **Step 5: Lint, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format tests/unit/test_golden_runs.py && uv run ruff check .
cd .. && git add agent/tests/unit/test_golden_runs.py agent/tests/unit/golden/v2
git commit -m "test(agent): record prompt v2 goldens and grep them for model labels" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: `swil-agent prompt-ab`

**Files:**
- Create: `agent/swil_agent/bench/prompt_ab.py`
- Create: `agent/swil_agent/cli/prompt_ab.py`
- Modify: `agent/swil_agent/cli/__init__.py` (register; docstring list)
- Modify: `agent/tests/unit/test_cli_package.py` (`_COMMANDS` pin + comment)
- Test: `agent/tests/unit/test_prompt_ab.py` (new)

**Interfaces:**
- Consumes: `act_prompt`/`dream_prompt` (Tasks 3, 5, 10, 11), `plan_request(handle_keys=…)` and `guardrail_step(handles=…)` (Task 8), `context_step(world=…)` (Task 2), `compose.act_deps_for`, `compose.embedder_for`, `compose.guard_for`.
- Produces:
  - `bench.prompt_ab.VERSIONS`
  - `ActSample` / `DreamSample` (frozen dataclasses)
  - `reason_key(reason: str) -> str`
  - `arm_of(persona) -> str`
  - `sample_act(*, persona, backend, context, rhythm, version, embedder, clock) -> ActSample`
  - `sample_dream(*, persona, backend, memory_tail, group_memory, version, embedder, clock) -> DreamSample`
  - `summarize_act(samples) -> dict[str, dict[str, dict[str, Any]]]`
  - `summarize_dream(samples) -> dict[str, dict[str, dict[str, Any]]]`
  - `act_passes(v1, v2) -> bool`
  - `build_report(*, phase, k, generated_at, accounts, samples) -> dict[str, Any]`
  - `write_report(report, directory, *, stamp) -> Path`
  - `render_table(report) -> str`
  - CLI `swil-agent prompt-ab [--accounts all|a,b] [--k 2] [--phase act|dream] [--seed N]`. Exit codes: 0 report written; 64 bad `--phase`/`--k`; 66 unknown account; 75 no sample at all.

- [ ] **Step 1: Write the failing tests** (`agent/tests/unit/test_prompt_ab.py`)

```python
"""`prompt-ab` (spec 2026-10-17 §5): one fetched context per account through v1
and v2, nothing posted. Fake backend and fake embedder, no network."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from swil_agent import cli
from swil_agent.bench import prompt_ab as ab
from swil_agent.config import Settings
from swil_agent.models import ActContext, ActSources, RhythmDecision, RhythmPolicy

from ._golden_seams import _FakeEmbedderClient, _patch_cycle_seams
from ._runners import FakeEmbedder, FakeResources, SilentBackend, StubBackend, make_persona

runner = CliRunner()
MUST = RhythmDecision(policy=RhythmPolicy.MUST_POST, prefer_non_post="comment", guidance="g", roll=1)
NO = RhythmDecision(policy=RhythmPolicy.NO_POST, prefer_non_post="comment", guidance="g", roll=99)
POST_ID = "6a0000000000000000000001"
CTX = ActContext(
    today="2026-10-17",
    sources=ActSources(board_posts=[{"id": POST_ID, "text": "t", "author": {"username": "a"}}]),
)


def _clock() -> Any:
    ticks = iter([0.0, 0.25, 1.0, 1.5, 2.0, 2.5])
    return lambda: next(ticks)


@pytest.mark.parametrize(
    ("reason", "key"),
    [
        ("unknown_handle", "unknown_handle"),
        ("rhythm policy no_post", "rhythm_no_post"),
        ("dm recipient not in contacts", "dm_not_contact"),
        ("only one post per round", "extra_post"),
        ("only one echo per round", "extra_echo"),
        (f"duplicate like on {POST_ID}", "duplicate"),
        ("over the 5-action budget", "over_budget"),
        ("nothing mixed into a multi-action plan", "nothing_mixed"),
        ("backend allow-list (post)", "allow_list"),
        ("something new", "other"),
    ],
)
def test_guardrail_reasons_map_to_stable_keys(reason: str, key: str) -> None:
    assert ab.reason_key(reason) == key


def test_a_v2_sample_resolves_handles_and_measures_the_draft() -> None:
    backend = StubBackend('{"plan":[{"action":"post","text":"今天"},{"action":"like","post":"p1"}]}')
    sample = ab.sample_act(
        persona=make_persona(model="opus"),
        backend=backend,
        context=CTX,
        rhythm=MUST,
        version="v2",
        embedder=_FakeEmbedderClient(),
        clock=_clock(),
    )
    assert sample.json_valid is True
    assert (sample.proposed, sample.dropped, sample.posted) == (2, {}, True)
    assert sample.card_sim == 1.0
    assert sample.latency_ms == 250
    assert sample.arm == "claude:opus"
    assert backend.last is not None and sample.user_chars == len(backend.last.user)


def test_an_unknown_handle_is_counted_as_a_drop() -> None:
    sample = ab.sample_act(
        persona=make_persona(),
        backend=StubBackend('{"plan":[{"action":"like","post":"p9"}]}'),
        context=CTX,
        rhythm=NO,
        version="v2",
        embedder=_FakeEmbedderClient(),
        clock=_clock(),
    )
    assert sample.dropped == {"unknown_handle": 1}
    assert sample.card_sim is None


def test_a_silent_backend_is_an_invalid_sample() -> None:
    sample = ab.sample_act(
        persona=make_persona(),
        backend=SilentBackend(),
        context=CTX,
        rhythm=MUST,
        version="v1",
        embedder=_FakeEmbedderClient(),
        clock=_clock(),
    )
    assert (sample.json_valid, sample.proposed, sample.posted) == (False, 0, False)


def _act(version: str, *, valid: bool = True, posted: bool = True, policy: str = "must_post",
         proposed: int = 2, dropped: dict[str, int] | None = None) -> ab.ActSample:
    return ab.ActSample(
        account="zenith", arm="claude:opus", version=version, json_valid=valid,
        proposed=proposed, dropped=dropped or {}, policy=policy, posted=posted,
        card_sim=0.5 if posted else None, user_chars=100, latency_ms=10,
    )


def test_the_act_summary_and_the_pass_bar() -> None:
    samples = [
        _act("v1"), _act("v1", policy="no_post", posted=False),
        _act("v2"), _act("v2", policy="no_post", posted=False, dropped={"unknown_handle": 1}),
    ]
    arms = ab.summarize_act(samples)
    v1, v2 = arms["claude:opus"]["v1"], arms["claude:opus"]["v2"]
    assert v1["jsonValidRate"] == 1.0 and v1["mustPostObeyed"] == 1.0 and v1["noPostObeyed"] == 1.0
    assert v2["dropRate"] == 0.25 and v2["drops"] == {"unknown_handle": 1}
    assert ab.act_passes(v1, v2) is False  # 25 points over v1's 0
    assert ab.act_passes(v1, {**v2, "dropRate": 0.02}) is True  # the +2-point slack, inclusive
    assert ab.act_passes(v1, {**v2, "dropRate": 0.0, "jsonValidRate": 0.5}) is False


def test_a_dream_sample_counts_items_length_and_restated_items() -> None:
    sample = ab.sample_dream(
        persona=make_persona(),
        backend=StubBackend('{"recent": ["一二三", "四五"]}'),
        memory_tail="2026-10-17 | post | id=x | 帖",
        group_memory="",
        version="v2",
        embedder=_FakeEmbedderClient(),
        clock=_clock(),
    )
    assert (sample.json_valid, sample.items, sample.mean_len, sample.restated) == (True, 2, 2.5, 2)


def test_a_dream_with_the_embedder_down_reports_no_restate_count() -> None:
    sample = ab.sample_dream(
        persona=make_persona(),
        backend=StubBackend('{"recent": ["一"]}'),
        memory_tail="",
        group_memory="",
        version="v1",
        embedder=FakeEmbedder(fail_always=True),
        clock=_clock(),
    )
    assert sample.json_valid is True and sample.restated is None


def test_the_report_shape_file_and_table(tmp_path: Path) -> None:
    report = ab.build_report(
        phase="act", k=1, generated_at="2026-10-17T00:00:00Z", accounts=["zenith"],
        samples=[_act("v1"), _act("v2")],
    )
    assert set(report) == {"phase", "k", "generatedAt", "accounts", "arms", "passes", "samples"}
    assert report["passes"] == {"claude:opus": True}
    path = ab.write_report(report, tmp_path / "prompt-ab", stamp="20261017T000000Z")
    assert path.name == "20261017T000000Z-act.json"
    assert json.loads(path.read_text(encoding="utf-8"))["k"] == 1
    assert "claude:opus" in ab.render_table(report)


# ── the command ─────────────────────────────────────────────────────────────

_PERSONA = """---
username: {name}
display_name: 测试
model: claude:opus
board: ai
topics: [alpha]
era: 3
---
# 测试

一个测试用的账号。

## 最近
- 一件旧事
"""


def _roster(root: Path, *names: str, broken: str | None = None) -> None:
    for name in (*names, *([broken] if broken else [])):
        directory = root / "agents" / name
        directory.mkdir(parents=True)
        text = "not a persona" if name == broken else _PERSONA.format(name=name)
        (directory / "personality.md").write_text(text, encoding="utf-8")
        (directory / "memory.md").write_text("2026-10-16 | post | id=x | 帖\n", encoding="utf-8")


def _seams(monkeypatch: pytest.MonkeyPatch, root: Path, resources: FakeResources) -> None:
    settings = Settings(agent_root=root, era_start=datetime(2026, 10, 1, tzinfo=UTC))
    _patch_cycle_seams(
        monkeypatch,
        root,
        settings=settings,
        resources=lambda persona, s: resources,
        backend=lambda persona, s: StubBackend('{"plan":[{"action":"post","text":"今天"}]}'),
    )


def test_the_command_samples_both_versions_and_writes_nothing_to_the_platform(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _roster(tmp_path, "zenith")
    resources = FakeResources()
    _seams(monkeypatch, tmp_path, resources)

    result = runner.invoke(cli.app, ["prompt-ab", "--accounts", "zenith", "--k", "1", "--seed", "0"])

    assert result.exit_code == 0, result.output
    (path,) = (tmp_path / "bench" / "results" / "prompt-ab").glob("*-act.json")
    report = json.loads(path.read_text(encoding="utf-8"))
    assert [s["version"] for s in report["samples"]] == ["v1", "v2"]
    assert "claude:opus" in result.stdout
    for written in (
        resources.created_posts, resources.comments, resources.liked, resources.followed,
        resources.dms, resources.lab_events, resources.profile_patches, resources.post_vectors,
        resources.snapshots, resources.marked_read,
    ):
        assert written == []


def test_a_broken_account_is_skipped_and_the_rest_still_sampled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _roster(tmp_path, "zenith", broken="broken")
    _seams(monkeypatch, tmp_path, FakeResources())
    result = runner.invoke(cli.app, ["prompt-ab", "--k", "1"])
    assert result.exit_code == 0, result.output
    (path,) = (tmp_path / "bench" / "results" / "prompt-ab").glob("*-act.json")
    assert {s["account"] for s in json.loads(path.read_text(encoding="utf-8"))["samples"]} == {
        "zenith"
    }


def test_the_dream_phase_writes_a_dream_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _roster(tmp_path, "zenith")
    _seams(monkeypatch, tmp_path, FakeResources())
    result = runner.invoke(cli.app, ["prompt-ab", "--phase", "dream", "--k", "1"])
    assert result.exit_code == 0, result.output
    assert list((tmp_path / "bench" / "results" / "prompt-ab").glob("*-dream.json"))


@pytest.mark.parametrize(
    ("argv", "code"),
    [
        (["prompt-ab", "--phase", "both"], 64),
        (["prompt-ab", "--k", "0"], 64),
        (["prompt-ab", "--accounts", "nobody"], 66),
    ],
)
def test_bad_invocations_exit_with_their_codes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, argv: list[str], code: int
) -> None:
    _roster(tmp_path, "zenith")
    _seams(monkeypatch, tmp_path, FakeResources())
    assert runner.invoke(cli.app, argv).exit_code == code
```

(Wrap any over-long test line when `ruff format` reports it.)

In `agent/tests/unit/test_cli_package.py`, append `"prompt-ab"` to `_COMMANDS` (after `"measure-status"`) and change the comment above it to: "What `swil-agent --help` lists, in order (`prompt-ab` added 2026-10-17)."

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_ab.py tests/unit/test_cli_package.py -q`
Expected: FAIL (`ModuleNotFoundError: swil_agent.bench.prompt_ab`, and the command list is missing `prompt-ab`).

- [ ] **Step 3: Implement the A/B logic** (`agent/swil_agent/bench/prompt_ab.py`)

```python
"""Offline prompt A/B (spec 2026-10-17 §5): the same fetched context rendered
through v1 and v2, sent to the account's own pinned model, scored. Nothing
here executes a plan, posts, or files a lab event; the backends are the
round's own (tool-less, isolated)."""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Final, Protocol

from swil_agent.act.planner import plan_request
from swil_agent.act.round import guardrail_step
from swil_agent.act.similarity import candidate_post_text, measure_act_similarity
from swil_agent.dream.candidate import parse_recent
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.llm.complete import complete_text
from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.protocol import Backend
from swil_agent.models import ActContext, Persona, Plan, PromptVersion, RhythmDecision
from swil_agent.persona.format import card_text, clamp_recent
from swil_agent.prompts import act_prompt, dream_prompt

VERSIONS: Final[tuple[PromptVersion, ...]] = ("v1", "v2")
RESTATE_THRESHOLD: Final = 0.85
DROP_RATE_SLACK: Final = 0.02

_REASON_KEYS: Final = (
    ("unknown_handle", "unknown_handle"),
    ("backend allow-list", "allow_list"),
    ("nothing mixed", "nothing_mixed"),
    ("rhythm policy no_post", "rhythm_no_post"),
    ("dm recipient", "dm_not_contact"),
    ("only one post", "extra_post"),
    ("only one echo", "extra_echo"),
    ("duplicate ", "duplicate"),
    ("over the ", "over_budget"),
)


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


@dataclass(frozen=True)
class ActSample:
    account: str
    arm: str
    version: str
    json_valid: bool
    proposed: int
    dropped: dict[str, int]
    policy: str
    posted: bool
    card_sim: float | None
    user_chars: int
    latency_ms: int


@dataclass(frozen=True)
class DreamSample:
    account: str
    arm: str
    version: str
    json_valid: bool
    items: int
    mean_len: float | None
    restated: int | None
    user_chars: int
    latency_ms: int


def reason_key(reason: str) -> str:
    """A guardrail veto reason as a stable key (several reasons embed ids)."""
    for prefix, key in _REASON_KEYS:
        if reason.startswith(prefix):
            return key
    return "other"


def arm_of(persona: Persona) -> str:
    return f"{persona.backend}:{persona.model}" if persona.model else persona.backend


def sample_act(
    *,
    persona: Persona,
    backend: Backend,
    context: ActContext,
    rhythm: RhythmDecision,
    version: PromptVersion,
    embedder: Embedder,
    clock: Callable[[], float],
) -> ActSample:
    prompt = act_prompt(version, persona, context, rhythm)
    started = clock()
    plan = plan_request(backend, prompt.request, handle_keys=prompt.handles is not None)
    latency_ms = int((clock() - started) * 1000)
    proposed = plan.actions if plan is not None else []
    guarded = guardrail_step(
        plan=plan or Plan(),
        persona=persona,
        rhythm=rhythm,
        context=context,
        budget=context.action_budget,
        handles=prompt.handles,
    )
    draft = candidate_post_text(proposed)
    card_sim = (
        measure_act_similarity(
            candidate_text=draft,
            card_text=card_text(persona.card),
            prior_texts=[],
            embedder=embedder,
        ).card_sim
        if draft
        else None
    )
    return ActSample(
        account=persona.directory.name,
        arm=arm_of(persona),
        version=version,
        json_valid=plan is not None,
        proposed=len(proposed),
        dropped=dict(Counter(reason_key(v.reason) for v in guarded.vetoed)),
        policy=rhythm.policy.value,
        posted=any(action.kind == "post" for action in proposed),
        card_sim=card_sim,
        user_chars=len(prompt.request.user),
        latency_ms=latency_ms,
    )


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    return max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b, strict=True))))


def _restated(persona: Persona, recent: list[str], embedder: Embedder) -> int | None:
    """How many items sit at cosine >= 0.85 to the card: they restate it."""
    try:
        vectors = embedder.embed([card_text(persona.card), *recent])
        if len(vectors) != len(recent) + 1:
            return None
        return sum(1 for v in vectors[1:] if _cosine(vectors[0], v) >= RESTATE_THRESHOLD)
    except (EmbedderUnavailable, ValueError):
        return None


def sample_dream(
    *,
    persona: Persona,
    backend: Backend,
    memory_tail: str,
    group_memory: str,
    version: PromptVersion,
    embedder: Embedder,
    clock: Callable[[], float],
) -> DreamSample:
    prompt = dream_prompt(version, persona, memory_tail=memory_tail, group_memory=group_memory)
    started = clock()
    try:
        raw = complete_text(backend, prompt.request)
    except BackendUnavailableError:
        raw = ""
    latency_ms = int((clock() - started) * 1000)
    parsed = parse_recent(raw) if raw.strip() else None
    recent = list(clamp_recent(parsed)) if parsed else []
    return DreamSample(
        account=persona.directory.name,
        arm=arm_of(persona),
        version=version,
        json_valid=bool(recent),
        items=len(recent),
        mean_len=sum(len(item) for item in recent) / len(recent) if recent else None,
        restated=_restated(persona, recent, embedder) if recent else None,
        user_chars=len(prompt.request.user),
        latency_ms=latency_ms,
    )


def _rate(hits: int, n: int) -> float | None:
    return hits / n if n else None


def _mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _groups[S: (ActSample, DreamSample)](samples: Sequence[S]) -> dict[tuple[str, str], list[S]]:
    groups: dict[tuple[str, str], list[S]] = {}
    for sample in samples:
        groups.setdefault((sample.arm, sample.version), []).append(sample)
    return groups


def summarize_act(samples: Sequence[ActSample]) -> dict[str, dict[str, dict[str, Any]]]:
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for (arm, version), group in sorted(_groups(samples).items()):
        drops: Counter[str] = Counter()
        for sample in group:
            drops.update(sample.dropped)
        must = [s for s in group if s.policy == "must_post"]
        no = [s for s in group if s.policy == "no_post"]
        out.setdefault(arm, {})[version] = {
            "samples": len(group),
            "jsonValidRate": _rate(sum(s.json_valid for s in group), len(group)),
            "dropRate": _rate(sum(drops.values()), sum(s.proposed for s in group)),
            "drops": dict(sorted(drops.items())),
            "mustPostObeyed": _rate(sum(s.posted for s in must), len(must)),
            "noPostObeyed": _rate(sum(not s.posted for s in no), len(no)),
            "cardSim": _mean([s.card_sim for s in group if s.card_sim is not None]),
            "userChars": _mean([s.user_chars for s in group]),
            "latencyMs": _mean([s.latency_ms for s in group]),
        }
    return out


def summarize_dream(samples: Sequence[DreamSample]) -> dict[str, dict[str, dict[str, Any]]]:
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for (arm, version), group in sorted(_groups(samples).items()):
        measured = [s for s in group if s.restated is not None]
        out.setdefault(arm, {})[version] = {
            "samples": len(group),
            "jsonValidRate": _rate(sum(s.json_valid for s in group), len(group)),
            "meanItems": _mean([s.items for s in group]),
            "meanLength": _mean([s.mean_len for s in group if s.mean_len is not None]),
            "restateShare": _rate(sum(s.restated or 0 for s in measured), sum(s.items for s in measured)),
            "userChars": _mean([s.user_chars for s in group]),
            "latencyMs": _mean([s.latency_ms for s in group]),
        }
    return out


def act_passes(v1: dict[str, Any], v2: dict[str, Any]) -> bool:
    """Spec §5 pass bar for one arm: v2's JSON-valid rate and rhythm obedience
    >= v1's, its guardrail drop rate <= v1's + 2 points. `card_sim` has no bar."""
    for key in ("jsonValidRate", "mustPostObeyed", "noPostObeyed"):
        if v1[key] is not None and v2[key] is not None and v2[key] < v1[key]:
            return False
    return bool((v2["dropRate"] or 0.0) <= (v1["dropRate"] or 0.0) + DROP_RATE_SLACK)


def build_report(
    *,
    phase: str,
    k: int,
    generated_at: str,
    accounts: Sequence[str],
    samples: Sequence[ActSample | DreamSample],
) -> dict[str, Any]:
    acts = [s for s in samples if isinstance(s, ActSample)]
    dreams = [s for s in samples if isinstance(s, DreamSample)]
    arms = summarize_act(acts) if phase == "act" else summarize_dream(dreams)
    report: dict[str, Any] = {
        "phase": phase,
        "k": k,
        "generatedAt": generated_at,
        "accounts": list(accounts),
        "arms": arms,
        "samples": [asdict(s) for s in samples],
    }
    if phase == "act":
        report["passes"] = {
            arm: act_passes(by["v1"], by["v2"]) for arm, by in arms.items() if {"v1", "v2"} <= set(by)
        }
    return report


def write_report(report: dict[str, Any], directory: Path, *, stamp: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{stamp}-{report['phase']}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def _cell(value: object) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value)


def render_table(report: dict[str, Any]) -> str:
    keys = (
        ("jsonValidRate", "dropRate", "mustPostObeyed", "noPostObeyed", "cardSim", "userChars")
        if report["phase"] == "act"
        else ("jsonValidRate", "meanItems", "meanLength", "restateShare", "userChars")
    )
    rows = [("arm", "ver", "n", *keys)]
    for arm, by in report["arms"].items():
        for version, metrics in by.items():
            rows.append((arm, version, str(metrics["samples"]), *(_cell(metrics[k]) for k in keys)))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    lines = ["  ".join(cell.ljust(width) for cell, width in zip(row, widths, strict=True)) for row in rows]
    for arm, ok in report.get("passes", {}).items():
        lines.append(f"{arm}: {'PASS' if ok else 'FAIL'} (spec §5 bar)")
    return "\n".join(lines)
```

(If mypy rejects the PEP 695 constrained `_groups`, replace it with two plain loops, one per sample type.)

- [ ] **Step 4: Implement the command** (`agent/swil_agent/cli/prompt_ab.py`)

```python
"""`prompt-ab`: the offline v1/v2 prompt comparison (spec 2026-10-17 §5).

Per account: the round's own reads with `act --dry-run` semantics (no lease,
no `agentBackend` PATCH, no execute, no lab event), one rhythm draw, then `k`
samples per prompt version against the account's pinned model. On demand only,
never inside a round: it spends about accounts x 2 x k LLM calls. The two-key
runtime switch does not gate it -- it is offline by construction.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC
from pathlib import Path

import typer

from swil_agent.act.round import context_step
from swil_agent.api.client import ApiError
from swil_agent.bench import prompt_ab as ab
from swil_agent.cli import compose
from swil_agent.cli.app import EXIT_NO_ACTION, EXIT_NO_SUCH_ACCOUNT, EXIT_OK, EXIT_USAGE
from swil_agent.cli.errors import enforce_era_gate, load_persona_or_raise_setup_error, skip_for_exception
from swil_agent.config import Settings
from swil_agent.dream.candidate import group_memory_digest
from swil_agent.embedder.client import EmbedderClient
from swil_agent.persona.source import PersonaSource

logger = logging.getLogger("swil_agent.cli")

_PHASES = ("act", "dream")
_MEMORY_TAIL_LINES = 30  # the dream's own window (dream/round.py)
_GROUP_LIMIT = 30


def _roster(agent_root: Path) -> list[str]:
    return sorted(path.parent.name for path in (agent_root / "agents").glob("*/personality.md"))


def _account_samples(
    name: str,
    source: PersonaSource,
    settings: Settings,
    embedder: EmbedderClient,
    *,
    phase: str,
    k: int,
    seed: int | None,
) -> list[ab.ActSample] | list[ab.DreamSample]:
    persona = load_persona_or_raise_setup_error(source, name)
    persona, deps, finish = compose.act_deps_for(
        persona, source, settings, dry_run=True, budget=5, seed=seed, probe_board=None
    )
    if finish is not None:
        deps = finish(deps)
    if phase == "dream":
        tail = "\n".join(deps.memory_text.splitlines()[-_MEMORY_TAIL_LINES:])
        try:
            notes = deps.resources.notifications(limit=_GROUP_LIMIT, unread_only=False)
        except ApiError:
            notes = []
        group = group_memory_digest(notes)
        return [
            ab.sample_dream(
                persona=persona, backend=deps.backend, memory_tail=tail, group_memory=group,
                version=version, embedder=embedder, clock=time.monotonic,
            )
            for version in ab.VERSIONS
            for _ in range(k)
        ]
    step = context_step(
        resources=deps.resources,
        persona=persona,
        memory_text=deps.memory_text,
        now=deps.now,
        rng=deps.rng,
        budget=deps.budget,
        context_now=deps.context_now,
        feed_context=deps.feed_context,
        era_start=settings.era_start,
        post_probability=settings.post_probability,
        post_ceiling=settings.post_ceiling_per_day,
        world=deps.world,
    )
    return [
        ab.sample_act(
            persona=persona, backend=deps.backend, context=step.context, rhythm=step.rhythm,
            version=version, embedder=embedder, clock=time.monotonic,
        )
        for version in ab.VERSIONS
        for _ in range(k)
    ]


def prompt_ab(
    accounts: str = typer.Option("all", "--accounts", help="`all`, or comma-separated names."),
    k: int = typer.Option(2, "--k", help="Samples per account and prompt version."),
    phase: str = typer.Option("act", "--phase", help="act | dream"),
    seed: int | None = typer.Option(None, "--seed", help="Seed each account's rhythm roll."),
) -> None:
    """Compare prompt v1 and v2 offline on live, read-only contexts; never posts.

    Writes `bench/results/prompt-ab/<UTC stamp>-<phase>.json` and prints a table.
    Exit 0 written, 64 bad --phase/--k, 66 unknown account, 75 no sample at all.
    """
    if phase not in _PHASES or k < 1:
        typer.echo("--phase must be act or dream and --k at least 1", err=True)
        raise typer.Exit(EXIT_USAGE)
    settings = compose.load_settings()
    enforce_era_gate(settings)
    roster = _roster(settings.agent_root)
    names = roster if accounts == "all" else [n.strip() for n in accounts.split(",") if n.strip()]
    missing = [name for name in names if name not in roster]
    if missing:
        typer.echo(f"no such account: {', '.join(missing)}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT)

    source = compose.persona_source_for(settings)
    embedder = compose.embedder_for(settings)
    guard = compose.guard_for(settings)
    samples: list[ab.ActSample | ab.DreamSample] = []
    guard.up()
    try:
        for name in names:
            try:
                samples.extend(
                    _account_samples(name, source, settings, embedder, phase=phase, k=k, seed=seed)
                )
            except Exception as exc:
                skip_for_exception(name, exc)
    finally:
        guard.down()
    if not samples:
        raise typer.Exit(EXIT_NO_ACTION)

    generated = compose.now(UTC)
    report = ab.build_report(
        phase=phase,
        k=k,
        generated_at=generated.strftime("%Y-%m-%dT%H:%M:%SZ"),
        accounts=names,
        samples=samples,
    )
    path = ab.write_report(
        report,
        settings.agent_root / "bench" / "results" / "prompt-ab",
        stamp=generated.strftime("%Y%m%dT%H%M%SZ"),
    )
    typer.echo(ab.render_table(report))
    typer.echo(f"report: {path}")
    raise typer.Exit(EXIT_OK)
```

`agent/swil_agent/cli/__init__.py`: add `from swil_agent.cli import prompt_ab as _prompt_ab`, add `app.command("prompt-ab")(_prompt_ab.prompt_ab)` directly after the `measure-status` line, and add `` * `prompt_ab.py` -- `prompt-ab`, the offline v1/v2 prompt comparison; `` to the module docstring list.

- [ ] **Step 5: Run the tests**

Run: `cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run pytest tests/unit/test_prompt_ab.py tests/unit/test_cli_package.py tests/unit/test_architecture.py tests/unit/test_llm_isolation.py tests/unit/test_backends.py -q`
Expected: PASS. Run `tests/unit/test_prompt_ab.py` twice more (testing standards §2: three runs for a new file).

- [ ] **Step 6: Lint, type-check, commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv run ruff format swil_agent tests/unit/test_prompt_ab.py tests/unit/test_cli_package.py && uv run ruff check . && uv run mypy
cd .. && git add agent/swil_agent/bench/prompt_ab.py agent/swil_agent/cli/prompt_ab.py agent/swil_agent/cli/__init__.py agent/tests/unit/test_prompt_ab.py agent/tests/unit/test_cli_package.py
git commit -m "feat(agent): add prompt-ab, an offline v1/v2 prompt comparison" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Docs and the full gate

**Files:**
- Modify: `docs/13-observation-lab.md` (new dated change point, first under `## Change points`)
- Modify: `docs/12-handoff.md` (a new section after "Where things stand"; bump `last-updated`)
- Modify: `CLAUDE.md` (agent section: prompts package, `PROMPT_VERSION`, `prompt-ab`; one command-table row)

- [ ] **Step 1: `docs/13-observation-lab.md`.** Insert directly under `## Change points`, above `### 2026-10-16 — …`:

```markdown
### 2026-10-17 — prompt versioning and prompt size on the card (v2 built, off)

No change to what any persona reads: every act and dream prompt is byte-identical
to round 1 (the 16 golden runs and the full-text pins are the oracle). What changed:

- Persona-facing text lives in `agent/swil_agent/prompts/`: `v1/` is the Era 3 text
  moved verbatim, `v2/` the lean prompt of the 2026-10-17 runtime-prompt-v2 spec.
  Callers go through one seam, `prompts.act_prompt` / `prompts.dream_prompt`.
- `PROMPT_VERSION` (default `v1`) selects it; `v2` is refused unless
  `PROMPT_V2_ENABLED=1` as well. **v2 is off** until the confirmatory window freezes
  and a dated amendment (or Era 4) switches it on; that amendment defines how
  `promptVersion` deviations are treated in `/agents/arms`.
- `cycle_run` cards now carry `promptVersion` and the prompt size in characters,
  flattened because event metrics are scalars:
  `promptChars{System,Preamble,Context,Feeds,News,Threads,Memory,Social,Tail,Total}`
  for act and `dreamPromptChars{System,User}` for dream, `null` when that phase
  rendered no prompt. Cards before this date have neither key; read them as `v1`.
  Nothing in `/agents/arms` reads them yet, so no number moves.
- `swil-agent prompt-ab` compares v1 and v2 offline on live, read-only contexts
  (nothing executed, posted or filed); reports go to `agent/bench/results/prompt-ab/`.
```

- [ ] **Step 2: `docs/12-handoff.md`.** Set `last-updated: 2026-10-17` in the front matter and insert after the "Where things stand" section:

```markdown
## Runtime prompt v2 — 2026-10-17

**Status: built locally on `feat/runtime-prompt-v2`, v2 OFF, nothing deployed.**
Spec `docs/superpowers/specs/2026-10-17-runtime-prompt-v2-design.md`, plan
`docs/superpowers/plans/2026-10-17-runtime-prompt-v2.md`.

- Phase A (live now, no persona-visible change): `swil_agent/prompts/` package with
  the v1 text moved verbatim; `PROMPT_VERSION` / `PROMPT_V2_ENABLED`; `promptVersion`
  and flattened `promptChars*` on every `cycle_run` card; `ActContext.sources` keeps
  the rows each prompt block was rendered from; the dead `backend_action_constraint`
  is gone.
- Phase B (built, off): v2 act prompt (one deduped 30-post list with `p`/`c` handles,
  board news ≤ 2,000 chars, id-free memory) and v2 dream prompt; handles resolve in
  `guardrail_step` (`unknown_handle`, raw ids still accepted). v2 goldens in
  `agent/tests/unit/golden/v2/`.
- Validate before any switch: `uv run --project agent swil-agent prompt-ab --k 2`
  and `--phase dream`. Switching on needs spec §6: the 12th completed round, a
  passing A/B report, a dated amendment, then both keys in `agent/.env`.
```

- [ ] **Step 3: `CLAUDE.md`.** In the "Persona format v2" section, after the "System prompt = card + 最近 …" bullet, add:

```markdown
- **Prompts are versioned.** Every persona-facing string lives in
  `agent/swil_agent/prompts/` (`v1/` = the Era 3 text, `v2/` = the lean prompt, built
  and OFF); callers use `prompts.act_prompt` / `prompts.dream_prompt` only.
  `PROMPT_VERSION` (default `v1`) selects it and `v2` is refused without
  `PROMPT_V2_ENABLED=1`; inside a round `.env` wins, so the switch is one `.env`
  edit, made only after the confirmatory window freezes, under a dated amendment.
  v1 goldens are `agent/tests/unit/golden/*.json`, v2 goldens `golden/v2/`.
```

In the `swil-agent …` command table, add the row:

```markdown
| `prompt-ab [--accounts all\|a,b] [--k 2] [--phase act\|dream] [--seed N]` | Offline v1/v2 prompt comparison on live read-only contexts; never posts. Report in `agent/bench/results/prompt-ab/`. On demand, never inside a round. |
```

- [ ] **Step 4: Run the full agent gate, then `ci:check`**

```bash
cd /Users/supwils/supwilsoft/live/swil-social/agent && uv lock --check --offline && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest --cov-fail-under=97
cd .. && npm run ci:check
```

Expected: every step green and agent coverage ≥ 97%. If coverage drops, add the missing tests to the task that owns the uncovered code. Do not lower the floor. Run the new test files (`test_act_sources.py`, `test_prompt_seam.py`, `test_handles.py`, `test_prompt_v2_parts.py`, `test_prompt_v2_act.py`, `test_prompt_v2_dream.py`, `test_prompt_ab.py`) twice more.

- [ ] **Step 5: Confirm the boundaries**

```bash
cd /Users/supwils/supwilsoft/live/swil-social && git diff main --stat -- agent/swil_agent/llm/backends agent/swil_agent/llm/isolation.py agent/agents agent/archive docs/superpowers/specs
```

Expected: no output. Isolation, the roster, the archive and the frozen specs are untouched.

- [ ] **Step 6: Commit**

```bash
cd /Users/supwils/supwilsoft/live/swil-social && git add docs/13-observation-lab.md docs/12-handoff.md CLAUDE.md
git commit -m "docs: record prompt versioning and the off-by-default prompt v2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The branch now holds 14 local commits. Squash them to 2–3 outcome commits before landing on `main` (for example: Phase A refactor + card, Phase B prompt v2 + goldens, prompt-ab + docs). **Do not push.**

---

## Self-review

**Spec coverage.**

| Spec item | Task |
|---|---|
| A1 prompts package + seam | 3, 4, 5, 6 |
| A1 typed rhythm decision | 4 |
| A2 two-key setting | 1 |
| A3 card fields (flattened per R2; analysis unchanged) | 7 |
| A4 dead code | 6 |
| Phase A acceptance (zero golden/pin diff; seam, gate and card tests) | every Phase A step 4/8 |
| B1 merged posts, cap, line format | 10 |
| B1 threads | 10 |
| B1 handles | 8, 10 |
| B1 news | 9, 10 |
| B1 notifications, DMs, contacts, memory | 10 |
| B1 single date | 10 |
| B2 text | 10 |
| B3 dream | 9, 11 |
| §5 prompt-ab, act and dream (fake backend/embedder) | 13 |
| §7 v2 goldens | 12 |
| §7 label grep | 10, 11, 12 |
| §7 dream id-free | 9, 11 |
| Docs | 14 |

§6 (switching on) is explicitly out of scope.

**Placeholder scan.** Two steps are deliberately cut-and-paste moves (Task 3 v1 strings, Task 6 template). Task 3 also shows the full text. The paste comment in Task 6's `now.py` is an instruction that is deleted when the literal is pasted. No step says "TBD" or "similar to".

**Type consistency.** These names are used identically across tasks:

- `RenderedPrompt(version, request, chars, handles)`
- `act_prompt(version, persona, ctx, rhythm)`
- `dream_prompt(version, persona, *, memory_tail, group_memory)`
- `plan_request(backend, request, *, handle_keys)`
- `guardrail_step(..., handles)`
- `context_step(..., world)`
- `CycleState` keys `prompt_version`, `act_prompt_chars`, `dream_prompt_chars`, `handles`
- `ACT_PROMPT_PARTS`, `DREAM_PROMPT_PARTS`

**Review Focus.** Each of the five lines has a named test in its owning task (Tasks 1, 4, 8, 9, 10, 12, 13).
