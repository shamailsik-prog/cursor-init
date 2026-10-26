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
import threading
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
            "statutes_staging", "scraper_jobs", "quarantine_queue", "embedding_queue",
            "harvest_operator_state")],
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


async def _make_sources(specs):
    """specs: {key: (source_name, trust_level)} -> {key: id}."""
    from scraper.database import SessionLocal
    from scraper.models import ScraperSource

    async with SessionLocal() as db:
        objs = {
            key: ScraperSource(source_name=name, source_url=f"https://f20.example.invalid/{key}", trust_level=trust)
            for key, (name, trust) in specs.items()
        }
        db.add_all(objs.values())
        await db.commit()
        return {key: obj.id for key, obj in objs.items()}


async def _stage(rows):
    """rows: {key: dict of ScraperStaging fields} -> {key: id}. Every row is normalised."""
    from scraper.database import SessionLocal
    from scraper.models import ScraperStaging

    async with SessionLocal() as db:
        objs = {}
        for key, fields in rows.items():
            fields = {
                "source_url": f"https://f20.example.invalid/judgment/{key}",
                "extracted_title": f"F20 Fixture {key} v. Test",
                "extracted_year": 2099,
                "raw_text": "synthetic F20 fixture text",
                # Audit F19: a bench and the harvested page, so a promoted row publishes into Annex A
                # with complete provenance (plan Task 8 mapping).
                "extracted_bench_type": "single",
                "raw_html": "<p>synthetic F20 fixture</p>",
                "normalised": True,
                **fields,
            }
            objs[key] = ScraperStaging(**fields)
        db.add_all(objs.values())
        await db.commit()
        return {key: obj.id for key, obj in objs.items()}


async def _outcomes():
    staging = await fetch(
        "SELECT id, promoted, quarantined, quarantine_reason, promoted_to_id FROM scraper_staging ORDER BY id"
    )
    queue = await fetch("SELECT staging_id, reason, source_id FROM quarantine_queue ORDER BY staging_id, id")
    master = await fetch("SELECT id, citation FROM case_law_master ORDER BY id")
    embed = await fetch("SELECT record_id, table_name FROM embedding_queue ORDER BY record_id")
    return staging, queue, master, embed


# Audit F19: promotion publishes into the Annex A contract. What it published, read as the admin.
ANNEX_A_TABLES = (
    "source_provenance", "judgment", "citation", "treatment", "statute", "statute_section",
    "statute_section_version", "corpus_publication", "corpus_publication_item", "corpus_publication_grant",
    "corpus_metadata",
)


async def _annex_a_promoted():
    """(judgment id, citation_text) for every promoted citation of a promoted judgment."""
    return await fetch(
        "SELECT j.id, c.citation_text FROM judgment j JOIN citation c ON c.judgment_id = j.id "
        "WHERE j.review_status = 'promoted' AND c.review_status = 'promoted' ORDER BY c.citation_text"
    )


async def _annex_a_snapshot():
    return {table: await fetch(f"SELECT * FROM {table} ORDER BY 1") for table in ANNEX_A_TABLES}


def _promote():
    from scraper.tasks.promotion import promote_staging_records

    return run(promote_staging_records())


def _promote_as_runtime_role(corpus_db):
    """Promotion as the compose runtime role (DML on its own tables, corpus_writer by SET ROLE only),
    as in production after PR 2b. A superuser is refused by publish_batch (plan D2)."""
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        return _promote()


def test_c_promotion_decides_through_the_trust_vocabulary(corpus_db):
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({
        "trusted": ("f20-trusted", "trusted"),
        "review": ("f20-review", "review"),
        "blocked": ("f20-blocked", "blocked"),
        "deleted": ("f20-deleted", "trusted"),
        "renamed": ("f20-old-name", "trusted"),
    }))
    ids = run(_stage({
        "trusted_050": dict(source_site="f20-trusted", source_id=src["trusted"], extracted_citation="2099 SCMR 1", confidence_score=0.5),
        "trusted_049": dict(source_site="f20-trusted", source_id=src["trusted"], extracted_citation="2099 SCMR 2", confidence_score=0.49),
        "review": dict(source_site="f20-review", source_id=src["review"], extracted_citation="2099 SCMR 3", confidence_score=0.99),
        "blocked": dict(source_site="f20-blocked", source_id=src["blocked"], extracted_citation="2099 SCMR 4", confidence_score=0.99),
        "unknown_site": dict(source_site="f20-no-such-source", extracted_citation="2099 SCMR 5", confidence_score=0.99),
        "deleted": dict(source_site="f20-deleted", source_id=src["deleted"], extracted_citation="2099 SCMR 6", confidence_score=0.99),
        "renamed": dict(source_site="f20-old-name", source_id=src["renamed"], extracted_citation="2099 SCMR 7", confidence_score=0.9),
        # The FK is authoritative: a review source cannot borrow a trusted source's name.
        "fk_beats_name": dict(source_site="f20-trusted", source_id=src["review"], extracted_citation="2099 SCMR 8", confidence_score=0.99),
        # No FK: the harvester's parsing_metadata.source_name comes before the source_site label.
        "metadata_name": dict(source_site="f20-site-label", parsing_metadata={"source_name": "f20-trusted"}, extracted_citation="2099 SCMR 9", confidence_score=0.8),
        # No FK, no metadata: the source_site label, as today's harvesters stage rows.
        "site_only": dict(source_site="f20-trusted", extracted_citation="2099 SCMR 10", confidence_score=0.7),
    }))
    # After staging: the source is deleted (FK -> NULL), and another renamed.
    run(execute(
        "DELETE FROM scraper_sources WHERE id = :d",
        "UPDATE scraper_sources SET source_name = 'f20-new-name' WHERE id = :r",
        params={"d": src["deleted"], "r": src["renamed"]},
    ))

    result = _promote_as_runtime_role(corpus_db)

    staging, queue, master, embed = run(_outcomes())
    published = run(_annex_a_promoted())
    by_id = {row[0]: row for row in staging}
    expected = {
        "trusted_050": ("promoted", None),
        "trusted_049": ("quarantined", "low_confidence"),
        "review": ("quarantined", "review_source"),
        "blocked": ("quarantined", "blocked_source"),
        "unknown_site": ("quarantined", "unknown_source"),
        "deleted": ("quarantined", "unknown_source"),
        "renamed": ("promoted", None),
        "fk_beats_name": ("quarantined", "review_source"),
        "metadata_name": ("promoted", None),
        "site_only": ("promoted", None),
    }
    queue_reason = {row[0]: row[1] for row in queue}
    actual = {}
    for key in expected:
        _id, promoted, quarantined, staged_reason, _to = by_id[ids[key]]
        got = "promoted" if promoted and not quarantined else "quarantined" if quarantined and not promoted else "pending"
        actual[key] = (got, staged_reason if quarantined else None)
    wrong = {key: {"got": actual[key], "want": expected[key]} for key in expected if actual[key] != expected[key]}
    assert not wrong, f"staging outcome differs from the trust rule: {wrong}"
    # The durable reason is on the review-queue row too, and nothing promoted is queued.
    assert {key: queue_reason.get(ids[key]) for key in expected} == {key: reason for key, (_s, reason) in expected.items()}
    # Audit F19: promoted rows are published into Annex A, and only they reach it.
    promoted_citations = {"2099 SCMR 1", "2099 SCMR 7", "2099 SCMR 9", "2099 SCMR 10"}
    assert {row[1] for row in published} == promoted_citations, "only promoted rows may reach Annex A"
    assert len(published) == 4
    judgment_ids = {row[0] for row in published}
    assert len(judgment_ids) == 4
    assert {by_id[ids[k]][4] for k in ("trusted_050", "renamed", "metadata_name", "site_only")} == judgment_ids
    # Ruling 10: promotion no longer writes case_law_master or queues embeddings.
    assert master == [] and embed == []
    assert result == {"promoted": 4, "attached": 0, "quarantined": 6, "failed": 0}

    # A second pass has nothing left to decide and writes nothing new.
    annex_a = run(_annex_a_snapshot())
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 0, "attached": 0, "quarantined": 0, "failed": 0}
    assert run(_outcomes()) == (staging, queue, master, embed)
    assert run(_annex_a_snapshot()) == annex_a


