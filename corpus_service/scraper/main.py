from fastapi import Depends, FastAPI
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import logging
import pathlib
from scraper.auth import require_admin_api_key
from scraper.routers import sources, jobs, quarantine, search, export
from scraper.database import init_db
from scraper.config import settings

logger = logging.getLogger(__name__)
app = FastAPI(title="Blackletter Legal Scraper")
# Restrict CORS: wildcard origins are unsafe next to admin write routes.
_cors_origins = [o.strip() for o in getattr(settings, "CORS_ALLOW_ORIGINS", "").split(",") if o.strip()]
if not _cors_origins:
    _cors_origins = ["http://localhost:8000", "http://127.0.0.1:8000"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
app.include_router(sources.router)
app.include_router(jobs.router)
app.include_router(quarantine.router)
app.include_router(search.router)
app.include_router(export.router)
@app.on_event("startup")
async def startup():
    await init_db()
@app.get("/health")
async def health():
    import pathlib, json
    from scraper.database import SessionLocal
    from sqlalchemy import select, func
    from scraper.models import CaseLawMaster
    STATE_DIR = pathlib.Path("/app/state" if pathlib.Path("/app/state").exists() else "./blackletter_state")
    LIVE_DIR = pathlib.Path("/app/live" if pathlib.Path("/app/live").exists() else "./live")
    total_pdfs = sum(1 for p in LIVE_DIR.rglob("*.pdf") if p.stat().st_size>15000) if LIVE_DIR.exists() else 0
    seen=0
    sf=STATE_DIR/"harvest-seen.json"
    if sf.exists():
        try: seen=len(json.loads(sf.read_text()).get("seen",[]))
        except: pass
    try:
        async with SessionLocal() as db:
            c=await db.execute(select(func.count(CaseLawMaster.id)))
            return {"status":"ok","db_connected":True,"total_cases":c.scalar(),"total_pdfs":total_pdfs,"seen":seen}
    except Exception:
        # Never echo the exception: driver errors can embed the DATABASE_URL (credentials, host).
        logger.warning("health: database probe failed", exc_info=True)
        return {"status":"degraded","db_connected":False,"total_pdfs":total_pdfs,"seen":seen}
@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard():
    p=pathlib.Path(__file__).parent/"templates"/"dashboard.html"
    return p.read_text() if p.exists() else "<h1>Dashboard missing</h1>"
@app.get("/api/live-feed")
async def live_feed(_: None = Depends(require_admin_api_key)):
    import pathlib
    STATE_DIR = pathlib.Path("/app/state" if pathlib.Path("/app/state").exists() else "./blackletter_state")
    logs=[]
    for seat in ["a","b"]:
        lp=STATE_DIR/f"harvest-{seat}.log"
        if lp.exists():
            logs.extend(lp.read_text().splitlines()[-20:])
    return {"feed": logs[-40:]}
@app.post("/api/start")
async def start_h(_: None = Depends(require_admin_api_key)):
    import pathlib
    STATE_DIR = pathlib.Path("/app/state" if pathlib.Path("/app/state").exists() else "./blackletter_state")
    sf=STATE_DIR/"harvest.stopped"
    if sf.exists(): sf.unlink()
    return {"status":"started"}
@app.post("/api/stop")
async def stop_h(_: None = Depends(require_admin_api_key)):
    import pathlib
    STATE_DIR = pathlib.Path("/app/state" if pathlib.Path("/app/state").exists() else "./blackletter_state")
    (STATE_DIR/"harvest.stopped").write_text("stopped")
    return {"status":"stopped"}
@app.get("/api/vault")
async def vault(_: None = Depends(require_admin_api_key)):
    import pathlib
    LIVE_DIR = pathlib.Path("/app/live" if pathlib.Path("/app/live").exists() else "./live")
    files=[]
    if LIVE_DIR.exists():
        for pdf in sorted(LIVE_DIR.rglob("*.pdf"), key=lambda x: x.stat().st_mtime, reverse=True)[:100]:
            if pdf.stat().st_size<15000: continue
            files.append({"path": str(pdf.relative_to(LIVE_DIR)), "size": pdf.stat().st_size, "mtime": pdf.stat().st_mtime})
    return {"files": files}
