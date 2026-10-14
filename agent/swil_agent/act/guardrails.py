"""The act-path plan guardrails (contract `02` §1.2) as typed Python.

Six stages, run in this exact order (reordering changes outcomes):

1. backend allow-list (only when `allowed` is non-empty)
2. drop `nothing` when the plan has more than one entry
3. drop `post` when the rhythm policy is `no_post`
4. drop `dm` whose username is not in `contacts`
5. reduce: at most one `post`, at most one `echo`, dedupe on `"{kind}|{post_id}"`
6. truncate to `budget`

Two things this adds over Bash, which filters silently:

- It records WHY each action was dropped (design spec §7.5). Today, in Bash,
  a plan of five comments vetoed by the codex allow-list and a plan where the
  model chose `nothing` both log as `planned: nothing` -- indistinguishable.
  Three codex accounts landed in exactly that uninterpretable state on
  2026-08-16. Every drop below carries a distinct reason string.
- It is a pure function over already-typed `Plan`/`Action` objects, so the
  golden fixtures in `tests/golden/guardrail_cases.json` can pin every rule
  independently. This function has no parse-error fallback because it never
  sees raw JSON -- `Plan`/`Action`
  validation (and its own "malformed input" degradation) already happened
  upstream in `swil_agent.llm.extract.normalize_plan`. Reproducing a
  "parse-error" fallback here would be reproducing a concern that has already
  been handled at a different layer.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from swil_agent.models import Action, Plan, RhythmPolicy, VetoedAction


class GuardrailResult(BaseModel):
    actions: list[Action] = Field(default_factory=list)
    vetoed: list[VetoedAction] = Field(default_factory=list)


def apply_guardrails(
    plan: Plan,
    *,
    policy: RhythmPolicy,
    budget: int,
    contacts: list[str],
    allowed: list[str],
) -> GuardrailResult:
    """Filter `plan.actions` down to what may actually execute.

    `contacts` and `allowed` are filtered for blank entries here, not by the
    caller -- in Bash that filtering (`map(select(length > 0))`) happens
    *inside* `apply_plan_guardrails` itself (contract `02` §1.1, building
    `contacts_json`/`allowed_json` from newline/comma-separated raw strings),
    so it is part of this function's contract, not a precondition on its
    input.
    """
    vetoed: list[VetoedAction] = []

    def drop(action: Action, reason: str) -> None:
        vetoed.append(VetoedAction(action=action, reason=reason))

    # 1. Backend allow-list. Empty means "everything allowed". Codex used to
    # be restricted to post/nothing while its comment path was a confirmed
    # silent-fail; write-verification is the real fix (loop-engine spec §7)
    # so that list is empty for every backend. The stage stays: a non-empty
    # `allowed` still filters.
    allowed_kinds = {a for a in allowed if a}
    if allowed_kinds:
        kept = [a for a in plan.actions if a.kind in allowed_kinds]
        for action in plan.actions:
            if action.kind not in allowed_kinds:
                drop(action, f"backend allow-list ({','.join(allowed)})")
    else:
        kept = list(plan.actions)

    # 2. `nothing` only means something as the whole plan; mixed in, it is
    # noise from a model that couldn't commit to a single action.
    if len(kept) > 1:
        next_kept: list[Action] = []
        for action in kept:
            if action.kind == "nothing":
                drop(action, "nothing mixed into a multi-action plan")
            else:
                next_kept.append(action)
        kept = next_kept

    # 3. Rhythm veto.
    #
    # This runs AFTER stage 2 -- deliberately, and that order is why a plan
    # of `[post, nothing]` under a `no_post` policy ends up EMPTY rather than
    # falling back to `nothing` (contract `02` §1.4): stage 2 already
    # stripped `nothing` because the plan had two entries, so by the time
    # stage 3 removes the `post`, there is nothing left to fall back to. That
    # reads like a bug. It is reproduced anyway, for two reasons. First,
    # parity: the shadow round compares guardrail verdicts per account, and
    # reordering stages 2 and 3 here would show up as divergence on every
    # single rhythm-vetoed round, drowning out real findings under noise from
    # a difference nobody asked to measure. Second, the harm that used to
    # make this look like a real bug is already gone: an empty plan is
    # `ActOutcome.VETOED_EMPTY` (design spec §7.1), which no longer denies
    # the account its dream the way Bash's `rc=75` used to. The ordering
    # stays; the consequence that made it painful does not. Do not "fix"
    # this by moving stage 3 before stage 2.
    if policy is RhythmPolicy.NO_POST:
        next_kept = []
        for action in kept:
            if action.kind == "post":
                drop(action, "rhythm policy no_post")
            else:
                next_kept.append(action)
        kept = next_kept

    # 4. A DM to someone outside the contact list never leaves this machine.
    allowed_contacts = {c for c in contacts if c}
    survivors: list[Action] = []
    for action in kept:
        if action.kind == "dm" and (action.username or "") not in allowed_contacts:
            drop(action, "dm recipient not in contacts")
        else:
            survivors.append(action)
    kept = survivors

    # 5. One post, one echo, first of each wins; never repeat a verb on a
    # postId. The dedupe key is "{kind}|{post_id}" and deliberately excludes
    # parent_id -- two replies to different comments under the same post
    # collapse to the first (contract `02` §1.3 rule 5). Actions with no
    # post_id (follow, dm, nothing) never reach the dedupe branch at all --
    # only the post/echo singleton caps apply to them. `action.post_id is
    # not None`, not a truthiness check, to match jq's `(.postId // null) !=
    # null` exactly (an empty-string postId would count as present in jq).
    out: list[Action] = []
    posts = 0
    echoes = 0
    seen: set[str] = set()
    for action in kept:
        has_post_id = action.post_id is not None
        key = f"{action.kind}|{action.post_id or ''}"
        if action.kind == "post" and posts >= 1:
            drop(action, "only one post per round")
        elif action.kind == "echo" and echoes >= 1:
            drop(action, "only one echo per round")
        elif has_post_id and key in seen:
            drop(action, f"duplicate {action.kind} on {action.post_id}")
        else:
            out.append(action)
            if action.kind == "post":
                posts += 1
            elif action.kind == "echo":
                echoes += 1
            if has_post_id:
                seen.add(key)

    # 6. Budget cap. Order is preserved -- these are the tail of `out`, not a
    # re-sort by any priority.
    for action in out[budget:]:
        drop(action, f"over the {budget}-action budget")
    return GuardrailResult(actions=out[:budget], vetoed=vetoed)
