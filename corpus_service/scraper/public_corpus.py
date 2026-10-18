"""Published-only, bounded reads of the corpus for the public routes and the export (audit F24).

This module is the only code that reads ``case_law_master`` / ``statutes_master`` for
``scraper.routers.search`` (public) and ``scraper.routers.export`` (admin). The AST scan in
``tests/test_trust_policy.py`` keeps it that way: neither router is on its read-only allowlist.

Spec: docs/superpowers/specs/2026-10-18-f24-bounded-public-corpus-queries-design.md.

* Ruling 1, published only, failing closed. Case law is published when ``is_promoted IS TRUE``
  and its ``source_site`` names a source whose ``trust_level`` is exactly ``trusted`` or
  ``review``. A statute section is published when its ``source_site`` names a source whose
  ``trust_level`` is exactly ``trusted`` (since F20 only a trusted ``direct`` route may write the
  table). Anything else (not promoted, blocked, a missing or unknown source, a value outside the
  vocabulary) is never returned.
* Ruling 3, query text: trimmed, 2-200 characters, no control characters, not only LIKE
  metacharacters; ``\\``, ``%`` and ``_`` are escaped and matched with an explicit ESCAPE clause.
* Ruling 4, summary DTOs from explicit column lists: no list reads a text or vector column; no
  public response carries the embedding, provenance or internal quality fields.
* Ruling 5, keyset pages on the primary key with an opaque cursor; a malformed cursor is refused.
* Ruling 6, one READ ONLY transaction per request with a transaction-local statement timeout
  (``set_config('statement_timeout', ..., true)``, i.e. SET LOCAL); a cancelled statement
  (SQLSTATE 57014) becomes 503.
"""

from __future__ import annotations

import base64
import binascii
import re
import unicodedata
import uuid
from contextlib import asynccontextmanager
from datetime import date
from typing import AsyncIterator, Final, List, Optional, Sequence, Tuple

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Select, and_, exists, or_, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from scraper import database
from scraper.models import CaseLawMaster, ScraperSource, StatutesMaster
from scraper.trust import REVIEW, TRUSTED

# -- contract constants (ruling 10: the API's contract, not operator settings) ---------------------
MAX_PAGE_SIZE: Final = 100
SEARCH_DEFAULT_LIMIT: Final = 10  # FINAL_2 :1156 and main
STATUTES_DEFAULT_LIMIT: Final = 20  # main
MIN_QUERY_CHARS: Final = 2
MAX_QUERY_CHARS: Final = 200
MAX_CURSOR_CHARS: Final = 128
CASE_CURSOR: Final = "cl"
STATUTE_CURSOR: Final = "st"
LIKE_ESCAPE: Final = "\\"
STATEMENT_TIMEOUT_SQLSTATE: Final = "57014"  # query_canceled

# -- ruling 1: the published boundary ---------------------------------------------------------------
CASE_LAW_PUBLISHED_TRUST: Final[Tuple[str, ...]] = (TRUSTED, REVIEW)
STATUTE_PUBLISHED_TRUST: Final[Tuple[str, ...]] = (TRUSTED,)


def _source_trust_in(source_site_column, levels: Tuple[str, ...]):
    """EXISTS a scraper_sources row named exactly ``source_site`` with a trust level in ``levels``.
    A NULL or unknown source_site has no such row, so the row is not published."""
    return exists().where(
        ScraperSource.source_name == source_site_column,
        ScraperSource.trust_level.in_(levels),
    )


def published_case_law():
    return and_(
        CaseLawMaster.is_promoted.is_(True),
        _source_trust_in(CaseLawMaster.source_site, CASE_LAW_PUBLISHED_TRUST),
    )


def published_statutes():
    return _source_trust_in(StatutesMaster.source_site, STATUTE_PUBLISHED_TRUST)


# -- ruling 4: DTOs and the columns they are selected from --------------------------------------------
class _PublicDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CaseSummary(_PublicDTO):
    id: uuid.UUID
    citation: Optional[str]
    case_title: Optional[str]
    court: Optional[str]
    year: Optional[int]
    reporter: Optional[str]
    decision_date: Optional[date]
    bench_type: Optional[str]
    case_type: Optional[str]
    is_overruled: bool
    is_landmark: bool


class CaseDetail(CaseSummary):
    judge_names: Optional[List[str]]
    petitioner: Optional[str]
    respondent: Optional[str]
    overruled_by: Optional[str]
    summary: Optional[str]
    headnotes: Optional[str]
    full_text: Optional[str]


class StatuteSummary(_PublicDTO):
    id: uuid.UUID
    statute_name: Optional[str]
    short_name: Optional[str]
    section_number: Optional[str]
    section_title: Optional[str]
    chapter: Optional[str]
    year_enacted: Optional[int]
    is_repealed: bool


