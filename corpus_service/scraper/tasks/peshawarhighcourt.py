import asyncio
import logging
import re
from collections import deque
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from scraper.net import fetch_policy
from scraper.tasks import outcomes

logger = logging.getLogger(__name__)

PHC_ALLOWED_HOSTS = {
    "peshawarhighcourt.gov.pk",
    "www.peshawarhighcourt.gov.pk",
}

PHC_LISTING_SEED_URLS = [
    "https://peshawarhighcourt.gov.pk/app/site/",
    "https://peshawarhighcourt.gov.pk/",
    "https://peshawarhighcourt.gov.pk/app/site/47/c/All_the_Referred,Reported_Judgments.html",
    "https://peshawarhighcourt.gov.pk/app/site/48/c/Reported_Judgments_of_Former_Chief_Justices.html",
    "https://peshawarhighcourt.gov.pk/app/site/77/c/Reported_Judgments_of_Retired_Judges.html",
    "https://peshawarhighcourt.gov.pk/app/site/108/c/Case_Law.html",
    "https://peshawarhighcourt.gov.pk/PHCCMS/reportedJudgments.php",
]

PHC_LISTING_KEYWORDS = (
    "/app/site/47/",
    "/app/site/48/",
    "/app/site/77/",
    "/app/site/108/",
    "reported_judgment",
    "referred,reported_judgments",
    "case_law",
    "phccms/reportedjudgments.php",
    "judgment",
    "judgement",
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


def _is_public_phc_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in PHC_ALLOWED_HOSTS


def _normalize_public_phc_url(base_url: str, href: str) -> str | None:
    href = (href or "").strip()
    if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
        return None

    candidate = urljoin(base_url, href)
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not _is_public_phc_url(candidate):
        return None

    hostname = (parsed.hostname or "").lower()
    if hostname == "www.peshawarhighcourt.gov.pk":
        hostname = "peshawarhighcourt.gov.pk"
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
    return any(keyword in haystack for keyword in PHC_LISTING_KEYWORDS)


def _looks_like_case_pdf(url: str, link_text: str) -> bool:
    url_lower = url.lower()
    if "/phccms/judgments/" in url_lower:
        return True
    if "/image_bank/publications/case_law/" in url_lower:
        return True

    haystack = f"{url_lower} {link_text.lower()}"
    return any(
        keyword in haystack
        for keyword in (
            "judgment",
            "judgement",
            "case law",
            "reported judgment",
            "referencer",
            "citator",
        )
    )


def _extract_listing_and_pdf_links(html: str, base_url: str) -> tuple[list[str], list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    listing_urls: list[str] = []
    pdf_urls: list[str] = []

    for anchor in soup.select("a[href]"):
        normalized = _normalize_public_phc_url(base_url, anchor.get("href", ""))
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
        normalized = _normalize_public_phc_url(base_url, raw_match)
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
    listing_queue = deque(PHC_LISTING_SEED_URLS)

    # Audit F28: every listing request is counted; when all of them fail the run fails.
    listings = outcomes.Tally()

    # Audit F25: listing pages are external input. Every request (and every redirect hop)
    # goes through the PeshawarHighCourt fetch policy: https, its hosts on 443, public addresses only.
    async with fetch_policy.fetcher_for("PeshawarHighCourt") as client:
        while listing_queue and len(visited_listing_urls) < 30:
            listing_url = listing_queue.popleft()
            if listing_url in visited_listing_urls:
                continue
            visited_listing_urls.add(listing_url)
            try:
                response = await _request_with_retries(client, listing_url)
            except Exception as e:
                logger.warning(
                    "PeshawarHighCourt listing request failed %s: %s",
                    listing_url,
                    repr(e),
                )
                listings.item_failed(e)
                continue

            if response.status_code >= 400:
                logger.warning(
                    "PeshawarHighCourt listing returned status %s for %s",
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
        "PeshawarHighCourt discovery visited %d listing pages, found %d PDFs",
        len(visited_listing_urls),
        len(pdf_sources),
    )
    listings.raise_if_all_failed(outcomes.REASON_LISTINGS_FAILED)
    return list(pdf_sources.keys()), pdf_sources


async def scrape_peshawarhighcourt(source, db):
    # Audit F28: no outer catch. A discovery whose every listing request failed, a database error,
    # or a run whose every PDF failed fails the run; each PDF's outcome is counted.
    from scraper.models import ScraperStaging
    from scraper.parsers.pdf_extractor import extract_pdf_text
    from scraper.source_identity import stamp_metadata

    tally = outcomes.run_tally()
    pdf_urls, pdf_sources = await _discover_pdf_urls()
    if not pdf_urls:
        logger.warning(
            "PeshawarHighCourt: no PDF links discovered from configured listing URLs"
        )
        return tally.finish(note="no PDF links discovered")

    async with fetch_policy.fetcher_for("PeshawarHighCourt") as client:
        for pdf_url in pdf_urls[:40]:
            try:
                response = await _request_with_retries(client, pdf_url)
                if response.status_code != 200:
                    tally.item_failed(f"http_{response.status_code}")
                    continue
                if response.content[:4] != b"%PDF":
                    tally.item_failed("not_pdf")
                    continue
                text = extract_pdf_text(response.content)
                staging = ScraperStaging(
                    source_id=source.id,
                    source_site="PeshawarHighCourt",
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
                logger.error("PeshawarHighCourt PDF %s error %s", pdf_url, e)
                tally.item_failed(e)
    return tally.finish()
