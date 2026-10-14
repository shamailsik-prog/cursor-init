#!/usr/bin/env python3
"""Shared path rules for G-0 scraper and provider guards."""
from __future__ import annotations

import json
import pathlib

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
    # Root tests/ only — not functions/test/ or other nested test dirs.
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


def load_allowlist() -> dict[str, list[str]]:
    data = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    return {
        "fa_d3c_001_scraper": list(data.get("fa_d3c_001_scraper", [])),
        "fa_d3c_002_provider": list(data.get("fa_d3c_002_provider", [])),
    }


def is_allowlisted(rel: str, bucket: str, allow: dict[str, list[str]]) -> bool:
    return rel in allow.get(bucket, [])
