"""Public corpus routes: /search, /cases/{id}, /statutes, /statutes/{id} (audit F24).

Intentionally unauthenticated: these serve the published legal corpus. Operational/admin data
(/export, /jobs, /quarantine, /admin/*, /api/vault, /api/live-feed) is behind
require_admin_api_key.

Every route here is rate-limited per client address (scraper.rate_limit) and reads only through
scraper.public_corpus: published rows only, summary DTOs in keyset pages, bounded parameters, one
read-only transaction with a statement timeout. Parameters are validated (422 / 400) before any
database work. Spec: docs/superpowers/specs/2026-10-18-f24-bounded-public-corpus-queries-design.md.
"""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from scraper import public_corpus as pc
from scraper.config import settings
from scraper.rate_limit import public_rate_limit

router = APIRouter(dependencies=[Depends(public_rate_limit)])


def _timeout_ms() -> int:
    return settings.PUBLIC_QUERY_TIMEOUT_MS


@router.get("/search", response_model=pc.CasePage)
async def search(
    q: str = Query(..., description="2-200 characters; matched literally in the citation or title"),
    limit: int = Query(pc.SEARCH_DEFAULT_LIMIT, ge=1, le=pc.MAX_PAGE_SIZE),
    cursor: Optional[str] = Query(None, description="next_cursor from the previous page"),
):
    query_text = pc.query_text_or_422("q", q)
    after = pc.cursor_or_400(pc.CASE_CURSOR, cursor)
    rows = await pc.fetch_rows(pc.search_cases_stmt(query_text, after, limit), timeout_ms=_timeout_ms())
    return pc.page_of(rows, limit, pc.CASE_CURSOR, pc.CaseSummary, pc.CasePage)


@router.get("/cases/{case_id}", response_model=pc.CaseDetail)
async def get_case(case_id: uuid.UUID):
    rows = await pc.fetch_rows(pc.case_detail_stmt(case_id), timeout_ms=_timeout_ms())
    if not rows:  # missing and unpublished look the same
        raise HTTPException(status_code=404, detail="not found")
    return pc.CaseDetail.model_validate(dict(rows[0]._mapping))


@router.get("/statutes", response_model=pc.StatutePage)
async def statutes(
    statute_name: Optional[str] = Query(None, description="2-200 characters; matched literally"),
    limit: int = Query(pc.STATUTES_DEFAULT_LIMIT, ge=1, le=pc.MAX_PAGE_SIZE),
    cursor: Optional[str] = Query(None, description="next_cursor from the previous page"),
):
    name = pc.query_text_or_422("statute_name", statute_name) if statute_name is not None else None
    after = pc.cursor_or_400(pc.STATUTE_CURSOR, cursor)
    rows = await pc.fetch_rows(pc.list_statutes_stmt(name, after, limit), timeout_ms=_timeout_ms())
    return pc.page_of(rows, limit, pc.STATUTE_CURSOR, pc.StatuteSummary, pc.StatutePage)


@router.get("/statutes/{statute_id}", response_model=pc.StatuteDetail)
async def get_statute(statute_id: uuid.UUID):
    """The bounded replacement for the section text the unbounded /statutes list used to return
    (spec ruling 9)."""
    rows = await pc.fetch_rows(pc.statute_detail_stmt(statute_id), timeout_ms=_timeout_ms())
    if not rows:
        raise HTTPException(status_code=404, detail="not found")
    return pc.StatuteDetail.model_validate(dict(rows[0]._mapping))
