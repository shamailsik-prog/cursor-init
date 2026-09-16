from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import text
from scraper.config import settings
import logging
logger = logging.getLogger(__name__)

class Base(DeclarativeBase):
    pass

engine = create_async_engine(settings.DATABASE_URL, echo=False, pool_size=20, max_overflow=30)
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
        dict(source_name="NasirLawSite", source_url="https://www.nasirlawsite.com", scrape_case_law=True, scrape_statutes=True, trust_level="review", requires_login=False, scrape_frequency_hours=6),
        dict(source_name="PakistanCode", source_url="https://pakistancode.gov.pk", scrape_case_law=False, scrape_statutes=True, trust_level="trusted", requires_login=False, scrape_frequency_hours=48),
        dict(source_name="SindhHighCourt", source_url="https://www.shc.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="SupremeCourt", source_url="https://www.supremecourt.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="LahoreHighCourt", source_url="https://lhc.gov.pk", scrape_case_law=True, scrape_statutes=False, trust_level="review", requires_login=False, scrape_frequency_hours=12),
        dict(source_name="NationalAssembly", source_url="https://na.gov.pk/en/acts-tenure.php", scrape_case_law=False, scrape_statutes=True, trust_level="trusted", requires_login=False, scrape_frequency_hours=168),
    ]

    async with SessionLocal() as db:
        result = await db.execute(select(ScraperSource.source_name))
        existing_names = {name for (name,) in result.all()}
        inserted = 0

        for row in source_defaults:
            if row["source_name"] in existing_names:
                continue
            db.add(ScraperSource(**row))
            inserted += 1

        if inserted:
            await db.commit()
            logger.info("Inserted %d missing default source(s)", inserted)
