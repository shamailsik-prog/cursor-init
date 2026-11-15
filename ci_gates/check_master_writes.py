#!/usr/bin/env python3
"""master-write-guard — only P6 may write master tables / master_versions."""
import re, pathlib, sys

ALLOWED_PREFIXES = (
    "platform/p6/",
    "ci_gates/",
    "postgres/ddl/",
    "tests/",
)
SKIP_PARTS = {"node_modules", ".git", ".next", "_superseded", "corpus_service", ".eve"}
# INSERT/UPDATE/DELETE/TRUNCATE of master_* or change_proposals, schema-qualified or quoted.
REL = r'(?:(?:"?public"?\s*\.\s*)?"?(?:master_[a-z0-9_]+|change_proposals)"?)'
PAT = re.compile(
    r"applyChange\s*\("
    r"|INSERT\s+INTO\s+(?:master_|templates\b|change_proposals\b)"
    r"|UPDATE\s+(?:ONLY\s+)?" + REL + r"\b"
    r"|DELETE\s+FROM\s+(?:ONLY\s+)?" + REL + r"\b"
    r"|TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?" + REL + r"\b"
    r"|collection\(\s*['\"]master_versions['\"]"
    r"|match\s+/master_versions/",
    re.I,
)

# firestore.rules is a deny-write policy, not a writer.
SKIP_FILES = {"firestore.rules"}


def scan(root: pathlib.Path | None = None) -> list[str]:
    base = root or pathlib.Path(".")
    failed: list[str] = []
    for p in base.rglob("*"):
        if p.suffix not in {".ts", ".tsx", ".js", ".py", ".sql"}:
            continue
        rel = p.relative_to(base).as_posix()
        if any(part in SKIP_PARTS for part in rel.split("/")):
            continue
        if any(rel.startswith(a) for a in ALLOWED_PREFIXES):
            continue
        if p.name in SKIP_FILES:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if PAT.search(text):
            failed.append(rel)
    return failed


def main() -> int:
    failed = scan()
    if failed:
        print("FAIL: master write outside P6:")
        for f in failed:
            print(" ", f)
        return 1
    print("PASS: no master writes outside P6")
    return 0


if __name__ == "__main__":
    sys.exit(main())