# ---------------------------------------------------------------------------------------------
# (d) F22: a citation-free record is quarantined; a bad record does not stop the batch
# ---------------------------------------------------------------------------------------------
def test_d_citation_free_record_is_quarantined_and_the_batch_continues(corpus_db, caplog):
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    # A database error on one row (F22's isolation property, now on Annex A): the publication of the
    # row titled "F22 fault 2099" is refused by a test trigger on judgment.
    corpus_db.admin(
        """CREATE FUNCTION f22_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF NEW.case_title = 'F22 fault 2099' THEN
               RAISE EXCEPTION 'f22 marker %', NEW.case_title USING ERRCODE = '23514';
             END IF;
             RETURN NEW;
           END $$""",
        "CREATE TRIGGER f22_test_fault BEFORE INSERT OR UPDATE ON judgment FOR EACH ROW EXECUTE FUNCTION f22_test_fault()",
    )
    src = run(_make_sources({"trusted": ("f20-trusted", "trusted")}))
    ids = run(_stage({
        "no_citation": dict(source_site="f20-trusted", source_id=src["trusted"], extracted_citation=None, confidence_score=0.9),
        "blank_citation": dict(source_site="f20-trusted", source_id=src["trusted"], extracted_citation="   ", confidence_score=0.9),
        "good": dict(source_site="f20-trusted", source_id=src["trusted"], extracted_citation="2099 SCMR 21", confidence_score=0.9),
        # The fault trigger above refuses this row's judgment: a database error on this row.
        "db_error": dict(source_site="f20-trusted", source_id=src["trusted"], extracted_citation="2099 SCMR 22", extracted_title="F22 fault 2099", confidence_score=0.9),
        "good_too": dict(source_site="f20-trusted", source_id=src["trusted"], extracted_citation="2099 SCMR 23", confidence_score=0.9),
    }))

    with caplog.at_level(logging.INFO):
        result = _promote_as_runtime_role(corpus_db)

    staging, queue, master, _embed = run(_outcomes())
    published = run(_annex_a_promoted())
    by_id = {row[0]: row for row in staging}
    assert by_id[ids["no_citation"]][1:4] == (False, True, "citation_missing")
    assert by_id[ids["blank_citation"]][1:4] == (False, True, "citation_missing")
    assert by_id[ids["good"]][1:3] == (True, False)
    assert by_id[ids["good_too"]][1:3] == (True, False)
    # The failing row's own work is rolled back (its Annex A publication with it), then it is
    # quarantined with a durable reason (exception class only), so a poison record is not retried
    # forever (re-audit LOW-3).
    assert by_id[ids["db_error"]][1:4] == (False, True, "promotion_error:IntegrityError")
    assert sorted((row[0], row[1]) for row in queue) == sorted([
        (ids["no_citation"], "citation_missing"),
        (ids["blank_citation"], "citation_missing"),
        (ids["db_error"], "promotion_error:IntegrityError"),
    ])
    assert {row[1] for row in published} == {"2099 SCMR 21", "2099 SCMR 23"}
    assert master == []  # F19 ruling 10: promotion no longer writes case_law_master
    assert run(fetch("SELECT count(*) FROM corpus_publication WHERE batch_key = :k",
                     k=f"staging/{ids['db_error']}")) == [(0,)]
    assert result == {"promoted": 2, "attached": 0, "quarantined": 2, "failed": 1}

    failures = [r.getMessage() for r in caplog.records if "promotion.record_failed" in r.getMessage()]
    assert len(failures) == 1, failures
    assert str(ids["db_error"]) in failures[0] and "IntegrityError" in failures[0]
    assert "f22 marker" not in failures[0] and "F22 fault 2099" not in failures[0], "log carries row data"


# ---------------------------------------------------------------------------------------------
# (e) the dispatcher harvests only trusted and review sources
# ---------------------------------------------------------------------------------------------
def install_harvester_spies(monkeypatch):
    """Replace every harvester module the dispatcher can route to with a spy, so a call is recorded
    and no network is touched."""
    calls = []
    modules = {
        "pakistanlawsite": "scrape_pakistanlawsite",
        "nasirlawsite": "scrape_nasirlawsite",
        "pakistancode": "scrape_pakistancode",
        "shc": "scrape_shc",
        "supremecourt": "scrape_supremecourt",
        "lahorehighcourt": "scrape_lahorehighcourt",
        "peshawarhighcourt": "scrape_peshawarhighcourt",
        "balochistanhighcourt": "scrape_balochistanhighcourt",
        "islamabadhighcourt": "scrape_islamabadhighcourt",
        "nationalassembly": "scrape_nationalassembly",
    }
    for module, func in modules.items():
        spy = types.ModuleType(f"scraper.tasks.{module}")

        async def _harvest(source, db, _func=func):
            calls.append((_func, source.source_name))

        setattr(spy, func, _harvest)
        monkeypatch.setitem(sys.modules, f"scraper.tasks.{module}", spy)
    return calls


def test_e_dispatcher_never_harvests_blocked_or_unknown_sources(corpus_db, monkeypatch):
    assert_migrated(corpus_db.migrate(), corpus_db)
    # Unknown values cannot be stored through the schema any more; drop the CHECK to model a
    # drifted or un-migrated database, which the dispatcher must still refuse on its own.
    run(execute(
        f"ALTER TABLE scraper_sources DROP CONSTRAINT {CHECK_NAME}",
        "UPDATE scraper_sources SET trust_level = 'blocked' WHERE source_name = 'NasirLawSite'",
        "UPDATE scraper_sources SET trust_level = 'semi_trusted' WHERE source_name = 'PakistanCode'",
        "UPDATE scraper_sources SET trust_level = 'TRUSTED' WHERE source_name = 'NationalAssembly'",
        "UPDATE scraper_sources SET trust_level = '' WHERE source_name = 'LahoreHighCourt'",
        "UPDATE scraper_sources SET trust_level = 'trusted' WHERE source_name = 'PakistanLawSite'",
        "UPDATE scraper_sources SET trust_level = 'review' WHERE source_name = 'SupremeCourt'",
    ))
    calls = install_harvester_spies(monkeypatch)
    from scraper.tasks.dispatcher import _run_async

    for name in ("NasirLawSite", "PakistanCode", "NationalAssembly", "LahoreHighCourt"):
        run(_run_async(name))
    assert calls == [], f"harvested a blocked/unknown source: {calls}"

    # Positive controls: the spies do record a permitted harvest.
    run(_run_async("PakistanLawSite"))
    run(_run_async("SupremeCourt"))
    assert calls == [("scrape_pakistanlawsite", "PakistanLawSite"), ("scrape_supremecourt", "SupremeCourt")]


# ---------------------------------------------------------------------------------------------
# (h) re-audit round 1 (PR #48): MEDIUM-1, LOW-1 .. LOW-4
# ---------------------------------------------------------------------------------------------
def _outcome_by_key(ids):
    staging = {row[0]: row for row in run(_outcomes())[0]}
    return {
        key: ("promoted" if staging[sid][1] and not staging[sid][2]
              else staging[sid][3] if staging[sid][2] and not staging[sid][1]
              else "pending")
        for key, sid in ids.items()
    }


