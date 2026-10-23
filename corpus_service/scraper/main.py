import asyncio
from datetime import datetime, timezone
import json
import logging
import os
import pathlib
import time
from typing import Any, Dict, Optional, Tuple
from fastapi import Depends, FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from scraper.auth import require_admin_api_key
from scraper.routers import sources, jobs, quarantine, search, export
from scraper.database import init_db
from scraper.config import settings
from scraper import client_identity
from scraper.parsers import raw_store
from scraper.rate_limit import RateLimitedPathsMiddleware

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

READINESS_DB_TIMEOUT_SECONDS = 2.0
HEALTH_COUNTS_TTL_SECONDS = 60.0

_counts_cache: Optional[Dict[str, Any]] = None


@app.on_event("startup")
async def startup():
    client_identity.log_forwarded_trust_at_startup()
    await init_db()


def _live_dir() -> pathlib.Path:
    """The PDF vault /health and /api/vault read (bootstrap_harvest.py's live/)."""
    return pathlib.Path("/app/live" if pathlib.Path("/app/live").exists() else "./live")


def _state_dir() -> pathlib.Path:
    return pathlib.Path("/app/state" if pathlib.Path("/app/state").exists() else "./blackletter_state")


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


def reset_health_counts_cache() -> None:
    """Clear the in-memory cached vault counts (for tests and explicit resets)."""
    global _counts_cache
    _counts_cache = None


def record_vault_counts(
    total_pdfs: int,
    seen: int,
    *,
    now_monotonic: Optional[float] = None,
    updated_at: Optional[str] = None,
    scope: Optional[Tuple[str, str]] = None,
) -> Dict[str, Any]:
    """Record precomputed vault/harvest counts with a freshness timestamp (audit F44)."""
    global _counts_cache
    mono = time.monotonic() if now_monotonic is None else float(now_monotonic)
    iso = updated_at or datetime.now(timezone.utc).isoformat()
    resolved_scope = scope or (str(_live_dir().resolve()), str(_state_dir().resolve()))
    _counts_cache = {
        "scope": resolved_scope,
        "total_pdfs": int(total_pdfs),
        "seen": int(seen),
        "updated_at": iso,
        "monotonic_at": mono,
    }
    return _counts_cache


def _get_cached_vault_counts(ttl_seconds: float = HEALTH_COUNTS_TTL_SECONDS) -> Dict[str, Any]:
    """Return cached (total_pdfs, seen) with freshness metadata, refreshing only when cold/expired."""
    global _counts_cache
    live_dir = _live_dir()
    state_dir = _state_dir()
    scope = (str(live_dir.resolve()), str(state_dir.resolve()))
    now_mono = time.monotonic()

    if (
        _counts_cache is not None
        and _counts_cache.get("scope") == scope
        and (now_mono - _counts_cache["monotonic_at"]) <= ttl_seconds
    ):
        age = max(0.0, round(now_mono - _counts_cache["monotonic_at"], 3))
        return {
            "total_pdfs": _counts_cache["total_pdfs"],
            "seen": _counts_cache["seen"],
            "counts_updated_at": _counts_cache["updated_at"],
            "counts_age_seconds": age,
        }

    total_pdfs = sum(1 for _, st in _vault_pdfs(live_dir) if st.st_size > 15000)
    seen = 0
    sf = state_dir / "harvest-seen.json"
    if sf.exists():
        try:
            seen = len(json.loads(sf.read_text()).get("seen", []))
        except Exception:
            pass
    entry = record_vault_counts(total_pdfs, seen, now_monotonic=now_mono, scope=scope)
    return {
        "total_pdfs": entry["total_pdfs"],
        "seen": entry["seen"],
        "counts_updated_at": entry["updated_at"],
        "counts_age_seconds": 0.0,
    }


async def _probe_database() -> int:
    from scraper.database import SessionLocal
    from sqlalchemy import select, func
    from scraper.models import CaseLawMaster

    async with SessionLocal() as db:
        c = await db.execute(select(func.count(CaseLawMaster.id)))
        return int(c.scalar() or 0)


@app.get("/livez")
async def livez():
    """Cheap liveness probe (audit F44): no disk walk, file read, or database query."""
    return {"status": "ok"}


async def _readiness_response():
    counts = _get_cached_vault_counts()
    try:
        total_cases = await asyncio.wait_for(_probe_database(), timeout=READINESS_DB_TIMEOUT_SECONDS)
        return {
            "status": "ok",
            "db_connected": True,
            "total_cases": total_cases,
            "total_pdfs": counts["total_pdfs"],
            "seen": counts["seen"],
            "counts_updated_at": counts["counts_updated_at"],
            "counts_age_seconds": counts["counts_age_seconds"],
        }
    except Exception:
        # Never echo the exception: driver errors can embed the DATABASE_URL (credentials, host).
        logger.warning("health: database probe failed", exc_info=True)
        return JSONResponse(
            status_code=503,
            content={
                "status": "degraded",
                "db_connected": False,
                "total_pdfs": counts["total_pdfs"],
                "seen": counts["seen"],
                "counts_updated_at": counts["counts_updated_at"],
                "counts_age_seconds": counts["counts_age_seconds"],
            },
        )


@app.get("/readyz")
async def readyz():
    """Bounded readiness probe (audit F44): probes DB with short timeout and returns 503 on failure."""
    return await _readiness_response()


@app.get("/health")
async def health():
    return await _readiness_response()


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard():
    # Static shell only; the page prompts for the admin key and sends it as X-API-Key.
    p = pathlib.Path(__file__).parent / "templates" / "dashboard.html"
    html = p.read_text() if p.exists() else "<h1>Dashboard missing</h1>"
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/api/live-feed")
async def live_feed(_: None = Depends(require_admin_api_key)):
    STATE_DIR = _state_dir()
    logs = []
    for seat in ["a", "b"]:
        lp = STATE_DIR / f"harvest-{seat}.log"
        if lp.exists():
            logs.extend(lp.read_text().splitlines()[-20:])
    return {"feed": logs[-40:]}


@app.post("/api/start")
async def start_h(_: None = Depends(require_admin_api_key)):
    STATE_DIR = _state_dir()
    sf = STATE_DIR / "harvest.stopped"
    if sf.exists():
        sf.unlink()
    return {"status": "started"}


@app.post("/api/stop")
async def stop_h(_: None = Depends(require_admin_api_key)):
    STATE_DIR = _state_dir()
    (STATE_DIR / "harvest.stopped").write_text("stopped")
    return {"status": "stopped"}


@app.get("/api/vault")
async def vault(_: None = Depends(require_admin_api_key)):
    LIVE_DIR = _live_dir()
    files = []
    for pdf, st in sorted(_vault_pdfs(LIVE_DIR), key=lambda item: item[1].st_mtime, reverse=True)[:100]:
        if st.st_size < 15000:
            continue
        files.append({"path": str(pdf.relative_to(LIVE_DIR)), "size": st.st_size, "mtime": st.st_mtime})
    return {"files": files}
