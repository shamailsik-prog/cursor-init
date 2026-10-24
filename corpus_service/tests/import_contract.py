"""Audit F31: the corpus runtime's import-to-dependency contract (standard library only).

Every third-party module the runtime code imports must come from a distribution that
corpus_service/requirements.txt declares. requirements.txt is what the production Dockerfile
installs; requirements-test.txt never counts for runtime code.

Two callers:
- tests/test_f31_import_contract.py, in the normal pytest run (the pinned test environment).
  Modules that environment does not install are resolved through the reviewed ALIASES table.
- tests/e2e/runtime_smoke.py, inside a clean venv built from requirements.txt only, with
  strict=True: there every imported module must be installed and resolve through the real
  package metadata, and every alias must agree with it.

The check fails closed: an import it cannot map, a dynamic import it cannot read, an alias or a
reviewed site that no longer matches the code, or a requirements line it does not understand is
a problem, never a pass. Spec: docs/superpowers/specs/2026-10-18-f31-corpus-runtime-dependencies-design.md (R3).
"""

from __future__ import annotations

import ast
import importlib.metadata
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Set, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# Every Python file the image copies and runs: the application package, the migrations folder and
# the operator's public-harvest entry point (scraper/workers/harvester.py names it).
RUNTIME_ROOTS: Tuple[str, ...] = ("scraper", "migrations", "bootstrap_harvest.py")

# Top-level names that are this service's own code.
FIRST_PARTY = frozenset({"scraper"})

# module -> (distribution, reason). Only where importlib.metadata.packages_distributions() cannot
# map the module in the pinned test environment. Reviewed: keep it small, and give every entry a
# reason. The runtime e2e (strict mode) checks each entry against the real installed metadata.
# Audit F26: PIL (pillow) and pdfplumber left this table when the pinned test set gained the PDF
# parser stack; their installed metadata maps them now.
ALIASES: Dict[str, Tuple[str, str]] = {
    "pytesseract": ("pytesseract", "runtime-only (parsers/pdf_extractor.py); not in the pinned test set"),
    "reportlab": ("reportlab", "runtime-only (parsers/pdf_writer.py); not in the pinned test set"),
}

# Distributions the runtime loads by name rather than by an import statement, by hand. The scan
# below also finds every parser feature and URL driver in the Python code (BY-NAME LOADS); this
# table keeps the ones it cannot see (compose commands, compose URLs) and names the ones it does.
LOADED_BY_NAME: Dict[str, str] = {
    "asyncpg": "SQLAlchemy dialect of every postgresql+asyncpg:// DATABASE_URL (config default, compose)",
    "redis": "kombu transport and Celery result backend for redis:// and rediss:// (tasks/celery_app.py)",
    "uvicorn": "the compose api command: uvicorn scraper.main:app",
    "lxml": "BeautifulSoup parser feature 'lxml' in bootstrap_harvest.py (Harvester.harvest_pakistancode, "
            "harvest_nasirlawsite, harvest_national_assembly); review round, independent re-audit",
}

# -- by-name loads: a string that makes a library import a distribution ---------------------------
# Review round (independent re-audit, MEDIUM): BeautifulSoup(..., "lxml") needs lxml as surely as
# `import lxml` does. The scan maps every such string under RUNTIME_ROOTS to the distribution that
# provides it (a tuple: any one of them satisfies it; () is the standard library). An unknown
# feature or driver, or a computed parser feature, fails closed.
BS4_FEATURES: Dict[str, Tuple[str, ...]] = {
    "html.parser": (), "html": (),          # html.parser is the stdlib builder; "html" alone falls back to it
    "lxml": ("lxml",), "lxml-xml": ("lxml",), "xml": ("lxml",), "fast": ("lxml",),
    "html5lib": ("html5lib",), "html5": ("html5lib",),
}
# SQLAlchemy "<dialect>+<driver>://" URLs: the driver is imported when an engine is built.
URL_DRIVERS: Dict[str, Tuple[str, ...]] = {
    "asyncpg": ("asyncpg",), "psycopg2": ("psycopg2", "psycopg2-binary"), "psycopg": ("psycopg",),
    "pg8000": ("pg8000",), "aiosqlite": ("aiosqlite",), "pysqlite": (), "pymysql": ("pymysql",),
    "aiomysql": ("aiomysql",), "asyncmy": ("asyncmy",), "mysqldb": ("mysqlclient",),
}
_URL_DIALECTS = ("postgresql", "postgres", "mysql", "mariadb", "sqlite", "oracle", "mssql")
_DRIVER_URL_RE = re.compile(r"(?<![A-Za-z0-9+.-])(" + "|".join(_URL_DIALECTS) + r")\+([A-Za-z0-9_]*)://")
# Celery / kombu broker and result-backend URL schemes.
URL_SCHEMES: Dict[str, Tuple[str, ...]] = {"redis": ("redis",), "rediss": ("redis",)}
_SCHEME_URL_RE = re.compile(r"(?<![A-Za-z0-9+.-])(" + "|".join(URL_SCHEMES) + r")://")

