#!/usr/bin/env python3
"""provider-guard — AI/OCR/STT/TTS SDK imports only under P1 / committeeBrain (full tree).

Known corpus_service violations are allowlisted per file (FA-D3C-002) until remediated.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from g0_guard_common import (
    SOURCE_SUFFIXES,
    is_allowlisted,
    iter_scan_files,
    load_allowlist,
    rel_posix,
)

ALLOWED_PREFIXES = (
    "platform/p1/",
    "platform/committeeBrain/",
    "functions/src/p1/",
)

SDK_NAMES = (
    r"openai|@anthropic-ai/sdk|@google/generative-ai|groq-sdk|elevenlabs|"
    r"@google-cloud/vision|@google-cloud/translate|@google-cloud/speech|"
    r"@ai-sdk/openai|@ai-sdk/anthropic|@ai-sdk/google|deepl-node|"
    r"whisper|@perplexity-ai/sdk|together-ai"
)

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

PKG_DEP_RE = re.compile(
    rf"^({SDK_NAMES})$",
    re.I,
)


def _check_package_json(path: pathlib.Path) -> list[str]:
    rel = rel_posix(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    failed: list[str] = []
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name in data.get(section, {}):
            if PKG_DEP_RE.match(name):
                failed.append(f"{rel}: {section} lists {name}")
    return failed


def _check_requirements_txt(path: pathlib.Path) -> list[str]:
    failed: list[str] = []
    rel = rel_posix(path)
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        token = re.split(r"[<>=!~\s]", stripped, maxsplit=1)[0].lower()
        if token in {"openai", "anthropic", "groq", "elevenlabs", "deepl-node"}:
            failed.append(f"{rel}: requires {token}")
    return failed


def main() -> int:
    allow = load_allowlist()
    failed: list[str] = []

    for p in iter_scan_files():
        rel = rel_posix(p)
        if any(rel.startswith(prefix) for prefix in ALLOWED_PREFIXES):
            continue
        if p.name == "package.json":
            for hit in _check_package_json(p):
                if not is_allowlisted(rel, "fa_d3c_002_provider", allow):
                    failed.append(hit)
            continue
        if p.name == "requirements.txt":
            for hit in _check_requirements_txt(p):
                if not is_allowlisted(rel, "fa_d3c_002_provider", allow):
                    failed.append(hit)
            continue
        if p.suffix not in SOURCE_SUFFIXES:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if PAT.search(text):
            if not is_allowlisted(rel, "fa_d3c_002_provider", allow):
                failed.append(f"{rel}: provider SDK import")

    if failed:
        print("FAIL: provider SDK imported outside P1:")
        for f in sorted(set(failed)):
            print(" ", f)
        return 1
    print("PASS: provider SDK imports confined to P1 (FA-D3C-002 allowlist only in corpus_service)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
