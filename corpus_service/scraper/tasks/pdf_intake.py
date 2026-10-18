"""Audit F26: the one path from a PDF link to its text, for every PDF harvester.

Spec: docs/superpowers/specs/2026-10-18-f26-bounded-isolated-pdf-processing-design.md (rulings R1-R5,
R10, R11).

``intake(client, url)`` is what the court harvesters (SHC, SC, LHC, PHC, BHC, IHC) and National
Assembly call for each PDF, with the ``PolicyFetcher`` they already hold:

1. size (R2): the client's body cap is narrowed to the operator's ``PDF_MAX_SIZE_MB`` (never above
   F25's cap), so the fetch boundary refuses an oversized body while it reads: ``pdf_too_large``;
2. cheap checks (R3): HTTP 200 (else ``http_<status>``, F28's key), one declared Content-Type (F26-FU,
   R21) that is not a non-PDF family and the ``%PDF-`` signature (else ``not_pdf``);
3. keep (R5): the bytes go to the raw store by sha256 before any parsing (``raw_store_full`` /
   ``raw_store_failed`` when they cannot), in a thread;
4. parse (R6-R8): ``pdf_sandbox.parse`` in a separate, limited process, awaited in a thread so the
   event loop keeps running; its refusals keep their codes; no text at all is ``empty_pdf_text``.

Every refusal is ``outcomes.DocumentRejected(code)``: the harvester counts it as a failed document
in F28's tally (never progress), and the run goes on with the next PDF (R10, R11). ``pdf_sandbox.parse``
is looked up at call time, the seam the F20 and F28 harnesses replace (R12).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional

from scraper import config
from scraper.net import fetch_policy
from scraper.parsers import pdf_sandbox, raw_store
from scraper.tasks import outcomes

logger = logging.getLogger(__name__)

# Declared types that cannot be a PDF (R3). A denylist: servers label PDFs octet-stream, x-download,
# even text/plain; the signature and the sandbox are the controls, the header only catches pages.
_NOT_PDF_PREFIXES = ("text/html", "image/", "audio/", "video/", "font/", "multipart/")
_NOT_PDF_MARKERS = ("xml", "json", "javascript")

Fetch = Callable[[Any, str], Awaitable[Any]]


@dataclass(frozen=True)
class PdfDocument:
    """A PDF that was fetched within its cap, kept, and parsed in the sandbox."""

    text: str
    pages: int
    ocr_applied: bool
    ocr_truncated: bool
    sha256: str
    raw_key: str  # raw store key, relative to PDF_STORAGE_PATH (staging raw_pdf_path)

    def metadata(self) -> Dict[str, Any]:
        """What a staging row's parsing_metadata records about the document."""
        extra: Dict[str, Any] = {"raw_sha256": self.sha256}
        if self.ocr_truncated:
            extra["ocr_truncated"] = True
        return extra


def cap_bytes() -> int:
    """The PDF size cap: the operator's PDF_MAX_SIZE_MB, never above the fetch boundary's own."""
    return min(int(config.settings.PDF_MAX_SIZE_MB) * 1024 * 1024, fetch_policy.MAX_BYTES)


def declared_type(headers: Optional[Mapping[str, str]]) -> str:
    for name, value in (headers or {}).items():
        if str(name).lower() == "content-type":
            return str(value).split(";", 1)[0].strip().lower()
    return ""


def declared_types(headers: Any) -> list:
    """Every Content-Type field's value (F26-FU, R21): ``get_list`` on the boundary's httpx.Headers
    (its ``items()`` would join repeated fields with a comma), every matching key of a mapping."""
    if headers is None:
        return []
    if hasattr(headers, "get_list"):
        return [str(v) for v in headers.get_list("content-type")]
    return [str(v) for k, v in headers.items() if str(k).lower() == "content-type"]


