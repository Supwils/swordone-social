"""Act-path near-duplicate guard (`act/round.py`'s `similarity_step` and
`apply_duplicate_guard`).

Before a post executes it is embedded and compared with the account's OWN
last `POST_DUPLICATE_WINDOW` posts; at max cosine >= `POST_DUPLICATE_THRESHOLD`
the post is dropped as a guardrail veto. Every candidate files one lab event,
dropped or not. Properties pinned here:

  * The corpus is the account's own recent posts, never the feed -- pinned on
    the embedder's INPUTS (`RecordingEmbedder` refuses unregistered texts).
  * The guard fails open: embedder down, too few priors, a failed fetch or
    any unexpected error leaves the post in place.
  * `None` is not `0.0`: an unmeasured candidate records `maxSim: null`.

Vectors are ONE-DIMENSIONAL throughout: over one dimension the dot product of
normalised vectors IS the cosine, so a fixture can pin an exact value.
"""

from __future__ import annotations

import logging
import random
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.act.round import (
    DEFAULT_POST_DUPLICATE_THRESHOLD,
    DEFAULT_POST_DUPLICATE_WINDOW,
    MIN_COMPARISON_CORPUS,
    apply_duplicate_guard,
    candidate_post_text,
    execute_step,
    measure_act_similarity,
    prior_post_texts,
    run_act,
    similarity_step,
)
from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.config import Settings
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.models import Action, ActOutcome, ActSimilarity, Persona, Plan

from ._runners import (
    FakePersonaSource,
    FakeResources,
    FakeState,
    StubBackend,
    make_persona,
)

NOW = datetime(2026, 8, 19, 10, 0, 0)
CAPTURED_AT = datetime(2026, 8, 19, 10, 0, 0, tzinfo=UTC)

USERNAME = "zenith"
DIR_NAME = "zenith_dir"
"""The `Username` bullet and the DIRECTORY name are deliberately DIFFERENT.

They diverge on the real roster (CLAUDE.md, "Stray `agents/<name>` dir shadows
a `humans/` account"), and both the posts read and the lab event are keyed by
the username, not the folder -- a fixture where the two matched would make
`persona.directory.name` an indistinguishable substitute for
`persona.username` at every one of those call sites (standing constraint §4).
"""

CANDIDATE = "流动性回来了，但只在开盘的前十分钟"
NEAR = "流动性只在开盘的前十分钟回来"
FAR = "周末读完了那本讲铁路调度的书"
FEED = "别人的帖子：宏观叙事又变了"
FEED_TWO = "别人的帖子：又一轮加息预期"
"""TWO feed items, and the second one is load-bearing (fix round 1, review
Minor 3). With a single one, mutating the corpus to the global feed produced
a ONE-item corpus, which trips `MIN_COMPARISON_CORPUS` and returns before
any embed: the mutation died on `embedder.embedded == []` -- the right
assertion failing for an accidental reason, which is precisely what the
corpus test's own docstring says it was built to avoid. Two items make the
feed corpus reach the embedder, so the mutation now fails displaying the
feed texts it wrongly embedded."""

# candidate 0.5, priors 0.9 / 0.8 -> sims 0.45 and 0.40.
#
# Every plausible wrong reduction lands on a DIFFERENT number: max is 0.45,
# mean 0.425, min 0.40. And the batch-order mutation (`[*corpus, candidate]`,
# which makes the first PRIOR play the candidate) yields max(0.9*0.8,
# 0.9*0.5) = 0.72. A fixture of 1.0/0.9/0.3 -- the obvious one -- returns 0.9
# for both the correct implementation and that reordering, because in one
# dimension `max_i(c * p_i) = c * max(p_i)` whenever the reordered candidate
# happens to be the largest prior.
CANDIDATE_VECTOR = [0.5]
NEAR_VECTOR = [0.9]
FAR_VECTOR = [0.8]
FEED_VECTOR = [0.2]
FEED_TWO_VECTOR = [0.3]
EXPECTED_MAX_SIM = 0.45
MEAN_SIM = 0.425
MIN_SIM = 0.40

VECTORS: dict[str, list[float]] = {
    CANDIDATE: CANDIDATE_VECTOR,
    NEAR: NEAR_VECTOR,
    FAR: FAR_VECTOR,
    FEED: FEED_VECTOR,
    FEED_TWO: FEED_TWO_VECTOR,
}


class RecordingEmbedder:
    """An `Embedder` double that answers by TEXT and refuses anything else.

    Returns one vector PER TEXT, unlike `_runners.FakeEmbedder`, which answers
    one vector per CALL regardless of batch size -- correct for the dream
    path's one-document-at-a-time embeds and useless here, where the whole
    point is a batch of a candidate plus a corpus.

    An unregistered text raises rather than returning a placeholder. That is
    what makes "which corpus was embedded" observable at all: a fake that
    answers the same vector whatever it is asked cannot distinguish the
    account's own posts from the global feed, and every assertion about the
    corpus would pass against an implementation that embedded the wrong one
    (standing constraint §4).
    """

    def __init__(self, vectors: dict[str, list[float]] | None = None, *, fails: bool = False):
        self._vectors = dict(vectors or VECTORS)
        self._fails = fails
        self.embedded: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.embedded.append(list(texts))
        if self._fails:
            raise EmbedderUnavailable("fake embedder is down")
        missing = [t for t in texts if t not in self._vectors]
        if missing:
            raise AssertionError(f"embedded an unregistered text: {missing[0]!r}")
        return [self._vectors[t] for t in texts]


