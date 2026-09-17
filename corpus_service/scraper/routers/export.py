from fastapi import APIRouter
from fastapi.responses import StreamingResponse
import csv, io, json
from scraper.database import SessionLocal
from sqlalchemy import select
from scraper.models import CaseLawMaster, StatutesMaster
router = APIRouter(prefix="/export")
@router.get("/cases")
async def export_cases(format: str="csv"):
    async with SessionLocal() as db:
        r = await db.execute(select(CaseLawMaster))
        cases = r.scalars().all()
        if format=="jsonl":
            def gen():
                for c in cases:
                    yield json.dumps({"citation": c.citation, "title": c.case_title})+"\n"
            return StreamingResponse(gen(), media_type="application/jsonl")
        out=io.StringIO()
        w=csv.writer(out)
        w.writerow(["citation","title","court","year"])
        for c in cases:
            w.writerow([c.citation, c.case_title, c.court, c.year])
        out.seek(0)
        return StreamingResponse(iter([out.getvalue()]), media_type="text/csv")
