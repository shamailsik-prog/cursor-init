"""Audit F28: the durable record of a corpus job run and its source's freshness.

Spec: docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md (rulings R8-R12, R18-R21, R24).

* One ``scraper_jobs`` row per attempt (R8): inserted as ``running`` before the harvest, closed as
  ``completed`` (ok / partial / empty), ``cancelled`` (skipped) or ``failed``, with its counts, timing,
  ``next_retry_at`` when a retry is scheduled and a ``result_summary``. The table and the runtime
  role's DML on it already exist, so there is no schema change.
* The ``scraper_sources`` row carries freshness (R9): ``last_scraped_at``, ``last_success_at``,
  ``consecutive_failures`` (failed attempts, retries included), ``last_failure_reason`` and the totals.
* Alerts (R10), on every recorded run of a source, skips included (R20b, without touching its
  counters), logged at ERROR as ``F28 source alert: <source> <alert>`` and kept in the summary:
  ``failing`` (3 consecutive failed attempts), ``no_progress`` (the last 3 runs that ran all completed
  and wrote nothing), ``stale`` (no successful run for 2x the source's scrape frequency).
* Before an attempt starts, rows of the same source and job type still ``running`` after 2 hours are
  closed as ``failed`` / ``abandoned`` (R11): the task time limit is 1 hour. Each closed row that
  started after the last success counts toward the failure streak, with a reason that names no
  cause, and the alerts are evaluated (R24, re-audit round 2).
* A run cut off by the soft time limit, or cancelled, is recorded by the dispatcher through
  ``finish_failed`` as ``outcomes.RunInterrupted`` (R21).
* ``in_task_loop`` disposes the engine's pool before a task's event loop closes (R12).

Error text comes only from ``outcomes.describe_error``; a traceback is kept as frame locations without
the exception message (the message can carry row data or a DSN).
"""

from __future__ import annotations

import logging
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Dict, List, Optional

from sqlalchemy import select, update

from scraper import database
from scraper.models import ScraperJob, ScraperSource
from scraper.tasks import outcomes

logger = logging.getLogger(__name__)

JOB_TYPE_SOURCE = "incremental"
JOB_TYPE_EMBED = "embed"
EMBED_SITE = "embedding_queue"

STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_CANCELLED = "cancelled"
STATUS_FAILED = "failed"

ABANDONED_AFTER = timedelta(hours=2)  # celery_app task_time_limit is 3600 s
# R24: the sweep cannot know why a row was left running (a hard kill, a restart, a record that could
# not be written), so its text names no cause.
ABANDONED_TEXT = "abandoned: still running 2 hours after it started, with no outcome recorded; cause unknown"
ALERT_STREAK = 3
STALE_FACTOR = 2
_TRACEBACK_LIMIT = 4000


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def in_task_loop(work: Awaitable[Any]) -> Any:
    """Await ``work``, then dispose the engine's pool before ``asyncio.run`` closes the loop (R12):
    asyncpg connections belong to the loop that opened them, and every Celery task runs in a new one."""
    try:
        return await work
    finally:
        try:
            await database.engine.dispose()
        except Exception as exc:  # never mask the task's own outcome
            logger.warning("F28: disposing the engine after a task failed: %s", outcomes.describe_error(exc))


def _frames(exc: BaseException) -> str:
    frames = "".join(traceback.format_list(traceback.extract_tb(exc.__traceback__)))
    text = f"{type(exc).__name__} raised at:\n{frames}"
    return text if len(text) <= _TRACEBACK_LIMIT else "...(truncated)\n" + text[-_TRACEBACK_LIMIT:]


