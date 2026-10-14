#!/usr/bin/env python3
"""scraper-guard — no Playwright/Puppeteer in application source (full tree).

FA-D3C-001 violations are allowlisted per file:symbol in g0_guard_allowlist.json.
Stale allowlist entries (fixed violations still listed) fail the build.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from g0_guard_common import (
    GuardFinding,
    SOURCE_SUFFIXES,
    apply_allowlist,
    iter_scan_files,
    load_allowlist,
    rel_posix,
)

PLAYWRIGHT_IMPORT_RE = re.compile(
    r"""
    from\s+(?:["']playwright[\w./-]*["']|playwright[\w.]*)\s+import|
    import\s+[^;\n]*\bplaywright\b|
    require\s*\(\s*["']playwright[\w./-]*["']|
    import\s*\(\s*["']playwright[\w./-]*["']
    """,
    re.I | re.VERBOSE,
)
PUPPETEER_IMPORT_RE = re.compile(
    r"""
    from\s+(?:["']puppeteer[\w./-]*["']|puppeteer[\w.]*)\s+import|
    import\s+[^;\n]*\bpuppeteer\b|
    require\s*\(\s*["']puppeteer[\w./-]*["']|
    import\s*\(\s*["']puppeteer[\w./-]*["']
    """,
    re.I | re.VERBOSE,
)

DOCKER_PLAYWRIGHT_RE = re.compile(r"\bplaywright\s+install\b", re.I)

ROOT_PACKAGE_JSON = "package.json"
ROOT_PLAYWRIGHT_TEST_DEV = "@playwright/test"

BUCKET = "fa_d3c_001_scraper"


def _pkg_symbol(name: str) -> str | None:
    low = name.lower()
    if "playwright" in low:
        return "playwright"
    if "puppeteer" in low:
        return "puppeteer"
    return None


def _check_package_json(path: pathlib.Path) -> list[GuardFinding]:
    rel = rel_posix(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    out: list[GuardFinding] = []
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name in data.get(section, {}):
            if rel == ROOT_PACKAGE_JSON and section == "devDependencies" and name == ROOT_PLAYWRIGHT_TEST_DEV:
                continue
            sym = _pkg_symbol(name)
            if sym:
                out.append(
                    GuardFinding(rel, sym, f"{rel}: {section} lists {name}"),
                )
    return out


def _check_requirements_txt(path: pathlib.Path) -> list[GuardFinding]:
    rel = rel_posix(path)
    out: list[GuardFinding] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        token = re.split(r"[<>=!~\s]", stripped, maxsplit=1)[0].lower()
        if token in {"playwright", "puppeteer"}:
            out.append(GuardFinding(rel, token, f"{rel}: requires {token}"))
    return out


def _check_dockerfile(path: pathlib.Path) -> list[GuardFinding]:
    rel = rel_posix(path)
    text = path.read_text(encoding="utf-8", errors="ignore")
    out: list[GuardFinding] = []
    if DOCKER_PLAYWRIGHT_RE.search(text):
        out.append(
            GuardFinding(rel, "playwright_install", f"{rel}: Playwright install in Dockerfile"),
        )
    if re.search(r"puppeteer\s+install|npm\s+.*puppeteer|pip\s+.*puppeteer", text, re.I):
        out.append(GuardFinding(rel, "puppeteer_install", f"{rel}: Puppeteer in Dockerfile"))
    return out


def _check_source(path: pathlib.Path, text: str) -> list[GuardFinding]:
    rel = rel_posix(path)
    out: list[GuardFinding] = []
    if PLAYWRIGHT_IMPORT_RE.search(text):
        out.append(GuardFinding(rel, "playwright", f"{rel}: playwright import"))
    if PUPPETEER_IMPORT_RE.search(text):
        out.append(GuardFinding(rel, "puppeteer", f"{rel}: puppeteer import"))
    return out


def collect_findings() -> list[GuardFinding]:
    findings: list[GuardFinding] = []
    for p in iter_scan_files():
        if p.name == "package.json":
            findings.extend(_check_package_json(p))
            continue
        if p.name == "requirements.txt":
            findings.extend(_check_requirements_txt(p))
            continue
        if p.name == "Dockerfile" or p.name.endswith(".Dockerfile"):
            findings.extend(_check_dockerfile(p))
            continue
        if p.suffix not in SOURCE_SUFFIXES:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        findings.extend(_check_source(p, text))
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
