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
PAT = re.compile(
    r"applyChange\s*\("
    r"|INSERT\s+INTO\s+(master_|templates\b)"
    r"|collection\(\s*['\"]master_versions['\"]"
    r"|match\s+/master_versions/",
    re.I,
)

# firestore.rules is a deny-write policy, not a writer.
SKIP_FILES = {"firestore.rules"}

failed = []
for p in pathlib.Path(".").rglob("*"):
    if p.suffix not in {".ts", ".tsx", ".js", ".py", ".sql"}:
        continue
    if any(part in SKIP_PARTS for part in p.parts):
        continue
    rel = str(p).replace("\\", "/")
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

if failed:
    print("FAIL: master write outside P6:")
    for f in failed:
        print(" ", f)
    sys.exit(1)
print("PASS: no master writes outside P6")
sys.exit(0)
