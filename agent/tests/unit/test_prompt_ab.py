"""`prompt-ab` (spec 2026-10-17 §5): one fetched context per account through v1
and v2, nothing posted. Fake backend and fake embedder, no network."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from typer.testing import CliRunner

from swil_agent import cli
from swil_agent.bench import prompt_ab as ab
from swil_agent.cli import compose
from swil_agent.cli.errors import AccountSetupError
from swil_agent.config import Settings
from swil_agent.models import ActContext, ActSources, RhythmDecision, RhythmPolicy
from swil_agent.policy import PRODUCTION_HOST

from ._golden_seams import _FakeEmbedderClient, _patch_cycle_seams
from ._runners import FakeEmbedder, FakeResources, SilentBackend, StubBackend, make_persona

runner = CliRunner()
MUST = RhythmDecision(
    policy=RhythmPolicy.MUST_POST, prefer_non_post="comment", guidance="g", roll=1
)
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
    backend = StubBackend(
        '{"plan":[{"action":"post","text":"今天"},{"action":"like","post":"p1"}]}'
    )
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
    assert sample.arm == "claude"  # no pinned model: the backend alone


def test_a_silent_backend_is_an_outage_not_an_invalid_reply() -> None:
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
    assert sample.backend_unavailable is True


def test_an_outage_leaves_the_rate_denominators_and_is_counted_on_its_own() -> None:
    down = replace(_act("v1", valid=False, posted=False), backend_unavailable=True)
    bad = _act("v1", valid=False, posted=False)  # reached, but not JSON
    good = _act("v1")
    row = ab.summarize_act([down, bad, good])["claude:opus"]["v1"]
    assert (row["samples"], row["backendUnavailable"]) == (3, 1)
    assert row["jsonValidRate"] == 0.5  # 1 of the 2 that reached the model
    assert row["mustPostObeyed"] == 1.0  # the outage is not a disobeyed verdict
    only_down = ab.summarize_act([down])["claude:opus"]["v1"]
    assert only_down["jsonValidRate"] is None
    v2 = ab.summarize_act([_act("v2")])["claude:opus"]["v2"]
    assert ab.act_verdict(only_down, v2) == "UNMEASURED"


def _act(
    version: str,
    *,
    valid: bool = True,
    posted: bool = True,
    policy: str = "must_post",
    proposed: int = 2,
    dropped: dict[str, int] | None = None,
) -> ab.ActSample:
    return ab.ActSample(
        account="zenith",
        arm="claude:opus",
        version=version,
        json_valid=valid,
        proposed=proposed,
        dropped=dropped or {},
        policy=policy,
        posted=posted,
        card_sim=0.5 if posted else None,
        user_chars=100,
        latency_ms=10,
    )


def _both_directions(version: str, **v2: Any) -> list[ab.ActSample]:
    return [_act(version, **v2), _act(version, policy="no_post", posted=False)]


def test_the_act_summary_and_the_pass_bar() -> None:
    samples = [
        *_both_directions("v1"),
        _act("v2"),
        _act("v2", policy="no_post", posted=False, dropped={"unknown_handle": 1}),
    ]
    arms = ab.summarize_act(samples)
    v1, v2 = arms["claude:opus"]["v1"], arms["claude:opus"]["v2"]
    assert v1["jsonValidRate"] == 1.0 and v1["mustPostObeyed"] == 1.0 and v1["noPostObeyed"] == 1.0
    assert v2["dropRate"] == 0.25 and v2["drops"] == {"unknown_handle": 1}
    assert ab.act_verdict(v1, v2) == "FAIL"  # 25 points over v1's 0
    assert ab.act_verdict(v1, {**v2, "dropRate": 0.02}) == "PASS"  # the +2-point slack, inclusive
    assert ab.act_verdict(v1, {**v2, "dropRate": 0.0, "jsonValidRate": 0.5}) == "FAIL"
    assert ab.act_verdict(v1, {**v2, "dropRate": 0.0, "noPostObeyed": 0.5}) == "FAIL"


def test_the_drop_slack_is_inclusive_despite_float_rounding() -> None:
    """17/100 - 3/20 is 0.020000000000000018 in floats: still within 2 points."""
    v1 = {"jsonValidRate": 1.0, "mustPostObeyed": 1.0, "noPostObeyed": 1.0, "dropRate": 3 / 20}
    assert ab.act_verdict(v1, {**v1, "dropRate": 17 / 100}) == "PASS"
    assert ab.act_verdict(v1, {**v1, "dropRate": 18 / 100}) == "FAIL"


def test_json_invalid_samples_are_no_evidence_about_obedience() -> None:
    """A JSON-invalid must-post sample did not post, but it is counted by the
    JSON-valid gate, not as disobedience."""
    arms = ab.summarize_act(
        [
            _act("v1"),
            _act("v1", valid=False, posted=False, proposed=0),
            _act("v1", policy="no_post", posted=False),
            _act("v1", policy="no_post", valid=False, posted=False, proposed=0),
        ]
    )
    v1 = arms["claude:opus"]["v1"]
    assert (v1["jsonValidRate"], v1["mustPostObeyed"], v1["noPostObeyed"]) == (0.5, 1.0, 1.0)


def test_an_arm_that_saw_one_direction_only_is_unmeasured_never_pass() -> None:
    arms = ab.summarize_act([_act("v1", proposed=0), _act("v2", proposed=0)])
    v1, v2 = arms["claude:opus"]["v1"], arms["claude:opus"]["v2"]
    assert v1["noPostObeyed"] == ab.UNMEASURED and v1["dropRate"] is None
    assert ab.act_verdict(v1, v2) == "UNMEASURED"
    # A measured regression still reads FAIL, not UNMEASURED.
    assert ab.act_verdict(v1, {**v2, "mustPostObeyed": 0.0}) == "FAIL"
    # Every must-post sample JSON-invalid in v2: that direction is unmeasured there.
    only_invalid = ab.summarize_act(
        [*_both_directions("v1"), _act("v2", valid=False, posted=False, proposed=0)]
    )["claude:opus"]
    assert only_invalid["v2"]["mustPostObeyed"] == ab.UNMEASURED
    assert ab.act_verdict(only_invalid["v1"], only_invalid["v2"]) == "FAIL"  # JSON-valid gate


def test_four_accounts_in_one_arm_get_two_of_each_direction() -> None:
    arms = {"d": "claude:opus", "b": "claude:opus", "a": "claude:opus", "c": "claude:opus"}
    arms |= {"y": "grok:grok-4.6", "x": "grok:grok-4.6", "z": "grok:grok-4.6"}
    assert ab.assign_policies(arms) == {
        "a": RhythmPolicy.MUST_POST,
        "b": RhythmPolicy.NO_POST,
        "c": RhythmPolicy.MUST_POST,
        "d": RhythmPolicy.NO_POST,
        "x": RhythmPolicy.MUST_POST,
        "y": RhythmPolicy.NO_POST,
        "z": RhythmPolicy.MUST_POST,
    }


@pytest.mark.parametrize(
    ("policy", "posts_today", "probability", "expected", "ceiling_reached"),
    [
        (RhythmPolicy.MUST_POST, 0, 60, RhythmPolicy.MUST_POST, False),
        (RhythmPolicy.NO_POST, 0, 60, RhythmPolicy.NO_POST, False),
        (RhythmPolicy.MUST_POST, 1, 60, RhythmPolicy.NO_POST, True),  # at the ceiling
        (RhythmPolicy.MUST_POST, 0, 0, RhythmPolicy.NO_POST, False),  # never posts
        (RhythmPolicy.NO_POST, 0, 100, RhythmPolicy.MUST_POST, False),  # always posts
    ],
)
def test_the_assigned_rhythm_is_one_the_round_could_reach(
    policy: RhythmPolicy,
    posts_today: int,
    probability: int,
    expected: RhythmPolicy,
    ceiling_reached: bool,
) -> None:
    rhythm = ab.assigned_rhythm(policy, posts_today=posts_today, probability=probability, ceiling=1)
    assert (rhythm.policy, rhythm.ceiling_reached) == (expected, ceiling_reached)


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


def test_a_dream_with_a_short_embed_batch_reports_no_restate_count() -> None:
    sample = ab.sample_dream(
        persona=make_persona(),
        backend=StubBackend('{"recent": ["一", "二"]}'),
        memory_tail="",
        group_memory="",
        version="v1",
        embedder=FakeEmbedder(),  # one vector per call, whatever the batch
        clock=_clock(),
    )
    assert sample.items == 2 and sample.restated is None


@pytest.mark.parametrize("backend", [SilentBackend(), StubBackend("no list here")])
def test_a_dream_with_no_usable_reply_is_an_invalid_sample(backend: Any) -> None:
    sample = ab.sample_dream(
        persona=make_persona(),
        backend=backend,
        memory_tail="",
        group_memory="",
        version="v2",
        embedder=_FakeEmbedderClient(),
        clock=_clock(),
    )
    assert (sample.json_valid, sample.items, sample.mean_len, sample.restated) == (
        False,
        0,
        None,
        None,
    )


def test_the_dream_summary() -> None:
    def dream(version: str, items: int, restated: int | None) -> ab.DreamSample:
        return ab.DreamSample(
            account="zenith",
            arm="claude:opus",
            version=version,
            json_valid=items > 0,
            items=items,
            mean_len=10.0 if items else None,
            restated=restated,
            user_chars=50,
            latency_ms=5,
        )

    arms = ab.summarize_dream([dream("v1", 4, 1), dream("v1", 0, None), dream("v2", 2, None)])
    v1, v2 = arms["claude:opus"]["v1"], arms["claude:opus"]["v2"]
    assert (v1["samples"], v1["jsonValidRate"], v1["meanItems"]) == (2, 0.5, 2.0)
    assert v1["restateShare"] == 0.25 and v1["meanLength"] == 10.0
    assert v2["restateShare"] is None  # embedder down on every measured sample


def test_the_report_shape_file_and_table(tmp_path: Path) -> None:
    report = ab.build_report(
        phase="act",
        k=1,
        generated_at="2026-10-17T00:00:00Z",
        accounts=["zenith"],
        samples=[*_both_directions("v1"), *_both_directions("v2")],
        expected_arms=["claude:opus"],
    )
    assert set(report) == {
        "phase",
        "k",
        "generatedAt",
        "accounts",
        "skippedAccounts",
        "arms",
        "passes",
        "allArmsPass",
        "unpairedArms",
        "samples",
    }
    assert report["passes"] == {"claude:opus": "PASS"}
    assert (report["allArmsPass"], report["unpairedArms"]) == (True, [])
    path = ab.write_report(report, tmp_path / "prompt-ab", stamp="20261017T000000Z")
    assert path.name == "20261017T000000Z-act.json"
    assert json.loads(path.read_text(encoding="utf-8"))["k"] == 1
    table = ab.render_table(report)
    assert "claude:opus: PASS" in table
    assert "all arms pass: yes" in table and "unpaired arms: none" in table
    row = next(line for line in table.splitlines() if line.startswith("claude:opus  v1"))
    assert row.split()[-1] == "100"  # userChars as an integer


def test_unpaired_and_unmeasured_arms_keep_all_arms_pass_false() -> None:
    def report(samples: list[ab.ActSample], expected: list[str]) -> dict[str, Any]:
        return ab.build_report(
            phase="act",
            k=1,
            generated_at="2026-10-17T00:00:00Z",
            accounts=["zenith"],
            samples=samples,
            expected_arms=expected,
        )

    paired = [*_both_directions("v1"), *_both_directions("v2")]
    skipped = report(paired, ["claude:opus", "grok:grok-4.6"])  # every grok account skipped
    assert skipped["unpairedArms"] == ["grok:grok-4.6"] and skipped["allArmsPass"] is False
    assert "unpaired arms: grok:grok-4.6" in ab.render_table(skipped)

    one_version = report([_act("v1")], ["claude:opus"])
    assert (one_version["passes"], one_version["unpairedArms"]) == ({}, ["claude:opus"])
    assert one_version["allArmsPass"] is False

    unmeasured = report([_act("v1"), _act("v2")], ["claude:opus"])
    assert unmeasured["passes"] == {"claude:opus": "UNMEASURED"}
    assert unmeasured["allArmsPass"] is False
    table = ab.render_table(unmeasured)
    assert "claude:opus: UNMEASURED" in table and ab.UNMEASURED in table
    assert "all arms pass: no" in table
    assert " - " in ab.render_table(report([_act("v1", proposed=0)], []))  # no drop rate


def test_a_dream_report_has_no_pass_bar() -> None:
    sample = ab.DreamSample(
        account="zenith",
        arm="claude:opus",
        version="v1",
        json_valid=True,
        items=1,
        mean_len=3.0,
        restated=0,
        user_chars=10,
        latency_ms=1,
    )
    report = ab.build_report(
        phase="dream",
        k=1,
        generated_at="2026-10-17T00:00:00Z",
        accounts=["zenith"],
        samples=[sample],
    )
    assert "passes" not in report
    assert "restateShare" in ab.render_table(report)


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


def _seams(
    monkeypatch: pytest.MonkeyPatch,
    root: Path,
    resources: FakeResources,
    **settings: Any,
) -> None:
    resolved = Settings(agent_root=root, era_start=datetime(2026, 10, 1, tzinfo=UTC), **settings)
    _patch_cycle_seams(
        monkeypatch,
        root,
        settings=resolved,
        resources=lambda persona, s: resources,
        backend=lambda persona, s: StubBackend(
            '{"plan":[{"action":"post","text":"今天"}],"recent":["一件新事"]}'
        ),
    )


def _report(root: Path, phase: str = "act") -> dict[str, Any]:
    (path,) = (root / "bench" / "results" / "prompt-ab").glob(f"*-{phase}.json")
    loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return loaded


def _assert_no_platform_write(resources: FakeResources) -> None:
    for written in (
        resources.calls,
        resources.created_posts,
        resources.comments,
        resources.liked,
        resources.followed,
        resources.dms,
        resources.lab_events,
        resources.profile_patches,
        resources.post_vectors,
        resources.snapshots,
        resources.marked_read,
        resources.behavior_snapshots,
        resources.interventions,
    ):
        assert written == []


def test_the_command_samples_both_versions_and_writes_nothing_to_the_platform(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _roster(tmp_path, "zenith")
    resources = FakeResources()
    _seams(monkeypatch, tmp_path, resources)

    result = runner.invoke(
        cli.app, ["prompt-ab", "--accounts", "zenith", "--k", "1", "--seed", "0"]
    )

    assert result.exit_code == 0, result.output
    report = _report(tmp_path)
    assert [s["version"] for s in report["samples"]] == ["v1", "v2"]
    assert report["accounts"] == ["zenith"] and report["k"] == 1
    # One account is one rhythm direction: the arm cannot pass on it.
    assert report["passes"] == {"claude:opus": "UNMEASURED"}
    assert (report["allArmsPass"], report["unpairedArms"]) == (False, [])
    assert "claude:opus" in result.stdout and "report: " in result.stdout
    _assert_no_platform_write(resources)


def test_k_samples_per_version_and_a_comma_separated_account_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _roster(tmp_path, "zenith", "yonder", "xeno")
    _seams(monkeypatch, tmp_path, FakeResources())
    result = runner.invoke(cli.app, ["prompt-ab", "--accounts", "yonder, zenith", "--k", "2"])
    assert result.exit_code == 0, result.output
    samples = _report(tmp_path)["samples"]
    assert [(s["account"], s["version"]) for s in samples] == [
        ("yonder", "v1"),
        ("yonder", "v1"),
        ("yonder", "v2"),
        ("yonder", "v2"),
        ("zenith", "v1"),
        ("zenith", "v1"),
        ("zenith", "v2"),
        ("zenith", "v2"),
    ]


def test_the_command_assigns_each_arm_both_directions_shared_by_v1_and_v2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _roster(tmp_path, "dawn", "brook", "alder", "cedar")
    _seams(monkeypatch, tmp_path, FakeResources())
    result = runner.invoke(cli.app, ["prompt-ab", "--k", "1", "--seed", "7"])
    assert result.exit_code == 0, result.output
    report = _report(tmp_path)
    policies = {(s["account"], s["version"]): s["policy"] for s in report["samples"]}
    assert policies == {
        (name, version): policy
        for name, policy in [
            ("alder", "must_post"),
            ("brook", "no_post"),
            ("cedar", "must_post"),
            ("dawn", "no_post"),
        ]
        for version in ("v1", "v2")
    }
    # The stub always posts: must-post obeyed, no-post vetoed and disobeyed.
    v1 = report["arms"]["claude:opus"]["v1"]
    assert (v1["mustPostObeyed"], v1["noPostObeyed"]) == (1.0, 0.0)
    assert report["passes"] == {"claude:opus": "PASS"} and report["allArmsPass"] is True


def test_a_broken_account_is_skipped_and_the_rest_still_sampled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _roster(tmp_path, "zenith", broken="broken")
    _seams(monkeypatch, tmp_path, FakeResources())
    result = runner.invoke(cli.app, ["prompt-ab", "--k", "1"])
    assert result.exit_code == 0, result.output
    assert "SKIP broken" in result.stdout
    assert {s["account"] for s in _report(tmp_path)["samples"]} == {"zenith"}


def test_an_arm_whose_every_account_fails_to_sample_is_unpaired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The persona loads (so its arm is known) but sampling fails: SKIP, and
    the arm is listed unpaired rather than silently missing."""
    _roster(tmp_path, "zenith")
    grok = tmp_path / "agents" / "gork"
    grok.mkdir()
    (grok / "personality.md").write_text(
        _PERSONA.format(name="gork").replace("claude:opus", "grok:grok-4.6"), encoding="utf-8"
    )
    resources = FakeResources()
    _seams(monkeypatch, tmp_path, resources)

    def resources_for(persona: Any, settings: Settings) -> FakeResources:
        if persona.username == "gork":
            raise AccountSetupError("gork: no api_key.txt (test)")
        return resources

    monkeypatch.setattr(compose, "resources_for", resources_for)
    result = runner.invoke(cli.app, ["prompt-ab", "--k", "1"])
    assert result.exit_code == 0, result.output
    assert "SKIP gork -- gork: no api_key.txt (test)" in result.stdout
    report = _report(tmp_path)
    assert report["unpairedArms"] == ["grok:grok-4.6"] and report["allArmsPass"] is False
    assert "unpaired arms: grok:grok-4.6" in result.stdout


