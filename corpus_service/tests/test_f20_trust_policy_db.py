"""Audit F20 (+ F22) end to end against real Postgres 16 + pgvector.

Everything runs through the application's own code: its models, ``python -m scraper.migrate`` as
the compose ``migrate`` service runs it, the real ``promote_staging_records()`` and the real
dispatcher ``_run_async``. The expected values are written out from the spec, not imported from
the code under test:

* FINAL_CORPUS_SERVICE_PROMPT_2.md :252-253 - trust_level is trusted | review | blocked,
  default review.
* :894-898 - only trusted with confidence >= 0.5 is promoted; review is always quarantined;
  blocked is never harvested. Unknown or missing sources fail closed (audit F20).
* audit F22 - a citation-free record is quarantined (citation_missing), not a crash, and one bad
  record does not stop the rest of the batch.

Needs CORPUS_TEST_DATABASE_URL (see conftest.py); every test gets a fresh database.
"""

import asyncio
import logging
import re
import sys
import types
import uuid

import pytest

SPEC_TRUST_LEVELS = {"trusted", "review", "blocked"}
LEGACY_CHECK = "trust_level IN ('trusted','semi_trusted','untrusted','quarantined')"
CHECK_NAME = "ck_trust_level_values"
CHECK_VIOLATION = "23514"

# Every seeded source and the trust it must carry after migrate. Only explicit approvals stay
# trusted; every former semi_trusted source is review.
SEEDED_TRUST = {
    "PakistanLawSite": "trusted",
    "PakistanCode": "trusted",
    "NationalAssembly": "trusted",
    "NasirLawSite": "review",
    "SindhHighCourt": "review",
    "SindhHighCourtPublic": "review",
    "SupremeCourt": "review",
    "SupremeCourtPublic": "review",
    "LahoreHighCourt": "review",
    "PeshawarHighCourt": "review",
    "PeshawarHighCourtPublic": "review",
    "BalochistanHighCourt": "review",
    "BalochistanHighCourtPublic": "review",
    "IslamabadHighCourt": "review",
    "IslamabadHighCourtPublic": "review",
}


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
def run(coro):
    return asyncio.run(coro)


def sqlstate(exc):
    for candidate in (getattr(exc, "orig", None), getattr(getattr(exc, "orig", None), "__cause__", None), exc):
        code = getattr(candidate, "sqlstate", None) or getattr(candidate, "pgcode", None)
        if code:
            return code
    return None


async def fetch(sql, **params):
    from sqlalchemy import text

    from scraper import database

    async with database.engine.connect() as conn:
        return (await conn.execute(text(sql), params)).all()


async def execute(*statements, params=None):
    from sqlalchemy import text

    from scraper import database

    async with database.engine.begin() as conn:
        for sql in statements:
            await conn.execute(text(sql), params or {})


async def try_insert_source(name, trust_level=None):
    """INSERT one source in its own transaction (always rolled back); return the stored trust_level
    or the SQLSTATE that refused it."""
    from sqlalchemy import text

    from scraper import database

    cols = "source_name, source_url" + (", trust_level" if trust_level is not None else "")
    vals = ":name, 'https://f20.example.invalid/'" + (", :trust" if trust_level is not None else "")
    async with database.engine.connect() as conn:
        trans = await conn.begin()
        try:
            stored = (
                await conn.execute(
                    text(f"INSERT INTO scraper_sources ({cols}) VALUES ({vals}) RETURNING trust_level"),
                    {"name": name, "trust": trust_level},
                )
            ).scalar()
            return ("stored", stored)
        except Exception as exc:  # noqa: BLE001 - classified by SQLSTATE
            return ("refused", sqlstate(exc))
        finally:
            await trans.rollback()


async def constraint_state():
    """(oid, literals in the CHECK, convalidated, literals in the column default)."""
    rows = await fetch(
        "SELECT c.oid, pg_get_constraintdef(c.oid), c.convalidated FROM pg_constraint c "
        "WHERE c.conrelid = 'scraper_sources'::regclass AND c.conname = :name",
        name=CHECK_NAME,
    )
    default = await fetch(
        "SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a "
        "ON a.attrelid = d.adrelid AND a.attnum = d.adnum "
        "WHERE d.adrelid = 'scraper_sources'::regclass AND a.attname = 'trust_level'"
    )
    literals = lambda s: set(re.findall(r"'([^']*)'", s or ""))  # noqa: E731
    if not rows:
        return None, set(), False, literals(default[0][0] if default else "")
    oid, condef, valid = rows[0]
    return oid, literals(condef), valid, literals(default[0][0] if default else "")


async def sources_snapshot():
    return await fetch("SELECT * FROM scraper_sources ORDER BY source_name")


async def trust_by_name():
    return dict(await fetch("SELECT source_name, trust_level FROM scraper_sources"))


def assert_migrated(proc, db):
    assert proc.returncode == 0, f"scraper.migrate failed:\n{proc.stdout}\n{proc.stderr[-4000:]}"