# ---------------------------------------------------------------------------------------------
# A source run (dispatcher)
# ---------------------------------------------------------------------------------------------
async def start(
    source_name: str,
    *,
    celery_task_id: Optional[str],
    worker: Optional[str],
    attempt: int,
    max_retries: int,
) -> uuid.UUID:
    """Close the source's abandoned rows, counting and alerting on them (R11, R24), and insert this
    attempt's ``running`` row."""
    now = utcnow()
    alerts: List[str] = []
    async with database.SessionLocal() as db:
        source_id = (
            await db.execute(select(ScraperSource.id).where(ScraperSource.source_name == source_name))
        ).scalar()
        abandoned = (
            ScraperJob.source_site == source_name,
            ScraperJob.job_type == JOB_TYPE_SOURCE,
            ScraperJob.status == STATUS_RUNNING,
            ScraperJob.started_at < now - ABANDONED_AFTER,
        )
        if (await db.execute(select(ScraperJob.id).where(*abandoned).limit(1))).first() is not None:
            alerts = await _sweep(db, source_name, abandoned, now)
        job = ScraperJob(
            source_id=source_id,
            source_site=source_name,
            job_type=JOB_TYPE_SOURCE,
            status=STATUS_RUNNING,
            celery_task_id=celery_task_id,
            worker_hostname=worker,
            retry_count=attempt,
            max_retries=max_retries,
            started_at=now,
            job_params={"attempt": attempt, "max_retries": max_retries},
        )
        db.add(job)
        await db.commit()
    for alert in alerts:
        logger.error("F28 source alert: %s %s", source_name, alert)
    return job.id


async def _sweep(db, source_name: str, abandoned, now: datetime) -> List[str]:
    """R24: close the abandoned rows as failed with a neutral reason, add each one that started after
    the source's last success to its failure streak, and evaluate the alerts. The source row is
    locked first (the lock order ``_close`` uses), and ``UPDATE ... RETURNING`` re-checks each row's
    status under its lock, so two concurrent sweeps never close or count the same row."""
    source = (
        await db.execute(select(ScraperSource).where(ScraperSource.source_name == source_name).with_for_update())
    ).scalars().first()
    closed = (
        await db.execute(
            update(ScraperJob)
            .where(*abandoned)
            .values(
                status=STATUS_FAILED,
                finished_at=now,
                error_message=ABANDONED_TEXT,
                result_summary={"outcome": outcomes.OUTCOME_FAILED, "reason": "abandoned"},
            )
            .returning(ScraperJob.id, ScraperJob.started_at)
            .execution_options(synchronize_session=False)
        )
    ).all()
    if source is None or not closed:
        return []
    last_success = source.last_success_at
    counted = [row for row in closed if last_success is None or row.started_at > last_success]
    if counted:
        source.consecutive_failures = (source.consecutive_failures or 0) + len(counted)
        source.last_failure_reason = ABANDONED_TEXT
    alerts = await _alerts(db, source, closed[-1].id, now, status=STATUS_FAILED, written=0)
    await db.execute(
        update(ScraperJob)
        .where(ScraperJob.id.in_([row.id for row in closed]))
        .values(result_summary={"outcome": outcomes.OUTCOME_FAILED, "reason": "abandoned", "alerts": alerts})
        .execution_options(synchronize_session=False)
    )
    return alerts


async def finish_completed(job_id: uuid.UUID, source_name: str, result: outcomes.HarvestResult, started: datetime) -> Dict[str, Any]:
    return await _close(
        job_id, source_name, status=STATUS_COMPLETED, summary=result.summary(), started=started,
        attempted=result.attempted, written=result.written, failed=result.failed, effect="success",
    )


async def finish_skipped(job_id: uuid.UUID, source_name: str, reason: str, started: datetime) -> Dict[str, Any]:
    summary = {"outcome": outcomes.OUTCOME_SKIPPED, "reason": reason}
    return await _close(
        job_id, source_name, status=STATUS_CANCELLED, summary=summary, started=started,
        attempted=0, written=0, failed=0, effect="none",
    )


