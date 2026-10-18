"""Audit F24 re-audit round (FAIL 7/10) end to end against real Postgres 16 + pgvector.

Same harness as test_f24_public_corpus_db.py (the real app, migrated by ``python -m
scraper.migrate``, bound to the DML-only runtime role, synthetic 2099-dated seed), whose fixtures
are reused. Covers R1(a) IPv6 /64 keying, R1(c) the concurrency cap, R1(d) pool exhaustion, strict
limit parsing, L3 and Copilot thread 4305228825 (the whole-export deadline; no connection held
across a yield, so a stalled download cannot pin the pool), L4 CSV formula cells, and the mutants
M14 (export buffering) and M46 (export statement timeout ignored).

Settings that 4cbc081 does not have are skipped by ``configure``: there the request runs without
the bound, which is what the test must catch.
"""

import asyncio
import contextlib
import csv
import io
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url

from test_f24_public_corpus_db import (  # noqa: F401  (fixtures are used by name)
    CASE_SUMMARY_KEYS,
    MARKER,
    TRUSTED_SOURCE,
    _db_exec,
    _fresh_rate_limiter,
    client,
    configure,
    corpus,
    describe,
    page_of,
)


def _plain_url(corpus_db):
    return make_url(corpus_db.url).set(drivername="postgresql").render_as_string(hide_password=False)


def _waiting_on(corpus_db, table):
    import asyncpg

    async def go():
        conn = await asyncpg.connect(_plain_url(corpus_db))
        try:
            return await conn.fetchval(
                f"SELECT count(*) FROM pg_locks WHERE relation = '{table}'::regclass AND NOT granted"
            )
        finally:
            await conn.close()

    return asyncio.run(go())


@contextlib.contextmanager
def table_lock(corpus_db, table="case_law_master", max_seconds=6.0):
    """Another session holds ACCESS EXCLUSIVE on ``table`` until the block exits (or max_seconds,
    so a request that waits for the lock cannot hang the test)."""
    import asyncpg

    locked, release = threading.Event(), threading.Event()

    def hold():
        async def go():
            conn = await asyncpg.connect(_plain_url(corpus_db))
            try:
                tx = conn.transaction()
                await tx.start()
                await conn.execute(f"LOCK TABLE {table} IN ACCESS EXCLUSIVE MODE")
                locked.set()
                deadline = time.monotonic() + max_seconds
                while not release.is_set() and time.monotonic() < deadline:
                    await asyncio.sleep(0.02)
                await tx.rollback()
            finally:
                await conn.close()

        asyncio.run(go())

    holder = threading.Thread(target=hold, daemon=True)
    holder.start()
    assert locked.wait(10), "could not take the table lock"
    try:
        yield release
    finally:
        release.set()
        holder.join(15)


def wait_until(predicate, seconds=5.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.05)
    return False


@contextlib.contextmanager
def pooled_app_engine(test_client, **pool):
    """Bind the app's sessions to a pooled engine (production pools; the test engines are NullPool).
    Its connections live on the TestClient's event loop, so it is disposed there."""
    from sqlalchemy.ext.asyncio import create_async_engine

    from scraper import database
    from scraper.config import asyncpg_engine_args

    clean_url, connect_args = asyncpg_engine_args(database.engine.url.render_as_string(hide_password=False))
    engine = create_async_engine(clean_url, connect_args=connect_args, **pool)
    database.SessionLocal.configure(bind=engine)
    try:
        yield engine
    finally:
        database.SessionLocal.configure(bind=database.engine)
        test_client.portal.call(engine.dispose)


