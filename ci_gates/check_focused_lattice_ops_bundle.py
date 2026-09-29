#!/usr/bin/env python3
"""Keep focused lattice ops vitest bundle runner, ledger doc, and frontend-real coverage aligned."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "ci_gates" / "run_focused_lattice_ops_vitest.sh"
LEDGER = ROOT / "docs" / "audits" / "lattice-focused-ops-vitest-bundle.md"
TESTS_DIR = ROOT / "tests"

VIEW_RANGE_RE = re.compile(r"(\d{3})-(\d{3})")
RUNNER_FILE_RE = re.compile(r'^\s+(tests/[^\s"]+\.test\.ts),?\s*$')
LEDGER_FILE_RE = re.compile(r"`(tests/[^`]+\.test\.ts)`")
FRONTEND_REAL_GLOB = "ops.*-frontend-real.test.ts"
BATCH_PREFIX = "tests/ops.batch-"


def parse_runner_files(text: str) -> list[str]:
    files: list[str] = []
    in_array = False
    for line in text.splitlines():
        if line.strip().startswith("FILES=("):
            in_array = True
            continue
        if in_array:
            if line.strip() == ")":
                break
            match = RUNNER_FILE_RE.match(line)
            if match:
                files.append(match.group(1))
    return files


def parse_ledger_files(text: str) -> list[str]:
    start = text.find("## File list")
    end = text.find("## History")
    section = text[start:end] if start != -1 and end != -1 else text
    files: list[str] = []
    for match in LEDGER_FILE_RE.finditer(section):
        files.append(match.group(1))
    return files


def parse_expected_count(text: str) -> int | None:
    match = re.search(r'\$\{#FILES\[@\]\}"\s+-ne\s+(\d+)', text)
    if match:
        return int(match.group(1))
    match = re.search(r"expected\s+(\d+)\s+files", text)
    if match:
        return int(match.group(1))
    return None


def lattice_frontend_real_paths() -> list[str]:
    paths: list[str] = []
    for path in sorted(TESTS_DIR.glob(FRONTEND_REAL_GLOB)):
        rel = f"tests/{path.name}"
        if rel.startswith(BATCH_PREFIX):
            continue
        if not rel.startswith("tests/ops."):
            continue
        view_match = VIEW_RANGE_RE.search(path.name)
        if view_match:
            lo, hi = int(view_match.group(1)), int(view_match.group(2))
            if lo < 485 or hi > 548:
                continue
        paths.append(rel)
    return paths


def main() -> int:
    fail = False

    if not RUNNER.is_file():
        print(f"FAIL: missing runner {RUNNER}")
        return 1
    if not LEDGER.is_file():
        print(f"FAIL: missing ledger {LEDGER}")
        return 1

    runner_text = RUNNER.read_text(encoding="utf-8")
    ledger_text = LEDGER.read_text(encoding="utf-8")
    runner_files = parse_runner_files(runner_text)
    ledger_files = parse_ledger_files(ledger_text)

    expected = parse_expected_count(runner_text)
    if expected is None:
        print("FAIL: could not parse expected file count from runner")
        fail = True
    elif len(runner_files) != expected:
        print(
            f"FAIL: runner FILES has {len(runner_files)} entries but guard expects {expected}"
        )
        fail = True
    else:
        print(f"PASS: runner guard matches FILES length ({expected})")

    if runner_files != ledger_files:
        print("FAIL: runner FILES and ledger doc file lists differ")
        only_runner = set(runner_files) - set(ledger_files)
        only_ledger = set(ledger_files) - set(runner_files)
        if only_runner:
            print(f"  only in runner: {sorted(only_runner)}")
        if only_ledger:
            print(f"  only in ledger: {sorted(only_ledger)}")
        fail = True
    else:
        print(f"PASS: runner and ledger agree ({len(runner_files)} files)")

    required_fe = lattice_frontend_real_paths()
    runner_set = set(runner_files)
    missing = [p for p in required_fe if p not in runner_set]
    extra_fe = [
        p
        for p in runner_files
        if p.startswith("tests/ops.") and p.endswith("-frontend-real.test.ts") and p not in required_fe
    ]
    if missing:
        print("FAIL: lattice frontend-real tests missing from runner FILES:")
        for path in missing:
            print(f"  - {path}")
        fail = True
    else:
        print(f"PASS: all {len(required_fe)} lattice frontend-real files (485–548) in FILES")

    if extra_fe:
        print("FAIL: runner includes unexpected ops frontend-real files:")
        for path in extra_fe:
            print(f"  - {path}")
        fail = True

    if fail:
        print("=== focused lattice ops bundle check FAILED ===")
        return 1
    print("=== focused lattice ops bundle check PASSED ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
