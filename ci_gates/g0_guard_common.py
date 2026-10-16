#!/usr/bin/env python3
"""Shared tree walk, file classification, import/manifest parsing and allowlist handling for the
G-0 scraper and provider guards (FA-CI-001).

Skip rules (re-audit 2026-10-16, defect 1): generated trees (node_modules, .git, .next) are
skipped wherever they appear. The gate scripts (ci_gates/), the root test suite (tests/, which
holds the sanctioned @playwright/test e2e specs), displaced slice files (_superseded/) and the
eve runtime cache (.eve/, gitignored as /.eve/) are skipped only at the repository root. A
directory with one of those names anywhere else, such as app/ci_gates/ or lib/_superseded/, is
scanned like any other.
"""
from __future__ import annotations

import ast
import json
import os
import pathlib
import re
import warnings
from dataclasses import dataclass

try:  # Python 3.11+; CI runs 3.12.
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - fail closed below
    tomllib = None  # type: ignore[assignment]

JS_SUFFIXES = frozenset({".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"})
PY_SUFFIXES = frozenset({".py"})
SOURCE_SUFFIXES = JS_SUFFIXES | PY_SUFFIXES
SHELL_SUFFIXES = frozenset({".sh", ".bash", ".zsh", ".ksh"})

# Skipped at any depth.
ANY_DEPTH_SKIP_DIRS = frozenset({"node_modules", ".git", ".next"})
# Skipped only as a top-level directory of the repository.
ROOT_ONLY_SKIP_DIRS = frozenset({"ci_gates", "tests", "_superseded", ".eve"})
# Root Playwright config for the e2e suite (root devDependency @playwright/test).
ROOT_SKIP_FILES = frozenset({"playwright.config.ts", "playwright.config.mts", "playwright.config.cts"})

ALLOWLIST_PATH = pathlib.Path(__file__).with_name("g0_guard_allowlist.json")

DOCKERFILE_NAME_RE = re.compile(
    r"^(?:(?:docker|container)file(?:[.-][\w.-]+)?|[\w.-]+\.(?:docker|container)file)$",
    re.I,
)
# requirements.txt, requirements-test.txt, requirements_dev.in, dev-requirements.txt, ...
REQUIREMENTS_NAME_RE = re.compile(
    r"^(?:[\w.-]+[-_.])?requirements(?:[-_.][\w.-]+)?\.(?:txt|in)$",
    re.I,
)
SHEBANG_SHELL_RE = re.compile(r"^#![^\n]*?\b(?:ba|z|k|da)?sh\b")


@dataclass(frozen=True)
class GuardFinding:
    rel: str
    symbol: str
    message: str

    @property
    def allow_key(self) -> str:
        return f"{self.rel}:{self.symbol}"


def rel_posix(p: pathlib.Path) -> str:
    return str(p).replace("\\", "/")


# --- tree walk ------------------------------------------------------------------------------


def is_skipped_path(p: pathlib.Path) -> bool:
    """True when a repository-relative path is outside the guards' scan."""
    parts = p.parts
    if not parts:
        return True
    if any(part in ANY_DEPTH_SKIP_DIRS for part in parts):
        return True
    if len(parts) > 1 and parts[0] in ROOT_ONLY_SKIP_DIRS:
        return True
    if len(parts) == 1 and parts[0] in ROOT_SKIP_FILES:
        return True
    return False


def iter_scan_files(root: pathlib.Path = pathlib.Path(".")):
    """Yield every regular file under root as a root-relative path, pruning skipped trees.

    Symlinked directories are not descended into (as with Path.rglob before 3.13).
    """
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = pathlib.Path(dirpath).relative_to(root)
        at_root = not rel_dir.parts
        dirnames[:] = sorted(
            d
            for d in dirnames
            if d not in ANY_DEPTH_SKIP_DIRS and not (at_root and d in ROOT_ONLY_SKIP_DIRS)
        )
        for name in sorted(filenames):
            rel = rel_dir / name
            if is_skipped_path(rel) or not (root / rel).is_file():
                continue
            yield rel


def read_text(p: pathlib.Path) -> str | None:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None


def _is_shell_script(p: pathlib.Path) -> bool:
    if p.suffix.lower() in SHELL_SUFFIXES:
        return True
    if p.suffix:
        return False
    try:
        with p.open("rb") as fh:
            head = fh.read(256).decode("utf-8", errors="ignore")
    except OSError:
        return False
    return bool(SHEBANG_SHELL_RE.match(head))


def file_kind(p: pathlib.Path) -> str | None:
    """Classify a scanned file: package_json, requirements, pyproject, pipfile, dockerfile,
    js, py, shell, or None (not inspected)."""
    name = p.name
    suffix = p.suffix.lower()
    if name == "package.json":
        return "package_json"
    if REQUIREMENTS_NAME_RE.match(name) or (
        p.parent.name.lower() == "requirements" and suffix in {".txt", ".in"}
    ):
        return "requirements"
    if name == "pyproject.toml":
        return "pyproject"
    if name == "Pipfile":
        return "pipfile"
    if DOCKERFILE_NAME_RE.match(name):
        return "dockerfile"
    if suffix in JS_SUFFIXES:
        return "js"
    if suffix in PY_SUFFIXES:
        return "py"
    if _is_shell_script(p):
        return "shell"
    return None


