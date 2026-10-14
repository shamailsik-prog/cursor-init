#!/usr/bin/env python3
"""Shared path rules and allowlist handling for G-0 scraper and provider guards."""
from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass

SOURCE_SUFFIXES = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".py",
}

SKIP_DIR_NAMES = {
    "node_modules",
    ".git",
    ".next",
    "ci_gates",
    "_superseded",
    ".eve",
}

ALLOWLIST_PATH = pathlib.Path(__file__).with_name("g0_guard_allowlist.json")


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


def is_skipped_path(p: pathlib.Path) -> bool:
    if any(part in SKIP_DIR_NAMES for part in p.parts):
        return True
    r = rel_posix(p)
    if r == "playwright.config.ts":
        return True
    if r == "playwright.config.mts" or r == "playwright.config.cts":
        return True
    parts = p.parts
    if parts and parts[0] == "tests":
        return True
    return False


def iter_scan_files(root: pathlib.Path = pathlib.Path(".")):
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if is_skipped_path(p):
            continue
        yield p


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
