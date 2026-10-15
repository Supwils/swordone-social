"""`bench/persona.py`: which persona, and the texts the bench takes from it.

The system-prompt pins replace `test_scripts.py`'s
`test_benchmark_system_prompt_carries_no_frontmatter`, which ran the Bash
`PTEXT ... SYS` block of the deleted `benchmark-run.sh` (S3 Review Focus 5).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from swil_agent.bench.errors import BenchStop
from swil_agent.bench.persona import (
    check_persona_name,
    display_name,
    find_persona_dir,
    is_v2,
    load_bench_persona,
    reference_text,
    system_prompt,
)

_V2_PERSONA = (
    "---\nusername: aa\ndisplay_name: 阿甲\nmodel: claude:claude-opus-5-5\n"
    "board: making\nera: 3\n---\n# 阿甲\n\n一段人设。\n\n## 最近\n- 一条\n"
)

_V1_PERSONA = (
    "# 流觞\n\n## 身份\n- **Username:** liushang\n- **Display Name:** 流觞\n"
    "- **AI Backend:** claude\n- **Model:** haiku\n\n## 性格\n安静。\n\n"
    "## 发帖节律\n- 每天一条\n\n## 规则\n- 不用感叹号\n"
)


def _write(root: Path, base: str, name: str, raw: bytes, *, key: bool = True) -> Path:
    directory = root / base / name
    directory.mkdir(parents=True)
    (directory / "personality.md").write_bytes(raw)
    if key:
        (directory / "api_key.txt").write_text("k\n", encoding="utf-8")
    return directory


@pytest.mark.parametrize(
    "raw",
    [
        _V2_PERSONA.encode(),
        _V2_PERSONA.replace("\n", "\r\n").encode(),
        b"\xef\xbb\xbf" + _V2_PERSONA.encode(),
    ],
    ids=["lf", "crlf", "bom"],
)
def test_a_v2_system_prompt_carries_no_frontmatter(tmp_path: Path, raw: bytes) -> None:
    """The bench's system prompt must never name the model under test."""
    _write(tmp_path, "agents", "aa", raw)
    persona = load_bench_persona(tmp_path, "aa")
    assert persona.display == "阿甲"
    assert persona.system.startswith("# 阿甲")
    for leak in ("---", "model:", "claude-opus", "username:", "\r", "﻿"):
        assert leak not in persona.system
    assert persona.system.endswith("## 最近\n- 一条")


def test_an_era_2_v1_file_is_used_raw_and_carries_no_frontmatter(tmp_path: Path) -> None:
    """A sealed Era 2 persona (archive/era-2/humans, v1, no frontmatter):
    the file as it is, minus its trailing newlines -- no `---` block and no
    lowercase `model:` line can reach the model, because there is none."""
    _write(tmp_path, "archive/era-2/humans", "liushang", _V1_PERSONA.encode())
    persona = load_bench_persona(tmp_path, "liushang")
    assert persona.system == _V1_PERSONA.rstrip("\n")
    assert "---" not in persona.system
    assert "\nmodel:" not in persona.system
    assert persona.display == "流觞"
    assert persona.reference == _V1_PERSONA.split("\n\n## 发帖节律")[0]
    assert persona.raw == _V1_PERSONA


def test_a_v1_file_keeps_its_bom_and_crs_as_bash_did() -> None:
    raw = "﻿# x\r\n- **display name:** 某人\r\n\r\n"
    assert not is_v2("# x")
    assert system_prompt(raw) == "﻿# x\r\n- **display name:** 某人\r\n\r"
    # Case-insensitive bullet, CR dropped from the name.
    assert display_name(raw) == "某人"


def test_v1_display_cuts_after_the_last_double_star_space() -> None:
    """`sed 's/.*\\*\\* //'` is greedy: everything up to the LAST `** `."""
    raw = "- **Display Name:** **甲** 乙\n- **Display Name:** 丙\n"
    assert display_name(raw) == "乙"
    assert display_name("# no bullet\n") == ""
    assert display_name("- **Display Name:**无空格\n") == "- **Display Name:**无空格"


def test_v2_display_drops_one_edge_quote_each_side_and_stops_at_the_fence() -> None:
    assert display_name("---\ndisplay_name: '阿甲'\n---\n") == "阿甲"
    assert display_name('---\ndisplay_name:   "阿\'甲"\n---\n') == "阿'甲"
    assert display_name("---\nusername: a\n---\ndisplay_name: 外\n") == ""


def test_the_frontmatter_walk_matches_the_bash_awk() -> None:
    # A later `---` is body; leading blank lines after the fence stay.
    assert system_prompt("---\na: 1\n---\n\n# x\n---\ny\n\n") == "\n# x\n---\ny"
    # An unclosed frontmatter swallows the whole file.
    assert system_prompt("---\na: 1\n# x\n") == ""
    # `---` must be the whole first line.
    assert not is_v2("--- \n# x\n")
    assert not is_v2("")


def test_reference_text_stops_at_the_rhythm_heading() -> None:
    assert reference_text("# x\n\n声音\n\n## 发帖节律\n- 规则") == "# x\n\n声音"
    assert reference_text("# x\n声音") == "# x\n声音"
    assert reference_text("# x\n## 发帖节律（旧）\n后面") == "# x"


def test_resolution_order_is_agents_then_era_2_agents_then_humans(tmp_path: Path) -> None:
    humans = _write(tmp_path, "archive/era-2/humans", "p", b"# h\n")
    assert find_persona_dir(tmp_path, "p") == humans
    sealed = _write(tmp_path, "archive/era-2/agents", "p", b"# s\n")
    assert find_persona_dir(tmp_path, "p") == sealed
    live = _write(tmp_path, "agents", "p", b"# a\n")
    assert find_persona_dir(tmp_path, "p") == live
    assert find_persona_dir(tmp_path, "nobody") is None


def test_a_missing_persona_is_66_and_missing_files_are_75(tmp_path: Path) -> None:
    with pytest.raises(BenchStop) as missing:
        load_bench_persona(tmp_path, "nobody")
    assert missing.value.code == 66
    assert missing.value.message == "bench: persona 'nobody' not found"

    (tmp_path / "agents" / "empty").mkdir(parents=True)
    with pytest.raises(BenchStop) as no_file:
        load_bench_persona(tmp_path, "empty")
    assert no_file.value.code == 75
    assert "no personality.md for empty" in no_file.value.message

    _write(tmp_path, "agents", "nokey", _V2_PERSONA.encode(), key=False)
    with pytest.raises(BenchStop) as no_key:
        load_bench_persona(tmp_path, "nokey")
    assert no_key.value.code == 75
    assert "no api_key.txt for nokey (needed to POST)" in no_key.value.message


def test_an_undecodable_byte_does_not_stop_the_run(tmp_path: Path) -> None:
    _write(tmp_path, "agents", "bad", b"# x\n\xff\n")
    assert load_bench_persona(tmp_path, "bad").system == "# x\n�"


@pytest.mark.parametrize("name", ["../aa", "a", "x" * 25, "a-b", "a/b", "阿甲", ""])
def test_a_name_the_server_refuses_is_64_before_it_becomes_a_path(
    tmp_path: Path, name: str
) -> None:
    """`benchmarkRunIngest.persona` is `^[a-zA-Z0-9_]{2,24}$`; `../x` would
    otherwise read outside `agents/` and write outside `results/`."""
    with pytest.raises(BenchStop) as stop:
        load_bench_persona(tmp_path, name)
    assert stop.value.code == 64


def test_a_valid_name_passes() -> None:
    for name in ("aa", "liushang", "x_1", "Z" * 24):
        check_persona_name(name)
