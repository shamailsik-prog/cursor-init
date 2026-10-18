"""Admin export of published case law (audit F24, spec ruling 8).

Behind require_admin_api_key, as before. Published rows only (scraper.public_corpus), the same
columns as before, at most EXPORT_MAX_ROWS rows in id order, read from a server-side cursor in
chunks of EXPORT_CHUNK_ROWS inside one read-only transaction with EXPORT_QUERY_TIMEOUT_MS, and
encoded one chunk at a time, so memory holds one chunk, never the corpus.

X-Export-Row-Cap gives the cap; X-Export-Truncated says whether more published rows existed when
the export started (a bounded probe in its own transaction, so it is advisory).
"""

import csv
import io
import json
from typing import Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from scraper import public_corpus as pc
from scraper.auth import require_admin_api_key
from scraper.config import settings

router = APIRouter(prefix="/export", dependencies=[Depends(require_admin_api_key)])

CSV_HEADER = ("citation", "title", "court", "year")


def _csv(rows) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerows(rows)
    return out.getvalue()


def _jsonl(rows) -> str:
    return "".join(json.dumps({"citation": r.citation, "title": r.case_title}) + "\n" for r in rows)


@router.get("/cases")
async def export_cases(fmt: Literal["csv", "jsonl"] = Query("csv", alias="format")):
    cap = settings.EXPORT_MAX_ROWS
    chunk_rows = settings.EXPORT_CHUNK_ROWS
    timeout_ms = settings.EXPORT_QUERY_TIMEOUT_MS
    truncated = bool(await pc.fetch_rows(pc.export_truncation_probe(cap), timeout_ms=timeout_ms))
    headers = {"X-Export-Row-Cap": str(cap), "X-Export-Truncated": "true" if truncated else "false"}

    async def body():
        if fmt == "csv":
            yield _csv([CSV_HEADER])
        async for rows in pc.stream_export_cases(cap, chunk_rows, timeout_ms):
            yield _jsonl(rows) if fmt == "jsonl" else _csv((r.citation, r.case_title, r.court, r.year) for r in rows)

    media_type = "application/jsonl" if fmt == "jsonl" else "text/csv"
    return StreamingResponse(body(), media_type=media_type, headers=headers)
