from celery import shared_task
import importlib
import logging, asyncio
from scraper.database import SessionLocal
from sqlalchemy import select
from scraper.models import ScraperSource
from scraper.tasks import job_record, outcomes
from scraper.trust import may_harvest, may_publish_directly
logger = logging.getLogger(__name__)

# Audit F28 (spec docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md): a run
# that could not do its work ends as a Celery FAILURE and a `failed` scraper_jobs row; a run that
# worked and found nothing is a success with a count. Every attempt is recorded (job_record), only a
# transient fault is retried (outcomes.will_retry), with backoff 300, 600, 1200 s, at most 3 times.

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

@shared_task(name="scraper.tasks.dispatcher.run_source_job", bind=True, max_retries=outcomes.MAX_RETRIES)
def run_source_job(self, source_name: str):
    logger.info("Dispatching job for %s", source_name)
    attempt = int(self.request.retries or 0)
    # A direct call (no worker, no broker) cannot be retried, so its record says max_retries 0.
    max_retries = 0 if self.request.called_directly else int(self.max_retries)
    try:
        return asyncio.run(job_record.in_task_loop(run_source(
            source_name,
            celery_task_id=self.request.id,
            worker=self.request.hostname,
            attempt=attempt,
            max_retries=max_retries,
        )))
    except Exception as e:
        logger.error("Job failed for %s: %s", source_name, outcomes.describe_error(e))
        if outcomes.will_retry(e, attempt, max_retries):
            raise self.retry(exc=e, countdown=outcomes.retry_countdown(attempt))
        raise


async def run_source(source_name: str, *, celery_task_id=None, worker=None, attempt=0, max_retries=outcomes.MAX_RETRIES):
    """One recorded attempt of a source job (F28 R1-R9). Returns the run summary, or raises the
    failure after recording it: Celery decides on a retry from the same outcomes.will_retry."""
    started = job_record.utcnow()
    job_id = await job_record.start(
        source_name, celery_task_id=celery_task_id, worker=worker, attempt=attempt, max_retries=max_retries
    )
    tally = outcomes.Tally()
    try:
        with outcomes.bind_run_tally(tally):
            decision = await _run_async(source_name)
        if isinstance(decision, outcomes.Refused):
            raise outcomes.SourceRefused(source_name, decision.reason)
        if not isinstance(decision, outcomes.Skipped) and not isinstance(decision, outcomes.HarvestResult):
            raise outcomes.HarvesterContractError(source_name, decision)
    except Exception as exc:
        retry_in = outcomes.retry_countdown(attempt) if outcomes.will_retry(exc, attempt, max_retries) else None
        await job_record.finish_failed(
            job_id, source_name, exc, tally=tally, started=started, attempt=attempt, max_retries=max_retries,
            retry_in=retry_in,
        )
        raise
    if isinstance(decision, outcomes.Skipped):
        try:
            return await job_record.finish_skipped(job_id, source_name, decision.reason, started)
        except Exception as exc:
            raise outcomes.RunRecordFailed(source_name) from exc
    try:
        return await job_record.finish_completed(job_id, source_name, decision, started)
    except Exception as exc:
        raise outcomes.RunRecordFailed(source_name) from exc


async def _run_async(source_name: str):
    """Decide whether the source runs, and run it. Returns ``outcomes.Skipped`` (a policy decision),
    ``outcomes.Refused`` (the source cannot be run: F28 R5) or the harvester's own result; a harvest
    failure propagates."""
    async with SessionLocal() as db:
        result = await db.execute(select(ScraperSource).where(ScraperSource.source_name==source_name))
        source = result.scalars().first()
        if not source:
            logger.error(f"Source {source_name} not found")
            return outcomes.Refused("source_not_found")
        if not source.is_active:
            logger.info(f"{source_name} inactive, skip")
            return outcomes.Skipped("inactive")
        # Audit F20: only trusted and review sources are harvested; blocked and any value outside
        # the vocabulary (an un-migrated or drifted row) fail closed.
        if not may_harvest(source.trust_level):
            logger.info("%s trust_level %r is not harvestable, skip", source_name, source.trust_level)
            return outcomes.Skipped("trust_level_not_harvestable")
        route = ROUTES.get(source_name)
        if route is None:
            logger.info("%s has no harvester, skip", source_name)
            return outcomes.Refused("no_harvester")
        if not (isinstance(route, tuple) and len(route) == 3 and route[2] in ROUTE_KINDS):
            kind = route[2] if isinstance(route, tuple) and len(route) == 3 else None
            logger.warning("%s route declares no valid kind (%r), refused", source_name, kind)
            return outcomes.Refused("invalid_route_kind")
        module_name, function_name, kind = route
        if kind == ROUTE_DIRECT and not may_publish_directly(source.trust_level):
            logger.info(
                "%s publishes to statutes_master/case_law_master directly; trust_level %r is not trusted, skip",
                source_name, source.trust_level,
            )
            return outcomes.Skipped("direct_route_needs_trusted")
        harvest = getattr(importlib.import_module(module_name), function_name)
        return await harvest(source, db)
