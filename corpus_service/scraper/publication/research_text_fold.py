"""Draft-text folding for research term tokenisation (parity with services/d4-2/citationFold.ts).

Research search terms use ``normaliseDraftText`` in TypeScript (NFKD, marks dropped, every Nd digit to
ASCII). Markup stripping is omitted here: judgment titles and citations are plain text at publication time.
"""
from __future__ import annotations

import unicodedata

_BLANKS = frozenset({0x2800, 0x3164, 0x115f, 0x1160, 0xffa0, 0x0009})


def _ascii_digit(cp: int) -> str:
    start = cp
    while start > 0 and unicodedata.category(chr(start - 1)) == "Nd":
        start -= 1
    return str((cp - start) % 10)


def _fold_char(ch: str) -> str | None:
    if ch in "\n\r":
        return "\n" if ch == "\n" else None
    cp = ord(ch)
    if cp < 0x80:
        if cp >= 0x20 and cp != 0x7f:
            return ch
        if cp == 0x09:
            return " "
        return None
    cat = unicodedata.category(ch)
    if cp in _BLANKS or cat.startswith("Z"):
        return " "
    if cat == "Mn" or cat in ("Cf", "Cc"):
        return None
    if cat == "Nd":
        return _ascii_digit(cp) if cp >= 0x80 else ch
    if cp == 0x2212 or cat == "Pd":
        return "-"
    return ch


def normalise_research_draft_text(text: str) -> str:
    """Fold like ``normaliseDraftText`` for token boundaries (digit folding included)."""
    folded = unicodedata.normalize("NFKD", text)
    out: list[str] = []
    for ch in folded:
        if unicodedata.category(ch) == "Mn":
            continue
        step = _fold_char(ch)
        if step is None:
            continue
        out.append(step)
    return "".join(out)
