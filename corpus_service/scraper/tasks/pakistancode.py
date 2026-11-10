import asyncio, re, logging
from bs4 import BeautifulSoup
from scraper.net import fetch_policy
from scraper.parsers.pakistancode_keys import (
    act_inventory_is_complete,
    fallback_act_keys,
    key_div_texts,
    normalise_div_text,
    page_has_text_besides_schedule_headings,
    parse_section_number,
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
                    # that share a number. act_keys is those keys in document order when the
                    # inventory is complete, which includes schedule items (FA-17). It is
                    # omitted for an unscoped div, and for a schedule page that also dropped
                    # divs at the cap, so publish will not retire that tail.
                    act_keys = [item.key for item in keyed.sections] if act_inventory_is_complete(keyed) else None
                    for item in keyed.sections:
                        extra = {
                            "section_kind": item.kind,
                            "lookup_number": item.lookup_number,
                            "schedule_label": item.schedule_label,
                            "keying": "fa-f21-017",
                            "harvest_at": harvest_at,
                        }
                        if act_keys is not None:
                            extra["act_keys"] = act_keys
                        db.add(_staged(
                            source, url, act_name, slug[:10], item.key, item.text,
                            section_title=item.title,
                            extra_metadata=extra,
                        ))
                        rows += 1
                else:
                    # No section divs, only short non-heading noise, or only schedule headings.
                    # Headings are staged. They do not by themselves retire the act. A page whose
                    # text is only those headings (and the act title) does not run the splitter,
                    # so the title is not staged as a spurious section. Paragraph sections that
                    # share a number are both kept, under the splitter's N-<sha8> keys. act_keys
                    # is the staged set, and is omitted for an unscoped div or a heading-only
                    # page. Schedule items do not reach this branch: they suppress the splitter.
                    pending = []
                    heading_texts = []
                    if keyed is not None:
                        for item in keyed.sections:
                            pending.append((item.key, item.text, item.title, {
                                "section_kind": item.kind,
                                "lookup_number": item.lookup_number,
                                "schedule_label": item.schedule_label,
                                "keying": "fa-f21-017",
                                "harvest_at": harvest_at,
                            }))
                            heading_texts.append(item.text)
                    full_text = clean_html(rr.text)
                    headings_only = bool(heading_texts) and (
                        keyed is None or all(item.kind == "schedule-heading" for item in keyed.sections)
                    )
                    if headings_only and not page_has_text_besides_schedule_headings(full_text, heading_texts, act_name):
                        parsed = []
                    else:
                        parsed = split_into_sections(full_text, act_name)
                    heading_norm = {normalise_div_text(text) for text in heading_texts}
                    for p in parsed:
                        body = p["section_text"][:20000]
                        if normalise_div_text(body) in heading_norm:
                            continue
                        if heading_texts and not page_has_text_besides_schedule_headings(body, heading_texts, act_name):
                            continue
                        title = (p.get("section_title") or "")[:500]
                        pending.append((p["section_number"], body, title, {
                            "section_kind": "fallback",
                            "keying": "fa-f21-017",
                            "harvest_at": harvest_at,
                        }))
                    # An unparsed single chunk is not an inventory of the act. Staging it keeps
                    # the text, and omitting act_keys means it cannot retire real sections.
                    body_rows = [item for item in pending if item[3]["section_kind"] == "fallback"]
                    parsed_body = [
                        item for item in body_rows
                        if parse_section_number(normalise_div_text(item[1])) is not None
                    ]
                    if body_rows and not parsed_body:
                        act_keys = None
                    else:
                        act_keys = fallback_act_keys(
                            keyed, [(number, extra["section_kind"]) for number, _text, _title, extra in pending],
                        )
                    for number, text, title, extra in pending:
                        if act_keys is not None:
                            extra = {**extra, "act_keys": act_keys}
                        db.add(_staged(
                            source, url, act_name, slug[:10], number, text,
                            section_title=title, extra_metadata=extra,
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
