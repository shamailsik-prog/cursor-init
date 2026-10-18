"""
Pakistani Legal Scraper - PDF Extractor
Section 15 - PDF Text Extraction

Production module for extracting text from legal judgment PDFs.
Primary: pdfplumber text extraction
Fallback: pytesseract OCR when text layer is empty / scanned.

Tech stack: pdfplumber, pytesseract, Pillow

Audit F26 (spec docs/superpowers/specs/2026-10-18-f26-bounded-isolated-pdf-processing-design.md):
this module runs only inside the PDF sandbox (scraper/parsers/pdf_sandbox.py), never in a worker
(tests/test_f26_pdf_sandbox.py fails the build if anything else imports it). The extraction algorithm
is main's (R9); what changed is that it is bounded (``Limits``: pages, extracted text, pages sent to
OCR, pixels rendered, tesseract time), that ``MemoryError`` and a ``PdfLimitExceeded`` are never
swallowed by its broad handlers, and that each page's cached layout is released once it is read.
``find_active_content`` is the malware policy's structural scan (R4). The streaming downloaders are
gone: every PDF is fetched by the F25 boundary through ``scraper.tasks.pdf_intake`` (R1, R2).
"""

from __future__ import annotations

import io
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants & Config
# ---------------------------------------------------------------------------
MIN_EXTRACTED_LENGTH = 200  # chars - threshold to consider pdfplumber success
MAX_PDF_SIZE_BYTES = 100 * 1024 * 1024  # 100 MB: the fetch boundary's cap (scraper.net.fetch_policy.MAX_BYTES)
OCR_DPI = 300  # the resolution pages are rendered at for OCR

# Tesseract config - PSM 6 = assume uniform block of text, good for judgments
TESSERACT_CONFIG = "--oem 3 --psm 6 -l eng"
# Some Pakistani judgments contain Urdu citations - try combined if available
TESSERACT_CONFIG_URDU = "--oem 3 --psm 6 -l eng+urd"

PDF_MAGIC = b"%PDF"

# Regex to clean extraction artifacts
RE_MSO_JUNK = re.compile(r"mso-[a-z-]+:[^;]+;?", re.I)
RE_MULTISPACE = re.compile(r"[ \t]{2,}")
RE_MULTINEWLINE = re.compile(r"\n{3,}")
RE_CONTROL = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F]")


class PDFDownloadError(RuntimeError):
    """Raised when PDF download fails or validation fails."""

class PDFExtractionError(RuntimeError):
    """Raised when both pdfplumber and OCR fail to produce usable text."""


# ---------------------------------------------------------------------------
# Audit F26: bounds (spec R8) and what an extraction did
# ---------------------------------------------------------------------------
PAGE_LIMIT = "pdf_page_limit"
TEXT_LIMIT = "pdf_text_limit"


