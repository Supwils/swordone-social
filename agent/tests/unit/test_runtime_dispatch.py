"""The unattended cycle is the Python LangGraph run, dispatched by thin scripts.

`cycle-one.sh` execs `swil-agent cycle`; `opportunistic-round.sh` fans out
through `cycle-one.sh`, sweeps only Era 3 accounts and stages only
`agent/agents`. These tests read the shipped scripts and compile the shipped
graph so a regression fails here rather than in a round.
"""

from __future__ import annotations

import re
from pathlib import Path

from swil_agent.cli import cycle
from swil_agent.graph.cycle import BEHAVIOR_SNAPSHOT, DREAM, LOGIN, build_cycle, run_cycle

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def _logical_lines(script: str) -> list[str]:
    """Executable text: comments stripped, backslash continuations joined.

    A search that also matches the cutover *comment* would stay green if the
    real `if` block were deleted. Same trick as `test_backends.py`.
    """
    text = (SCRIPTS / script).read_text(encoding="utf-8")
    text = re.sub(r"\\\n\s*", " ", text)
    return [line for line in text.splitlines() if not line.lstrip().startswith("#")]


def test_cycle_one_execs_the_python_cycle_with_auto_and_no_runtime_switch() -> None:
    text = (SCRIPTS / "cycle-one.sh").read_text(encoding="utf-8")
    live = "\n".join(_logical_lines("cycle-one.sh"))

    assert 'exec uv run --project "$ROOT_DIR" swil-agent cycle "$NAME" --auto' in live
    # FORCE_DREAM=1 is the only way to drop --auto.
    assert 'exec uv run --project "$ROOT_DIR" swil-agent cycle "$NAME"\n' in live + "\n"
    assert "SWIL_RUNTIME" not in text
    for retired in ("auto-run.sh", "dream.sh", "heartbeat.sh"):
        assert retired not in live


def test_opportunistic_round_fans_out_through_cycle_one_only() -> None:
    live = "\n".join(_logical_lines("opportunistic-round.sh"))
    assert 'bash "$SCRIPT_DIR/cycle-one.sh" "$name"' in live
    assert "auto-run.sh" not in live
    assert "heartbeat.sh" not in live


def test_opportunistic_round_roster_and_auto_commit_are_era_3_agents_only() -> None:
    live = "\n".join(_logical_lines("opportunistic-round.sh"))
    assert "humans" not in live
    assert "round.skip" not in live
    assert "grep -qx 'era: 3'" in live
    assert "git add agent/agents\n" in live + "\n"


def test_swil_agent_cycle_is_one_langgraph_act_to_dream_run() -> None:
    doc = cycle.__doc__ or ""
    assert "ONE LangGraph run" in doc
    assert "login -> act -> dream" in doc
    assert run_cycle.__code__.co_filename.endswith("graph/cycle.py")

    compiled = build_cycle().compile()
    drawn = compiled.get_graph()
    nodes = {node.id for node in drawn.nodes.values()}
    assert LOGIN in nodes
    assert DREAM in nodes
    edges = {(edge.source, edge.target) for edge in drawn.edges}
    assert (BEHAVIOR_SNAPSHOT, DREAM) in edges
    assert ("__start__", LOGIN) in edges