async def finish_failed(
    job_id: uuid.UUID,
    source_name: str,
    exc: BaseException,
    *,
    tally: outcomes.Tally,
    started: datetime,
    attempt: int,
    max_retries: int,
    retry_in: Optional[int],
) -> None:
    """Record a failed attempt. Never raises: a failure to record is logged and the caller re-raises
    the run's own exception (R8)."""
    reasoned = (outcomes.SourceRunFailed, outcomes.SourceRefused, outcomes.RunInterrupted)
    summary = {
        "outcome": outcomes.OUTCOME_FAILED,
        "reason": getattr(exc, "reason", None) if isinstance(exc, reasoned) else None,
        "error_class": type(exc).__name__,
        "retryable": outcomes.is_retryable(exc),
        "will_retry": retry_in is not None,
        "retry_in_seconds": retry_in,
        "attempt": attempt,
        "max_retries": max_retries,
        "attempted": tally.attempted,
        "succeeded": tally.succeeded,
        "failed": tally.failed,
        "written": tally.written,
        "errors": dict(getattr(exc, "errors", None) or tally.errors),
        "discovery_failed": tally.discovery_failed,
        "discovery_errors": dict(tally.discovery_errors),
    }
    if isinstance(exc, outcomes.RunInterrupted):
        summary["interrupted_by"] = exc.interrupted_by  # R21: the class that cut the run off
    try:
        await _close(
            job_id, source_name, status=STATUS_FAILED, summary=summary, started=started,
            attempted=tally.attempted, written=tally.written, failed=tally.failed, effect="failure",
            exc=exc, retry_in=retry_in,
        )
    except Exception as record_exc:
        logger.error(
            "F28: could not record the failed run of %s (%s); the run's own error follows: %s",
            source_name, outcomes.describe_error(record_exc), outcomes.describe_error(exc),
        )


async def _close(
    job_id: uuid.UUID,
    source_name: str,
    *,
    status: str,
    summary: Dict[str, Any],
    started: datetime,
    attempted: int,
    written: int,
    failed: int,
    effect: str,
    exc: Optional[BaseException] = None,
    retry_in: Optional[int] = None,
) -> Dict[str, Any]:
    now = utcnow()
    alerts: List[str] = []
    async with database.SessionLocal() as db:
        existing = await db.get(ScraperJob, job_id)
        if existing is not None and existing.status != STATUS_RUNNING:
            logger.info(
                "F29: scraper_jobs %s already %s; leaving operator cancel in place",
                job_id,
                existing.status,
            )
            return dict(existing.result_summary or summary)
        if effect != "none":
            source = (
                await db.execute(
                    select(ScraperSource).where(ScraperSource.source_name == source_name).with_for_update()
                )
            ).scalars().first()
            if source is not None:
                source.last_scraped_at = now
                source.total_records_extracted = (source.total_records_extracted or 0) + written
                source.total_pages_scraped = (source.total_pages_scraped or 0) + attempted
                if effect == "success":
                    source.last_success_at = now
                    source.consecutive_failures = 0
                else:
                    source.consecutive_failures = (source.consecutive_failures or 0) + 1
                    source.last_failure_reason = outcomes.describe_error(exc)[:1000] if exc is not None else None
                alerts = await _alerts(db, source, job_id, now, status=status, written=written)
        else:
            # F28 R20b (Copilot 4305705096): a skip is not a run, so it changes no freshness counter,
            # but a skipped source can still go stale (or still be failing): the alerts are evaluated.
            source = (
                await db.execute(select(ScraperSource).where(ScraperSource.source_name == source_name))
            ).scalars().first()
            if source is not None:
                alerts = await _alerts(db, source, job_id, now, status=status, written=written)
        summary = {**summary, "alerts": alerts}
        job = existing if existing is not None else await db.get(ScraperJob, job_id)
        if job is None:
            await db.commit()
            return summary
        job.status = status
        job.finished_at = now
        job.duration_seconds = max(int((now - started).total_seconds()), 0)
        job.pages_scraped = attempted
        job.records_extracted = written
        job.records_failed = failed
        job.result_summary = summary
        if exc is not None:
            job.error_message = outcomes.describe_error(exc)
            job.error_traceback = _frames(exc)
        if retry_in is not None:
            job.next_retry_at = now + timedelta(seconds=retry_in)
        await db.commit()
    for alert in alerts:
        logger.error("F28 source alert: %s %s", source_name, alert)
    return summary


