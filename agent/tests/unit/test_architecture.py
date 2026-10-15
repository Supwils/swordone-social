"""Architecture invariants enforced as tests, not conventions."""

import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2] / "swil_agent"
_ROOT = PACKAGE.parent  # directory containing "swil_agent" — the dotted-name anchor


def _own_package(path: Path) -> str:
    """Dotted package that owns `path`, matching Python's own `__package__`.

    For `swil_agent/llm/runner.py` that's `"swil_agent.llm"` — the package
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
    `swil_agent.llm.backends.claude`:
      - `import swil_agent.llm.backends.claude`
      - `from swil_agent.llm.backends.claude import DeepSeekCLIBackend`
      - `from swil_agent.llm.backends import claude`           (module + name joined)
      - `from .claude import DeepSeekCLIBackend`                (relative, resolved)
      - `from . import claude`                                (relative, `module is
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


def _constructs(path: Path, class_name: str) -> bool:
    """True when `path` calls `class_name(...)`, by bare name or attribute."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == class_name:
            return True
        if isinstance(func, ast.Attribute) and func.attr == class_name:
            return True
    return False


# The Persona Bench (`bench/`, spec §8) may construct the DeepSeek backend for
# `ds-flash`. It currently reaches it through `build_backend("deepseek", ...)`,
# which reads the key the same way the roster does; the path stays allowed.
_DEEPSEEK_CONSTRUCTION_ALLOWED = ("llm/backends/__init__.py", "bench/")


def _deepseek_offenders(package: Path) -> list[str]:
    offenders: list[str] = []
    for path in package.rglob("*.py"):
        relative = path.relative_to(package).as_posix()
        if relative.startswith(_DEEPSEEK_CONSTRUCTION_ALLOWED):
            continue
        if _constructs(path, "DeepSeekCLIBackend"):
            offenders.append(relative)
    return offenders


def test_deepseek_backend_is_constructed_only_by_build_backend_and_the_bench() -> None:
    """DeepSeek is reachable only through an explicit `deepseek` selection
    (`build_backend`) or the Persona Bench -- never as a roster default."""
    assert _deepseek_offenders(PACKAGE) == []
    assert _constructs(PACKAGE / "llm" / "backends" / "__init__.py", "DeepSeekCLIBackend")


def test_the_deepseek_guard_can_actually_fail(tmp_path: Path) -> None:
    pkg = tmp_path / "swil_agent"
    (pkg / "act").mkdir(parents=True)
    (pkg / "act" / "bad.py").write_text(
        "from swil_agent.llm.backends.claude import DeepSeekCLIBackend\n"
        "backend = DeepSeekCLIBackend(None, 'k')\n",
        encoding="utf-8",
    )
    (pkg / "bench").mkdir()
    (pkg / "bench" / "ok.py").write_text("b = x.DeepSeekCLIBackend(None, 'k')\n", encoding="utf-8")
    assert _deepseek_offenders(pkg) == ["act/bad.py"]


def test_the_default_backend_kind_stays_claude_cli() -> None:
    from swil_agent.llm.selection import DEFAULT_KIND

    assert DEFAULT_KIND == "claude_cli"


def test_the_lease_module_does_not_import_langgraph() -> None:
    for module in ("lease.py", "file.py", "__init__.py"):
        imported = _imported_modules(PACKAGE / "locks" / module)
        assert not any(m.split(".")[0] == "langgraph" for m in imported), module


def test_the_pre_split_llm_and_lock_modules_stay_deleted() -> None:
    for relative in (
        "llm/base.py",
        "llm/claude_cli.py",
        "llm/codex_cli.py",
        "llm/deepseek_cli.py",
        "locks.py",
        "graph/leases.py",
    ):
        assert not (PACKAGE / relative).exists(), relative


_LOCKS_FILE = "swil_agent.locks.file"


def _locks_file_offenders(package: Path) -> list[str]:
    """Modules outside `locks/` that import `swil_agent.locks.file` in any
    form -- the module itself, or any name from it (`FileLock`, `LockBusy`,
    the path helpers)."""
    offenders: list[str] = []
    for path in package.rglob("*.py"):
        relative = path.relative_to(package).as_posix()
        if relative.startswith("locks/"):
            continue
        if any(
            m == _LOCKS_FILE or m.startswith(f"{_LOCKS_FILE}.") for m in _imported_modules(path)
        ):
            offenders.append(relative)
    return sorted(offenders)


