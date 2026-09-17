from celery import shared_task
import logging, asyncio
from scraper.database import SessionLocal
from sqlalchemy import select
from scraper.models import ScraperSource
logger = logging.getLogger(__name__)

@shared_task(name="scraper.tasks.dispatcher.run_source_job", bind=True, max_retries=3)
def run_source_job(self, source_name: str):
    logger.info(f"Dispatching job for {source_name}")
    try:
        asyncio.run(_run_async(source_name))
    except Exception as e:
        logger.error(f"Job failed for {source_name}: {e}")
        raise self.retry(exc=e, countdown=300)

async def _run_async(source_name: str):
    async with SessionLocal() as db:
        result = await db.execute(select(ScraperSource).where(ScraperSource.source_name==source_name))
        source = result.scalars().first()
        if not source:
            logger.error(f"Source {source_name} not found")
            return
        if not source.is_active:
            logger.info(f"{source_name} inactive, skip")
            return
        if source.trust_level=="blocked":
            logger.info(f"{source_name} blocked, skip")
            return
        # route
        if source_name=="PakistanLawSite":
            from scraper.tasks.pakistanlawsite import scrape_pakistanlawsite
            await scrape_pakistanlawsite(source, db)
        elif source_name=="NasirLawSite":
            from scraper.tasks.nasirlawsite import scrape_nasirlawsite
            await scrape_nasirlawsite(source, db)
        elif source_name=="PakistanCode":
            from scraper.tasks.pakistancode import scrape_pakistancode
            await scrape_pakistancode(source, db)
        elif source_name in {"SindhHighCourt", "SindhHighCourtPublic"}:
            from scraper.tasks.shc import scrape_shc
            await scrape_shc(source, db)
        elif source_name=="SupremeCourt":
            from scraper.tasks.supremecourt import scrape_supremecourt
            await scrape_supremecourt(source, db)
        elif source_name=="LahoreHighCourt":
            from scraper.tasks.lahorehighcourt import scrape_lahorehighcourt
            await scrape_lahorehighcourt(source, db)
        elif source_name=="NationalAssembly":
            from scraper.tasks.nationalassembly import scrape_nationalassembly
            await scrape_nationalassembly(source, db)
