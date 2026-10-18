"""Migration 005 (audit F21): bring the staging tables created before F21 into the corpus lifecycle.

`python -m scraper.migrate` runs create_all first, which creates `corpus_lifecycle_transitions`
(scraper.models.CorpusLifecycleTransition) on any database and builds a new database's staging tables
with the lifecycle columns already in place, but leaves existing tables as they were. This migration
adds to `scraper_staging` and `statutes_staging`, from the definitions the model uses
(scraper.tasks.lifecycle), whatever is missing:

* the columns `lifecycle_state` (NOT NULL, default 'parsed'), `state_changed_at` (NOT NULL, default
  now()), `state_reason`, `published_id`;
* the CHECKs `ck_<table>_lifecycle_state` and `ck_<table>_lifecycle_reason`, and the claim index
  `ix_<table>_lifecycle_claim`;
* on `scraper_jobs`, the four lifecycle job types in `ck_jobs_type_values`.

When it adds `lifecycle_state` to a table, it backfills that table's existing rows once from their
legacy flags (spec R13) and logs each row's entry as a transition with `from_state = NULL`, actor
`migration_005` and the legacy flags in its details. A harvester's pre-gate quarantine label (a
quarantined row with no review-queue row) is cleared, because the review gate decides quarantine.

It reads the catalog first: a current database (a new one, or one migrated before) gets no DDL and no
backfill, so it never needs ownership of a table it does not change. It does not touch
`embedding_queue`'s F27 columns or depend on migration 004: either can run first.

DDL: run only by `python -m scraper.migrate` as the schema owner (MIGRATE_DB_USER), in the caller's
transaction, never by the API's init_db(). Spec: docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md (R13).
"""

import logging
from collections import Counter

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from scraper.tasks import lifecycle

logger = logging.getLogger("scraper.migrate")

TRANSITIONS = "corpus_lifecycle_transitions"
JOBS = "scraper_jobs"
JOBS_CHECK = "ck_jobs_type_values"
COLUMNS = {
    "lifecycle_state": f"varchar(20) NOT NULL DEFAULT '{lifecycle.ENTRY_STATE}'",
    "state_changed_at": "timestamptz NOT NULL DEFAULT now()",
    "state_reason": f"varchar({lifecycle.MAX_REASON_CHARS})",
    "published_id": "uuid",
}
# table: (constraint/index prefix, review-queue column, retrieval table, F23 decisions apply)
TABLES = {
    lifecycle.CASE_TABLE: ("staging", "staging_id", "case_law_master", True),
    lifecycle.STATUTE_TABLE: ("statutes_staging", "statutes_staging_id", "statutes_master", False),
}


async def _present(conn: AsyncConnection, sql: str, **params) -> set:
    return {row[0] for row in (await conn.execute(text(sql), params)).all()}


def _sha256_sql(column: str) -> str:
    """Postgres' spelling of scraper.tasks.normalise.sha256_text (hex sha256 of the UTF-8 text)."""
    return f"encode(sha256(convert_to({column}, 'UTF8')), 'hex')"


def _backfill_sql(table: str, queue_column: str, master: str, decisions: bool) -> str:
    """One statement: snapshot the legacy flags, set each row's state (R13's table), clear harvester
    labels, fill the dedup hashes the normaliser compares (source_url_hash; content_hash for a case),
    and log every row's entry with its legacy flags."""
    decided = (
        "(SELECT d.published_id FROM quarantine_decisions d WHERE d.staging_id = st.id AND d.decision = 'promoted' "
        "ORDER BY d.decided_at DESC LIMIT 1)" if decisions else "CAST(NULL AS uuid)"
    )
    content_hash = (
        f"content_hash = coalesce(st.content_hash, CASE WHEN st.raw_text IS NOT NULL THEN {_sha256_sql('st.raw_text')} END),"
        if table == lifecycle.CASE_TABLE else ""
    )
    return f"""
WITH legacy AS (
  SELECT st.id, st.promoted, st.quarantined, st.normalised, st.quarantine_reason, st.promoted_to_id,
         st.created_at, st.updated_at,
         EXISTS (SELECT 1 FROM quarantine_queue q WHERE q.{queue_column} = st.id) AS has_queue,
         {decided} AS decided_id,
         EXISTS (SELECT 1 FROM {master} m WHERE m.id = st.promoted_to_id) AS master_exists,
         EXISTS (SELECT 1 FROM embedding_queue e WHERE e.table_name = '{master}' AND e.record_id = st.promoted_to_id) AS has_outbox
    FROM {table} st
), target AS (
  SELECT legacy.*,
         CASE
           WHEN promoted AND decided_id IS NOT NULL THEN 'embedded'
           WHEN promoted AND master_exists AND has_outbox THEN 'embedded'
           WHEN promoted AND master_exists THEN 'published'
           WHEN promoted THEN 'approved'
           WHEN quarantined AND has_queue THEN 'quarantined'
           WHEN normalised THEN 'normalised'
           ELSE 'parsed'
         END AS state,
         (quarantined AND NOT promoted AND NOT has_queue) AS clear_label
    FROM legacy
), moved AS (
  UPDATE {table} st
     SET lifecycle_state = t.state,
         state_changed_at = CASE WHEN t.state IN ('parsed', 'normalised') THEN t.created_at
                                 ELSE coalesce(t.updated_at, t.created_at) END,
         published_id = CASE WHEN t.state IN ('published', 'embedded') THEN coalesce(t.decided_id, t.promoted_to_id) END,
         quarantined = CASE WHEN t.clear_label THEN false ELSE st.quarantined END,
         quarantine_reason = CASE WHEN t.clear_label THEN NULL ELSE st.quarantine_reason END,
         {content_hash}
         source_url_hash = coalesce(st.source_url_hash,
                                    CASE WHEN st.source_url IS NOT NULL THEN {_sha256_sql('st.source_url')} END)
    FROM target t
   WHERE st.id = t.id
  RETURNING st.id
)
INSERT INTO {TRANSITIONS} (record_table, record_id, from_state, to_state, actor, details)
SELECT '{table}', t.id, NULL, t.state, '{lifecycle.ACTOR_MIGRATION}',
       jsonb_build_object(
         'legacy', jsonb_build_object('promoted', t.promoted, 'quarantined', t.quarantined, 'normalised', t.normalised,
                                      'quarantine_reason', t.quarantine_reason, 'promoted_to_id', t.promoted_to_id),
         'label_cleared', t.clear_label)
  FROM target t
RETURNING to_state
"""


