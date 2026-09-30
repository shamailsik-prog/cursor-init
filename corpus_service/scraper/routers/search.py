from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, or_
from scraper.database import get_db
from scraper.models import CaseLawMaster, StatutesMaster
from sqlalchemy.ext.asyncio import AsyncSession
# Intentionally unauthenticated: /search, /cases/{id} and /statutes serve the public legal
# corpus (published judgments and statutes). Operational/admin data (/export, /jobs,
# /api/vault, /api/live-feed, /admin/*) is behind require_admin_api_key.
router = APIRouter()
@router.get("/search")
async def search(q: str=Query(...), limit: int=10, db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(CaseLawMaster).where(or_(CaseLawMaster.citation.ilike(f"%{q}%"), CaseLawMaster.case_title.ilike(f"%{q}%"))).limit(limit))
    return r.scalars().all()
@router.get("/cases/{id}")
async def get_case(id: str, db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(CaseLawMaster).where(CaseLawMaster.id==id))
    return r.scalars().first()
@router.get("/statutes")
async def statutes(statute_name: str=None, limit: int=20, db: AsyncSession = Depends(get_db)):
    q = select(StatutesMaster).limit(limit)
    if statute_name:
        q = q.where(StatutesMaster.statute_name.ilike(f"%{statute_name}%"))
    r = await db.execute(q)
    return r.scalars().all()
