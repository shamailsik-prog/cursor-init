import asyncio, re, logging
from bs4 import BeautifulSoup
from scraper.net import fetch_policy
from scraper.parsers.pakistancode_keys import (
    key_div_texts,
    normalise_div_text,
    schedule_container_label,
    suppresses_plain_text_fallback,
)
from scraper.parsers.statute_parser import split_into_sections, detect_statute_name
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


def _staged(source, url, act_name, short_name, section_number, section_text, section_title=None,
           extra_metadata=None):
    """One statutes_staging row (audit F21: no source task writes statutes_master; R12). It enters the
    lifecycle at `parsed`, stamped with its source and the harvest run that staged it."""
    metadata = {
        "extraction_method": "html",
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    if extra_metadata:
        metadata.update(extra_metadata)
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
        parsing_metadata=stamp_metadata(source, metadata),
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
                # FA-F21-017: identity is the locked key in pakistancode_keys, not the first 20
                # characters of the div. Headings are decided before the short-div skip.
                div_nodes = soup2.find_all("div", class_=re.compile("section"))
                harvest_at = datetime.now(timezone.utc).isoformat()
                keyed = key_div_texts(
                    [div.get_text(" ", strip=True) for div in div_nodes],
                    [schedule_container_label(div) for div in div_nodes],
                ) if div_nodes else None
                rows = 0
                if keyed is not None and suppresses_plain_text_fallback(keyed):
                    # Kept body, schedule, preamble, explanation, or numberless divs are the
                    # page. The paragraph splitter is not run, so it cannot collapse two divs
                    # that share a number.
                    act_keys = [item.key for item in keyed.sections]
                    for item in keyed.sections:
                        db.add(_staged(
                            source, url, act_name, slug[:10], item.key, item.text,
                            section_title=item.title,
                            extra_metadata={
                                "section_kind": item.kind,
                                "lookup_number": item.lookup_number,
                                "schedule_label": item.schedule_label,
                                "act_keys": act_keys,
                                "keying": "fa-f21-017",
                                "harvest_at": harvest_at,
                            },
                        ))
                        rows += 1
                else:
                    # No section divs, only short non-heading noise, or only schedule headings.
                    # Headings are staged and do not by themselves retire the act. The paragraph
                    # fallback still runs, and a fallback row whose text is the heading is not
                    # staged a second time. This path carries no act_keys.
                    heading_texts = set()
                    if keyed is not None:
                        for item in keyed.sections:
                            db.add(_staged(
                                source, url, act_name, slug[:10], item.key, item.text,
                                section_title=item.title,
                                extra_metadata={
                                    "section_kind": item.kind,
                                    "lookup_number": item.lookup_number,
                                    "schedule_label": item.schedule_label,
                                    "keying": "fa-f21-017",
                                    "harvest_at": harvest_at,
                                },
                            ))
                            heading_texts.add(normalise_div_text(item.text))
                            rows += 1
                    full_text = clean_html(rr.text)
                    parsed = split_into_sections(full_text, act_name)
                    for p in parsed:
                        body = p["section_text"][:20000]
                        if normalise_div_text(body) in heading_texts:
                            continue
                        title = (p.get("section_title") or "")[:500]
                        db.add(_staged(
                            source, url, act_name, slug[:10], p["section_number"], body,
                            section_title=title,
                            extra_metadata={
                                "section_kind": "fallback",
                                "keying": "fa-f21-017",
                                "harvest_at": harvest_at,
                            },
                        ))
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
