"""Audit F31: every third-party module the corpus runtime imports is declared in requirements.txt.

requirements.txt is what corpus_service/Dockerfile installs; requirements-test.txt (this suite's
environment) never counts for runtime code. On main this fails: scraper/models.py imports
pgvector, which only requirements-test.txt declares, and anyio, certifi, httpcore and pydantic
are imported directly but present only as other packages' dependencies.

The end-to-end proof is tests/e2e/runtime_smoke.sh (a clean venv from requirements.txt only,
then the compose entry points against real PostgreSQL); this file is the static half that runs
in every pytest run. Spec: docs/superpowers/specs/2026-10-18-f31-corpus-runtime-dependencies-design.md.
"""

from __future__ import annotations

import importlib.metadata
import textwrap
from pathlib import Path

import pytest

import import_contract as ic

PROJECT_ROOT = Path(__file__).resolve().parents[1]


# -- the contract on the real tree ----------------------------------------------------------------


def test_every_runtime_import_is_declared_in_requirements_txt():
    problems = ic.check(PROJECT_ROOT)
    assert problems == [], "corpus runtime import contract broken:\n" + "\n".join(problems)


def test_models_import_pgvector_and_requirements_txt_declares_it():
    """The finding's exact pair: scraper/models.py imports pgvector.sqlalchemy, so the runtime
    manifest (not only the test manifest) must declare pgvector, at the version the tests run."""
    sites = ic.third_party_imports(ic.scan_tree(PROJECT_ROOT)).get("pgvector", [])
    assert any(s.path == "scraper/models.py" for s in sites), sites
    runtime = (PROJECT_ROOT / "requirements.txt").read_text(encoding="utf-8")
    test_set = (PROJECT_ROOT / "requirements-test.txt").read_text(encoding="utf-8")
    assert "pgvector" in ic.parse_requirements(runtime)
    pin = [line.strip() for line in test_set.splitlines() if line.strip().startswith("pgvector")]
    assert pin and pin[0] in [line.strip() for line in runtime.splitlines()], (pin, "requirements.txt must pin the tested pgvector")


def test_dispatcher_dynamic_import_targets_are_scanned_first_party_modules():
    """The one reviewed non-literal import: dispatcher.ROUTES. Every target must be a scraper.*
    module whose file the contract scans, so its own imports are checked."""
    from scraper.tasks import dispatcher

    assert dispatcher.ROUTES
    scanned = {p.relative_to(PROJECT_ROOT).as_posix() for p in ic.iter_runtime_files(PROJECT_ROOT)}
    for source, route in dispatcher.ROUTES.items():
        module = route[0]
        assert module.split(".")[0] in ic.FIRST_PARTY, (source, module)
        assert module.replace(".", "/") + ".py" in scanned, (source, module)


def test_every_alias_is_still_needed_and_matches_installed_metadata():
    """An alias exists only where this environment cannot map the module; once the module is
    installed here its metadata must agree (strict mode in the runtime e2e checks all of them)."""
    distributions = importlib.metadata.packages_distributions()
    imported = ic.third_party_imports(ic.scan_tree(PROJECT_ROOT))
    for module, (dist, reason) in ic.ALIASES.items():
        assert reason.strip(), module
        assert module in imported, f"stale alias {module}"
        installed = {ic.normalize(d) for d in distributions.get(module) or ()}
        if installed:
            assert ic.normalize(dist) in installed, (module, dist, installed)


# -- the checker fails closed (synthetic trees) -----------------------------------------------------


def _tree(tmp_path: Path, files: dict, requirements: str) -> Path:
    for rel, body in files.items():
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(body), encoding="utf-8")
    (tmp_path / "requirements.txt").write_text(textwrap.dedent(requirements), encoding="utf-8")
    return tmp_path


def _check(root: Path, **kw):
    kw.setdefault("roots", ("scraper",))
    kw.setdefault("aliases", {})
    kw.setdefault("loaded_by_name", {})
    kw.setdefault("dynamic_sites", {})
    kw.setdefault("distributions", {"pgvector": ["pgvector"], "bs4": ["beautifulsoup4"], "PIL": ["Pillow"]})
    return ic.check(root, **kw)


def test_an_import_only_the_test_manifest_declares_is_refused(tmp_path):
    root = _tree(tmp_path, {"scraper/models.py": "from pgvector.sqlalchemy import Vector\n"}, "fastapi\n")
    (root / "requirements-test.txt").write_text("pgvector==0.5.0\n", encoding="utf-8")
    problems = _check(root)
    assert len(problems) == 1 and problems[0].startswith("undeclared: pgvector"), problems
    assert "scraper/models.py:1" in problems[0]


def test_an_unknown_module_fails_closed(tmp_path):
    root = _tree(tmp_path, {"scraper/a.py": "def f():\n    import f31_not_a_real_module\n"}, "fastapi\n")
    problems = _check(root)
    assert len(problems) == 1 and problems[0].startswith("unknown import: f31_not_a_real_module"), problems


