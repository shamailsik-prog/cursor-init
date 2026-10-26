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
import re
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
    import re

    def _pin(name: str, blob: str) -> str | None:
        for line in blob.splitlines():
            m = re.match(rf"^{name}==([^\s\\]+)", line.strip(), re.I)
            if m:
                return f"{name}=={m.group(1)}"
        return None

    test_pin = _pin("pgvector", test_set)
    runtime_pin = _pin("pgvector", runtime)
    assert test_pin and runtime_pin == test_pin, (runtime_pin, test_pin)


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
    if hasattr(ic, "BY_NAME_EXCEPTIONS"):  # synthetic trees start with no reviewed exception
        kw.setdefault("by_name_exceptions", {})
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


# -- dynamic imports are classified by the loader's identity, not its spelling ---------------------
# Review round (Copilot thread 4305672214): `from importlib import
# import_module as load` then `load("missing_dep")` used to record neither the dependency nor a
# dynamic import. A literal target must be recorded as an import; anything else must count as an
# unreviewed dynamic import; a loader reference the checker cannot follow fails closed the same way.


def _summary(problems):
    """(kind, what, where) per problem: ("import", module, "file:line") or ("dynamic", file, lines)."""
    out = []
    for p in problems:
        m = re.match(r"unknown import: (\S+) is imported at (.+?) and maps to", p)
        if m:
            out.append(("import", m.group(1), m.group(2)))
            continue
        m = re.match(r"unreviewed dynamic import at (\S+?):([\d,]+): ", p)
        if m:
            out.append(("dynamic", m.group(1), m.group(2)))
            continue
        out.append(("other", p, ""))
    return sorted(out)


