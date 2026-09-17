from fastapi import APIRouter, Depends
from sqlalchemy import select
from scraper.database import get_db
from scraper.models import ScraperJob
from sqlalchemy.ext.asyncio import AsyncSession
router = APIRouter(prefix="/jobs")
@router.get("")
async def list_jobs(limit: int=50, db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(ScraperJob).order_by(ScraperJob.created_at.desc()).limit(limit))
    return r.scalars().all()
