#!/usr/bin/env python3
"""provider-guard — AI/OCR/STT/TTS SDK imports only under P1 / committeeBrain (full tree).

FA-D3C-002 violations are allowlisted per file:symbol in g0_guard_allowlist.json.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from g0_guard_common import (
    GuardFinding,
    SOURCE_SUFFIXES,
    apply_allowlist,
    iter_scan_files,
    load_allowlist,
    rel_posix,
)

ALLOWED_PREFIXES = (
    "platform/p1/",
    "platform/committeeBrain/",
    "functions/src/p1/",
)

SDK_PACKAGES = (
    "openai",
    "@anthropic-ai/sdk",
    "@google/generative-ai",
    "groq-sdk",
    "elevenlabs",
    "@google-cloud/vision",
    "@google-cloud/translate",
    "@google-cloud/speech",
    "@ai-sdk/openai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "deepl-node",
    "whisper",
    "@perplexity-ai/sdk",
    "together-ai",
)

SDK_NAMES = "|".join(re.escape(p) for p in SDK_PACKAGES)

PAT = re.compile(
    rf"""
    from\s+['"]({SDK_NAMES})['"]|
    export\s+[^;\n]*\s+from\s+['"]({SDK_NAMES})['"]|
    import\s+(openai|anthropic|google\.generativeai|groq|elevenlabs)\b|
    require\s*\(\s*['"]({SDK_NAMES})['"]\s*\)|
    (?:await\s+)?import\s*\(\s*['"]({SDK_NAMES})['"]\s*\)
    """,
    re.I | re.VERBOSE,
)

PKG_DEP_RE = re.compile(rf"^({SDK_NAMES})$", re.I)

REQ_TOKENS = {
    "openai",
    "anthropic",
    "groq",
    "elevenlabs",
    "deepl-node",
    "together-ai",
}

BUCKET = "fa_d3c_002_provider"


def _normalize_module_symbol(raw: str) -> str:
    low = raw.lower()
    if low in {"openai", "anthropic", "groq", "elevenlabs"}:
        return low
    return raw.lower()


def _symbols_in_source(text: str) -> set[str]:
    symbols: set[str] = set()
    for m in PAT.finditer(text):
        for g in m.groups():
            if g:
                symbols.add(_normalize_module_symbol(g))
    return symbols


def _check_package_json(path: pathlib.Path) -> list[GuardFinding]:
    rel = rel_posix(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    out: list[GuardFinding] = []
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name in data.get(section, {}):
            if PKG_DEP_RE.match(name):
                sym = name.lower()
                out.append(GuardFinding(rel, sym, f"{rel}: {section} lists {name}"))
    return out


def _check_requirements_txt(path: pathlib.Path) -> list[GuardFinding]:
    rel = rel_posix(path)
    out: list[GuardFinding] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        token = re.split(r"[<>=!~\s]", stripped, maxsplit=1)[0].lower()
        if token in REQ_TOKENS:
            out.append(GuardFinding(rel, token, f"{rel}: requires {token}"))
    return out


def collect_findings() -> list[GuardFinding]:
    findings: list[GuardFinding] = []
    for p in iter_scan_files():
        rel = rel_posix(p)
        if any(rel.startswith(prefix) for prefix in ALLOWED_PREFIXES):
            continue
        if p.name == "package.json":
            findings.extend(_check_package_json(p))
            continue
        if p.name == "requirements.txt":
            findings.extend(_check_requirements_txt(p))
            continue
        if p.suffix not in SOURCE_SUFFIXES:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for sym in _symbols_in_source(text):
            findings.append(GuardFinding(rel, sym, f"{rel}: provider SDK ({sym})"))
    return findings


def main() -> int:
    allow = load_allowlist()[BUCKET]
    findings = collect_findings()
    failures, stale = apply_allowlist(findings, allow)
    if stale:
        failures.extend([f"stale allowlist entry (no matching finding): {key}" for key in stale])
    if failures:
        print("FAIL: provider SDK imported outside P1:")
        for f in sorted(set(failures)):
            print(" ", f)
        return 1
    print("PASS: provider SDK imports confined to P1; FA-D3C-002 allowlist entries verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
