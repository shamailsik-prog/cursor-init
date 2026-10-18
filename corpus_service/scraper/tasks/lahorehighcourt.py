import asyncio
import logging
import re
from collections import deque
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from scraper.net import fetch_policy
from scraper.tasks import outcomes, pdf_intake

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


async def _discover_pdf_urls(tally: outcomes.Tally | None = None) -> tuple[list[str], dict[str, str]]:
    pdf_sources: dict[str, str] = {}
    visited_listing_urls: set[str] = set()
    listing_queue = deque(LHC_LISTING_SEED_URLS)

    # Audit F28: every listing request is counted; when all of them fail the run fails.
    listings = outcomes.Tally()

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
                listings.item_failed(e)
                continue

            if response.status_code != 200:
                logger.warning(
                    "LHC listing returned status %s for %s",
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
        "LahoreHighCourt discovery visited %d listing pages, found %d PDFs",
        len(visited_listing_urls),
        len(pdf_sources),
    )
    listings.raise_if_all_failed(outcomes.REASON_LISTINGS_FAILED)
    if tally is not None:
        # Audit F28 R30: the failed listing pages are recorded in the run (listing:<key>), not partial (R17).
        tally.add_listing_failures(listings)
    return list(pdf_sources.keys()), pdf_sources


async def scrape_lahorehighcourt(source, db):
    # Audit F28: no outer catch. A discovery whose every listing request failed, a database error,
    # or a run whose every PDF failed fails the run; each PDF's outcome is counted.
    from scraper.models import ScraperStaging
    from scraper.source_identity import stamp_metadata

    tally = outcomes.run_tally()
    pdf_urls, pdf_sources = await _discover_pdf_urls(tally=tally)
    if not pdf_urls:
        logger.warning(
            "LahoreHighCourt: no PDF links discovered from configured listing URLs"
        )
        return tally.finish(note="no PDF links discovered")

    async with fetch_policy.fetcher_for("LahoreHighCourt") as client:
        for pdf_url in pdf_urls[:20]:
            try:
                # Audit F26: one bounded path per PDF (the size cap at the fetch boundary, the type and
                # signature checks, the raw store by sha256, the sandboxed parse); a refusal is a
                # failed document, counted by its code.
                document = await pdf_intake.intake(client, pdf_url)
                staging = ScraperStaging(
                    source_id=source.id,
                    source_site="LahoreHighCourt",
                    source_url=pdf_url,
                    raw_text=document.text[:50000],
                    raw_pdf_path=document.raw_key,
                    pdf_page_count=document.pages,
                    ocr_applied=document.ocr_applied,
                    confidence_score=0.6,
                    quarantined=True,
                    quarantine_reason="review source",
                    parsing_metadata=stamp_metadata(
                        source, {"listing_url": pdf_sources.get(pdf_url), **document.metadata()}
                    ),
                )
                db.add(staging)
                await db.commit()
                tally.item_ok(1)
                await asyncio.sleep(1)
            except outcomes.DocumentRejected as rejected:
                tally.item_failed(rejected)
            except Exception as e:
                if outcomes.is_database_error(e):
                    raise
                logger.error("LHC PDF %s error %s", pdf_url, e)
                tally.item_failed(e)
    return tally.finish()