_LOADER_CASES = {
    "from-import alias, literal": (
        {"scraper/a.py": 'from importlib import import_module as load\nload("missing_dep")\n'},
        [("import", "missing_dep", "scraper/a.py:2")],
    ),
    "from-import alias, computed": (
        {"scraper/a.py": "from importlib import import_module as load\ndef f(name):\n    return load(name)\n"},
        [("dynamic", "scraper/a.py", "3")],
    ),
    "module alias": (
        {"scraper/a.py": 'import importlib as il\nil.import_module("missing_dep")\nil.import_module(name)\n'},
        [("dynamic", "scraper/a.py", "3"), ("import", "missing_dep", "scraper/a.py:2")],
    ),
    "keyword and missing arguments": (
        {"scraper/a.py": 'import importlib\nimportlib.import_module(name="missing_dep")\n'
                         'importlib.import_module(package="scraper", name=other)\nimportlib.import_module()\n'},
        [("dynamic", "scraper/a.py", "3,4"), ("import", "missing_dep", "scraper/a.py:2")],
    ),
    "star import from importlib": (
        {"scraper/a.py": 'from importlib import *\nimport_module("missing_dep")\n__import__(name)\n'},
        [("dynamic", "scraper/a.py", "3"), ("import", "missing_dep", "scraper/a.py:2")],
    ),
    "__import__ through importlib and builtins": (
        {"scraper/a.py": 'import importlib, builtins as b\nimportlib.__import__("missing_dep")\n'
                         'b.__import__("missing_dep2")\nfrom builtins import __import__ as imp\nimp(name)\n'
                         '__builtins__.__import__("missing_dep3")\n'},
        [("dynamic", "scraper/a.py", "5"), ("import", "missing_dep", "scraper/a.py:2"),
         ("import", "missing_dep2", "scraper/a.py:3"), ("import", "missing_dep3", "scraper/a.py:6")],
    ),
    "importlib.util.find_spec forms": (
        {"scraper/a.py": "import importlib.util\nfrom importlib import util as u\nfrom importlib.util import find_spec as fs\n"
                         'importlib.util.find_spec("missing_dep")\nu.find_spec("missing_dep2")\nfs(name)\n'
                         'from importlib.util import *\nfind_spec("missing_dep3")\n'},
        [("dynamic", "scraper/a.py", "6"), ("import", "missing_dep", "scraper/a.py:4"),
         ("import", "missing_dep2", "scraper/a.py:5"), ("import", "missing_dep3", "scraper/a.py:8")],
    ),
    "assignment aliases: plain, chained, annotated, tuple, walrus": (
        {"scraper/a.py": "import importlib\nh = importlib.import_module\nm = importlib\nk = m.import_module\n"
                         'a: object = k\nb, c = h, 1\nh("missing_dep")\na("missing_dep2")\nb(name)\n'
                         '(w := importlib.import_module)("missing_dep3")\nw(name)\n'},
        [("dynamic", "scraper/a.py", "9,11"), ("import", "missing_dep", "scraper/a.py:7"),
         ("import", "missing_dep2", "scraper/a.py:8"), ("import", "missing_dep3", "scraper/a.py:10")],
    ),
    "alias bound after its use": (
        {"scraper/a.py": 'def f():\n    return late("missing_dep")\nlate = __import__\n'},
        [("import", "missing_dep", "scraper/a.py:2")],
    ),
    "getattr and globals()": (
        {"scraper/a.py": 'import importlib\ngetattr(importlib, "import_module")("missing_dep")\n'
                         'globals()["__import__"]("missing_dep2")\ngetattr(importlib, name)\nglobals()[name]("x")\n'
                         'vars(importlib)["import_module"]("missing_dep3")\nimportlib.__dict__[name]\n'},
        [("dynamic", "scraper/a.py", "4,5,7"), ("import", "missing_dep", "scraper/a.py:2"),
         ("import", "missing_dep2", "scraper/a.py:3"), ("import", "missing_dep3", "scraper/a.py:6")],
    ),
    "references that escape fail closed": (
        {"scraper/a.py": "import importlib\nloaders = [importlib.import_module]\n"
                         "found = list(map(importlib.import_module, names))\nregistry = {'mod': importlib}\n"},
        [("dynamic", "scraper/a.py", "2,3,4")],
    ),
    "exec and eval": (
        {"scraper/a.py": "exec(source)\neval(\"__import__('missing_dep')\")\n"},
        [("dynamic", "scraper/a.py", "1,2")],
    ),
    "re-exported across first-party modules": (
        {"scraper/util.py": "from importlib import import_module as load\nimport importlib as lib\n",
         "scraper/a.py": "from scraper.util import load\nfrom .util import lib\nfrom scraper import util\n"
                         "import scraper.util as u2\nimport scraper.util\n"
                         'load("missing_dep")\nlib.import_module("missing_dep2")\nutil.load("missing_dep3")\n'
                         'u2.load(name)\nscraper.util.lib.import_module("missing_dep4")\n'},
        [("dynamic", "scraper/a.py", "9"), ("import", "missing_dep", "scraper/a.py:6"),
         ("import", "missing_dep2", "scraper/a.py:7"), ("import", "missing_dep3", "scraper/a.py:8"),
         ("import", "missing_dep4", "scraper/a.py:10")],
    ),
    "star import from a first-party module": (
        {"scraper/util.py": "from importlib import import_module as load\n",
         "scraper/a.py": 'from scraper.util import *\nload("missing_dep")\n'},
        [("import", "missing_dep", "scraper/a.py:2")],
    ),
    "star import from a module the checker cannot enumerate": (
        {"scraper/a.py": 'from os.path import *\nimport_module("missing_dep")\nfind_spec(name)\n'},
        [("dynamic", "scraper/a.py", "3"), ("import", "missing_dep", "scraper/a.py:2")],
    ),
    "an alias in a class body is reached as an attribute: fails closed": (
        {"scraper/a.py": 'import importlib\nclass C:\n    load = importlib.import_module\nC.load("missing_dep")\n'},
        [("dynamic", "scraper/a.py", "3")],
    ),
    "sys.modules": (
        {"scraper/a.py": 'import sys\nsys.modules["importlib"].import_module("missing_dep")\n'
                         "sys.modules[name].import_module(x)\n"},
        [("dynamic", "scraper/a.py", "3"), ("import", "missing_dep", "scraper/a.py:2")],
    ),
    "no false positives": (
        {"scraper/a.py": "import importlib\nimport re\nimportlib.reload(re)\nre.compile('x')\n"
                         "getattr(settings, 'X')\ndef load(name):\n    return name\nload('not_an_import')\n"
                         "import_module = 3\nimportlib.invalidate_caches()\nhasattr(importlib, 'import_module')\n"
                         "sys.modules.get('x')\n"},
        [],
    ),
}


@pytest.mark.parametrize("case", sorted(_LOADER_CASES))
def test_dynamic_imports_are_classified_by_loader_identity(tmp_path, case):
    files, expected = _LOADER_CASES[case]
    root = _tree(tmp_path, files, "fastapi\n")
    assert _summary(_check(root)) == sorted(expected)


# -- distributions loaded by a string: parser features and URL drivers -----------------------------
# Review round (independent re-audit, MEDIUM): bootstrap_harvest.py calls BeautifulSoup(..., "lxml")
# four times. With lxml removed from requirements.txt the contract (plain and strict) and the
# clean-runtime smoke all passed, while Harvester.harvest_pakistancode() raised
# bs4.exceptions.FeatureNotFound. A parser feature or a URL driver is a dependency like an import.


def _by_name_problems(tmp_path, files, requirements, **kw):
    root = _tree(tmp_path, files, requirements)
    return _check(root, **kw)


