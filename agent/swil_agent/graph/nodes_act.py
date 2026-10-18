"""The act phase's nodes: `login`, `plan`, `guardrail`, `execute`.

Each adapts `CycleState` to the `act/round.py` steps it imports by name (see
`graph/deps.py` for the node -> step map); a test patches a step HERE, on the
module whose node looks it up at call time.
"""

from __future__ import annotations

from swil_agent.act.round import (
    context_step,
    execute_step,
    finalize_step,
    guardrail_step,
    login_step,
    plan_step,
    sync_backend_step,
)
from swil_agent.graph.deps import CycleDeps, NodeFn, _require, agent_dir_name
from swil_agent.graph.state import CycleState
from swil_agent.models import ActOutcome
from swil_agent.prompts import act_prompt


def make_login_node(deps: CycleDeps) -> NodeFn:
    """`login_step` -> `sync_backend_step` -> `context_step`.

    The probe comes first and an offline probe returns immediately: an
    offline round PATCHes nothing and reads nothing. No lock is taken here --
    `run_graph` holds a `RunLease` around the whole run (ruling R2).
    """

    def login(state: CycleState) -> CycleState:
        persona = state["persona"]
        step = login_step(persona=persona, health_check=deps.health_check)
        if not step.online:
            return {"agent": step.agent_name, "outcome": ActOutcome.OFFLINE}

        sync_backend_step(
            resources=deps.resources,
            persona=persona,
            agent_name=step.agent_name,
            dry_run=deps.dry_run,
        )
        context, rhythm = context_step(
            resources=deps.resources,
            persona=persona,
            memory_text=deps.memory_text,
            now=deps.now,
            rng=deps.rng,
            budget=deps.budget,
            context_now=deps.context_now,
            feed_context=deps.feed_context,
            era_start=deps.settings.era_start,
            post_probability=deps.settings.post_probability,
            post_ceiling=deps.settings.post_ceiling_per_day,
            probe_board=deps.probe_board,
            world=deps.world,
        )
        return {"agent": step.agent_name, "context": context, "rhythm": rhythm}

    return login


def make_plan_node(deps: CycleDeps) -> NodeFn:
    """`plan_step`. `None` back means the backend produced nothing at all,
    which is one of the only two outcomes that deny the account its dream --
    so the label is set here rather than inferred downstream from a missing
    plan (an empty plan and an absent one are different rounds). It renders the
    prompt through `prompts.act_prompt(deps.settings.prompt_version, ...)` and
    keeps its version and size in the state."""

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
        if prompt.handles is not None:
            update["handles"] = prompt.handles
        if planned is None:
            update["outcome"] = ActOutcome.BACKEND_UNAVAILABLE
        return update

    return plan


def make_guardrail_node(deps: CycleDeps) -> NodeFn:
    """`guardrail_step`. PURE: it reads `deps.budget` and nothing else off
    `deps`, so this node performs no I/O of any kind -- which is why §5.4
    gives it no retry policy and why a test asserts it cannot even touch
    `Resources`.

    `actions` (the survivors) is a separate field from `plan` (the model's
    original proposal) on purpose: `ActResult` reports both, and §7.5 exists
    because "guardrails dropped all five" and "the model proposed nothing"
    were indistinguishable.
    """

    def guardrail(state: CycleState) -> CycleState:
        guarded = guardrail_step(
            plan=_require(state.get("plan"), key="plan", node="guardrail"),
            persona=state["persona"],
            rhythm=_require(state.get("rhythm"), key="rhythm", node="guardrail"),
            context=_require(state.get("context"), key="context", node="guardrail"),
            budget=deps.budget,
            handles=state.get("handles"),
        )
        update: CycleState = {
            "actions": guarded.actions,
            "vetoed": guarded.vetoed,
            "solo_nothing": guarded.solo_nothing,
        }
        if guarded.empty_outcome is not None:
            update["outcome"] = guarded.empty_outcome
        return update

    return guardrail


def make_execute_node(deps: CycleDeps) -> NodeFn:
    """`execute_step` -> `finalize_step`, both threaded `dry_run`.

    `deps.embedder` and the `post_duplicate_*` settings are threaded into
    `execute_step` because the near-duplicate guard lives inside that
    function, which is what lets this node get it without a copy. The
    guard's vetoes are appended to the state's `vetoed`.

    `state["round_id"]` labels the similarity event and the post-vector
    ingest; a thread checkpointed before S2 has none and sends `null`. A post
    that landed without its vector filed sets `missing_post_vector`.

    An empty `actions` list returns an empty partial instead of running the
    steps. An empty plan is an early return, not a step, and in the graph
    that is an edge that routes around this node. This is the belt to those
    braces: entered by
    mistake, the node must not run `finalize_step` and convert the
    `VETOED_EMPTY` the guardrail node just decided into `LANDED_PARTIAL`
    plus Bash's FAIL line. A solo `nothing` is NOT this case -- it is a
    surviving action and still executes.
    """

    def execute(state: CycleState) -> CycleState:
        actions = state.get("actions") or []
        if not actions:
            return {}

        persona = state["persona"]
        agent_name = agent_dir_name(persona)
        step = execute_step(
            resources=deps.resources,
            persona=persona,
            actions=actions,
            agent_name=agent_name,
            now=deps.now,
            access_key=deps.access_key,
            dry_run=deps.dry_run,
            embedder=deps.embedder,
            duplicate_window=deps.settings.post_duplicate_window,
            duplicate_threshold=deps.settings.post_duplicate_threshold,
            round_id=state.get("round_id"),
        )
        outcome = finalize_step(
            resources=deps.resources,
            actions=step.actions,
            agent_name=agent_name,
            attempted=step.attempted,
            landed=step.landed,
            solo_nothing=state.get("solo_nothing", False),
            dry_run=deps.dry_run,
            emptied=step.emptied,
        )
        update: CycleState = {
            "actions": step.actions,
            "results": step.results,
            "attempted": step.attempted,
            "landed": step.landed,
            "outcome": outcome,
            "vetoed": [*(state.get("vetoed") or []), *step.vetoed],
        }
        if step.missing_post_vector:
            update["missing_post_vector"] = True
        return update

    return execute
