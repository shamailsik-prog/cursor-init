#!/usr/bin/env python3
"""scraper-guard — no Playwright/Puppeteer in application source (full tree).

Scans the repository like fee-guard [1], excluding harvest-only trees and test harnesses.
corpus_service/ is excluded until FA-D3C-001 (separate repo / harvest boundary).
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

SKIP_PARTS = {
    "node_modules",
    ".git",
    ".next",
    "ci_gates",
    "_superseded",
    "corpus_service",
    ".eve",
    "tests",
}
SKIP_FILES = {"playwright.config.ts"}

SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".py"}

# Real dependency / import usage, not documentation strings.
IMPORT_RE = re.compile(
    r"""
    (?:from\s+["']playwright|import\s+[^;\n]*\bplaywright\b|require\s*\(\s*["']playwright)
    |(?:from\s+["']puppeteer|import\s+[^;\n]*\bpuppeteer\b|require\s*\(\s*["']puppeteer)
    """,
    re.I | re.VERBOSE,
)


def _rel(p: pathlib.Path) -> str:
    return str(p).replace("\\", "/")


def _check_package_json(path: pathlib.Path) -> list[str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    failed: list[str] = []
    for section in ("dependencies", "optionalDependencies"):
        for name in data.get(section, {}):
            low = name.lower()
            if "playwright" in low or "puppeteer" in low:
                failed.append(f"{_rel(path)}: {section} lists {name}")
    return failed


def _check_requirements_txt(path: pathlib.Path) -> list[str]:
    failed: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        token = re.split(r"[<>=!~\s]", stripped, maxsplit=1)[0].lower()
        if token in {"playwright", "puppeteer"}:
            failed.append(f"{_rel(path)}: requires {token}")
    return failed


def main() -> int:
    failed: list[str] = []
    for p in pathlib.Path(".").rglob("*"):
        if any(part in SKIP_PARTS for part in p.parts):
            continue
        rel = _rel(p)
        if p.name in SKIP_FILES:
            continue
        if p.name == "package.json":
            failed.extend(_check_package_json(p))
            continue
        if p.name == "requirements.txt":
            failed.extend(_check_requirements_txt(p))
            continue
        if p.suffix not in SOURCE_SUFFIXES:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if IMPORT_RE.search(text):
            failed.append(f"{rel}: Playwright/Puppeteer import")

    if failed:
        print("FAIL: scraper library in application source (N1 / L17.12):")
        for f in sorted(set(failed)):
            print(" ", f)
        return 1
    print("PASS: no Playwright/Puppeteer outside excluded trees")
    return 0


if __name__ == "__main__":
    sys.exit(main())