class TracingResources(FakeResources):
    """`FakeResources` plus an ordered cross-method trace and the username
    each lab event was filed under.

    `FakeResources.lab_event` discards its `username` argument, so without
    this subclass "filed under the `Username` bullet" would be unobservable
    and `persona.directory.name` would substitute for it silently.

    `echo_new_posts` makes a landed `create_post` join `user_post_items`, the
    way the real platform does -- which is what lets a test see that a sample
    taken after the write would have compared the candidate against itself.
    """

    def __init__(self, *, echo_new_posts: bool = False, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.trace: list[str] = []
        self.event_usernames: list[tuple[str, str]] = []
        self._echo_new_posts = echo_new_posts

    def user_posts(self, username: str, limit: int = 12) -> list[dict[str, Any]]:
        self.trace.append("user_posts")
        return super().user_posts(username, limit)

    def create_post(
        self,
        text: str,
        board_id: str | None = None,
        image: tuple[str, bytes] | None = None,
        echo_of: str | None = None,
    ) -> str:
        self.trace.append("create_post")
        post_id = super().create_post(text, board_id=board_id, image=image, echo_of=echo_of)
        if self._echo_new_posts:
            self.user_post_items = [{"text": text}, *self.user_post_items]
        return post_id

    def lab_event(self, username: str, event: LabEvent) -> None:
        self.trace.append(f"lab_event:{event.phase}/{event.outcome}")
        self.event_usernames.append((username, event.summary))
        super().lab_event(username, event)


def _persona(tmp_path: Path, *, username: str = USERNAME, dir_name: str = DIR_NAME) -> Persona:
    directory = tmp_path / "agents" / dir_name
    directory.mkdir(parents=True, exist_ok=True)
    return make_persona(username=username, directory=directory, prompt="PERSONA")


def _own_posts(*texts: str) -> list[dict[str, Any]]:
    return [{"text": t} for t in texts]


def _similarity_events(resources: FakeResources) -> list[LabEvent]:
    """The rows this sampler files, and only those.

    Selected by summary rather than by `(type, phase)`: `act/executor.py`
    emits `cycle`/`act` rows for every action, so filtering on the pair would
    silently include them and make a count assertion meaningless.
    """
    return [e for e in resources.lab_events if e.summary.startswith("act self-similarity")]


def _run_execute(
    tmp_path: Path,
    *,
    resources: FakeResources,
    embedder: Any,
    actions: list[Action] | None = None,
    window: int = DEFAULT_POST_DUPLICATE_WINDOW,
    threshold: float = DEFAULT_POST_DUPLICATE_THRESHOLD,
    dry_run: bool = False,
) -> Any:
    return execute_step(
        resources=resources,
        persona=_persona(tmp_path),
        actions=actions if actions is not None else [Action(kind="post", text=CANDIDATE)],
        agent_name=DIR_NAME,
        now=NOW,
        embedder=embedder,
        duplicate_window=window,
        duplicate_threshold=threshold,
        dry_run=dry_run,
    )


# ── the three properties the brief names ─────────────────────────────────


def test_similarity_is_computed_against_the_accounts_own_recent_posts(tmp_path: Path) -> None:
    """Not the feed, not the global corpus. A cross-account comparison would
    measure roster homogeneity, which is a different metric with a different
    threshold (spec 13, the homogenisation risk row).

    Asserted on the embedder's INPUTS. `RecordingEmbedder` would answer a
    perfectly ordinary 0.45 for a feed-derived corpus too (the feed texts are
    registered, precisely so the mutation does not fail for the accidental
    reason of an unknown text), so an assertion on `max_sim` alone cannot
    tell the two corpora apart -- standing constraint §4. TWO feed items, not
    one, for the same reason and it is not padding: with one, the mutated
    corpus is below `MIN_COMPARISON_CORPUS` and returns before embedding, so
    the assertion fails on `[]` rather than on the feed texts -- the right
    assertion, the wrong evidence (fix round 1, review Minor 3).

    Kills: `resources.user_posts(...)` -> `resources.feed_global(...)`, and
    `persona.username` -> `persona.directory.name` at the same call.
    """
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    resources.recommended = _own_posts(FEED, FEED_TWO)
    resources.latest = _own_posts(FEED, FEED_TWO)
    embedder = RecordingEmbedder()

    _run_execute(tmp_path, resources=resources, embedder=embedder)

    assert embedder.embedded == [[CANDIDATE, NEAR, FAR]]
    assert FEED not in embedder.embedded[0]
    assert FEED_TWO not in embedder.embedded[0]
    assert resources.user_posts_calls == [(USERNAME, DEFAULT_POST_DUPLICATE_WINDOW)]
    event = _similarity_events(resources)[0]
    assert event.metrics["maxSim"] == pytest.approx(EXPECTED_MAX_SIM)
    assert event.metrics["comparedAgainst"] == 2


# ── the guard ────────────────────────────────────────────────────────────

DUPLICATE = {CANDIDATE: [1.0], NEAR: [0.95], FAR: [0.3]}
"""max_sim 0.95: above the 0.92 default."""

DISTINCT = {CANDIDATE: [1.0], NEAR: [0.80], FAR: [0.3]}
"""max_sim 0.80: below the 0.92 default."""


def test_a_near_duplicate_post_is_dropped_and_its_event_says_so(tmp_path: Path) -> None:
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)

    step = _run_execute(tmp_path, resources=resources, embedder=RecordingEmbedder(DUPLICATE))

    assert resources.created_posts == []
    assert [v.action.kind for v in step.vetoed] == ["post"]
    assert step.vetoed[0].reason == "near-duplicate of a recent post (max_sim 0.950 >= 0.92)"
    event = _similarity_events(resources)[0]
    assert event.metrics["maxSim"] == pytest.approx(0.95)
    assert event.metrics["dropped"] is True
    assert event.metrics["threshold"] == DEFAULT_POST_DUPLICATE_THRESHOLD