def repeated_type(values: list) -> bool:
    """More than one Content-Type field, or one whose media type (before any ``;`` parameter) is a
    comma-separated list. RFC 9110 makes Content-Type a singleton field."""
    return len(values) > 1 or any("," in v.split(";", 1)[0] for v in values)


def declared_not_pdf(content_type: str) -> bool:
    return content_type.startswith(_NOT_PDF_PREFIXES) or any(m in content_type for m in _NOT_PDF_MARKERS)


def _rejected(url: str, code: str, detail: Optional[str] = None) -> outcomes.DocumentRejected:
    logger.warning(
        "F26 PDF refused: %s (%s%s)", fetch_policy.redact_url(url), code, f": {detail}" if detail else ""
    )
    return outcomes.DocumentRejected(code, detail)


async def intake(client: Any, url: str, *, fetch: Optional[Fetch] = None) -> PdfDocument:
    """Fetch, check, keep and parse one PDF. ``fetch(client, url)`` replaces ``client.get(url)`` for
    a harvester with its own retry helper. Raises ``outcomes.DocumentRejected`` for a refused
    document; a database or network error propagates as before."""
    cap = cap_bytes()
    # R2: narrow the fetch boundary's own body cap, so it refuses the body while reading it. The
    # client is the connector's PolicyFetcher (its public ``max_bytes``); F25's guard keeps the class
    # itself out of reach here, so it is recognised by that attribute. A harness client has none.
    current = getattr(client, "max_bytes", None)
    if isinstance(current, int) and current > cap:
        client.max_bytes = cap
    try:
        response = await (fetch(client, url) if fetch is not None else client.get(url))
    except fetch_policy.FetchRefused as exc:
        if exc.reason == fetch_policy.TOO_LARGE:
            raise _rejected(url, outcomes.ERROR_PDF_TOO_LARGE, exc.detail) from None
        raise
    if response.status_code != 200:
        raise outcomes.DocumentRejected(f"http_{response.status_code}")
    body = response.content or b""
    content_type = declared_type(getattr(response, "headers", None))
    repeated = repeated_type(declared_types(getattr(response, "headers", None)))
    del response
    if len(body) > cap:
        raise _rejected(url, outcomes.ERROR_PDF_TOO_LARGE, f"{len(body)} bytes over {cap}")
    if repeated:  # R21: a singleton field sent twice, or as a list, is a malformed or rewritten response
        raise _rejected(url, outcomes.ERROR_NOT_PDF, "multiple Content-Type values")
    if declared_not_pdf(content_type):
        raise _rejected(url, outcomes.ERROR_NOT_PDF, f"declared {content_type[:60]}")
    if not outcomes.looks_like_pdf(body):
        raise _rejected(url, outcomes.ERROR_NOT_PDF, "no %PDF- signature")
    try:
        # hashing, a write, an fsync and perhaps a wait for another worker's lock: off the event loop
        stored = await asyncio.to_thread(raw_store.put, body)
    except raw_store.StoreRefused as exc:
        code = outcomes.ERROR_RAW_STORE_FULL if exc.full else outcomes.ERROR_RAW_STORE_FAILED
        raise _rejected(url, code, exc.reason) from None
    del body  # the worker keeps nothing of the document while the sandbox parses it
    try:
        parsed = await asyncio.to_thread(pdf_sandbox.parse, stored.path, stored.sha256, stored.size)
    except pdf_sandbox.ParseRefused as exc:
        raise _rejected(url, exc.code, exc.detail) from None
    if not outcomes.has_text(parsed.text):
        # F28 R16: the signature but no text (parsing and OCR both failed) is a failed document.
        raise _rejected(url, outcomes.ERROR_EMPTY_PDF_TEXT)
    return PdfDocument(
        text=parsed.text,
        pages=parsed.pages,
        ocr_applied=parsed.ocr_applied,
        ocr_truncated=parsed.ocr_truncated,
        sha256=stored.sha256,
        raw_key=stored.key,
    )
