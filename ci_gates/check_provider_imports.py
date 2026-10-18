#!/usr/bin/env python3
"""provider-guard — AI/OCR/STT/TTS SDK imports only under P1 / committeeBrain (full tree).

Scans every file outside the skip rules in g0_guard_common and outside ALLOWED_PREFIXES
(FA-CI-001):
- JS/TS: every module specifier in import, export ... from, import(), require() and
  require.resolve() position, with comments between the tokens and ', " or ` quotes, and calls
  through createRequire aliases; subpaths (`openai/client`) count as the package. Extensionless
  node/bun/deno scripts are read as JS and python scripts as Python (by shebang).
- Python: every import (ast): `import openai`, `from openai import AsyncOpenAI`,
  `from openai.types import X`, `from google.cloud import vision`, importlib.import_module().
- package.json dependency sections; pip requirements files (requirements*.txt/.in,
  requirements/*.txt), pyproject.toml and Pipfile, with PEP 508/503 name normalisation
  (`openai[datalib]`, markers, direct references, `google_generativeai`).

FA-D3C-002 violations are allowlisted per file:symbol in g0_guard_allowlist.json.
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from g0_guard_common import (  # noqa: E402
    GuardFinding,
    ManifestError,
    apply_allowlist,
    file_kind,
    iter_scan_files,
    js_imported_packages,
    load_allowlist,
    load_package_json,
    module_matches,
    python_imported_modules,
    python_manifest_names,
    read_text,
    rel_posix,
)

ALLOWED_PREFIXES = (
    "platform/p1/",
    "platform/committeeBrain/",
    "functions/src/p1/",
)

# npm packages (matched on the package a specifier resolves to).
SDK_PACKAGES = (
    "openai",
    "@anthropic-ai/sdk",
    "@google/generative-ai",
    "@google/genai",
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
SDK_PACKAGE_SET = frozenset(p.lower() for p in SDK_PACKAGES)

# Python modules for the same providers (matched with submodules and versioned siblings).
PY_SDK_MODULES = (
    "openai",
    "anthropic",
    "groq",
    "elevenlabs",
    "google.generativeai",
    "google.genai",
    "google.cloud.vision",
    "google.cloud.translate",
    "google.cloud.speech",
    "deepl",
    "together",
    "whisper",
)

# PyPI distributions (PEP 503-normalised) for the same providers. deepl-node and together-ai
# are the npm names, kept from the original list.
REQ_NAMES = frozenset(
    {
        "openai",
        "anthropic",
        "groq",
        "elevenlabs",
        "google-generativeai",
        "google-genai",
        "google-cloud-vision",
        "google-cloud-translate",
        "google-cloud-speech",
        "deepl",
        "deepl-node",
        "together",
        "together-ai",
        "openai-whisper",
    }
)

BUCKET = "fa_d3c_002_provider"


def _check_package_json(rel: str, text: str) -> list[GuardFinding]:
    data = load_package_json(text)
    out: list[GuardFinding] = []
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name in data.get(section) or {}:
            if name.lower() in SDK_PACKAGE_SET:
                out.append(GuardFinding(rel, name.lower(), f"{rel}: {section} lists {name}"))
    return out


def _check_python_manifest(rel: str, kind: str, text: str) -> list[GuardFinding]:
    return [
        GuardFinding(rel, name, f"{rel}: requires {name}")
        for name in python_manifest_names(kind, text)
        if name in REQ_NAMES
    ]


def _source_symbols(kind: str, text: str) -> set[str]:
    if kind == "js":
        return {root for root in js_imported_packages(text) if root in SDK_PACKAGE_SET}
    symbols: set[str] = set()
    for module in python_imported_modules(text):
        for banned in PY_SDK_MODULES:
            if module_matches(module, banned):
                symbols.add(banned)
    return symbols


def findings_for(p: pathlib.Path) -> list[GuardFinding]:
    rel = rel_posix(p)
    if rel.startswith(ALLOWED_PREFIXES):
        return []
    kind = file_kind(p)
    if kind not in {"package_json", "requirements", "pyproject", "pipfile", "js", "py"}:
        return []
    text = read_text(p)
    if text is None:
        return []
    try:
        if kind == "package_json":
            return _check_package_json(rel, text)
        if kind in {"requirements", "pyproject", "pipfile"}:
            return _check_python_manifest(rel, kind, text)
    except ManifestError as err:
        return [GuardFinding(rel, "unreadable_manifest", f"{rel}: cannot read manifest ({err})")]
    return [
        GuardFinding(rel, sym, f"{rel}: provider SDK ({sym})")
        for sym in sorted(_source_symbols(kind, text))
    ]


def collect_findings() -> list[GuardFinding]:
    findings: list[GuardFinding] = []
    for p in iter_scan_files():
        findings.extend(findings_for(p))
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