def build_legacy_schema(db):
    """The schema exactly as main had it before this fix: today's tables (only the trust CHECK and
    default differ), with the old CHECK string literally and default 'trusted'."""
    from sqlalchemy import text

    from scraper import database
    from scraper import models  # noqa: F401 - registers the tables on Base.metadata

    db.admin(
        "CREATE EXTENSION IF NOT EXISTS vector",
        "CREATE EXTENSION IF NOT EXISTS pg_trgm",
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
    )

    async def _build():
        async with database.engine.begin() as conn:
            await conn.run_sync(database.Base.metadata.create_all)
            await conn.execute(text(f"ALTER TABLE scraper_sources DROP CONSTRAINT IF EXISTS {CHECK_NAME}"))
            await conn.execute(text(f"ALTER TABLE scraper_sources ADD CONSTRAINT {CHECK_NAME} CHECK ({LEGACY_CHECK})"))
            await conn.execute(text("ALTER TABLE scraper_sources ALTER COLUMN trust_level SET DEFAULT 'trusted'"))

    run(_build())


# ---------------------------------------------------------------------------------------------
# (a) the schema after migrate refuses values outside the vocabulary and defaults to review
# ---------------------------------------------------------------------------------------------
def test_a_new_schema_refuses_every_value_outside_the_vocabulary(corpus_db):
    assert_migrated(corpus_db.migrate(), corpus_db)
    for bad in ("semi_trusted", "untrusted", "quarantined", "", "TRUSTED", " trusted"):
        outcome = run(try_insert_source(f"f20-bad-{uuid.uuid4().hex[:6]}", bad))
        assert outcome == ("refused", CHECK_VIOLATION), f"trust_level={bad!r} was not refused: {outcome}"
    for good in sorted(SPEC_TRUST_LEVELS):
        assert run(try_insert_source(f"f20-good-{good}", good)) == ("stored", good)


def test_a_a_source_inserted_without_trust_level_is_review(corpus_db):
    assert_migrated(corpus_db.migrate(), corpus_db)
    # Server default (raw SQL that names no trust_level)...
    assert run(try_insert_source("f20-default-sql")) == ("stored", "review")

    # ...and the ORM default.
    async def _orm():
        from scraper.database import SessionLocal
        from scraper.models import ScraperSource

        async with SessionLocal() as db:
            src = ScraperSource(source_name="f20-default-orm", source_url="https://f20.example.invalid/orm")
            db.add(src)
            await db.commit()
            return (await fetch("SELECT trust_level FROM scraper_sources WHERE source_name = 'f20-default-orm'"))[0][0]

    assert run(_orm()) == "review"
    _oid, literals, valid, default = run(constraint_state())
    assert literals == SPEC_TRUST_LEVELS and valid is True
    assert default == {"review"}


# ---------------------------------------------------------------------------------------------
# (b) a legacy database is upgraded once by migrate; a re-run changes nothing
# ---------------------------------------------------------------------------------------------
LEGACY_ROWS = {
    # name: stored legacy value
    "f20-legacy-semi": "semi_trusted",
    "f20-legacy-untrusted": "untrusted",
    "f20-legacy-quarantined": "quarantined",
    "f20-legacy-trusted": "trusted",
    "NasirLawSite": "semi_trusted",
    "SupremeCourt": "semi_trusted",
    "PakistanLawSite": "trusted",
}


def test_b_legacy_database_is_upgraded_by_migrate_and_a_rerun_is_a_no_op(corpus_db):
    build_legacy_schema(corpus_db)
    for name, value in LEGACY_ROWS.items():
        run(execute(
            "INSERT INTO scraper_sources (source_name, source_url, trust_level) VALUES (:n, 'https://f20.example.invalid/', :t)",
            params={"n": name, "t": value},
        ))
    # A row the old default filled in: 'trusted' under main.
    run(execute("INSERT INTO scraper_sources (source_name, source_url) VALUES ('f20-legacy-default', 'https://f20.example.invalid/')"))
    assert run(trust_by_name())["f20-legacy-default"] == "trusted"
    assert run(constraint_state())[1] == {"trusted", "semi_trusted", "untrusted", "quarantined"}

    # First run: upgrade, then seed. Seeding inserts the sources the legacy DB lacks with
    # 'review', which the old CHECK would refuse: so this also proves upgrade-before-seed.
    assert_migrated(corpus_db.migrate(), corpus_db)

    trust = run(trust_by_name())
    assert trust["f20-legacy-semi"] == "review"
    assert trust["f20-legacy-untrusted"] == "review"
    assert trust["f20-legacy-quarantined"] == "review"
    assert trust["f20-legacy-trusted"] == "trusted"
    assert trust["f20-legacy-default"] == "trusted"  # explicit-or-default trusted is kept as is
    assert trust["NasirLawSite"] == "review"
    assert trust["SupremeCourt"] == "review"
    assert trust["PakistanLawSite"] == "trusted"
    for name, expected in SEEDED_TRUST.items():
        assert trust[name] == expected, f"{name}: {trust[name]!r} != {expected!r}"
    assert set(trust.values()) <= SPEC_TRUST_LEVELS

    oid1, literals, valid, default = run(constraint_state())
    assert literals == SPEC_TRUST_LEVELS and valid is True, literals
    assert default == {"review"}
    assert run(try_insert_source("f20-after-upgrade-semi", "semi_trusted")) == ("refused", CHECK_VIOLATION)
    assert run(try_insert_source("f20-after-upgrade-default")) == ("stored", "review")

    # Second run: nothing changes - same rows, same constraint object (not dropped and re-added).
    before = run(sources_snapshot())
    second = corpus_db.migrate()
    assert_migrated(second, corpus_db)
    assert run(sources_snapshot()) == before
    oid2, literals2, valid2, default2 = run(constraint_state())
    assert (oid2, literals2, valid2, default2) == (oid1, SPEC_TRUST_LEVELS, True, {"review"})