def test_h_a_present_identifier_that_misses_never_falls_through_to_a_trusted_label(corpus_db):
    """MEDIUM-1: the most specific identifier present decides; if it no longer resolves (source
    deleted or renamed) the record is unknown_source. It never falls through to a less specific
    label - here every row also carries a trusted family label, the shape the court harvesters use
    (source_site "SupremeCourt" for source "SupremeCourtPublic"). Since F19 the promoted control is
    published into Annex A, as the runtime role."""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({
        "family": ("f20-family", "trusted"),
        "a": ("f20-specific-a", "review"),
        "b": ("f20-specific-b", "review"),
        "c": ("f20-specific-c", "review"),
        "d": ("f20-specific-d", "review"),
    }))
    ids = run(_stage({
        # FK plus the stamps every harvester now writes; FK becomes NULL on delete (ON DELETE SET NULL).
        "fk_deleted": dict(source_id=src["a"], parsing_metadata={"source_id": str(src["a"]), "source_name": "f20-specific-a"},
                           source_site="f20-family", extracted_citation="2099 SCMR 41", confidence_score=0.9),
        "meta_source_id_deleted": dict(parsing_metadata={"source_id": str(src["b"])}, source_site="f20-family",
                                       extracted_citation="2099 SCMR 42", confidence_score=0.9),
        "meta_source_name_renamed": dict(parsing_metadata={"source_name": "f20-specific-c"}, source_site="f20-family",
                                         extracted_citation="2099 SCMR 43", confidence_score=0.9),
        "meta_source_name_deleted": dict(parsing_metadata={"source_name": "f20-specific-d"}, source_site="f20-family",
                                         extracted_citation="2099 SCMR 44", confidence_score=0.9),
        # A malformed identifier is present and resolves to nothing: also unknown, never the label.
        "meta_source_id_malformed": dict(parsing_metadata={"source_id": "not-a-uuid"}, source_site="f20-family",
                                         extracted_citation="2099 SCMR 45", confidence_score=0.9),
        # Control: with no more specific identifier, the label itself is the identifier.
        "label_only": dict(source_site="f20-family", extracted_citation="2099 SCMR 46", confidence_score=0.9),
    }))
    run(execute(
        "DELETE FROM scraper_sources WHERE id IN (:a, :b, :d)",
        "UPDATE scraper_sources SET source_name = 'f20-specific-c-v2' WHERE id = :c",
        params={"a": src["a"], "b": src["b"], "c": src["c"], "d": src["d"]},
    ))

    result = _promote_as_runtime_role(corpus_db)

    got = _outcome_by_key(ids)
    want = {key: "unknown_source" for key in ids}
    want["label_only"] = "promoted"
    assert got == want, got
    _staging, queue, master, _embed = run(_outcomes())
    published = run(_annex_a_promoted())
    assert {row[1] for row in published} == {"2099 SCMR 46"}, "only the label-only control may be promoted"
    assert master == []  # F19 ruling 10: promotion no longer writes case_law_master
    assert sorted(row[1] for row in queue) == ["unknown_source"] * 5
    assert result == {"promoted": 1, "attached": 0, "quarantined": 5, "failed": 0}


def test_h_trust_is_decided_before_the_duplicate_check(corpus_db):
    """LOW-4 + round-2 L3: a record that may not be promoted is quarantined with its trust reason
    whether or not its citation is already published, and nothing is published for it. A promotable
    duplicate follows FINAL_2's DEDUPLICATION rule ("attach ... to the existing judgment row and skip
    the rest").

    Migrated to F19 (the case_law_master duplicate query is gone): the duplicate decision is the
    audited publication's, against Annex A. An identical re-stage is `unchanged`: attached to the
    existing judgment and skipped (promoted, promoted_to_id = that judgment, nothing rewritten, no
    review-queue row, counted `attached`). A changed trusted re-stage is `updated` onto the same
    judgment (counted `promoted`). A bench-less re-stage is refused as promoted_row_protected (D9), the
    only re-stage that goes to review. Two identical promotable rows with one new citation in one run
    yield one judgment and one citation row: the first is published, the second attached to it.
    Explicit ids fix the processing order."""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted"), "b": ("f20-blocked", "blocked"), "r": ("f20-review", "review")}))
    original = dict(source_id=src["t"], source_site="f20-trusted", extracted_citation="2099 SCMR 901", confidence_score=0.9,
                    source_url="https://f20.example.invalid/judgment/original", extracted_title="F20 Fixture original v. Test")
    run(_stage({"original": original}))
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 1, "attached": 0, "quarantined": 0, "failed": 0}
    judgment_d1 = run(_annex_a_promoted())[0][0]
    # The pair below is one judgment staged twice with identical content.
    pair = dict(source_id=src["t"], source_site="f20-trusted", extracted_citation="2099 SCMR 902", confidence_score=0.9,
                source_url="https://f20.example.invalid/judgment/pair", extracted_title="F20 Fixture pair v. Test")

    uid = lambda n: uuid.UUID(f"00000000-0000-4000-8000-{n:012d}")  # noqa: E731
    ids = run(_stage({
        "blocked_dup": dict(id=uid(1), source_id=src["b"], source_site="f20-blocked", extracted_citation="2099 SCMR 901", confidence_score=0.9),
        "review_dup": dict(id=uid(2), source_id=src["r"], source_site="f20-review", extracted_citation="2099 SCMR 901", confidence_score=0.9),
        "low_conf_dup": dict(id=uid(3), source_id=src["t"], source_site="f20-trusted", extracted_citation="2099 SCMR 901", confidence_score=0.3),
        "trusted_dup_identical": dict(original, id=uid(4)),
        "trusted_dup_changed": dict(id=uid(5), source_id=src["t"], source_site="f20-trusted", extracted_citation="2099 SCMR 901", confidence_score=0.9),
        "trusted_dup_no_bench": dict(original, id=uid(6), extracted_bench_type=None),
        # Two identical promotable rows with the same new citation in one batch: one judgment is
        # published by the first, and the second is attached to it.
        "pair_1": dict(pair, id=uid(10)),
        "pair_2": dict(pair, id=uid(11)),
    }))
    result = _promote_as_runtime_role(corpus_db)

    got = _outcome_by_key(ids)
    assert got == {
        "blocked_dup": "blocked_source",
        "review_dup": "review_source",
        "low_conf_dup": "low_confidence",
        "trusted_dup_identical": "promoted",
        "trusted_dup_changed": "promoted",
        "trusted_dup_no_bench": "promoted_row_protected",
        "pair_1": "promoted",
        "pair_2": "promoted",
    }, got
    decisions = dict(run(fetch(
        "SELECT p.batch_key, i.decision || coalesce(':' || i.reason, '') FROM corpus_publication p "
        "JOIN corpus_publication_item i ON i.publication_id = p.id WHERE i.entity_type = 'judgment'"
    )))
    key = lambda name: f"staging/{ids[name]}"  # noqa: E731
    for name in ("blocked_dup", "review_dup", "low_conf_dup"):
        assert key(name) not in decisions, f"{name}: a record that may not be promoted was published"
    assert decisions[key("trusted_dup_identical")] == "unchanged"
    assert decisions[key("trusted_dup_changed")] == "updated"
    assert decisions[key("trusted_dup_no_bench")] == "rejected:promoted_row_protected"
    assert (decisions[key("pair_1")], decisions[key("pair_2")]) == ("promoted", "unchanged")

    published = run(_annex_a_promoted())
    assert sorted(row[1] for row in published) == ["2099 SCMR 901", "2099 SCMR 902"]
    assert run(fetch("SELECT count(*) FROM judgment")) == [(2,)] and run(fetch("SELECT count(*) FROM citation")) == [(2,)]
    staging, queue, master, embed = run(_outcomes())
    by_id = {row[0]: row for row in staging}
    judgment_d2 = next(row[0] for row in published if row[1] == "2099 SCMR 902")
    # Attached: closed (promoted flag, promoted_to_id = the existing judgment), not quarantined.
    assert by_id[ids["trusted_dup_identical"]][1:5] == (True, False, None, judgment_d1)
    assert by_id[ids["pair_2"]][1:5] == (True, False, None, judgment_d2)
    # Updated onto the same judgment, and the first of the pair published it.
    assert by_id[ids["trusted_dup_changed"]][1:5] == (True, False, None, judgment_d1)
    assert by_id[ids["pair_1"]][1:5] == (True, False, None, judgment_d2)
    # Only the trust reasons and the protected re-stage reach the review queue; an attached duplicate
    # writes no review-queue row.
    assert sorted(row[1] for row in queue) == ["blocked_source", "low_confidence", "promoted_row_protected", "review_source"]
    assert master == [] and embed == []  # F19 ruling 10: no case_law_master row, no embedding
    assert result == {"promoted": 2, "attached": 2, "quarantined": 4, "failed": 0}


