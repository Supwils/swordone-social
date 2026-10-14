"""Architecture invariants enforced as tests, not conventions."""

import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2] / "swil_agent"
_ROOT = PACKAGE.parent  # directory containing "swil_agent" — the dotted-name anchor


def _own_package(path: Path) -> str:
    """Dotted package that owns `path`, matching Python's own `__package__`.

    For `swil_agent/llm/base.py` that's `"swil_agent.llm"` — the package
    directly containing the file — whether or not the file is itself an
    `__init__.py` (a package's `__init__.py` IS that package, so it gets the
    same `__package__` as its sibling modules, not one level up).
    """
    parts = path.relative_to(_ROOT).parts[:-1]
    return ".".join(parts)


def _resolve_from_import(node: ast.ImportFrom, package: str) -> str:
    """Resolve `from X import ...` (absolute or relative) to one dotted path.

    Mirrors `importlib._bootstrap._resolve_name`: for a relative import
    (`node.level >= 1`), `bits = package.rsplit(".", level - 1)` and the
    result is `bits[0]` (+ `.module` if given). `node.level == 0` is a plain
    absolute import, where `node.module` is already the answer.
    """
    if node.level == 0:
        return node.module or ""
    bits = package.rsplit(".", node.level - 1)
    base = bits[0]
    return f"{base}.{node.module}" if node.module else base


def _imported_modules(path: Path) -> set[str]:
    """All modules a file imports, as fully-qualified dotted names.

    Handles four forms that must all resolve to the same name for
    `swil_agent.llm.deepseek_cli`:
      - `import swil_agent.llm.deepseek_cli`
      - `from swil_agent.llm.deepseek_cli import DeepSeekCLIBackend`
      - `from swil_agent.llm import deepseek_cli`             (module + name joined)
      - `from .deepseek_cli import DeepSeekCLIBackend`        (relative, resolved)
      - `from . import deepseek_cli`                          (relative, `module is
        None`, resolved via the anchor package + the imported name joined)
    A naive `{node.module for node in ImportFrom}` misses the last two: the
    plain-relative form resolves to the wrong string (or nothing, since
    `node.module` is `None` for `from . import x`), and the "import a name
    from a package" form never looks at `alias.name` at all.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    package = _own_package(path)
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = _resolve_from_import(node, package)
            if base:
                names.add(base)
            for alias in node.names:
                names.add(f"{base}.{alias.name}" if base else alias.name)
    return names


def test_the_langgraph_guard_can_actually_fail(tmp_path: Path, monkeypatch) -> None:
    """The guard below is only worth having if it can fire. Feed
    `_imported_modules` a module that violates the rule and assert it is
    reported -- this is what makes `test_no_module_outside_graph_imports_langgraph`
    non-vacuous now that `langgraph` is an actual dependency (previously
    nothing could import it even by mistake, so that test always passed
    for the wrong reason).

    A prior architecture guard in this codebase shipped as a substring
    search over source text; a legitimately-written absolute import
    (`from X import Y`) walked straight past it. Pinning this against the
    real `_imported_modules` helper -- the same AST walker the guard test
    below uses -- is what would have caught that class of mistake.

    `_own_package` (called internally by `_imported_modules`) requires its
    argument to sit under `_ROOT`, so a bare `tmp_path` file (elsewhere on
    disk) would raise `ValueError` on `relative_to` before the import-parsing
    logic under test ever runs. `_ROOT` is monkeypatched to `tmp_path` for
    the duration of this test so the only thing that can make it fail is
    `_imported_modules` itself mishandling the absolute `from X import Y`
    form -- not an unrelated path-resolution error.
    """
    monkeypatch.setattr("tests.unit.test_architecture._ROOT", tmp_path)
    offender = tmp_path / "offender.py"
    offender.write_text("from langgraph.graph import StateGraph\n", encoding="utf-8")
    imported = _imported_modules(offender)
    # Mirrors the exact predicate `test_no_module_outside_graph_imports_langgraph`
    # uses below: `_imported_modules` resolves `from langgraph.graph import
    # StateGraph` to fully-qualified names ("langgraph.graph",
    # "langgraph.graph.StateGraph"), never the bare top-level "langgraph" --
    # so the guard, and this sanity check, must split on "." before comparing.
    assert any(m.split(".")[0] == "langgraph" for m in imported), imported


def test_no_module_outside_graph_imports_langgraph() -> None:
    offenders: list[str] = []
    for path in PACKAGE.rglob("*.py"):
        if "graph" in path.relative_to(PACKAGE).parts:
            continue
        if any(m.split(".")[0] == "langgraph" for m in _imported_modules(path)):
            offenders.append(str(path.relative_to(PACKAGE)))
    assert offenders == [], f"langgraph imported outside graph/: {offenders}"


def test_persona_and_llm_do_not_import_api() -> None:
    """Dependency direction: api/ may not be pulled in by the parsing layers."""
    for subpackage in ("persona", "llm"):
        for path in (PACKAGE / subpackage).rglob("*.py"):
            for module in _imported_modules(path):
                assert not module.startswith("swil_agent.api"), f"{path} imports {module}"


def test_analysis_imports_nothing_from_graph_act_or_dream() -> None:
    """Dependency direction, spec §5.2: `graph -> act, dream, analysis ->
    api, llm, persona, embedder -> config, models`.

    `analysis/` sits at the same level as `act/` and `dream/`, so an import
    of any of the three would be the first sideways (or upward) edge in that
    graph. The langgraph half is already covered by
    `test_no_module_outside_graph_imports_langgraph`; this is the rest of the
    rule, and it is what keeps a measurement pass callable from a plain test
    with no graph, no checkpointer and no lease DB.

    The concrete pressure it resists: `dream/round.py` already declares an
    `Embedder` Protocol of exactly the shape `analysis/behavior_snapshot.py`
    needs, and importing it instead of re-declaring one locally is the
    obvious-looking edit. Protocols are structural, so nothing is gained by
    sharing the declaration and a layering rule is lost.
    """
    forbidden = ("swil_agent.graph", "swil_agent.act", "swil_agent.dream")
    offenders: list[str] = []
    for path in (PACKAGE / "analysis").rglob("*.py"):
        for module in _imported_modules(path):
            if module.startswith(forbidden):
                offenders.append(f"{path.relative_to(PACKAGE)} imports {module}")
    assert offenders == [], offenders


def test_the_retired_dream_modules_stay_deleted() -> None:
    """Era 3's dream returns a 最近 list; the drift gate, the aspect
    distiller, the neutral ruler and rule-check went with the full rewrite."""
    for relative in (
        "dream/gate.py",
        "dream/distill.py",
        "dream/drift.py",
        "llm/neutral.py",
        "analysis/rule_check.py",
    ):
        assert not (PACKAGE / relative).exists(), relative


def test_nothing_imports_a_retired_dream_module() -> None:
    retired = (
        "swil_agent.dream.gate",
        "swil_agent.dream.distill",
        "swil_agent.dream.drift",
        "swil_agent.llm.neutral",
        "swil_agent.analysis.rule_check",
    )
    offenders = [
        f"{path.relative_to(PACKAGE)} imports {module}"
        for path in PACKAGE.rglob("*.py")
        for module in _imported_modules(path)
        if module.startswith(retired)
    ]
    assert offenders == [], offenders
