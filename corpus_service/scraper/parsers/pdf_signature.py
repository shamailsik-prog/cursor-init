"""Audit F28 re-audit (FA-corpus-005): the one rule for "these bytes carry a PDF signature".

Used by the harvesters' pre-extraction check (``scraper.tasks.outcomes.looks_like_pdf``) and by the
extractor's validation (``scraper.parsers.pdf_extractor._validate_pdf_bytes``), so the two cannot
diverge again. The PDF spec allows bytes before the header (a CRLF, a BOM, junk), so the ``%PDF-``
signature may sit anywhere in the first 1024 bytes, never later. An HTML page is never a PDF, even
when it mentions ``%PDF-``. No third-party imports: the PDF sandbox imports this module too.
"""

from __future__ import annotations

from typing import Optional

PDF_SIGNATURE = b"%PDF-"
SIGNATURE_WINDOW = 1024
_HTML_PREFIXES = (b"<!doc", b"<html")
_LEADING_JUNK = b"\xef\xbb\xbf \t\r\n\x0c\x00"


def looks_like_html(data: Optional[bytes]) -> bool:
    """An HTML document (an error page served where a PDF was linked)."""
    return bool(data) and data[:SIGNATURE_WINDOW].lstrip(_LEADING_JUNK).lower().startswith(_HTML_PREFIXES)


def has_pdf_signature(data: Optional[bytes]) -> bool:
    """``%PDF-`` within the first 1024 bytes, and not an HTML page."""
    return bool(data) and PDF_SIGNATURE in data[:SIGNATURE_WINDOW] and not looks_like_html(data)