# (file, enclosing function, distribution) -> reason: a by-name use that never runs. It holds only
# while nothing in RUNTIME_ROOTS refers to the function by name (attribute, name or string); once
# something does, or once the use is gone, the check fails.
BY_NAME_EXCEPTIONS: Dict[Tuple[str, str, str], str] = {
    ("scraper/config.py", "database_sync_url", "psycopg2"): (
        "Settings.database_sync_url rewrites DATABASE_URL to postgresql+psycopg2:// for a sync client "
        "(Alembic) that nothing wires up: no runtime code reads it, so psycopg2 is never imported"
    ),
}

# file (relative to corpus_service/) -> (number of lines with a dynamic import the check cannot
# resolve, reason). Such a line anywhere else is refused: a loader call with a computed target, a
# loader reference that escapes (into a container, an argument, an attribute), getattr()/globals()
# with a computed name on a loader's module, or exec()/eval().
DYNAMIC_IMPORT_SITES: Dict[str, Tuple[int, str]] = {
    "scraper/tasks/dispatcher.py": (
        1,
        "resolves dispatcher.ROUTES harvester modules; every one is a scraper.tasks.* file scanned here "
        "(tests/test_f31_import_contract.py checks ROUTES)",
    ),
}

_NAME_RE = re.compile(r"^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$")
# What may follow a requirement name (after any extras): nothing, a version clause, an environment
# marker, a direct reference or per-requirement hash options.
_REST_RE = re.compile(r"^(?:$|(?:===|==|!=|~=|<=|>=|<|>)|;|@|--hash[=\s])")


class ContractError(Exception):
    """The contract cannot be evaluated (fail closed): an unreadable manifest or source tree."""


def normalize(name: str) -> str:
    """PEP 503 distribution name normalisation."""
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_requirements(text: str, source: str = "requirements.txt") -> Set[str]:
    """Normalised distribution names a pip requirements file declares.

    Understands names, extras, version clauses, environment markers, direct references,
    backslash continuations, --hash options and comments. Any other option line (-r, -c, -e,
    --index-url, ...) or a line that is not a requirement raises ContractError: an include or an
    editable install would hide what the image really installs from this check.
    """
    logical: List[Tuple[int, str]] = []
    buf, start = "", 0
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip()
        if not buf:
            start = lineno
        if line.endswith("\\"):
            buf += line[:-1] + " "
            continue
        logical.append((start, buf + line))
        buf = ""
    if buf:
        logical.append((start, buf))

    names: Set[str] = set()
    for lineno, line in logical:
        line = re.sub(r"(?:^|\s)#.*$", "", line).strip()
        if not line:
            continue
        if line.startswith("-"):
            raise ContractError(f"{source}:{lineno}: unsupported requirements option (fail closed): {line!r}")
        match = _NAME_RE.match(line)
        if not match or "://" in match.group(1) or not _REST_RE.match(match.group(3).strip()):
            raise ContractError(f"{source}:{lineno}: not a requirement this check understands (fail closed): {line!r}")
        names.add(normalize(match.group(1)))
    return names


@dataclass(frozen=True)
class ImportSite:
    module: str  # top-level module name
    path: str  # relative to the project root
    line: int


@dataclass(frozen=True)
class ByNameUse:
    distributions: Tuple[str, ...]  # any one satisfies the use; () = standard library
    what: str  # e.g. "BeautifulSoup parser feature 'lxml'"
    path: str
    line: int
    function: str  # enclosing function ("" at module or class level)
    problem: str = ""  # set when the string cannot be mapped (fail closed)


@dataclass
class ScanResult:
    imports: List[ImportSite] = field(default_factory=list)
    dynamic: Dict[str, List[int]] = field(default_factory=dict)  # path -> lines of non-literal dynamic imports
    by_name: List[ByNameUse] = field(default_factory=list)
    referenced: Set[str] = field(default_factory=set)  # names read anywhere: attributes, names, strings


