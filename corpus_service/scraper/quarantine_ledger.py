"""quarantine_decisions is append-only in the database (audit F23, spec rulings 5 and 11).

A trigger function refuses the operation (SQLSTATE 23001, restrict_violation) and two triggers call
it: BEFORE DELETE OR UPDATE (per row, every column, no WHEN clause) and BEFORE TRUNCATE (per
statement). Both are ENABLE ALWAYS: an ordinary enabled trigger ('O') is skipped by a session whose
session_replication_role is replica, which a superuser, or any role granted SET on that parameter, can
choose; an ALWAYS trigger ('A') fires in every mode. They bind every role that can reach the table, the
runtime role's DML grant included; only the table's owner or a superuser could alter or drop them.

The table never exists without them, whichever path creates it:
* ``make_append_only`` is attached to the table's ``after_create`` event (scraper.models), so
  ``create_all`` (``python -m scraper.migrate``, or a development startup) creates the function and
  triggers in the same transaction as the table;
* ``ensure_append_only`` is migration 002 (corpus_service/migrations/002_quarantine_decisions.py): on
  every migrate it leaves a current database untouched and otherwise drops and recreates the function
  and both triggers.

"Current" fails closed (review round, Copilot thread 4305754687): the function must match every
pg_proc attribute that decides what it does (body, language, return type, no arguments, a plain
function, not SECURITY DEFINER, no SET options, not strict, not set-returning, volatile), and each
trigger must match every pg_trigger column that decides when it fires (the function's oid, the timing,
level and events in tgtype, enabled ALWAYS, no WHEN clause, no column list, no arguments, not a
constraint trigger, not deferrable, no transition tables, not inherited from a parent). These are the
columns pg_get_triggerdef renders a trigger from; comparing them directly does not depend on how the
search_path qualifies names in the rendered text. Any difference, a WHEN (false) or UPDATE OF column
list included, means the whole set is rebuilt.

Everything is created in the table's own schema (resolved from 'quarantine_decisions'::regclass, as
F20's probe does for scraper_sources), not in whatever schema comes first on the search_path.
"""

from __future__ import annotations

from typing import Any, Dict, Final, Mapping, Optional, Sequence, Tuple

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
ENABLED_ALWAYS: Final = "A"

# Every pg_proc attribute that decides what the function does, except its oid.
EXPECTED_FUNCTION: Final[Mapping[str, Any]] = {
    "prosrc": FUNCTION_BODY,
    "lanname": "plpgsql",
    "rettype": "trigger",
    "pronargs": 0,
    "prokind": "f",
    "prosecdef": False,
    "no_config": True,
    "proisstrict": False,
    "proretset": False,
    "provolatile": "v",
}


def expected_trigger(function_oid: Any, tgtype: int) -> Dict[str, Any]:
    """Every pg_trigger column that decides when the trigger fires and what it calls."""
    return {
        "tgfoid": function_oid,
        "tgtype": tgtype,
        "tgenabled": ENABLED_ALWAYS,
        "no_qual": True,  # no WHEN clause
        "attr_count": 0,  # no UPDATE OF column list
        "tgnargs": 0,
        "no_constraint": True,  # not a constraint trigger
        "tgdeferrable": False,
        "tginitdeferred": False,
        "no_transition_tables": True,
        "no_parent": True,  # not cloned from a partitioned parent's trigger
    }