# --- source imports -------------------------------------------------------------------------

# The module specifier in every import position: `from "x"` (import/export ... from, across
# lines), `import "x"`, `import("x")` (optionally with /* comments */), `require("x")` and
# `require.resolve("x")`, with ', " or ` quotes.
_JS_SPECIFIER_RE = re.compile(
    r"""
    (?:\bfrom|\bimport)\s*(?:\(\s*(?:/\*.*?\*/\s*)*)?(?P<q1>["'`])(?P<s1>[^"'`\r\n]+)(?P=q1)
    |
    \brequire(?:\.resolve)?\s*\(\s*(?:/\*.*?\*/\s*)*(?P<q2>["'`])(?P<s2>[^"'`\r\n]+)(?P=q2)
    """,
    re.VERBOSE | re.DOTALL,
)


def js_package_root(spec: str) -> str | None:
    """npm package a module specifier resolves to (lower case), or None for relative, absolute,
    URL and node: specifiers. `openai/client` -> openai; `@anthropic-ai/sdk/x` -> @anthropic-ai/sdk;
    `npm:openai@4` -> openai."""
    s = spec.strip()
    if s.startswith("npm:"):
        s = s[len("npm:"):]
    if not s or s.startswith((".", "/")) or ":" in s:
        return None
    parts = s.split("/")
    if s.startswith("@"):
        if len(parts) < 2 or not parts[1]:
            return None
        root = f"{parts[0]}/{parts[1].split('@', 1)[0]}"
    else:
        root = parts[0].split("@", 1)[0]
    return root.lower() or None


def js_imported_packages(text: str) -> set[str]:
    roots: set[str] = set()
    for m in _JS_SPECIFIER_RE.finditer(text):
        root = js_package_root(m.group("s1") or m.group("s2") or "")
        if root:
            roots.add(root)
    return roots


_PY_FROM_RE = re.compile(r"^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+\(?([^\n#;)]*)", re.M)
_PY_IMPORT_RE = re.compile(r"^[ \t]*import[ \t]+([^\n#;]+)", re.M)
_PY_DYNAMIC_RE = re.compile(r"\b(?:__import__|import_module)\s*\(\s*[\"']([\w.]+)[\"']")


def _py_imports_by_regex(text: str) -> set[str]:
    """Fallback for files ast cannot parse (other Python versions, templates)."""
    mods: set[str] = set()
    for m in _PY_FROM_RE.finditer(text):
        base = m.group(1)
        if base.startswith("."):
            continue
        mods.add(base)
        for item in m.group(2).split(","):
            words = item.split()
            if words and words[0] != "*":
                mods.add(f"{base}.{words[0]}")
    for m in _PY_IMPORT_RE.finditer(text):
        for item in m.group(1).split(","):
            words = item.split()
            if words:
                mods.add(words[0])
    mods.update(m.group(1) for m in _PY_DYNAMIC_RE.finditer(text))
    return mods


