from celery import Celery
from scraper.config import settings
import logging

logger = logging.getLogger(__name__)

app = Celery("legal_scraper", broker=settings.REDIS_URL, backend=settings.REDIS_URL)
app.conf.update(
    timezone=settings.TIMEZONE,
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_time_limit=3600,
    task_soft_time_limit=3300,
    task_default_queue="celery",
    beat_schedule={
        "scrape-pakistanlawsite": {"task": "scraper.tasks.dispatcher.run_source_job", "schedule": 6 * 3600, "args": ("PakistanLawSite",)},
        "scrape-nasirlawsite": {"task": "scraper.tasks.dispatcher.run_source_job", "schedule": 6 * 3600, "args": ("NasirLawSite",)},
        "scrape-pakistancode": {"task": "scraper.tasks.dispatcher.run_source_job", "schedule": 48 * 3600, "args": ("PakistanCode",)},
        "scrape-shc": {"task": "scraper.tasks.dispatcher.run_source_job", "schedule": 12 * 3600, "args": ("SindhHighCourt",)},
        "scrape-supremecourt": {"task": "scraper.tasks.dispatcher.run_source_job", "schedule": 12 * 3600, "args": ("SupremeCourt",)},
        "scrape-lahorehighcourt": {"task": "scraper.tasks.dispatcher.run_source_job", "schedule": 12 * 3600, "args": ("LahoreHighCourt",)},
        "scrape-na": {"task": "scraper.tasks.dispatcher.run_source_job", "schedule": 168 * 3600, "args": ("NationalAssembly",)},
        "process-embeddings": {"task": "scraper.tasks.embeddings.process_embedding_queue", "schedule": 300},
        "cross-ref": {"task": "scraper.tasks.cross_reference.cross_reference_citations", "schedule": 86400},
    },
)

# Register @shared_task modules so beat schedule names resolve.
import scraper.tasks.dispatcher  # noqa: E402,F401
import scraper.tasks.embeddings  # noqa: E402,F401
import scraper.tasks.cross_reference  # noqa: E402,F401

logger.info("Celery app configured with beat schedule %s", list(app.conf.beat_schedule.keys()))
