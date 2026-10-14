#!/usr/bin/env python3
"""scraper-guard — no Playwright/Puppeteer in application source (full tree).

Known corpus_service violations are allowlisted per file (FA-D3C-001) until remediated.
Any new violation under corpus_service/ fails the build.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from g0_guard_common import (
    SOURCE_SUFFIXES,
    is_allowlisted,
    iter_scan_files,
    load_allowlist,
    rel_posix,
)

# Real dependency / import usage, not bare words in docstrings.
IMPORT_RE = re.compile(
    r"""
    (?:from\s+(?:["']playwright[\w./-]*["']|playwright[\w.]*)\s+import|
       import\s+[^;\n]*\bplaywright\b|
       require\s*\(\s*["']playwright[\w./-]*["']|
       import\s*\(\s*["']playwright[\w./-]*["'])
    |(?:from\s+(?:["']puppeteer[\w./-]*["']|puppeteer[\w.]*)\s+import|
       import\s+[^;\n]*\bpuppeteer\b|
       require\s*\(\s*["']puppeteer[\w./-]*["']|
       import\s*\(\s*["']puppeteer[\w./-]*["'])
    """,
    re.I | re.VERBOSE,
)

DOCKER_PLAYWRIGHT_RE = re.compile(r"\bplaywright\s+install\b", re.I)
DOCKER_PUPPETEER_RE = re.compile(r"\bpuppeteer\b", re.I)

ROOT_PACKAGE_JSON = "package.json"
ROOT_PLAYWRIGHT_TEST_DEV = "@playwright/test"


def _check_package_json(path: pathlib.Path) -> list[str]:
    rel = rel_posix(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    failed: list[str] = []
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name in data.get(section, {}):
            low = name.lower()
            if "playwright" not in low and "puppeteer" not in low:
                continue
            if rel == ROOT_PACKAGE_JSON and section == "devDependencies" and name == ROOT_PLAYWRIGHT_TEST_DEV:
                continue
            failed.append(f"{rel}: {section} lists {name}")
    return failed


def _check_requirements_txt(path: pathlib.Path) -> list[str]:
    failed: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        token = re.split(r"[<>=!~\s]", stripped, maxsplit=1)[0].lower()
        if token in {"playwright", "puppeteer"}:
            failed.append(f"{rel_posix(path)}: requires {token}")
    return failed


def _check_dockerfile(path: pathlib.Path) -> list[str]:
    rel = rel_posix(path)
    text = path.read_text(encoding="utf-8", errors="ignore")
    failed: list[str] = []
    if DOCKER_PLAYWRIGHT_RE.search(text):
        failed.append(f"{rel}: Playwright install in Dockerfile")
    if DOCKER_PUPPETEER_RE.search(text) and "puppeteer" in text.lower():
        # Avoid matching unrelated words; require install-like context or package name
        if re.search(r"puppeteer\s+install|npm\s+.*puppeteer|pip\s+.*puppeteer", text, re.I):
            failed.append(f"{rel}: Puppeteer in Dockerfile")
    return failed


def main() -> int:
    allow = load_allowlist()
    failed: list[str] = []

    for p in iter_scan_files():
        rel = rel_posix(p)
        if p.name == "package.json":
            for hit in _check_package_json(p):
                if not is_allowlisted(rel, "fa_d3c_001_scraper", allow):
                    failed.append(hit)
            continue
        if p.name == "requirements.txt":
            for hit in _check_requirements_txt(p):
                if not is_allowlisted(rel, "fa_d3c_001_scraper", allow):
                    failed.append(hit)
            continue
        if p.name == "Dockerfile" or p.name.endswith(".Dockerfile"):
            for hit in _check_dockerfile(p):
                if not is_allowlisted(rel, "fa_d3c_001_scraper", allow):
                    failed.append(hit)
            continue
        if p.suffix not in SOURCE_SUFFIXES:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if IMPORT_RE.search(text):
            if not is_allowlisted(rel, "fa_d3c_001_scraper", allow):
                failed.append(f"{rel}: Playwright/Puppeteer import")

    if failed:
        print("FAIL: scraper library in application source (N1 / L17.12):")
        for f in sorted(set(failed)):
            print(" ", f)
        return 1
    print("PASS: no Playwright/Puppeteer outside allowlisted FA-D3C-001 files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
