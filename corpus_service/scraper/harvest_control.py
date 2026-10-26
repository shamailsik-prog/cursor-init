"""Audit F29: durable harvest pause/resume in PostgreSQL, shared by the admin API and Celery workers.

``POST /api/stop`` and ``POST /api/start`` set the singleton ``harvest_operator_state`` row.
Scheduled harvest and embedding tasks read the same flag before doing work. A legacy
``harvest.stopped`` file under the state directory is adopted once into the database and removed.
"""
from __future__ import annotations

import asyncio
import logging
import pathlib
from datetime import datetime, timezone

from typing import Any, Dict

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert

from scraper.config import settings
from scraper.database import SessionLocal
from scraper.models import HarvestOperatorState, ScraperJob
from scraper.tasks import outcomes
from scraper.tasks.job_record import (
    JOB_TYPE_EMBED,
    JOB_TYPE_SOURCE,
    STATUS_CANCELLED,
    STATUS_RUNNING,
)

logger = logging.getLogger(__name__)

SINGLETON_ID = "global"
_LEGACY_STOP_FILE = "harvest.stopped"
# Scheduled harvest and embedding batches (F29 consumers); not corpus lifecycle ticks.
_HARVEST_JOB_TYPES = frozenset({JOB_TYPE_SOURCE, JOB_TYPE_EMBED})


def state_dir() -> pathlib.Path:
    """Directory for harvest operator artefacts (seat logs, seen index; legacy stop file)."""
    docker = pathlib.Path("/app/state")
    if docker.exists():
        return docker
    configured = pathlib.Path(settings.STATE_STORAGE_PATH)
    if configured.exists():
        return configured
    return pathlib.Path("./blackletter_state")


def _legacy_stop_path() -> pathlib.Path:
    return state_dir() / _LEGACY_STOP_FILE


def _legacy_file_paused() -> bool:
    return _legacy_stop_path().exists()


def _clear_legacy_file() -> None:
    path = _legacy_stop_path()
    if path.exists():
        try:
            path.unlink()
        except OSError as exc:
            logger.warning("F29: could not remove legacy harvest stop file %s: %s", path, exc)


async def _ensure_row(session) -> None:
    stmt = (
        insert(HarvestOperatorState)
        .values(id=SINGLETON_ID, paused=False)
        .on_conflict_do_nothing(index_elements=["id"])
    )
    await session.execute(stmt)
    await session.commit()


async def _set_paused(session, paused: bool) -> None:
    row = await session.get(HarvestOperatorState, SINGLETON_ID)
    if row is None:
        await _ensure_row(session)
        row = await session.get(HarvestOperatorState, SINGLETON_ID)
    if row is None:
        raise RuntimeError("harvest_operator_state singleton row is missing after ensure")
    row.paused = paused
    row.updated_at = datetime.now(timezone.utc)
    await session.commit()


async def is_paused_async() -> bool:
    async with SessionLocal() as session:
        await _ensure_row(session)
        row = await session.get(HarvestOperatorState, SINGLETON_ID)
        paused = bool(row.paused) if row else False
        if _legacy_file_paused() and not paused:
            await _set_paused(session, True)
            _clear_legacy_file()
            return True
        if _legacy_file_paused() and paused:
            _clear_legacy_file()
        return paused


def _revoke_celery_tasks(task_ids: list[str]) -> int:
    """Cooperative revoke (terminate=False): safe when the worker will observe pause / DB cancel."""
    ids = [tid for tid in task_ids if tid]
    if not ids:
        return 0
    try:
        from scraper.tasks.celery_app import app

        for tid in ids:
            app.control.revoke(tid, terminate=False)
        return len(ids)
    except Exception as exc:
        logger.warning("F29: could not revoke in-flight Celery task(s): %s", exc)
        return 0


