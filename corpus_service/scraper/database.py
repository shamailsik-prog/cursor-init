from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession, AsyncConnection
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import text
from scraper.config import asyncpg_engine_args, settings
from scraper.trust import DEFAULT_TRUST_LEVEL, TRUST_LEVELS, normalise_legacy_trust, trust_check_sql
import logging
import re
logger = logging.getLogger(__name__)

class Base(DeclarativeBase):
    pass

def build_engine(url: str):
    """Async engine for a DATABASE_URL. TLS parameters (sslmode/ssl, sslrootcert) become an explicit
    asyncpg `ssl` argument; with sslmode=verify-full that is an SSLContext requiring a certificate
    that chains to sslrootcert and names the host (audit F30)."""
    clean_url, connect_args = asyncpg_engine_args(url)
    return create_async_engine(clean_url, echo=False, pool_size=20, max_overflow=30, connect_args=connect_args)

engine = build_engine(settings.DATABASE_URL)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

async def get_db():
    async with SessionLocal() as session:
        yield session

async def create_schema():
    """Extensions and tables. With everything already present (the runtime role's case after
    migrate, audit F30) the extension statements are no-ops and create_all is a catalog check."""
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\""))
    # create tables
    from scraper import models  # noqa
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("DB initialized with pgvector and pg_trgm")


async def init_db():
    """API startup (runtime role, DML only - audit F30): schema check, then seed. It never runs
    the trust vocabulary upgrade, which is DDL; only `python -m scraper.migrate` does that."""
    await create_schema()
    await seed_data()


TRUST_CHECK_NAME = "ck_trust_level_values"
_SQL_LITERAL = re.compile(r"'((?:[^']|'')*)'")


def _sql_literals(expr):
    return {m.replace("''", "'") for m in _SQL_LITERAL.findall(expr or "")}


async def _trust_vocabulary_is_current(conn: AsyncConnection) -> bool:
    """True when scraper_sources already carries the validated F20 CHECK and the review default."""
    check = (await conn.execute(text(
        "SELECT pg_get_constraintdef(c.oid), c.convalidated FROM pg_constraint c "
        "WHERE c.conrelid = 'scraper_sources'::regclass AND c.conname = :name AND c.contype = 'c'"
    ), {"name": TRUST_CHECK_NAME})).first()
    default = (await conn.execute(text(
        "SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a "
        "ON a.attrelid = d.adrelid AND a.attnum = d.adnum "
        "WHERE d.adrelid = 'scraper_sources'::regclass AND a.attname = 'trust_level'"
    ))).scalar()
    return (
        check is not None
        and check[1] is True
        and "trust_level" in check[0]
        and _sql_literals(check[0]) == set(TRUST_LEVELS)
        and _sql_literals(default) == {DEFAULT_TRUST_LEVEL}
    )


async def upgrade_trust_vocabulary(conn: AsyncConnection) -> None:
    """Bring scraper_sources onto the F20 vocabulary (trusted | review | blocked, default review).

    Idempotent: a database that is already current is left untouched (no DDL, no UPDATE). Otherwise,
    in the caller's transaction: drop the old CHECK, map every stored value outside the vocabulary
    (the legacy semi_trusted / untrusted / quarantined, or anything else) to review via
    scraper.trust.normalise_legacy_trust, add the new CHECK and set the default. The old CHECK
    refuses 'review', so it goes first, and this must run before seed_data() on an old database.

    DDL: run only by `python -m scraper.migrate` as the schema owner (MIGRATE_DB_USER). The API's
    runtime role cannot, and init_db() does not call this (audit F30)."""
    if await _trust_vocabulary_is_current(conn):
        logger.info("trust vocabulary already current; nothing to upgrade")
        return
    await conn.execute(text(f"ALTER TABLE scraper_sources DROP CONSTRAINT IF EXISTS {TRUST_CHECK_NAME}"))
    rows = (await conn.execute(text("SELECT id, source_name, trust_level FROM scraper_sources FOR UPDATE"))).all()
    mapped = []
    for source_id, source_name, stored in rows:
        level = normalise_legacy_trust(stored)
        if level != stored:
            await conn.execute(
                text("UPDATE scraper_sources SET trust_level = :level WHERE id = :id"),
                {"level": level, "id": source_id},
            )
            mapped.append(f"{source_name}: {stored!r} -> {level}")
    await conn.execute(text(f"ALTER TABLE scraper_sources ADD CONSTRAINT {TRUST_CHECK_NAME} CHECK ({trust_check_sql()})"))
    await conn.execute(text(f"ALTER TABLE scraper_sources ALTER COLUMN trust_level SET DEFAULT '{DEFAULT_TRUST_LEVEL}'"))
    logger.info(
        "trust vocabulary upgraded to %s (default %s); %d source(s) remapped%s",
        "|".join(TRUST_LEVELS), DEFAULT_TRUST_LEVEL, len(mapped), (": " + "; ".join(mapped)) if mapped else "",
    )

