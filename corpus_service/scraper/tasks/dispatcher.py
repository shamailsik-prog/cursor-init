from celery import shared_task
import importlib
import logging, asyncio
from scraper.database import SessionLocal
from sqlalchemy import select
from scraper.models import ScraperSource
from scraper.trust import may_harvest, may_publish_directly
logger = logging.getLogger(__name__)

# What a harvester does with what it fetches (audit F20, PR #48 re-audit round 2):
#   staging - writes scraper_staging rows only; promotion makes the trust decision later.
#   direct  - writes statutes_master / case_law_master itself, so there is no promotion decision
#             and no quarantine. FINAL_2 :897 (review -> always quarantine): runs only for a
#             trusted source.
# Every route declares one; a route with no kind or any other value is refused (fail closed).
# tests/test_trust_policy.py scans all of scraper/ for master-table writes and requires every
# writing module to be a `direct` route here or on its reviewed allowlist.
ROUTE_STAGING = "staging"
ROUTE_DIRECT = "direct"
ROUTE_KINDS = frozenset({ROUTE_STAGING, ROUTE_DIRECT})

# source_name -> (harvester module, function, kind).
ROUTES = {
    "PakistanLawSite": ("scraper.tasks.pakistanlawsite", "scrape_pakistanlawsite", ROUTE_STAGING),
    "NasirLawSite": ("scraper.tasks.nasirlawsite", "scrape_nasirlawsite", ROUTE_STAGING),
    "PakistanCode": ("scraper.tasks.pakistancode", "scrape_pakistancode", ROUTE_DIRECT),
    "SindhHighCourt": ("scraper.tasks.shc", "scrape_shc", ROUTE_STAGING),
    "SindhHighCourtPublic": ("scraper.tasks.shc", "scrape_shc", ROUTE_STAGING),
    "SupremeCourt": ("scraper.tasks.supremecourt", "scrape_supremecourt", ROUTE_STAGING),
    "SupremeCourtPublic": ("scraper.tasks.supremecourt", "scrape_supremecourt", ROUTE_STAGING),
    "LahoreHighCourt": ("scraper.tasks.lahorehighcourt", "scrape_lahorehighcourt", ROUTE_STAGING),
    "PeshawarHighCourt": ("scraper.tasks.peshawarhighcourt", "scrape_peshawarhighcourt", ROUTE_STAGING),
    "PeshawarHighCourtPublic": ("scraper.tasks.peshawarhighcourt", "scrape_peshawarhighcourt", ROUTE_STAGING),
    "BalochistanHighCourt": ("scraper.tasks.balochistanhighcourt", "scrape_balochistanhighcourt", ROUTE_STAGING),
    "BalochistanHighCourtPublic": ("scraper.tasks.balochistanhighcourt", "scrape_balochistanhighcourt", ROUTE_STAGING),
    "IslamabadHighCourt": ("scraper.tasks.islamabadhighcourt", "scrape_islamabadhighcourt", ROUTE_STAGING),
    "IslamabadHighCourtPublic": ("scraper.tasks.islamabadhighcourt", "scrape_islamabadhighcourt", ROUTE_STAGING),
    "NationalAssembly": ("scraper.tasks.nationalassembly", "scrape_nationalassembly", ROUTE_DIRECT),
}

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
        if not (isinstance(route, tuple) and len(route) == 3 and route[2] in ROUTE_KINDS):
            kind = route[2] if isinstance(route, tuple) and len(route) == 3 else None
            logger.warning("%s route declares no valid kind (%r), refused", source_name, kind)
            return
        module_name, function_name, kind = route
        if kind == ROUTE_DIRECT and not may_publish_directly(source.trust_level):
            logger.info(
                "%s publishes to statutes_master/case_law_master directly; trust_level %r is not trusted, skip",
                source_name, source.trust_level,
            )
            return
        harvest = getattr(importlib.import_module(module_name), function_name)
        await harvest(source, db)
