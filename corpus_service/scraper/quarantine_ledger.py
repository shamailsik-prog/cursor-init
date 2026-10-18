"""quarantine_decisions is append-only in the database (audit F23, spec rulings 5 and 11).

A trigger function refuses the operation (SQLSTATE 23001, restrict_violation) and two triggers call
it: BEFORE UPDATE OR DELETE (per row) and BEFORE TRUNCATE (per statement). They bind every role that
can reach the table, the runtime role's DML grant included; only the table's owner or a superuser
could disable them.

The table never exists without them, whichever path creates it:
* ``make_append_only`` is attached to the table's ``after_create`` event (scraper.models), so
  ``create_all`` (``python -m scraper.migrate``, or a development startup) creates the function and
  triggers in the same transaction as the table;
* ``ensure_append_only`` is migration 002 (corpus_service/migrations/002_quarantine_decisions.py): on
  every migrate it leaves a current database untouched and repairs a dropped, disabled or altered
  trigger or function.

Everything is created in the table's own schema (resolved from 'quarantine_decisions'::regclass, as
F20's probe does for scraper_sources), not in whatever schema comes first on the search_path.
"""

from __future__ import annotations

from typing import Any, Final, Optional, Sequence, Tuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

TABLE: Final = "quarantine_decisions"
FUNCTION: Final = "quarantine_decisions_append_only"
ROW_TRIGGER: Final = "quarantine_decisions_no_update_delete"
TRUNCATE_TRIGGER: Final = "quarantine_decisions_no_truncate"
APPEND_ONLY_SQLSTATE: Final = "23001"
FUNCTION_BODY: Final = (
    "\nBEGIN\n"
    "  RAISE EXCEPTION 'quarantine_decisions is append-only: % refused', TG_OP\n"
    "    USING ERRCODE = 'restrict_violation';\n"
    "END\n"
)
# pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32.
ROW_TGTYPE: Final = 1 | 2 | 8 | 16
TRUNCATE_TGTYPE: Final = 2 | 32

SCHEMA_SQL: Final = (
    "SELECT quote_ident(n.nspname) FROM pg_catalog.pg_class c "
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = CAST(:t AS regclass)"
)
FUNCTION_SQL: Final = (
    "SELECT p.oid, p.prosrc FROM pg_catalog.pg_proc p "
    "JOIN pg_catalog.pg_class c ON c.relnamespace = p.pronamespace "
    "WHERE c.oid = CAST(:t AS regclass) AND p.proname = :f AND p.pronargs = 0"
)
# tgenabled is a "char"; asyncpg returns it as bytes, so it is compared as text.
TRIGGERS_SQL: Final = (
    "SELECT tgname, tgfoid, tgenabled::text, tgtype FROM pg_catalog.pg_trigger "
    "WHERE tgrelid = CAST(:t AS regclass) AND NOT tgisinternal"
)


def ddl(schema: str) -> Tuple[str, ...]:
    """The statements that (re)make the table append-only, for ``schema`` (already quoted)."""
    table = f"{schema}.{TABLE}"
    function = f"{schema}.{FUNCTION}"
    return (
        f"CREATE OR REPLACE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $f23${FUNCTION_BODY}$f23$",
        f"DROP TRIGGER IF EXISTS {ROW_TRIGGER} ON {table}",
        f"DROP TRIGGER IF EXISTS {TRUNCATE_TRIGGER} ON {table}",
        f"CREATE TRIGGER {ROW_TRIGGER} BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION {function}()",
        f"CREATE TRIGGER {TRUNCATE_TRIGGER} BEFORE TRUNCATE ON {table} FOR EACH STATEMENT EXECUTE FUNCTION {function}()",
    )


def is_current(function: Optional[Sequence[Any]], triggers: Sequence[Sequence[Any]]) -> bool:
    """True when the function (oid, prosrc) has the expected body and both triggers (name, function
    oid, enabled, type) exist, are enabled ('O') and call it with the expected timing and events."""
    if function is None or function[1] != FUNCTION_BODY:
        return False
    found = {row[0]: (row[1], row[2], row[3]) for row in triggers}
    return (
        found.get(ROW_TRIGGER) == (function[0], "O", ROW_TGTYPE)
        and found.get(TRUNCATE_TRIGGER) == (function[0], "O", TRUNCATE_TGTYPE)
    )


def make_append_only(target, connection, **_kw) -> None:
    """``after_create`` listener on the quarantine_decisions table: runs in create_all's transaction."""
    schema = connection.execute(text(SCHEMA_SQL), {"t": TABLE}).scalar_one()
    for statement in ddl(schema):
        connection.execute(text(statement))


async def ensure_append_only(conn: AsyncConnection) -> bool:
    """Migration 002: make the table append-only unless it already is. Returns True when it changed
    anything. DDL, in the caller's transaction; run by ``python -m scraper.migrate`` only."""
    function = (await conn.execute(text(FUNCTION_SQL), {"t": TABLE, "f": FUNCTION})).first()
    triggers = (await conn.execute(text(TRIGGERS_SQL), {"t": TABLE})).all()
    if is_current(function, triggers):
        return False
    schema = (await conn.execute(text(SCHEMA_SQL), {"t": TABLE})).scalar_one()
    for statement in ddl(schema):
        await conn.execute(text(statement))
    return True