def test_imports_anywhere_in_a_file_count(tmp_path):
    body = """
        try:
            import bs4
        except ImportError:
            bs4 = None
        def later():
            from PIL import Image
        import importlib
        x = importlib.import_module("pgvector.sqlalchemy")
        """
    root = _tree(tmp_path, {"scraper/a.py": body}, "fastapi\n")
    problems = _check(root)
    assert {p.split(" ")[1] for p in problems} == {"bs4", "PIL", "pgvector"}, problems
    root = _tree(tmp_path, {"scraper/a.py": body}, "beautifulsoup4\npillow\npgvector==0.5.0\n")
    assert _check(root) == []


def test_stdlib_relative_and_first_party_imports_are_not_dependencies(tmp_path):
    body = "from __future__ import annotations\nimport json, os.path\nfrom . import b\nfrom scraper.b import c\n"
    root = _tree(tmp_path, {"scraper/a.py": body, "scraper/b.py": "c = 1\n"}, "fastapi\n")
    assert _check(root) == []


def test_alias_resolves_only_a_declared_distribution_and_must_match_metadata(tmp_path):
    root = _tree(tmp_path, {"scraper/a.py": "import openai\n"}, "fastapi\n")
    alias = {"openai": ("openai", "runtime-only")}
    assert _check(root, aliases=alias)[0].startswith("undeclared: openai")
    root = _tree(tmp_path, {"scraper/a.py": "import openai\n"}, "openai\n")
    assert _check(root, aliases=alias) == []
    # strict (the runtime venv): an alias is never enough, the module must be installed.
    assert _check(root, aliases=alias, strict=True)[0].startswith("not installed: openai")
    # an alias that contradicts installed metadata is refused.
    root = _tree(tmp_path, {"scraper/a.py": "import PIL\n"}, "pillow\n")
    assert _check(root, aliases={"PIL": ("pil-fork", "wrong")})[0].startswith("alias PIL -> pil-fork disagrees")


def test_stale_alias_fails(tmp_path):
    root = _tree(tmp_path, {"scraper/a.py": "import json\n"}, "fastapi\n")
    assert _check(root, aliases={"openai": ("openai", "x")}) == [
        "stale alias: openai is in the alias table but no runtime code imports it"
    ]


def test_non_literal_dynamic_import_must_be_reviewed(tmp_path):
    body = "import importlib\ndef load(name):\n    return importlib.import_module(name)\n"
    root = _tree(tmp_path, {"scraper/tasks/d.py": body}, "fastapi\n")
    problems = _check(root)
    assert len(problems) == 1 and problems[0].startswith("unreviewed dynamic import at scraper/tasks/d.py:3"), problems
    assert _check(root, dynamic_sites={"scraper/tasks/d.py": (1, "reviewed")}) == []
    assert _check(root, dynamic_sites={"scraper/tasks/d.py": (2, "reviewed")})[0].startswith("dynamic imports at")
    root = _tree(tmp_path, {"scraper/tasks/d.py": "x = 1\n"}, "fastapi\n")
    assert _check(root, dynamic_sites={"scraper/tasks/d.py": (1, "reviewed")})[0].startswith("stale dynamic-import site")


def test_loaded_by_name_distributions_must_be_declared(tmp_path):
    root = _tree(tmp_path, {"scraper/a.py": "x = 1\n"}, "fastapi\nuvicorn[standard]\n")
    problems = _check(root, loaded_by_name={"asyncpg": "dialect", "uvicorn": "api command"})
    assert problems == ["undeclared: asyncpg is loaded by name (dialect) but requirements.txt does not declare it"]


def test_missing_root_and_unreadable_source_fail_closed(tmp_path):
    root = _tree(tmp_path, {"scraper/a.py": "x = 1\n"}, "fastapi\n")
    with pytest.raises(ic.ContractError):
        _check(root, roots=("scraper", "migrations"))
    root = _tree(tmp_path, {"scraper/a.py": "def broken(:\n"}, "fastapi\n")
    with pytest.raises(SyntaxError):
        _check(root)


# -- requirements parsing ------------------------------------------------------------------------


def test_parse_requirements_reads_names_extras_pins_markers_hashes_and_comments():
    text = """
        # comment
        uvicorn[standard]
        sqlalchemy[asyncio]
        httpx==0.28.1  # trailing comment
        Python_Dateutil>=2.9 ; python_version >= "3.8"
        pgvector==0.5.0 \\
            --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000
        pydantic-settings
        my.pkg @ https://example.invalid/my_pkg-1.0-py3-none-any.whl
        """
    assert ic.parse_requirements(textwrap.dedent(text)) == {
        "uvicorn", "sqlalchemy", "httpx", "python-dateutil", "pgvector", "pydantic-settings", "my-pkg",
    }


@pytest.mark.parametrize(
    "line",
    ["-r requirements-test.txt", "-e .", "--index-url https://example.invalid/simple",
     "https://example.invalid/pkg.whl", "git+https://example.invalid/pkg.git", "pkg is great"],
)
def test_parse_requirements_refuses_what_it_cannot_vouch_for(line):
    with pytest.raises(ic.ContractError):
        ic.parse_requirements("fastapi\n" + line + "\n")


def test_the_real_manifests_parse():
    for name in ("requirements.txt", "requirements-test.txt"):
        assert ic.parse_requirements((PROJECT_ROOT / name).read_text(encoding="utf-8"), name)
