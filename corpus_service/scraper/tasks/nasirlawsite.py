import re, asyncio, logging
from urllib.parse import urljoin
from bs4 import BeautifulSoup
from scraper.net import fetch_policy
from scraper.parsers.text_cleaner import clean_html, extract_summary
from scraper.parsers.citation_extractor import extract_citations, score_confidence
from scraper.database import SessionLocal
from scraper.models import ScraperStaging
from scraper.source_identity import stamp_metadata
from scraper.tasks import lifecycle, outcomes
logger = logging.getLogger(__name__)

REPORTER_URLS = [
    "https://www.nasirlawsite.com/case/scmr.htm",
    "https://www.nasirlawsite.com/case/pld.htm",
    "https://www.nasirlawsite.com/case/clc.htm",
    "https://www.nasirlawsite.com/case/ylr.htm",
    "https://www.nasirlawsite.com/case/mld.htm",
]

def _citation_to_str(citation) -> str | None:
    """Persist a string into ScraperStaging.extracted_citation (VARCHAR)."""
    if citation is None:
        return None
    if isinstance(citation, str):
        return citation[:500]
    if isinstance(citation, dict):
        text = citation.get("normalized") or citation.get("raw") or ""
        return (text[:500] if text else None)
    return str(citation)[:500]


def _resolve_link(page_url: str, href: str) -> str | None:
    """A page link resolved against the page actually fetched (so ``//host/x`` is never glued
    onto the Nasir host); None if it cannot be parsed."""
    try:
        return urljoin(page_url, href.strip())
    except ValueError:
        return None


async def scrape_nasirlawsite(source, db):
    # Audit F28: reporter pages are the run's listings and case pages its documents. Each is counted;
    # a case page answering anything but 200 is a failure, never staged; a database error fails
    # the run at once; a run whose every reporter page, or every case page, failed raises
    # SourceRunFailed.
    tally = outcomes.run_tally()
    listings = outcomes.Tally()
    # Audit F25: every request goes through the NasirLawSite fetch policy (https, Nasir hosts on
    # 443, public addresses only, each redirect re-checked). Reporter-page links are external
    # input: a link the policy refuses is logged by the boundary and never requested.
    async with fetch_policy.fetcher_for("NasirLawSite", headers={"User-Agent": "Mozilla/5.0"}) as client:
        for url in REPORTER_URLS:
            try:
                r = await client.get(url)
                if r.status_code != 200:
                    logger.error(f"Nasir reporter {url} returned status {r.status_code}")
                    listings.item_failed(f"http_{r.status_code}")
                    continue
                soup = BeautifulSoup(r.text, "html.parser")
                hrefs = [a.get("href") for a in soup.find_all("a", href=True) if "case" in a.get("href","").lower() or ".htm" in a.get("href","")]
                links = [full for full in (_resolve_link(r.url, href) for href in hrefs) if full and client.allows(full)]
                listings.item_ok()
                # follow individual case pages (limit for demo)
                for full in links[:20]:
                    try:
                        cr = await client.get(full)
                        if cr.status_code != 200:
                            logger.error(f"Nasir case {full} returned status {cr.status_code}")
                            tally.item_failed(f"http_{cr.status_code}")
                            continue
                        raw_html = cr.text
                        cleaned = clean_html(raw_html)
                        cits = extract_citations(cleaned)
                        citation_obj = cits[0] if cits else None
                        citation = _citation_to_str(citation_obj)
                        staging = ScraperStaging(
                            source_id=source.id,
                            source_site="NasirLawSite",
                            job_id=lifecycle.run_job_id(),  # audit F21 (spec R5): the run that staged it
                            source_url=full,
                            raw_html=raw_html[:50000],
                            raw_text=cleaned[:50000],
                            extracted_citation=citation,
                            extracted_title=soup.title.string if soup.title else None,
                            confidence_score=score_confidence({"citation": citation, "full_text": cleaned}),
                            parsing_metadata=stamp_metadata(source),
                        )
                        db.add(staging)
                        await db.commit()
                        tally.item_ok(1)
                        await asyncio.sleep(1)
                    except Exception as e:
                        if outcomes.is_database_error(e):
                            raise
                        logger.error(f"Nasir case error {full}: {e}")
                        tally.item_failed(e)
                await asyncio.sleep(2)
            except Exception as e:
                if outcomes.is_database_error(e):
                    raise
                logger.error(f"Nasir reporter {url} error {e}")
                listings.item_failed(e)
    listings.raise_if_all_failed(outcomes.REASON_LISTINGS_FAILED)
    # Audit F28 R30: the five reporters are fixed, live listing pages (not R17's legacy seeds), so a
    # failed one is recorded and makes the run partial: never an error-free empty run.
    tally.add_listing_failures(listings, makes_partial=True)
    return tally.finish()
