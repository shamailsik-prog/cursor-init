import re, logging, asyncio
from bs4 import BeautifulSoup
from scraper.net import fetch_policy
from scraper.parsers.pdf_extractor import extract_pdf_text
from scraper.models import StatutesMaster
logger = logging.getLogger(__name__)

async def scrape_nationalassembly(source, db):
    # Audit F25: index-page PDF links are external input; the NationalAssembly fetch policy
    # refuses (and logs) any link off na.gov.pk, off 443, or resolving to a non-public address.
    async with fetch_policy.fetcher_for("NationalAssembly") as client:
        try:
            r = await client.get("https://na.gov.pk/en/legis.php")
            soup = BeautifulSoup(r.text, "html.parser")
            pdf_links = [a.get("href") for a in soup.find_all("a", href=re.compile(r"\.pdf$", re.I)) if a.get_text() and ("Act" in a.get_text() or "Ordinance" in a.get_text())]
            for pdf_url in pdf_links[:20]:
                try:
                    full = pdf_url if pdf_url.startswith("http") else f"https://na.gov.pk{pdf_url}" if pdf_url.startswith("/") else f"https://na.gov.pk/en/{pdf_url}"
                    rr = await client.get(full)
                    txt = extract_pdf_text(rr.content)
                    # naive split
                    for chunk in txt.split("\n\n")[:10]:
                        if len(chunk)>100:
                            sm = StatutesMaster(statute_name="National Assembly Act", section_number=chunk[:20], section_text=chunk[:20000], source_site="NationalAssembly", source_url=full)
                            db.add(sm)
                    await db.commit()
                    await asyncio.sleep(1)
                except Exception as e:
                    logger.error(f"NA pdf {pdf_url} error {e}")
        except Exception as e:
            logger.error(f"NA index error {e}")