class StatuteDetail(StatuteSummary):
    section_text: Optional[str]
    effective_date: Optional[date]
    repealed_by: Optional[str]


class CasePage(_PublicDTO):
    items: List[CaseSummary]
    next_cursor: Optional[str]


class StatutePage(_PublicDTO):
    items: List[StatuteSummary]
    next_cursor: Optional[str]


def _columns(model, dto) -> tuple:
    return tuple(getattr(model, name) for name in dto.model_fields)


CASE_SUMMARY_COLUMNS: Final = _columns(CaseLawMaster, CaseSummary)
CASE_DETAIL_COLUMNS: Final = _columns(CaseLawMaster, CaseDetail)
STATUTE_SUMMARY_COLUMNS: Final = _columns(StatutesMaster, StatuteSummary)
STATUTE_DETAIL_COLUMNS: Final = _columns(StatutesMaster, StatuteDetail)
EXPORT_CASE_COLUMNS: Final = (CaseLawMaster.citation, CaseLawMaster.case_title, CaseLawMaster.court, CaseLawMaster.year)


# -- ruling 3: query text -----------------------------------------------------------------------------
class QueryTextError(ValueError):
    """Search text outside the public bounds. The message never contains the input."""


_LIKE_METACHARACTERS: Final = frozenset("%_\\")


def normalise_query_text(raw: str) -> str:
    """The trimmed search text, or QueryTextError when it is outside the bounds: 2-200 characters
    after trimming, no control character (Unicode Cc, NUL included), and not only LIKE
    metacharacters and whitespace."""
    if not isinstance(raw, str):
        raise QueryTextError("not text")
    if any(unicodedata.category(ch) == "Cc" for ch in raw):
        raise QueryTextError("control character")
    value = raw.strip()
    if not MIN_QUERY_CHARS <= len(value) <= MAX_QUERY_CHARS:
        raise QueryTextError("length")
    if all(ch in _LIKE_METACHARACTERS or ch.isspace() for ch in value):
        raise QueryTextError("wildcards only")
    return value


def escape_like(value: str) -> str:
    """``value`` with the escape character first, then ``%`` and ``_``, each preceded by
    LIKE_ESCAPE, so every character matches itself under ``ESCAPE '\\'``."""
    return value.replace(LIKE_ESCAPE, LIKE_ESCAPE * 2).replace("%", LIKE_ESCAPE + "%").replace("_", LIKE_ESCAPE + "_")


def like_contains(value: str) -> str:
    return f"%{escape_like(value)}%"


def query_text_or_422(name: str, raw: str) -> str:
    try:
        return normalise_query_text(raw)
    except QueryTextError:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{name} must be {MIN_QUERY_CHARS}-{MAX_QUERY_CHARS} characters after trimming, "
                "contain no control characters, and not consist only of wildcards"
            ),
        ) from None


# -- ruling 5: cursor ---------------------------------------------------------------------------------
class CursorError(ValueError):
    """A cursor this API did not issue (or not for this list)."""


_CURSOR_TOKEN: Final = re.compile(r"[A-Za-z0-9_-]+")


def encode_cursor(kind: str, after: uuid.UUID) -> str:
    raw = f"{kind}:{after}".encode("ascii")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(kind: str, token: str) -> uuid.UUID:
    """The id a cursor of ``kind`` points after; CursorError for anything else."""
    if not isinstance(token, str) or not token or len(token) > MAX_CURSOR_CHARS or not _CURSOR_TOKEN.fullmatch(token):
        raise CursorError("format")
    try:
        decoded = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode("ascii")
    except (binascii.Error, ValueError):  # UnicodeDecodeError is a ValueError
        raise CursorError("encoding") from None
    prefix, separator, rest = decoded.partition(":")
    if separator != ":" or prefix != kind:
        raise CursorError("kind")
    try:
        after = uuid.UUID(rest)
    except ValueError:
        raise CursorError("id") from None
    if str(after) != rest:  # only the canonical form this module issues
        raise CursorError("id")
    return after


def cursor_or_400(kind: str, token: Optional[str]) -> Optional[uuid.UUID]:
    if token is None:
        return None
    try:
        return decode_cursor(kind, token)
    except CursorError:
        raise HTTPException(status_code=400, detail="invalid cursor") from None


# -- statements -----------------------------------------------------------------------------------------
def search_cases_stmt(query_text: str, after: Optional[uuid.UUID], limit: int) -> Select:
    """Published case-law summaries whose citation or title contains ``query_text`` literally, in id
    order after ``after``; ``limit + 1`` rows so the caller can tell whether a next page exists."""
    pattern = like_contains(query_text)
    stmt = (
        select(*CASE_SUMMARY_COLUMNS)
        .where(
            published_case_law(),
            or_(
                CaseLawMaster.citation.ilike(pattern, escape=LIKE_ESCAPE),
                CaseLawMaster.case_title.ilike(pattern, escape=LIKE_ESCAPE),
            ),
        )
        .order_by(CaseLawMaster.id)
        .limit(limit + 1)
    )
    if after is not None:
        stmt = stmt.where(CaseLawMaster.id > after)
    return stmt