def test_a_distinct_post_is_kept_and_its_event_says_so(tmp_path: Path) -> None:
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)

    step = _run_execute(tmp_path, resources=resources, embedder=RecordingEmbedder(DISTINCT))

    assert [p.text for p in resources.created_posts] == [CANDIDATE]
    assert step.vetoed == []
    assert step.emptied is False
    event = _similarity_events(resources)[0]
    assert event.metrics["maxSim"] == pytest.approx(0.80)
    assert event.metrics["dropped"] is False
    assert event.metrics["threshold"] == DEFAULT_POST_DUPLICATE_THRESHOLD


def test_a_similarity_exactly_at_the_threshold_is_dropped(tmp_path: Path) -> None:
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)

    step = _run_execute(
        tmp_path, resources=resources, embedder=RecordingEmbedder(DUPLICATE), threshold=0.95
    )

    assert resources.created_posts == []
    assert len(step.vetoed) == 1


def test_the_threshold_is_the_one_passed_in(tmp_path: Path) -> None:
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)

    _run_execute(
        tmp_path, resources=resources, embedder=RecordingEmbedder(DUPLICATE), threshold=0.99
    )

    assert [p.text for p in resources.created_posts] == [CANDIDATE]
    assert _similarity_events(resources)[0].metrics["threshold"] == 0.99


def test_an_embedder_outage_keeps_the_post(tmp_path: Path) -> None:
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)

    step = _run_execute(tmp_path, resources=resources, embedder=RecordingEmbedder(fails=True))

    assert [p.text for p in resources.created_posts] == [CANDIDATE]
    assert step.vetoed == []
    assert _similarity_events(resources)[0].metrics["dropped"] is False


def test_the_other_actions_of_the_round_still_execute(tmp_path: Path) -> None:
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    like = Action(kind="like", post_id="a" * 24)

    step = _run_execute(
        tmp_path,
        resources=resources,
        embedder=RecordingEmbedder(DUPLICATE),
        actions=[Action(kind="post", text=CANDIDATE), like],
    )

    assert resources.created_posts == []
    assert resources.liked == ["a" * 24]
    assert step.actions == [like]
    assert step.emptied is False
    assert (step.attempted, step.landed) == (1, 1)


def test_a_round_left_empty_becomes_nothing(tmp_path: Path) -> None:
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    persona_dir = tmp_path / "agents" / DIR_NAME

    step = _run_execute(tmp_path, resources=resources, embedder=RecordingEmbedder(DUPLICATE))

    assert [a.kind for a in step.actions] == ["nothing"]
    assert step.emptied is True
    assert (step.attempted, step.landed) == (1, 1)
    assert resources.get_boards_calls == 0
    assert not (persona_dir / "memory.md").exists()


def test_run_act_reports_a_guard_emptied_round_as_vetoed_empty(tmp_path: Path) -> None:
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    resources.notification_items = [{"id": "n1", "type": "comment", "post": {"id": "p"}}]

    result = run_act(
        persona=_persona(tmp_path),
        resources=resources,
        backend=StubBackend('{"plan":[{"action":"post","text":"' + CANDIDATE + '"}]}'),
        memory_text="",
        agent_root=tmp_path,
        now=NOW,
        rng=random.Random(0),
        health_check=lambda: True,
        embedder=RecordingEmbedder(DUPLICATE),
    )

    assert result.outcome is ActOutcome.VETOED_EMPTY
    assert [v.action.kind for v in result.vetoed] == ["post"]
    assert result.vetoed[0].reason.startswith("near-duplicate of a recent post")
    assert resources.created_posts == []
    assert resources.marked_read == []
    assert result.grants_dream is True


def test_run_act_appends_the_duplicate_veto_after_the_guardrail_vetoes(tmp_path: Path) -> None:
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    plan = (
        '{"plan":[{"action":"post","text":"' + CANDIDATE + '"},'
        '{"action":"post","text":"second"},'
        '{"action":"like","postId":"' + "a" * 24 + '"}]}'
    )

    result = run_act(
        persona=_persona(tmp_path),
        resources=resources,
        backend=StubBackend(plan),
        memory_text="",
        agent_root=tmp_path,
        now=NOW,
        rng=random.Random(0),
        health_check=lambda: True,
        embedder=RecordingEmbedder(DUPLICATE),
    )

    assert [v.reason for v in result.vetoed] == [
        "only one post per round",
        "near-duplicate of a recent post (max_sim 0.950 >= 0.92)",
    ]
    assert result.outcome is ActOutcome.LANDED_ALL
    assert resources.liked == ["a" * 24]