# ---------------------------------------------------------------------------------------------
# R1(a): rotating addresses inside one IPv6 /64 is one client
# ---------------------------------------------------------------------------------------------
def test_r1a_ipv6_rotation_inside_one_64_gets_429(client, corpus, monkeypatch):
    from scraper.main import app

    configure(monkeypatch, PUBLIC_RATE_LIMIT_REQUESTS=3, PUBLIC_RATE_LIMIT_WINDOW_SECONDS=3600)
    codes = []
    for n in range(20):
        c = TestClient(app, raise_server_exceptions=False, client=(f"2001:db8:1:2::{n + 100:x}", 50000))
        codes.append(c.get("/search", params={"q": MARKER, "limit": 1}).status_code)
    assert codes == [200] * 3 + [429] * 17, f"one /64, a new address per request: {codes}"
    other = TestClient(app, raise_server_exceptions=False, client=("2001:db8:1:3::1", 50000))
    assert other.get("/search", params={"q": MARKER, "limit": 1}).status_code == 200
    mapped = [TestClient(app, raise_server_exceptions=False, client=(h, 50000)).get(
        "/search", params={"q": MARKER, "limit": 1}).status_code
        for h in ("203.0.113.7", "::ffff:203.0.113.7", "203.0.113.7", "::ffff:203.0.113.7")]
    assert mapped == [200, 200, 200, 429], f"IPv4 and IPv4-mapped IPv6 must share a bucket: {mapped}"


# ---------------------------------------------------------------------------------------------
# R1(c): the (N+1)th concurrent public read is 503, at once
# ---------------------------------------------------------------------------------------------
def test_r1c_the_next_concurrent_public_read_gets_503(client, corpus, corpus_db, monkeypatch):
    configure(monkeypatch, PUBLIC_DB_CONCURRENCY=2, PUBLIC_QUERY_TIMEOUT_MS=8000)
    holders = []
    with table_lock(corpus_db) as release:
        threads = [threading.Thread(target=lambda: holders.append(
            client.get("/search", params={"q": MARKER, "limit": 1}).status_code)) for _ in range(2)]
        for t in threads:
            t.start()
        assert wait_until(lambda: _waiting_on(corpus_db, "case_law_master") >= 2), "the two reads never reached the database"
        started = time.monotonic()
        res = client.get("/search", params={"q": MARKER, "limit": 1})
        elapsed = time.monotonic() - started
        release.set()
        for t in threads:
            t.join(15)
    assert res.status_code == 503, f"the third concurrent read: {describe(res)} after {elapsed:.2f}s"
    assert elapsed < 1.5, f"the cap must refuse at once, not wait ({elapsed:.2f}s)"
    assert res.headers.get("retry-after") == "1"
    assert MARKER not in res.text
    assert sorted(holders) == [200, 200]
    items, _ = page_of(client.get("/search", params={"q": MARKER, "limit": 1}), CASE_SUMMARY_KEYS)
    assert len(items) == 1, "the slots were not given back"


# ---------------------------------------------------------------------------------------------
# R1(d): pool exhaustion is 503 with Retry-After, never 500
# ---------------------------------------------------------------------------------------------
def test_r1d_pool_exhaustion_is_503_not_500(client, corpus, corpus_db, monkeypatch):
    configure(monkeypatch, PUBLIC_DB_CONCURRENCY=8, PUBLIC_QUERY_TIMEOUT_MS=8000)
    holder = []
    with pooled_app_engine(client, pool_size=1, max_overflow=0, pool_timeout=0.5) as engine:
        with table_lock(corpus_db) as release:
            t = threading.Thread(target=lambda: holder.append(
                client.get("/search", params={"q": MARKER, "limit": 1}).status_code))
            t.start()
            assert wait_until(lambda: _waiting_on(corpus_db, "case_law_master") >= 1)
            assert engine.pool.checkedout() == 1
            started = time.monotonic()
            res = client.get("/search", params={"q": MARKER, "limit": 1})
            elapsed = time.monotonic() - started
            release.set()
            t.join(15)
    assert res.status_code == 503, f"pool exhausted: {res.status_code} after {elapsed:.2f}s: {res.text[:200]}"
    assert res.headers.get("retry-after") == "1"
    assert "QueuePool" not in res.text
    assert holder == [200]


# ---------------------------------------------------------------------------------------------
# strict limit parsing, end to end
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("limit", ["10.0", "+10", " 10", "1_0"])
def test_strict_limit_values_are_refused_end_to_end(client, corpus, limit):
    for path, params in (("/search", {"q": MARKER, "limit": limit}), ("/statutes", {"limit": limit})):
        res = client.get(path, params=params)
        assert res.status_code == 422, f"{path} limit={limit!r} was served: {describe(res)}"