def test_nothing_outside_the_locks_package_imports_the_file_lock_module() -> None:
    """S3 §5 / §12.11: one lock layer. `FileLock` is the file half of a
    `RunLease`, and only `locks/lease.py` reaches for `locks/file.py` --
    `act` and `dream` used to take a `FileLock` of their own beside the
    cycle's leases. Tests may still import it."""
    assert _locks_file_offenders(PACKAGE) == []
    assert _LOCKS_FILE in _imported_modules(PACKAGE / "locks" / "lease.py")


def test_the_file_lock_module_guard_can_actually_fail(tmp_path: Path, monkeypatch) -> None:
    """All three import forms are caught; `locks/` itself and a module that
    only reaches the lease are not. `_ROOT` is pointed at `tmp_path` for the
    same reason `test_the_langgraph_guard_can_actually_fail` gives."""
    monkeypatch.setattr("tests.unit.test_architecture._ROOT", tmp_path)
    pkg = tmp_path / "swil_agent"
    (pkg / "act").mkdir(parents=True)
    (pkg / "act" / "by_name.py").write_text(
        "from swil_agent.locks.file import act_lock_path\n", encoding="utf-8"
    )
    (pkg / "dream").mkdir()
    (pkg / "dream" / "by_module.py").write_text(
        "from swil_agent.locks import file\n", encoding="utf-8"
    )
    (pkg / "graph").mkdir()
    (pkg / "graph" / "plain.py").write_text("import swil_agent.locks.file\n", encoding="utf-8")
    (pkg / "graph" / "lease_only.py").write_text(
        "from swil_agent.locks.lease import RunLease\n", encoding="utf-8"
    )
    (pkg / "locks").mkdir()
    (pkg / "locks" / "lease.py").write_text("from .file import FileLock\n", encoding="utf-8")
    assert _locks_file_offenders(pkg) == ["act/by_name.py", "dream/by_module.py", "graph/plain.py"]


def test_the_run_act_and_run_dream_composers_stay_deleted() -> None:
    """S3 §4: `act` and `dream` run the phase graph; a second hand composer
    is a second implementation of the act path to keep in step."""
    from swil_agent.act import round as act_round
    from swil_agent.dream import round as dream_round

    assert not hasattr(act_round, "run_act")
    assert not hasattr(dream_round, "run_dream")


MAX_MODULE_LINES = 600


def _oversized_modules(package: Path, limit: int = MAX_MODULE_LINES) -> list[str]:
    """`<relative path> (<lines>)` for every module over `limit` physical
    lines, sorted. Physical lines as `wc -l` counts them: docstrings and
    comments included, because they are what a reader has to page through."""
    offenders: list[str] = []
    for path in sorted(package.rglob("*.py")):
        lines = len(path.read_text(encoding="utf-8").splitlines())
        if lines > limit:
            offenders.append(f"{path.relative_to(package).as_posix()} ({lines})")
    return offenders


def test_no_module_exceeds_600_lines() -> None:
    """S3 §9: every `swil_agent/**/*.py` is at most 600 physical lines. A
    module that outgrows it is split along its seams (verbatim moves), not
    squeezed. Tests are exempt (§12.27)."""
    assert _oversized_modules(PACKAGE) == []


def test_the_size_cap_guard_can_actually_fail(tmp_path: Path) -> None:
    (tmp_path / "act").mkdir()
    (tmp_path / "act" / "big.py").write_text("x = 1\n" * 601, encoding="utf-8")
    (tmp_path / "act" / "edge.py").write_text("x = 1\n" * 600, encoding="utf-8")
    assert _oversized_modules(tmp_path) == ["act/big.py (601)"]


def test_the_pre_split_node_module_stays_deleted() -> None:
    """S3 §9 split `graph/nodes.py` by phase. A thin re-export put back in its
    place would let `setattr(nodes, "<step>", spy)` succeed while patching a
    name no node looks up -- the spy stays silent and the test passes
    vacuously (§12.15)."""
    assert not (PACKAGE / "graph" / "nodes.py").exists()


_TESTS = Path(__file__).resolve().parent
# Packages whose module globals the suite patches and S3 §9 split.
_PATCHED_PACKAGES = ("swil_agent.act.", "swil_agent.graph.", "swil_agent.api.")


