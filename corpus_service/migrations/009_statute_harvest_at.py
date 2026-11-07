"""Migration 009 (FA-F21-021): statutes_master.harvest_at.

`python -m scraper.migrate` runs create_all first, so a new database already has the
nullable column from scraper.models.StatutesMaster. This migration adds it to a
database created before the column existed. It reads the catalog first and runs no
DDL when the column is already there.

The column is the harvest clock of the PakistanCode publish that last decided the
row. It is left NULL on existing rows. Nothing here rewrites section text or
is_repealed, and this module does not invent timestamps or backfill rows.

Rollout. Run `python -m scraper.migrate` before the new publish code serves
traffic. That is necessary and not sufficient:

* A publish whose text matches one stored row may store its own ``harvest_at``
  on that row only. It does not change the text, does not clear ``is_repealed``,
  and does not retire any other row. One stamp does not date the siblings.
  Their history is unknown; this migration does not invent it.
* While any row of the act still has NULL ``harvest_at``, a publish that would
  change text, clear repeal, insert a key, or retire is not applied. A stamp
  that is not strictly newer than a clock already stored is dead-lettered
  ``harvest_baseline_incomplete``. That reason does not mean the refused text
  was historically stale. A strictly newer stamp stays ``approved`` until every
  existing row has its own clock, and is then applied only if it is still newer.
* An unstamped publish that would change an undated row, or insert another key
  into an act whose rows are all still undated, is dead-lettered
  ``harvest_clock_uninitialized``. An unstamped publish after any clock is
  stored is ``stale_harvest`` and writes nothing. Do not weaken that gate.
* After every existing row has its own clock, an older stamp is ``stale_harvest``.
  An equal or newer stamp may amend and retire under the ordinary rule.
* Re-harvest after the baseline is complete. Do not copy a clock onto old rows
  by hand and do not point this migration at a live database from a workstation.

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
