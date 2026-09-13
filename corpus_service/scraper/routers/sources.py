from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from scraper.database import get_db
from scraper.models import ScraperSource
from scraper.config import settings
from sqlalchemy.ext.asyncio import AsyncSession
router = APIRouter(prefix="/admin/sources")
def check_key(x_api_key: str = Header(...)):
    if x_api_key != settings.ADMIN_API_KEY:
        raise HTTPException(401, "Invalid key")
@router.get("")
async def list_sources(db: AsyncSession = Depends(get_db), x_api_key: str = Header(...)):
    check_key(x_api_key)
    r = await db.execute(select(ScraperSource))
    out=[]
    for s in r.scalars().all():
        out.append({"source_name": s.source_name, "source_url": s.source_url, "is_active": s.is_active, "scrape_case_law": s.scrape_case_law, "scrape_statutes": s.scrape_statutes, "trust_level": s.trust_level, "active_slot": s.active_credential_slot, "credential_slot_1": "CONFIGURED" if s.credential_slot_1_username else "NOT SET", "credential_slot_2": "CONFIGURED" if s.credential_slot_2_username else "NOT SET"})
    return out
@router.get("/{name}/status")
async def status(name: str, db: AsyncSession = Depends(get_db), x_api_key: str = Header(...)):
    check_key(x_api_key)
    r = await db.execute(select(ScraperSource).where(ScraperSource.source_name==name))
    s = r.scalars().first()
    if not s: raise HTTPException(404, "not found")
    return {"source_name": s.source_name, "is_active": s.is_active, "active_slot": s.active_credential_slot, "last_scraped": s.last_scraped_at}
@router.post("/{name}/trigger")
async def trigger(name: str, x_api_key: str = Header(...)):
    check_key(x_api_key)
    from scraper.tasks.dispatcher import run_source_job
    run_source_job.delay(name)
    return {"message": f"triggered {name}"}