def iter_runtime_files(project_root: Path, roots: Sequence[str] = RUNTIME_ROOTS) -> Iterator[Path]:
    for rel in roots:
        path = project_root / rel
        if path.is_file():
            yield path
        elif path.is_dir():
            yield from sorted(p for p in path.rglob("*.py") if "__pycache__" not in p.parts)
        else:
            raise ContractError(f"runtime root {rel!r} does not exist under {project_root} (fail closed)")


# -- dynamic imports, by the loader's identity -----------------------------------------------------
# Review round (Copilot thread 4305672214): a loader is recognised by what it IS, not how it is
# spelled. `from importlib import import_module as load; load("x")` is the same call as
# `importlib.import_module("x")`. The scanner follows, per file and across the scanned first-party
# modules, every name bound to a loader or to a loader's module: import and from-import (with
# `as`), star imports, plain / chained / annotated / tuple / walrus assignment, getattr() and
# globals()/vars()/__dict__ with a literal name, and re-exports between first-party modules
# (from-import, relative import, module objects, dotted chains). Bindings are flow-insensitive: a
# name bound to a loader anywhere in a file is a loader everywhere in it.

# The callables whose first argument (or name=) names a module, by their home module.
LOADERS: Dict[str, frozenset] = {
    "importlib": frozenset({"import_module", "__import__"}),
    "importlib.util": frozenset({"find_spec"}),
    "builtins": frozenset({"__import__"}),
}
# What `from <module> import *` binds to a loader: importlib.__all__ holds import_module and
# __import__; importlib.util has no __all__, so every public name, of which find_spec is the loader.
STAR_LOADERS: Dict[str, frozenset] = {
    "importlib": frozenset({"import_module", "__import__"}),
    "importlib.util": frozenset({"find_spec"}),
}
# Builtins that run arbitrary code, and so arbitrary imports: never resolvable.
CODE_RUNNERS = frozenset({"exec", "eval"})
# After a star import the check cannot enumerate, these names may be loaders: count them as such.
_STAR_UNKNOWN_LOADERS = frozenset({"import_module", "find_spec"})

_LOADER, _RUNNER, _UNRESOLVED = "loader", "runner", "unresolved"
_SYS, _SYS_MODULES = "sys", "sys.modules"  # the sys module; its module table (any module by name)
_MOD, _FP = "mod:", "fp:"  # a loader's home module ("mod:importlib"); a scanned first-party module
_EXT, _FN = "ext:", "fn:"  # a third-party module with a tracked callable; the callable ("fn:bs4.BeautifulSoup")
# Third-party callables whose string arguments name a distribution to load (BS4_FEATURES).
TRACKED_CALLABLES: Dict[str, frozenset] = {"bs4": frozenset({"BeautifulSoup"})}
_BS4 = _FN + "bs4.BeautifulSoup"
# After a star import the check cannot enumerate, these names may be tracked callables.
_STAR_UNKNOWN_TRACKED = {"BeautifulSoup": _BS4}


def _is_ref(kind: Optional[str]) -> bool:
    return kind in (_LOADER, _RUNNER, _SYS, _SYS_MODULES) or (
        kind is not None and kind.startswith((_MOD, _FP, _EXT, _FN)))


def _scope_of(mod: "_Module", node: ast.AST) -> Optional[ast.AST]:
    """The function, lambda, class or module whose namespace a binding at ``node`` lands in."""
    parent = mod.parents.get(id(node))
    while parent is not None and not isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda,
                                                         ast.ClassDef, ast.Module)):
        parent = mod.parents.get(id(parent))
    return parent


class _Module:
    def __init__(self, rel: str, tree: ast.Module):
        self.rel = rel
        self.tree = tree
        parts = list(Path(rel).with_suffix("").parts)
        is_package = parts[-1] == "__init__"
        if is_package:
            parts = parts[:-1]
        self.dotted = ".".join(parts)
        self.package = self.dotted if is_package else self.dotted.rpartition(".")[0]
        # Names that hold a loader, a code runner, a loader's module or a first-party module.
        self.bindings: Dict[str, str] = {"__import__": _LOADER, "__builtins__": _MOD + "builtins",
                                         "exec": _RUNNER, "eval": _RUNNER}
        self.star_unknown = False
        self.consumed: Set[int] = set()  # id() of value nodes bound by an alias statement
        self.parents: Dict[int, ast.AST] = {}
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                self.parents[id(child)] = node

    def lookup(self, name: str) -> Optional[str]:
        kind = self.bindings.get(name)
        if kind is None and self.star_unknown:
            if name in _STAR_UNKNOWN_LOADERS:
                return _LOADER
            if name in _STAR_UNKNOWN_TRACKED:
                return _STAR_UNKNOWN_TRACKED[name]
        return kind