def test_b_migrate_as_schema_owner_upgrades_and_api_init_db_stays_dml_only(corpus_db):
    """F30 roles: migrate runs as the schema owner (NOSUPERUSER); the API's startup init_db() runs
    as the DML-only runtime role and must not attempt the vocabulary DDL. Run on a legacy
    database, so an init_db() that tried the upgrade would fail with insufficient_privilege."""
    from scraper import database

    build_legacy_schema(corpus_db)
    mig, mig_pw = corpus_db.create_role("f20_mig")
    app, app_pw = corpus_db.create_role("f20_app")
    corpus_db.admin(
        f'REVOKE ALL ON DATABASE "{corpus_db.name}" FROM PUBLIC',
        f'GRANT CONNECT ON DATABASE "{corpus_db.name}" TO "{mig}", "{app}"',
        "REVOKE ALL ON SCHEMA public FROM PUBLIC",
        f'GRANT USAGE ON SCHEMA public TO "{mig}", "{app}"',
        f'GRANT CREATE ON SCHEMA public TO "{mig}"',
        # As provision-roles.sh does for a pre-F30 volume: application tables move to the owner.
        *[f'ALTER TABLE "{t}" OWNER TO "{mig}"' for t in (
            "courts", "scraper_sources", "case_law_master", "statutes_master", "scraper_staging",
            "statutes_staging", "scraper_jobs", "quarantine_queue", "embedding_queue")],
        f'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "{app}"',
        f'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "{app}"',
    )
    # Every seeded source already exists (legacy values), so the runtime seed step is UPDATE-only.
    for name in SEEDED_TRUST:
        legacy = "trusted" if SEEDED_TRUST[name] == "trusted" else "semi_trusted"
        run(execute(
            "INSERT INTO scraper_sources (source_name, source_url, trust_level) VALUES (:n, 'https://f20.example.invalid/', :t)",
            params={"n": name, "t": legacy},
        ))

    # 1. API startup as the runtime role: succeeds and leaves the vocabulary untouched.
    app_engine = corpus_db.engine_for(corpus_db.url_as(app, app_pw))
    saved = database.engine
    database.engine = app_engine
    database.SessionLocal.configure(bind=app_engine)
    try:
        run(database.init_db())
        who = run(fetch("SELECT current_user"))[0][0]
        assert who == app
        denied = run(try_ddl_as_current("ALTER TABLE scraper_sources ALTER COLUMN trust_level SET DEFAULT 'review'"))
        assert denied == "42501", f"runtime role could run DDL: {denied}"
    finally:
        database.SessionLocal.configure(bind=saved)
        database.engine = saved
        run(app_engine.dispose())
    assert run(constraint_state())[1] == {"trusted", "semi_trusted", "untrusted", "quarantined"}
    assert run(trust_by_name())["NasirLawSite"] == "semi_trusted"

    # 2. migrate as the schema owner upgrades.
    assert_migrated(corpus_db.migrate(corpus_db.url_as(mig, mig_pw)), corpus_db)
    _oid, literals, valid, default = run(constraint_state())
    assert literals == SPEC_TRUST_LEVELS and valid is True and default == {"review"}
    assert run(trust_by_name()) == SEEDED_TRUST


async def try_ddl_as_current(sql):
    from sqlalchemy import text

    from scraper import database

    try:
        async with database.engine.begin() as conn:
            await conn.execute(text(sql))
    except Exception as exc:  # noqa: BLE001
        return sqlstate(exc)
    return "SUCCEEDED"


# ---------------------------------------------------------------------------------------------
# (c) seeding and promotion outcomes
# ---------------------------------------------------------------------------------------------
def test_c_every_seeded_source_carries_a_value_from_the_vocabulary(corpus_db):
    assert_migrated(corpus_db.migrate(), corpus_db)
    assert run(trust_by_name()) == SEEDED_TRUST
