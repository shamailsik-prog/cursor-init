#!/usr/bin/env python3
"""pagination-guard — list GET handlers must accept limit and cursor (L18 §4.3)."""
import pathlib, sys

SKIP_PARTS = {"node_modules", ".git", ".next", "ci_gates", "_superseded", "tests", "corpus_service", ".eve"}
failed = []

for p in pathlib.Path(".").rglob("*"):
    if p.suffix not in {".ts", ".tsx", ".js"}:
        continue
    if any(part in SKIP_PARTS for part in p.parts):
        continue
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        continue
    if "export async function GET" not in text and "export function GET" not in text:
        continue
    if "limit" in text and "cursor" in text:
        continue
    failed.append(str(p))

if failed:
    print("FAIL: list GET lacks limit/cursor:")
    for f in failed:
        print(" ", f)
    sys.exit(1)
print("PASS: list handlers paginate (or no GET list handlers)")
sys.exit(0)
