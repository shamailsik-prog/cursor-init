from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import text
from scraper.config import asyncpg_engine_args, settings
import logging
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

async def init_db():
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\""))
    # create tables
    from scraper import models  # noqa
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("DB initialized with pgvector and pg_trgm")
    await seed_data()

async def seed_data():
    from scraper.models import ScraperSource
    from sqlalchemy import select

    # FINAL_2: requires_login is ALWAYS FALSE. PakistanLawSite is
    # licensed_api / import_folder only — never login scraping.
    source_defaults = [
        dict(source_name="PakistanLawSite", source_url="https://www.pakistanlawsite.com", scrape_case_law=True, scrape_statutes=True, trust_level="trusted", requires_login=False, scrape_frequency_hours=6),
        dict(source_name="NasirLawSite", source_url="https://www.nasirlawsite.com", scrape_case_law=True, scrape_statutes=True, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=6),
        dict(source_name="PakistanCode", source_url="https://pakistancode.gov.pk", scrape_case_law=False, scrape_statutes=True, trust_level="trusted", requires_login=False, scrape_frequency_hours=48),
        dict(source_name="SindhHighCourt", source_url="https://sindhhighcourt.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="SindhHighCourtPublic", source_url="https://sindhhighcourt.gov.pk/Imp_Judgement_Orders.php", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="SupremeCourt", source_url="https://www.supremecourt.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="SupremeCourtPublic", source_url="https://www.supremecourt.gov.pk/latest-judgements/", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="LahoreHighCourt", source_url="https://lhc.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="PeshawarHighCourt", source_url="https://peshawarhighcourt.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="PeshawarHighCourtPublic", source_url="https://peshawarhighcourt.gov.pk/app/site/", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="BalochistanHighCourt", source_url="https://bhc.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="BalochistanHighCourtPublic", source_url="https://bhc.gov.pk/resources/judgments", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="IslamabadHighCourt", source_url="https://ihc.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="IslamabadHighCourtPublic", source_url="https://mis.ihc.gov.pk/frmJgmnt.aspx?jgs=1", scrape_case_law=True, scrape_statutes=False, trust_level="semi_trusted", requires_login=False, scrape_frequency_hours=12),
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
