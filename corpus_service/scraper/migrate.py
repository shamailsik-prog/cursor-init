"""One-shot schema migration (audit F30).

Run by the `migrate` compose service as MIGRATE_DB_USER, the schema-owner role, before the api and
workers start. The runtime role (APP_DB_USER) has DML rights only, so the API's own startup
init_db() can no longer create tables: with every table already present, its create_all is a
catalog check and its seed step is plain DML.

    python -m scraper.migrate
"""

import asyncio
import logging

from scraper.database import engine, init_db

logger = logging.getLogger("scraper.migrate")


async def _run() -> None:
    try:
        await init_db()
    finally:
        await engine.dispose()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_run())
    logger.info("schema migration complete")


if __name__ == "__main__":
    main()
