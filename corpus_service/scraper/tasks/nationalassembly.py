import re, logging, asyncio
from bs4 import BeautifulSoup
from scraper.net import fetch_policy
from scraper.models import StatutesMaster
from scraper.tasks import outcomes, pdf_intake
logger = logging.getLogger(__name__)

async def scrape_nationalassembly(source, db):
    # Audit F28: the index page is the run's only listing, so a failed index request (network, an
    # F25 refusal, any answer but 200) fails the run; every PDF's outcome is counted, a database error
    # fails the run at once, and a run whose every PDF failed raises SourceRunFailed.
    tally = outcomes.run_tally()
    # Audit F25: index-page PDF links are external input; the NationalAssembly fetch policy
    # refuses (and logs) any link off na.gov.pk, off 443, or resolving to a non-public address.
    async with fetch_policy.fetcher_for("NationalAssembly") as client:
        r = await client.get("https://na.gov.pk/en/legis.php")
        if r.status_code != 200:
            listing = outcomes.Tally()
            listing.item_failed(f"http_{r.status_code}")
            listing.raise_if_all_failed(outcomes.REASON_LISTINGS_FAILED)
        soup = BeautifulSoup(r.text, "html.parser")
        pdf_links = [a.get("href") for a in soup.find_all("a", href=re.compile(r"\.pdf$", re.I)) if a.get_text() and ("Act" in a.get_text() or "Ordinance" in a.get_text())]
        for pdf_url in pdf_links[:20]:
            try:
                full = pdf_url if pdf_url.startswith("http") else f"https://na.gov.pk{pdf_url}" if pdf_url.startswith("/") else f"https://na.gov.pk/en/{pdf_url}"
                # Audit F26: the one bounded PDF path (size cap at the fetch boundary, type and
                # signature checks, raw store by sha256, sandboxed parse). A refusal, an empty body or
                # an unreadable PDF (F28 R16) is a failed document, never an empty success. NA's
                # statutes_master rows have no raw-reference column (spec R5, F26-FU2).
                txt = (await pdf_intake.intake(client, full)).text
                # naive split
                rows = 0
                for chunk in txt.split("\n\n")[:10]:
                    if len(chunk)>100:
                        sm = StatutesMaster(statute_name="National Assembly Act", section_number=chunk[:20], section_text=chunk[:20000], source_site="NationalAssembly", source_url=full)
                        db.add(sm)
                        rows += 1
                await db.commit()
                tally.item_ok(rows)
                await asyncio.sleep(1)
            except outcomes.DocumentRejected as rejected:
                tally.item_failed(rejected)
            except Exception as e:
                if outcomes.is_database_error(e):
                    raise
                logger.error(f"NA pdf {pdf_url} error {e}")
                tally.item_failed(e)
    return tally.finish()
