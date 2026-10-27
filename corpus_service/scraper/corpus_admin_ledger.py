"""corpus_admin_audit is append-only in the database (audit F47)."""

from __future__ import annotations

from typing import Any, Dict, Final, Mapping, Optional, Sequence, Tuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

TABLE: Final = "corpus_admin_audit"
FUNCTION: Final = "corpus_admin_audit_append_only"
ROW_TRIGGER: Final = "corpus_admin_audit_no_update_delete"
TRUNCATE_TRIGGER: Final = "corpus_admin_audit_no_truncate"
FUNCTION_BODY: Final = (
    "\nBEGIN\n"
    "  RAISE EXCEPTION 'corpus_admin_audit is append-only: % refused', TG_OP\n"
    "    USING ERRCODE = 'restrict_violation';\n"
    "END\n"
)
ROW_TGTYPE: Final = 1 | 2 | 8 | 16
TRUNCATE_TGTYPE: Final = 2 | 32
ENABLED_ALWAYS: Final = "A"

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
TRIGGERS_SQL: Final = (
    "SELECT tgname, tgfoid, tgtype::int AS tgtype, tgenabled::text AS tgenabled, tgqual IS NULL AS no_qual, "
    "cardinality(tgattr::int2[]) AS attr_count, tgnargs::int AS tgnargs, "
    "(tgconstraint = 0 AND tgconstrrelid = 0 AND tgconstrindid = 0) AS no_constraint, tgdeferrable, tginitdeferred, "
    "(tgoldtable IS NULL AND tgnewtable IS NULL) AS no_transition_tables, tgparentid = 0 AS no_parent "
    "FROM pg_catalog.pg_trigger WHERE tgrelid = CAST(:t AS regclass) AND NOT tgisinternal"
)


def expected_trigger(function_oid: Any, tgtype: int) -> Dict[str, Any]:
    return {
        "tgfoid": function_oid,
        "tgtype": tgtype,
        "tgenabled": ENABLED_ALWAYS,
        "no_qual": True,
        "attr_count": 0,
        "tgnargs": 0,
        "no_constraint": True,
        "tgdeferrable": False,
        "tginitdeferred": False,
        "no_transition_tables": True,
        "no_parent": True,
    }


def ddl(schema: str) -> Tuple[str, ...]:
    table = f"{schema}.{TABLE}"
    function = f"{schema}.{FUNCTION}"
    return (
        f"DROP TRIGGER IF EXISTS {ROW_TRIGGER} ON {table}",
        f"DROP TRIGGER IF EXISTS {TRUNCATE_TRIGGER} ON {table}",
        f"DROP FUNCTION IF EXISTS {function}() CASCADE",
        f"CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $f47${FUNCTION_BODY}$f47$",
        f"CREATE TRIGGER {ROW_TRIGGER} BEFORE DELETE OR UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION {function}()",
        f"CREATE TRIGGER {TRUNCATE_TRIGGER} BEFORE TRUNCATE ON {table} FOR EACH STATEMENT EXECUTE FUNCTION {function}()",
        f"ALTER TABLE {table} ENABLE ALWAYS TRIGGER {ROW_TRIGGER}",
        f"ALTER TABLE {table} ENABLE ALWAYS TRIGGER {TRUNCATE_TRIGGER}",
    )


def is_current(function: Optional[Mapping[str, Any]], triggers: Sequence[Mapping[str, Any]]) -> bool:
    if function is None or {key: function.get(key) for key in EXPECTED_FUNCTION} != dict(EXPECTED_FUNCTION):
        return False
    found = {row["tgname"]: {key: row.get(key) for key in expected_trigger(None, 0)} for row in triggers}
    return (
        found.get(ROW_TRIGGER) == expected_trigger(function["oid"], ROW_TGTYPE)
        and found.get(TRUNCATE_TRIGGER) == expected_trigger(function["oid"], TRUNCATE_TGTYPE)
    )


def make_append_only(target, connection, **_kw) -> None:
    schema = connection.execute(text(SCHEMA_SQL), {"t": TABLE}).scalar_one()
    for statement in ddl(schema):
        connection.execute(text(statement))


async def ensure_append_only(conn: AsyncConnection) -> bool:
    function = (await conn.execute(text(FUNCTION_SQL), {"t": TABLE, "f": FUNCTION})).mappings().first()
    triggers = (await conn.execute(text(TRIGGERS_SQL), {"t": TABLE})).mappings().all()
    if is_current(function, triggers):
        return False
    schema = (await conn.execute(text(SCHEMA_SQL), {"t": TABLE})).scalar_one()
    for statement in ddl(schema):
        await conn.execute(text(statement))
    return True