def test_apply_duplicate_guard_is_the_identity_without_a_drop() -> None:
    actions = [Action(kind="post", text=CANDIDATE)]
    for sim in (None, ActSimilarity(max_sim=0.5, compared_against=2), ActSimilarity()):
        kept, vetoed = apply_duplicate_guard(actions, sim, threshold=0.92)
        assert kept == actions
        assert vetoed == []


def test_fewer_than_two_prior_posts_yields_max_sim_none_not_zero(tmp_path: Path) -> None:
    """A new account has nothing to be similar to. Recording 0.0 would put a
    fake 'maximally diverse' point into the calibration sample.

    Both sub-two cases, because the guard is `< MIN_COMPARISON_CORPUS` and an
    off-by-one between "no corpus" and "a one-post corpus" is invisible if
    only the empty case is driven. `compared_against` still reports the real
    corpus size on both, so "nothing to compare against" stays distinguishable
    from "the measurement failed".

    `embedder_ok` is True on both: no embed was attempted, so no outage was
    observed -- `embedder_ok is False` means "embedder outage" and nothing
    else.

    Kills: returning `0.0` (or `max_sim` omitted from a corpus-too-small
    branch that then computes a similarity anyway).
    """
    embedder = RecordingEmbedder()

    for corpus in ([], [NEAR]):
        sim = measure_act_similarity(
            candidate_text=CANDIDATE, prior_texts=corpus, embedder=embedder
        )
        assert sim.max_sim is None
        assert sim.max_sim != 0.0
        assert sim.compared_against == len(corpus)
        assert sim.embedder_ok is True

    assert embedder.embedded == [], "a corpus too small to compare must cost no embed call"


def test_a_new_account_still_files_a_row_saying_why_it_has_no_number(tmp_path: Path) -> None:
    """The skip is RECORDED, not silent.

    An absent row and a row reading "there was nothing to compare against"
    are the two facts this plan exists to stop conflating -- a series that
    records only its successes is the same censoring Phase B task 1 ended on
    the dream side. `outcome="skip"` and `reason` carry the distinction;
    `maxSim` stays `null`.
    """
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR)

    _run_execute(tmp_path, resources=resources, embedder=RecordingEmbedder())

    event = _similarity_events(resources)[0]
    assert event.outcome == "skip"
    assert event.reason == f"fewer than {MIN_COMPARISON_CORPUS} prior posts"
    assert event.metrics["maxSim"] is None
    assert event.metrics["comparedAgainst"] == 1
    assert event.metrics["embedderOk"] is True


# ── the measurement itself ───────────────────────────────────────────────


def test_max_sim_is_the_maximum_not_the_mean_or_the_minimum() -> None:
    """The pathology is "this post repeats THAT post". A mean over a 12-post
    window dilutes exactly the signal being looked for, and a minimum inverts
    it.

    The fixture separates all three (0.45 / 0.425 / 0.40) and additionally
    separates the batch-ORDER mutation (`[*corpus, candidate]` -> 0.72), which
    a 1.0/0.9/0.3 fixture would not.
    """
    sim = measure_act_similarity(
        candidate_text=CANDIDATE, prior_texts=[NEAR, FAR], embedder=RecordingEmbedder()
    )
    assert sim.max_sim == pytest.approx(EXPECTED_MAX_SIM)
    assert sim.max_sim != pytest.approx(MEAN_SIM)
    assert sim.max_sim != pytest.approx(MIN_SIM)
    assert sim.compared_against == 2
    assert sim.embedder_ok is True


def test_one_embed_call_carries_the_candidate_and_the_whole_corpus() -> None:
    """One batch, candidate first, priors in order.

    The prior posts' vectors are RECOMPUTED every round because there is
    nothing to fetch: `server/src/db/schema/lab.ts` puts a `vector` column on
    exactly two tables, and the behaviour one holds a single vector over all
    twelve posts JOINED into one document, which cannot yield a per-post
    maximum. Pinning the shape here makes the per-round cost -- one `/embed`
    of `1 + n` texts -- a stated property rather than an accident.
    """
    embedder = RecordingEmbedder()
    measure_act_similarity(candidate_text=CANDIDATE, prior_texts=[NEAR, FAR], embedder=embedder)
    assert embedder.embedded == [[CANDIDATE, NEAR, FAR]]


def test_the_candidate_is_not_compared_against_its_own_vector() -> None:
    """`candidate_vector, *prior_vectors = vectors` -- the head is the
    candidate and is REMOVED from the comparison set.

    Its own fixture, with a UNIT candidate vector, because the file's main
    one cannot see this: a candidate of 0.5 self-compares to 0.25, below both
    real sims, so leaving it in the set changes nothing there. Real bge-m3
    vectors are L2-normalised, so a self-comparison is exactly 1.0 and would
    dominate every round -- `max_sim` would read 1.0 for every account
    forever, the same artefact as sampling after the write, arrived at from
    the other direction.
    """
    sim = measure_act_similarity(
        candidate_text=CANDIDATE,
        prior_texts=[NEAR, FAR],
        embedder=RecordingEmbedder({CANDIDATE: [1.0], NEAR: [0.9], FAR: [0.8]}),
    )
    assert sim.max_sim == pytest.approx(0.9)
    assert sim.max_sim != pytest.approx(1.0)


