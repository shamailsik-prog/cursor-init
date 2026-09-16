import logging, asyncio
logger = logging.getLogger(__name__)
async def scrape_supremecourt(source, db):
    try:
        from playwright.async_api import async_playwright
        from scraper.parsers.pdf_extractor import extract_pdf_text
        import httpx
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            await page.goto("https://www.supremecourt.gov.pk/judgements/", timeout=30000)
            await page.wait_for_load_state("networkidle", timeout=30000)
            links = await page.query_selector_all("a[href$='.pdf']")
            pdf_urls = [await link.get_attribute("href") for link in links]
            await browser.close()
        async with httpx.AsyncClient(timeout=60) as client:
            for pdf_url in pdf_urls[:20]:
                try:
                    full_url = pdf_url if pdf_url.startswith("http") else f"https://www.supremecourt.gov.pk{pdf_url}"
                    r = await client.get(full_url)
                    text = extract_pdf_text(r.content)
                    from scraper.models import ScraperStaging
                    st = ScraperStaging(source_site="SupremeCourt", source_url=full_url, raw_text=text[:50000], confidence_score=0.6, quarantined=True, quarantine_reason="review source")
                    db.add(st)
                    await db.commit()
                    await asyncio.sleep(1)
                except Exception as e:
                    logger.error(f"SC pdf {pdf_url} error {e}")
    except Exception as e:
        logger.error(f"SupremeCourt error {e}")
