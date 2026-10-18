#!/usr/bin/env python3
"""Fail misleading PR phase claims.

Rules:
1) Require explicit `backend_real`, `frontend_real`, and `transport_stub` flags
   in PR metadata. Only line-anchored declarations count: `flag: value` or
   `flag=value` at the start of a line (optionally a `-`/`*`/`+` list item), or
   a markdown table row `| flag | value |`. A mention inside a sentence, such as
   "fails `transport_stub: false` while...", is not a declaration.
2) Require action/view -> `/ops` call-site evidence in PR metadata only when
   `frontend_real=true` or `/ops` files are changed.
3) If PR metadata claims "scaffold-only/docs-only/no runtime change", fail when
   route handlers or tests changed. Next-slice mentions such as
   "docs-only queue update" are not treated as current-PR claims.
4) If PR metadata claims COMPLETE/product-done, fail while filing transport
   TODO/stub markers remain active.
5) If PR metadata claims COMPLETE/product-done, fail when
   `frontend_real=false` OR `transport_stub=true`.
6) If PR touches `/ops`, require focused ops tests and at least one concrete
   `/api/...` fetch-path evidence entry in PR metadata.
7) Reject self-certifying DONE/COMPLETE statements directed to Shamail.
8) Fail when `transport_stub` is declared false while filing transport
   TODO/stub markers remain in the tree (the flag must say what the code is).
9) Fail when one flag is declared more than once with different values
   ("conflicting <flag> declarations"); no declaration silently wins.
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
# Roadmap / next-slice mentions such as "docs-only queue update" are not
# claims that the current PR is docs-only.
SCAFFOLD_NEXT_SLICE_MENTION_RE = re.compile(
    r"\b(?:docs|documentation)[-\s]?only\s+queue\s+update\b",
    re.IGNORECASE,
)

COMPLETE_TOKEN = r"(?:(?:phase\s+)?complete|complete\s+product|fully\s+done|product[-\s]?done|done\s+product)"
COMPLETE_CLAIM_RE = re.compile(
    rf"\b({COMPLETE_TOKEN})\b",
    re.IGNORECASE,
)
NEGATED_COMPLETE_DISCLAIMER_RE = re.compile(
    r"\b(?:no|not(?:\s+yet)?|never|without|do(?:es)?\s+not|don['’]t)\b"
    r"\s*(?:\*\*)?\s*"
    r"(?:(?:a|an|the)\s+)?"
    rf"{COMPLETE_TOKEN}"
    rf"(?:\s*/\s*{COMPLETE_TOKEN})*"
    r"(?:\s+claims?)?",
    re.IGNORECASE,
)
SHAMAIL_SELF_CERTIFY_RE = re.compile(
    r"\bshamail\b[\s\S]{0,80}\b(done|complete|completed|product[-\s]?done)\b"
    r"|\b(done|complete|completed|product[-\s]?done)\b[\s\S]{0,80}\bshamail\b",
    re.IGNORECASE,
)

FLAG_NAMES = ("backend_real", "frontend_real", "transport_stub")
TRUTHY = frozenset({"true", "pass", "yes", "1"})
FALSY = frozenset({"false", "fail", "no", "0"})

_FLAG_NAME = r"backend_real|frontend_real|transport_stub"
_FLAG_VALUE = r"true|false|pass|fail|yes|no|1|0"

# A declaration line: the flag name at the start of a line (optionally a `-`/`*`/`+` list item;
# the name alone may be wrapped in backticks or bold), then `:` or `=`, then the value. A mention
# inside a sentence ("fails `transport_stub: false` while...") is not at the start of a line, and
# a code span quoting a whole declaration ("`transport_stub=false` is refused") does not wrap the
# name alone, so neither is a declaration. `true/false` (a template placeholder) is no value.
FLAG_DECLARATION_LINE_RE = re.compile(
    r"^[ \t]*(?:[-*+][ \t]+)?"
    rf"(?:`(?P<n1>{_FLAG_NAME})`|\*\*(?P<n2>{_FLAG_NAME})\*\*|(?P<n3>{_FLAG_NAME}))"
    r"[ \t]*[:=][ \t]*(?:\*\*|`)?"
    rf"(?P<value>{_FLAG_VALUE})\b(?!/)",
    re.IGNORECASE | re.MULTILINE,
)

# Markdown table rows, e.g. `| backend_real | true |` or `| **backend_real** | **true** |`.
FLAG_TABLE_ROW_RE = re.compile(
    r"^\s*\|\s*(?P<name>[^|]+?)\s*\|\s*(?P<value>[^|]+?)\s*\|",
    re.MULTILINE,
)


def _strip_markdown_cell(token: str) -> str:
    cleaned = token.strip()
    cleaned = re.sub(r"^`+|`+$", "", cleaned)
    cleaned = re.sub(r"^\*+|\*+$", "", cleaned)
    return cleaned.strip().lower()


def _coerce_flag_value(raw: str) -> bool | None:
    value = raw.lower()
    if value in TRUTHY:
        return True
    if value in FALSY:
        return False
    return None

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


# Cursor Bugbot appends a generated summary of the diff to PR bodies between these markers. It is
# a third party's description, not the author's claim, so it is neither a COMPLETE claim nor a
# place to declare flags (PR #72: its prose "work that cannot complete" read as a claim). Only a
# closed block is removed; an unterminated marker leaves the text in place, so it is still read.
BOT_SUMMARY_RE = re.compile(r"<!-- CURSOR_SUMMARY -->.*?<!-- /CURSOR_SUMMARY -->", re.DOTALL)


def read_pr_claim_text() -> str:
    title = os.getenv("PR_TITLE", "")
    body = BOT_SUMMARY_RE.sub("", os.getenv("PR_BODY", ""))
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


def transport_stub_files() -> list[str]:
    """The filing transport files that still carry a TODO/stub marker."""
    found: list[str] = []
    for path in TRANSPORT_STUB_LOCATIONS:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        if any(marker in text for marker in TRANSPORT_STUB_PATTERNS):
            found.append(path.as_posix())
    return found


def transport_stub_present() -> bool:
    return bool(transport_stub_files())


def flag_declarations(claim_text: str) -> dict[str, list[bool]]:
    """Every line-anchored declaration of each flag, in the order they appear."""
    found: list[tuple[int, str, bool]] = []
    for match in FLAG_DECLARATION_LINE_RE.finditer(claim_text):
        name = (match.group("n1") or match.group("n2") or match.group("n3")).lower()
        coerced = _coerce_flag_value(match.group("value"))
        if coerced is not None:
            found.append((match.start(), name, coerced))
    for match in FLAG_TABLE_ROW_RE.finditer(claim_text):
        name = _strip_markdown_cell(match.group("name"))
        if name not in FLAG_NAMES:
            continue
        value_cell = _strip_markdown_cell(match.group("value"))
        value_token = re.split(r"\s+[-—]\s+|\s+", value_cell, maxsplit=1)[0]
        coerced = _coerce_flag_value(value_token)
        if coerced is not None:
            found.append((match.start(), name, coerced))
    declarations: dict[str, list[bool]] = {}
    for _, name, value in sorted(found):
        declarations.setdefault(name, []).append(value)
    return declarations


def parse_flags(claim_text: str) -> tuple[dict[str, bool], dict[str, list[bool]]]:
    """The declared flags, and apart from them the flags whose declarations disagree."""
    flags: dict[str, bool] = {}
    conflicts: dict[str, list[bool]] = {}
    for name, values in flag_declarations(claim_text).items():
        if len(set(values)) > 1:
            conflicts[name] = values
        else:
            flags[name] = values[0]
    return flags, conflicts


def _contained_in_spans(match: re.Match[str], spans: list[tuple[int, int]]) -> bool:
    return any(start <= match.start() and match.end() <= end for start, end in spans)


def has_complete_claim(claim_text: str) -> bool:
    negated_spans = [match.span() for match in NEGATED_COMPLETE_DISCLAIMER_RE.finditer(claim_text)]
    for claim_match in COMPLETE_CLAIM_RE.finditer(claim_text):
        if _contained_in_spans(claim_match, negated_spans):
            continue
        return True
    return False


def has_scaffold_only_claim(claim_text: str) -> bool:
    mention_spans = [match.span() for match in SCAFFOLD_NEXT_SLICE_MENTION_RE.finditer(claim_text)]
    for claim_match in SCAFFOLD_ONLY_RE.finditer(claim_text):
        if _contained_in_spans(claim_match, mention_spans):
            continue
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
    flags, conflicting_flags = parse_flags(claim_text)

    for name, values in conflicting_flags.items():
        failures.append(
            f"conflicting {name} declarations ({', '.join('true' if v else 'false' for v in values)}, "
            "in order); declare each flag once, at the start of a line or in a `| flag | value |` row."
        )

    missing_flags = [name for name in FLAG_NAMES if name not in flags and name not in conflicting_flags]
    if missing_flags:
        failures.append(
            "PR metadata must declare backend_real, frontend_real, and transport_stub "
            f"(missing: {', '.join(missing_flags)}). Declare each at the start of a line "
            "(`flag: value`, optionally as a list item) or in a `| flag | value |` table row; "
            "an inline mention inside a sentence is not a declaration."
        )

    callsite_evidence_required = flags.get("frontend_real") is True
    if changed_paths and ops_changed(changed_paths):
        callsite_evidence_required = True

    if callsite_evidence_required and not CALLSITE_EVIDENCE_RE.search(claim_text):
        failures.append(
            "PR metadata must include action-name→call-site evidence for /ops "
            "(e.g. `set_backup_owner -> app/ops/operator-audit-console.tsx`)."
        )

    if changed_paths and route_or_test_changed(changed_paths) and has_scaffold_only_claim(claim_text):
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

    complete_claim_detected = has_complete_claim(claim_text)

    # A false transport_stub flag is a claim that the filing transport is real. While the markers
    # remain it is not, whether or not the PR also claims COMPLETE.
    if flags.get("transport_stub") is False:
        remaining = transport_stub_files()
        if remaining:
            failures.append(
                "transport_stub=false but filing transport stub markers remain: "
                f"{', '.join(remaining)}."
            )

    if complete_claim_detected and transport_stub_present():
        failures.append(
            "PR claims COMPLETE/product-done while filing transport TODO/stub markers still exist."
        )
    if complete_claim_detected:
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
