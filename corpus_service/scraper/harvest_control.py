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

from sqlalchemy.dialects.postgresql import insert

from scraper.config import settings
from scraper.database import SessionLocal
from scraper.models import HarvestOperatorState

logger = logging.getLogger(__name__)

SINGLETON_ID = "global"
_LEGACY_STOP_FILE = "harvest.stopped"


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


async def pause_async() -> None:
    async with SessionLocal() as session:
        await _set_paused(session, True)
    _clear_legacy_file()


async def resume_async() -> None:
    async with SessionLocal() as session:
        await _set_paused(session, False)
    _clear_legacy_file()


def is_paused() -> bool:
    """Read the durable pause flag. Safe from Celery sync tasks (no running loop)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(is_paused_async())
    raise RuntimeError(
        "harvest_control.is_paused() cannot run inside an event loop; use await is_paused_async()"
    )


def pause() -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(pause_async())
        return
    raise RuntimeError("harvest_control.pause() cannot run inside an event loop; use await pause_async()")


def resume() -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(resume_async())
        return
    raise RuntimeError("harvest_control.resume() cannot run inside an event loop; use await resume_async()")