def list_statutes_stmt(statute_name: Optional[str], after: Optional[uuid.UUID], limit: int) -> Select:
    stmt = select(*STATUTE_SUMMARY_COLUMNS).where(published_statutes()).order_by(StatutesMaster.id).limit(limit + 1)
    if statute_name is not None:
        stmt = stmt.where(StatutesMaster.statute_name.ilike(like_contains(statute_name), escape=LIKE_ESCAPE))
    if after is not None:
        stmt = stmt.where(StatutesMaster.id > after)
    return stmt


def case_detail_stmt(case_id: uuid.UUID) -> Select:
    return select(*CASE_DETAIL_COLUMNS).where(CaseLawMaster.id == case_id, published_case_law())


def statute_detail_stmt(statute_id: uuid.UUID) -> Select:
    return select(*STATUTE_DETAIL_COLUMNS).where(StatutesMaster.id == statute_id, published_statutes())


def export_cases_stmt(cap: int) -> Select:
    return select(*EXPORT_CASE_COLUMNS).where(published_case_law()).order_by(CaseLawMaster.id).limit(cap)


def export_truncation_probe(cap: int) -> Select:
    """One row when more than ``cap`` published judgments exist, none otherwise."""
    return select(CaseLawMaster.id).where(published_case_law()).order_by(CaseLawMaster.id).offset(cap).limit(1)


def page_of(rows: Sequence, limit: int, kind: str, dto, page):
    """A keyset page from ``limit + 1`` rows."""
    more = len(rows) > limit
    kept = list(rows[:limit])
    items = [dto.model_validate(dict(row._mapping)) for row in kept]
    next_cursor = encode_cursor(kind, kept[-1].id) if more and kept else None
    return page(items=items, next_cursor=next_cursor)


# -- ruling 6: the read-only, timed transaction -----------------------------------------------------
def _sqlstate(exc: BaseException) -> Optional[str]:
    seen, stack = set(), [exc]
    while stack:
        candidate = stack.pop()
        if candidate is None or id(candidate) in seen:
            continue
        seen.add(id(candidate))
        for attr in ("sqlstate", "pgcode"):
            code = getattr(candidate, attr, None)
            if isinstance(code, str) and len(code) == 5:
                return code
        stack.extend([getattr(candidate, "orig", None), candidate.__cause__, candidate.__context__])
    return None


def is_statement_timeout(exc: BaseException) -> bool:
    return _sqlstate(exc) == STATEMENT_TIMEOUT_SQLSTATE


@asynccontextmanager
async def public_read_session(timeout_ms: int) -> AsyncIterator[AsyncSession]:
    """A session in one READ ONLY transaction whose statement_timeout is ``timeout_ms``. The
    timeout is transaction-local (set_config(..., true) is SET LOCAL; SET cannot take a bind
    parameter), so it ends with the transaction and never stays on a pooled connection."""
    async with database.SessionLocal() as session:
        async with session.begin():
            await session.execute(text("SET TRANSACTION READ ONLY"))
            await session.execute(
                text("SELECT set_config('statement_timeout', :timeout, true)"),
                {"timeout": f"{int(timeout_ms)}ms"},
            )
            yield session


@asynccontextmanager
async def timeouts_as_503() -> AsyncIterator[None]:
    """A statement cancelled by the timeout becomes 503 with Retry-After; nothing about the query
    or its rows is returned. Every other database error propagates unchanged."""
    try:
        yield
    except DBAPIError as exc:
        if is_statement_timeout(exc):
            raise HTTPException(status_code=503, detail="query timed out", headers={"Retry-After": "1"}) from None
        raise


async def fetch_rows(stmt: Select, *, timeout_ms: int) -> list:
    async with timeouts_as_503():
        async with public_read_session(timeout_ms) as db:
            return list((await db.execute(stmt)).all())


async def stream_export_cases(cap: int, chunk_rows: int, timeout_ms: int) -> AsyncIterator[Sequence]:
    """Published export rows (citation, case_title, court, year), at most ``cap``, in id order, in
    chunks of ``chunk_rows`` read from a server-side cursor inside one timed read-only
    transaction. Only one chunk is held in memory at a time."""
    async with public_read_session(timeout_ms) as db:
        result = await db.stream(export_cases_stmt(cap).execution_options(yield_per=chunk_rows))
        async for partition in result.partitions():
            yield partition
