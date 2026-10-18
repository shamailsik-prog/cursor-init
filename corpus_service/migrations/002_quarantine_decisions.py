"""Migration 002 (audit F23): keep quarantine_decisions append-only in the database.

The table comes from the ORM model (scraper.models.QuarantineDecision) through create_schema()'s
create_all, which `python -m scraper.migrate` runs before this, and its after_create listener
creates the append-only function and triggers with it (scraper.quarantine_ledger). This migration
asserts them on every migrate: a database whose function and both triggers match exactly what the
ledger creates (every pg_proc and pg_trigger attribute that decides behaviour, ENABLE ALWAYS
included) is left untouched; anything else, a WHEN clause, an UPDATE OF column list, a statement-level
trigger, a disabled or origin-only trigger or a replaced function body among them, makes it drop and
recreate the function and both triggers, in the caller's transaction (review round, Copilot thread
4305754687).

DDL: run only by `python -m scraper.migrate` as the schema owner (MIGRATE_DB_USER), never by the
API's init_db(). Spec: docs/superpowers/specs/2026-10-18-f23-auditable-quarantine-promotion-design.md
(ruling 11).
"""

import logging

from sqlalchemy.ext.asyncio import AsyncConnection

from scraper.quarantine_ledger import FUNCTION, ROW_TRIGGER, TABLE, TRUNCATE_TRIGGER, ensure_append_only

logger = logging.getLogger("scraper.migrate")


async def upgrade(conn: AsyncConnection) -> None:
    if await ensure_append_only(conn):
        logger.info("%s made append-only (function %s, triggers %s, %s)", TABLE, FUNCTION, ROW_TRIGGER,
                    TRUNCATE_TRIGGER)
    else:
        logger.info("%s append-only trigger already current; nothing to upgrade", TABLE)
