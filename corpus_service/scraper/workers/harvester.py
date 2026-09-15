"""Seat harvester entrypoint.

FINAL_2: login scraping is permanently disabled. This process stays alive so
Docker `restart: unless-stopped` does not thrash, and exits cleanly when
signaled. Public harvests run via Celery beat / bootstrap_harvest.py.
"""
from __future__ import annotations

import logging
import os
import signal
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("scraper.workers.harvester")

_stop = False


def _handle_signal(signum, _frame):
    global _stop
    logger.info("Received signal %s — shutting down harvester idle loop", signum)
    _stop = True


def main() -> None:
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    seat = os.getenv("PLS_SEAT", "?")
    logger.info(
        "Harvester seat=%s idle: ALLOW_LOGIN_SCRAPING is false; "
        "use Celery beat or bootstrap_harvest.py for public sources",
        seat,
    )
    while not _stop:
        time.sleep(60)


if __name__ == "__main__":
    main()
