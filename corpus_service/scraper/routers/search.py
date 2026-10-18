"""Public corpus routes: /search, /cases/{id}, /statutes, /statutes/{id} (audit F24).

Intentionally unauthenticated: these serve the published legal corpus. Operational/admin data
(/export, /jobs, /quarantine, /admin/*, /api/vault, /api/live-feed) is behind
require_admin_api_key.

Every route here is rate-limited per client network (scraper.rate_limit) and reads only through
scraper.public_corpus's public API: published rows only, summary DTOs in keyset pages, bounded
parameters (``limit`` in ASCII digits), one read-only transaction with a statement timeout, under
the process-wide cap on concurrent public reads. Parameters are validated (422 / 400) before any
database work. Spec: docs/superpowers/specs/2026-10-18-f24-bounded-public-corpus-queries-design.md.
"""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from scraper import public_corpus as pc
from scraper.client_identity import note_ignored_forwarding
from scraper.config import settings
from scraper.rate_limit import public_rate_limit

router = APIRouter(dependencies=[Depends(public_rate_limit), Depends(note_ignored_forwarding)])


def _timeout_ms() -> int:
    return settings.PUBLIC_QUERY_TIMEOUT_MS


@router.get("/search", response_model=pc.CasePage)
async def search(
    q: str = Query(..., description="2-200 characters; matched literally in the citation or title"),
    limit: int = Depends(pc.limit_param(pc.SEARCH_DEFAULT_LIMIT)),
    cursor: Optional[str] = Query(None, description="next_cursor from the previous page"),
):
    query_text = pc.query_text_or_422("q", q)
    after = pc.cursor_or_400(pc.CASE_CURSOR, cursor)
    return await pc.search_cases(query_text, after, limit, timeout_ms=_timeout_ms())


@router.get("/cases/{case_id}", response_model=pc.CaseDetail)
async def get_case(case_id: uuid.UUID):
    detail = await pc.case_detail(case_id, timeout_ms=_timeout_ms())
    if detail is None:  # missing and unpublished look the same
        raise HTTPException(status_code=404, detail="not found")
    return detail


@router.get("/statutes", response_model=pc.StatutePage)
async def statutes(
    statute_name: Optional[str] = Query(None, description="2-200 characters; matched literally"),
    limit: int = Depends(pc.limit_param(pc.STATUTES_DEFAULT_LIMIT)),
    cursor: Optional[str] = Query(None, description="next_cursor from the previous page"),
):
    name = pc.query_text_or_422("statute_name", statute_name) if statute_name is not None else None
    after = pc.cursor_or_400(pc.STATUTE_CURSOR, cursor)
    return await pc.list_statutes(name, after, limit, timeout_ms=_timeout_ms())


@router.get("/statutes/{statute_id}", response_model=pc.StatuteDetail)
async def get_statute(statute_id: uuid.UUID):
    """The bounded replacement for the section text the unbounded /statutes list used to return
    (spec ruling 9)."""
    detail = await pc.statute_detail(statute_id, timeout_ms=_timeout_ms())
    if detail is None:
        raise HTTPException(status_code=404, detail="not found")
    return detail