async def cancel_in_flight_harvest_work_async() -> Dict[str, Any]:
    """FA-F29-005: close running harvest/embedding scraper_jobs and revoke their Celery tasks."""
    now = datetime.now(timezone.utc)
    task_ids: list[str] = []
    cancelled = 0
    summary = {
        "outcome": outcomes.OUTCOME_SKIPPED,
        "reason": outcomes.REASON_HARVEST_STOPPED,
    }
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(ScraperJob.id, ScraperJob.celery_task_id)
                .where(
                    ScraperJob.status == STATUS_RUNNING,
                    ScraperJob.job_type.in_(_HARVEST_JOB_TYPES),
                )
                .with_for_update()
            )
        ).all()
        if rows:
            job_ids = [row.id for row in rows]
            task_ids = [row.celery_task_id for row in rows if row.celery_task_id]
            await session.execute(
                update(ScraperJob)
                .where(ScraperJob.id.in_(job_ids), ScraperJob.status == STATUS_RUNNING)
                .values(
                    status=STATUS_CANCELLED,
                    finished_at=now,
                    duration_seconds=func.greatest(
                        func.floor(func.extract("epoch", now - ScraperJob.started_at)),
                        0,
                    ),
                    error_message=None,
                    result_summary=summary,
                )
                .execution_options(synchronize_session=False)
            )
            cancelled = len(job_ids)
            await session.commit()
    revoked = _revoke_celery_tasks(task_ids)
    if cancelled or revoked:
        logger.info(
            "F29: operator stop cancelled %d in-flight harvest job(s), revoked %d Celery task(s)",
            cancelled,
            revoked,
        )
    return {"cancelled_jobs": cancelled, "revoked_tasks": revoked}


async def cooperative_cancel_if_paused_async() -> None:
    """Raise when the operator has paused harvest (checkpoints in long-running tasks)."""
    if await is_paused_async():
        raise outcomes.HarvestOperatorPaused()


async def pause_async() -> Dict[str, Any]:
    async with SessionLocal() as session:
        await _set_paused(session, True)
    _clear_legacy_file()
    return await cancel_in_flight_harvest_work_async()


async def resume_async() -> None:
    async with SessionLocal() as session:
        await _set_paused(session, False)
    _clear_legacy_file()


async def _running_harvest_jobs(session) -> Dict[str, int]:
    """Count ``scraper_jobs`` rows still ``running`` for F29-governed work (cheap index on status)."""
    rows = (
        await session.execute(
            select(ScraperJob.job_type, func.count())
            .where(
                ScraperJob.status == STATUS_RUNNING,
                ScraperJob.job_type.in_(_HARVEST_JOB_TYPES),
            )
            .group_by(ScraperJob.job_type)
        )
    ).all()
    counts = {job_type: int(n) for job_type, n in rows}
    source_runs = counts.get(JOB_TYPE_SOURCE, 0)
    embed_batches = counts.get(JOB_TYPE_EMBED, 0)
    return {
        "source_runs": source_runs,
        "embed_batches": embed_batches,
        "total": source_runs + embed_batches,
    }


async def operator_status_async() -> Dict[str, Any]:
    """Pause flag plus whether harvest/embedding Celery work is in flight (FA-F29-003)."""
    async with SessionLocal() as session:
        await _ensure_row(session)
        row = await session.get(HarvestOperatorState, SINGLETON_ID)
        paused = bool(row.paused) if row else False
        if _legacy_file_paused() and not paused:
            await _set_paused(session, True)
            _clear_legacy_file()
            paused = True
        elif _legacy_file_paused() and paused:
            _clear_legacy_file()
        running = await _running_harvest_jobs(session)
    return {
        "paused": paused,
        "in_flight": running["total"] > 0,
        "running": running,
    }


def is_paused() -> bool:
    """Read the durable pause flag. Safe from Celery sync tasks (no running loop)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(is_paused_async())
    raise RuntimeError(
        "harvest_control.is_paused() cannot run inside an event loop; use await is_paused_async()"
    )


def pause() -> Dict[str, Any]:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(pause_async())
    raise RuntimeError("harvest_control.pause() cannot run inside an event loop; use await pause_async()")


def cancel_in_flight_harvest_work() -> Dict[str, Any]:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(cancel_in_flight_harvest_work_async())
    raise RuntimeError(
        "harvest_control.cancel_in_flight_harvest_work() cannot run inside an event loop; "
        "use await cancel_in_flight_harvest_work_async()"
    )


def resume() -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(resume_async())
        return
    raise RuntimeError("harvest_control.resume() cannot run inside an event loop; use await resume_async()")
