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
    shape elsewhere -- see `act/memory_log.py`'s `_PARENT_UNUSABLE_DETAIL`
    sentinel). It lets `act/memory_log.py`'s memory-line writer record
    `conversationId=...` instead of a `messageId=` substitute.

    `call_succeeded` (ruling R19) answers a DIFFERENT question from `landed`:
    did the underlying API write succeed -- i.e. did the
    write go through -- rather than does this action count toward the round's
    landed tally. For every action kind the two are equal, and
    `act/executor.py`'s `_outcome` derives one from the other by default so
    they cannot drift apart by accident. `follow` is the ONE kind where they
    legitimately differ: a follow that 409s ("already following") is the
    common outcome and not a failed round, but the write did not succeed, so
    no memory line is recorded. So a 409 is a landed round AND an unwritten memory
    line, which needs two fields to say.

    Deliberately a typed field rather than a sentinel matched out of `detail`
    (the `_PARENT_UNUSABLE_DETAIL` shape above): the follow-failure detail is
    a COMPOSED string (`f"likely already following: {...}"`), so a reword
    would silently restore the bug.
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
    """One account, loaded from a v2 `personality.md` (see `persona/format.py`)."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    username: str
    display_name: str
    bio: str | None = None
    topics: list[str]
    # `model: <backend>:<model>` in the frontmatter, split at the first colon.
    backend: str
    # The backend as the file declares it. With `model` required in v2 it
    # always equals `backend`; kept so `llm/selection.py` can rank sources.
    declared_backend: str | None = None
    model: str | None = None
    board: str
    era: int
    card: str
    recent: list[str] = Field(default_factory=list)
    # The system prompt: card + 最近, never the frontmatter.
    prompt: str
    raw: str = ""
    directory: Path


class CooldownDecision(BaseModel):
    """The outcome of `dream.candidate.check_cooldown`.

    `reason` is the message body only (no `SKIP <name> —` prefix) and stays
    `""` for every silent proceed: force mode, a first-ever dream, an elapsed
    cooldown.
    """

    proceed: bool
    reason: str = ""
    override: bool = False


class DreamResult(BaseModel):
    """The outcome of one dream (`graph/outcome.py`'s `dream_result_of`).

    `proceeded=False` is a cooldown SKIP (no LLM call). `accepted` means the
    new 最近 list was written; `recent` is that list as written (clamped).
    A failed dream (empty or unparseable reply, refused write) is
    `proceeded=True, accepted=False` with `reason`. A snapshot failure never
    flips `accepted`: the file is already written by then.
    """

    proceeded: bool
    accepted: bool = False
    reason: str = ""
    recent: list[str] | None = None
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


class ActResult(BaseModel):
    """The outcome of one act round (`graph/outcome.py`'s `act_result_of`;
    `run_act` produced it until S3 Task 4).

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
    posts (`act/similarity.py`'s `similarity_step`), and whether the duplicate
    guard dropped it.

    `max_sim` is the maximum cosine over the window, not the mean: the
    pathology is one post repeating one earlier post. `None` means "not
    computed" (too small a corpus, or the embedder failed) and is never
    `0.0`; `embedder_ok` tells those two apart and is `False` only when an
    embed attempted for this measurement failed. `compared_against` is the
    number of prior posts actually in the corpus. `dropped` is true only for
    a computed `max_sim` at or above the threshold.

    `card_sim` is cosine(candidate, card) (S2 §4), `None` when not computed.
    `vector` is the candidate's own embedding, kept so a landed post's vector
    can be filed without a second embed; it is excluded from dumps and the
    repr because it is 1024 floats meant for one endpoint only.
    """

    model_config = ConfigDict(frozen=True)

    max_sim: float | None = None
    compared_against: int = 0
    embedder_ok: bool = True
    dropped: bool = False
    card_sim: float | None = None
    vector: list[float] | None = Field(default=None, exclude=True, repr=False)