def python_imported_modules(text: str) -> set[str]:
    """Absolute module names a Python file imports. `from a import b` yields `a` and `a.b`, so
    `from google.cloud import vision` yields google.cloud.vision. Also __import__("x") and
    importlib.import_module("x") with a literal name. Relative imports are local, not packages."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return _py_imports_by_regex(text)
    mods: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            mods.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level or not node.module:
                continue
            mods.add(node.module)
            mods.update(f"{node.module}.{alias.name}" for alias in node.names if alias.name != "*")
        elif isinstance(node, ast.Call) and node.args:
            func = node.func
            fname = (
                func.attr
                if isinstance(func, ast.Attribute)
                else func.id
                if isinstance(func, ast.Name)
                else None
            )
            first = node.args[0]
            if (
                fname in {"__import__", "import_module"}
                and isinstance(first, ast.Constant)
                and isinstance(first.value, str)
            ):
                mods.add(first.value)
    return mods


def module_matches(module: str, banned: str) -> bool:
    """`banned` itself, a submodule of it, or a versioned sibling (google.cloud.vision_v1)."""
    return (
        module == banned
        or module.startswith(banned + ".")
        or re.match(re.escape(banned) + r"_v\d", module) is not None
    )


# --- dependency manifests -------------------------------------------------------------------

_DIST_NAME_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?")
_EGG_RE = re.compile(r"#egg=([A-Za-z0-9][A-Za-z0-9._-]*)")


class ManifestError(ValueError):
    """A dependency manifest the guards cannot read. The guards fail closed on it."""


def normalize_dist_name(name: str) -> str:
    """PEP 503 normalisation: case-folded, runs of - _ . collapsed to -."""
    return re.sub(r"[-_.]+", "-", name).lower()


def requirement_name(spec: str) -> str | None:
    """Distribution name of one PEP 508 requirement (extras, versions, markers and direct
    references stripped), normalised. `openai[datalib]>=1; python_version>"3.8"` -> openai."""
    m = _DIST_NAME_RE.match(spec.strip())
    return normalize_dist_name(m.group(0)) if m else None


def requirements_file_names(text: str) -> list[str]:
    """Distribution names a pip requirements file installs."""
    names: list[str] = []
    for raw in re.sub(r"\\\r?\n", " ", text).splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        egg = _EGG_RE.search(line)
        if egg:
            names.append(normalize_dist_name(egg.group(1)))
        if line.startswith("-"):
            continue  # -r/-c/-e/--option lines; an -e VCS URL is covered by #egg= above
        name = requirement_name(re.split(r"\s#", line, maxsplit=1)[0])
        if name:
            names.append(name)
    return names


def _toml(text: str) -> dict:
    if tomllib is None:
        raise ManifestError("Python 3.11+ (tomllib) is required to read TOML manifests")
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as err:
        raise ManifestError(f"invalid TOML: {err}") from err


def _strings(value: object) -> list[str]:
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def pyproject_dependency_names(text: str) -> list[str]:
    """PEP 621 dependencies and optional-dependencies, PEP 735 dependency-groups, build-system
    requires, uv/pdm dev-dependencies and Poetry dependency tables."""
    data = _toml(text)
    specs: list[str] = []
    project = data.get("project") or {}
    specs += _strings(project.get("dependencies"))
    for group in (project.get("optional-dependencies") or {}).values():
        specs += _strings(group)
    for group in (data.get("dependency-groups") or {}).values():
        specs += _strings(group)
    specs += _strings((data.get("build-system") or {}).get("requires"))
    tool = data.get("tool") or {}
    for name in ("uv", "pdm"):
        dev = (tool.get(name) or {}).get("dev-dependencies")
        if isinstance(dev, dict):
            for group in dev.values():
                specs += _strings(group)
        else:
            specs += _strings(dev)
    names = [n for n in (requirement_name(s) for s in specs) if n]
    poetry = tool.get("poetry") or {}
    tables = [poetry.get("dependencies"), poetry.get("dev-dependencies")]
    tables += [(g or {}).get("dependencies") for g in (poetry.get("group") or {}).values()]
    for table in tables:
        if isinstance(table, dict):
            names += [normalize_dist_name(k) for k in table]
    return names


def pipfile_dependency_names(text: str) -> list[str]:
    """Every package category table of a Pipfile ([packages], [dev-packages], custom)."""
    data = _toml(text)
    names: list[str] = []
    for key, table in data.items():
        if key in {"source", "requires", "scripts", "pipenv"} or not isinstance(table, dict):
            continue
        names += [normalize_dist_name(k) for k in table]
    return names


def python_manifest_names(kind: str, text: str) -> list[str]:
    if kind == "requirements":
        return requirements_file_names(text)
    if kind == "pyproject":
        return pyproject_dependency_names(text)
    if kind == "pipfile":
        return pipfile_dependency_names(text)
    raise ValueError(kind)


def load_package_json(text: str) -> dict:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as err:
        raise ManifestError(f"invalid JSON: {err}") from err
    if not isinstance(data, dict):
        raise ManifestError("package.json is not a JSON object")
    return data


def command_text(text: str) -> str:
    """Dockerfile or shell text with full-line comments dropped and line continuations joined,
    so `RUN pip install \\` + newline + `playwright` reads as one command."""
    kept = [line for line in text.splitlines() if not line.lstrip().startswith("#")]
    return re.sub(r"\\[ \t]*\n", " ", "\n".join(kept))


# --- allowlist ------------------------------------------------------------------------------


def load_allowlist() -> dict[str, set[str]]:
    data = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    out: dict[str, set[str]] = {}
    for bucket in ("fa_d3c_001_scraper", "fa_d3c_002_provider"):
        entries = data.get(bucket, [])
        parsed: set[str] = set()
        for raw in entries:
            if ":" not in raw:
                raise ValueError(f"allowlist entry must be path:symbol, got {raw!r}")
            rel, symbol = raw.split(":", 1)
            if not rel or not symbol:
                raise ValueError(f"allowlist entry must be path:symbol, got {raw!r}")
            parsed.add(f"{rel}:{symbol}")
        out[bucket] = parsed
    return out


def apply_allowlist(
    findings: list[GuardFinding],
    allowset: set[str],
) -> tuple[list[str], list[str]]:
    """Return violation messages and stale allowlist keys (expected but not found)."""
    matched: set[str] = set()
    failures: list[str] = []
    for f in findings:
        if f.allow_key in allowset:
            matched.add(f.allow_key)
        else:
            failures.append(f.message)
    stale = sorted(allowset - matched)
    return failures, stale