def test_an_unreachable_embedder_records_no_number_and_says_so() -> None:
    """Fail-open, in the direction that cannot manufacture a signal.

    `max_sim=None` with `embedder_ok=False` -- never `0.0` (a fabricated
    "maximally diverse" reading) and never `1.0` (which `dream/drift.py`'s
    `cosine_sim` would return, since its fail-open points the other way: safe
    for a gate that rejects on LOW similarity, exactly backwards for one that
    fires on HIGH).
    """
    sim = measure_act_similarity(
        candidate_text=CANDIDATE,
        prior_texts=[NEAR, FAR],
        embedder=RecordingEmbedder(fails=True),
    )
    assert sim.max_sim is None
    assert sim.embedder_ok is False
    assert sim.compared_against == 2


def test_an_oversized_window_degrades_instead_of_aborting_the_round() -> None:
    """`EmbedderClient.embed` raises `ValueError`, not `EmbedderUnavailable`,
    for a batch above `MAX_BATCH`. That must cost the measurement, never the
    round that was about to post.
    """

    class OversizedBatchEmbedder:
        def embed(self, texts: list[str]) -> list[list[float]]:
            raise ValueError("embed() takes at most 64 texts, got 65")

    sim = measure_act_similarity(
        candidate_text=CANDIDATE, prior_texts=[NEAR, FAR], embedder=OversizedBatchEmbedder()
    )
    assert sim.max_sim is None
    assert sim.embedder_ok is False


def test_a_short_or_ragged_embedder_response_is_an_outage_not_a_partial_answer() -> None:
    """Partial vector damage is total damage.

    Maximising over the survivors would leave `compared_against` claiming
    priors that were never compared -- a number that looks normal and is about
    a corpus that did not exist. Both shapes a real daemon can produce (too
    few vectors; a vector of the wrong width) report `embedder_ok=False`.
    """

    class ShortEmbedder:
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[0.5]]

    class RaggedEmbedder:
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[0.5], [0.9, 0.1], [0.8]]

    for embedder in (ShortEmbedder(), RaggedEmbedder()):
        sim = measure_act_similarity(
            candidate_text=CANDIDATE, prior_texts=[NEAR, FAR], embedder=embedder
        )
        assert sim.max_sim is None, embedder
        assert sim.embedder_ok is False, embedder


# ── what counts as the candidate, and as a prior ─────────────────────────


def test_the_candidate_is_the_text_that_will_land_not_the_raw_model_output() -> None:
    """`_memory_text` == `act/executor.py`'s `collapse_doubled_text(_clean(...))`
    -- byte-for-byte what `create_post` receives.

    Not cosmetic on the accounts this exists for: `collapse_doubled_text`
    exists because a degenerate backend emits its answer twice, so the raw
    text of a collapsing account can be double the length of the post it
    becomes. Measuring the raw string would measure a document that never
    existed, on exactly the rounds the measurement is for.
    """
    once = "order books never lie, they only whisper."
    raw = f"  {once}{once}\n"
    assert candidate_post_text([Action(kind="post", text=raw)]) == once


def test_an_echo_is_not_a_candidate() -> None:
    """An echo also creates a row through `create_post`
    (`act/executor.py::_execute_echo`), so it is a plausible candidate and is
    deliberately not one: its text is commentary attached to somebody else's
    post -- different length, different shape -- and a round may carry one
    post AND one echo, leaving two candidates for one scalar metric. Blending
    two distributions is how a calibration sample ends up describing neither.
    """
    assert candidate_post_text([Action(kind="echo", text=CANDIDATE, post_id="p1")]) is None
    assert candidate_post_text([Action(kind="comment", text=CANDIDATE, post_id="p1")]) is None
    assert candidate_post_text([Action(kind="nothing")]) is None
    assert candidate_post_text([Action(kind="post", text="   ")]) is None
    assert candidate_post_text([Action(kind="post", text=None)]) is None
    mixed = [Action(kind="echo", text=FAR, post_id="p1"), Action(kind="post", text=CANDIDATE)]
    assert candidate_post_text(mixed) == CANDIDATE


def test_a_round_with_no_post_takes_no_sample_at_all(tmp_path: Path) -> None:
    """No candidate, no embed, no row. A comment-only round has nothing this
    metric is about, and filing a "not computed" row for it would fill the
    series with a category that is neither an outage nor a quiet account.
    """
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    embedder = RecordingEmbedder()

    _run_execute(
        tmp_path,
        resources=resources,
        embedder=embedder,
        actions=[Action(kind="like", post_id="a" * 24)],
    )

    assert embedder.embedded == []
    assert resources.user_posts_calls == []
    assert _similarity_events(resources) == []


def test_prior_posts_prefer_the_original_language_body_with_jq_semantics() -> None:
    """`(.originalText // .text)` -- the ORIGINAL-language text, so the
    comparison is never polluted by the translation layer, and jq's `//`,
    which falls back only on `null`/`false`. An EMPTY `originalText` is
    truthy in jq and therefore does NOT fall through to `text`; it is then
    dropped by the blank filter, so `{"originalText": "", "text": "hi"}`
    contributes nothing rather than contributing `"hi"`.

    The same extraction `analysis/behavior_snapshot.py::select_post_texts`
    performs on the same endpoint. Reimplemented rather than imported --
    `act` and `analysis` are peers under spec §5.2 -- so it needs its own
    pin, or the two can drift apart silently.
    """
    items: list[dict[str, Any]] = [
        {"originalText": NEAR, "text": "translated"},
        {"originalText": None, "text": FAR},
        {"originalText": "", "text": "dropped"},
        {"text": "   "},
        {"text": 42},
        {},
    ]
    assert prior_post_texts(items) == [NEAR, FAR]