async def _upgrade_table(conn: AsyncConnection, table: str) -> list:
    prefix, queue_column, master, decisions = TABLES[table]
    columns = await _present(
        conn,
        "SELECT attname FROM pg_attribute WHERE attrelid = CAST(:t AS regclass) AND attnum > 0 AND NOT attisdropped",
        t=table,
    )
    checks = await _present(
        conn, "SELECT conname FROM pg_constraint WHERE conrelid = CAST(:t AS regclass) AND contype = 'c'", t=table
    )
    indexes = await _present(
        conn,
        "SELECT i.relname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = CAST(:t AS regclass)",
        t=table,
    )
    changed = []
    backfill = "lifecycle_state" not in columns
    for name, ddl in COLUMNS.items():
        if name not in columns:
            await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
            changed.append(f"column {name}")
    if backfill:
        states = Counter(row[0] for row in (await conn.execute(text(_backfill_sql(table, queue_column, master, decisions)))).all())
        changed.append("backfilled " + (", ".join(f"{n} {s}" for s, n in sorted(states.items())) or "no rows"))
    wanted = {
        f"ck_{prefix}_lifecycle_state": lifecycle.states_check_sql(),
        f"ck_{prefix}_lifecycle_reason": lifecycle.reason_check_sql(),
    }
    for name, sql in wanted.items():
        if name not in checks:
            await conn.execute(text(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({sql})"))
            changed.append(f"check {name}")
    index = f"ix_{prefix}_lifecycle_claim"
    if index not in indexes:
        await conn.execute(text(f"CREATE INDEX {index} ON {table} (lifecycle_state, created_at, id)"))
        changed.append(f"index {index}")
    return changed


async def _upgrade_job_types(conn: AsyncConnection) -> list:
    definition = (await conn.execute(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = CAST(:t AS regclass) AND conname = :n"
    ), {"t": JOBS, "n": JOBS_CHECK})).scalar()
    wanted = lifecycle.LEGACY_JOB_TYPES + lifecycle.LIFECYCLE_JOB_TYPES
    if definition is not None and all(f"'{t}'" in definition for t in wanted):
        return []
    await conn.execute(text(f"ALTER TABLE {JOBS} DROP CONSTRAINT IF EXISTS {JOBS_CHECK}"))
    await conn.execute(text(f"ALTER TABLE {JOBS} ADD CONSTRAINT {JOBS_CHECK} CHECK ({lifecycle.job_type_check_sql()})"))
    return [f"check {JOBS_CHECK} with the lifecycle job types"]


async def upgrade(conn: AsyncConnection) -> None:
    if (await conn.execute(text(f"SELECT to_regclass('{TRANSITIONS}')"))).scalar() is None:
        raise RuntimeError(f"{TRANSITIONS} is missing: create_schema() must run before migration 005")
    changed = {}
    for table in TABLES:
        done = await _upgrade_table(conn, table)
        if done:
            changed[table] = done
    jobs = await _upgrade_job_types(conn)
    if jobs:
        changed[JOBS] = jobs
    if not changed:
        logger.info("migration 005: already current; nothing to upgrade")
        return
    for table, done in changed.items():
        logger.info("migration 005: %s: %s", table, "; ".join(done))
