"""One-shot schema migration (audit F30, F20).

Run by the `migrate` compose service as MIGRATE_DB_USER, the schema-owner role, before the api and
workers start. The runtime role (APP_DB_USER) has DML rights only, so the API's own startup
init_db() can no longer create tables: with every table already present, its create_all is a
catalog check and its seed step is plain DML.

Order (audit F20): create the schema, then bring scraper_sources onto the trust vocabulary
(trusted | review | blocked, default review), then seed. On a database created before F20 the old
CHECK refuses 'review', so the upgrade must come before the seed step inserts a review source.
The upgrade is DDL and runs only here, never in the API's init_db().

Run it only as MIGRATE_DB_USER (the `migrate` service). Deciding whether the trust CHECK is already
current builds a throwaway table in scraper_sources' schema (rolled back), which needs CREATE on
that schema, so running this as the DML-only runtime role exits 1 even on a database that is
already current.

    python -m scraper.migrate
"""

import asyncio
import logging

from scraper import database

logger = logging.getLogger("scraper.migrate")


async def run_migrations() -> None:
    await database.create_schema()
    async with database.engine.begin() as conn:
        await database.upgrade_trust_vocabulary(conn)
    await database.seed_data()


async def _run() -> None:
    try:
        await run_migrations()
    finally:
        await database.engine.dispose()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_run())
    logger.info("schema migration complete")


if __name__ == "__main__":
    main()
