import logging, time, asyncio
from celery import shared_task
from scraper.database import SessionLocal
from sqlalchemy import select
from scraper.models import EmbeddingQueue, CaseLawMaster, StatutesMaster
from scraper.tasks import job_record, outcomes
logger = logging.getLogger(__name__)

# Audit F28 (spec R13): a batch that fails is a failure. Nothing here catches the batch's own failure
# (a database fault, a missing openai package); a database error inside the item loop fails the batch
# at once; a batch that tried items and completed none raises BatchFailed after the per-item attempt
# counts are committed, so a failed item is never `completed`. The claim (selection, lease, retry
# timing, missing records) is unchanged: that is audit F27.

async def process_embedding_queue():
    from scraper.config import settings
    if not settings.OPENAI_API_KEY:
        logger.info("No OPENAI_API_KEY, skip embeddings")
        return {"outcome": outcomes.OUTCOME_SKIPPED, "reason": "no_openai_api_key", "claimed": 0, "completed": 0, "failed": 0, "missing": 0}
    import openai
    client = openai.AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    tally = outcomes.Tally()
    missing = 0
    async with SessionLocal() as db:
        result = await db.execute(select(EmbeddingQueue).where(EmbeddingQueue.status=="pending").limit(50))
        queue_items = result.scalars().all()
        for item in queue_items:
            try:
                if item.table_name=="case_law_master":
                    res = await db.execute(select(CaseLawMaster).where(CaseLawMaster.id==item.record_id))
                    rec = res.scalars().first()
                    if not rec:
                        missing += 1
                        continue
                    embed_text = f"{rec.citation or ''} {rec.case_title or ''} {rec.full_text[:2000] if rec.full_text else ''}"
                else:
                    res = await db.execute(select(StatutesMaster).where(StatutesMaster.id==item.record_id))
                    rec = res.scalars().first()
                    if not rec:
                        missing += 1
                        continue
                    embed_text = f"{rec.statute_name or ''} {rec.section_number or ''} {rec.section_text[:2000] if rec.section_text else ''}"
                emb = await client.embeddings.create(model="text-embedding-3-small", input=embed_text)
                vector = emb.data[0].embedding
                rec.embedding = vector
                item.status = "completed"
                await db.commit()
                tally.item_ok(1)
                await asyncio.sleep(0.6)  # 100 RPM limit
            except Exception as e:
                if outcomes.is_database_error(e):
                    raise
                logger.error("Embedding failed %s: %s", item.id, outcomes.describe_error(e))
                item.attempts+=1
                item.status="failed" if item.attempts>=3 else "pending"
                await db.commit()
                tally.item_failed(e)
    summary = {
        "outcome": tally.result().outcome,
        "claimed": len(queue_items),
        "completed": tally.succeeded,
        "failed": tally.failed,
        "missing": missing,
        "errors": dict(tally.errors),
    }
    if tally.all_failed:
        raise outcomes.BatchFailed(errors=tally.errors)
    return summary


async def run_embedding_batch(*, celery_task_id=None, worker=None):
    """One batch with its run record: a `scraper_jobs` row (job type `embed`) when the batch claimed
    work or failed; an empty queue or a skipped batch writes none (F28 R13)."""
    started = job_record.utcnow()
    try:
        summary = await process_embedding_queue()
    except Exception as exc:
        errors = dict(getattr(exc, "errors", None) or {})
        failed = sum(errors.values())
        try:
            await job_record.record_batch(
                status=job_record.STATUS_FAILED,
                summary={"outcome": outcomes.OUTCOME_FAILED, "error_class": type(exc).__name__, "errors": errors},
                started=started, attempted=failed, written=0, failed=failed,
                celery_task_id=celery_task_id, worker=worker, exc=exc,
            )
        except Exception as record_exc:
            logger.error(
                "F28: could not record the failed embedding batch (%s); the batch's own error follows: %s",
                outcomes.describe_error(record_exc), outcomes.describe_error(exc),
            )
        raise
    if summary["claimed"]:
        await job_record.record_batch(
            status=job_record.STATUS_COMPLETED, summary=summary, started=started,
            attempted=summary["completed"] + summary["failed"], written=summary["completed"], failed=summary["failed"],
            celery_task_id=celery_task_id, worker=worker,
        )
    return summary


def process_embedding_queue_sync(celery_task_id=None, worker=None):
    return asyncio.run(job_record.in_task_loop(run_embedding_batch(celery_task_id=celery_task_id, worker=worker)))


@shared_task(name="scraper.tasks.embeddings.process_embedding_queue", bind=True)
def process_embedding_queue_task(self):
    # No Celery retry (F28 R7): beat fires this every 5 minutes and each item has its own bound.
    return process_embedding_queue_sync(celery_task_id=self.request.id, worker=self.request.hostname)