def test_lxml_is_loaded_by_name_in_bootstrap_harvest_and_must_be_declared():
    scan = ic.scan_tree(PROJECT_ROOT)
    lxml = [u for u in scan.by_name if "lxml" in u.distributions]
    assert lxml and {u.path for u in lxml} == {"bootstrap_harvest.py"}, lxml
    assert all(u.what == "BeautifulSoup parser feature 'lxml'" for u in lxml), lxml
    assert "lxml" in ic.LOADED_BY_NAME and "bootstrap_harvest.py" in ic.LOADED_BY_NAME["lxml"]
    # The re-audit's demonstration as a test: the real tree with lxml dropped from the manifest.
    runtime = (PROJECT_ROOT / "requirements.txt").read_text(encoding="utf-8")
    without = "\n".join(line for line in runtime.splitlines() if line.strip() != "lxml") + "\n"
    assert without != runtime
    problems = ic.check(PROJECT_ROOT, requirements=without)
    assert any(p.startswith("undeclared: lxml is loaded by name") and "bootstrap_harvest.py:" in p for p in problems), problems


def test_real_tree_url_drivers_are_declared_or_reviewed():
    scan = ic.scan_tree(PROJECT_ROOT)
    found = {(u.path, d) for u in scan.by_name for d in u.distributions}
    assert ("scraper/config.py", "asyncpg") in found and ("scraper/config.py", "redis") in found, found
    psycopg2 = [u for u in scan.by_name if "psycopg2" in u.distributions]
    assert psycopg2 and all((u.path, u.function) == ("scraper/config.py", "database_sync_url") for u in psycopg2), psycopg2
    assert ("scraper/config.py", "database_sync_url", "psycopg2") in ic.BY_NAME_EXCEPTIONS


@pytest.mark.parametrize("call, dist", [
    ('from bs4 import BeautifulSoup\nBeautifulSoup(x, "lxml")\n', "lxml"),
    ('from bs4 import BeautifulSoup as BS\nBS(x, features="lxml-xml")\n', "lxml"),
    ('import bs4\nbs4.BeautifulSoup(x, "xml")\n', "lxml"),
    ('import bs4 as b\nsoup = b.BeautifulSoup\nsoup(x, ["fast", "html"])\n', "lxml"),
    ('from bs4 import BeautifulSoup\nBeautifulSoup(x, "html5lib")\n', "html5lib"),
    ('from bs4 import BeautifulSoup\nBeautifulSoup(x, "lxml, html")\n', "lxml"),
])
def test_bs4_parser_features_map_to_their_distribution(tmp_path, call, dist):
    files = {"scraper/a.py": call}
    problems = _by_name_problems(tmp_path, files, "beautifulsoup4\n")
    assert len(problems) == 1 and problems[0].startswith(f"undeclared: {dist} is loaded by name"), problems
    assert "scraper/a.py:" in problems[0]
    assert _by_name_problems(tmp_path, files, f"beautifulsoup4\n{dist}\n") == []


@pytest.mark.parametrize("call", [
    'BeautifulSoup(x, "html.parser")', "BeautifulSoup(x)", 'BeautifulSoup(x, features="html")',
])
def test_stdlib_parser_features_need_nothing(tmp_path, call):
    assert _by_name_problems(tmp_path, {"scraper/a.py": f"from bs4 import BeautifulSoup\n{call}\n"}, "beautifulsoup4\n") == []


@pytest.mark.parametrize("call, start", [
    ('BeautifulSoup(x, "bogus-parser")', "unknown parser feature 'bogus-parser'"),
    ("BeautifulSoup(x, parser_name)", "unresolved parser feature"),
    ("BeautifulSoup(x, features=pick())", "unresolved parser feature"),
])
def test_unknown_or_computed_parser_features_fail_closed(tmp_path, call, start):
    problems = _by_name_problems(tmp_path, {"scraper/a.py": f"from bs4 import BeautifulSoup\n{call}\n"}, "beautifulsoup4\nlxml\n")
    assert len(problems) == 1 and problems[0].startswith(start) and "scraper/a.py:2" in problems[0], problems


# Review round (Cursor Bugbot thread 4305754112, on 882c6df): references to the BeautifulSoup
# callable (or the bs4 module) that the check cannot follow used to be exempt, so a later
# BeautifulSoup(..., "lxml") through them never required lxml. They now fail closed, naming the
# line, like the loader path; a star import from bs4 is followed.
@pytest.mark.parametrize("source, line", [
    ('from bs4 import BeautifulSoup\nclass Parsers:\n    soup = BeautifulSoup\nParsers.soup(x, "lxml")\n', 3),
    ('from bs4 import BeautifulSoup\nPARSERS = [BeautifulSoup]\nPARSERS[0](x, "lxml")\n', 2),
    ('from bs4 import BeautifulSoup\nPARSERS = {"soup": BeautifulSoup}\nPARSERS["soup"](x, "lxml")\n', 2),
    ('from bs4 import BeautifulSoup\nmake = functools.partial(BeautifulSoup, features="lxml")\n', 2),
    ('import bs4\nmods = [bs4]\nmods[0].BeautifulSoup(x, "lxml")\n', 2),
])
def test_untracked_beautifulsoup_references_fail_closed(tmp_path, source, line):
    problems = _by_name_problems(tmp_path, {"scraper/a.py": source}, "beautifulsoup4\nlxml\n")
    assert len(problems) == 1 and problems[0].startswith(f"untracked BeautifulSoup reference at scraper/a.py:{line}"), problems


