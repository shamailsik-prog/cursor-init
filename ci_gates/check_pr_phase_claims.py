#!/usr/bin/env python3
"""Fail misleading PR phase claims.

Rules:
1) Require explicit `backend_real`, `frontend_real`, and `transport_stub` flags
   in PR metadata.
2) Require action/view -> `/ops` call-site evidence in PR metadata.
3) If PR metadata claims "scaffold-only/docs-only/no runtime change", fail when
   route handlers or tests changed.
4) If PR metadata claims COMPLETE/product-done, fail while filing transport
   TODO/stub markers remain active.
5) If PR metadata claims COMPLETE/product-done, fail when
   `frontend_real=false` OR `transport_stub=true`.
6) If PR touches `/ops`, require focused ops tests and at least one concrete
   `/api/...` fetch-path evidence entry in PR metadata.
7) Reject self-certifying DONE/COMPLETE statements directed to Shamail.
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
SHAMAIL_SELF_CERTIFY_RE = re.compile(
    r"\bshamail\b[\s\S]{0,80}\b(done|complete|completed|product[-\s]?done)\b"
    r"|\b(done|complete|completed|product[-\s]?done)\b[\s\S]{0,80}\bshamail\b",
    re.IGNORECASE,
)

FLAG_VALUE_RE = re.compile(
    r"\b(?P<name>backend_real|frontend_real|transport_stub)\b\s*[:=]\s*"
    r"(?P<value>true|false|pass|fail|yes|no|1|0)\b",
    re.IGNORECASE,
)

CALLSITE_EVIDENCE_RE = re.compile(
    r"(action|view)[-_ ]?name[\s\S]{0,120}(?:->|→)[\s\S]{0,160}app/ops/operator-audit-console\.tsx"
    r"|(?:`?[a-z0-9_:-]+`?)[\s]*(?:->|→)[\s]*`?app/ops/operator-audit-console\.tsx`?",
    re.IGNORECASE,
)

ROUTE_OR_TEST_PREFIXES = ("app/api/", "tests/")
OPS_PREFIX = "app/ops/"
OPS_TEST_PREFIX = "tests/ops"

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


def ops_changed(paths: list[str]) -> bool:
    return any(path.startswith(OPS_PREFIX) for path in paths)


def focused_ops_test_changed(paths: list[str]) -> bool:
    return any(path.startswith(OPS_TEST_PREFIX) and path.endswith(".test.ts") for path in paths)


def transport_stub_present() -> bool:
    for path in TRANSPORT_STUB_LOCATIONS:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        if any(marker in text for marker in TRANSPORT_STUB_PATTERNS):
            return True
    return False


def parse_flags(claim_text: str) -> dict[str, bool]:
    parsed: dict[str, bool] = {}
    for match in FLAG_VALUE_RE.finditer(claim_text):
        name = match.group("name").lower()
        raw = match.group("value").lower()
        parsed[name] = raw in {"true", "pass", "yes", "1"}
    return parsed


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
    flags = parse_flags(claim_text)

    missing_flags = [name for name in ("backend_real", "frontend_real", "transport_stub") if name not in flags]
    if missing_flags:
        failures.append(
            "PR metadata must declare backend_real, frontend_real, and transport_stub "
            f"(missing: {', '.join(missing_flags)})."
        )

    if not CALLSITE_EVIDENCE_RE.search(claim_text):
        failures.append(
            "PR metadata must include action-name→call-site evidence for /ops "
            "(e.g. `set_backup_owner -> app/ops/operator-audit-console.tsx`)."
        )

    if changed_paths and route_or_test_changed(changed_paths) and SCAFFOLD_ONLY_RE.search(claim_text):
        failures.append(
            "PR claim says scaffold/docs-only or no runtime changes, but route/tests changed."
        )

    if SHAMAIL_SELF_CERTIFY_RE.search(claim_text):
        failures.append("Do not self-certify DONE/COMPLETE to Shamail in PR metadata.")

    if changed_paths and ops_changed(changed_paths):
        if not focused_ops_test_changed(changed_paths):
            failures.append(
                "PR touches app/ops but no focused tests under tests/ops*.test.ts were changed."
            )
        if "/api/" not in claim_text:
            failures.append(
                "PR touches app/ops; include at least one concrete /api/... fetch-path evidence entry."
            )

    if COMPLETE_CLAIM_RE.search(claim_text) and transport_stub_present():
        failures.append(
            "PR claims COMPLETE/product-done while filing transport TODO/stub markers still exist."
        )
    if COMPLETE_CLAIM_RE.search(claim_text):
        if "frontend_real" in flags and not flags["frontend_real"]:
            failures.append("PR claims COMPLETE/product-done while frontend_real=false.")
        if "transport_stub" in flags and flags["transport_stub"]:
            failures.append("PR claims COMPLETE/product-done while transport_stub=true.")

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