# ---------------------------------------------------------------------------------------------
# L3 / Copilot 4305228825: a stalled download holds no connection, and the deadline ends it
# ---------------------------------------------------------------------------------------------
def _export_scope(path_qs, key):
    path, _, qs = path_qs.partition("?")
    return {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": "GET", "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "",
        "query_string": qs.encode(), "headers": [(b"host", b"testserver"), (b"x-api-key", key.encode())],
        "client": ("192.0.2.60", 50000), "server": ("testserver", 80),
    }


def test_l3_stalled_consumer_releases_the_connection_at_the_deadline(corpus, monkeypatch):
    """The ASGI app driven directly (TestClient buffers the body, so it never stalls a send). The
    client stays connected (receive never returns) and stops reading after the first data chunk
    (send blocks). While it is stalled no pooled connection may be checked out, and by the
    whole-export deadline the response must have ended."""
    from sqlalchemy.ext.asyncio import create_async_engine

    from scraper import database
    from scraper.config import asyncpg_engine_args, settings
    from scraper.main import app

    configure(monkeypatch, EXPORT_DEADLINE_SECONDS=1, EXPORT_CHUNK_ROWS=10, EXPORT_MAX_ROWS=1000)
    deadline = getattr(settings, "EXPORT_DEADLINE_SECONDS", 1)

    async def go():
        clean_url, connect_args = asyncpg_engine_args(database.engine.url.render_as_string(hide_password=False))
        pooled = create_async_engine(clean_url, connect_args=connect_args, pool_size=2, max_overflow=0)
        database.SessionLocal.configure(bind=pooled)
        stall, first_data = asyncio.Event(), asyncio.Event()
        messages = []

        async def receive():
            await stall.wait()  # connected, never disconnects
            return {"type": "http.disconnect"}

        async def send(message):
            messages.append(message)
            if message["type"] == "http.response.body" and message.get("body"):
                first_data.set()
                await stall.wait()  # the client stops reading

        task = asyncio.create_task(app(_export_scope("/export/cases?format=jsonl", settings.ADMIN_API_KEY), receive, send))
        try:
            await asyncio.wait_for(first_data.wait(), 10)
            await asyncio.sleep(0.2)
            held_while_stalled = pooled.pool.checkedout()
            done, _ = await asyncio.wait({task}, timeout=deadline + 3)
            held_after = pooled.pool.checkedout()
            error = task.exception() if task in done else None
            return held_while_stalled, held_after, task in done, error, messages[0]
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            database.SessionLocal.configure(bind=database.engine)
            await pooled.dispose()

    held_while_stalled, held_after, finished, error, start = asyncio.run(go())
    assert start["type"] == "http.response.start" and start["status"] == 200
    assert held_while_stalled == 0, f"a stalled download kept {held_while_stalled} pooled connection(s) checked out"
    assert finished, "the export outlived its deadline while the client stalled"
    assert held_after == 0
    assert type(error).__name__ == "ExportDeadlineExceeded", repr(error)


def test_l3_a_slow_export_is_cut_at_the_whole_export_deadline(corpus, monkeypatch):
    """A producer slower than the deadline (each chunk takes 0.7 s to encode; the deadline is 1 s):
    the export ends with ExportDeadlineExceeded instead of running on. The server then drops the
    connection without the final chunk, so no client mistakes a cut export for a whole one."""
    from scraper.config import settings
    from scraper.main import app
    from scraper.routers import export

    configure(monkeypatch, EXPORT_DEADLINE_SECONDS=1, EXPORT_CHUNK_ROWS=10, EXPORT_MAX_ROWS=1000)
    encode = export._jsonl

    def slow(rows):
        time.sleep(0.7)
        return encode(rows)

    monkeypatch.setattr(export, "_jsonl", slow)
    strict = TestClient(app, raise_server_exceptions=True)
    with pytest.raises(Exception) as caught:
        strict.get("/export/cases", params={"format": "jsonl"}, headers={"X-API-Key": settings.ADMIN_API_KEY})
    assert type(caught.value).__name__ == "ExportDeadlineExceeded", repr(caught.value)
    # The database is not left in a transaction, and public reads still work.
    plain = TestClient(app, raise_server_exceptions=False)
    items, _ = page_of(plain.get("/search", params={"q": MARKER, "limit": 2}), CASE_SUMMARY_KEYS)
    assert len(items) == 2