def _module_aliases(tree: ast.Module) -> dict[str, str]:
    """`alias -> dotted module` for every `import a.b as x` / `from a import b
    [as x]` in a test file (function-local imports included) whose target is
    a `swil_agent` module."""
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname and alias.name.startswith("swil_agent."):
                    aliases[alias.asname] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            for alias in node.names:
                dotted = f"{node.module}.{alias.name}"
                if (_ROOT / Path(*dotted.split("."))).with_suffix(".py").is_file():
                    aliases[alias.asname or alias.name] = dotted
    return aliases


def _literal_patch_sites(tree: ast.Module) -> list[tuple[str, str, int]]:
    """`(alias, name, line)` for every `<x>.setattr(<alias>, "<name>", ...)`."""
    sites: list[tuple[str, str, int]] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "setattr"
            and len(node.args) >= 2
            and isinstance(node.args[0], ast.Name)
            and isinstance(node.args[1], ast.Constant)
            and isinstance(node.args[1].value, str)
        ):
            sites.append((node.args[0].id, node.args[1].value, node.lineno))
    return sites


def _names_loaded_in_functions(path: Path) -> set[str]:
    """Every bare name a module's FUNCTIONS read -- i.e. a global looked up at
    call time, which is what a monkeypatch of that module's attribute
    replaces. An import alone (a re-export) does not count."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    loaded: set[str] = set()
    for func in ast.walk(tree):
        if isinstance(func, ast.FunctionDef | ast.AsyncFunctionDef):
            for node in ast.walk(func):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                    loaded.add(node.id)
    return loaded


def _vacuous_patch_sites(tests: Path) -> tuple[list[str], int]:
    """`(offenders, checked)`: every literal `setattr(<module>, "<name>", ...)`
    in `tests/*.py` on an `act`/`graph`/`api` module whose own functions never
    read `<name>`."""
    offenders: list[str] = []
    checked = 0
    for test_file in sorted(tests.glob("*.py")):
        tree = ast.parse(test_file.read_text(encoding="utf-8"))
        aliases = _module_aliases(tree)
        for alias, name, line in _literal_patch_sites(tree):
            module = aliases.get(alias)
            if module is None or not module.startswith(_PATCHED_PACKAGES):
                continue
            checked += 1
            source = (_ROOT / Path(*module.split("."))).with_suffix(".py")
            if name not in _names_loaded_in_functions(source):
                offenders.append(f"{test_file.name}:{line} patches {module}.{name}")
    return offenders, checked


def test_every_patched_module_global_is_looked_up_by_that_modules_own_code() -> None:
    """S3 §12.15: a patch targets the module whose code calls the name. For
    every literal `setattr(<module>, "<name>", ...)` the suite makes on an
    `act`/`graph`/`api` module, that module's own functions must read
    `<name>` -- otherwise the patch replaces a re-export nobody calls and the
    test is vacuous. Loop-driven patches go through `_node_modules.caller_of`,
    which enforces the same rule at run time."""
    offenders, checked = _vacuous_patch_sites(_TESTS)
    assert offenders == []
    assert checked >= 20, checked  # the scan itself found the known sites


def test_the_patch_target_guard_can_actually_fail(tmp_path: Path, monkeypatch) -> None:
    """A re-export is flagged; a name the module's code calls is not."""
    monkeypatch.setattr("tests.unit.test_architecture._ROOT", tmp_path)
    act = tmp_path / "swil_agent" / "act"
    act.mkdir(parents=True)
    (act / "helper.py").write_text("def step():\n    return 1\n", encoding="utf-8")
    (act / "caller.py").write_text(
        "from swil_agent.act.helper import step\n\n\ndef run():\n    return step()\n",
        encoding="utf-8",
    )
    (act / "reexport.py").write_text("from swil_agent.act.helper import step\n", encoding="utf-8")
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_x.py").write_text(
        "from swil_agent.act import caller, reexport\n\n\n"
        "def test_a(monkeypatch):\n"
        '    monkeypatch.setattr(caller, "step", None)\n'
        '    monkeypatch.setattr(reexport, "step", None)\n',
        encoding="utf-8",
    )
    assert _vacuous_patch_sites(tests) == (["test_x.py:6 patches swil_agent.act.reexport.step"], 2)
