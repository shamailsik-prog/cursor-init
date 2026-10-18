"""Admin export of published case law (audit F24, spec ruling 8 and the re-audit round).

Behind require_admin_api_key, as before. Published rows only (scraper.public_corpus), the same
columns as before, at most EXPORT_MAX_ROWS rows in id order.

* **No connection is held while the client reads (L3, Copilot thread 4305228825).** Rows are read
  in keyset batches of EXPORT_CHUNK_ROWS, each in its own short read-only transaction with a
  statement timeout; the connection is back in the pool before a batch is encoded and sent. A
  stalled or slow download therefore pins no database connection.
* **One deadline for the whole export.** EXPORT_DEADLINE_SECONDS, from the start of the request,
  bounds the batch reads and the response sends together. Past it the response is cancelled even
  while a send is blocked on a client that stopped reading, the batch stream is closed, and
  ExportDeadlineExceeded ends the transfer without its final chunk.
* **Bounded concurrency.** EXPORT_MAX_CONCURRENT exports at once per process; the next is 503.
* **Failures before the first byte are 503.** The truncation probe and the first batch are read
  before the response starts, so a timeout or an unavailable database there is a 503 with
  Retry-After, not a cut stream.
* **CSV formula injection (L4).** A CSV cell that starts with ``=``, ``+``, ``-``, ``@``, a tab or a
  carriage return is prefixed with a single quote (OWASP CSV injection guidance). JSONL is data, not
  a spreadsheet, and is not altered.

X-Export-Row-Cap gives the cap; X-Export-Truncated says whether more published rows existed when
the export started (a bounded probe in its own transaction, so it is advisory).
"""

import csv
import io
import json
import logging
import time
from typing import Literal

import anyio
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from scraper import public_corpus as pc
from scraper.auth import require_admin_api_key
from scraper.config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/export", dependencies=[Depends(require_admin_api_key)])

CSV_HEADER = ("citation", "title", "court", "year")
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def csv_safe_cell(value):
    """``value`` with a leading single quote when a spreadsheet would read it as a formula."""
    if isinstance(value, str) and value.startswith(_FORMULA_PREFIXES):
        return "'" + value
    return value


def _csv(rows) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerows([csv_safe_cell(cell) for cell in row] for row in rows)
    return out.getvalue()


def _csv_rows(rows) -> str:
    return _csv((r.citation, r.case_title, r.court, r.year) for r in rows)


def _jsonl(rows) -> str:
    return "".join(json.dumps({"citation": r.citation, "title": r.case_title}) + "\n" for r in rows)


class DeadlineStreamingResponse(StreamingResponse):
    """A StreamingResponse bounded by a time.monotonic() deadline that covers the body iteration and
    every send. On the deadline it cancels the response, closes the body (which closes the batch
    stream), runs ``on_close``, and raises ExportDeadlineExceeded."""

    def __init__(self, content, *, deadline: float, on_close, **kwargs):
        super().__init__(content, **kwargs)
        self.deadline = deadline
        self.on_close = on_close

    async def __call__(self, scope, receive, send) -> None:
        cut = False
        try:
            with anyio.move_on_after(max(0.0, self.deadline - time.monotonic())) as scope_deadline:
                await super().__call__(scope, receive, send)
            cut = scope_deadline.cancelled_caught
        finally:
            try:
                await self.body_iterator.aclose()
            finally:
                self.on_close()
        if cut:
            logger.warning("export cut at its deadline of %s s", settings.EXPORT_DEADLINE_SECONDS)
            raise pc.ExportDeadlineExceeded()


@router.get("/cases")
async def export_cases(fmt: Literal["csv", "jsonl"] = Query("csv", alias="format")):
    release = pc.acquire_export_slot()
    deadline = time.monotonic() + settings.EXPORT_DEADLINE_SECONDS
    cap = settings.EXPORT_MAX_ROWS
    timeout_ms = settings.EXPORT_QUERY_TIMEOUT_MS
    batches = pc.stream_export_cases(cap, settings.EXPORT_CHUNK_ROWS, timeout_ms, deadline=deadline)
    try:
        truncated = await pc.export_is_truncated(cap, timeout_ms=timeout_ms)
        try:
            first = await batches.__anext__()
        except StopAsyncIteration:
            first = []
    except BaseException:
        await batches.aclose()
        release()
        raise
    encode = _jsonl if fmt == "jsonl" else _csv_rows

    async def body():
        try:
            if fmt == "csv":
                yield _csv([CSV_HEADER])
            if first:
                yield encode(first)
            async for rows in batches:
                yield encode(rows)
        finally:
            await batches.aclose()

    headers = {"X-Export-Row-Cap": str(cap), "X-Export-Truncated": "true" if truncated else "false"}
    media_type = "application/jsonl" if fmt == "jsonl" else "text/csv"
    return DeadlineStreamingResponse(body(), deadline=deadline, on_close=release, media_type=media_type, headers=headers)
