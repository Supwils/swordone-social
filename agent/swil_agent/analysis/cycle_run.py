"""The cycle_run card -- one ledger row per finished cycle (spec §4).

Per-action `cycle` events already fire from the executor. This module builds
the rollup `/lab` reads as runtime health: `metrics.kind == "cycle_run"` on
the existing `cycle` type. Missing-sampler warn events are the audit rows;
the card copies the flag. Both are fail-loud on the ledger and fail-soft on
the round outcome.

Era 3 dropped `gateStatus` and `missingRuleCheck` (the drift gate and the
rule check are gone); the server reads both as optional for older rows.

S2 added `roundId` (the round the cycle ran under; omitted for a thread
checkpointed before S2) and `missingPostVector` (a post landed but its vector
was not filed). Neither changes the card's outcome.

Spec 2026-10-17 A3 added `promptVersion` and the prompt size per part,
flattened to scalar keys because event metrics are scalars
(`promptChars<Part>` for act, `dreamPromptChars<Part>` for dream; `null` when
that phase rendered no prompt). `/agents/arms` does not read them yet.

This package must not import `graph/` (architecture test). The builder is
pure: it takes scalars and returns a `LabEvent`.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from swil_agent.api.dto import LabEvent
from swil_agent.models import ActOutcome, ActResult
from swil_agent.prompts.types import ACT_PROMPT_PARTS, DREAM_PROMPT_PARTS

CYCLE_RUN_KIND: Final = "cycle_run"


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

MISSING_SAMPLER_BEHAVIOR: Final = "behavior_snapshot"


def build_missing_sampler_event(*, sampler: str) -> LabEvent:
    """Audit row for one sampler that raised or returned empty.

    Deliberately has no `metrics.kind`. Readers MUST ignore events without
    `kind=cycle_run` when building the runtime strip; this row is the
    per-sampler trail, not the rollup.
    """
    return LabEvent(
        type="cycle",
        phase="act",
        outcome="warn",
        summary=f"missingSampler {sampler}",
        metrics={"missingSampler": sampler},
    )


def _card_outcome(
    *,
    act_outcome: ActOutcome | None,
    missing_behavior_snapshot: bool,
) -> str:
    """Spec §4 mapping, in listed order: fail, then warn, then skip, else success."""
    if act_outcome in (ActOutcome.OFFLINE, ActOutcome.BACKEND_UNAVAILABLE):
        return "fail"
    if missing_behavior_snapshot:
        return "warn"
    if act_outcome in (ActOutcome.PLANNER_EMPTY, ActOutcome.VETOED_EMPTY):
        return "skip"
    return "success"


def build_cycle_run_event(
    *,
    username: str,
    attempted: int,
    landed: int,
    act_outcome: ActOutcome | None,
    grants_dream: bool,
    dream_accepted: bool | None,
    missing_behavior_snapshot: bool,
    duration_ms: int,
    backend: str,
    model: str,
    round_id: str | None,
    missing_post_vector: bool,
    prompt_version: str,
    act_prompt_chars: Mapping[str, int] | None,
    dream_prompt_chars: Mapping[str, int] | None,
) -> LabEvent:
    """One cycle_run card. Metric keys match spec §4 exactly -- no aliases.
    `backend`/`model` are the values the cycle's LLM client was built from."""
    act_label = act_outcome.value if act_outcome is not None else "unknown"
    metrics: dict[str, Any] = {
        "kind": CYCLE_RUN_KIND,
        "attempted": attempted,
        "landed": landed,
        "actOutcome": act_label,
        "grantsDream": grants_dream,
        "dreamAccepted": dream_accepted,
        "missingBehaviorSnapshot": missing_behavior_snapshot,
        "durationMs": duration_ms,
        "backend": backend,
        "model": model,
        "missingPostVector": missing_post_vector,
    }
    metrics["promptVersion"] = prompt_version
    for part in ACT_PROMPT_PARTS:
        metrics[_act_key(part)] = act_prompt_chars.get(part) if act_prompt_chars else None
    for part in DREAM_PROMPT_PARTS:
        metrics[_dream_key(part)] = dream_prompt_chars.get(part) if dream_prompt_chars else None
    if round_id is not None:
        metrics["roundId"] = round_id
    return LabEvent(
        type="cycle",
        phase="act",
        outcome=_card_outcome(
            act_outcome=act_outcome,
            missing_behavior_snapshot=missing_behavior_snapshot,
        ),
        summary=f"cycle_run {username} {act_label}",
        metrics=metrics,
    )


def grants_dream_for(act_outcome: ActOutcome | None) -> bool:
    """`ActResult.grants_dream`, with an undecided outcome denying nothing."""
    if act_outcome is None:
        return True
    return ActResult(outcome=act_outcome).grants_dream
