#!/usr/bin/env python3
"""Fail misleading PR phase claims.

Rules:
1) If PR metadata claims "scaffold-only/docs-only/no runtime change", fail when
   route handlers or tests changed.
2) If PR metadata claims COMPLETE/product-done, fail while filing transport
   TODO/stub markers remain active.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

SCAFFOLD_ONLY_RE = re.compile(
    r"\b(scaffold[-\s]?only|docs[-\s]?only|documentation[-\s]?only|no runtime changes?)\b",
    re.IGNORECASE,
)

COMPLETE_CLAIM_RE = re.compile(
    r"\b(phase complete|complete product|fully done|product[-\s]?done|done product)\b",
    re.IGNORECASE,
)

ROUTE_OR_TEST_PREFIXES = ("app/api/", "tests/")

TRANSPORT_STUB_LOCATIONS = [
    Path("platform/persistence/filingDispatchQueue.ts"),
    Path("platform/persistence/filingSubmissionReceipts.ts"),
    Path("platform/persistence/filingTransportExecutionEvidence.ts"),
    Path("app/api/d4/filings/route.ts"),
]

TRANSPORT_STUB_PATTERNS = (
    "TODO(firm): external court submission transport",
    "blocked_todo_firm",
    "_stub",
)


def read_pr_claim_text() -> str:
    title = os.getenv("PR_TITLE", "")
    body = os.getenv("PR_BODY", "")
    return f"{title}\n{body}".strip()


def list_changed_files(base_sha: str, head_sha: str) -> list[str]:
    cmd = ["git", "diff", "--name-only", base_sha, head_sha]
    output = subprocess.check_output(cmd, text=True)
    return [line.strip() for line in output.splitlines() if line.strip()]


def route_or_test_changed(paths: list[str]) -> bool:
    return any(path.startswith(ROUTE_OR_TEST_PREFIXES) for path in paths)


def transport_stub_present() -> bool:
    for path in TRANSPORT_STUB_LOCATIONS:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        if any(marker in text for marker in TRANSPORT_STUB_PATTERNS):
            return True
    return False


def main() -> int:
    claim_text = read_pr_claim_text()
    if not claim_text:
        print("PR metadata not provided; skipping claim gate.")
        return 0

    base_sha = os.getenv("BASE_SHA", "").strip()
    head_sha = os.getenv("HEAD_SHA", "").strip()
    changed_paths: list[str] = []
    if base_sha and head_sha:
        changed_paths = list_changed_files(base_sha, head_sha)
    else:
        print("BASE_SHA/HEAD_SHA missing; changed-file checks skipped.")

    failures: list[str] = []

    if changed_paths and route_or_test_changed(changed_paths) and SCAFFOLD_ONLY_RE.search(claim_text):
        failures.append(
            "PR claim says scaffold/docs-only or no runtime changes, but route/tests changed."
        )

    if COMPLETE_CLAIM_RE.search(claim_text) and transport_stub_present():
        failures.append(
            "PR claims COMPLETE/product-done while filing transport TODO/stub markers still exist."
        )

    if failures:
        print("FAIL: PR phase-claim gate blocked this change.")
        for item in failures:
            print(f" - {item}")
        print("Required labels while transport stubs exist: backend_real, frontend_real, transport_stub.")
        return 1

    print("PASS: PR phase-claim gate.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
