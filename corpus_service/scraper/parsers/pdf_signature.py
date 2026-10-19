"""Audit F28 re-audit (FA-corpus-005): the one rule for "these bytes carry a PDF signature".

Used by the harvesters' pre-extraction check (``scraper.tasks.outcomes.looks_like_pdf``) and by the
extractor's validation (``scraper.parsers.pdf_extractor._validate_pdf_bytes``), so the two cannot
diverge again. Servers prepend a CRLF, a BOM or NUL padding, so the ``%PDF-`` signature may start
after such junk anywhere in the first 1024 bytes, never later, and only after such junk. No third-party imports: the PDF sandbox imports this module too.
"""

from __future__ import annotations

from typing import Optional

PDF_SIGNATURE = b"%PDF-"
SIGNATURE_WINDOW = 1024  # the five signature bytes must lie wholly within bytes 0..1023
_BOM = b"\xef\xbb\xbf"
_PREFIX_JUNK = frozenset(b"\x00\t\n\x0b\x0c\r ")  # NUL padding and ASCII whitespace


def _skip_leading_junk(head: bytes) -> bytes:
    return head.replace(_BOM, b"").lstrip(bytes(_PREFIX_JUNK))


def looks_like_html(data: Optional[bytes]) -> bool:
    """A markup document (an HTML/XML error page, whatever tag or comment it opens with) served
    where a PDF was linked (FA-corpus-007)."""
    return bool(data) and _skip_leading_junk(data[:SIGNATURE_WINDOW]).startswith(b"<")


def has_pdf_signature(data: Optional[bytes]) -> bool:
    """``%PDF-`` within the first 1024 bytes, preceded by nothing but a BOM, whitespace or NUL padding
    (FA-corpus-007): an error page, markup, JSON, text or another format that mentions ``%PDF-`` is
    not a PDF."""
    if not data:
        return False
    at = data.find(PDF_SIGNATURE, 0, SIGNATURE_WINDOW)
    return at >= 0 and not _skip_leading_junk(data[:at])
