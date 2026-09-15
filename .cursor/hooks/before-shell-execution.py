#!/usr/bin/env python3
"""Deny Playwright/Puppeteer, court-fee scripts, and off-P1 provider SDK installs.

SIKANDER AI — Gate G-0 non-negotiables (Erratum Set No. 1 > Layer 18 > Layer 17).
Reads hook JSON on stdin; prints permission JSON on stdout. Exit 0.
"""
from __future__ import annotations

import json
import re
import sys

FEE_IDENTIFIERS = (
    "calculateCourtFee",
    "getFeeRule",
    "insertFeeMemo",
    "courtFeeBasis",
)

# Same families as ci_gates/gate_g0.sh [3]. Install names plus Python import pkgs.
PROVIDER_PACKAGES = (
    "openai",
    "@anthropic-ai/sdk",
    "anthropic",
    "@google/generative-ai",
    "google-generativeai",
    "groq-sdk",
    "groq",
    "elevenlabs",
    "@google-cloud/vision",
    "@google-cloud/translate",
    "@google-cloud/speech",
    "@ai-sdk/openai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "deepl-node",
    "openai-whisper",
    "whisper",
    "@perplexity-ai/sdk",
    "together-ai",
    "together",
)

SCRAPER_PACKAGES = (
    "playwright",
    "@playwright/test",
    "puppeteer",
    "puppeteer-core",
)

P1_PATH_RE = re.compile(r"(?:^|/)platform/(?:p1|committeeBrain)(?:/|$)", re.I)

INSTALL_RE = re.compile(
    r"""(?ix)
    (?:
        \b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|dlx)\b
      | \bnpx\s+(?:--yes\s+|-y\s+)?
      | \b(?:pip3?|pipx)\s+install\b
      | \buv\s+(?:add|pip\s+install)\b
      | \bpoetry\s+add\b
    )
    """
)

# Read-only / audit commands that may mention banned strings without implementing them.
SEARCH_RE = re.compile(
    r"""(?ix)
    ^\s*(?:sudo\s+)?(?:
        git\b
      | grep\b
      | egrep\b
      | fgrep\b
      | rg\b
      | ripgrep\b
      | ag\b
    )
    """
)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")


def deny(agent: str, user: str | None = None) -> None:
    emit(
        {
            "permission": "deny",
            "agent_message": agent,
            "user_message": user or agent,
        }
    )


def ask(agent: str, user: str | None = None) -> None:
    emit(
        {
            "permission": "ask",
            "agent_message": agent,
            "user_message": user or agent,
        }
    )


def allow() -> None:
    emit({"permission": "allow"})


def read_input() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    data = json.loads(raw)
    return data if isinstance(data, dict) else {}


def command_of(data: dict) -> str:
    for key in ("command", "shell_command", "cmd"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def cwd_of(data: dict) -> str:
    value = data.get("cwd") or data.get("working_directory") or ""
    return value if isinstance(value, str) else ""


def is_search_or_gate(command: str) -> bool:
    if SEARCH_RE.search(command):
        return True
    if "ci_gates/" in command:
        return True
    if ".cursor/hooks/" in command:
        return True
    return False


def in_p1(command: str, cwd: str) -> bool:
    return bool(P1_PATH_RE.search(cwd) or P1_PATH_RE.search(command))


def _pkg_token_re(packages: tuple[str, ...]) -> re.Pattern[str]:
    parts = [re.escape(p) for p in sorted(packages, key=len, reverse=True)]
    return re.compile(r"(?<![A-Za-z0-9._/-])(?:" + "|".join(parts) + r")(?![A-Za-z0-9._/-])")


SCRAPER_TOKEN_RE = _pkg_token_re(SCRAPER_PACKAGES)
PROVIDER_TOKEN_RE = _pkg_token_re(PROVIDER_PACKAGES)
FEE_RE = re.compile("|".join(re.escape(s) for s in FEE_IDENTIFIERS))
PLAYWRIGHT_BIN_RE = re.compile(
    r"(?i)\b(?:npx\s+(?:--yes\s+|-y\s+)?)?(?:playwright|puppeteer)\s+(?:install|codegen|test|cr|screenshot)\b"
)


def scraper_install(command: str) -> bool:
    if PLAYWRIGHT_BIN_RE.search(command):
        return True
    if INSTALL_RE.search(command) and SCRAPER_TOKEN_RE.search(command):
        return True
    return False


def provider_install(command: str) -> bool:
    return bool(INSTALL_RE.search(command) and PROVIDER_TOKEN_RE.search(command))


def main() -> int:
    try:
        data = read_input()
    except json.JSONDecodeError:
        deny(
            "beforeShellExecution hook received invalid JSON; fail-closed deny.",
            "A project hook could not parse the shell-command payload, so the command was blocked.",
        )
        return 0

    command = command_of(data)
    cwd = cwd_of(data)
    if not command.strip():
        allow()
        return 0

    if scraper_install(command):
        deny(
            "Blocked: Playwright/Puppeteer is banned in this app repo (N1 / L17.12 / G-0 scraper-guard). "
            "Corpus harvest is a separate repository. Do not install or run Playwright or Puppeteer here.",
            "This command would install or run Playwright/Puppeteer, which SIKANDER AI forbids in this repository.",
        )
        return 0

    if FEE_RE.search(command) and not is_search_or_gate(command):
        deny(
            "Blocked: court-fee identifiers (calculateCourtFee, getFeeRule, insertFeeMemo, courtFeeBasis) "
            "are forbidden (E-15). Court fee and stamp duty are MANUAL checklist items only. "
            "Do not invent fee schedules.",
            "This command references banned court-fee identifiers. Court fee and stamp duty stay MANUAL.",
        )
        return 0

    if provider_install(command) and not in_p1(command, cwd):
        ask(
            "Provider AI/OCR/STT/TTS SDKs may only be imported under platform/p1 or platform/committeeBrain "
            "(G-0 provider-guard). Installing at the repo root still requires every import to stay in those "
            "directories. Confirm this install is for P1 Committee Brain only. Do not invent DPA entries.",
            "This installs an AI/OCR/STT/TTS provider SDK. SIKANDER AI allows those only via P1 Committee Brain. Review before continuing.",
        )
        return 0

    allow()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # fail-closed
        deny(
            f"beforeShellExecution hook error; fail-closed deny: {exc}",
            "A project hook failed while reviewing this command, so it was blocked.",
        )
        sys.exit(0)
