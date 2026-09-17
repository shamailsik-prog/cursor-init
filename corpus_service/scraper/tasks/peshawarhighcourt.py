import asyncio
import logging
import re
from collections import deque
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

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


async def _discover_pdf_urls() -> tuple[list[str], dict[str, str]]:
    pdf_sources: dict[str, str] = {}
    visited_listing_urls: set[str] = set()
    listing_queue = deque(PHC_LISTING_SEED_URLS)

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        follow_redirects=True,
    ) as client:
        while listing_queue and len(visited_listing_urls) < 30:
            listing_url = listing_queue.popleft()
            if listing_url in visited_listing_urls:
                continue
            visited_listing_urls.add(listing_url)
            try:
                response = await client.get(listing_url)
            except Exception as e:
                logger.warning("PeshawarHighCourt listing request failed %s: %s", listing_url, e)
                continue

            if response.status_code >= 400:
                logger.warning(
                    "PeshawarHighCourt listing returned status %s for %s",
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
        "PeshawarHighCourt discovery visited %d listing pages, found %d PDFs",
        len(visited_listing_urls),
        len(pdf_sources),
    )
    return list(pdf_sources.keys()), pdf_sources


async def scrape_peshawarhighcourt(source, db):
    try:
        from scraper.models import ScraperStaging
        from scraper.parsers.pdf_extractor import extract_pdf_text

        pdf_urls, pdf_sources = await _discover_pdf_urls()
        if not pdf_urls:
            logger.warning(
                "PeshawarHighCourt: no PDF links discovered from configured listing URLs"
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
                        source_site="PeshawarHighCourt",
                        source_url=pdf_url,
                        raw_text=text[:50000],
                        confidence_score=0.6,
                        quarantined=True,
                        quarantine_reason="review source",
                        parsing_metadata={
                            "listing_url": pdf_sources.get(pdf_url),
                            "source_name": source.source_name,
                        },
                    )
                    db.add(staging)
                    await db.commit()
                    await asyncio.sleep(1)
                except Exception as e:
                    logger.error("PeshawarHighCourt PDF %s error %s", pdf_url, e)
    except Exception as e:
        logger.error("PeshawarHighCourt scraper error %s", e)
