#!/usr/bin/env python3
"""scraper-guard extra: HTTP fetch to a host outside the L4.9 legislation allowlist.
Playwright/Puppeteer remains in gate_g0.sh. P1 provider egress is excluded (not a scraper).
"""
import json, re, pathlib, sys
from urllib.parse import urlsplit

allow = json.loads(pathlib.Path("data/l49_allowlist.json").read_text())
allowed = {h.lower() for h in allow.get("hosts", [])}
allowed |= {"localhost", "127.0.0.1"}

# corpus_service is the separate harvest tree (FINAL_2 / L17.12). Not scanned.
SKIP_PARTS = {"node_modules", ".git", ".next", "ci_gates", "_superseded", "tests", "corpus_service", ".eve"}
P1_PREFIXES = ("platform/p1/", "platform/committeeBrain/")
# Cloud Functions tests talk only to the local Firebase emulators (FIREBASE_*_EMULATOR_HOST); like tests/, not a scraper.
TEST_PREFIXES = ("functions/test/",)
FETCH = re.compile(
    r"""(?:fetch|axios\.(?:get|post|put|patch|delete)|got(?:\.get)?)\s*\(\s*(['"`])(https?://[^'"`]+)\1""",
    re.I,
)

failed = []
for p in pathlib.Path(".").rglob("*"):
    if p.suffix not in {".ts", ".tsx", ".js", ".py"}:
        continue
    if any(part in SKIP_PARTS for part in p.parts):
        continue
    rel = str(p).replace("\\", "/")
    if any(rel.startswith(a) for a in P1_PREFIXES + TEST_PREFIXES):
        continue
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        continue
    for m in FETCH.finditer(text):
        url = m.group(2)
        host = (urlsplit(url).hostname or "").lower()
        if host not in allowed:
            failed.append(f"{rel}: fetch to {host} (not on L4.9 allowlist)")

if failed:
    print("FAIL: non-allowlist fetch:")
    for f in failed:
        print(" ", f)
    sys.exit(1)
print("PASS: no non-allowlist fetch outside P1")
sys.exit(0)