# ── the recorded row ─────────────────────────────────────────────────────


def test_the_lab_events_metrics_are_flat_scalars(tmp_path: Path) -> None:
    """`agentEventIngest.metrics` is `z.record(z.union([z.string(),
    z.number(), z.boolean(), z.null()]))`
    (`server/src/modules/agents/agents.schemas.ts:59`). A nested object or an
    array fails that union and zod 400s the WHOLE event -- silently, since a
    lab event's failure may never change what a round did. That exact defect
    ran for six weeks on the dream side (`dream/round.py`'s
    `_drift_fail_metrics`, fixed by the task immediately before this one).

    The `type`/`phase`/`outcome` triple is checked against the three zod enums
    at :51-53 for the same reason: an illegal member 400s the row just as
    quietly.
    """
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)

    _run_execute(tmp_path, resources=resources, embedder=RecordingEmbedder())

    event = _similarity_events(resources)[0]
    assert event.type == "cycle"
    assert event.phase == "act"
    assert event.outcome == "success"
    assert event.action is None, "the sampler posted nothing; the action facet belongs to the write"
    assert set(event.metrics) == {
        "maxSim",
        "comparedAgainst",
        "embedderOk",
        "window",
        "threshold",
        "dropped",
    }
    for key, value in event.metrics.items():
        assert isinstance(value, str | int | float | bool) or value is None, key
        assert not isinstance(value, dict | list), key
    body = event.to_wire()
    assert body["metrics"] == event.metrics
    assert 1 <= len(body["summary"]) <= 500


def test_the_row_is_filed_under_the_username_bullet_not_the_directory_name(
    tmp_path: Path,
) -> None:
    """`/agents/{username}/events` is keyed by the platform username. The
    folder name and the `Username` bullet differ on this roster, and a row
    filed under the folder name lands on the wrong account or nowhere.
    """
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)

    _run_execute(tmp_path, resources=resources, embedder=RecordingEmbedder())

    filed = [name for name, summary in resources.event_usernames if "self-similarity" in summary]
    assert filed == [USERNAME]
    assert DIR_NAME not in filed


def test_an_embedder_outage_is_recorded_as_an_outage_not_as_a_quiet_account(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """`embedderOk: false` with a full `comparedAgainst`, plus a WARN.

    An account that has been quiet and a daemon that was down all week produce
    the same flat series on `/lab` unless the row says which happened --
    `analysis/behavior_snapshot.py` records what it costs to lose that
    distinction. The round is unaffected: the post still lands.
    """
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        _run_execute(tmp_path, resources=resources, embedder=RecordingEmbedder(fails=True))

    event = _similarity_events(resources)[0]
    assert event.outcome == "skip"
    assert event.reason == "embedder unreachable"
    assert event.metrics["maxSim"] is None
    assert event.metrics["embedderOk"] is False
    assert event.metrics["comparedAgainst"] == 2
    assert "embedder unreachable" in caplog.text
    assert [p.text for p in resources.created_posts] == [CANDIDATE]


def test_a_corpus_fetch_failure_is_its_own_reason_not_an_empty_corpus(tmp_path: Path) -> None:
    """ "The platform was unreachable" and "this account has been quiet" are
    different facts that produce an identical flat series if folded together
    -- the divergence `analysis/behavior_snapshot.py` deliberately keeps open
    for the same read. The round still posts.
    """
    resources = TracingResources()
    resources.fail("user_posts")
    embedder = RecordingEmbedder()

    _run_execute(tmp_path, resources=resources, embedder=embedder)

    event = _similarity_events(resources)[0]
    assert event.outcome == "skip"
    assert event.reason == "could not fetch prior posts"
    assert event.metrics["maxSim"] is None
    assert event.metrics["comparedAgainst"] == 0
    assert embedder.embedded == []
    assert [p.text for p in resources.created_posts] == [CANDIDATE]


# ── placement: before the write, below the dry-run guard, on both paths ──


def test_the_sample_precedes_the_write_so_the_candidate_is_never_its_own_prior(
    tmp_path: Path,
) -> None:
    """Sampled at the HEAD of `execute_step`, before `create_post`.

    The instant this round's post lands it IS one of `user_posts`' items, so a
    sample taken afterwards compares the candidate against itself and reports
    ~1.0 for every account forever -- a number that looks like the pathology
    being hunted and is an artefact of ordering. `echo_new_posts=True` makes
    the fake behave like the real platform here, so moving the call below the
    loop turns this red.
    """
    resources = TracingResources(echo_new_posts=True)
    resources.user_post_items = _own_posts(NEAR, FAR)
    embedder = RecordingEmbedder()

    _run_execute(tmp_path, resources=resources, embedder=embedder)

    assert resources.trace.index("user_posts") < resources.trace.index("create_post")
    assert embedder.embedded == [[CANDIDATE, NEAR, FAR]]
    assert embedder.embedded[0].count(CANDIDATE) == 1
    assert _similarity_events(resources)[0].metrics["comparedAgainst"] == 2


def test_a_dry_run_takes_no_sample_and_writes_no_event(tmp_path: Path) -> None:
    """Below the `dry_run` guard, because the row is a WRITE.

    Stage 3 is a `--dry-run` shadow round over 23 live accounts (standing
    constraint §9): a sampler above that guard would post 23 lab events per
    round from a mode whose whole contract is that it writes nothing.
    """
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    embedder = RecordingEmbedder()

    _run_execute(tmp_path, resources=resources, embedder=embedder, dry_run=True)

    assert embedder.embedded == []
    assert resources.user_posts_calls == []
    assert resources.lab_events == []
    assert resources.created_posts == []


def test_run_act_without_an_embedder_is_the_step_it_always_was(tmp_path: Path) -> None:
    """`embedder=None` is the default and must be inert.

    `test_act_round.py` (the frozen oracle, 92 tests) and `test_act_steps.py`
    drive both functions without one; if the default did anything, their
    passing would mean nothing about the round they think they are asserting
    on.
    """
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)

    result = run_act(
        persona=_persona(tmp_path),
        resources=resources,
        backend=StubBackend('{"plan":[{"action":"post","text":"' + CANDIDATE + '"}]}'),
        memory_text="",
        agent_root=tmp_path,
        now=NOW,
        rng=random.Random(0),
        health_check=lambda: True,
    )

    assert [p.text for p in resources.created_posts] == [CANDIDATE]
    assert resources.user_posts_calls == []
    assert _similarity_events(resources) == []
    assert result.landed == 1