# ---------------------------------------------------------------------------------------------
# M14 and Copilot 4305228825: bounded batches, and no connection checked out across a yield
# ---------------------------------------------------------------------------------------------
def test_m14_export_reads_bounded_batches_and_holds_no_connection_between_them(corpus):
    from sqlalchemy.ext.asyncio import create_async_engine

    from scraper import database
    from scraper import public_corpus as pc
    from scraper.config import asyncpg_engine_args

    async def go():
        clean_url, connect_args = asyncpg_engine_args(database.engine.url.render_as_string(hide_password=False))
        pooled = create_async_engine(clean_url, connect_args=connect_args, pool_size=2, max_overflow=0)
        database.SessionLocal.configure(bind=pooled)
        sizes, held = [], []
        try:
            stream = pc.stream_export_cases(1000, 10, 5000)
            try:
                async for batch in stream:
                    sizes.append(len(batch))
                    held.append(pooled.pool.checkedout())  # the generator is suspended at its yield
            finally:
                await stream.aclose()
        finally:
            database.SessionLocal.configure(bind=database.engine)
            await pooled.dispose()
        return sizes, held

    sizes, held = asyncio.run(go())
    assert sizes == [10, 10, 5], f"export batches {sizes}: not bounded chunks of 10"
    assert held == [0, 0, 0], f"pooled connections checked out at each yield: {held}"


def test_m46_the_export_statement_timeout_applies_to_its_reads(corpus, corpus_db):
    """Kills M46 (the export's reads run without the statement timeout): with the table locked, the
    export's first read is cancelled after 300 ms instead of waiting for the lock."""
    from scraper import public_corpus as pc

    async def first_batch():
        stream = pc.stream_export_cases(1000, 10, 300)
        try:
            return await stream.__anext__()
        finally:
            await stream.aclose()

    with table_lock(corpus_db, max_seconds=8.0):
        started = time.monotonic()
        with pytest.raises(Exception) as caught:
            asyncio.run(first_batch())
        elapsed = time.monotonic() - started
    assert elapsed < 4, f"the export read waited {elapsed:.2f}s for the lock"
    status = getattr(caught.value, "status_code", None)
    assert status == 503 or pc.is_statement_timeout(caught.value), repr(caught.value)


# ---------------------------------------------------------------------------------------------
# L4: formula cells are neutralised in CSV, kept as data in JSONL
# ---------------------------------------------------------------------------------------------
def test_l4_csv_export_neutralises_formula_cells(client, corpus, corpus_db):
    from scraper.config import settings

    _db_exec(
        corpus_db,
        "INSERT INTO case_law_master (citation, case_title, court, year, source_site, is_promoted) "
        "VALUES (:citation, :title, :court, 2099, :site, true)",
        {"citation": '=HYPERLINK("http://evil.invalid","x")', "title": "+cmd|' /C calc'!A0",
         "court": "@SUM(1+1)", "site": TRUSTED_SOURCE},
    )
    headers = {"X-API-Key": settings.ADMIN_API_KEY}
    rows = list(csv.reader(io.StringIO(client.get("/export/cases", params={"format": "csv"}, headers=headers).text)))
    hostile = [r for r in rows if "HYPERLINK" in r[0]]
    assert hostile == [["'=HYPERLINK(\"http://evil.invalid\",\"x\")", "'+cmd|' /C calc'!A0", "'@SUM(1+1)", "2099"]], hostile
    assert all(not cell.startswith(("=", "+", "-", "@", "\t", "\r")) for row in rows for cell in row)
    lines = [json.loads(line) for line in client.get("/export/cases", params={"format": "jsonl"}, headers=headers).text.splitlines()]
    assert {"citation": '=HYPERLINK("http://evil.invalid","x")', "title": "+cmd|' /C calc'!A0"} in lines
