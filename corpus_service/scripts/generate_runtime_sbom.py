#!/usr/bin/env python3
"""Refresh corpus_service/runtime-sbom.json from the locked requirements.txt (audit F46)."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "runtime-images.lock.json"
REQ = ROOT / "requirements.txt"
OUT = ROOT / "runtime-sbom.json"

TRACK = {
    "parsers_and_media": (
        "pdfplumber",
        "pdfminer.six",
        "pillow",
        "pytesseract",
        "lxml",
        "weasyprint",
        "reportlab",
    ),
    "data_stack": ("sqlalchemy", "asyncpg", "pgvector", "celery", "redis"),
}


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def pinned_versions(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]+\])?==([^\\\s#]+)", line)
        if m:
            out[_normalize(m.group(1))] = m.group(2)
    return out


def main() -> None:
    pins = pinned_versions(REQ.read_text(encoding="utf-8"))
    images = json.loads(LOCK.read_text(encoding="utf-8"))
    py_ref = images["images"]["python_base"]
    doc = {
        "version": 1,
        "scope": "corpus_service production runtime (requirements.txt)",
        "python": "3.12",
        "base_image": f"{py_ref['reference']}@{py_ref['digest']}",
        "parsers_and_media": {k: pins[_normalize(k)] for k in TRACK["parsers_and_media"]},
        "data_stack": {k: pins[_normalize(k)] for k in TRACK["data_stack"]},
        "refresh": "corpus_service/scripts/compile_requirements.sh regenerates requirements.txt, "
        "runtime-sbom.json, and re-verify image digests in runtime-images.lock.json",
    }
    OUT.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
