import asyncio
import json
import logging
import re
from collections import deque
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

IHC_ALLOWED_HOSTS = {
    "ihc.gov.pk",
    "www.ihc.gov.pk",
    "mis.ihc.gov.pk",
    "www.mis.ihc.gov.pk",
}

IHC_LISTING_SEED_URLS = [
    "https://ihc.gov.pk/",
    "https://mis.ihc.gov.pk/",
    "https://mis.ihc.gov.pk/frmJgmnt.aspx?jgs=1",
    "https://mis.ihc.gov.pk/frmJgmnt.aspx?jgs=0",
    "https://mis.ihc.gov.pk/frmSrchOrdr.aspx",
    "https://mis.ihc.gov.pk/frmJudges.aspx?jgs=20",
]

IHC_LISTING_KEYWORDS = (
    "frmjgmnt",
    "frmjudges",
    "frmsrchordr",
    "frmrdjgmnt",
    "judgment",
    "judgement",
    "order",
    "cause",
    "case",
)

IHC_CASE_PDF_KEYWORDS = (
    "/attachments/judgements/",
    "judgment",
    "judgement",
    "appeal",
    "petition",
    "w.p.",
    "crl",
    "ylr",
    "clc",
    "pld",
)

IHC_ALLOWED_FEED_METHODS = {"getlatestjgmntsnew"}

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
INLINE_FEED_PATTERN = re.compile(
    r"(?:https?://[^\s\"'<>]*?/)?/?ihc\.asmx/[A-Za-z0-9_]+",
    flags=re.IGNORECASE,
)


def _dedupe_preserve_order(urls: list[str]) -> list[str]:
    return list(dict.fromkeys(urls))


def _is_public_ihc_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in IHC_ALLOWED_HOSTS


def _normalize_public_ihc_url(base_url: str, href: str) -> str | None:
    href = (href or "").strip()
    if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
        return None

    candidate = urljoin(base_url, href)
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not _is_public_ihc_url(candidate):
        return None

    hostname = (parsed.hostname or "").lower()
    if hostname == "www.ihc.gov.pk":
        hostname = "ihc.gov.pk"
    if hostname == "www.mis.ihc.gov.pk":
        hostname = "mis.ihc.gov.pk"
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
    return any(keyword in haystack for keyword in IHC_LISTING_KEYWORDS)


def _looks_like_case_pdf(url: str, link_text: str) -> bool:
    url_lower = url.lower()
    if "/attachments/judgements/" in url_lower:
        return True
    haystack = f"{url_lower} {link_text.lower()}"
    return any(keyword in haystack for keyword in IHC_CASE_PDF_KEYWORDS)