class PdfLimitExceeded(Exception):
    """A document past one of the extraction caps; ``code`` is the F26 refusal code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Limits:
    max_pages: int = 1000
    max_text_chars: int = 4_000_000
    max_ocr_pages: int = 25  # pages sent to OCR; the rest are not OCRed (ocr_truncated)
    max_image_pixels: int = 50_000_000  # a page larger than this at OCR_DPI is not rendered
    tesseract_seconds: int = 30  # one tesseract call


DEFAULT_LIMITS = Limits()

# Never swallowed by the broad handlers below: the sandbox turns them into refusals.
_NEVER_SWALLOWED = (MemoryError, PdfLimitExceeded)


@dataclass(frozen=True)
class Extraction:
    text: str
    pages: int
    ocr_applied: bool  # the text returned came from OCR
    ocr_pages: int = 0  # pages OCR was attempted on
    ocr_skipped: int = 0  # pages too large to render
    ocr_truncated: bool = False  # pages past max_ocr_pages were not OCRed


@dataclass
class _OcrStats:
    pages: int = 0
    skipped: int = 0
    truncated: bool = False


def _reraise_if_exhausted(exc: BaseException) -> None:
    """pdfplumber wraps what pdfminer and pypdfium2 raise (``PdfminerException(e)``,
    ``MalformedPDFException(e)``), so a MemoryError or a cap can arrive inside another exception. Find
    it in the chain (cause, context, arguments) and raise it, so no broad handler swallows it."""
    seen, stack = set(), [exc]
    while stack:
        item = stack.pop()
        if not isinstance(item, BaseException) or id(item) in seen:
            continue
        seen.add(id(item))
        if isinstance(item, PdfLimitExceeded):
            raise item
        if isinstance(item, MemoryError):
            raise MemoryError("parser memory exhausted") from exc
        stack.extend([item.__cause__, item.__context__, *item.args])


def _check_pages(num_pages: int, limits: Limits) -> None:
    if num_pages > limits.max_pages:
        raise PdfLimitExceeded(PAGE_LIMIT)


def _render_pixels(page: Any, dpi: int) -> float:
    return (float(page.width) * dpi / 72.0) * (float(page.height) * dpi / 72.0)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def _clean_text(text: str) -> str:
    """Normalize legal judgment text."""
    if not text:
        return ""
    # Remove Word/MSO artifacts often present in PakistanLawSite HTML-converted PDFs
    text = RE_MSO_JUNK.sub("", text)
    text = text.replace("\xa0", " ").replace("\u200b", "").replace("\ufeff", "")
    text = RE_CONTROL.sub("", text)
    text = RE_MULTISPACE.sub(" ", text)
    text = RE_MULTINEWLINE.sub("\n\n", text)
    # Normalize line breaks but keep paragraph structure
    lines = [ln.strip() for ln in text.splitlines()]
    # Remove excessive empty lines but preserve at least one separator
    cleaned_lines: list[str] = []
    empty_streak = 0
    for ln in lines:
        if not ln:
            empty_streak += 1
            if empty_streak <= 1:
                cleaned_lines.append("")
            continue
        empty_streak = 0
        cleaned_lines.append(ln)
    return "\n".join(cleaned_lines).strip()


def _pdfplumber_extract(pdf_bytes: bytes, limits: Limits = DEFAULT_LIMITS) -> tuple[str, int, bool]:
    """
    Attempt pdfplumber extraction.
    Returns (text, num_pages, is_scanned_hint)
    Audit F26: raises PdfLimitExceeded past the page or text cap; never swallows MemoryError.
    """
    try:
        import pdfplumber
    except ImportError as exc:
        logger.error("pdfplumber not installed: %s", exc)
        return "", 0, False

    try:
        text_parts: list[str] = []
        num_pages = 0
        scanned_pages = 0
        total_chars = 0
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            num_pages = len(pdf.pages)
            _check_pages(num_pages, limits)
            if num_pages == 0:
                return "", 0, False
            for i, page in enumerate(pdf.pages):
                try:
                    page_text = page.extract_text(x_tolerance=2, y_tolerance=2) or ""
                    # Also try extract_text_simple for some layouts
                    if len(page_text.strip()) < 50:
                        alt = page.extract_text_simple() if hasattr(page, "extract_text_simple") else ""
                        if alt and len(alt) > len(page_text):
                            page_text = alt
                    if len(page_text.strip()) < 20:
                        scanned_pages += 1
                    text_parts.append(page_text)
                except _NEVER_SWALLOWED:
                    raise
                except Exception as e:
                    _reraise_if_exhausted(e)
                    logger.warning("pdfplumber page %d extraction failed: %s", i, e, exc_info=False)
                    text_parts.append("")
                    scanned_pages += 1
                finally:
                    page.close()  # audit F26: release the page's cached layout
                total_chars += len(text_parts[-1])
                if total_chars > limits.max_text_chars:
                    raise PdfLimitExceeded(TEXT_LIMIT)
        full_text = "\n".join(text_parts)
        is_scanned = scanned_pages > (num_pages * 0.6) if num_pages else False
        return full_text, num_pages, is_scanned
    except _NEVER_SWALLOWED:
        raise
    except Exception as e:
        _reraise_if_exhausted(e)
        logger.warning("pdfplumber open/parse failed: %s", e, exc_info=True)
        return "", 0, True


def _ocr_extract_with_pdfplumber_images(
    pdf_bytes: bytes, limits: Limits = DEFAULT_LIMITS, stats: Optional[_OcrStats] = None
) -> str:
    """
    OCR fallback using pdfplumber's page.to_image() -> PIL -> pytesseract
    Works without poppler dependency.
    Audit F26: at most limits.max_ocr_pages pages, none larger than limits.max_image_pixels at
    OCR_DPI, each tesseract call bounded by limits.tesseract_seconds, the OCR text held to
    limits.max_text_chars; MemoryError and PdfLimitExceeded propagate. ``stats`` records what was done.
    """
    stats = stats if stats is not None else _OcrStats()
    try:
        import pdfplumber
        from PIL import Image
        import pytesseract
    except ImportError as exc:
        logger.error("OCR dependencies missing: %s", exc)
        return ""

    ocr_texts: list[str] = []
    ocr_chars = 0
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            _check_pages(len(pdf.pages), limits)
            for idx, page in enumerate(pdf.pages):
                if idx >= limits.max_ocr_pages:
                    stats.truncated = True
                    logger.warning("OCR stops after %d of %d pages (audit F26 cap)", idx, len(pdf.pages))
                    break
                try:
                    pixels = _render_pixels(page, OCR_DPI)
                    if pixels > limits.max_image_pixels:
                        stats.skipped += 1
                        logger.warning("page %d is %.0f pixels at %d dpi, over the audit F26 cap; not rendered", idx, pixels, OCR_DPI)
                        continue
                    stats.pages += 1
                    # Render page to image at 300 DPI for decent OCR
                    # pdfplumber's to_image requires Wand or pdfium optional; handle fallback
                    try:
                        pil_image: Image.Image = page.to_image(resolution=OCR_DPI).original
                    except Exception as render_error:
                        _reraise_if_exhausted(render_error)
                        # Fallback: try to extract embedded images and OCR them (less accurate)
                        # If no image rendering, skip
                        logger.debug("page.to_image failed on page %d, trying crop render", idx)
                        # Some pdfplumber versions need explicit
                        im = page.to_image(resolution=250)
                        pil_image = im.original if hasattr(im, "original") else None
                        if pil_image is None:
                            continue

                    if pil_image is None:
                        continue

                    # Convert to grayscale for better OCR on legal scans
                    if pil_image.mode in ("RGBA", "LA", "P"):
                        background = Image.new("RGB", pil_image.size, (255, 255, 255))
                        if pil_image.mode == "P":
                            pil_image = pil_image.convert("RGBA")
                        if pil_image.mode == "RGBA":
                            background.paste(pil_image, mask=pil_image.split()[-1])
                            pil_image = background
                        else:
                            pil_image = pil_image.convert("RGB")
                    elif pil_image.mode != "L":
                        pil_image = pil_image.convert("L")

                    # Try combined eng+urd first, fallback to eng if urdu traineddata missing
                    try:
                        txt = pytesseract.image_to_string(
                            pil_image, config=TESSERACT_CONFIG_URDU, timeout=limits.tesseract_seconds
                        )
                        if len(txt.strip()) < 50:
                            txt = pytesseract.image_to_string(
                                pil_image, config=TESSERACT_CONFIG, timeout=limits.tesseract_seconds
                            )
                    except _NEVER_SWALLOWED:
                        raise
                    except Exception as e:
                        _reraise_if_exhausted(e)
                        # Tesseract might not have urd, fallback
                        logger.debug("tesseract urd fallback triggered: %s", e)
                        txt = pytesseract.image_to_string(pil_image, config=TESSERACT_CONFIG, timeout=limits.tesseract_seconds)

                    if txt:
                        ocr_texts.append(txt)
                        # audit F26: OCR text counts against the same cap as a text layer
                        ocr_chars += len(txt)
                        if ocr_chars > limits.max_text_chars:
                            raise PdfLimitExceeded(TEXT_LIMIT)

                except _NEVER_SWALLOWED:
                    raise
                except Exception as e:
                    _reraise_if_exhausted(e)
                    logger.warning("OCR failed on page %d: %s", idx, e, exc_info=False)
                    continue
                finally:
                    page.close()  # audit F26: release the page's cached layout
    except _NEVER_SWALLOWED:
        raise
    except Exception as e:
        _reraise_if_exhausted(e)
        logger.warning("OCR pdf open failed: %s", e, exc_info=True)
        return ""

    return "\n".join(ocr_texts)


def _validate_pdf_bytes(data: bytes, url: str = "") -> None:
    """Lightweight validation that bytes look like a PDF."""
    if not data:
        raise PDFDownloadError(f"Empty PDF download from {url}")
    if len(data) < 1024:
        # Could be error page that got returned as PDF mime
        # Allow but log
        logger.warning("Very small PDF %d bytes from %s, may be error page", len(data), url)
    if not data[:4].startswith(PDF_MAGIC):
        # Some servers prepend BOM or whitespace; check first 1024 bytes for %PDF
        if PDF_MAGIC not in data[:1024]:
            # But don't hard-fail - site sometimes sends HTML error page with PDF url
            # Examine if it looks like HTML
            if data[:5].lower().startswith(b"<!doc") or data[:6].lower().startswith(b"<html"):
                preview = data[:500].decode("utf-8", errors="ignore")
                raise PDFDownloadError(
                    f"URL did not return PDF, got HTML from {url}: {preview[:200]}"
                )
            logger.warning("Download from %s missing PDF magic, continuing anyway", url)


# ---------------------------------------------------------------------------
# Public API per spec Section 15
# ---------------------------------------------------------------------------
def extract_pdf(pdf_bytes: bytes, limits: Limits = DEFAULT_LIMITS) -> Extraction:
    """
    Extract text from Pakistan legal judgment PDF bytes, within ``limits`` (audit F26).

    Strategy (main's, unchanged):
      1. Primary: pdfplumber extract_text() for digital PDFs.
      2. If extracted length < 200 chars or >60% pages look scanned,
         fallback to pytesseract OCR via pdfplumber page.to_image().
      3. Return cleaned, normalized text. Empty string if truly unreadable.

    Raises PdfLimitExceeded past the page or text cap, and MemoryError; any other failure degrades
    to the best text found (possibly "") as before.
    """
    if not pdf_bytes:
        logger.warning("extract_pdf_text called with empty bytes")
        return Extraction("", 0, False)

    _validate_pdf_bytes(pdf_bytes)

    start = time.monotonic()

    # --- Primary: pdfplumber ---
    raw_text, num_pages, is_scanned_hint = _pdfplumber_extract(pdf_bytes, limits)
    cleaned_primary = _clean_text(raw_text)

    if len(cleaned_primary.strip()) >= MIN_EXTRACTED_LENGTH and not is_scanned_hint:
        logger.info(
            "pdfplumber success: %d pages, %d chars in %.2fs",
            num_pages,
            len(cleaned_primary),
            time.monotonic() - start,
        )
        return Extraction(cleaned_primary, num_pages, False)

    # --- Fallback: OCR ---
    logger.info(
        "pdfplumber text too short (%d chars, scanned_hint=%s, pages=%d), falling back to OCR",
        len(cleaned_primary.strip()),
        is_scanned_hint,
        num_pages,
    )

    ocr = _OcrStats()

    def done(text: str, from_ocr: bool) -> Extraction:
        return Extraction(text, num_pages, from_ocr, ocr.pages, ocr.skipped, ocr.truncated)

    try:
        ocr_raw = _ocr_extract_with_pdfplumber_images(pdf_bytes, limits, ocr)
        ocr_cleaned = _clean_text(ocr_raw)

        # Choose best of primary vs OCR
        if len(ocr_cleaned.strip()) > len(cleaned_primary.strip()):
            logger.info(
                "OCR fallback success: %d chars (primary was %d) in %.2fs",
                len(ocr_cleaned),
                len(cleaned_primary),
                time.monotonic() - start,
            )
            if len(ocr_cleaned.strip()) >= 50:
                return done(ocr_cleaned, True)

        # If OCR produced little but primary had something, return primary
        if len(cleaned_primary.strip()) >= 50:
            logger.warning(
                "OCR output (%d) smaller than primary (%d), using primary",
                len(ocr_cleaned.strip()),
                len(cleaned_primary.strip()),
            )
            return done(cleaned_primary, False)

        # Last resort - return whatever we have
        from_ocr = len(ocr_cleaned) > len(cleaned_primary)
        final = ocr_cleaned if from_ocr else cleaned_primary
        if final.strip():
            return done(final, from_ocr)

        logger.error("Both pdfplumber (%d chars) and OCR (%d chars) yielded insufficient text", len(cleaned_primary), len(ocr_cleaned))
        return done("", False)

    except _NEVER_SWALLOWED:
        raise
    except Exception as e:
        _reraise_if_exhausted(e)
        logger.error("extract_pdf_text OCR fallback crashed: %s", e, exc_info=True)
        # Return primary if exists, else empty - graceful degradation for scraper
        return done(cleaned_primary if cleaned_primary.strip() else "", False)


def extract_pdf_text(pdf_bytes: bytes) -> str:
    """
    Extract text from Pakistan legal judgment PDF bytes: ``extract_pdf(pdf_bytes).text`` with the
    default limits. Same signature and, below the limits, the same text as before audit F26.
    """
    return extract_pdf(pdf_bytes).text


# ---------------------------------------------------------------------------
# Audit F26: malware policy (spec R4) and the sandbox's set-up
# ---------------------------------------------------------------------------
# PDF names that carry or launch code, or embed files: JavaScript (/JS, /JavaScript), launch actions,
# embedded files (the stream's optional /Type, the name tree, a filespec's /EF, an attachment
# annotation), and the script containers that need no /JS name (/XFA forms, /RichMedia).
# F26-FU (spec R20, re-audit L4): 3D artwork and its script (/3DD, /OnInstantiate), go-to actions whose
# target is another or an embedded file (/GoToR, /GoToE: a UNC path leaks the reader's NTLM hash), and
# form actions that send or load data (/SubmitForm, /ImportData). /URI stays accepted: judgments link
# to statutes and reports.
ACTIVE_CONTENT_NAMES = frozenset({
    "JS", "JavaScript", "Launch", "EmbeddedFile", "EmbeddedFiles", "EF", "FileAttachment", "RichMedia", "XFA",
    "OnInstantiate", "3DD", "GoToR", "GoToE", "SubmitForm", "ImportData",
})


def _name_of(value: Any) -> Optional[str]:
    if isinstance(value, bytes):
        return value.decode("latin-1")
    return value if isinstance(value, str) else None


def _active_name_in(root: Any) -> Optional[str]:
    """The first active-content name among the keys, name values and stream dictionaries of ``root``
    (references are not followed: every object is scanned on its own)."""
    from pdfminer.pdftypes import PDFStream
    from pdfminer.psparser import PSLiteral

    stack = [root]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            for key, value in item.items():
                if _name_of(key) in ACTIVE_CONTENT_NAMES:
                    return _name_of(key)
                stack.append(value)
        elif isinstance(item, (list, tuple)):
            stack.extend(item)
        elif isinstance(item, PDFStream):
            stack.append(item.attrs)
        elif isinstance(item, PSLiteral):
            if _name_of(item.name) in ACTIVE_CONTENT_NAMES:
                return _name_of(item.name)
    return None


def find_active_content(pdf_bytes: bytes) -> Optional[str]:
    """The structural scan (spec R4): every object pdfminer resolves through every cross-reference
    section (tables and streams, objects packed in compressed object streams included, and its own
    repair scan of a broken table) and every trailer. Names are compared after pdfminer decodes
    their #xx escapes. Returns the first active-content name found, or None. A document pdfminer
    cannot open is left to extraction."""
    from pdfminer.pdfdocument import PDFDocument
    from pdfminer.pdfparser import PDFParser

    try:
        document = PDFDocument(PDFParser(io.BytesIO(pdf_bytes)))
    except _NEVER_SWALLOWED:
        raise
    except Exception as e:
        _reraise_if_exhausted(e)
        logger.info("active-content scan: pdfminer cannot open the document (%s); extraction decides", type(e).__name__)
        return None
    seen: set = set()
    for xref in document.xrefs:
        hit = _active_name_in(xref.get_trailer())
        if hit:
            return hit
        for objid in xref.get_objids():
            if objid in seen:
                continue
            seen.add(objid)
            try:
                obj = document.getobj(objid)
            except _NEVER_SWALLOWED:
                raise
            except Exception as e:
                _reraise_if_exhausted(e)
                continue
            hit = _active_name_in(obj)
            if hit:
                return hit
    return None


def bound_image_decoding(max_pixels: int) -> None:
    """PIL refuses any image over ``max_pixels``: its decompression-bomb warning becomes an error."""
    import warnings

    from PIL import Image

    Image.MAX_IMAGE_PIXELS = int(max_pixels)
    warnings.simplefilter("error", Image.DecompressionBombWarning)


def image_decoding_bound() -> dict:
    """PIL's bound as it holds now, read back for the sandbox's isolation record (F26-FU, spec R24):
    the pixel cap and whether the bomb warning is raised as an error."""
    import warnings

    from PIL import Image

    as_error = any(f[0] == "error" and f[2] is Image.DecompressionBombWarning for f in warnings.filters)
    return {"image_pixels": Image.MAX_IMAGE_PIXELS, "image_bomb_error": as_error}


def _warm_up_pdf() -> bytes:
    """A one-page PDF of more than 1 KiB (so _validate_pdf_bytes does not warn) with a text layer of
    more than MIN_EXTRACTED_LENGTH characters (so the warm-up never turns to OCR)."""
    lines = [f"F26 sandbox warm-up line {i}: a synthetic page, not a judgment, 2099." for i in range(1, 9)]
    content = b"BT\n/F1 11 Tf\n14 TL\n72 740 Td\n" + b"\nT*\n".join(b"(" + ln.encode("ascii") + b") Tj" for ln in lines) + b"\nET\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def warm_up() -> None:
    """Load everything the parser and the OCR path load lazily, by running them once on a built-in
    page: the sandbox calls this before it drops privileges, so nothing later needs to read files
    the unprivileged user may not."""
    import pdfplumber
    import pdfplumber.display  # noqa: F401 - pypdfium2, which renders pages for OCR
    import PIL.Image
    import PIL.PngImagePlugin  # noqa: F401 - the format pytesseract hands images to tesseract in

    try:
        import pytesseract  # noqa: F401
    except ImportError:
        pass
    data = _warm_up_pdf()
    extract_pdf(data)
    find_active_content(data)
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        image = pdf.pages[0].to_image(resolution=10).original
        PIL.Image.new("RGB", image.size, (255, 255, 255)).convert("L").save(io.BytesIO(), format="PNG")
        image.convert("L").save(io.BytesIO(), format="PNG")
