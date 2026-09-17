import asyncio
import logging
from urllib.parse import urljoin

import httpx

logger = logging.getLogger(__name__)

LHC_LISTING_CANDIDATES = [
    "https://lhc.gov.pk/judgments",
    "https://lhc.gov.pk/reported-judgments",
    "https://lhc.gov.pk/judgment-search",
]


async def _discover_pdf_urls() -> tuple[list[str], str | None]:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            for listing_url in LHC_LISTING_CANDIDATES:
                try:
                    await page.goto(listing_url, timeout=30000)
                    await page.wait_for_load_state("networkidle", timeout=30000)
                    links = await page.eval_on_selector_all(
                        "a[href]",
                        "els => els.map(e => e.getAttribute('href')).filter(Boolean)",
                    )
                    pdf_urls = []
                    for href in links:
                        lower = href.lower()
                        if ".pdf" in lower:
                            pdf_urls.append(urljoin(listing_url, href))
                    if pdf_urls:
                        # Preserve page order while deduplicating.
                        unique = list(dict.fromkeys(pdf_urls))
                        return unique, listing_url
                except Exception as e:
                    logger.warning("LHC listing failed %s: %s", listing_url, e)
            return [], None
        finally:
            await browser.close()


async def scrape_lahorehighcourt(source, db):
    try:
        from scraper.models import ScraperStaging
        from scraper.parsers.pdf_extractor import extract_pdf_text

        pdf_urls, listing_url = await _discover_pdf_urls()
        if not pdf_urls:
            logger.warning(
                "LahoreHighCourt: no PDF links discovered from configured listing URLs"
            )
            return

        async with httpx.AsyncClient(timeout=60) as client:
            for pdf_url in pdf_urls[:20]:
                try:
                    response = await client.get(pdf_url)
                    if response.status_code != 200:
                        continue
                    if response.content[:4] != b"%PDF":
                        continue
                    text = extract_pdf_text(response.content)
                    staging = ScraperStaging(
                        source_site="LahoreHighCourt",
                        source_url=pdf_url,
                        raw_text=text[:50000],
                        confidence_score=0.6,
                        quarantined=True,
                        quarantine_reason="review source",
                        parsing_metadata={"listing_url": listing_url},
                    )
                    db.add(staging)
                    await db.commit()
                    await asyncio.sleep(1)
                except Exception as e:
                    logger.error("LHC PDF %s error %s", pdf_url, e)
    except Exception as e:
        logger.error("LahoreHighCourt scraper error %s", e)