def test_h_a_python_error_leaves_the_record_pending_and_the_batch_continues(corpus_db, monkeypatch, caplog):
    """LOW-3 + round-4 (Codex P1): a Python exception mid-batch says nothing about the record (it
    has no SQLSTATE, so it may be a deployment or code fault). The record's work is rolled back and
    it is left pending, not quarantined, so it retries once the fault is fixed; the rest of the
    batch is promoted. The log carries the id and class only, marked systemic. Since F19 the rest
    of the batch is published into Annex A, as the runtime role."""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))
    ids = run(_stage({
        f"k{i}": dict(source_id=src["t"], source_site="f20-trusted", extracted_citation=f"2099 SCMR 7{i}",
                      confidence_score=0.61 if i == 2 else 0.9)
        for i in range(5)
    }))
    import scraper.tasks.promotion as promo

    real = promo.publication_decision

    def boom(trust, confidence):
        if confidence == 0.61:
            raise RuntimeError("boom with row data 2099 SCMR 72")
        return real(trust, confidence)

    monkeypatch.setattr(promo, "publication_decision", boom)
    with caplog.at_level(logging.INFO):
        result = _promote_as_runtime_role(corpus_db)

    assert result == {"promoted": 4, "attached": 0, "quarantined": 0, "failed": 1}
    staging, queue, master, _embed = run(_outcomes())
    by_id = {row[0]: row for row in staging}
    assert by_id[ids["k2"]][1:4] == (False, False, None), "a Python error must leave the record pending"
    assert queue == []
    published = run(_annex_a_promoted())
    assert sorted(row[1] for row in published) == ["2099 SCMR 70", "2099 SCMR 71", "2099 SCMR 73", "2099 SCMR 74"]
    assert master == []  # F19 ruling 10
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert f"promotion.record_failed staging_id={ids['k2']} error=RuntimeError" in messages
    assert "systemic=true" in messages
    assert "2099 SCMR 72" not in messages, "log carries row data"

    # The record is retried on the next run (still failing while the fault is there), then
    # promoted once it is gone.
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 0, "attached": 0, "quarantined": 0, "failed": 1}
    monkeypatch.setattr(promo, "publication_decision", real)
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 1, "attached": 0, "quarantined": 0, "failed": 0}


def test_h_if_the_error_quarantine_also_fails_the_batch_still_continues(corpus_db, monkeypatch, caplog):
    """LOW-3: if even the promotion_error quarantine write fails, that is logged (class only) and the
    batch continues; the record stays pending. (Round 4: the first failure is a record-specific
    database error, the only kind that is quarantined. Since F19 the others publish into Annex A,
    as the runtime role, and the fault is raised on the record's citation insert.)"""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))
    ids = run(_stage({
        f"k{i}": dict(source_id=src["t"], source_site="f20-trusted", extracted_citation=f"2099 SCMR 8{i}",
                      confidence_score=0.9)
        for i in range(3)
    }))
    run(execute(*_raise_on_citation_insert({"2099 SCMR 81": "23505"})))
    import scraper.tasks.promotion as promo

    real_queue = promo.QuarantineQueue

    def queue_that_refuses_error_rows(**fields):
        if str(fields.get("reason", "")).startswith("promotion_error:"):
            raise LookupError("second failure")
        return real_queue(**fields)

    monkeypatch.setattr(promo, "QuarantineQueue", queue_that_refuses_error_rows)
    with caplog.at_level(logging.INFO):
        result = _promote_as_runtime_role(corpus_db)

    assert result == {"promoted": 2, "attached": 0, "quarantined": 0, "failed": 1}
    assert sorted(row[1] for row in run(_annex_a_promoted())) == ["2099 SCMR 80", "2099 SCMR 82"]
    staging = {row[0]: row for row in run(_outcomes())[0]}
    assert staging[ids["k1"]][1:4] == (False, False, None)
    messages = [r.getMessage() for r in caplog.records]
    assert any(f"promotion.error_quarantine_failed staging_id={ids['k1']} error=LookupError" in m for m in messages), messages


def _threaded(fn, n):
    results, errors = [None] * n, []

    def worker(i):
        try:
            results[i] = fn()
        except Exception as exc:  # noqa: BLE001
            errors.append(repr(exc))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(300)
    return results, errors


def test_h_concurrent_runs_never_double_promote(corpus_db):
    """LOW-1 (re-audit attack, adapted to LOW-4 and round-2 L3): four promotion runs at once over
    160 rows. Every citation is staged twice by a trusted source, so a race could publish both
    copies. Exactly one copy is published; the other is attached to it (no review-queue row).

    Migrated to F19: "double promote" now means two Annex A judgments or citation rows for one
    citation, or a copy that fails instead of being decided. Each pair is one judgment staged twice
    with identical content under two spellings of the citation ("PLD 2099 Karachi n" / "PLD 2099
    Sindh n"), so it is also the per-citation lock keyed by the canonical citation that serialises
    them. Whichever copy runs first publishes the judgment; the other finds it `unchanged` and is
    attached to it."""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted"), "r": ("f20-review", "review")}))
    rows = {}
    for i in range(120):
        spelling = "Karachi" if i % 2 == 0 else "Sindh"
        rows[f"t{i}"] = dict(source_id=src["t"], source_site="f20-trusted",
                             extracted_citation=f"PLD 2099 {spelling} {300 + i // 2}", confidence_score=0.9,
                             source_url=f"https://f20.example.invalid/judgment/pair{i // 2}",
                             extracted_title=f"F20 Fixture pair {i // 2} v. Test")
    for i in range(40):
        rows[f"r{i}"] = dict(source_id=src["r"], source_site="f20-review", extracted_citation=f"2099 SCMR {2000 + i}", confidence_score=0.9)
    ids = run(_stage(rows))

    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        # Connect once first: the four threads then share an engine whose dialect is initialised (a
        # brand-new engine's first connect, raced from four event loops at once, is a test artefact).
        assert run(fetch("SELECT 1")) == [(1,)]
        results, errors = _threaded(_promote, 4)
    assert not errors, errors
    staging, queue, master, embed = run(_outcomes())
    assert not [s for s in staging if s[1] and s[2]], "a row is both promoted and quarantined"
    assert not [s for s in staging if not s[1] and not s[2]], "a row was left undecided"
    # Both copies of every citation (both spellings) point at its single Annex A judgment.
    judgment_by_citation = dict(run(fetch("SELECT citation_text, judgment_id FROM citation")))
    by_id = {s[0]: s for s in staging}
    wrong_link = [k for k, sid in ids.items() if k.startswith("t")
                  and by_id[sid][4] != judgment_by_citation[f"PLD 2099 Sindh {300 + int(k[1:]) // 2}"]]
    assert not wrong_link, wrong_link[:3]
    queued = [q[0] for q in queue]
    assert len(queued) == len(set(queued)) == 40, "only the review rows go to the review queue"
    assert sorted(q[1] for q in queue) == ["review_source"] * 40, "a copy failed or was refused"
    citations = [row[0] for row in run(fetch("SELECT citation_text FROM citation WHERE review_status = 'promoted'"))]
    assert len(citations) == len(set(citations)) == 60, (len(citations), len(set(citations)))
    assert set(citations) == {f"PLD 2099 Sindh {300 + k}" for k in range(60)}
    assert run(fetch("SELECT count(*), count(*) FILTER (WHERE review_status = 'promoted') FROM judgment")) == [(60, 60)]
    decisions = sorted(run(fetch(
        "SELECT i.decision, count(*) FROM corpus_publication_item i WHERE i.entity_type = 'judgment' GROUP BY 1"
    )))
    assert decisions == [("promoted", 60), ("unchanged", 60)], decisions
    assert run(fetch("SELECT count(*) FROM corpus_publication WHERE finished_at IS NOT NULL")) == [(120,)]
    assert master == [] and embed == []  # F19 ruling 10
    total = {k: sum(r[k] for r in results) for k in ("promoted", "attached", "quarantined", "failed")}
    assert total == {"promoted": 60, "attached": 60, "quarantined": 40, "failed": 0}, (total, results)


