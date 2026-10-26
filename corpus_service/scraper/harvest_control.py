"""Audit F29: durable harvest pause/resume shared by the admin API and Celery workers.

The dashboard ``POST /api/stop`` and ``POST /api/start`` endpoints write or remove
``harvest.stopped`` under the state directory. Scheduled harvest and embedding tasks
must read the same marker before doing work (not only the idle seat workers).
"""
from __future__ import annotations

import pathlib

from scraper.config import settings

_STOP_FILE = "harvest.stopped"


def state_dir() -> pathlib.Path:
    """Directory for harvest operator state (``harvest.stopped``, seat logs, seen index)."""
    docker = pathlib.Path("/app/state")
    if docker.exists():
        return docker
    configured = pathlib.Path(settings.STATE_STORAGE_PATH)
    if configured.exists():
        return configured
    return pathlib.Path("./blackletter_state")


def is_paused() -> bool:
    return (state_dir() / _STOP_FILE).exists()


def pause() -> None:
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / _STOP_FILE).write_text("stopped")


def resume() -> None:
    stop_file = state_dir() / _STOP_FILE
    if stop_file.exists():
        stop_file.unlink()