async def seed_data():
    from scraper.models import ScraperSource
    from sqlalchemy import select

    # FINAL_2: requires_login is ALWAYS FALSE. PakistanLawSite is
    # licensed_api / import_folder only — never login scraping.
    # Trust (F20, FINAL_2 :252-253): trusted | review | blocked. Only the licensed/import feed and the
    # official statute portals are trusted; every other source is review (quarantined at promotion).
    source_defaults = [
        dict(source_name="PakistanLawSite", source_url="https://www.pakistanlawsite.com", scrape_case_law=True, scrape_statutes=True, trust_level="trusted", requires_login=False, scrape_frequency_hours=6),
        dict(source_name="NasirLawSite", source_url="https://www.nasirlawsite.com", scrape_case_law=True, scrape_statutes=True, trust_level="review", requires_login=False, scrape_frequency_hours=6),
        dict(source_name="PakistanCode", source_url="https://pakistancode.gov.pk", scrape_case_law=False, scrape_statutes=True, trust_level="trusted", requires_login=False, scrape_frequency_hours=48),
        dict(source_name="SindhHighCourt", source_url="https://sindhhighcourt.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="SindhHighCourtPublic", source_url="https://sindhhighcourt.gov.pk/Imp_Judgement_Orders.php", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="SupremeCourt", source_url="https://www.supremecourt.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="SupremeCourtPublic", source_url="https://www.supremecourt.gov.pk/latest-judgements/", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="LahoreHighCourt", source_url="https://lhc.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="PeshawarHighCourt", source_url="https://peshawarhighcourt.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="PeshawarHighCourtPublic", source_url="https://peshawarhighcourt.gov.pk/app/site/", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="BalochistanHighCourt", source_url="https://bhc.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="BalochistanHighCourtPublic", source_url="https://bhc.gov.pk/resources/judgments", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="IslamabadHighCourt", source_url="https://ihc.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="IslamabadHighCourtPublic", source_url="https://mis.ihc.gov.pk/frmJgmnt.aspx?jgs=1", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="NationalAssembly", source_url="https://na.gov.pk/en/acts-tenure.php", scrape_case_law=False, scrape_statutes=True, trust_level="trusted", requires_login=False, scrape_frequency_hours=168),
    ]

    async with SessionLocal() as db:
        result = await db.execute(select(ScraperSource))
        existing_sources = {source.source_name: source for source in result.scalars().all()}
        inserted = 0
        updated = 0

        for row in source_defaults:
            existing = existing_sources.get(row["source_name"])
            if not existing:
                db.add(ScraperSource(**row))
                inserted += 1
                continue

            # Keep existing trust/review posture, but repair stale legacy SHC URLs.
            if existing.source_name == "SindhHighCourt" and "shc.gov.pk" in (existing.source_url or ""):
                existing.source_url = "https://sindhhighcourt.gov.pk"
                updated += 1
            if existing.source_name in {"SupremeCourt", "SupremeCourtPublic"}:
                current_url = (existing.source_url or "").lower()
                if "supremecourt.gov.pk/judgements" in current_url:
                    existing.source_url = "https://www.supremecourt.gov.pk/latest-judgements/"
                    updated += 1
            if existing.source_name in {"PeshawarHighCourt", "PeshawarHighCourtPublic"}:
                current_url = (existing.source_url or "").lower()
                if "phcjudgments" in current_url:
                    if existing.source_name == "PeshawarHighCourt":
                        existing.source_url = "https://peshawarhighcourt.gov.pk"
                    else:
                        existing.source_url = "https://peshawarhighcourt.gov.pk/app/site/"
                    updated += 1
            if existing.source_name in {"BalochistanHighCourt", "BalochistanHighCourtPublic"}:
                current_url = (existing.source_url or "").lower()
                if "portal.bhc.gov.pk/judgments" in current_url or "bhc.gov.pk/judgments" in current_url:
                    if existing.source_name == "BalochistanHighCourt":
                        existing.source_url = "https://bhc.gov.pk"
                    else:
                        existing.source_url = "https://bhc.gov.pk/resources/judgments"
                    updated += 1
            if existing.source_name in {"IslamabadHighCourt", "IslamabadHighCourtPublic"}:
                current_url = (existing.source_url or "").lower()
                if (
                    "islamabadhighcourt.gov.pk" in current_url
                    or ("ihc.gov.pk" in current_url and "mis.ihc.gov.pk" not in current_url and existing.source_name == "IslamabadHighCourtPublic")
                    or ("mis.ihc.gov.pk" in current_url and existing.source_name == "IslamabadHighCourt")
                ):
                    if existing.source_name == "IslamabadHighCourt":
                        existing.source_url = "https://ihc.gov.pk"
                    else:
                        existing.source_url = "https://mis.ihc.gov.pk/frmJgmnt.aspx?jgs=1"
                    updated += 1

        if inserted or updated:
            await db.commit()
            logger.info(
                "Seeded source defaults (inserted=%d, updated=%d)",
                inserted,
                updated,
            )
