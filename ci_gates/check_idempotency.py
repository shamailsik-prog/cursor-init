#!/usr/bin/env python3
"""idempotency-guard — every POST/PUT/PATCH handler requires Idempotency-Key."""
import pathlib, sys

SKIP_PARTS = {"node_modules", ".git", ".next", "ci_gates", "_superseded"}
METHODS = ("POST", "PUT", "PATCH")
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
    for method in METHODS:
        if f"export async function {method}" in text or f"export function {method}" in text:
            if (
                "Idempotency-Key" not in text
                and "requireIdempotencyKey" not in text
                and "withIdempotency" not in text
            ):
                failed.append(f"{p}: {method} without Idempotency-Key")

if failed:
    print("FAIL: POST/PUT without idempotency:")
    for f in failed:
        print(" ", f)
    sys.exit(1)
print("PASS: POST/PUT handlers require Idempotency-Key")
sys.exit(0)