def test_h_for_update_reread_sees_concurrent_quarantine(corpus_db):
    """LOW-1 (re-audit attack): another transaction holds the row lock and quarantines the row;
    promotion waits on the lock, re-reads, and leaves the row alone."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))
    ids = run(_stage({"x": dict(source_id=src["t"], source_site="f20-trusted", extracted_citation="2099 F20 L1", confidence_score=0.9)}))
    locked, release = threading.Event(), threading.Event()

    async def holder():
        from sqlalchemy import text

        eng = corpus_db.engine_for(corpus_db.url)
        try:
            async with eng.begin() as conn:
                await conn.execute(text("SELECT 1 FROM scraper_staging WHERE id = :i FOR UPDATE"), {"i": ids["x"]})
                await conn.execute(text("UPDATE scraper_staging SET quarantined = true, quarantine_reason = 'manual' WHERE id = :i"), {"i": ids["x"]})
                locked.set()
                while not release.is_set():
                    await asyncio.sleep(0.05)
        finally:
            await eng.dispose()

    th = threading.Thread(target=lambda: asyncio.run(holder()))
    th.start()
    assert locked.wait(30)
    out = {}
    pt = threading.Thread(target=lambda: out.setdefault("r", _promote()))
    pt.start()
    pt.join(2.0)
    assert pt.is_alive(), "promotion did not wait on the row lock"
    release.set()
    th.join(30)
    pt.join(60)
    assert out["r"] == {"promoted": 0, "attached": 0, "quarantined": 0, "failed": 0}, out
    _staging, queue, master, _ = run(_outcomes())
    assert master == [] and queue == []


def test_h_permissive_same_name_check_is_not_treated_as_current(corpus_db):
    """LOW-2 (re-audit attack): a CHECK with the right name and literals but a permissive body is
    replaced by migrate."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    run(execute(
        f"ALTER TABLE scraper_sources DROP CONSTRAINT {CHECK_NAME}",
        f"ALTER TABLE scraper_sources ADD CONSTRAINT {CHECK_NAME} CHECK "
        "(trust_level IN ('trusted','review','blocked') OR trust_level IS NOT NULL)",
        "INSERT INTO scraper_sources (source_name, source_url, trust_level) VALUES ('f20-drift', 'https://f20.example.invalid/', 'semi_trusted')",
    ))
    assert_migrated(corpus_db.migrate(), corpus_db)
    assert run(try_insert_source("f20-after-drift", "semi_trusted")) == ("refused", CHECK_VIOLATION)
    assert run(trust_by_name())["f20-drift"] == "review"
    _oid, literals, valid, default = run(constraint_state())
    assert (literals, valid, default) == (SPEC_TRUST_LEVELS, True, {"review"})


def test_h_not_valid_check_is_revalidated(corpus_db):
    """LOW-2 (re-audit attack): the right CHECK added NOT VALID over a legacy row is not current."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    run(execute(
        f"ALTER TABLE scraper_sources DROP CONSTRAINT {CHECK_NAME}",
        "INSERT INTO scraper_sources (source_name, source_url, trust_level) VALUES ('f20-nv', 'https://f20.example.invalid/', 'semi_trusted')",
        f"ALTER TABLE scraper_sources ADD CONSTRAINT {CHECK_NAME} CHECK (trust_level IN ('trusted','review','blocked')) NOT VALID",
    ))
    assert run(constraint_state())[2] is False
    assert_migrated(corpus_db.migrate(), corpus_db)
    assert run(trust_by_name())["f20-nv"] == "review"
    assert run(constraint_state())[2] is True


def test_h_a_fresh_database_is_current_after_one_migrate(corpus_db):
    """LOW-2 guard: the constraint create_all builds is recognised as current, so a second migrate
    on a fresh database issues no DDL (same constraint OID) and says so."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    oid1 = run(constraint_state())[0]
    second = corpus_db.migrate()
    assert_migrated(second, corpus_db)
    assert run(constraint_state())[0] == oid1
    assert "trust vocabulary already current" in second.stderr + second.stdout


def test_h_a_second_run_waits_for_an_unfinished_publication_of_the_same_citation(corpus_db, monkeypatch):
    """LOW-1/LOW-4 + round-2 L3: two runs on *different* staging rows with the same citation,
    interleaved so the second run reaches the citation while the first has published but not yet
    committed it. The second run must wait for the first and then attach its copy to the first's
    judgment - not publish a second copy (refused at commit as a promotion_error).

    Migrated to F19: the hook point is the Annex A publication (case_law_master and the embedding
    queue are gone), and the two rows spell the citation differently ("PLD 2099 Karachi 98" and
    "PLD 2099 Sindh 98") with otherwise identical content, so the per-citation lock must be keyed by
    the canonical citation for B to wait before its own publication. After A commits, B's
    publication finds A's judgment `unchanged` (A's hash as the previous one): B is attached to it,
    one judgment, one citation row, no review-queue row."""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))
    first_id = uuid.UUID("ffffffff-ffff-4fff-bfff-ffffffffffff")
    second_id = uuid.UUID("00000000-0000-4000-8000-000000000001")  # sorts first for run B
    run(_stage({"first": dict(id=first_id, source_id=src["t"], source_site="f20-trusted",
                              extracted_citation="PLD 2099 Karachi 98", confidence_score=0.9,
                              source_url="https://f20.example.invalid/judgment/race", extracted_title="F20 Fixture race v. Test")}))

    import scraper.tasks.promotion as promo

    real_publish = promo.publish_batch
    a_paused, b_publishing = threading.Event(), threading.Event()
    observed = {}

    async def publish_batch(conn, batch, actor_id):
        if threading.current_thread().name == "run-A":
            result = await real_publish(conn, batch, actor_id)  # published, not yet committed
            a_paused.set()
            # B gets this long to (wrongly) reach its own publication of the same citation.
            observed["b_published_while_a_open"] = b_publishing.wait(5)
            return result
        b_publishing.set()
        return await real_publish(conn, batch, actor_id)

    monkeypatch.setattr(promo, "publish_batch", publish_batch)
    out = {}
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        run_a = threading.Thread(target=lambda: out.setdefault("A", _promote()), name="run-A")
        run_a.start()
        assert a_paused.wait(30), "run A never reached its publication"
        run(_stage({"second": dict(id=second_id, source_id=src["t"], source_site="f20-trusted",
                                   extracted_citation="PLD 2099 Sindh 98", confidence_score=0.9,
                                   source_url="https://f20.example.invalid/judgment/race", extracted_title="F20 Fixture race v. Test")}))
        run_b = threading.Thread(target=lambda: out.setdefault("B", _promote()), name="run-B")
        run_b.start()
        run_a.join(60)
        run_b.join(60)

    assert observed == {"b_published_while_a_open": False}, "run B did not wait for run A's citation lock"
    assert out["A"] == {"promoted": 1, "attached": 0, "quarantined": 0, "failed": 0}, out
    assert out["B"] == {"promoted": 0, "attached": 1, "quarantined": 0, "failed": 0}, out
    staging, queue, master, _embed = run(_outcomes())
    by_id = {row[0]: row for row in staging}
    assert by_id[first_id][1:3] == (True, False)
    # B waited for A, then attached its copy to A's judgment instead of publishing a second one.
    assert by_id[second_id][1:5] == (True, False, None, by_id[first_id][4])
    assert by_id[first_id][4] is not None
    assert [row[1] for row in run(_annex_a_promoted())] == ["PLD 2099 Sindh 98"]
    assert run(fetch("SELECT count(*) FROM judgment")) == [(1,)]
    audit = run(fetch(
        "SELECT p.batch_key, p.seq, i.decision, i.content_sha256, i.prev_sha256 FROM corpus_publication p "
        "JOIN corpus_publication_item i ON i.publication_id = p.id WHERE i.entity_type = 'judgment' ORDER BY p.seq"
    ))
    assert [(row[0], row[2]) for row in audit] == [(f"staging/{first_id}", "promoted"), (f"staging/{second_id}", "unchanged")]
    assert audit[1][4] == audit[0][3], "B decided against A's committed publication"
    assert master == [] and queue == []  # F19 ruling 10; an attached copy writes no review-queue row


