import asyncio
import json
import logging
import re
from collections import deque
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from scraper.net import fetch_policy
from scraper.tasks import outcomes, pdf_intake

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


def _parse_feed_rows(payload_text: str) -> list | None:
    """The rows of a feed payload (``{"d": [...]}`` or ``{"d": "<json list>"}``), or None when the
    payload does not parse (audit F28 R17: an unparseable feed answer is a failed feed request)."""
    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    data = payload.get("d")
    if isinstance(data, str):
        try:
            rows = json.loads(data)
        except json.JSONDecodeError:
            return None
        return rows if isinstance(rows, list) else None
    if isinstance(data, list):
        return data
    return None


def _extract_pdf_urls_from_feed_payload(payload_text: str, feed_url: str) -> list[str]:
    rows = _parse_feed_rows(payload_text)
    if rows is None:
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
        except outcomes.INTERRUPTIONS:
            raise  # Audit F28 R23: the time limit ends the run; it is never a reason to retry the URL
        except Exception as exc:  # pragma: no cover - depends on network path.
            last_error = exc
            if attempt < attempts:
                await asyncio.sleep(pause_seconds * attempt)
    assert last_error is not None
    raise last_error


async def _post_json_with_retries(
    client: fetch_policy.PolicyFetcher,
    url: str,
    payload: dict,
    *,
    attempts: int = 3,
    pause_seconds: float = 1.0,
) -> fetch_policy.FetchedResponse:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await client.post(url, json=payload)
        except fetch_policy.FetchRefused:
            raise  # Audit F25: a refused URL is never retried
        except outcomes.INTERRUPTIONS:
            raise  # Audit F28 R23: the time limit ends the run; it is never a reason to retry the URL
        except Exception as exc:  # pragma: no cover - depends on network path.
            last_error = exc
            if attempt < attempts:
                await asyncio.sleep(pause_seconds * attempt)
    assert last_error is not None
    raise last_error


async def _discover_pdf_urls(tally: outcomes.Tally | None = None) -> tuple[list[str], dict[str, dict[str, str]]]:
    pdf_sources: dict[str, dict[str, str]] = {}
    visited_listing_urls: set[str] = set()
    visited_feed_urls: set[str] = set()
    listing_queue = deque(IHC_LISTING_SEED_URLS)

    # Audit F28: every listing request is counted; when all of them fail the run fails.
    listings = outcomes.Tally()
    # Audit F28 R17: every AJAX feed request too (a failure, a 4xx/5xx, an unparseable payload).
    # Every feed failing with nothing found any other way fails the run; otherwise the feed failures
    # go into the run's tally (``tally``) and make it partial.
    feeds = outcomes.Tally()

    # Audit F25: listing pages are external input. Every request (and every redirect hop)
    # goes through the IslamabadHighCourt fetch policy: https, its hosts on 443, public addresses only.
    async with fetch_policy.fetcher_for("IslamabadHighCourt") as client:
        while listing_queue and len(visited_listing_urls) < 50:
            listing_url = listing_queue.popleft()
            if listing_url in visited_listing_urls:
                continue
            visited_listing_urls.add(listing_url)

            try:
                response = await _request_with_retries(client, listing_url)
            except Exception as e:
                logger.warning("IHC listing request failed %s: %s", listing_url, repr(e))
                listings.item_failed(e)
                continue

            if response.status_code != 200:
                logger.warning(
                    "IHC listing returned status %s for %s",
                    response.status_code,
                    listing_url,
                )
                listings.item_failed(f"http_{response.status_code}")
                continue

            listings.item_ok()
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
                    feeds.item_failed(e)
                    continue
                if feed_response.status_code != 200:
                    logger.warning(
                        "IHC feed returned status %s for %s",
                        feed_response.status_code,
                        feed_url,
                    )
                    feeds.item_failed(f"http_{feed_response.status_code}")
                    continue
                if _parse_feed_rows(feed_response.text) is None:
                    logger.warning("IHC feed returned an unparseable payload for %s", feed_url)
                    feeds.item_failed(outcomes.ERROR_FEED_UNPARSEABLE)
                    continue
                feeds.item_ok()

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
    listings.raise_if_all_failed(outcomes.REASON_LISTINGS_FAILED)
    if tally is not None:
        # Audit F28 R30: the failed listing pages are recorded in the run (listing:<key>), not partial (R17).
        tally.add_listing_failures(listings)
    if not pdf_sources:
        # The feeds were the only discovery path left: all of them failing fails the run, before
        # anything is written, with their error counts (a transient set is retried).
        feeds.raise_if_all_failed(outcomes.REASON_FEEDS_FAILED)
    if tally is not None:
        tally.add_discovery_failures(feeds)
    return list(pdf_sources.keys()), pdf_sources


async def scrape_islamabadhighcourt(source, db):
    # Audit F28: no outer catch. A discovery whose every listing request failed, a database error,
    # or a run whose every PDF failed fails the run; each PDF's outcome is counted.
    from scraper.models import ScraperStaging
    from scraper.source_identity import stamp_metadata

    tally = outcomes.run_tally()
    pdf_urls, pdf_sources = await _discover_pdf_urls(tally=tally)
    if not pdf_urls:
        logger.warning(
            "IslamabadHighCourt: no PDF links discovered from configured listing URLs"
        )
        return tally.finish(note="no PDF links discovered")

    async with fetch_policy.fetcher_for("IslamabadHighCourt") as client:
        for pdf_url in pdf_urls[:60]:
            try:
                # Audit F26: one bounded path per PDF (the size cap at the fetch boundary, the type and
                # signature checks, the raw store by sha256, the sandboxed parse); a refusal is a
                # failed document, counted by its code.
                document = await pdf_intake.intake(client, pdf_url, fetch=_request_with_retries)
                provenance = pdf_sources.get(pdf_url, {})
                staging = ScraperStaging(
                    source_id=source.id,
                    source_site="IslamabadHighCourt",
                    source_url=pdf_url,
                    raw_text=document.text[:50000],
                    raw_pdf_path=document.raw_key,
                    pdf_page_count=document.pages,
                    ocr_applied=document.ocr_applied,
                    confidence_score=0.6,
                    quarantined=True,
                    quarantine_reason="review source",
                    parsing_metadata=stamp_metadata(source, {
                        "listing_url": provenance.get("listing_url"),
                        "feed_url": provenance.get("feed_url"),
                        "discovery_method": provenance.get("discovery_method"),
                        **document.metadata(),
                    }),
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
                logger.error("IslamabadHighCourt PDF %s error %s", pdf_url, e)
                tally.item_failed(e)
    return tally.finish()
