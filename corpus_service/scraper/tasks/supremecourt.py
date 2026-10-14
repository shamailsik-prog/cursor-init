import asyncio
import logging
import re
from collections import deque
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

SUPREMECOURT_LISTING_SEED_URLS = [
    "https://www.supremecourt.gov.pk/latest-judgements/",
    "https://www.supremecourt.gov.pk/judgement-search/",
    "https://www.supremecourt.gov.pk/online-case-status/",
    "https://www.supremecourt.gov.pk/downloads_judgements/",
    "https://www.supremecourt.gov.pk/sitemap.xml",
    "https://www.supremecourt.gov.pk/",
]

SUPREMECOURT_LISTING_KEYWORDS = (
    "latest-judgements",
    "judgement-search",
    "judgment-search",
    "online-case-status",
    "downloads_judgements",
    "download/",
    "sitemap",
    "judgement",
    "judgment",
)

SUPREMECOURT_CASE_PDF_KEYWORDS = (
    "downloads_judgements",
    "judgement",
    "judgment",
    "const.p.",
    "c.p.",
    "crl.",
    "civil",
    "appeal",
    "sca",
    "s.m.c.",
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

INLINE_PUBLIC_URL_PATTERN = re.compile(
    r"https?://[^\s\"'<>]+",
    flags=re.IGNORECASE,
)


def _dedupe_preserve_order(urls: list[str]) -> list[str]:
    return list(dict.fromkeys(urls))


def _is_public_supremecourt_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("supremecourt.gov.pk")


def _normalize_public_supremecourt_url(base_url: str, href: str) -> str | None:
    href = (href or "").strip()
    if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
        return None

    candidate = urljoin(base_url, href)
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not _is_public_supremecourt_url(candidate):
        return None
    return candidate.split("#", 1)[0]


def _looks_like_pdf_url(url: str) -> bool:
    parsed = urlparse(url)
    return ".pdf" in parsed.path.lower() or ".pdf" in parsed.query.lower()


def _looks_like_listing_url(url: str, link_text: str) -> bool:
    if _looks_like_pdf_url(url):
        return False
    if urlparse(url).path.lower().endswith(NON_LISTING_SUFFIXES):
        return False
    haystack = f"{url.lower()} {link_text.lower()}"
    return any(keyword in haystack for keyword in SUPREMECOURT_LISTING_KEYWORDS)


def _looks_like_case_pdf(url: str, link_text: str) -> bool:
    url_lower = url.lower()
    if "downloads_judgements" in url_lower:
        return True
    haystack = f"{url_lower} {link_text.lower()}"
    return any(keyword in haystack for keyword in SUPREMECOURT_CASE_PDF_KEYWORDS)


def _extract_listing_and_pdf_links(html: str, base_url: str) -> tuple[list[str], list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    listing_urls: list[str] = []
    pdf_urls: list[str] = []

    for anchor in soup.select("a[href]"):
        normalized = _normalize_public_supremecourt_url(base_url, anchor.get("href", ""))
        if not normalized:
            continue

        link_text = anchor.get_text(" ", strip=True)
        if _looks_like_pdf_url(normalized) and _looks_like_case_pdf(normalized, link_text):
            pdf_urls.append(normalized)
        if _looks_like_listing_url(normalized, link_text):
            listing_urls.append(normalized)

    script_bodies = "\n".join(script.get_text(" ", strip=False) for script in soup.find_all("script"))
    unescaped_scripts = script_bodies.replace("\\/", "/")
    for raw_match in INLINE_PDF_URL_PATTERN.findall(unescaped_scripts):
        normalized = _normalize_public_supremecourt_url(base_url, raw_match)
        if normalized and _looks_like_pdf_url(normalized) and _looks_like_case_pdf(normalized, ""):
            pdf_urls.append(normalized)

    # Sitemap XML pages expose URLs in <loc> tags rather than anchors.
    for raw_match in INLINE_PUBLIC_URL_PATTERN.findall(html):
        normalized = _normalize_public_supremecourt_url(base_url, raw_match)
        if not normalized:
            continue
        if _looks_like_pdf_url(normalized) and _looks_like_case_pdf(normalized, ""):
            pdf_urls.append(normalized)
            continue
        if _looks_like_listing_url(normalized, ""):
            listing_urls.append(normalized)

    return _dedupe_preserve_order(listing_urls), _dedupe_preserve_order(pdf_urls)


async def _discover_pdf_urls() -> tuple[list[str], dict[str, str]]:
    pdf_sources: dict[str, str] = {}
    visited_listing_urls: set[str] = set()
    listing_queue = deque(SUPREMECOURT_LISTING_SEED_URLS)

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        follow_redirects=True,
    ) as client:
        while listing_queue and len(visited_listing_urls) < 25:
            listing_url = listing_queue.popleft()
            if listing_url in visited_listing_urls:
                continue
            visited_listing_urls.add(listing_url)
            try:
                response = await client.get(listing_url)
            except Exception as e:
                logger.warning("SupremeCourt listing request failed %s: %s", listing_url, e)
                continue

            if response.status_code >= 400:
                logger.warning(
                    "SupremeCourt listing returned status %s for %s",
                    response.status_code,
                    listing_url,
                )
                continue

            child_listings, discovered_pdfs = _extract_listing_and_pdf_links(
                response.text, str(response.url)
            )
            for pdf_url in discovered_pdfs:
                pdf_sources.setdefault(pdf_url, listing_url)

            for child_url in child_listings:
                if child_url not in visited_listing_urls and child_url not in listing_queue:
                    listing_queue.append(child_url)

    logger.info(
        "SupremeCourt discovery visited %d listing pages, found %d PDFs",
        len(visited_listing_urls),
        len(pdf_sources),
    )
    return list(pdf_sources.keys()), pdf_sources


async def scrape_supremecourt(source, db):
    try:
        from scraper.models import ScraperStaging
        from scraper.parsers.pdf_extractor import extract_pdf_text
        from scraper.source_identity import stamp_metadata

        pdf_urls, pdf_sources = await _discover_pdf_urls()
        if not pdf_urls:
            logger.warning(
                "SupremeCourt: no PDF links discovered from configured listing URLs"
            )
            return

        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            for pdf_url in pdf_urls[:40]:
                try:
                    response = await client.get(pdf_url)
                    if response.status_code != 200:
                        continue
                    if response.content[:4] != b"%PDF":
                        continue
                    text = extract_pdf_text(response.content)
                    staging = ScraperStaging(
                        source_id=source.id,
                        source_site="SupremeCourt",
                        source_url=pdf_url,
                        raw_text=text[:50000],
                        confidence_score=0.6,
                        quarantined=True,
                        quarantine_reason="review source",
                        parsing_metadata=stamp_metadata(source, {"listing_url": pdf_sources.get(pdf_url)}),
                    )
                    db.add(staging)
                    await db.commit()
                    await asyncio.sleep(1)
                except Exception as e:
                    logger.error("SupremeCourt PDF %s error %s", pdf_url, e)
    except Exception as e:
        logger.error("SupremeCourt scraper error %s", e)
