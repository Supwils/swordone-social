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
    prompt = dream_prompt(
        "v2", make_persona(), memory_tail=TAIL, group_memory="- @a（A）：1 条回应"
    )
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