def test_run_act_with_an_embedder_takes_the_sample(tmp_path: Path) -> None:
    """The direct path (`swil-agent act`) reaches the guard through
    `execute_step`, with the window and threshold `cli.py` hands it.

    `duplicate_window=3` is neither default, so an argument dropped anywhere
    between `run_act` and `resources.user_posts` shows up as a 12 here.
    """
    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    embedder = RecordingEmbedder()

    run_act(
        persona=_persona(tmp_path),
        resources=resources,
        backend=StubBackend('{"plan":[{"action":"post","text":"' + CANDIDATE + '"}]}'),
        memory_text="",
        agent_root=tmp_path,
        now=NOW,
        rng=random.Random(0),
        health_check=lambda: True,
        embedder=embedder,
        duplicate_window=3,
        duplicate_threshold=0.4,
    )

    assert resources.user_posts_calls == [(USERNAME, 3)]
    assert embedder.embedded == [[CANDIDATE, NEAR, FAR]]
    assert resources.created_posts == []
    assert _similarity_events(resources)[0].metrics["threshold"] == 0.4


def test_the_graph_execute_node_takes_the_sample_too(tmp_path: Path) -> None:
    """The graph path is the one `cycle-one.sh` actually runs.

    `run_act` is not its composition -- `graph/nodes.py`'s execute node calls
    `execute_step` directly -- so a sampler placed in `run_act`'s body would
    exclude every production round from the calibration series while every
    direct-path test stayed green. The window and threshold come from
    `deps.settings`, pinned at 5 and 0.4 here: neither default.
    """
    from swil_agent.graph.nodes import CycleDeps, make_execute_node

    resources = TracingResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    embedder = RecordingEmbedder()
    persona = _persona(tmp_path)
    deps = CycleDeps(
        resources=resources,
        backend=StubBackend('{"plan":[{"action":"nothing"}]}'),
        persona_source=FakePersonaSource(),
        embedder=embedder,
        dream_state=FakeState(),
        settings=Settings(
            agent_root=tmp_path, post_duplicate_window=5, post_duplicate_threshold=0.4
        ),
        agent_root=tmp_path,
        health_check=lambda: True,
        memory_text="",
        now=NOW,
        captured_at=CAPTURED_AT,
    )

    update = make_execute_node(deps)(
        {"persona": persona, "actions": [Action(kind="post", text=CANDIDATE)], "vetoed": []}
    )

    assert resources.user_posts_calls == [(USERNAME, 5)]
    assert embedder.embedded == [[CANDIDATE, NEAR, FAR]]
    assert _similarity_events(resources)[0].metrics["window"] == 5
    assert resources.created_posts == []
    assert update["outcome"] is ActOutcome.VETOED_EMPTY
    assert [v.action.kind for v in update["vetoed"]] == ["post"]


# ── it can never cost a round ────────────────────────────────────────────