# ---------------------------------------------------------------------------------------------
# (i) re-audit round 2 (PR #48): L2 transient database errors
# ---------------------------------------------------------------------------------------------
def _interrupt_the_promotion_waiting_on(corpus_db, staging_id, terminate, started, done):
    """Hold staging_id's row lock; once promotion blocks on it, terminate or cancel that backend
    (the backend-terminate / statement-cancel repro from the re-audit), then release the lock."""

    async def holder():
        from sqlalchemy import text

        eng = corpus_db.engine_for(corpus_db.url)
        try:
            async with eng.begin() as conn:
                await conn.execute(text("SELECT 1 FROM scraper_staging WHERE id = :i FOR UPDATE"), {"i": staging_id})
                started.set()
                for _ in range(600):
                    await conn.execute(text("SELECT pg_stat_clear_snapshot()"))
                    waiting = (await conn.execute(text(
                        "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid() "
                        # (pg_stat_activity truncates the ORM's long column list, so match its start)
                        "AND datname = current_database() AND query ILIKE '%scraper_staging%'"))).all()
                    if waiting:
                        fn = "pg_terminate_backend" if terminate else "pg_cancel_backend"
                        await conn.execute(text(f"SELECT {fn}(:p)"), {"p": waiting[0][0]})
                        break
                    await asyncio.sleep(0.05)
        finally:
            await eng.dispose()
            done.set()

    threading.Thread(target=lambda: asyncio.run(holder())).start()


@pytest.mark.parametrize("terminate", [True, False], ids=["terminate_backend", "cancel_statement"])
@pytest.mark.parametrize("pool", ["production_queuepool", "test_nullpool"])
def test_i_a_transient_database_error_leaves_the_record_pending(corpus_db, terminate, pool, caplog):
    """Round-2 L2: a transient error (connection lost, SQLSTATE class 08/40/53/57, or 55P03) is not
    the record's fault. The record is left pending (not quarantined), reported as failed, and the
    rest of the batch continues; a later run promotes it.

    Migrated to F19: promotion runs as the runtime role (a superuser is refused by publish_batch),
    the citations are canonical, and "promoted" means published into Annex A. The interrupted record
    leaves no publication behind."""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))
    ids = run(_stage({
        f"k{i}": dict(id=uuid.UUID(f"00000000-0000-4000-8000-{i + 1:012d}"), source_id=src["t"],
                      source_site="f20-trusted", extracted_citation=f"2099 SCMR 95{i}", confidence_score=0.9)
        for i in range(4)
    }))
    started, done = threading.Event(), threading.Event()
    _interrupt_the_promotion_waiting_on(corpus_db, ids["k1"], terminate, started, done)
    assert started.wait(30)
    runtime_url = corpus_db.url_as(*corpus_db.runtime_role())

    async def promote_with(pool_kind):
        from scraper import database
        from scraper.tasks.promotion import promote_staging_records

        eng = database.build_engine(runtime_url) if pool_kind == "production_queuepool" else corpus_db.engine_for(runtime_url)
        saved = database.SessionLocal.kw.get("bind")
        database.SessionLocal.configure(bind=eng)
        try:
            return await promote_staging_records()
        finally:
            database.SessionLocal.configure(bind=saved)
            await eng.dispose()

    with caplog.at_level(logging.INFO):
        result = run(promote_with(pool))
    assert done.wait(30)

    staging, queue, master, _embed = run(_outcomes())
    by_id = {row[0]: row for row in staging}
    assert by_id[ids["k1"]][1:4] == (False, False, None), "a transient error must leave the record pending"
    assert queue == [], "a transient error writes no review-queue row"
    assert result == {"promoted": 3, "attached": 0, "quarantined": 0, "failed": 1}, result
    assert sorted(row[1] for row in run(_annex_a_promoted())) == ["2099 SCMR 950", "2099 SCMR 952", "2099 SCMR 953"]
    assert run(fetch("SELECT count(*) FROM corpus_publication WHERE batch_key = :k", k=f"staging/{ids['k1']}")) == [(0,)]
    assert master == []  # F19 ruling 10
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert f"promotion.record_failed staging_id={ids['k1']} " in messages and "transient=true" in messages, messages

    # The lock is gone now; the next run promotes the record.
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 1, "attached": 0, "quarantined": 0, "failed": 0}
    assert sorted(row[1] for row in run(_annex_a_promoted()))[1] == "2099 SCMR 951"


def test_i_a_publication_guard_refusal_is_never_treated_as_transient(corpus_db, caplog):
    """Merging round-2 L2 into F19: a refusal by the Annex A publication is the record's fault, not a
    transient error. A guard refusal that escapes the item (SQLSTATE class SK; here SKP13 from a
    stand-in trigger, the code the D3 guard uses) and a CHECK refusal (23514, IntegrityError) quarantine
    the record as promotion_error:<Class>: never left pending to be retried forever. (An item-level
    guard refusal, SKP03-SKP06, is recorded rejected and quarantined with its own reason:
    test_f19_guard_rejection_inside_promotion_rolls_back_only_that_item.)"""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    corpus_db.admin(
        """CREATE FUNCTION f19_test_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF NEW.case_title = 'F19 guard SKP13 2099' THEN
               RAISE EXCEPTION USING ERRCODE = 'SKP13', MESSAGE = 'parent_not_promoted', DETAIL = 'table judgment';
             END IF;
             IF NEW.case_title = 'F19 guard 23514 2099' THEN
               RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'f19 check refusal';
             END IF;
             RETURN NEW;
           END $$""",
        "CREATE TRIGGER f19_test_refusal BEFORE INSERT ON judgment FOR EACH ROW EXECUTE FUNCTION f19_test_refusal()",
    )
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))
    row = lambda n, citation, **kw: dict(id=uuid.UUID(f"00000000-0000-4000-8000-{n:012d}"), source_id=src["t"],  # noqa: E731
                                         source_site="f20-trusted", extracted_citation=citation, confidence_score=0.9, **kw)
    ids = run(_stage({
        "before": row(1, "2099 SCMR 960"),
        "skp13": row(2, "2099 SCMR 961", extracted_title="F19 guard SKP13 2099"),
        "check": row(3, "2099 SCMR 962", extracted_title="F19 guard 23514 2099"),
        "after": row(4, "2099 SCMR 963"),
    }))
    with caplog.at_level(logging.INFO):
        result = _promote_as_runtime_role(corpus_db)

    assert result == {"promoted": 2, "attached": 0, "quarantined": 0, "failed": 2}, result
    staging, queue, _master, _embed = run(_outcomes())
    by_id = {r[0]: r for r in staging}
    for key in ("skp13", "check"):
        promoted, quarantined, reason = by_id[ids[key]][1:4]
        assert (promoted, quarantined) == (False, True), (key, by_id[ids[key]])
        assert reason.startswith("promotion_error:"), (key, reason)
    assert by_id[ids["check"]][3] == "promotion_error:IntegrityError"
    assert sorted(q[1] for q in queue) == sorted([by_id[ids["skp13"]][3], "promotion_error:IntegrityError"])
    failed = [r.getMessage() for r in caplog.records if "promotion.record_failed" in r.getMessage()]
    assert len(failed) == 2 and all("transient=false" in m for m in failed), failed
    assert sorted(r[1] for r in run(_annex_a_promoted())) == ["2099 SCMR 960", "2099 SCMR 963"]
    # Nothing is left pending to be retried.
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 0, "attached": 0, "quarantined": 0, "failed": 0}


