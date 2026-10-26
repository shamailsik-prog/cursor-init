from fastapi import Depends, FastAPI
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import logging
import os
import pathlib
from scraper.auth import require_admin_api_key
from scraper.routers import sources, jobs, quarantine, search, export
from scraper.database import init_db
from scraper.config import settings
from scraper import client_identity
from scraper.parsers import raw_store
from scraper.rate_limit import RateLimitedPathsMiddleware
from scraper import harvest_control

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
# Audit F24 re-audit: the anonymous pages outside the public router share its per-client quota
# (/health is F44's route and is not listed).
app.add_middleware(RateLimitedPathsMiddleware, paths=[app.openapi_url, app.docs_url, app.redoc_url,
                                                      app.swagger_ui_oauth2_redirect_url, "/dashboard"])
@app.on_event("startup")
async def startup():
    client_identity.log_forwarded_trust_at_startup()
    await init_db()
def _live_dir() -> pathlib.Path:
    """The PDF vault /health and /api/vault read (bootstrap_harvest.py's live/)."""
    return pathlib.Path("/app/live" if pathlib.Path("/app/live").exists() else "./live")
def _vault_pdfs(live_dir: pathlib.Path):
    """(path, stat) of every *.pdf under ``live_dir``, never inside the raw PDF store (audit F26-FU,
    spec R19): since F26 that store lives under the same vault, and these routes counted and listed
    the bootstrap files before it. Directory links are not followed."""
    if not live_dir.exists():
        return
    for top, dirs, files in os.walk(live_dir):
        dirs[:] = [d for d in dirs if d != raw_store.STORE_DIR]
        for name in files:
            if name.endswith(".pdf"):
                path = pathlib.Path(top) / name
                try:
                    st = path.stat()
                except OSError:  # removed or a dangling link: not a PDF in the vault
                    continue
                yield path, st
@app.get("/health")
async def health():
    import pathlib, json
    from scraper.database import SessionLocal
    from sqlalchemy import select, func
    from scraper.models import CaseLawMaster
    STATE_DIR = pathlib.Path("/app/state" if pathlib.Path("/app/state").exists() else "./blackletter_state")
    total_pdfs = sum(1 for _, st in _vault_pdfs(_live_dir()) if st.st_size>15000)
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
    # Static shell only; the page prompts for the admin key and sends it as X-API-Key.
    p=pathlib.Path(__file__).parent/"templates"/"dashboard.html"
    html = p.read_text() if p.exists() else "<h1>Dashboard missing</h1>"
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})
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
    harvest_control.resume()
    return {"status": "started"}
@app.post("/api/stop")
async def stop_h(_: None = Depends(require_admin_api_key)):
    harvest_control.pause()
    return {"status": "stopped"}
@app.get("/api/harvest-control")
async def harvest_control_status(_: None = Depends(require_admin_api_key)):
    """Operator view: pause flag and whether scheduled harvest/embedding tasks will run."""
    return {"paused": harvest_control.is_paused()}
@app.get("/api/vault")
async def vault(_: None = Depends(require_admin_api_key)):
    LIVE_DIR = _live_dir()
    files=[]
    for pdf, st in sorted(_vault_pdfs(LIVE_DIR), key=lambda item: item[1].st_mtime, reverse=True)[:100]:
        if st.st_size<15000: continue
        files.append({"path": str(pdf.relative_to(LIVE_DIR)), "size": st.st_size, "mtime": st.st_mtime})
    return {"files": files}
