#!/usr/bin/env python3
"""scraper-guard — no Playwright/Puppeteer in application source (full tree).

Scans every file outside the skip rules in g0_guard_common (FA-CI-001):
- JS/TS: every module specifier in import, export ... from, import(), require() and
  require.resolve() position, however the statement is laid out across lines, with comments
  between the tokens, with ', " or `; and calls through createRequire aliases.
- Extensionless scripts by shebang: node/bun/deno as JS, python as Python, sh/bash/dash/ash/
  ksh/zsh/busybox (directly or through `env [-S]`) as shell.
- Python: every import (ast), including importlib.import_module("...") and __import__("...").
- package.json dependency sections and scripts; pip requirements files (requirements*.txt/.in,
  requirements/*.txt), pyproject.toml and Pipfile, with PEP 508/503 name normalisation.
- Dockerfiles (Dockerfile, Dockerfile.*, *.Dockerfile, Containerfile) and shell scripts (.sh,
  .bash, .zsh, .ksh, or an extensionless file with a shell shebang) that install
  Playwright/Puppeteer or their browsers.

The one sanctioned use is the root Playwright e2e suite: the root package.json devDependency
@playwright/test, the root playwright.config.*, and the root tests/ tree.

FA-D3C-001 violations are allowlisted per file:symbol in g0_guard_allowlist.json.
Stale allowlist entries (fixed violations still listed) fail the build.
"""
from __future__ import annotations

import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from g0_guard_common import (  # noqa: E402
    GuardFinding,
    ManifestError,
    apply_allowlist,
    command_text,
    file_kind,
    iter_scan_files,
    js_imported_packages,
    load_allowlist,
    load_package_json,
    python_imported_modules,
    python_manifest_names,
    read_text,
    rel_posix,
)

ROOT_PACKAGE_JSON = "package.json"
ROOT_PLAYWRIGHT_TEST_DEV = "@playwright/test"

BUCKET = "fa_d3c_001_scraper"

# npm packages: playwright, playwright-core, playwright-chromium, @playwright/*, puppeteer,
# puppeteer-core, puppeteer-extra, @puppeteer/*, ...
JS_SCRAPER_PACKAGE_RE = re.compile(r"^@?(playwright|puppeteer)")
# Python top-level modules: playwright (sync_api, async_api, ...), playwright_stealth, pyppeteer.
PY_SCRAPER_MODULE_RE = re.compile(r"^(playwright|pyppeteer|puppeteer)", re.I)

_PKG_MANAGER = r"\b(?:pip3?|pipx|uv|poetry|pdm|conda|mamba|npm|pnpm|yarn|bun)\b"
_INSTALL_VERB = r"\b(?:install|add|i)\b"

# `playwright install chromium`, `npx playwright@1.48 install`, `python -m playwright install`,
# `playwright install-deps`, or a package manager installing a Playwright package.
PLAYWRIGHT_INSTALL_RE = re.compile(
    r"\bplaywright(?:-core)?(?:@[\w.^~-]+)?\s+install(?:-deps)?\b"
    rf"|{_PKG_MANAGER}[^\n]*?{_INSTALL_VERB}[^\n]*\bplaywright",
    re.I,
)
PUPPETEER_INSTALL_RE = re.compile(
    r"\b(?:puppeteer|@puppeteer/browsers)(?:@[\w.^~-]+)?\s+(?:browsers\s+)?install\b"
    r"|\bpyppeteer-install\b"
    rf"|{_PKG_MANAGER}[^\n]*?{_INSTALL_VERB}[^\n]*(?:puppeteer|pyppeteer)"
    r"|npm\s+.*puppeteer|pip\s+.*puppeteer",
    re.I,
)


def _dist_symbol(name: str) -> str | None:
    low = name.lower()
    if "playwright" in low:
        return "playwright"
    if "puppeteer" in low or "pyppeteer" in low:
        return "puppeteer"
    return None


def _install_findings(rel: str, text: str, where: str) -> list[GuardFinding]:
    out: list[GuardFinding] = []
    if PLAYWRIGHT_INSTALL_RE.search(text):
        out.append(GuardFinding(rel, "playwright_install", f"{rel}: Playwright install in {where}"))
    if PUPPETEER_INSTALL_RE.search(text):
        out.append(GuardFinding(rel, "puppeteer_install", f"{rel}: Puppeteer install in {where}"))
    return out


def _check_package_json(rel: str, text: str) -> list[GuardFinding]:
    data = load_package_json(text)
    out: list[GuardFinding] = []
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name in data.get(section) or {}:
            if rel == ROOT_PACKAGE_JSON and section == "devDependencies" and name == ROOT_PLAYWRIGHT_TEST_DEV:
                continue
            sym = _dist_symbol(name)
            if sym:
                out.append(GuardFinding(rel, sym, f"{rel}: {section} lists {name}"))
    scripts = data.get("scripts") or {}
    if isinstance(scripts, dict):
        body = "\n".join(v for v in scripts.values() if isinstance(v, str))
        out.extend(_install_findings(rel, body, "package.json scripts"))
    return out


def _check_python_manifest(rel: str, kind: str, text: str) -> list[GuardFinding]:
    out: list[GuardFinding] = []
    for name in python_manifest_names(kind, text):
        sym = _dist_symbol(name)
        if sym:
            out.append(GuardFinding(rel, sym, f"{rel}: requires {name}"))
    return out


def _check_js(rel: str, text: str) -> list[GuardFinding]:
    out: list[GuardFinding] = []
    for root in js_imported_packages(text):
        m = JS_SCRAPER_PACKAGE_RE.match(root)
        if m:
            sym = m.group(1)
            out.append(GuardFinding(rel, sym, f"{rel}: {sym} import"))
    return out


def _check_python(rel: str, text: str) -> list[GuardFinding]:
    out: list[GuardFinding] = []
    for module in python_imported_modules(text):
        m = PY_SCRAPER_MODULE_RE.match(module)
        if m:
            sym = "playwright" if m.group(1).lower() == "playwright" else "puppeteer"
            out.append(GuardFinding(rel, sym, f"{rel}: {sym} import"))
    return out


def findings_for(p: pathlib.Path) -> list[GuardFinding]:
    kind = file_kind(p)
    if kind is None:
        return []
    text = read_text(p)
    if text is None:
        return []
    rel = rel_posix(p)
    try:
        if kind == "package_json":
            return _check_package_json(rel, text)
        if kind in {"requirements", "pyproject", "pipfile"}:
            return _check_python_manifest(rel, kind, text)
        if kind == "dockerfile":
            return _install_findings(rel, command_text(text), "Dockerfile")
        if kind == "shell":
            return _install_findings(rel, command_text(text), "shell script")
        if kind == "js":
            return _check_js(rel, text)
        if kind == "py":
            return _check_python(rel, text)
    except ManifestError as err:
        return [GuardFinding(rel, "unreadable_manifest", f"{rel}: cannot read manifest ({err})")]
    return []


def collect_findings() -> list[GuardFinding]:
    findings: list[GuardFinding] = []
    for p in iter_scan_files():
        findings.extend(findings_for(p))
    return findings


def main() -> int:
    allow = load_allowlist()[BUCKET]
    findings = collect_findings()
    failures, stale = apply_allowlist(findings, allow)
    if stale:
        failures.extend([f"stale allowlist entry (no matching finding): {key}" for key in stale])
    if failures:
        print("FAIL: scraper library in application source (N1 / L17.12):")
        for f in sorted(set(failures)):
            print(" ", f)
        return 1
    print("PASS: no unallowlisted Playwright/Puppeteer; FA-D3C-001 allowlist entries verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
