"""Data types shared across the agent runtime.

Field names use snake_case; the wire format uses camelCase. Conversion happens
at the API boundary (api/resources.py), never here.
"""

from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ActionKind = Literal["post", "comment", "like", "follow", "dm", "echo", "nothing"]

# The value of a persona's `Read` bullet that means "read the whole platform"
# -- the widest-input arm of the input-diversification experiment (Phase B
# task 3, spec §8.3). An ABSENT `Read` bullet means the same thing, which is
# why 22 of the 23 accounts on the roster do not carry one today.
#
# It lives here, in the lowest layer, rather than in `act/context.py` beside
# the code that acts on it, because `ActContext.board_read` below defaults to
# it and `models` sits UNDER `act/` in spec §5.2's dependency order. A literal
# `"global"` in one of the two places is exactly the kind of duplicate a later
# edit changes on one side only.
GLOBAL_READ_SCOPE = "global"


class Action(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: ActionKind
    text: str | None = None
    post_id: str | None = None
    parent_id: str | None = None
    username: str | None = None
    image_topic: str | None = None


class Plan(BaseModel):
    actions: list[Action] = Field(default_factory=list)


class VetoedAction(BaseModel):
    action: Action
    reason: str


class ActionResult(BaseModel):
    """One executed action's outcome.

    `conversation_id` (fix round 1, task-7 review item 4) is populated only
    for a landed `dm`: `resource_id` stays the created MESSAGE id, matching
    every other kind's "id of the thing I created" convention, so this is a
    second, dm-only field rather than overloading `resource_id` or `detail`
    (the latter is already a free-text failure/note channel matched by
    shape elsewhere -- see `act/round.py`'s `_PARENT_UNUSABLE_DETAIL`
    sentinel). It lets `act/round.py`'s memory-line writer record
    `conversationId=...` the way `swil.sh:711`'s `_remember` does, instead
    of the `messageId=` substitute this task shipped with initially.

    `call_succeeded` (ruling R19) answers a DIFFERENT question from `landed`:
    did the underlying `swil.sh` subcommand actually exit 0 -- i.e. did the
    write go through -- rather than does this action count toward the round's
    landed tally. For every action kind the two are equal, and
    `act/executor.py`'s `_outcome` derives one from the other by default so
    they cannot drift apart by accident. `follow` is the ONE kind where they
    legitimately differ: `auto-run.sh:250-252` returns 0 whether the follow
    landed or 409'd ("Deliberately 0 either way: 'already following' is the
    common outcome and is not a failed round"), while `swil.sh`'s own `follow`
    case never reaches `_remember` on that 409 -- `_curl` returns 1 for any
    status >= 400 (swil.sh:132-135) and `set -euo pipefail` aborts the case at
    the failing pipeline. So a 409 is a landed round AND an unwritten memory
    line, which needs two fields to say.

    Deliberately a typed field rather than a sentinel matched out of `detail`
    (the `_PARENT_UNUSABLE_DETAIL` shape above): the follow-failure detail is
    a COMPOSED string (`f"likely already following: {...}"`), so a reword
    would silently restore the bug -- the same defect class as the
    `DreamVerdict.reason` equality check that lost the embedder-unreachable
    warning.
    """

    action: Action
    landed: bool
    resource_id: str | None = None
    detail: str | None = None
    conversation_id: str | None = None
    call_succeeded: bool = True


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
    follow_topics: list[str] = Field(default_factory=list)
    backend: str = "claude"
    # The `AI Backend:` bullet AS WRITTEN, `None` when the file has none --
    # where `backend` above is the same value already defaulted to "claude".
    # Keeping both is what lets `llm/selection.py` rank a global
    # `SWIL_LLM_BACKEND` above an account that declares nothing while leaving
    # an account that declares `claude` explicitly alone. hodlge / lvchuang /
    # zaofan shipped with no bullet until 2026-08-25; they now declare `codex`.
    declared_backend: str | None = None
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


class DriftMeasurement(BaseModel):
    """Everything one dream measured about its own drift, recorded whatever
    the gate then decided with it (Phase B task 1; spec §8.1).

    This type exists because the `/lab` drift series was CENSORED: the
    numbers were computed only as an input to an accept/reject decision, and
    only an ACCEPTED dream left a `personalitysnapshots` row behind. The
    recorded distribution was therefore "drift among the versions the gate
    allowed", not drift -- and a threshold calibrated on it is calibrated on
    its own survivors. Every path through `dream.gate.evaluate_candidate`
    now produces one of these, INCLUDING the structural-failure path that
    returns before a single embed is attempted.

    `None` is a first-class value here and is NOT interchangeable with
    `0.0`: it means "this quantity was not computed", which is a different
    fact from "this quantity was measured and came out at zero". A
    structural rejection or an embedder outage records `None`; recording
    `0.0` would put a fake "maximally drifted" point into the calibration
    sample, which is the mirror image of the censoring this type exists to
    end.

    The three quantities, and why there are three:

      * `anchor_sim` -- cosine(anchor, candidate). POSITION: how far the
        candidate sits from the account's origin. This is the same number as
        `DreamVerdict.scalar_sim` and the same number today's scalar gate
        decides on; carried here as well because the verdict is the gate's
        working state while this is the record.
      * `step_sim` -- cosine(current personality.md, candidate). STEP SIZE:
        how far THIS dream moves the account, independent of where it
        already stood. A position gate cannot see a series of small steps
        walking an account away from its anchor and cannot tell a large
        single jump from a small one that happens to land far out.
      * `aspects` -- the per-aspect (values/style/topic) similarities, when
        the aspect pipeline produced them; `None` when it did not (scalar
        mode, a dead distiller, or a failed card embed).

    `embedder_ok` is FALSE only when an embed attempted FOR THIS
    MEASUREMENT raised `EmbedderUnavailable` -- i.e. the whole-doc embeds
    behind `anchor_sim`/`step_sim`. A path that attempted none (the
    structural rejection, which returns before any embedding) records
    `True`: it observed no outage, and its `None` sims already say the
    measurement did not happen. Counting `embedder_ok is False` therefore
    counts embedder outages, not "rounds with no numbers".

    `mode` is the `DRIFT_MODE` the round ran under, recorded alongside the
    numbers so a later analyst reading a window of rows does not have to
    infer which regime produced them from the deploy history.
    """

    mode: str
    anchor_sim: float | None = None
    step_sim: float | None = None
    aspects: AspectSims | None = None
    embedder_ok: bool = True


class AspectThresholds(BaseModel):
    """Per-aspect drift gate lower bounds -- a candidate whose similarity to
    the anchor falls STRICTLY BELOW its own threshold breaches that aspect.

    Calibrated 2026-07-03 against real distilled-card data (see
    `docs/superpowers/specs/2026-07-02-per-aspect-drift-design.md`). The
    original design hypothesis was that `values` should be guarded strictest;
    a shadow round refuted it -- keyword-distilled cards put all three
    aspects on roughly the same ~0.70 band, and `values` came out the
    *lowest* (least stable) of the three, not the highest. The thresholds
    are therefore symmetric-ish by measurement, not asymmetric by design --
    do not "fix" them back toward a values-strictest shape.
    """

    values: float = 0.63
    style: float = 0.72
    topic: float = 0.71


class AspectCards(BaseModel):
    """Three keyword cards distilled from a personality document (task 9,
    `dream/distill.py`'s `distill_cards`) -- the model-neutral ruler's raw
    output before embedding.

    Field names are `values` / `style` / `topic` -- SINGULAR `topic`, even
    though the distiller prompt's own instructions say `TOPICS` (plural). That
    mismatch is deliberate and baked into `dream.sh`'s prompt text itself
    (contract `04` §3); every consumer -- `_anchor_aspects`, the gate,
    `_aspect_breached`, `snapshot.sh`'s payload -- reads the singular key, so
    "fixing" it to `topics` here would silently break the JSON contract the
    whole per-aspect drift system depends on.
    """

    values: str
    style: str
    topic: str


class AspectVectors(BaseModel):
    """The embedded form of `AspectCards` -- one bge-m3 vector (1024-dim) per
    aspect, cached alongside the cards in `<dir>/personality.anchor.aspects.json`
    (task 9, `dream/distill.py`'s `anchor_aspects`). Compared against a
    candidate's own `AspectVectors` via `dream/drift.py`'s `cosine_sim`, one
    aspect at a time, to produce an `AspectSims`.
    """

    values: list[float]
    style: list[float]
    topic: list[float]


class DreamVerdict(BaseModel):
    """The outcome of `dream.gate.evaluate_candidate` (task 11, `dream/gate.py`;
    contract `03` §1.4, `04` §5).

    `sims` and `scalar_sim` are independent, not a discriminated pair: `sims`
    is populated only outside scalar `DRIFT_MODE` and only when the aspect
    distill/embed pipeline succeeded; `scalar_sim` is populated whenever the
    whole-doc scalar embed pair succeeded, which `evaluate_candidate` always
    attempts regardless of `DRIFT_MODE` (it is the gate itself in scalar/
    shadow modes, and the aspect-mode fallback). A dream can therefore carry
    both, either, or neither.

    `scalar_sim` (fix round 2, task 12) is `None` -- not `0.0` -- whenever
    the scalar embed pair could not be computed (an unreachable embedder),
    matching `dream/gate.py`'s own `_scalar_similarity`/`_scalar_decision`
    fail-open distinction: "no value" and "value 0.0" are different states,
    and a caller building a metrics payload from this field (`dream/round.py`
    's `_drift_fail_metrics`) must be able to tell a REAL, if very low,
    similarity apart from "the check never ran". Added specifically so
    `dream/round.py` no longer needs to regex the number back out of
    `reason`'s formatted text -- see that module's `_drift_fail_metrics`
    docstring for the incident (a reworded reason string silently emptying a
    lab event's metrics with no test failure) this field exists to close.

    `embedder_unreachable` is that same lesson applied to the same `reason`
    string one line further on. `True` means the SCALAR gate ran with nothing
    measured and fail-opened -- i.e. this dream landed UNGATED
    (`dream/gate.py`, `dream.sh:797-807`). It is deliberately not derivable
    from `scalar_sim is None` alone: in `aspect` mode with usable aspect sims
    the aspect gate decides and a `None` `scalar_sim` gated nothing, so only
    the gate itself knows which branch actually made the call. It exists
    because `reason` is COMPOSED (`f"{aspect_note}; {base_reason}"`), so a
    caller comparing it for equality against the bare fail-open note stops
    matching precisely when the aspect pipeline is degraded too -- losing the
    one signal that says the constitution layer is off, at the moment it
    matters most.
    """

    accepted: bool
    reason: str
    breached: list[str] = Field(default_factory=list)
    sims: AspectSims | None = None
    scalar_sim: float | None = None
    embedder_unreachable: bool = False
    attempt: int = 1


class CooldownDecision(BaseModel):
    """The outcome of `dream.check_cooldown` (task 10, `dream/candidate.py`;
    contract `03` §1.3).

    `reason` holds only the message BODY -- e.g. `"cooldown (1h < 12h, +4 new
    memories)"` or `"cooldown override: +8 new memories since last dream"` --
    never the `"SKIP $name — "` / plain log-line prefix Bash prepends
    (`dream.sh:504`/`507`); a caller logging this decision adds that prefix
    itself, the same way `render_dream_prompt`'s output is prefix-free text
    a caller writes into its own log line.

    `reason` stays `""` for every SILENT proceed path (force mode, first-ever
    dream, or an elapsed cooldown) -- Bash logs nothing for those three cases
    either (contract `03` §1.3: "cooldown elapsed → proceed silently, no log
    line").
    """

    proceed: bool
    reason: str = ""
    override: bool = False


class DreamResult(BaseModel):
    """The outcome of one `run_dream` round (`dream/round.py`, task 12).

    `proceeded` distinguishes a cooldown SKIP (`proceeded=False`, only
    `reason` populated -- `check_cooldown` never asked the LLM for anything)
    from an attempt that actually ran the dream-rewrite call (`proceeded=
    True`), matching Bash's SKIP vs FAIL/DONE split (contract `03` §1.4).
    `accepted` is the single flag that answers "did personality.md actually
    change": true only once the full archive/write/marker/memory sequence
    has run. A structural or drift rejection is `proceeded=True,
    accepted=False`, with `reason` and `verdict` explaining why.

    `verdict` is populated for a STRUCTURAL rejection too, not only a
    drift-side one. (This paragraph used to say the opposite -- that
    `verdict` stays `None` on a structural failure because
    `evaluate_candidate` is "caught earlier by `run_dream`, before
    `evaluate_candidate` is even called". Read the code: `run_dream` has no
    structural check of its own, it calls `gate_step` unconditionally, and
    `evaluate_candidate` returns a verdict for the structural path as well.
    Corrected 2026-08-19 while making that same path also return a
    measurement.) `verdict` stays `None` only where no gate ran at all: a
    cooldown SKIP, and a round whose backend returned nothing.

    `recorded_memlines` is the exact value written to
    `last_dream_memlines_<name>` -- populated only when `accepted=True`,
    and always the memory.md line count taken BEFORE the "personality
    consolidated" housekeeping line was appended (contract `03` §4 steps
    4-5; see `dream.candidate.FilesystemDreamState.record_dream`'s
    docstring for why that ordering is deliberate).

    `snapshot_ok` / `snapshot_reason` describe the LAST step (contract `03`
    §4.9): a snapshot failure never flips `accepted` back to `False` -- the
    personality write has already committed by the time the snapshot is
    attempted. `snapshot_reason` is the upload failure's own message, never
    a hardcoded guess (see `dream/round.py`'s module docstring for the
    2026-07-31 incident this preserves).
    """

    proceeded: bool
    accepted: bool = False
    reason: str = ""
    verdict: DreamVerdict | None = None
    narrative: str = ""
    recorded_memlines: int | None = None
    snapshot_ok: bool = False
    snapshot_reason: str | None = None


class ActContext(BaseModel):
    """Everything that goes into the planner prompt.

    Two field classes, and the difference is load-bearing (contract 01 §4):
    fields with a non-empty default ALWAYS render, showing their placeholder
    when the source failed; fields defaulting to "" make their whole prompt
    section disappear. Unifying them would change the model's input on any
    partial-outage round.
    """

    context_now: str = "(no context file)"
    notification_context: str = "（暂无新互动）"
    recent_memory: str = "(no memory yet)"
    global_feed: str = "(could not fetch feed)"

    feed_context: str = ""
    timeline_feed: str = ""
    thread_context: str = ""
    contacts_list: str = ""
    dm_context: str = ""

    engaged_ids: str = ""
    today: str = ""
    today_post_count: int = 0
    last_post: str = "(暂无发帖记录)"
    action_budget: int = 5
    backend_action_constraint: str = ""

    contacts: list[str] = Field(default_factory=list)
    probe_post_ids: list[str] = Field(default_factory=list)

    # ── what this round actually READ (Phase B task 3, spec §8.3) ──────────
    #
    # Not prompt content: these three are the record of which input pool the
    # blocks above were drawn from. Without them a cross-read round is
    # indistinguishable from a home round in the data and the whole
    # intervention is unmeasurable.
    #
    # `board_read` is the scope actually read -- a board slug, or
    # `GLOBAL_READ_SCOPE` for an account with no niche. `home_board` is the
    # scope the persona's `Read` bullet ASSIGNED, which on a cross-read round
    # is a different board and is otherwise unrecoverable: reconstructing it
    # would mean joining against the assignment table as of that date, and
    # that table lives in `personality.md` -- a file a dream can rewrite.
    # `cross_read` says the round left its niche, which is NOT derivable from
    # `board_read` alone. `board_items` is how many items the breadth pass
    # returned, and `None` means the fetch FAILED -- distinct from `0`, which
    # means the board is empty. Told apart on purpose: a thin board starving
    # an account of input and an outage look identical in a count that
    # collapses them.
    board_read: str = GLOBAL_READ_SCOPE
    home_board: str = GLOBAL_READ_SCOPE
    cross_read: bool = False
    board_items: int | None = None


class ActResult(BaseModel):
    """The outcome of one `run_act` round (`act/round.py`, task 7).

    `plan` and `context` are included even though task-7-brief.md's own
    step-1 code sketch omitted them from this class body -- the SAME
    brief's "Produces" line, one paragraph above that sketch, lists them
    explicitly as part of what `run_act` produces, and without a `plan`
    field `dry_run` mode (design spec §9.4) would have nothing to return:
    the whole point of a shadow round is inspecting what plan and veto list
    guardrails WOULD have produced, without executing anything. Treating
    the interface summary as authoritative and the code sketch as an
    incomplete transcription of it -- recorded in task-7-report.md.
    """

    outcome: ActOutcome
    results: list[ActionResult] = Field(default_factory=list)
    vetoed: list[VetoedAction] = Field(default_factory=list)
    plan: Plan | None = None
    context: ActContext | None = None
    rhythm: RhythmDecision | None = None
    attempted: int = 0
    landed: int = 0

    @property
    def grants_dream(self) -> bool:
        """Whether this round's outcome permits a dream afterwards.

        Design spec §7.1: only a dead backend or an unreachable platform denies
        the account its dream. A rhythm-vetoed or deliberately-empty plan is the
        agent correctly choosing not to act, and Bash's rc=75 conflated all four
        -- which is how an empty plan came to cost a personality evolution.
        """
        return self.outcome not in (ActOutcome.BACKEND_UNAVAILABLE, ActOutcome.OFFLINE)


class ActSimilarity(BaseModel):
    """How close one round's candidate post sits to the account's OWN recent
    posts (Phase B task 2; `act/round.py`'s `measure_act_similarity`).

    SHADOW ONLY. Nothing reads this to decide anything: it is recorded to
    `/lab` and discarded. The act path -- the half of the cycle that decides
    and posts -- has no guard at all, which is why `liushang` has been
    collapsing onto a single recycled phrase since 2026-07-22 while the dream
    gate correctly rejects its personality rewrites and can do nothing about
    what it posts. Turning this number into a guard is a later task, after a
    calibration gate sets the threshold FROM this series. A threshold guessed
    before the distribution is known is the mistake the drift gate's own
    `ECHO_VARIANCE_THRESHOLD` already made (0.04 against a real measured range
    of 0.001-0.011, i.e. it would flag every account on every dream).

    `max_sim` is the MAXIMUM cosine similarity between the candidate and any
    single prior post, not the mean: the pathology is "this one post repeats
    that one post", and a mean over a 12-post window dilutes exactly the
    signal being looked for.

    `None` is a first-class value and is NOT interchangeable with `0.0`, for
    the same reason `DriftMeasurement` says so above: `0.0` would record
    "maximally diverse", a fabricated data point, where the truth is "not
    computed". An account with too small a corpus to compare against, and one
    whose embedder was down, both record `None` -- `embedder_ok` is what
    separates them.

    `compared_against` is the number of prior posts in the comparison corpus,
    recorded even on the paths that compute no similarity, so "nothing to
    compare against" is distinguishable from "plenty to compare against and
    the measurement still produced nothing".

    `embedder_ok` is FALSE only when an embed attempted FOR THIS MEASUREMENT
    failed (or came back unusable). A path that attempted none records `True`
    -- identical semantics to `DriftMeasurement.embedder_ok`, deliberately, so
    counting `embedder_ok is False` counts embedder outages on both series
    rather than meaning one thing on one panel and another on the other.
    """

    model_config = ConfigDict(frozen=True)

    max_sim: float | None = None
    compared_against: int = 0
    embedder_ok: bool = True
