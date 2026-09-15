import httpx, re, asyncio, logging
from bs4 import BeautifulSoup
from scraper.parsers.text_cleaner import clean_html, extract_summary
from scraper.parsers.citation_extractor import extract_citations, score_confidence
from scraper.database import SessionLocal
from scraper.models import ScraperStaging
logger = logging.getLogger(__name__)

REPORTER_URLS = [
    "https://www.nasirlawsite.com/case/scmr.htm",
    "https://www.nasirlawsite.com/case/pld.htm",
    "https://www.nasirlawsite.com/case/clc.htm",
    "https://www.nasirlawsite.com/case/ylr.htm",
    "https://www.nasirlawsite.com/case/mld.htm",
]

async def scrape_nasirlawsite(source, db):
    async with httpx.AsyncClient(timeout=30, headers={"User-Agent":"Mozilla/5.0"}) as client:
        for url in REPORTER_URLS:
            try:
                r = await client.get(url)
                soup = BeautifulSoup(r.text, "html.parser")
                links = [a.get("href") for a in soup.find_all("a", href=True) if "case" in a.get("href","").lower() or ".htm" in a.get("href","")]
                # follow individual case pages (limit for demo)
                for link in links[:20]:
                    full = link if link.startswith("http") else f"https://www.nasirlawsite.com/case/{link}" if not link.startswith("/") else f"https://www.nasirlawsite.com{link}"
                    try:
                        cr = await client.get(full)
                        raw_html = cr.text
                        cleaned = clean_html(raw_html)
                        cits = extract_citations(cleaned)
                        citation = cits[0] if cits else None
                        staging = ScraperStaging(source_site="NasirLawSite", source_url=full, raw_html=raw_html[:50000], raw_text=cleaned[:50000], extracted_citation=citation, extracted_title=soup.title.string if soup.title else None, confidence_score=score_confidence({"citation": citation, "full_text": cleaned}))
                        db.add(staging)
                        await db.commit()
                        await asyncio.sleep(1)
                    except Exception as e:
                        logger.error(f"Nasir case error {link}: {e}")
                await asyncio.sleep(2)
            except Exception as e:
                logger.error(f"Nasir reporter {url} error {e}")
