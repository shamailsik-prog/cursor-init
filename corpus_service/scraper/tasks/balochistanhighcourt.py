import asyncio
import logging
import re
from collections import deque
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from scraper.net import fetch_policy
from scraper.tasks import outcomes

logger = logging.getLogger(__name__)

BHC_ALLOWED_HOSTS = {
    "bhc.gov.pk",
    "www.bhc.gov.pk",
    "portal.bhc.gov.pk",
}

BHC_LISTING_SEED_URLS = [
    "https://bhc.gov.pk/resources/judgments",
    "https://bhc.gov.pk/judgments",
    "https://bhc.gov.pk/reported-judgments",
    "https://bhc.gov.pk/reported_judgments",
    "https://portal.bhc.gov.pk/judgments",
]

BHC_LISTING_KEYWORDS = (
    "/resources/judgments",
    "/judgments",
    "reported-judgments",
    "reported_judgments",
    "significant-judgments",
    "portal.bhc.gov.pk/judgments",
)

BHC_CASE_PDF_KEYWORDS = (
    "/media/judgments/",
    "judgment",
    "judgement",
    "reported",
    "significant",
    "pld ",
)

NON_LISTING_SUFFIXES = (
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".zip",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
)

INLINE_PDF_URL_PATTERN = re.compile(
    r"(https?://[^\s\"'<>]+\.pdf(?:\?[^\s\"'<>]*)?|/[^\s\"'<>]+\.pdf(?:\?[^\s\"'<>]*)?)",
    flags=re.IGNORECASE,
)


def _dedupe_preserve_order(urls: list[str]) -> list[str]:
    return list(dict.fromkeys(urls))


def _is_public_bhc_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in BHC_ALLOWED_HOSTS


def _normalize_public_bhc_url(base_url: str, href: str) -> str | None:
    href = (href or "").strip()
    if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
        return None

    candidate = urljoin(base_url, href)
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not _is_public_bhc_url(candidate):
        return None

    hostname = (parsed.hostname or "").lower()
    if hostname == "www.bhc.gov.pk":
        hostname = "bhc.gov.pk"
    if not hostname:
        return None

    if parsed.port and not (
        (parsed.scheme == "https" and parsed.port == 443)
        or (parsed.scheme == "http" and parsed.port == 80)
    ):
        netloc = f"{hostname}:{parsed.port}"
    else:
        netloc = hostname

    normalized = parsed._replace(netloc=netloc).geturl()
    return normalized.split("#", 1)[0]


def _looks_like_pdf_url(url: str) -> bool:
    parsed = urlparse(url)
    return ".pdf" in parsed.path.lower() or ".pdf" in parsed.query.lower()


def _looks_like_listing_url(url: str, link_text: str) -> bool:
    if _looks_like_pdf_url(url):
        return False
    if urlparse(url).path.lower().endswith(NON_LISTING_SUFFIXES):
        return False
    haystack = f"{url.lower()} {link_text.lower()}"
    return any(keyword in haystack for keyword in BHC_LISTING_KEYWORDS)


def _looks_like_case_pdf(url: str, link_text: str) -> bool:
    haystack = f"{url.lower()} {link_text.lower()}"
    return any(keyword in haystack for keyword in BHC_CASE_PDF_KEYWORDS)


