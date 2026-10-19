import asyncio, re, logging
from bs4 import BeautifulSoup
from scraper.net import fetch_policy
from scraper.parsers.statute_parser import split_into_sections, detect_statute_name, _extract_number_title_from_chunk
from scraper.parsers.text_cleaner import clean_html
from datetime import datetime, timezone
from scraper.database import SessionLocal
from scraper.models import StatutesStaging
from scraper.source_identity import stamp_metadata
from scraper.tasks import lifecycle, outcomes
logger = logging.getLogger(__name__)

# Audit F21 (spec R12): the confidence statutes_master gave the rows this route wrote on main (its
# column default); the review gate (F20) then decides them like any other record.
STATUTE_CONFIDENCE = 0.85


def _staged(source, url, act_name, short_name, section_number, section_text, section_title=None):
    """One statutes_staging row (audit F21: no source task writes statutes_master; R12). It enters the
    lifecycle at `parsed`, stamped with its source and the harvest run that staged it."""
    return StatutesStaging(
        source_id=source.id,
        source_site="PakistanCode",
        source_url=url,
        job_id=lifecycle.run_job_id(),
        raw_text=section_text,
        extracted_act_name=act_name,
        extracted_short_name=short_name,
        extracted_section_number=section_number,
        extracted_section_title=section_title,
        extracted_section_text=section_text,
        confidence_score=STATUTE_CONFIDENCE,
        parsing_metadata=stamp_metadata(source, {
            "extraction_method": "html",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }),
    )

TARGET_SLUGS = ["ppc1860","crpc1898","cpc1908","constitution1973","limitation-act1908","specific-relief-act1877","transfer-of-property-act1882","contract-act1872","evidence-act1872","companies-act2017"]

async def scrape_pakistancode(source, db):
    # Audit F28: the index request is the run's reachability check, so a failure there (network,
    # an F25 refusal) fails the run; every slug's outcome is counted, a database error fails the run
    # at once, and a run whose every slug failed raises SourceRunFailed.
    tally = outcomes.run_tally()
    # Audit F25: fixed URLs, still through the PakistanCode fetch policy (one boundary for all).
    async with fetch_policy.fetcher_for("PakistanCode", headers={"User-Agent": "Mozilla/5.0"}) as client:
        r = await client.get("https://pakistancode.gov.pk/federal")
        soup = BeautifulSoup(r.text, "html.parser")
        # iterate slugs
        for slug in TARGET_SLUGS:
            try:
                url = f"https://pakistancode.gov.pk/english/statues/details/{slug}"
                rr = await client.get(url)
                if rr.status_code!=200:
                    tally.item_failed(f"http_{rr.status_code}")
                    continue
                soup2 = BeautifulSoup(rr.text, "html.parser")
                title = soup2.find("h1")
                act_name = title.get_text(strip=True) if title else slug
                # find sections
                sections = []
                for div in soup2.find_all("div", class_=re.compile("section")):
                    txt = div.get_text(" ", strip=True)
                    if len(txt)>20:
                        sections.append(txt)
                rows = 0
                if not sections:
                    # fallback parse paragraphs starting digit
                    full_text = clean_html(rr.text)
                    parsed = split_into_sections(full_text, act_name)
                    for p in parsed:
                        db.add(_staged(source, url, act_name, slug[:10], p["section_number"], p["section_text"][:20000],
                                       section_title=p["section_title"][:500]))
                        rows += 1
                else:
                    for sec in sections[:50]:
                        section_number, section_title, _ = _extract_number_title_from_chunk(sec)
                        if not section_number:
                            continue
                        db.add(_staged(source, url, act_name, slug[:10], section_number, sec[:20000],
                                       section_title=section_title[:500] if section_title else None))
                        rows += 1
                await db.commit()
                tally.item_ok(rows)
                await asyncio.sleep(1.5)
            except Exception as e:
                if outcomes.is_database_error(e):
                    raise
                logger.error(f"PakistanCode slug {slug} error {e}")
                tally.item_failed(e)
    return tally.finish()
