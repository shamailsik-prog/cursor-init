"""F44 readiness/liveness helpers for scraper.main (no FastAPI imports)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import pathlib
import time
from typing import Any, Callable, Optional

from sqlalchemy import text

logger = logging.getLogger(__name__)

READINESS_DB_TIMEOUT_SEC = 2.0
TELEMETRY_CACHE_TTL_SEC = 60.0

_state: dict[str, Any] = {
    "at": 0.0,
    "total_pdfs": 0,
    "seen": 0,
    "total_cases": None,
}


def telemetry_snapshot() -> dict[str, Any]:
    """Last cached dashboard fields (may be stale); never walks the vault."""
    return {
        "total_pdfs": int(_state["total_pdfs"]),
        "seen": int(_state["seen"]),
        "total_cases": _state["total_cases"],
    }


def refresh_vault_telemetry(
    *,
    live_dir: Callable[[], pathlib.Path],
    vault_pdfs: Callable[[pathlib.Path], Any],
    state_dir: pathlib.Path,
) -> None:
    """Expensive vault walk; call from background refresh only, not from readiness."""
    total_pdfs = sum(1 for _, st in vault_pdfs(live_dir()) if st.st_size > 15000)
    seen = 0
    sf = state_dir / "harvest-seen.json"
    if sf.exists():
        try:
            seen = len(json.loads(sf.read_text()).get("seen", []))
        except Exception:  # noqa: BLE001 — corrupt state file should not break refresh
            pass
    _state["total_pdfs"] = total_pdfs
    _state["seen"] = seen
    _state["at"] = time.monotonic()


async def refresh_case_count(session_factory: Callable[[], Any]) -> None:
    async with session_factory() as db:
        result = await db.execute(text("SELECT count(*) FROM case_law_master"))
        _state["total_cases"] = result.scalar()
    _state["at"] = time.monotonic()


async def readiness_postgres_ok(
    session_factory: Callable[[], Any],
    *,
    timeout_sec: float | None = None,
) -> bool:
    limit = timeout_sec if timeout_sec is not None else READINESS_DB_TIMEOUT_SEC

    async def _probe() -> None:
        async with session_factory() as db:
            await db.execute(text("SELECT 1"))

    try:
        await asyncio.wait_for(_probe(), timeout=limit)
        return True
    except Exception:
        logger.warning("health: database readiness probe failed", exc_info=True)
        return False


async def periodic_telemetry_refresh(
    session_factory: Callable[[], Any],
    *,
    live_dir: Callable[[], pathlib.Path],
    vault_pdfs: Callable[[pathlib.Path], Any],
    state_dir: pathlib.Path,
    interval_sec: float = TELEMETRY_CACHE_TTL_SEC,
    stop: Optional[asyncio.Event] = None,
) -> None:
    """Background task: refresh cached counts without blocking readiness."""
    while True:
        try:
            refresh_vault_telemetry(live_dir=live_dir, vault_pdfs=vault_pdfs, state_dir=state_dir)
            await refresh_case_count(session_factory)
        except Exception:
            logger.warning("health: telemetry refresh failed", exc_info=True)
        if stop is not None and stop.is_set():
            return
        await asyncio.sleep(interval_sec)
