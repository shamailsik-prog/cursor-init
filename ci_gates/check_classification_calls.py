#!/usr/bin/env python3
"""classification-guard — P1 calls and artefact writes must carry classification."""
import re, pathlib, sys

SKIP_PARTS = {"node_modules", ".git", ".next", "ci_gates", "_superseded", "platform/p1", "tests", "corpus_service", ".eve"}
CALL = re.compile(r"callCommitteeBrain\s*\(")
failed = []

for p in pathlib.Path(".").rglob("*"):
    if p.suffix not in {".ts", ".tsx", ".js", ".py"}:
        continue
    if any(part in SKIP_PARTS for part in p.parts):
        continue
    rel = str(p).replace("\\", "/")
    if rel.startswith("platform/p1/"):
        continue
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        continue
    for m in CALL.finditer(text):
        window = text[m.start() : m.start() + 400]
        if "classification" not in window:
            failed.append(f"{rel}: callCommitteeBrain omitted classification")

if failed:
    print("FAIL: classification omitted:")
    for f in failed:
        print(" ", f)
    sys.exit(1)
print("PASS: P1 calls carry classification")
sys.exit(0)
