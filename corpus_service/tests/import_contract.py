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
ALIASES: Dict[str, Tuple[str, str]] = {
    "PIL": ("pillow", "module name differs from the distribution; not in the pinned test set"),
    "openai": ("openai", "runtime-only (tasks/embeddings.py); not in the pinned test set"),
    "pdfplumber": ("pdfplumber", "runtime-only (parsers/pdf_extractor.py); not in the pinned test set"),
    "pytesseract": ("pytesseract", "runtime-only (parsers/pdf_extractor.py); not in the pinned test set"),
    "reportlab": ("reportlab", "runtime-only (parsers/pdf_writer.py); not in the pinned test set"),
}

# Distributions the runtime loads by name rather than by an import statement.
LOADED_BY_NAME: Dict[str, str] = {
    "asyncpg": "SQLAlchemy dialect of every postgresql+asyncpg:// DATABASE_URL (config default, compose)",
    "redis": "kombu transport and Celery result backend for redis:// and rediss:// (tasks/celery_app.py)",
    "uvicorn": "the compose api command: uvicorn scraper.main:app",
}

# file (relative to corpus_service/) -> (number of non-literal dynamic imports, reason). A
# non-literal importlib.import_module()/__import__() anywhere else is refused.
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


@dataclass
class ScanResult:
    imports: List[ImportSite] = field(default_factory=list)
    dynamic: Dict[str, List[int]] = field(default_factory=dict)  # path -> lines of non-literal dynamic imports


def iter_runtime_files(project_root: Path, roots: Sequence[str] = RUNTIME_ROOTS) -> Iterator[Path]:
    for rel in roots:
        path = project_root / rel
        if path.is_file():
            yield path
        elif path.is_dir():
            yield from sorted(p for p in path.rglob("*.py") if "__pycache__" not in p.parts)
        else:
            raise ContractError(f"runtime root {rel!r} does not exist under {project_root} (fail closed)")


def _is_dynamic_import(func: ast.expr) -> bool:
    if isinstance(func, ast.Name):
        return func.id in {"__import__", "import_module"}
    if isinstance(func, ast.Attribute):
        return func.attr in {"import_module", "__import__"}
    return False


def scan_source(text: str, rel: str) -> Tuple[List[ImportSite], List[int]]:
    """Absolute imports (top-level names) and the lines of non-literal dynamic imports in one file.
    A syntax error propagates: a file the check cannot read is not a pass."""
    tree = ast.parse(text, filename=rel)
    imports: List[ImportSite] = []
    dynamic: List[int] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(ImportSite(alias.name.split(".")[0], rel, node.lineno))
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                imports.append(ImportSite(node.module.split(".")[0], rel, node.lineno))
        elif isinstance(node, ast.Call) and _is_dynamic_import(node.func):
            target = node.args[0] if node.args else None
            if isinstance(target, ast.Constant) and isinstance(target.value, str) and target.value and not target.value.startswith("."):
                imports.append(ImportSite(target.value.split(".")[0], rel, node.lineno))
            else:
                dynamic.append(node.lineno)
    return imports, dynamic


def scan_tree(project_root: Path, roots: Sequence[str] = RUNTIME_ROOTS) -> ScanResult:
    result = ScanResult()
    for path in iter_runtime_files(project_root, roots):
        rel = path.relative_to(project_root).as_posix()
        imports, dynamic = scan_source(path.read_text(encoding="utf-8"), rel)
        result.imports.extend(imports)
        if dynamic:
            result.dynamic[rel] = dynamic
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
