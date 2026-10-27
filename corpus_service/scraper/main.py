from fastapi import Depends, FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import logging
import os
import pathlib
from scraper.admin_credentials import CorpusAdminPrincipal
from scraper.auth import (
    record_corpus_admin_audit,
    require_corpus_read,
    require_corpus_trigger,
)
from scraper.database import get_db
from sqlalchemy.ext.asyncio import AsyncSession
from scraper.routers import sources, jobs, quarantine, search, export
from scraper.database import init_db
from scraper.config import settings
from scraper import client_identity
from scraper.parsers import raw_store
from scraper.rate_limit import RateLimitedPathsMiddleware
from scraper import harvest_control
from scraper import health_probe

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
def _state_dir() -> pathlib.Path:
    return pathlib.Path("/app/state" if pathlib.Path("/app/state").exists() else "./blackletter_state")


@app.on_event("startup")
async def startup():
    client_identity.log_forwarded_trust_at_startup()
    await init_db()
    from scraper.database import SessionLocal

    app.state._health_telemetry_stop = asyncio.Event()
    app.state._health_telemetry_task = asyncio.create_task(
        health_probe.periodic_telemetry_refresh(
            SessionLocal,
            live_dir=_live_dir,
            vault_pdfs=_vault_pdfs,
            state_dir=_state_dir(),
            stop=app.state._health_telemetry_stop,
        )
    )


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
@app.get("/health/live")
async def health_live():
    """Process-up liveness only (no database or vault I/O)."""
    return {"status": "ok", "probe": "liveness"}


@app.get("/health")
async def health():
    """
    Readiness: bounded PostgreSQL probe (`SELECT 1`, short timeout). Telemetry fields come from the
    background cache only (no vault walk or `COUNT(*)` on this path). HTTP 503 when the DB probe fails.
    """
    from scraper.database import SessionLocal

    body = {**health_probe.telemetry_snapshot(), "dependencies": {"postgres": "failed"}}
    if await health_probe.readiness_postgres_ok(SessionLocal):
        body.update({"status": "ok", "db_connected": True, "dependencies": {"postgres": "ok"}})
        return JSONResponse(status_code=200, content=body)
    body.update({"status": "unhealthy", "db_connected": False})
    return JSONResponse(status_code=503, content=body)
@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard():
    # Static shell only; the page prompts for the admin key and sends it as X-API-Key.
    p=pathlib.Path(__file__).parent/"templates"/"dashboard.html"
    html = p.read_text() if p.exists() else "<h1>Dashboard missing</h1>"
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})
@app.get("/api/live-feed")
async def live_feed(_: CorpusAdminPrincipal = Depends(require_corpus_read)):
    import pathlib
    STATE_DIR = pathlib.Path("/app/state" if pathlib.Path("/app/state").exists() else "./blackletter_state")
    logs=[]
    for seat in ["a","b"]:
        lp=STATE_DIR/f"harvest-{seat}.log"
        if lp.exists():
            logs.extend(lp.read_text().splitlines()[-20:])
    return {"feed": logs[-40:]}
@app.post("/api/start")
async def start_h(
    principal: CorpusAdminPrincipal = Depends(require_corpus_trigger),
    db: AsyncSession = Depends(get_db),
):
    await record_corpus_admin_audit(
        db, principal, "harvest.start", scopes_used=["trigger"], resource={}
    )
    await db.commit()
    await harvest_control.resume_async()
    return {"status": "started"}
@app.post("/api/stop")
async def stop_h(
    principal: CorpusAdminPrincipal = Depends(require_corpus_trigger),
    db: AsyncSession = Depends(get_db),
):
    await record_corpus_admin_audit(
        db, principal, "harvest.stop", scopes_used=["trigger"], resource={}
    )
    await db.commit()
    await harvest_control.pause_async()
    return {"status": "stopped"}
@app.get("/api/harvest-control")
async def harvest_control_status(_: CorpusAdminPrincipal = Depends(require_corpus_read)):
    """Operator view: pause flag, in-flight harvest/embedding work, and scheduled gate state."""
    return await harvest_control.operator_status_async()
@app.get("/api/vault")
async def vault(_: CorpusAdminPrincipal = Depends(require_corpus_read)):
    LIVE_DIR = _live_dir()
    files=[]
    for pdf, st in sorted(_vault_pdfs(LIVE_DIR), key=lambda item: item[1].st_mtime, reverse=True)[:100]:
        if st.st_size<15000: continue
        files.append({"path": str(pdf.relative_to(LIVE_DIR)), "size": st.st_size, "mtime": st.st_mtime})
    return {"files": files}