async def _alerts(db, source: ScraperSource, job_id: uuid.UUID, now: datetime, *, status: str, written: int) -> List[str]:
    alerts = []
    if (source.consecutive_failures or 0) >= ALERT_STREAK:
        alerts.append(f"failing: {source.consecutive_failures} consecutive failed attempts")
    if status == STATUS_COMPLETED and written == 0:
        previous = (
            await db.execute(
                select(ScraperJob.status, ScraperJob.records_extracted)
                .where(
                    ScraperJob.source_site == source.source_name,
                    ScraperJob.job_type == JOB_TYPE_SOURCE,
                    ScraperJob.id != job_id,
                    ScraperJob.status.in_((STATUS_COMPLETED, STATUS_FAILED)),
                )
                .order_by(ScraperJob.started_at.desc())
                .limit(ALERT_STREAK - 1)
            )
        ).all()
        if len(previous) == ALERT_STREAK - 1 and all(s == STATUS_COMPLETED and not n for s, n in previous):
            alerts.append(f"no_progress: {ALERT_STREAK} consecutive runs wrote nothing")
    reference = source.last_success_at or source.created_at
    frequency = timedelta(hours=STALE_FACTOR * max(int(source.scrape_frequency_hours or 1), 1))
    if reference is not None and now - reference > frequency:
        alerts.append(f"stale: no successful run since {reference.isoformat()}")
    return alerts


# ---------------------------------------------------------------------------------------------
# A corpus lifecycle tick (audit F21 R5): one row, written by scraper.tasks.corpus_pipeline when the
# tick claimed a record or failed (an idle tick writes none, R13's rule), or every reconcile tick.
# The id is drawn before the first claim, so every transition the tick writes can name it.
# ---------------------------------------------------------------------------------------------
async def record_consumer_run(
    *,
    job_id: uuid.UUID,
    job_type: str,
    status: str,
    summary: Dict[str, Any],
    started: datetime,
    attempted: int,
    written: int,
    failed: int,
    celery_task_id: Optional[str] = None,
    worker: Optional[str] = None,
    exc: Optional[BaseException] = None,
) -> None:
    from scraper.tasks import lifecycle

    now = utcnow()
    async with database.SessionLocal() as db:
        db.add(ScraperJob(
            id=job_id,
            source_id=None,
            source_site=lifecycle.LIFECYCLE_SITE,
            job_type=job_type,
            status=status,
            celery_task_id=celery_task_id,
            worker_hostname=worker,
            retry_count=0,
            max_retries=0,
            started_at=started,
            finished_at=now,
            duration_seconds=max(int((now - started).total_seconds()), 0),
            pages_scraped=attempted,
            records_extracted=written,
            records_failed=failed,
            error_message=outcomes.describe_error(exc) if exc is not None else None,
            error_traceback=_frames(exc) if exc is not None else None,
            result_summary=summary,
        ))
        await db.commit()


# ---------------------------------------------------------------------------------------------
# An embedding batch (one row, written when the batch claimed work or failed; R13)
# ---------------------------------------------------------------------------------------------
async def record_batch(
    *,
    status: str,
    summary: Dict[str, Any],
    started: datetime,
    attempted: int,
    written: int,
    failed: int,
    celery_task_id: Optional[str] = None,
    worker: Optional[str] = None,
    exc: Optional[BaseException] = None,
) -> None:
    now = utcnow()
    async with database.SessionLocal() as db:
        db.add(ScraperJob(
            source_id=None,
            source_site=EMBED_SITE,
            job_type=JOB_TYPE_EMBED,
            status=status,
            celery_task_id=celery_task_id,
            worker_hostname=worker,
            retry_count=0,
            max_retries=0,
            started_at=started,
            finished_at=now,
            duration_seconds=max(int((now - started).total_seconds()), 0),
            pages_scraped=attempted,
            records_extracted=written,
            records_failed=failed,
            error_message=outcomes.describe_error(exc) if exc is not None else None,
            error_traceback=_frames(exc) if exc is not None else None,
            result_summary=summary,
        ))
        await db.commit()