def _extract_listing_and_pdf_links(html: str, base_url: str) -> tuple[list[str], list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    listing_urls: list[str] = []
    pdf_urls: list[str] = []

    for anchor in soup.find_all("a"):
        link_text = anchor.get_text(" ", strip=True)

        normalized_href = _normalize_public_ihc_url(base_url, anchor.get("href", ""))
        if normalized_href:
            if _looks_like_pdf_url(normalized_href) and _looks_like_case_pdf(normalized_href, link_text):
                pdf_urls.append(normalized_href)
            if _looks_like_listing_url(normalized_href, link_text):
                listing_urls.append(normalized_href)

        for attribute in ("data-src", "data-href", "data-url", "data-file", "data-pdf"):
            normalized_data_url = _normalize_public_ihc_url(base_url, anchor.get(attribute, ""))
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
        normalized = _normalize_public_ihc_url(base_url, raw_match)
        if normalized and _looks_like_pdf_url(normalized) and _looks_like_case_pdf(normalized, ""):
            pdf_urls.append(normalized)

    unescaped_html = html.replace("\\/", "/")
    for raw_match in INLINE_PDF_URL_PATTERN.findall(unescaped_html):
        normalized = _normalize_public_ihc_url(base_url, raw_match)
        if normalized and _looks_like_pdf_url(normalized) and _looks_like_case_pdf(normalized, ""):
            pdf_urls.append(normalized)

    return _dedupe_preserve_order(listing_urls), _dedupe_preserve_order(pdf_urls)


def _extract_feed_urls(html: str, base_url: str) -> list[str]:
    feed_urls: list[str] = []
    unescaped_html = html.replace("\\/", "/")
    for raw_match in INLINE_FEED_PATTERN.findall(unescaped_html):
        normalized = _normalize_public_ihc_url(base_url, raw_match)
        if not normalized:
            continue
        path = urlparse(normalized).path.lower()
        if not path.startswith("/ihc.asmx/"):
            continue
        method_name = path.rsplit("/", 1)[-1]
        if method_name in IHC_ALLOWED_FEED_METHODS:
            feed_urls.append(normalized)
    return _dedupe_preserve_order(feed_urls)


def _extract_pdf_urls_from_feed_payload(payload_text: str, feed_url: str) -> list[str]:
    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        return []

    data = payload.get("d")
    if isinstance(data, str):
        try:
            rows = json.loads(data)
        except json.JSONDecodeError:
            return []
    elif isinstance(data, list):
        rows = data
    else:
        return []

    pdf_urls: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        attachment = str(row.get("ATTACHMENTS", "")).strip()
        if not attachment:
            continue
        normalized = _normalize_public_ihc_url(feed_url, attachment)
        if not normalized:
            continue
        if _looks_like_pdf_url(normalized) and _looks_like_case_pdf(normalized, str(row.get("CASENO", ""))):
            pdf_urls.append(normalized)
    return _dedupe_preserve_order(pdf_urls)


async def _request_with_retries(
    client: httpx.AsyncClient,
    url: str,
    *,
    attempts: int = 3,
    pause_seconds: float = 1.0,
) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await client.get(url)
        except Exception as exc:  # pragma: no cover - depends on network path.
            last_error = exc
            if attempt < attempts:
                await asyncio.sleep(pause_seconds * attempt)
    assert last_error is not None
    raise last_error


async def _post_json_with_retries(
    client: httpx.AsyncClient,
    url: str,
    payload: dict,
    *,
    attempts: int = 3,
    pause_seconds: float = 1.0,
) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await client.post(url, json=payload)
        except Exception as exc:  # pragma: no cover - depends on network path.
            last_error = exc
            if attempt < attempts:
                await asyncio.sleep(pause_seconds * attempt)
    assert last_error is not None
    raise last_error


async def _discover_pdf_urls() -> tuple[list[str], dict[str, dict[str, str]]]:
    pdf_sources: dict[str, dict[str, str]] = {}
    visited_listing_urls: set[str] = set()
    visited_feed_urls: set[str] = set()
    listing_queue = deque(IHC_LISTING_SEED_URLS)

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        follow_redirects=True,
    ) as client:
        while listing_queue and len(visited_listing_urls) < 50:
            listing_url = listing_queue.popleft()
            if listing_url in visited_listing_urls:
                continue
            visited_listing_urls.add(listing_url)

            try:
                response = await _request_with_retries(client, listing_url)
            except Exception as e:
                logger.warning("IHC listing request failed %s: %s", listing_url, repr(e))
                continue

            if response.status_code >= 400:
                logger.warning(
                    "IHC listing returned status %s for %s",
                    response.status_code,
                    listing_url,
                )
                continue

            child_listings, discovered_pdfs = _extract_listing_and_pdf_links(response.text, str(response.url))
            for pdf_url in discovered_pdfs:
                pdf_sources.setdefault(
                    pdf_url,
                    {
                        "listing_url": listing_url,
                        "discovery_method": "markup",
                    },
                )

            for child_url in child_listings:
                if child_url not in visited_listing_urls and child_url not in listing_queue:
                    listing_queue.append(child_url)

            feed_urls = _extract_feed_urls(response.text, str(response.url))
            for feed_url in feed_urls:
                if feed_url in visited_feed_urls:
                    continue
                visited_feed_urls.add(feed_url)
                try:
                    feed_response = await _post_json_with_retries(client, feed_url, {})
                except Exception as e:
                    logger.warning("IHC feed request failed %s: %s", feed_url, repr(e))
                    continue
                if feed_response.status_code >= 400:
                    logger.warning(
                        "IHC feed returned status %s for %s",
                        feed_response.status_code,
                        feed_url,
                    )
                    continue

                for pdf_url in _extract_pdf_urls_from_feed_payload(feed_response.text, feed_url):
                    pdf_sources.setdefault(
                        pdf_url,
                        {
                            "listing_url": listing_url,
                            "feed_url": feed_url,
                            "discovery_method": "ajax_feed",
                        },
                    )

    logger.info(
        "IslamabadHighCourt discovery visited %d listing pages and %d feeds, found %d PDFs",
        len(visited_listing_urls),
        len(visited_feed_urls),
        len(pdf_sources),
    )
    return list(pdf_sources.keys()), pdf_sources


async def scrape_islamabadhighcourt(source, db):
    try:
        from scraper.models import ScraperStaging
        from scraper.parsers.pdf_extractor import extract_pdf_text
        from scraper.source_identity import stamp_metadata

        pdf_urls, pdf_sources = await _discover_pdf_urls()
        if not pdf_urls:
            logger.warning(
                "IslamabadHighCourt: no PDF links discovered from configured listing URLs"
            )
            return

        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            for pdf_url in pdf_urls[:60]:
                try:
                    response = await _request_with_retries(client, pdf_url)
                    if response.status_code != 200:
                        continue
                    if response.content[:4] != b"%PDF":
                        continue
                    text = extract_pdf_text(response.content)
                    provenance = pdf_sources.get(pdf_url, {})
                    staging = ScraperStaging(
                        source_id=source.id,
                        source_site="IslamabadHighCourt",
                        source_url=pdf_url,
                        raw_text=text[:50000],
                        confidence_score=0.6,
                        quarantined=True,
                        quarantine_reason="review source",
                        parsing_metadata=stamp_metadata(source, {
                            "listing_url": provenance.get("listing_url"),
                            "feed_url": provenance.get("feed_url"),
                            "discovery_method": provenance.get("discovery_method"),
                        }),
                    )
                    db.add(staging)
                    await db.commit()
                    await asyncio.sleep(1)
                except Exception as e:
                    logger.error("IslamabadHighCourt PDF %s error %s", pdf_url, e)
    except Exception as e:
        logger.error("IslamabadHighCourt scraper error %s", e)
