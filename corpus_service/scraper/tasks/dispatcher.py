from celery import shared_task
import importlib
import logging, asyncio
from scraper.database import SessionLocal
from sqlalchemy import select
from scraper.models import ScraperSource
from scraper.trust import may_harvest, may_publish_directly
logger = logging.getLogger(__name__)

# source_name -> (harvester module, function).
ROUTES = {
    "PakistanLawSite": ("scraper.tasks.pakistanlawsite", "scrape_pakistanlawsite"),
    "NasirLawSite": ("scraper.tasks.nasirlawsite", "scrape_nasirlawsite"),
    "PakistanCode": ("scraper.tasks.pakistancode", "scrape_pakistancode"),
    "SindhHighCourt": ("scraper.tasks.shc", "scrape_shc"),
    "SindhHighCourtPublic": ("scraper.tasks.shc", "scrape_shc"),
    "SupremeCourt": ("scraper.tasks.supremecourt", "scrape_supremecourt"),
    "SupremeCourtPublic": ("scraper.tasks.supremecourt", "scrape_supremecourt"),
    "LahoreHighCourt": ("scraper.tasks.lahorehighcourt", "scrape_lahorehighcourt"),
    "PeshawarHighCourt": ("scraper.tasks.peshawarhighcourt", "scrape_peshawarhighcourt"),
    "PeshawarHighCourtPublic": ("scraper.tasks.peshawarhighcourt", "scrape_peshawarhighcourt"),
    "BalochistanHighCourt": ("scraper.tasks.balochistanhighcourt", "scrape_balochistanhighcourt"),
    "BalochistanHighCourtPublic": ("scraper.tasks.balochistanhighcourt", "scrape_balochistanhighcourt"),
    "IslamabadHighCourt": ("scraper.tasks.islamabadhighcourt", "scrape_islamabadhighcourt"),
    "IslamabadHighCourtPublic": ("scraper.tasks.islamabadhighcourt", "scrape_islamabadhighcourt"),
    "NationalAssembly": ("scraper.tasks.nationalassembly", "scrape_nationalassembly"),
}

# Harvesters that write statutes_master / case_law_master themselves: no staging row, so no
# promotion decision and no quarantine. Audit F20 (FINAL_2 :897, review -> always quarantine): they
# run only for a trusted source. tests/test_trust_policy.py checks that every master writer under
# scraper/tasks is listed here.
DIRECT_PUBLISHER_MODULES = frozenset({"scraper.tasks.pakistancode", "scraper.tasks.nationalassembly"})

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
        # Audit F20: only trusted and review sources are harvested; blocked and any value outside
        # the vocabulary (an un-migrated or drifted row) fail closed.
        if not may_harvest(source.trust_level):
            logger.info("%s trust_level %r is not harvestable, skip", source_name, source.trust_level)
            return
        route = ROUTES.get(source_name)
        if route is None:
            logger.info("%s has no harvester, skip", source_name)
            return
        module_name, function_name = route
        if module_name in DIRECT_PUBLISHER_MODULES and not may_publish_directly(source.trust_level):
            logger.info(
                "%s publishes to statutes_master/case_law_master directly; trust_level %r is not trusted, skip",
                source_name, source.trust_level,
            )
            return
        harvest = getattr(importlib.import_module(module_name), function_name)
        await harvest(source, db)
