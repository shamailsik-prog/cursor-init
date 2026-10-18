"""Migration 004 (audit F27): bring a queue created before F27 onto the leased-claim schema.

`python -m scraper.migrate` runs create_all first, which creates the new receipt table
`embedding_attempts` (scraper.models.EmbeddingAttempt) on any database, but leaves an existing
`embedding_queue` as it was. This migration adds to it, from the strings the model itself uses
(scraper.models.EMBEDDING_QUEUE_F27_*), whatever is missing:

* the columns `lease_owner`, `lease_expires_at`, `operation_id`, `stored_operation_id`;
* the CHECKs `ck_embedding_lease_held`, `ck_embedding_operation_ids`, `ck_embedding_dead_letter_reason`;
* the partial indexes `ix_embedding_claim_order`, `ix_embedding_lease_expiry`, `ix_embedding_waiting_created`.

It reads the catalog first and runs no DDL on a queue that is already current, so a second run (or a
new database, which create_all built from the model) changes nothing. Before the lease CHECK, rows
left `processing` without a lease (main never wrote that status; only a hand edit could) go back to
`pending`, attempts unchanged; before the dead-letter CHECK, a `dead_letter` row without a reason
(also never written by main) gets `error_type = 'legacy_unspecified'`. Legacy `failed` rows are left
as they are. Independent of migration 003 (audit F23): either can run first.

DDL: run only by `python -m scraper.migrate` as the schema owner (MIGRATE_DB_USER), in the caller's
transaction, never by the API's init_db(). Spec:
docs/superpowers/specs/2026-10-18-f27-leased-embedding-claims-design.md (R14).
"""

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from scraper.models import EMBEDDING_QUEUE_F27_CHECKS, EMBEDDING_QUEUE_F27_COLUMNS, EMBEDDING_QUEUE_F27_INDEXES

logger = logging.getLogger("scraper.migrate")

TABLE = "embedding_queue"


async def _present(conn: AsyncConnection, sql: str, **params) -> set:
    return {row[0] for row in (await conn.execute(text(sql), params)).all()}


async def upgrade(conn: AsyncConnection) -> None:
    if (await conn.execute(text("SELECT to_regclass('embedding_attempts')"))).scalar() is None:
        raise RuntimeError("embedding_attempts is missing: create_schema() must run before migration 004")
    columns = await _present(
        conn,
        "SELECT attname FROM pg_attribute WHERE attrelid = CAST(:t AS regclass) AND attnum > 0 AND NOT attisdropped",
        t=TABLE,
    )
    checks = await _present(
        conn, "SELECT conname FROM pg_constraint WHERE conrelid = CAST(:t AS regclass) AND contype = 'c'", t=TABLE
    )
    indexes = await _present(
        conn,
        "SELECT i.relname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = CAST(:t AS regclass)",
        t=TABLE,
    )
    changed = []
    for name, ddl_type in EMBEDDING_QUEUE_F27_COLUMNS.items():
        if name not in columns:
            await conn.execute(text(f"ALTER TABLE {TABLE} ADD COLUMN {name} {ddl_type}"))
            changed.append(f"column {name}")
    for name, sql in EMBEDDING_QUEUE_F27_CHECKS.items():
        if name in checks:
            continue
        if name == "ck_embedding_lease_held":
            moved = (await conn.execute(text(
                f"UPDATE {TABLE} SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = now() "
                "WHERE status = 'processing' AND (lease_owner IS NULL OR lease_expires_at IS NULL)"
            ))).rowcount
            if moved:
                changed.append(f"{moved} unleased processing row(s) back to pending")
        if name == "ck_embedding_dead_letter_reason":
            await conn.execute(text(
                f"UPDATE {TABLE} SET error_type = 'legacy_unspecified', updated_at = now() "
                "WHERE status = 'dead_letter' AND error_type IS NULL"
            ))
        await conn.execute(text(f"ALTER TABLE {TABLE} ADD CONSTRAINT {name} CHECK ({sql})"))
        changed.append(f"check {name}")
    for name, (cols, where) in EMBEDDING_QUEUE_F27_INDEXES.items():
        if name not in indexes:
            await conn.execute(text(f"CREATE INDEX {name} ON {TABLE} ({cols}) WHERE {where}"))
            changed.append(f"index {name}")
    if changed:
        logger.info("%s brought onto the F27 leased-claim schema: %s", TABLE, "; ".join(changed))
    else:
        logger.info("%s already on the F27 leased-claim schema; nothing to upgrade", TABLE)
