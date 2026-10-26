"""Migration 006 (audit F29 / FA-F29-001): durable harvest pause flag in PostgreSQL.

``python -m scraper.migrate`` runs create_all first, which creates ``harvest_operator_state``
(scraper.models.HarvestOperatorState) on a new database. This migration ensures the singleton row
exists on databases that already ran earlier migrations without the table (create_all on migrate still
adds the table; the row seed is idempotent here).

The legacy host-local ``harvest.stopped`` file is not read here; ``scraper.harvest_control`` adopts
it on the first DB read after upgrade when the file is present and the row is not paused.

DDL: run only by ``python -m scraper.migrate`` as the schema owner (MIGRATE_DB_USER).
"""

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

logger = logging.getLogger("scraper.migrate")

TABLE = "harvest_operator_state"
SINGLETON_ID = "global"


async def upgrade(conn: AsyncConnection) -> None:
    if (await conn.execute(text("SELECT to_regclass(:t)"), {"t": TABLE})).scalar() is None:
        raise RuntimeError(f"{TABLE} is missing: create_schema() must run before migration 006")
    present = (
        await conn.execute(text(f"SELECT 1 FROM {TABLE} WHERE id = :id"), {"id": SINGLETON_ID})
    ).first()
    if present is None:
        await conn.execute(
            text(f"INSERT INTO {TABLE} (id, paused) VALUES (:id, false)"),
            {"id": SINGLETON_ID},
        )
        logger.info("migration 006: seeded harvest_operator_state row %s", SINGLETON_ID)
