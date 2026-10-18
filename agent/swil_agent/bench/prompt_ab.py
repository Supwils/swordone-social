"""Offline prompt A/B (spec 2026-10-17 §5): the same fetched context rendered
through v1 and v2, sent to the account's own pinned model, scored. Nothing
here executes a plan, posts, or files a lab event; the backends are the
round's own (tool-less, isolated).

The rhythm is assigned, not rolled (`assign_policies`): within an arm the
accounts alternate must-post / no-post, and v1 and v2 see the same verdict,
so every arm measures both directions and every pair is symmetric."""

from __future__ import annotations

import json
import random
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Final, Literal

from swil_agent.act.planner import plan_attempt
from swil_agent.act.round import guardrail_step
from swil_agent.act.similarity import Embedder, candidate_post_text, measure_act_similarity
from swil_agent.dream.round import dream_reply
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.embedder.vectors import clamped_cosine
from swil_agent.llm.protocol import Backend
from swil_agent.models import (
    ActContext,
    Persona,
    Plan,
    PromptVersion,
    RhythmDecision,
    RhythmPolicy,
)
from swil_agent.persona.format import card_text
from swil_agent.persona.rhythm import decide_rhythm
from swil_agent.prompts import act_prompt, dream_prompt

VERSIONS: Final[tuple[PromptVersion, ...]] = ("v1", "v2")
RESTATE_THRESHOLD: Final = 0.85
DROP_RATE_SLACK: Final = 0.02
# Rates are float quotients: 17/100 - 3/20 is 0.020000000000000018.
_RATE_TOLERANCE: Final = 1e-9
UNMEASURED: Final = "unmeasured"
"""An obedience rate with no JSON-valid sample of that rhythm direction."""

Verdict = Literal["PASS", "FAIL", "UNMEASURED"]

_OBEDIENCE: Final = ("mustPostObeyed", "noPostObeyed")
# The roll `decide_rhythm` draws, fixed at the end of the scale that gives
# the assigned verdict (1 hits any probability >= 1, 100 misses any < 100).
_ASSIGNED_ROLL: Final = {RhythmPolicy.MUST_POST: 1, RhythmPolicy.NO_POST: 100}

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
    backend_unavailable: bool = False
    """The backend raised unavailable: an outage, not an invalid reply."""


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


def assign_policies(arms: Mapping[str, str]) -> dict[str, RhythmPolicy]:
    """Account -> assigned rhythm direction: within each arm, its accounts
    sorted by name (the directory name, which equals the username) alternate
    must-post, no-post. Deterministic, so a re-run samples the same design."""
    by_arm: dict[str, list[str]] = {}
    for account, arm in arms.items():
        by_arm.setdefault(arm, []).append(account)
    directions = (RhythmPolicy.MUST_POST, RhythmPolicy.NO_POST)
    return {
        account: directions[index % 2]
        for accounts in by_arm.values()
        for index, account in enumerate(sorted(accounts))
    }


class _FixedRoll(random.Random):
    """A `random.Random` whose one `randint` answer is fixed."""

    def __init__(self, roll: int) -> None:
        super().__init__(0)
        self._roll = roll

    def randint(self, a: int, b: int) -> int:
        _ = a, b
        return self._roll


def assigned_rhythm(
    policy: RhythmPolicy, *, posts_today: int, probability: int, ceiling: int
) -> RhythmDecision:
    """The round's own `decide_rhythm` with the roll fixed to give `policy`.

    An account at the daily ceiling keeps the ceiling verdict, and a
    probability of 0 or 100 keeps the only verdict it allows: the prompt
    never shows a verdict the round could not reach.
    """
    return decide_rhythm(
        posts_today,
        _FixedRoll(_ASSIGNED_ROLL[policy]),
        probability=probability,
        ceiling=ceiling,
    )


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
    """One planner call on `context` under `version`, guarded and measured.

    The plan is never executed: the guardrails run only to count what they
    would drop, and the draft post is embedded only for its card similarity.
    """
    prompt = act_prompt(version, persona, context, rhythm)
    started = clock()
    plan, unavailable = plan_attempt(
        backend, prompt.request, handle_keys=prompt.handles is not None
    )
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
        backend_unavailable=unavailable,
    )


def _restated(persona: Persona, recent: list[str], embedder: Embedder) -> int | None:
    """How many items sit at cosine >= 0.85 to the card: they restate it."""
    try:
        vectors = embedder.embed([card_text(persona.card), *recent])
        if len(vectors) != len(recent) + 1:
            return None
        card, *items = vectors
        return sum(1 for v in items if clamped_cosine(card, v) >= RESTATE_THRESHOLD)
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
    """One dream call under `version`, parsed and clamped exactly as the
    round's dream (`dream_reply`); nothing is written."""
    prompt = dream_prompt(version, persona, memory_tail=memory_tail, group_memory=group_memory)
    started = clock()
    recent = dream_reply(backend, prompt.request).recent or []
    latency_ms = int((clock() - started) * 1000)
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