# ---------------------------------------------------------------------------------------------
# (j) re-audit round 2 (PR #48): L4 a current CHECK with a drifted default; INFO the probe schema
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("drift", ["SET DEFAULT 'trusted'", "DROP DEFAULT"], ids=["default_trusted", "default_dropped"])
def test_j_a_current_check_with_a_drifted_default_is_repaired(corpus_db, drift):
    """Round-2 L4: the CHECK is exactly current but the default drifted (fail-open 'trusted', or
    none). Migrate must not treat that as current: the default comes back as 'review', the CHECK
    keeps refusing legacy values, and the comparison probe leaves nothing behind."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    run(execute(f"ALTER TABLE scraper_sources ALTER COLUMN trust_level {drift}"))
    assert run(constraint_state())[1] == SPEC_TRUST_LEVELS, "the CHECK itself is still current"
    assert run(constraint_state())[3] != {"review"}

    second = corpus_db.migrate()
    assert_migrated(second, corpus_db)

    _oid, literals, valid, default = run(constraint_state())
    assert (literals, valid, default) == (SPEC_TRUST_LEVELS, True, {"review"})
    assert run(try_insert_source("f20-after-default-drift")) == ("stored", "review")
    assert "trust vocabulary already current" not in second.stderr + second.stdout
    assert run(fetch("SELECT count(*) FROM pg_class WHERE relname LIKE 'f20_trust_vocabulary_probe%'"))[0][0] == 0


def test_j_the_probe_is_built_next_to_scraper_sources_not_in_the_first_search_path_schema(corpus_db):
    """Round-2 INFO: the comparison probe is created in scraper_sources' own schema. With the default
    search_path ("$user", public), a schema named after the migration role comes first; F30 gives
    that role CREATE on public only, so an unqualified probe would make migrate fail there."""
    build_legacy_schema(corpus_db)
    mig, mig_pw = corpus_db.create_role("f20_mig")
    corpus_db.admin(
        f'REVOKE ALL ON DATABASE "{corpus_db.name}" FROM PUBLIC',
        f'GRANT CONNECT ON DATABASE "{corpus_db.name}" TO "{mig}"',
        "REVOKE ALL ON SCHEMA public FROM PUBLIC",
        f'GRANT USAGE, CREATE ON SCHEMA public TO "{mig}"',
        *[f'ALTER TABLE "{t}" OWNER TO "{mig}"' for t in (
            "courts", "scraper_sources", "case_law_master", "statutes_master", "scraper_staging",
            "statutes_staging", "scraper_jobs", "quarantine_queue", "embedding_queue",
            "harvest_operator_state")],
        # A "$user" schema the role can use but not create in.
        f'CREATE SCHEMA "{mig}"',
        f'GRANT USAGE ON SCHEMA "{mig}" TO "{mig}"',
    )
    assert_migrated(corpus_db.migrate(corpus_db.url_as(mig, mig_pw)), corpus_db)
    _oid, literals, valid, default = run(constraint_state())
    assert (literals, valid, default) == (SPEC_TRUST_LEVELS, True, {"review"})
    assert run(fetch("SELECT count(*) FROM pg_class WHERE relname LIKE 'f20_trust_vocabulary_probe%'"))[0][0] == 0


# ---------------------------------------------------------------------------------------------
# (k) re-audit round 2 (PR #48): L1 route kinds
# ---------------------------------------------------------------------------------------------
def test_k_a_route_without_a_valid_kind_is_refused_and_every_direct_route_needs_trusted(corpus_db, monkeypatch, caplog):
    """Round-2 L1(a): the dispatcher trusts only what a route declares. A route with no kind or an
    unknown kind is refused (fail closed, logged); any route declared `direct` runs only for a
    trusted source, whichever module it names."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    calls = install_harvester_spies(monkeypatch)
    from scraper.tasks import dispatcher

    routes = dict(dispatcher.ROUTES)
    routes["NasirLawSite"] = ("scraper.tasks.nasirlawsite", "scrape_nasirlawsite")  # no kind
    routes["SupremeCourt"] = ("scraper.tasks.supremecourt", "scrape_supremecourt", "stagin")  # unknown kind
    routes["PakistanLawSite"] = ("scraper.tasks.pakistanlawsite", "scrape_pakistanlawsite", None)
    routes["LahoreHighCourt"] = ("scraper.tasks.lahorehighcourt", "scrape_lahorehighcourt", "direct")  # review source
    routes["PeshawarHighCourt"] = ("scraper.tasks.peshawarhighcourt", "scrape_peshawarhighcourt", "direct")
    monkeypatch.setattr(dispatcher, "ROUTES", routes)
    run(execute("UPDATE scraper_sources SET trust_level = 'trusted' WHERE source_name IN ('PakistanLawSite', 'PeshawarHighCourt')"))

    with caplog.at_level(logging.INFO):
        for name in ("NasirLawSite", "SupremeCourt", "PakistanLawSite", "LahoreHighCourt"):
            run(dispatcher._run_async(name))
    assert calls == [], f"harvested through a route it should have refused: {calls}"
    refused = [r.getMessage() for r in caplog.records if "route declares no valid kind" in r.getMessage()]
    assert sorted(m.split()[0] for m in refused) == ["NasirLawSite", "PakistanLawSite", "SupremeCourt"], refused
    assert any(r.getMessage().startswith("LahoreHighCourt ") and "directly" in r.getMessage() for r in caplog.records)

    # Positive controls: a trusted `direct` route and an untouched `staging` route both run.
    run(dispatcher._run_async("PeshawarHighCourt"))
    run(dispatcher._run_async("SindhHighCourt"))
    assert calls == [("scrape_peshawarhighcourt", "PeshawarHighCourt"), ("scrape_shc", "SindhHighCourt")]


# ---------------------------------------------------------------------------------------------
# (l) round 4 (Codex P1 on PR #48): only record-specific failures are quarantined
# ---------------------------------------------------------------------------------------------
def _raise_on_citation_insert(codes):
    """SQL for a trigger that raises SQLSTATE codes[citation] when that citation's Annex A citation
    row is inserted (the message carries row data, which must never reach a log or a reason).
    Migrated to F19: promotion no longer writes case_law_master, so the fault sits on the row the
    publication writes for the record (the error escapes publish_batch's item, as any non-guard
    database error does)."""
    cases = " ".join(f"WHEN '{citation}' THEN '{code}'" for citation, code in codes.items())
    return (
        "CREATE FUNCTION f20_raise_on_insert() RETURNS trigger LANGUAGE plpgsql AS $$ "
        f"DECLARE code text := CASE NEW.citation_text {cases} END; BEGIN "
        "IF code IS NOT NULL THEN RAISE EXCEPTION 'synthetic row data %', NEW.citation_text USING ERRCODE = code; END IF; "
        "RETURN NEW; END $$",
        "CREATE TRIGGER f20_raise_on_insert BEFORE INSERT ON citation FOR EACH ROW EXECUTE FUNCTION f20_raise_on_insert()",
    )


