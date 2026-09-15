#!/usr/bin/env python3
"""Audit edits for banned court-fee identifiers and off-P1 provider SDK imports.

SIKANDER AI — Gate G-0 non-negotiables (Erratum Set No. 1 > Layer 18 > Layer 17).
Warns via additional_context. Does not block (fail open). Exit 0.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

FEE_IDENTIFIERS = (
    "calculateCourtFee",
    "getFeeRule",
    "insertFeeMemo",
    "courtFeeBasis",
)

PROVIDER_IMPORT_RE = re.compile(
    r"""(?x)
    (?:
        from\s+['"](?:openai|@anthropic-ai/sdk|@google/generative-ai|groq-sdk|elevenlabs
            |@google-cloud/vision|@google-cloud/translate|@google-cloud/speech
            |@ai-sdk/openai|@ai-sdk/anthropic|@ai-sdk/google|deepl-node
            |whisper|@perplexity-ai/sdk|together-ai)['"]
      | import\s+(?:openai|anthropic|google\.generativeai|groq|elevenlabs)\b
      | from\s+(?:openai|anthropic|groq|elevenlabs|google\.generativeai)\s+import
      | require\(\s*['"](?:openai|@anthropic-ai/sdk|@google/generative-ai|groq-sdk
            |elevenlabs|@google-cloud/vision|@google-cloud/translate|@google-cloud/speech
            |@ai-sdk/openai|@ai-sdk/anthropic|@ai-sdk/google|deepl-node
            |whisper|@perplexity-ai/sdk|together-ai)['"]
    )
    """,
    re.I,
)

SCRAPER_RE = re.compile(r"(?i)\b(?:playwright|puppeteer(?:-core)?|@playwright/test)\b")
FEE_RE = re.compile("|".join(re.escape(s) for s in FEE_IDENTIFIERS))
P1_PATH_RE = re.compile(r"(?:^|/)platform/(?:p1|committeeBrain)(?:/|$)")

SKIP_PREFIXES = (
    ".cursor/",
    "ci_gates/",
    "node_modules/",
    ".git/",
)
SKIP_FILES = {
    "correction_log.md",
    "cursor_start_prompt.md",
}


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")


def read_input() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    data = json.loads(raw)
    return data if isinstance(data, dict) else {}


def file_path_of(data: dict) -> str:
    for key in ("file_path", "filePath", "path"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.replace("\\", "/")
    return ""


def edited_text(data: dict) -> str:
    chunks: list[str] = []
    edits = data.get("edits")
    if isinstance(edits, list):
        for edit in edits:
            if not isinstance(edit, dict):
                continue
            for key in ("new_string", "newString", "to", "content"):
                value = edit.get(key)
                if isinstance(value, str):
                    chunks.append(value)
    for key in ("new_string", "newString", "content", "contents", "text"):
        value = data.get(key)
        if isinstance(value, str):
            chunks.append(value)
    return "\n".join(chunks)


def rel_path(file_path: str) -> str:
    path = file_path.strip()
    if not path:
        return ""
    try:
        resolved = Path(path)
        if resolved.is_absolute():
            try:
                path = str(resolved.resolve().relative_to(Path.cwd().resolve()))
            except ValueError:
                path = resolved.as_posix()
        return path.replace("\\", "/")
    except (OSError, RuntimeError):
        return file_path.replace("\\", "/")


def should_skip(path: str) -> bool:
    lowered = path.lstrip("./").lower()
    if lowered in SKIP_FILES:
        return True
    for prefix in SKIP_PREFIXES:
        if lowered.startswith(prefix):
            return True
    return False


def in_p1(path: str) -> bool:
    return bool(P1_PATH_RE.search(path.replace("\\", "/")))


def findings(path: str, text: str) -> list[str]:
    notes: list[str] = []
    if not text:
        return notes

    hits = sorted(set(FEE_RE.findall(text)))
    if hits:
        notes.append(
            "Fee-guard (E-15): this edit introduces banned court-fee identifiers "
            + ", ".join(hits)
            + ". Court fee and stamp duty are MANUAL checklist items only. "
            "Do not compute them and do not invent fee schedules. Remove the identifiers."
        )

    if not in_p1(path) and PROVIDER_IMPORT_RE.search(text):
        notes.append(
            "Provider-guard (G-0): AI/OCR/STT/TTS SDK imports are allowed only under "
            "platform/p1 or platform/committeeBrain. Move this import into P1 Committee Brain "
            "or remove it. Do not invent DPA, residency, or provider credentials."
        )

    if SCRAPER_RE.search(text):
        notes.append(
            "Scraper-guard (N1 / L17.12): Playwright/Puppeteer is forbidden in this app repository "
            "(no P1 exemption). Corpus harvest is a separate repo. Remove the scraper dependency or import."
        )

    return notes


def main() -> int:
    try:
        data = read_input()
    except json.JSONDecodeError:
        emit({})
        return 0

    path = rel_path(file_path_of(data))
    if should_skip(path):
        emit({})
        return 0

    notes = findings(path, edited_text(data))
    if not notes:
        emit({})
        return 0

    header = (
        "SIKANDER AI hook (afterFileEdit) — precedence: Erratum Set No. 1 > Layer 18 > Layer 17. "
        f"File: {path or '(unknown)'}."
    )
    context = header + " " + " ".join(notes)
    sys.stderr.write(context + "\n")
    emit({"additional_context": context})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.stderr.write(f"afterFileEdit hook error (fail open): {exc}\n")
        emit({})
        sys.exit(0)