SCHEMA_SQL: Final = (
    "SELECT quote_ident(n.nspname) FROM pg_catalog.pg_class c "
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = CAST(:t AS regclass)"
)
FUNCTION_SQL: Final = (
    "SELECT p.oid, p.prosrc, l.lanname, p.prorettype::regtype::text AS rettype, p.pronargs::int AS pronargs, "
    "p.prokind::text AS prokind, p.prosecdef, p.proconfig IS NULL AS no_config, p.proisstrict, p.proretset, "
    "p.provolatile::text AS provolatile "
    "FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang "
    "JOIN pg_catalog.pg_class c ON c.relnamespace = p.pronamespace "
    "WHERE c.oid = CAST(:t AS regclass) AND p.proname = :f AND p.pronargs = 0"
)
# "char" columns arrive as bytes through asyncpg, so they are cast to text.
TRIGGERS_SQL: Final = (
    "SELECT tgname, tgfoid, tgtype::int AS tgtype, tgenabled::text AS tgenabled, tgqual IS NULL AS no_qual, "
    "cardinality(tgattr::int2[]) AS attr_count, tgnargs::int AS tgnargs, "
    "(tgconstraint = 0 AND tgconstrrelid = 0 AND tgconstrindid = 0) AS no_constraint, tgdeferrable, tginitdeferred, "
    "(tgoldtable IS NULL AND tgnewtable IS NULL) AS no_transition_tables, tgparentid = 0 AS no_parent "
    "FROM pg_catalog.pg_trigger WHERE tgrelid = CAST(:t AS regclass) AND NOT tgisinternal"
)


def ddl(schema: str) -> Tuple[str, ...]:
    """The statements that rebuild the function and both triggers from nothing, for ``schema``
    (already quoted). Dropping first means nothing of a drifted definition survives."""
    table = f"{schema}.{TABLE}"
    function = f"{schema}.{FUNCTION}"
    return (
        f"DROP TRIGGER IF EXISTS {ROW_TRIGGER} ON {table}",
        f"DROP TRIGGER IF EXISTS {TRUNCATE_TRIGGER} ON {table}",
        f"DROP FUNCTION IF EXISTS {function}() CASCADE",
        f"CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $f23${FUNCTION_BODY}$f23$",
        f"CREATE TRIGGER {ROW_TRIGGER} BEFORE DELETE OR UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION {function}()",
        f"CREATE TRIGGER {TRUNCATE_TRIGGER} BEFORE TRUNCATE ON {table} FOR EACH STATEMENT EXECUTE FUNCTION {function}()",
        f"ALTER TABLE {table} ENABLE ALWAYS TRIGGER {ROW_TRIGGER}",
        f"ALTER TABLE {table} ENABLE ALWAYS TRIGGER {TRUNCATE_TRIGGER}",
    )


def is_current(function: Optional[Mapping[str, Any]], triggers: Sequence[Mapping[str, Any]]) -> bool:
    """True only when the function and both triggers are exactly as ``ddl`` makes them."""
    if function is None or {key: function.get(key) for key in EXPECTED_FUNCTION} != dict(EXPECTED_FUNCTION):
        return False
    found = {row["tgname"]: {key: row.get(key) for key in expected_trigger(None, 0)} for row in triggers}
    return (
        found.get(ROW_TRIGGER) == expected_trigger(function["oid"], ROW_TGTYPE)
        and found.get(TRUNCATE_TRIGGER) == expected_trigger(function["oid"], TRUNCATE_TGTYPE)
    )


def make_append_only(target, connection, **_kw) -> None:
    """``after_create`` listener on the quarantine_decisions table: runs in create_all's transaction."""
    schema = connection.execute(text(SCHEMA_SQL), {"t": TABLE}).scalar_one()
    for statement in ddl(schema):
        connection.execute(text(statement))


async def ensure_append_only(conn: AsyncConnection) -> bool:
    """Migration 002: rebuild the function and triggers unless they are exactly current. Returns True
    when it changed anything. DDL, in the caller's transaction; run by ``python -m scraper.migrate``."""
    function = (await conn.execute(text(FUNCTION_SQL), {"t": TABLE, "f": FUNCTION})).mappings().first()
    triggers = (await conn.execute(text(TRIGGERS_SQL), {"t": TABLE})).mappings().all()
    if is_current(function, triggers):
        return False
    schema = (await conn.execute(text(SCHEMA_SQL), {"t": TABLE})).scalar_one()
    for statement in ddl(schema):
        await conn.execute(text(statement))
    return True
