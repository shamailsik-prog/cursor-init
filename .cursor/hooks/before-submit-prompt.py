#!/usr/bin/env python3
"""Lightweight prompt reminder for SIKANDER AI non-negotiables.

Never blocks a user prompt. Injects additional_context only when the prompt
mentions court-fee work, scrapers, or provider SDKs. Exit 0. Fail open.
"""
from __future__ import annotations

import json
import re
import sys

FEE_RE = re.compile(
    r"calculateCourtFee|getFeeRule|insertFeeMemo|courtFeeBasis|"
    r"court\s*fees?|stamp\s*duty",
    re.I,
)
SCRAPER_RE = re.compile(r"playwright|puppeteer", re.I)
PROVIDER_RE = re.compile(
    r"\b(?:openai|anthropic|@ai-sdk|elevenlabs|groq|whisper|deepl|"
    r"generative-ai|together-ai|perplexity)\b",
    re.I,
)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")


def prompt_of(data: dict) -> str:
    for key in ("prompt", "content", "text", "user_prompt"):
        value = data.get(key)
        if isinstance(value, str):
            return value
    return ""


def main() -> int:
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        if not isinstance(data, dict):
            data = {}
    except json.JSONDecodeError:
        emit({"continue": True})
        return 0

    prompt = prompt_of(data)
    notes: list[str] = []
    if FEE_RE.search(prompt):
        notes.append(
            "Court fee and stamp duty are MANUAL only (E-15). Do not add calculateCourtFee, "
            "getFeeRule, insertFeeMemo, courtFeeBasis, or any fee schedule."
        )
    if SCRAPER_RE.search(prompt):
        notes.append(
            "Playwright/Puppeteer is banned in this app repo (G-0 scraper-guard). "
            "Corpus harvest is a separate repository."
        )
    if PROVIDER_RE.search(prompt):
        notes.append(
            "AI/OCR/STT/TTS SDKs may be imported only under platform/p1 or platform/committeeBrain. "
            "Do not invent DPA entries or live credentials."
        )

    if not notes:
        emit({"continue": True})
        return 0

    context = (
        "SIKANDER AI non-negotiables (Erratum Set No. 1 > Layer 18 > Layer 17): "
        + " ".join(notes)
    )
    emit({"continue": True, "additional_context": context})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.stderr.write(f"beforeSubmitPrompt hook error (fail open): {exc}\n")
        emit({"continue": True})
        sys.exit(0)
