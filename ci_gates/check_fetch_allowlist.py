#!/usr/bin/env python3
"""scraper-guard extra: HTTP fetch to a host outside the L4.9 legislation allowlist.
Playwright/Puppeteer remains in gate_g0.sh. P1 provider egress is excluded (not a scraper).
"""
import json, re, pathlib, sys
from urllib.parse import urlparse

allow = json.loads(pathlib.Path("data/l49_allowlist.json").read_text())
allowed = {h.lower() for h in allow.get("hosts", [])}
allowed |= {"localhost", "127.0.0.1"}

SKIP_PARTS = {"node_modules", ".git", ".next", "ci_gates", "_superseded", "tests"}
P1_PREFIXES = ("platform/p1/", "platform/committeeBrain/")
FETCH = re.compile(
    r"""(?:fetch|axios\.(?:get|post|put|patch|delete)|got(?:\.get)?)\s*\(\s*(['"`])(https?://[^'"`]+)\1""",
    re.I,
)


def host_of(url: str) -> str:
    parsed = urlparse(url)
    return (parsed.hostname or "").lower()


def _selftest() -> None:
    assert host_of("https://pakistancode.gov.pk/act") == "pakistancode.gov.pk"
    assert host_of("http://127.0.0.1:8080/x") == "127.0.0.1"
    assert host_of("https://example.com/path") != "https"
    assert host_of("http://localhost/foo") == "localhost"


_selftest()

failed = []
for p in pathlib.Path(".").rglob("*"):
    if p.suffix not in {".ts", ".tsx", ".js", ".py"}:
        continue
    if any(part in SKIP_PARTS for part in p.parts):
        continue
    rel = str(p).replace("\\", "/")
    if any(rel.startswith(a) for a in P1_PREFIXES):
        continue
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        continue
    for m in FETCH.finditer(text):
        url = m.group(2)
        host = host_of(url)
        if not host or host not in allowed:
            failed.append(f"{rel}: fetch to {host or url} (not on L4.9 allowlist)")

if failed:
    print("FAIL: non-allowlist fetch:")
    for f in failed:
        print(" ", f)
    sys.exit(1)
print("PASS: no non-allowlist fetch outside P1")
sys.exit(0)