def _obeyed(hits: int, n: int) -> float | str:
    return hits / n if n else UNMEASURED


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
        # An outage is no evidence about the prompt: it leaves the JSON-valid
        # and obedience denominators and is counted on its own. A JSON-invalid
        # sample is already counted by `jsonValidRate`; it is no evidence about
        # obedience either way.
        reached = [s for s in group if not s.backend_unavailable]
        valid = [s for s in reached if s.json_valid]
        must = [s for s in valid if s.policy == "must_post"]
        no = [s for s in valid if s.policy == "no_post"]
        out.setdefault(arm, {})[version] = {
            "samples": len(group),
            "backendUnavailable": len(group) - len(reached),
            "jsonValidRate": _rate(len(valid), len(reached)),
            "dropRate": _rate(sum(drops.values()), sum(s.proposed for s in group)),
            "drops": dict(sorted(drops.items())),
            "mustPostObeyed": _obeyed(sum(s.posted for s in must), len(must)),
            "noPostObeyed": _obeyed(sum(not s.posted for s in no), len(no)),
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
            "restateShare": _rate(
                sum(s.restated or 0 for s in measured), sum(s.items for s in measured)
            ),
            "userChars": _mean([s.user_chars for s in group]),
            "latencyMs": _mean([s.latency_ms for s in group]),
        }
    return out


def act_verdict(v1: dict[str, Any], v2: dict[str, Any]) -> Verdict:
    """Spec §5 pass bar for one arm: v2's JSON-valid rate and rhythm obedience
    >= v1's, its guardrail drop rate <= v1's + 2 points. `card_sim` has no bar.

    FAIL when any measured component misses the bar; otherwise UNMEASURED
    when either obedience rate has no sample in either version (an
    unmeasured direction never passes); otherwise PASS.
    """
    # No reachable sample (every call an outage) leaves no JSON-valid rate.
    unmeasured = v1["jsonValidRate"] is None or v2["jsonValidRate"] is None
    if not unmeasured and v2["jsonValidRate"] < v1["jsonValidRate"] - _RATE_TOLERANCE:
        return "FAIL"
    for key in _OBEDIENCE:
        if UNMEASURED in (v1[key], v2[key]):
            unmeasured = True
        elif v2[key] < v1[key] - _RATE_TOLERANCE:
            return "FAIL"
    drop_rise = (v2["dropRate"] or 0.0) - (v1["dropRate"] or 0.0)
    if drop_rise > DROP_RATE_SLACK + _RATE_TOLERANCE:
        return "FAIL"
    return "UNMEASURED" if unmeasured else "PASS"


def build_report(
    *,
    phase: str,
    k: int,
    generated_at: str,
    accounts: Sequence[str],
    samples: Sequence[ActSample | DreamSample],
    expected_arms: Sequence[str] = (),
    skipped_accounts: Sequence[str] = (),
) -> dict[str, Any]:
    """The report. `expected_arms` are the arms of the WHOLE roster, tested or
    not: one with no sample at all (not selected, or every account skipped) is
    listed in `unpairedArms` with those missing a version. `skipped_accounts`
    are the selected accounts that failed to load or to sample. `allArmsPass`
    (act only) is true only when there is a paired arm, no arm is unpaired
    and every paired arm's verdict is PASS."""
    acts = [s for s in samples if isinstance(s, ActSample)]
    dreams = [s for s in samples if isinstance(s, DreamSample)]
    arms = summarize_act(acts) if phase == "act" else summarize_dream(dreams)
    paired = sorted(arm for arm, by in arms.items() if set(VERSIONS) <= set(by))
    unpaired = sorted((set(expected_arms) | set(arms)) - set(paired))
    report: dict[str, Any] = {
        "phase": phase,
        "k": k,
        "generatedAt": generated_at,
        "accounts": list(accounts),
        "skippedAccounts": list(skipped_accounts),
        "arms": arms,
        "unpairedArms": unpaired,
        "samples": [asdict(s) for s in samples],
    }
    if phase == "act":
        passes = {arm: act_verdict(arms[arm]["v1"], arms[arm]["v2"]) for arm in paired}
        report["passes"] = passes
        report["allArmsPass"] = (
            bool(passes) and not unpaired and all(verdict == "PASS" for verdict in passes.values())
        )
    return report


def write_report(report: dict[str, Any], directory: Path, *, stamp: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{stamp}-{report['phase']}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def _cell(key: str, value: float | str | None) -> str:
    """A rate or a mean to two places (`userChars` as a whole number); `None`
    had nothing to measure, a string (`unmeasured`) prints as itself."""
    if value is None:
        return "-"
    if isinstance(value, str):
        return value
    return str(round(value)) if key == "userChars" else f"{value:.2f}"


def render_table(report: dict[str, Any]) -> str:
    keys = (
        ("jsonValidRate", "dropRate", "mustPostObeyed", "noPostObeyed", "cardSim", "userChars")
        if report["phase"] == "act"
        else ("jsonValidRate", "meanItems", "meanLength", "restateShare", "userChars")
    )
    rows = [("arm", "ver", "n", *keys)]
    for arm, by in report["arms"].items():
        for version, metrics in by.items():
            cells = (_cell(key, metrics[key]) for key in keys)
            rows.append((arm, version, str(metrics["samples"]), *cells))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    lines = [
        "  ".join(cell.ljust(width) for cell, width in zip(row, widths, strict=True))
        for row in rows
    ]
    for arm, verdict in report.get("passes", {}).items():
        lines.append(f"{arm}: {verdict} (spec §5 bar)")
    if "allArmsPass" in report:
        lines.append(f"all arms pass: {'yes' if report['allArmsPass'] else 'no'}")
    lines.append(f"unpaired arms: {', '.join(report['unpairedArms']) or 'none'}")
    return "\n".join(lines)