def _write_refusing_api() -> tuple[httpx.MockTransport, list[str]]:
    """The platform over the wire: every GET answers an empty page, every
    other method is recorded and refused with a 500."""
    writes: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method != "GET":
            writes.append(f"{request.method} {request.url.path}")
            return httpx.Response(500, json={"error": {"code": "WRITE_REFUSED"}})
        if request.url.path.endswith("/auth/me"):  # the contacts read asks who it is
            return httpx.Response(200, json={"data": {"user": {"username": "zenith"}}})
        return httpx.Response(200, json={"data": {"items": []}})

    return httpx.MockTransport(handler), writes


@pytest.mark.parametrize("phase", ["act", "dream"])
def test_against_the_production_host_nothing_reaches_a_write_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    """Review focus 5: SWIL_URL on the production host with
    SWIL_REQUIRE_NON_PROD=1, one broken account -- the others are still
    sampled through the real `Resources`, and no request other than a GET
    leaves the process."""
    _roster(tmp_path, "zenith", "yonder", broken="broken")
    for name in ("zenith", "yonder"):
        (tmp_path / "agents" / name / "api_key.txt").write_text("swil_test_key\n")
    transport, writes = _write_refusing_api()
    real_resources_for = compose.resources_for
    _seams(
        monkeypatch,
        tmp_path,
        FakeResources(),
        swil_url=f"https://{PRODUCTION_HOST}",
        swil_require_non_prod=True,
    )
    monkeypatch.setattr(
        compose,
        "resources_for",
        lambda persona, settings: real_resources_for(persona, settings, transport=transport),
    )

    result = runner.invoke(cli.app, ["prompt-ab", "--phase", phase, "--k", "1"])

    assert result.exit_code == 0, result.output
    assert {s["account"] for s in _report(tmp_path, phase)["samples"]} == {"yonder", "zenith"}
    assert writes == []


