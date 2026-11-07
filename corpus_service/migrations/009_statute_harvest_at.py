"""Migration 009 (FA-F21-021): statutes_master.harvest_at.

`python -m scraper.migrate` runs create_all first, so a new database already has the
nullable column from scraper.models.StatutesMaster. This migration adds it to a
database created before the column existed. It reads the catalog first and runs no
DDL when the column is already there.

The column is the harvest clock of the PakistanCode publish that last decided the
row. It is left NULL on existing rows. Nothing here rewrites section text or
is_repealed, and this module is not run against a live database by the change that
adds it.

DDL: run only by `python -m scraper.migrate` as the schema owner, in the caller's
transaction, never by the API's init_db().
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

TABLE = "statutes_master"
COLUMN = "harvest_at"


async def upgrade(conn: AsyncConnection) -> None:
    if (await conn.execute(text("SELECT to_regclass('statutes_master')"))).scalar() is None:
        raise RuntimeError("statutes_master is missing: create_schema() must run before migration 009")
    present = {
        row[0]
        for row in (
            await conn.execute(
                text(
                    "SELECT attname FROM pg_attribute "
                    "WHERE attrelid = CAST(:t AS regclass) AND attnum > 0 AND NOT attisdropped"
                ),
                {"t": TABLE},
            )
        ).all()
    }
    if COLUMN in present:
        return
    await conn.execute(text("ALTER TABLE statutes_master ADD COLUMN harvest_at TIMESTAMP WITH TIME ZONE"))