def test_star_import_from_bs4_is_followed(tmp_path):
    files = {"scraper/a.py": 'from bs4 import *\nBeautifulSoup(x, "lxml")\n'}
    problems = _by_name_problems(tmp_path, files, "beautifulsoup4\n")
    assert len(problems) == 1 and problems[0].startswith("undeclared: lxml is loaded by name"), problems
    assert "scraper/a.py:2" in problems[0]
    assert _by_name_problems(tmp_path, files, "beautifulsoup4\nlxml\n") == []


def test_beautifulsoup_after_a_star_import_the_check_cannot_enumerate_is_scanned(tmp_path):
    files = {"scraper/a.py": 'from os.path import *\nBeautifulSoup(x, "lxml")\n'}
    problems = _by_name_problems(tmp_path, files, "beautifulsoup4\n")
    assert len(problems) == 1 and problems[0].startswith("undeclared: lxml is loaded by name"), problems


@pytest.mark.parametrize("source", [
    'from bs4 import BeautifulSoup\nBeautifulSoup(x, "lxml")\n',
    'from bs4 import BeautifulSoup\ndef parse(html: str) -> BeautifulSoup:\n'
    '    soup: BeautifulSoup = BeautifulSoup(html, "lxml")\n    return soup\n',
    'from bs4 import BeautifulSoup\nimport bs4\nisinstance(x, (BeautifulSoup, str))\nbs4.BeautifulSoup.__name__\n',
    'import bs4\nbs4.BeautifulSoup(x, "lxml")\nb = bs4\nb.BeautifulSoup(y, "lxml")\nS = bs4.BeautifulSoup\nS(z, "lxml")\n',
])
def test_followed_beautifulsoup_uses_pass(tmp_path, source):
    assert _by_name_problems(tmp_path, {"scraper/a.py": source}, "beautifulsoup4\nlxml\n") == []


@pytest.mark.parametrize("literal, dist", [
    ("postgresql+asyncpg://u@h/db", "asyncpg"),
    ("mysql+pymysql://u@h/db", "pymysql"),
    ("postgresql+psycopg2://u@h/db", "psycopg2"),
    ("rediss://u@h:6379/0", "redis"),
    ("redis://h:6379/0", "redis"),
])
def test_url_drivers_and_broker_schemes_map_to_their_distribution(tmp_path, literal, dist):
    files = {"scraper/a.py": f'URL = "{literal}"\n'}
    problems = _by_name_problems(tmp_path, files, "fastapi\n")
    assert len(problems) == 1 and problems[0].startswith(f"undeclared: {dist} is loaded by name"), problems
    assert _by_name_problems(tmp_path, files, f"fastapi\n{dist}\n") == []


def test_unknown_url_driver_fails_closed_and_docstrings_are_not_loads(tmp_path):
    files = {"scraper/a.py": '"""Example: postgresql+psycopg2://u@h/db"""\nURL = f"postgresql+nosuchdriver://{host}/db"\n'}
    problems = _by_name_problems(tmp_path, files, "fastapi\n")
    assert len(problems) == 1 and problems[0].startswith("unknown URL driver 'postgresql+nosuchdriver'"), problems
    assert "scraper/a.py:2" in problems[0]


def test_by_name_exceptions_hold_only_while_unreachable(tmp_path):
    exc = {("scraper/a.py", "sync_url", "psycopg2"): "no caller"}
    helper = 'class S:\n    @property\n    def sync_url(self):\n        return "postgresql+psycopg2://u@h/db"\n'
    assert _by_name_problems(tmp_path, {"scraper/a.py": helper}, "fastapi\n", by_name_exceptions=exc) == []
    reached = {"scraper/a.py": helper, "scraper/b.py": "from scraper.a import S\nS().sync_url\n"}
    problems = _by_name_problems(tmp_path, reached, "fastapi\n", by_name_exceptions=exc)
    assert len(problems) == 1 and problems[0].startswith("reviewed by-name exception scraper/a.py:sync_url (psycopg2) is reachable"), problems
    stale = _by_name_problems(tmp_path, {"scraper/a.py": "x = 1\n", "scraper/b.py": "y = 2\n"}, "fastapi\n", by_name_exceptions=exc)
    assert stale == ["stale by-name exception: scraper/a.py:sync_url (psycopg2) matches no by-name use"], stale


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
