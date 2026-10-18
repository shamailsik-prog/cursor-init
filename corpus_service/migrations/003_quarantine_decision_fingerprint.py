"""Migration 003 (audit F23 re-audit round 2): quarantine_decisions.request_fingerprint.

Every decision stores the SHA-256 of the canonical decision, reviewer and reason of the request that
made it, so a request that reuses its Idempotency-Key with another body is refused (422) instead of
being answered with this decision (spec ruling 20). This migration adds the column
(``varchar(64)``, nullable) and its CHECK (NULL or 64 lowercase hex characters) to a table created
before them, and leaves a table that has both untouched ("already current"). A column of another
type stops the migration. On a new database the model (scraper.models.QuarantineDecision) creates
both through create_all, which `python -m scraper.migrate` runs before this.

Existing rows are not backfilled: the table refuses UPDATE (ruling 5), and a row without a
fingerprint is compared by recomputing it from its stored values (ruling 20). A new migration rather
than part of 002, which means "the table is append-only" (ruling 21).

DDL: run only by `python -m scraper.migrate` as the schema owner (MIGRATE_DB_USER), never by the
API's init_db(). Spec: docs/superpowers/specs/2026-10-18-f23-auditable-quarantine-promotion-design.md.
"""

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from scraper.quarantine_ledger import SCHEMA_SQL, TABLE

logger = logging.getLogger("scraper.migrate")

COLUMN = "request_fingerprint"
COLUMN_TYPE = "character varying(64)"
CONSTRAINT = "ck_quarantine_decisions_request_fingerprint"
CHECK = "request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'"
COLUMN_SQL = (
    "SELECT format_type(a.atttypid, a.atttypmod) FROM pg_catalog.pg_attribute a "
    "WHERE a.attrelid = CAST(:t AS regclass) AND a.attname = :c AND NOT a.attisdropped"
)
CONSTRAINT_SQL = (
    "SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = CAST(:t AS regclass) AND conname = :n "
    "AND contype = 'c'"
)


async def upgrade(conn: AsyncConnection) -> None:
    schema = (await conn.execute(text(SCHEMA_SQL), {"t": TABLE})).scalar_one()
    table = f"{schema}.{TABLE}"
    added = []
    column_type = (await conn.execute(text(COLUMN_SQL), {"t": TABLE, "c": COLUMN})).scalar()
    if column_type is None:
        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {COLUMN} varchar(64)"))
        added.append("column")
    elif column_type != COLUMN_TYPE:
        raise RuntimeError(f"{TABLE}.{COLUMN} is {column_type}, expected {COLUMN_TYPE}")
    if (await conn.execute(text(CONSTRAINT_SQL), {"t": TABLE, "n": CONSTRAINT})).first() is None:
        await conn.execute(text(f"ALTER TABLE {table} ADD CONSTRAINT {CONSTRAINT} CHECK ({CHECK})"))
        added.append("check")
    if added:
        logger.info("%s.%s added (%s)", TABLE, COLUMN, ", ".join(added))
    else:
        logger.info("%s.%s already current; nothing to upgrade", TABLE, COLUMN)
