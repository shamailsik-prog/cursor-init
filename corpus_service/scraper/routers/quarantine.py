from fastapi import APIRouter, Depends
from sqlalchemy import select
from scraper.database import get_db
from scraper.models import QuarantineQueue, ScraperStaging, CaseLawMaster
from sqlalchemy.ext.asyncio import AsyncSession
router = APIRouter(prefix="/quarantine")
@router.get("")
async def list_q(limit: int=50, db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(QuarantineQueue).order_by(QuarantineQueue.created_at.desc()).limit(limit))
    return r.scalars().all()
@router.post("/{id}/promote")
async def promote(id: str, db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(QuarantineQueue).where(QuarantineQueue.id==id))
    qq = r.scalars().first()
    if not qq: return {"error":"not found"}
    st_r = await db.execute(select(ScraperStaging).where(ScraperStaging.id==qq.staging_id))
    st = st_r.scalars().first()
    if st:
        m = CaseLawMaster(citation=qq.extracted_citation, case_title=qq.extracted_title, source_site=qq.source_site, source_url=qq.source_url, full_text=st.raw_text, is_promoted=True)
        db.add(m)
        qq.reviewed=True
        await db.commit()
    return {"message":"promoted"}
