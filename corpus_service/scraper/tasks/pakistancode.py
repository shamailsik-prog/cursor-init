import asyncio, re, logging, hashlib
from collections import Counter
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

# FA-F21-006/010: the heading words of a numberless div that is staged even when it is short.
_HEADING_WORDS = {"preamble", "explanation", "explanations", "illustration", "illustrations", "proviso",
                  "schedule", "appendix", "annex", "annexure", "form", "table", "part", "chapter"}
_ORDINALS = {"the", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"}
_MAX_DIVS = 50


def _heading_kind(text):
    """The slugified heading word of a numberless div ("Preamble." -> "preamble", "THE FIRST
    SCHEDULE" -> "schedule"); "unnumbered" when it has no word."""
    words = [w for w in re.findall(r"[a-z]+", text.lower()[:80]) if w not in _ORDINALS]
    return words[0] if words else "unnumbered"


def _sha8(text):
    return hashlib.sha256(" ".join(text.split()).encode("utf-8")).hexdigest()[:8]


def _keyed_sections(slug, divs):
    """(section_number, text, title, numbered) for every div.section of one act page, in page order.
    Keys are anchored on content, never on position (FA-F21-008), so inserting or reordering divs
    does not change any other div's key:
    - a numberless div (Preamble, Explanation, Schedule) is "<kind>-<sha8>": its heading word and
      the first 8 hex characters of sha256 of its whitespace-normalised text;
    - a number that appears once on the page stays plain ("1"); a number that appears more than once
      is "<num>-<sha8>" for EVERY occurrence. Parsed numbers never hold a hyphen, so these keys cannot
      collide with a real section number.
    A div of 20 characters or fewer is skipped unless it is a heading (FA-F21-010); a skipped div does
    not count toward the per-page cap. Every skip is logged, and the page's counts are logged (no
    silent loss, FA-F21-006)."""
    parsed, skipped = [], 0
    for position, div in enumerate(divs):
        txt = div.get_text(" ", strip=True)
        short = len(txt) <= 20 and _heading_kind(txt) not in _HEADING_WORDS
        if short or len(parsed) >= _MAX_DIVS:
            skipped += 1
            logger.warning("pakistancode.div_skipped slug=%s position=%d reason=%s chars=%d", slug, position,
                           "too_short" if short else "over_cap", len(txt))
            continue
        number, title, _ = _extract_number_title_from_chunk(txt)
        parsed.append((number, txt, title or None))
    repeated = Counter(number for number, _txt, _title in parsed if number)
    out = []
    for number, txt, title in parsed:
        if not number:
            key = f"{_heading_kind(txt)}-{_sha8(txt)}"
        else:
            key = f"{number}-{_sha8(txt)}" if repeated[number] > 1 else number
        out.append((key, txt, title, bool(number)))
    numbered = sum(repeated.values())
    logger.info("pakistancode.staged slug=%s numbered=%d numberless=%d skipped=%d", slug, numbered,
                len(out) - numbered, skipped)
    return out

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
                keyed = _keyed_sections(slug, soup2.find_all("div", class_=re.compile("section")))
                rows = [(key, sec, section_title) for key, sec, section_title, _numbered in keyed]
                if not any(numbered for *_rest, numbered in keyed):
                    # fallback when no div.section rows or none had extractable numbers (e.g. Article N)
                    full_text = clean_html(rr.text)
                    parsed = split_into_sections(full_text, act_name)
                    rows = [(p["section_number"], p["section_text"], p["section_title"]) for p in parsed]
                for section_number, sec, section_title in rows:
                    db.add(_staged(source, url, act_name, slug[:10], section_number, sec[:20000],
                                   section_title=section_title[:500] if section_title else None))
                rows = len(rows)
                await db.commit()
                tally.item_ok(rows)
                await asyncio.sleep(1.5)
            except Exception as e:
                if outcomes.is_database_error(e):
                    raise
                logger.error(f"PakistanCode slug {slug} error {e}")
                tally.item_failed(e)
    return tally.finish()
