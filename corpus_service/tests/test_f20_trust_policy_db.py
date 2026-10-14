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
    assert result == {"promoted": 4, "quarantined": 6, "failed": 0}

    # A second pass has nothing left to decide and writes nothing new.
    annex_a = run(_annex_a_snapshot())
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 0, "quarantined": 0, "failed": 0}
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
    assert result == {"promoted": 2, "quarantined": 2, "failed": 1}

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
    assert result == {"promoted": 1, "quarantined": 5, "failed": 0}


def test_h_trust_is_decided_before_the_duplicate_check(corpus_db):
    """LOW-4: a record that may not be promoted is quarantined with its trust reason whether or not
    its citation is already published, and nothing is published for it; a promotable duplicate is
    decided (never left pending forever).

    Migrated to F19 (the case_law_master duplicate query is gone): the duplicate decision is the
    audited publication's, against Annex A. An identical re-stage is unchanged and a changed trusted
    re-stage is updated - both promoted onto the one existing judgment - and a bench-less re-stage
    is refused as promoted_row_protected (D9). Two promotable rows with one new citation in one run
    yield exactly one judgment and one citation row. Explicit ids fix the processing order."""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted"), "b": ("f20-blocked", "blocked"), "r": ("f20-review", "review")}))
    original = dict(source_id=src["t"], source_site="f20-trusted", extracted_citation="2099 SCMR 901", confidence_score=0.9,
                    source_url="https://f20.example.invalid/judgment/original", extracted_title="F20 Fixture original v. Test")
    run(_stage({"original": original}))
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 1, "quarantined": 0, "failed": 0}
    judgment_d1 = run(_annex_a_promoted())[0][0]

    uid = lambda n: uuid.UUID(f"00000000-0000-4000-8000-{n:012d}")  # noqa: E731
    ids = run(_stage({
        "blocked_dup": dict(id=uid(1), source_id=src["b"], source_site="f20-blocked", extracted_citation="2099 SCMR 901", confidence_score=0.9),
        "review_dup": dict(id=uid(2), source_id=src["r"], source_site="f20-review", extracted_citation="2099 SCMR 901", confidence_score=0.9),
        "low_conf_dup": dict(id=uid(3), source_id=src["t"], source_site="f20-trusted", extracted_citation="2099 SCMR 901", confidence_score=0.3),
        "trusted_dup_identical": dict(original, id=uid(4)),
        "trusted_dup_changed": dict(id=uid(5), source_id=src["t"], source_site="f20-trusted", extracted_citation="2099 SCMR 901", confidence_score=0.9),
        "trusted_dup_no_bench": dict(original, id=uid(6), extracted_bench_type=None),
        # Two promotable rows with the same new citation in one batch: one judgment is published.
        "pair_1": dict(id=uid(10), source_id=src["t"], source_site="f20-trusted", extracted_citation="2099 SCMR 902", confidence_score=0.9),
        "pair_2": dict(id=uid(11), source_id=src["t"], source_site="f20-trusted", extracted_citation="2099 SCMR 902", confidence_score=0.9),
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
    assert (decisions[key("pair_1")], decisions[key("pair_2")]) == ("promoted", "updated")

    published = run(_annex_a_promoted())
    assert sorted(row[1] for row in published) == ["2099 SCMR 901", "2099 SCMR 902"]
    assert run(fetch("SELECT count(*) FROM judgment")) == [(2,)] and run(fetch("SELECT count(*) FROM citation")) == [(2,)]
    staging = {row[0]: row for row in run(_outcomes())[0]}
    assert {staging[ids[k]][4] for k in ("trusted_dup_identical", "trusted_dup_changed")} == {judgment_d1}
    judgment_d2 = next(row[0] for row in published if row[1] == "2099 SCMR 902")
    assert {staging[ids[k]][4] for k in ("pair_1", "pair_2")} == {judgment_d2}
    assert run(_outcomes())[2] == []  # F19 ruling 10: no case_law_master row
    assert result == {"promoted": 4, "quarantined": 4, "failed": 0}


def test_h_a_record_that_raises_is_quarantined_durably_and_the_batch_continues(corpus_db, monkeypatch, caplog):
    """LOW-3: a non-database exception mid-batch. The record's work is rolled back, it is
    quarantined as promotion_error:<ExceptionClass> so it is not retried forever, and the rest of
    the batch is promoted. Reason and log carry the class name only. Since F19 the rest of the batch
    is published into Annex A, as the runtime role."""
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

    assert result == {"promoted": 4, "quarantined": 0, "failed": 1}
    staging, queue, master, _embed = run(_outcomes())
    by_id = {row[0]: row for row in staging}
    assert by_id[ids["k2"]][1:4] == (False, True, "promotion_error:RuntimeError")
    assert [(row[0], row[1]) for row in queue] == [(ids["k2"], "promotion_error:RuntimeError")]
    published = run(_annex_a_promoted())
    assert sorted(row[1] for row in published) == ["2099 SCMR 70", "2099 SCMR 71", "2099 SCMR 73", "2099 SCMR 74"]
    assert master == []  # F19 ruling 10
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert f"promotion.record_failed staging_id={ids['k2']} error=RuntimeError" in messages
    assert "2099 SCMR 72" not in messages, "log carries row data"

    # A second run leaves the quarantined record alone.
    assert _promote_as_runtime_role(corpus_db) == {"promoted": 0, "quarantined": 0, "failed": 0}


def test_h_if_the_error_quarantine_also_fails_the_batch_still_continues(corpus_db, monkeypatch, caplog):
    """LOW-3: if even the promotion_error quarantine write fails, that is logged (class only) and the
    batch continues; the record stays pending. (Since F19 the others publish into Annex A, as the
    runtime role.)"""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))
    ids = run(_stage({
        f"k{i}": dict(source_id=src["t"], source_site="f20-trusted", extracted_citation=f"2099 SCMR 8{i}",
                      confidence_score=0.61 if i == 1 else 0.9)
        for i in range(3)
    }))
    import scraper.tasks.promotion as promo

    real_decision, real_queue = promo.publication_decision, promo.QuarantineQueue

    def boom(trust, confidence):
        if confidence == 0.61:
            raise RuntimeError("first failure")
        return real_decision(trust, confidence)

    def queue_that_refuses_error_rows(**fields):
        if str(fields.get("reason", "")).startswith("promotion_error:"):
            raise LookupError("second failure")
        return real_queue(**fields)

    monkeypatch.setattr(promo, "publication_decision", boom)
    monkeypatch.setattr(promo, "QuarantineQueue", queue_that_refuses_error_rows)
    with caplog.at_level(logging.INFO):
        result = _promote_as_runtime_role(corpus_db)

    assert result == {"promoted": 2, "quarantined": 0, "failed": 1}
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
    """LOW-1 (re-audit attack, adapted to LOW-4): four promotion runs at once over 160 rows. Every
    citation is staged twice by a trusted source, so a race could publish both copies.

    Migrated to F19: "double promote" now means two Annex A judgments or citation rows for one
    citation, or a copy that fails instead of being decided. Each pair is staged under two spellings
    of one authority ("PLD 2099 Karachi n" / "PLD 2099 Sindh n"), so it is also the per-citation lock
    keyed by the canonical citation that serialises them. Both copies are decided through the audited
    publication onto the one judgment (promoted, then updated), so 120 are promoted, not 60, and
    duplicate_citation is no longer a reason."""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted"), "r": ("f20-review", "review")}))
    rows = {}
    for i in range(120):
        spelling = "Karachi" if i % 2 == 0 else "Sindh"
        rows[f"t{i}"] = dict(source_id=src["t"], source_site="f20-trusted",
                             extracted_citation=f"PLD 2099 {spelling} {300 + i // 2}", confidence_score=0.9)
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
    queued = [q[0] for q in queue]
    assert len(queued) == len(set(queued)) == 40, "a staging row was quarantined twice"
    assert sorted(q[1] for q in queue) == ["review_source"] * 40, "a copy failed or was refused"
    citations = [row[0] for row in run(fetch("SELECT citation_text FROM citation WHERE review_status = 'promoted'"))]
    assert len(citations) == len(set(citations)) == 60, (len(citations), len(set(citations)))
    assert set(citations) == {f"PLD 2099 Sindh {300 + k}" for k in range(60)}
    assert run(fetch("SELECT count(*), count(*) FILTER (WHERE review_status = 'promoted') FROM judgment")) == [(60, 60)]
    by_id = {row[0]: row for row in staging}
    for k in range(60):
        pair = {by_id[ids[f"t{2 * k}"]][4], by_id[ids[f"t{2 * k + 1}"]][4]}
        assert len(pair) == 1 and None not in pair, f"the two spellings of pair {k} point at different judgments"
    decisions = sorted(run(fetch(
        "SELECT i.decision, count(*) FROM corpus_publication_item i WHERE i.entity_type = 'judgment' GROUP BY 1"
    )))
    assert decisions == [("promoted", 60), ("updated", 60)], decisions
    assert run(fetch("SELECT count(*) FROM corpus_publication WHERE finished_at IS NOT NULL")) == [(120,)]
    assert master == [] and embed == []  # F19 ruling 10
    total = {k: sum(r[k] for r in results) for k in ("promoted", "quarantined", "failed")}
    assert total == {"promoted": 120, "quarantined": 40, "failed": 0}, (total, results)


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
    assert out["r"] == {"promoted": 0, "quarantined": 0, "failed": 0}, out
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
    """LOW-1/LOW-4: two runs on *different* staging rows with the same citation, interleaved so the
    second run reaches the citation while the first has published but not yet committed it. The
    second run must wait for the first, then decide against the first's committed result - not
    publish a second copy (refused at commit as a promotion_error).

    Migrated to F19: the hook point is the Annex A publication (case_law_master and the embedding
    queue are gone), and the two rows spell the citation differently ("PLD 2099 Karachi 98" and
    "PLD 2099 Sindh 98"), so the per-citation lock must be keyed by the canonical citation for B to
    wait before its own publication. After A commits, B's publication finds A's judgment and records
    'updated' with A's hash as the previous one: one judgment, one citation row, both rows promoted
    onto it. (duplicate_citation is no longer a reason: the publication decides duplicates.)"""
    corpus_db.apply_annex_a()
    assert_migrated(corpus_db.migrate(), corpus_db)
    src = run(_make_sources({"t": ("f20-trusted", "trusted")}))
    first_id = uuid.UUID("ffffffff-ffff-4fff-bfff-ffffffffffff")
    second_id = uuid.UUID("00000000-0000-4000-8000-000000000001")  # sorts first for run B
    run(_stage({"first": dict(id=first_id, source_id=src["t"], source_site="f20-trusted",
                              extracted_citation="PLD 2099 Karachi 98", confidence_score=0.9)}))

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
                                   extracted_citation="PLD 2099 Sindh 98", confidence_score=0.9)}))
        run_b = threading.Thread(target=lambda: out.setdefault("B", _promote()), name="run-B")
        run_b.start()
        run_a.join(60)
        run_b.join(60)

    assert observed == {"b_published_while_a_open": False}, "run B did not wait for run A's citation lock"
    assert out["A"] == {"promoted": 1, "quarantined": 0, "failed": 0}, out
    assert out["B"] == {"promoted": 1, "quarantined": 0, "failed": 0}, out
    staging = {row[0]: row for row in run(_outcomes())[0]}
    assert staging[first_id][1:3] == (True, False) and staging[second_id][1:3] == (True, False)
    assert staging[first_id][4] == staging[second_id][4] is not None
    assert [row[1] for row in run(_annex_a_promoted())] == ["PLD 2099 Sindh 98"]
    assert run(fetch("SELECT count(*) FROM judgment")) == [(1,)]
    audit = run(fetch(
        "SELECT p.batch_key, p.seq, i.decision, i.content_sha256, i.prev_sha256 FROM corpus_publication p "
        "JOIN corpus_publication_item i ON i.publication_id = p.id WHERE i.entity_type = 'judgment' ORDER BY p.seq"
    ))
    assert [(row[0], row[2]) for row in audit] == [(f"staging/{first_id}", "promoted"), (f"staging/{second_id}", "updated")]
    assert audit[1][4] == audit[0][3], "B decided against A's committed publication"
    assert run(_outcomes())[2] == []  # F19 ruling 10