def _extract_listing_and_pdf_links(html: str, base_url: str) -> tuple[list[str], list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    listing_urls: list[str] = []
    pdf_urls: list[str] = []

    for anchor in soup.find_all("a"):
        link_text = anchor.get_text(" ", strip=True)

        href = anchor.get("href", "")
        normalized_href = _normalize_public_bhc_url(base_url, href)
        if normalized_href:
            if _looks_like_pdf_url(normalized_href) and _looks_like_case_pdf(normalized_href, link_text):
                pdf_urls.append(normalized_href)
            if _looks_like_listing_url(normalized_href, link_text):
                listing_urls.append(normalized_href)

        for attribute in ("data-src", "data-href", "data-url", "data-file", "data-pdf"):
            normalized_data_url = _normalize_public_bhc_url(base_url, anchor.get(attribute, ""))
            if not normalized_data_url:
                continue
            if _looks_like_pdf_url(normalized_data_url) and _looks_like_case_pdf(
                normalized_data_url, link_text
            ):
                pdf_urls.append(normalized_data_url)

    unescaped_scripts = "\n".join(
        script.get_text(" ", strip=False) for script in soup.find_all("script")
    ).replace("\\/", "/")
    for raw_match in INLINE_PDF_URL_PATTERN.findall(unescaped_scripts):
        normalized = _normalize_public_bhc_url(base_url, raw_match)
        if normalized and _looks_like_pdf_url(normalized) and _looks_like_case_pdf(normalized, ""):
            pdf_urls.append(normalized)

    unescaped_html = html.replace("\\/", "/")
    for raw_match in INLINE_PDF_URL_PATTERN.findall(unescaped_html):
        normalized = _normalize_public_bhc_url(base_url, raw_match)
        if normalized and _looks_like_pdf_url(normalized) and _looks_like_case_pdf(normalized, ""):
            pdf_urls.append(normalized)

    return _dedupe_preserve_order(listing_urls), _dedupe_preserve_order(pdf_urls)


async def _request_with_retries(
    client: fetch_policy.PolicyFetcher,
    url: str,
    *,
    attempts: int = 3,
    pause_seconds: float = 1.0,
) -> fetch_policy.FetchedResponse:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await client.get(url)
        except fetch_policy.FetchRefused:
            raise  # Audit F25: a refused URL is never retried
        except Exception as exc:  # pragma: no cover - depends on network path.
            last_error = exc
            if attempt < attempts:
                await asyncio.sleep(pause_seconds * attempt)
    assert last_error is not None
    raise last_error


async def _discover_pdf_urls() -> tuple[list[str], dict[str, str]]:
    pdf_sources: dict[str, str] = {}
    visited_listing_urls: set[str] = set()
    listing_queue = deque(BHC_LISTING_SEED_URLS)

    # Audit F28: every listing request is counted; when all of them fail the run fails.
    listings = outcomes.Tally()

    # Audit F25: listing pages are external input. Every request (and every redirect hop)
    # goes through the BalochistanHighCourt fetch policy: https, its hosts on 443, public addresses only.
    async with fetch_policy.fetcher_for("BalochistanHighCourt") as client:
        while listing_queue and len(visited_listing_urls) < 40:
            listing_url = listing_queue.popleft()
            if listing_url in visited_listing_urls:
                continue
            visited_listing_urls.add(listing_url)
            try:
                response = await _request_with_retries(client, listing_url)
            except Exception as e:
                logger.warning("BHC listing request failed %s: %s", listing_url, repr(e))
                listings.item_failed(e)
                continue

            if response.status_code != 200:
                logger.warning(
                    "BHC listing returned status %s for %s",
                    response.status_code,
                    listing_url,
                )
                listings.item_failed(f"http_{response.status_code}")
                continue

            listings.item_ok()
            child_listings, discovered_pdfs = _extract_listing_and_pdf_links(
                response.text, str(response.url)
            )
            for pdf_url in discovered_pdfs:
                pdf_sources.setdefault(pdf_url, listing_url)

            for child_url in child_listings:
                if child_url not in visited_listing_urls and child_url not in listing_queue:
                    listing_queue.append(child_url)

    logger.info(
        "BalochistanHighCourt discovery visited %d listing pages, found %d PDFs",
        len(visited_listing_urls),
        len(pdf_sources),
    )
    listings.raise_if_all_failed(outcomes.REASON_LISTINGS_FAILED)
    return list(pdf_sources.keys()), pdf_sources


async def scrape_balochistanhighcourt(source, db):
    # Audit F28: no outer catch. A discovery whose every listing request failed, a database error,
    # or a run whose every PDF failed fails the run; each PDF's outcome is counted.
    from scraper.models import ScraperStaging
    from scraper.parsers.pdf_extractor import extract_pdf_text
    from scraper.source_identity import stamp_metadata

    tally = outcomes.run_tally()
    pdf_urls, pdf_sources = await _discover_pdf_urls()
    if not pdf_urls:
        logger.warning(
            "BalochistanHighCourt: no PDF links discovered from configured listing URLs"
        )
        return tally.finish(note="no PDF links discovered")

    async with fetch_policy.fetcher_for("BalochistanHighCourt") as client:
        for pdf_url in pdf_urls[:60]:
            try:
                response = await _request_with_retries(client, pdf_url)
                if response.status_code != 200:
                    tally.item_failed(f"http_{response.status_code}")
                    continue
                if not outcomes.looks_like_pdf(response.content):
                    tally.item_failed(outcomes.ERROR_NOT_PDF)
                    continue
                text = extract_pdf_text(response.content)
                if not outcomes.has_text(text):
                    # Audit F28 R16: the signature but no text (parsing and OCR both failed) is a
                    # failed document: never staged, never progress.
                    logger.warning("PDF %s has no extractable text; not staged", pdf_url)
                    tally.item_failed(outcomes.ERROR_EMPTY_PDF_TEXT)
                    continue
                staging = ScraperStaging(
                    source_id=source.id,
                    source_site="BalochistanHighCourt",
                    source_url=pdf_url,
                    raw_text=text[:50000],
                    confidence_score=0.6,
                    quarantined=True,
                    quarantine_reason="review source",
                    parsing_metadata=stamp_metadata(source, {"listing_url": pdf_sources.get(pdf_url)}),
                )
                db.add(staging)
                await db.commit()
                tally.item_ok(1)
                await asyncio.sleep(1)
            except Exception as e:
                if outcomes.is_database_error(e):
                    raise
                logger.error("BalochistanHighCourt PDF %s error %s", pdf_url, e)
                tally.item_failed(e)
    return tally.finish()
