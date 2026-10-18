import asyncio
import logging
import re
from collections import deque
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from scraper.net import fetch_policy

logger = logging.getLogger(__name__)

LHC_LISTING_SEED_URLS = [
    "https://lhc.gov.pk/reported_judgments",
    "https://lhc.gov.pk/green_bench_notifications",
    # Legacy pages are kept as low-priority fallbacks for future reversions.
    "https://lhc.gov.pk/judgments",
    "https://lhc.gov.pk/reported-judgments",
    "https://lhc.gov.pk/judgment-search",
]

LHC_LISTING_KEYWORDS = (
    "reported_judgments",
    "reported-judgments",
    "judgment",
    "judgements",
    "green_bench",
    "school_security_orders",
    "approved_for_reporting",
)

INLINE_PDF_URL_PATTERN = re.compile(
    r"(https?://[^\s\"'<>]+\.pdf(?:\?[^\s\"'<>]*)?|/[^\s\"'<>]+\.pdf(?:\?[^\s\"'<>]*)?)",
    flags=re.IGNORECASE,
)


def _dedupe_preserve_order(urls: list[str]) -> list[str]:
    return list(dict.fromkeys(urls))


def _is_public_lhc_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("lhc.gov.pk")


def _normalize_public_lhc_url(base_url: str, href: str) -> str | None:
    href = (href or "").strip()
    if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
        return None

    candidate = urljoin(base_url, href)
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not _is_public_lhc_url(candidate):
        return None
    return candidate.split("#", 1)[0]


def _looks_like_pdf_url(url: str) -> bool:
    parsed = urlparse(url)
    return ".pdf" in parsed.path.lower() or ".pdf" in parsed.query.lower()


def _looks_like_listing_url(url: str, link_text: str) -> bool:
    haystack = f"{url.lower()} {link_text.lower()}"
    return any(keyword in haystack for keyword in LHC_LISTING_KEYWORDS)


def _extract_listing_and_pdf_links(html: str, base_url: str) -> tuple[list[str], list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    listing_urls: list[str] = []
    pdf_urls: list[str] = []

    for anchor in soup.select("a[href]"):
        normalized = _normalize_public_lhc_url(base_url, anchor.get("href", ""))
        if not normalized:
            continue

        link_text = anchor.get_text(" ", strip=True)
        if _looks_like_pdf_url(normalized):
            pdf_urls.append(normalized)
        if _looks_like_listing_url(normalized, link_text):
            listing_urls.append(normalized)

    # Catch script-embedded or escaped PDF URLs.
    unescaped_html = html.replace("\\/", "/")
    for raw_match in INLINE_PDF_URL_PATTERN.findall(unescaped_html):
        normalized = _normalize_public_lhc_url(base_url, raw_match)
        if normalized and _looks_like_pdf_url(normalized):
            pdf_urls.append(normalized)

    return _dedupe_preserve_order(listing_urls), _dedupe_preserve_order(pdf_urls)


async def _discover_pdf_urls() -> tuple[list[str], dict[str, str]]:
    pdf_sources: dict[str, str] = {}
    visited_listing_urls: set[str] = set()
    listing_queue = deque(LHC_LISTING_SEED_URLS)

    # Audit F25: listing pages are external input. Every request (and every redirect hop)
    # goes through the LahoreHighCourt fetch policy: https, its hosts on 443, public addresses only.
    async with fetch_policy.fetcher_for("LahoreHighCourt") as client:
        while listing_queue and len(visited_listing_urls) < 25:
            listing_url = listing_queue.popleft()
            if listing_url in visited_listing_urls:
                continue
            visited_listing_urls.add(listing_url)
            try:
                response = await client.get(listing_url)
            except Exception as e:
                logger.warning("LHC listing request failed %s: %s", listing_url, e)
                continue

            if response.status_code >= 400:
                logger.warning(
                    "LHC listing returned status %s for %s",
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
        "LahoreHighCourt discovery visited %d listing pages, found %d PDFs",
        len(visited_listing_urls),
        len(pdf_sources),
    )
    return list(pdf_sources.keys()), pdf_sources


async def scrape_lahorehighcourt(source, db):
    try:
        from scraper.models import ScraperStaging
        from scraper.parsers.pdf_extractor import extract_pdf_text
        from scraper.source_identity import stamp_metadata

        pdf_urls, pdf_sources = await _discover_pdf_urls()
        if not pdf_urls:
            logger.warning(
                "LahoreHighCourt: no PDF links discovered from configured listing URLs"
            )
            return

        async with fetch_policy.fetcher_for("LahoreHighCourt") as client:
            for pdf_url in pdf_urls[:20]:
                try:
                    response = await client.get(pdf_url)
                    if response.status_code != 200:
                        continue
                    if response.content[:4] != b"%PDF":
                        continue
                    text = extract_pdf_text(response.content)
                    staging = ScraperStaging(
                        source_id=source.id,
                        source_site="LahoreHighCourt",
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
                    logger.error("LHC PDF %s error %s", pdf_url, e)
    except Exception as e:
        logger.error("LahoreHighCourt scraper error %s", e)