def test_the_dream_phase_writes_a_dream_report_and_nothing_else(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _roster(tmp_path, "zenith")
    before = (tmp_path / "agents" / "zenith" / "personality.md").read_bytes()
    resources = FakeResources()
    _seams(monkeypatch, tmp_path, resources)
    result = runner.invoke(cli.app, ["prompt-ab", "--phase", "dream", "--k", "1"])
    assert result.exit_code == 0, result.output
    report = _report(tmp_path, "dream")
    assert [(s["version"], s["items"]) for s in report["samples"]] == [("v1", 1), ("v2", 1)]
    assert (tmp_path / "agents" / "zenith" / "personality.md").read_bytes() == before
    assert not (tmp_path / "agents" / "zenith" / "personality.archive.md").exists()
    _assert_no_platform_write(resources)


def test_no_sample_at_all_exits_75(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _roster(tmp_path, broken="broken")
    _seams(monkeypatch, tmp_path, FakeResources())
    result = runner.invoke(cli.app, ["prompt-ab", "--k", "1"])
    assert result.exit_code == 75
    assert not (tmp_path / "bench" / "results" / "prompt-ab").exists()


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


def test_a_partial_accounts_run_leaves_the_other_arms_unpaired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _roster(tmp_path, "zenith", "zora")
    gork = tmp_path / "agents" / "gork"
    gork.mkdir()
    (gork / "personality.md").write_text(
        _PERSONA.format(name="gork").replace("claude:opus", "grok:grok-4.6"), encoding="utf-8"
    )
    _seams(monkeypatch, tmp_path, FakeResources())
    result = runner.invoke(cli.app, ["prompt-ab", "--accounts", "zenith,zora", "--k", "1"])
    assert result.exit_code == 0, result.output
    report = _report(tmp_path)
    assert report["unpairedArms"] == ["grok:grok-4.6"]
    assert report["allArmsPass"] is False and report["skippedAccounts"] == []


def test_a_persona_that_fails_to_load_leaves_its_arm_unpaired_and_is_named(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _roster(tmp_path, "zenith")
    gork = tmp_path / "agents" / "gork"
    gork.mkdir()
    # Readable model line, but no topics: the full load refuses it.
    text = _PERSONA.format(name="gork").replace("claude:opus", "grok:grok-4.6")
    (gork / "personality.md").write_text(text.replace("topics: [alpha]\n", ""), encoding="utf-8")
    _roster(tmp_path, broken="broken")
    _seams(monkeypatch, tmp_path, FakeResources())
    result = runner.invoke(cli.app, ["prompt-ab", "--k", "1"])
    assert result.exit_code == 0, result.output
    report = _report(tmp_path)
    assert set(report["skippedAccounts"]) == {
        "gork",
        "broken",
    }
    assert "grok:grok-4.6" in report["unpairedArms"]
    assert "unreadable:broken" in report["unpairedArms"]
    assert report["allArmsPass"] is False