def _alias_pairs(target: ast.expr, value: ast.expr) -> List[Tuple[str, ast.expr]]:
    if isinstance(target, ast.Name):
        return [(target.id, value)]
    if isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (ast.Tuple, ast.List)) \
            and len(target.elts) == len(value.elts):
        return [pair for t, v in zip(target.elts, value.elts) for pair in _alias_pairs(t, v)]
    return []


class _Analyzer:
    """Loader identity across one set of files (the scanned tree)."""

    def __init__(self, sources: Mapping[str, str]):
        # A syntax error propagates: a file the check cannot read is not a pass.
        self.modules = [_Module(rel, ast.parse(text, filename=rel)) for rel, text in sources.items()]
        self.index = {m.dotted: m for m in self.modules}
        self.packages = {".".join(m.dotted.split(".")[:i]) for m in self.modules for i in range(1, m.dotted.count(".") + 1)}
        self.packages |= {m.dotted for m in self.modules if m.dotted == m.package}
        changed = True
        while changed:  # monotone: a binding is only ever added or upgraded to a loader
            changed = any([self._bind(m) for m in self.modules])

    # -- resolution ------------------------------------------------------------------------------
    def _module_kind(self, dotted: Optional[str]) -> Optional[str]:
        if dotted in LOADERS:
            return _MOD + dotted
        if dotted == "sys":
            return _SYS
        if dotted in TRACKED_CALLABLES:
            return _EXT + dotted
        if dotted and (dotted in self.index or dotted in self.packages):
            return _FP + dotted
        return None

    def _member(self, base: Optional[str], attr: str) -> Optional[str]:
        if base is None:
            return None
        if base == _SYS:
            return _SYS_MODULES if attr == "modules" else None
        if base.startswith(_EXT):
            home = base[len(_EXT):]
            return f"{_FN}{home}.{attr}" if attr in TRACKED_CALLABLES.get(home, ()) else None
        if base.startswith(_MOD):
            home = base[len(_MOD):]
            if attr in LOADERS.get(home, ()):
                return _LOADER
            if home == "builtins" and attr in CODE_RUNNERS:
                return _RUNNER
            if home == "importlib" and attr == "util":
                return _MOD + "importlib.util"
            return None
        if base.startswith(_FP):
            dotted = base[len(_FP):]
            sub = f"{dotted}.{attr}"
            if sub in self.index or sub in self.packages:
                return _FP + sub
            source = self.index.get(dotted)
            return source.lookup(attr) if source else None
        return None

    def kind(self, mod: _Module, node: ast.AST) -> Optional[str]:
        if isinstance(node, ast.Name):
            return mod.lookup(node.id)
        if isinstance(node, ast.Attribute):
            return self._member(self.kind(mod, node.value), node.attr)
        if isinstance(node, ast.NamedExpr):
            return self.kind(mod, node.value)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get" \
                and self.kind(mod, node.func.value) == _SYS_MODULES:
            key = node.args[0] if node.args else None
            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                return self._module_kind(key.value)
            return _UNRESOLVED
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "getattr" \
                and len(node.args) >= 2:
            base = self.kind(mod, node.args[0])
            if base is None or not base.startswith((_MOD, _FP, _EXT)):
                return None
            name = node.args[1]
            if isinstance(name, ast.Constant) and isinstance(name.value, str):
                return self._member(base, name.value)
            return _UNRESOLVED
        if isinstance(node, ast.Subscript):
            key = node.slice
            literal = key.value if isinstance(key, ast.Constant) and isinstance(key.value, str) else None
            box = node.value
            if self.kind(mod, box) == _SYS_MODULES:
                return self._module_kind(literal) if literal is not None else _UNRESOLVED
            if isinstance(box, ast.Call) and isinstance(box.func, ast.Name) \
                    and box.func.id in ("globals", "locals", "vars") and not box.args:
                return mod.lookup(literal) if literal is not None else _UNRESOLVED
            base = None
            if isinstance(box, ast.Call) and isinstance(box.func, ast.Name) and box.func.id == "vars" \
                    and len(box.args) == 1:
                base = self.kind(mod, box.args[0])
            elif isinstance(box, ast.Attribute) and box.attr == "__dict__":
                base = self.kind(mod, box.value)
            if base is not None and base.startswith((_MOD, _FP, _EXT)):
                return self._member(base, literal) if literal is not None else _UNRESOLVED
        return None

    def _from_target(self, mod: _Module, node: ast.ImportFrom) -> Optional[str]:
        if node.level == 0:
            return node.module
        base = mod.package.split(".") if mod.package else []
        if node.level > 1:
            base = base[: max(0, len(base) - (node.level - 1))]
        return ".".join(base + ([node.module] if node.module else [])) or None

    # -- binding (one pass; True when anything changed) -----------------------------------------
    def _bind(self, mod: _Module) -> bool:
        changed = False

        def put(name: str, kind: Optional[str]) -> None:
            nonlocal changed
            if not _is_ref(kind):
                return
            old = mod.bindings.get(name)
            if old is None or (kind in (_LOADER, _RUNNER) and old not in (_LOADER, _RUNNER)):
                mod.bindings[name] = kind
                changed = True

        for node in ast.walk(mod.tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    if a.asname:
                        put(a.asname, self._module_kind(a.name))
                    else:
                        top = a.name.split(".")[0]
                        put(top, self._module_kind(top))
            elif isinstance(node, ast.ImportFrom):
                target = self._from_target(mod, node)
                for a in node.names:
                    if a.name != "*":
                        put(a.asname or a.name, self._member(self._module_kind(target), a.name))
                    elif target in STAR_LOADERS:
                        for name in STAR_LOADERS[target]:
                            put(name, _LOADER)
                    elif target in TRACKED_CALLABLES:
                        for name in TRACKED_CALLABLES[target]:
                            put(name, f"{_FN}{target}.{name}")
                    elif target in self.index:
                        source = self.index[target]
                        for name, kind in list(source.bindings.items()):
                            put(name, kind)
                        if source.star_unknown and not mod.star_unknown:
                            mod.star_unknown = changed = True
                    elif target != "builtins" and not mod.star_unknown:  # builtins' star binds no _names
                        mod.star_unknown = changed = True
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr)) and node.value is not None \
                    and not isinstance(_scope_of(mod, node), ast.ClassDef):
                # A class-body alias is reached as an attribute (C.load, self.load), which the
                # check does not follow: it is not consumed here, so it fails closed as an escape.
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    for name, value in _alias_pairs(target, node.value):
                        kind = self.kind(mod, value)
                        if _is_ref(kind):
                            put(name, kind)
                            mod.consumed.add(id(value))
        return changed

    # -- classification ----------------------------------------------------------------------------
    @staticmethod
    def _loader_target(call: ast.Call) -> Optional[ast.expr]:
        if call.args:
            return None if isinstance(call.args[0], ast.Starred) else call.args[0]
        for kw in call.keywords:
            if kw.arg == "name":
                return kw.value
        return None

    def _in_annotation(self, mod: _Module, node: ast.expr) -> bool:
        """True inside a parameter, return or variable annotation (Optional[X], X | None, ...)."""
        child, parent = node, mod.parents.get(id(node))
        while isinstance(parent, (ast.Subscript, ast.Tuple, ast.List, ast.BinOp, ast.Attribute)):
            child, parent = parent, mod.parents.get(id(parent))
        if isinstance(parent, ast.arg):
            return parent.annotation is child
        if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return parent.returns is child
        if isinstance(parent, ast.AnnAssign):
            return parent.annotation is child
        return False

    def _contained(self, mod: _Module, node: ast.expr, kind: str) -> bool:
        """A reference the check has accounted for: called, bound by an alias statement, used in an
        annotation, or (a module) used for an attribute, getattr() or vars(), or (a tracked
        callable such as BeautifulSoup) used for an attribute or as isinstance()'s class."""
        if id(node) in mod.consumed:
            return True
        parent = mod.parents.get(id(node))
        if isinstance(parent, ast.Call) and parent.func is node:
            return True
        if isinstance(parent, ast.NamedExpr) and parent.value is node:
            return True
        if self._in_annotation(mod, node):
            return True
        if kind.startswith(_FN):
            if isinstance(parent, ast.Attribute) and parent.value is node:
                return True
            holder = mod.parents.get(id(parent)) if isinstance(parent, ast.Tuple) else parent
            if isinstance(holder, ast.Call) and isinstance(holder.func, ast.Name) \
                    and holder.func.id in ("isinstance", "issubclass") and len(holder.args) == 2 \
                    and holder.args[1] is (parent if holder is not parent else node):
                return True
        if kind.startswith((_MOD, _EXT)):
            if isinstance(parent, ast.Attribute) and parent.value is node:
                return True
            if isinstance(parent, ast.Call) and isinstance(parent.func, ast.Name) \
                    and parent.func.id in ("getattr", "hasattr", "vars") and parent.args and parent.args[0] is node:
                return True
        if kind == _SYS_MODULES:
            if isinstance(parent, (ast.Attribute, ast.Subscript)) and parent.value is node:
                return True
        return False

    # -- by-name loads ------------------------------------------------------------------------------
    def _function_of(self, mod: _Module, node: ast.AST) -> str:
        parent = mod.parents.get(id(node))
        while parent is not None and not isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
            parent = mod.parents.get(id(parent))
        return parent.name if parent is not None else ""

    @staticmethod
    def _docstrings(tree: ast.Module) -> Set[int]:
        ids = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
                first = node.body[0]
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) \
                        and isinstance(first.value.value, str):
                    ids.add(id(first.value))
        return ids

    def by_name(self, mod: _Module) -> Tuple[List[ByNameUse], Set[str]]:
        """Parser features handed to BeautifulSoup and URL drivers/schemes in string literals, each
        mapped to its distribution; and every name the file reads (for BY_NAME_EXCEPTIONS)."""
        uses: List[ByNameUse] = []
        referenced: Set[str] = set()
        docstrings = self._docstrings(mod.tree)

        def use(dists, what, node, problem=""):
            uses.append(ByNameUse(tuple(dists), what, mod.rel, node.lineno, self._function_of(mod, node), problem))

        for node in ast.walk(mod.tree):
            if isinstance(node, ast.expr) and not isinstance(getattr(node, "ctx", None), (ast.Store, ast.Del)):
                kind = self.kind(mod, node)
                if kind is not None and kind.startswith((_EXT, _FN)) and not self._contained(mod, node, kind):
                    use((), "BeautifulSoup reference", node,
                        f"untracked BeautifulSoup reference at {mod.rel}:{node.lineno}: the bs4 parser callable (or its "
                        f"module) is stored or passed where the check cannot follow it, so the parser feature it is "
                        f"later called with cannot be mapped to a distribution (fail closed)")
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                referenced.add(node.id)
            elif isinstance(node, ast.Attribute):
                referenced.add(node.attr)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
                if node.value.isidentifier():
                    referenced.add(node.value)
                for m in _DRIVER_URL_RE.finditer(node.value):
                    dialect, driver = m.group(1), m.group(2).lower()
                    label = f"database URL driver '{dialect}+{driver}'"
                    if driver in URL_DRIVERS:
                        use(URL_DRIVERS[driver], label, node)
                    else:
                        use((), label, node, f"unknown URL driver '{dialect}+{driver}' at {mod.rel}:{node.lineno}: "
                                             f"no distribution is known for it (fail closed): add it to URL_DRIVERS")
                for m in _SCHEME_URL_RE.finditer(node.value):
                    use(URL_SCHEMES[m.group(1)], f"broker URL scheme '{m.group(1)}://'", node)
            elif isinstance(node, ast.Call) and self.kind(mod, node.func) == _BS4:
                feature = node.args[1] if len(node.args) > 1 else next(
                    (kw.value for kw in node.keywords if kw.arg == "features"), None)
                if feature is None:
                    continue  # no feature: bs4 picks an installed builder, html.parser at worst
                items = feature.elts if isinstance(feature, (ast.List, ast.Tuple)) else [feature]
                if not all(isinstance(i, ast.Constant) and isinstance(i.value, str) for i in items):
                    use((), "BeautifulSoup parser feature", node,
                        f"unresolved parser feature at {mod.rel}:{node.lineno}: a computed BeautifulSoup feature "
                        f"cannot be mapped to a distribution (fail closed)")
                    continue
                for name in [f.strip().lower() for i in items for f in i.value.split(",") if f.strip()]:
                    if name in BS4_FEATURES:
                        use(BS4_FEATURES[name], f"BeautifulSoup parser feature '{name}'", node)
                    else:
                        use((), f"BeautifulSoup parser feature '{name}'", node,
                            f"unknown parser feature '{name}' at {mod.rel}:{node.lineno}: no distribution is known "
                            f"for it (fail closed): add it to BS4_FEATURES")
        return uses, referenced

    def classify(self, mod: _Module) -> Tuple[List[ImportSite], List[int]]:
        imports: List[ImportSite] = []
        dynamic: Set[int] = set()
        for node in ast.walk(mod.tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    imports.append(ImportSite(a.name.split(".")[0], mod.rel, node.lineno))
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module:
                    imports.append(ImportSite(node.module.split(".")[0], mod.rel, node.lineno))
            if not isinstance(node, ast.expr) or isinstance(getattr(node, "ctx", None), (ast.Store, ast.Del)):
                continue
            if isinstance(node, ast.Call):
                callee = self.kind(mod, node.func)
                if callee == _LOADER:
                    target = self._loader_target(node)
                    if isinstance(target, ast.Constant) and isinstance(target.value, str) and target.value \
                            and not target.value.startswith("."):
                        imports.append(ImportSite(target.value.split(".")[0], mod.rel, node.lineno))
                    else:
                        dynamic.add(node.lineno)
                elif callee in (_RUNNER, _UNRESOLVED):
                    dynamic.add(node.lineno)
            kind = self.kind(mod, node)
            if kind == _UNRESOLVED:
                dynamic.add(node.lineno)
            elif kind is not None and kind != _SYS and not kind.startswith((_FP, _EXT, _FN)) \
                    and not self._contained(mod, node, kind):
                dynamic.add(node.lineno)  # a reference that escapes where the check cannot follow it
        return imports, sorted(dynamic)


def scan_source(text: str, rel: str) -> Tuple[List[ImportSite], List[int]]:
    """Absolute imports (top-level names, literal dynamic targets included) and the lines of dynamic
    imports the check cannot resolve, in one file on its own."""
    analyzer = _Analyzer({rel: text})
    return analyzer.classify(analyzer.modules[0])


def scan_tree(project_root: Path, roots: Sequence[str] = RUNTIME_ROOTS) -> ScanResult:
    sources = {}
    for path in iter_runtime_files(project_root, roots):
        sources[path.relative_to(project_root).as_posix()] = path.read_text(encoding="utf-8")
    analyzer = _Analyzer(sources)
    result = ScanResult()
    for mod in analyzer.modules:
        imports, dynamic = analyzer.classify(mod)
        result.imports.extend(imports)
        if dynamic:
            result.dynamic[mod.rel] = dynamic
        uses, referenced = analyzer.by_name(mod)
        result.by_name.extend(uses)
        result.referenced |= referenced
    return result


def third_party_imports(scan: ScanResult, first_party: Iterable[str] = FIRST_PARTY) -> Dict[str, List[ImportSite]]:
    first = set(first_party)
    found: Dict[str, List[ImportSite]] = {}
    for site in scan.imports:
        if site.module in sys.stdlib_module_names or site.module in first:
            continue
        found.setdefault(site.module, []).append(site)
    return found


def check(
    project_root: Path = PROJECT_ROOT,
    *,
    strict: bool = False,
    roots: Sequence[str] = RUNTIME_ROOTS,
    requirements: Optional[str] = None,
    aliases: Mapping[str, Tuple[str, str]] = ALIASES,
    loaded_by_name: Mapping[str, str] = LOADED_BY_NAME,
    dynamic_sites: Mapping[str, Tuple[int, str]] = DYNAMIC_IMPORT_SITES,
    by_name_exceptions: Mapping[Tuple[str, str, str], str] = BY_NAME_EXCEPTIONS,
    distributions: Optional[Mapping[str, Sequence[str]]] = None,
) -> List[str]:
    """Every way the runtime code breaks the contract, as readable lines; empty means it holds.

    strict=True (the runtime venv): every third-party import must be installed here and resolve
    through the real metadata; the alias table is only cross-checked, never trusted.
    """
    problems: List[str] = []
    req_path = project_root / "requirements.txt"
    if requirements is None:
        if not req_path.is_file():
            raise ContractError(f"{req_path} is missing (fail closed)")
        requirements = req_path.read_text(encoding="utf-8")
    declared = parse_requirements(requirements)
    if distributions is None:
        distributions = importlib.metadata.packages_distributions()

    scan = scan_tree(project_root, roots)
    imported = third_party_imports(scan)

    for module in sorted(imported):
        sites = imported[module]
        where = ", ".join(f"{s.path}:{s.line}" for s in sites[:3]) + (f" (+{len(sites) - 3} more)" if len(sites) > 3 else "")
        installed = {normalize(d) for d in (distributions.get(module) or ())}
        alias = aliases.get(module)
        if installed:
            if alias and normalize(alias[0]) not in installed:
                problems.append(
                    f"alias {module} -> {alias[0]} disagrees with the installed metadata ({', '.join(sorted(installed))})"
                )
            if not installed & declared:
                problems.append(
                    f"undeclared: {module} (distribution {', '.join(sorted(installed))}) is imported at {where} "
                    f"but requirements.txt does not declare it"
                )
        elif strict:
            problems.append(
                f"not installed: {module} is imported at {where} but no distribution in this runtime environment "
                f"provides it (requirements.txt does not install it)"
            )
        elif alias:
            if normalize(alias[0]) not in declared:
                problems.append(
                    f"undeclared: {module} (distribution {alias[0]}, via alias) is imported at {where} "
                    f"but requirements.txt does not declare it"
                )
        else:
            problems.append(
                f"unknown import: {module} is imported at {where} and maps to no installed distribution or reviewed "
                f"alias (fail closed): declare its distribution in requirements.txt and, only if this environment "
                f"cannot resolve it, add a reviewed alias"
            )

    for module in sorted(set(aliases) - set(imported)):
        problems.append(f"stale alias: {module} is in the alias table but no runtime code imports it")

    for dist, reason in sorted(loaded_by_name.items()):
        if normalize(dist) not in declared:
            problems.append(f"undeclared: {dist} is loaded by name ({reason}) but requirements.txt does not declare it")

    for path, lines in sorted(scan.dynamic.items()):
        reviewed = dynamic_sites.get(path)
        if reviewed is None:
            problems.append(
                f"unreviewed dynamic import at {path}:{','.join(map(str, lines))}: a non-literal import target cannot be "
                f"checked statically (fail closed)"
            )
        elif reviewed[0] != len(lines):
            problems.append(
                f"dynamic imports at {path} changed: reviewed {reviewed[0]}, found {len(lines)} "
                f"(lines {','.join(map(str, lines))}); review them and update the table"
            )
    for path in sorted(set(dynamic_sites) - set(scan.dynamic)):
        problems.append(f"stale dynamic-import site: {path} is reviewed but has no non-literal dynamic import")

    # By-name loads (review round): a parser feature or URL driver is a dependency like an import.
    installed_dists = {normalize(d) for ds in distributions.values() for d in ds}
    groups: Dict[Tuple[str, ...], List[ByNameUse]] = {}
    matched_exceptions = set()
    for item in scan.by_name:
        if item.problem:
            problems.append(item.problem)
            continue
        if not item.distributions:
            continue  # standard library
        key = next((k for k in by_name_exceptions
                    if (k[0], k[1]) == (item.path, item.function) and k[2] in item.distributions), None)
        if key is not None:
            matched_exceptions.add(key)
            if key[1] in scan.referenced:
                problems.append(
                    f"reviewed by-name exception {key[0]}:{key[1]} ({key[2]}) is reachable: something in the runtime "
                    f"refers to {key[1]!r}, so declare {key[2]} in requirements.txt and drop the exception"
                )
            continue
        groups.setdefault(item.distributions, []).append(item)
    for dists, items in sorted(groups.items()):
        whats = "; ".join(sorted({i.what for i in items}))
        where = ", ".join(f"{i.path}:{i.line}" for i in sorted(items, key=lambda i: (i.path, i.line))[:4]) + (
            f" (+{len(items) - 4} more)" if len(items) > 4 else "")
        anyof = f" (any of: {', '.join(dists)})" if len(dists) > 1 else ""
        if not {normalize(d) for d in dists} & declared:
            problems.append(f"undeclared: {dists[0]} is loaded by name ({whats}) at {where} "
                            f"but requirements.txt does not declare it{anyof}")
        elif strict and not {normalize(d) for d in dists} & installed_dists:
            problems.append(f"not installed: {dists[0]} is loaded by name ({whats}) at {where} but no distribution "
                            f"in this runtime environment provides it{anyof}")
    for key in sorted(set(by_name_exceptions) - matched_exceptions):
        problems.append(f"stale by-name exception: {key[0]}:{key[1]} ({key[2]}) matches no by-name use")

    return problems


def main(argv: Sequence[str]) -> int:
    strict = "--strict" in argv
    problems = check(strict=strict)
    for line in problems:
        print(f"FAIL  {line}")
    if not problems:
        print(f"PASS  import contract holds ({'strict, ' if strict else ''}{PROJECT_ROOT / 'requirements.txt'})")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