def test_no_sampling_failure_can_fail_the_round(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """`similarity_step` never raises, whatever a collaborator does.

    The narrow catches cover what the code anticipates (`ApiError` on the
    read, `EmbedderUnavailable`/`ValueError` on the embed); the outer
    `except Exception` covers the class it does not -- an `OSError`, a
    `Resources` method that starts raising a type this module does not list.
    `graph/nodes.py`'s `_fail_soft` catches the same breadth and records the
    reasoning: this is the observability layer, and a measurement outage may
    never decide whether a round happened.
    """

    class ExplodingResources(TracingResources):
        def user_posts(self, username: str, limit: int = 12) -> list[dict[str, Any]]:
            raise OSError("socket exploded")

    resources = ExplodingResources()
    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        sim = similarity_step(
            resources=resources,
            persona=_persona(tmp_path),
            actions=[Action(kind="post", text=CANDIDATE)],
            embedder=RecordingEmbedder(),
        )

    assert sim is None
    assert "the round is unaffected" in caplog.text

    # ...and the same failure inside a real round still posts.
    exploding = ExplodingResources()
    _run_execute(tmp_path, resources=exploding, embedder=RecordingEmbedder())
    assert [p.text for p in exploding.created_posts] == [CANDIDATE]


def test_a_lab_event_outage_cannot_fail_the_sampler(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """`Resources.lab_event` contractually never raises, but any `Resources`
    may be passed and the fake can break that contract -- the same seam
    `test_act_round.py` uses to prove the memory-line write survives an events
    outage.

    Driven at `similarity_step`, not through `execute_step`: a fake that
    breaks the never-raises contract breaks it for `act/executor.py`'s own
    events too, and the round would then die inside the EXECUTOR, which is
    not this task's code and not this task's claim.
    """
    resources = TracingResources(lab_event_raises=ApiError(500, "boom", None))
    resources.user_post_items = _own_posts(NEAR, FAR)

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        sim = similarity_step(
            resources=resources,
            persona=_persona(tmp_path),
            actions=[Action(kind="post", text=CANDIDATE)],
            embedder=RecordingEmbedder(),
        )

    assert sim is None, "an unrecordable measurement is not a recorded one"
    assert "the round is unaffected" in caplog.text


# ── configuration ────────────────────────────────────────────────────────


def test_the_window_and_threshold_defaults_match_settings() -> None:
    """`act/` sits below `config`, so the module constants and the `Settings`
    defaults cannot import each other and are kept equal here."""
    settings = Settings()
    assert settings.post_duplicate_window == DEFAULT_POST_DUPLICATE_WINDOW == 12
    assert settings.post_duplicate_threshold == DEFAULT_POST_DUPLICATE_THRESHOLD == 0.92
    assert Settings(post_duplicate_window=7).post_duplicate_window == 7


def test_act_similarity_is_a_frozen_record_with_a_none_default() -> None:
    """`None`, not `0.0`, is the field default, so a code path that forgets to
    populate `max_sim` records "not computed" rather than a fabricated
    "maximally diverse" sample. Frozen for the same reason every other
    measurement type here is: nothing downstream may edit a recorded number.
    """
    sim = ActSimilarity()
    assert sim.max_sim is None
    assert sim.compared_against == 0
    assert sim.embedder_ok is True
    assert sim.dropped is False
    with pytest.raises(Exception, match="frozen"):
        sim.max_sim = 0.9  # type: ignore[misc]


def test_the_plan_type_still_carries_no_similarity(tmp_path: Path) -> None:
    """The guard reports through `vetoed` and the lab event; `Plan` and
    `Action` stay free of the measurement."""
    assert "similarity" not in Plan.model_fields
    assert "max_sim" not in Action.model_fields


# ── the two-language contract ───────────────────────────────────────────────
#
# The measured sample's summary is prose built inline in `_similarity_event`,
# and one consumer has to key on it: `server/src/modules/agents/agents.collapse.ts`
# narrows its SQL on `summary = 'act self-similarity measured'` because nothing
# else in `agent_events` distinguishes these rows from the executor's own
# `cycle`/`act` events.  Rewording it here reddens THIS suite loudly -- which is
# exactly the trap, because a contributor who reads only a Python failure
# updates the expected string and moves on, while the collapse watch quietly
# starts answering `basis: 'length-only'` for every account, a result
# indistinguishable from a window that predates the sampler.  So the pin below
# reaches across the language boundary, and its mirror in
# `server/src/modules/agents/agents.collapse.test.ts` reaches back.

_COLLAPSE_TS = Path(__file__).resolve().parents[3] / "server/src/modules/agents/agents.collapse.ts"


def _executable_ts(source: str) -> str:
    """`source` with its comment LINES dropped (standing constraint §14).

    The literal appears in that file's prose too -- its module header names the
    rows the query selects -- so a guard that greps the raw text can be
    satisfied by a comment while the real constant is gone.
    """
    return "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith(("//", "*", "/*"))
    )


def test_the_summary_the_server_queries_on_is_the_summary_this_module_files(
    tmp_path: Path,
) -> None:
    """The measured sample's summary is a contract with the TypeScript side.

    Both halves are asserted: the literal an actually-emitted event carries --
    taken off a real `execute_step` run rather than restated, so a change to how
    the summary is BUILT is caught as well as a change to the words -- and the
    literal the collapse endpoint selects on.
    """
    resources = FakeResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    _run_execute(tmp_path, resources=resources, embedder=RecordingEmbedder())

    summary = _similarity_events(resources)[0].summary
    assert summary == "act self-similarity measured"

    executable = _executable_ts(_COLLAPSE_TS.read_text(encoding="utf-8"))
    pattern = rf"^export const \w+ = '{re.escape(summary)}';$"
    assert re.search(pattern, executable, re.MULTILINE), (
        f'{_COLLAPSE_TS.name} no longer selects on "{summary}". That endpoint joins '
        "post length against the rows similarity_step files under this summary: if "
        "the rename was deliberate, change ACT_SIMILARITY_SUMMARY there in the same "
        "commit -- otherwise the collapse watch silently reports basis: 'length-only' "
        "for every account, which reads as 'the window predates the sampler'."
    )


def test_a_dropped_candidate_keeps_the_summary_the_server_queries_on(tmp_path: Path) -> None:
    """Metric (b) is computed over candidates, dropped ones included, so a
    dropped row must still match the collapse endpoint's summary."""
    resources = FakeResources()
    resources.user_post_items = _own_posts(NEAR, FAR)
    _run_execute(tmp_path, resources=resources, embedder=RecordingEmbedder(DUPLICATE))

    event = _similarity_events(resources)[0]
    assert event.metrics["dropped"] is True
    assert event.summary == "act self-similarity measured"