_PAGE_BASE = {"SYS": 9700, "REC": 9800, "CB": 9900, "PUB": 9600}


def _cite(prefix, i):
    """The canonical 2099 citation of record i of a section (l) batch."""
    return f"2099 SCMR {_PAGE_BASE[prefix] + i}"


def _stage_in_order(src, n, prefix):
    """n trusted, promotable records whose ids sort in index order (promotion runs ORDER BY id)."""
    return run(_stage({
        f"k{i}": dict(id=uuid.UUID(f"00000000-0000-4000-8000-{i + 1:012d}"), source_id=src, source_site="f20-trusted",
                      extracted_citation=_cite(prefix, i), confidence_score=0.9)
        for i in range(n)
    }))


@pytest.mark.parametrize("code", ["42501", "42P01", "XX000", "P0001"],
                         ids=["insufficient_privilege", "undefined_table", "internal_error", "raise_exception"])
def test_l_a_systemic_or_unknown_database_error_leaves_the_record_pending(corpus_db, code, caplog):
    """Round 4: a failure that is not confirmed to be about the record (permission, schema drift,
    an internal error, a generic RAISE) is rolled back and left pending, not quarantined, so the
    backlog is not lost when the deployment or schema is at fault. It counts as failed, is logged
    with id, class and SQLSTATE and systemic=true, and is retried on the next run. (Migrated to F19:
    Annex A, the runtime role, the fault on the record's citation insert.)"""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))["t"]
    ids = _stage_in_order(src, 3, "SYS")
    run(execute(*_raise_on_citation_insert({_cite("SYS", 1): code})))

    with caplog.at_level(logging.INFO):
        result = _promote_as_runtime_role(corpus_db)

    assert result == {"promoted": 2, "attached": 0, "quarantined": 0, "failed": 1}, result
    staging, queue, master, _embed = run(_outcomes())
    by_id = {row[0]: row for row in staging}
    assert by_id[ids["k1"]][1:4] == (False, False, None), f"{code} must leave the record pending"
    assert queue == [], f"{code} must write no review-queue row"
    assert sorted(row[1] for row in run(_annex_a_promoted())) == [_cite("SYS", 0), _cite("SYS", 2)]
    assert master == []  # F19 ruling 10
    failed = [r for r in caplog.records if "promotion.record_failed" in r.getMessage()]
    assert len(failed) == 1 and failed[0].levelno == logging.ERROR, [r.getMessage() for r in failed]
    message = failed[0].getMessage()
    assert f"staging_id={ids['k1']} " in message and f"sqlstate={code} " in message, message
    assert "transient=false" in message and "systemic=true" in message, message
    assert "synthetic row data" not in message and "2099" not in message, "log carries row data"

    # The next run retries it (and fails again while the fault is there): still pending.
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 0, "attached": 0, "quarantined": 0, "failed": 1}
    assert {row[0]: row for row in run(_outcomes())[0]}[ids["k1"]][1:4] == (False, False, None)


@pytest.mark.parametrize("code,reason", [("22001", "promotion_error:DBAPIError"), ("23505", "promotion_error:IntegrityError")],
                         ids=["string_data_right_truncation", "unique_violation"])
def test_l_a_record_specific_database_error_is_quarantined_and_the_good_records_are_promoted(corpus_db, code, reason, caplog):
    """Round 4: SQLSTATE class 22 (data exception) and 23 (integrity constraint violation) are the
    confirmed record-specific failures. That record is quarantined promotion_error:<ExceptionClass>
    (class only) with a review-queue row; the good records around it are promoted. (Migrated to F19:
    Annex A, the runtime role, the fault on the record's citation insert.)"""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))["t"]
    ids = _stage_in_order(src, 3, "REC")
    run(execute(*_raise_on_citation_insert({_cite("REC", 1): code})))

    with caplog.at_level(logging.INFO):
        result = _promote_as_runtime_role(corpus_db)

    assert result == {"promoted": 2, "attached": 0, "quarantined": 0, "failed": 1}, result
    staging, queue, master, _embed = run(_outcomes())
    by_id = {row[0]: row for row in staging}
    assert by_id[ids["k1"]][1:4] == (False, True, reason)
    assert [(row[0], row[1]) for row in queue] == [(ids["k1"], reason)]
    assert sorted(row[1] for row in run(_annex_a_promoted())) == [_cite("REC", 0), _cite("REC", 2)]
    assert master == []  # F19 ruling 10
    message = " ".join(r.getMessage() for r in caplog.records if "promotion.record_failed" in r.getMessage())
    assert f"sqlstate={code} " in message and "systemic=false" in message, message
    assert "2099" not in message
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 0, "attached": 0, "quarantined": 0, "failed": 0}, \
        "a quarantined record is not retried"


@pytest.mark.parametrize("codes,expected,aborted", [
    (["42501"] * 5, {"promoted": 0, "attached": 0, "quarantined": 0, "failed": 3}, "systemic:42501"),
    (["42501", "XX000", "42501", "XX000", "42501"], {"promoted": 0, "attached": 0, "quarantined": 0, "failed": 5}, None),
    (["42501", "42501", None, "42501", "42501"], {"promoted": 1, "attached": 0, "quarantined": 0, "failed": 4}, None),
    (["42501", "42501", "23505", "42501", "42501"], {"promoted": 0, "attached": 0, "quarantined": 0, "failed": 5}, None),
], ids=["same_code_five_times", "alternating_codes", "a_success_resets", "a_record_specific_failure_resets"])
def test_l_the_breaker_stops_the_batch_after_three_consecutive_identical_systemic_failures(
        corpus_db, codes, expected, aborted, caplog):
    """Round 4: N=3 consecutive systemic/unknown failures with the same SQLSTATE (or exception
    class) stop the run early, so a broken schema does not churn the whole backlog; the records not
    attempted stay pending and the result carries the reason. Any other outcome in between resets
    the count. (Migrated to F19: Annex A, the runtime role, the fault on each record's citation
    insert.)"""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))["t"]
    ids = _stage_in_order(src, len(codes), "CB")
    run(execute(*_raise_on_citation_insert({_cite("CB", i): c for i, c in enumerate(codes) if c})))

    with caplog.at_level(logging.INFO):
        result = _promote_as_runtime_role(corpus_db)

    want = dict(expected, aborted=aborted) if aborted else expected
    assert result == want, result
    staging = {row[0]: row for row in run(_outcomes())[0]}
    for i, c in enumerate(codes):
        state = staging[ids[f"k{i}"]][1:4]
        if c is None:
            assert state[:2] == (True, False), (i, state)
        elif c == "23505":
            assert state == (False, True, "promotion_error:IntegrityError"), (i, state)
        else:
            assert state == (False, False, None), (i, state)
    attempted = [r for r in caplog.records if "promotion.record_failed" in r.getMessage()]
    assert len(attempted) == expected["failed"]
    aborted_logs = [r.getMessage() for r in caplog.records if "promotion.aborted" in r.getMessage()]
    if aborted:
        assert len(aborted_logs) == 1 and "42501" in aborted_logs[0] and "left_pending=2" in aborted_logs[0], aborted_logs
    else:
        assert aborted_logs == []
    from scraper.tasks import promotion

    assert getattr(promotion, "SYSTEMIC_FAILURE_LIMIT", None) == 3
