#!/usr/bin/env python3
"""provider-guard — AI/OCR/STT/TTS SDK imports only under P1 / committeeBrain (full tree)."""
from __future__ import annotations

import pathlib
import re
import sys

SKIP_PARTS = {
    "node_modules",
    ".git",
    ".next",
    "ci_gates",
    "_superseded",
    "corpus_service",
    ".eve",
    "tests",
}
ALLOWED_PREFIXES = (
    "platform/p1/",
    "platform/committeeBrain/",
    "functions/src/p1/",
)

PAT = re.compile(
    r"""from\s+['"](openai|@anthropic-ai/sdk|@google/generative-ai|groq-sdk|elevenlabs|
        @google-cloud/vision|@google-cloud/translate|@google-cloud/speech|
        @ai-sdk/openai|@ai-sdk/anthropic|@ai-sdk/google|deepl-node)['"]|
        import\s+(openai|anthropic|google\.generativeai|groq|elevenlabs)\b|
        from\s+['"](whisper|@perplexity-ai/sdk|together-ai)['"]""",
    re.I | re.VERBOSE,
)


def main() -> int:
    failed: list[str] = []
    for p in pathlib.Path(".").rglob("*"):
        if p.suffix not in {".ts", ".tsx", ".js", ".py"}:
            continue
        if any(part in SKIP_PARTS for part in p.parts):
            continue
        rel = str(p).replace("\\", "/")
        if any(rel.startswith(prefix) for prefix in ALLOWED_PREFIXES):
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if PAT.search(text):
            failed.append(rel)

    if failed:
        print("FAIL: provider SDK imported outside P1:")
        for f in sorted(set(failed)):
            print(" ", f)
        return 1
    print("PASS: provider SDK imports confined to P1")
    return 0


if __name__ == "__main__":
    sys.exit(main())
