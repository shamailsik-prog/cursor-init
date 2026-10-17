"""Audit F24 end to end against real Postgres 16 + pgvector.

The real application (``scraper.main.app``, startup included) is driven through ``TestClient``.
The database is built by ``python -m scraper.migrate`` exactly as the compose ``migrate`` service
runs it, and the app is bound to a DML-only runtime role the way PR 2b provisions it. The seed is
synthetic and 2099-dated:

* 25 published judgments (``is_promoted`` true, from a trusted or a review source), each with full
  text and a 1536-dimension embedding;
* 4 unpublished judgments carrying the same search marker: not promoted, a blocked source, a source
  that does not exist, no source;
* a staging row and a quarantine row with the same marker;
* 3 statute sections from a trusted source and 3 that are not published (review source, blocked
  source, no source).

What the tests expect is written out from the spec
(docs/superpowers/specs/2026-10-18-f24-bounded-public-corpus-queries-design.md), not imported
from the code under test, and this file imports no module that main lacks: on main it fails by
behaviour. Settings that main does not have are skipped by ``configure`` below, so on main the
request runs with no bound at all, which is the finding.

Needs CORPUS_TEST_DATABASE_URL (see conftest.py); every test gets a fresh database.
"""

import asyncio
import csv
import io
import json
import threading
import time
import uuid

import pytest
from sqlalchemy import text

MARKER = "F24MARKER"
EMBEDDING = "[" + ",".join(["0.001"] * 1536) + "]"
TRUSTED_SOURCE = "PakistanLawSite"  # seeded trusted by migrate (F20)
REVIEW_SOURCE = "SindhHighCourt"  # seeded review by migrate (F20)
STATUTE_SOURCE = "PakistanCode"  # seeded trusted by migrate (F20)
STATUTE_REVIEW_SOURCE = "NasirLawSite"  # seeded review by migrate (F20)
BLOCKED_SOURCE = "F24BlockedSource"  # inserted blocked below
MISSING_SOURCE = "F24NoSuchSource"  # names no scraper_sources row

# Spec ruling 4: the exact public field sets.
CASE_SUMMARY_KEYS = {
    "id", "citation", "case_title", "court", "year", "reporter", "decision_date", "bench_type",
    "case_type", "is_overruled", "is_landmark",
}
CASE_DETAIL_KEYS = CASE_SUMMARY_KEYS | {
    "judge_names", "petitioner", "respondent", "overruled_by", "summary", "headnotes", "full_text",
}
STATUTE_SUMMARY_KEYS = {
    "id", "statute_name", "short_name", "section_number", "section_title", "chapter", "year_enacted",
    "is_repealed",
}
STATUTE_DETAIL_KEYS = STATUTE_SUMMARY_KEYS | {"section_text", "effective_date", "repealed_by"}
NEVER_PUBLIC = {"embedding", "search_text", "validation_errors", "source_site", "source_url", "source_file_path"}


# ---------------------------------------------------------------------------------------------
# seed
# ---------------------------------------------------------------------------------------------
def _published_cases():
    rows = []
    for i in range(19):
        rows.append((f"2099 SCMR {101 + i}", f"{MARKER} Trusted Party {i} v. The State", TRUSTED_SOURCE))
    for i in range(2):
        rows.append((f"2099 PLD Karachi {201 + i}", f"{MARKER} Reviewed Party {i} v. Province", REVIEW_SOURCE))
    # Literal LIKE metacharacters in titles (spec ruling 3): "100%" must not match "1005", and
    # "A_B" must not match "AxB".
    rows.append(("2099 CLC 301", f"{MARKER} 100% Shareholding Ltd v. Registrar", TRUSTED_SOURCE))
    rows.append(("2099 CLC 302", f"{MARKER} 1005 Holdings v. Registrar", TRUSTED_SOURCE))
    rows.append(("2099 CLC 303", f"{MARKER} A_B Traders v. Collector", TRUSTED_SOURCE))
    rows.append(("2099 CLC 304", f"{MARKER} AxB Traders v. Collector", TRUSTED_SOURCE))
    return rows


UNPUBLISHED_CASES = {
    # citation: (title, source_site, is_promoted)
    "2099 YLR 901": (f"{MARKER} Unpromoted Party v. State", TRUSTED_SOURCE, False),
    "2099 YLR 902": (f"{MARKER} Blocked Source Party v. State", BLOCKED_SOURCE, True),
    "2099 YLR 903": (f"{MARKER} Unknown Source Party v. State", MISSING_SOURCE, True),
    "2099 YLR 904": (f"{MARKER} No Source Party v. State", None, True),
}


def _db_exec(corpus_db, sql, rows=None):
    async def go():
        eng = corpus_db.engine_for(corpus_db.url)
        try:
            async with eng.begin() as conn:
                await conn.execute(text(sql), rows if rows is not None else {})
        finally:
            await eng.dispose()

    asyncio.run(go())


def seed(corpus_db):
    """Migrate (as the compose migrate service runs it) and seed; returns the ids and citations."""
    proc = corpus_db.migrate()
    assert proc.returncode == 0, f"migrate failed:\n{proc.stdout[-2000:]}\n{proc.stderr[-4000:]}"
    _db_exec(
        corpus_db,
        "INSERT INTO scraper_sources (source_name, source_url, trust_level) "
        "VALUES (:n, 'https://blocked.invalid', 'blocked')",
        {"n": BLOCKED_SOURCE},
    )
    insert_case = (
        "INSERT INTO case_law_master (id, citation, case_title, court, year, reporter, full_text, "
        "summary, source_site, source_url, is_promoted, embedding) VALUES (:id, :citation, :title, "
        "'Synthetic Court', 2099, :reporter, :full_text, :summary, :site, 'https://example.invalid/j', "
        ":promoted, CAST(CAST(:embedding AS text) AS vector))"
    )
    published, unpublished, rows = {}, {}, []
    for citation, title, site in _published_cases():
        case_id = uuid.uuid4()
        published[citation] = case_id
        rows.append(dict(id=case_id, citation=citation, title=title, reporter=citation.split()[1],
                         full_text=f"FULL-TEXT {citation}", summary=f"SUMMARY {citation}", site=site,
                         promoted=True, embedding=EMBEDDING))
    for citation, (title, site, promoted) in UNPUBLISHED_CASES.items():
        case_id = uuid.uuid4()
        unpublished[citation] = case_id
        rows.append(dict(id=case_id, citation=citation, title=title, reporter="YLR",
                         full_text=f"FULL-TEXT {citation}", summary=f"SUMMARY {citation}", site=site,
                         promoted=promoted, embedding=EMBEDDING))
    _db_exec(corpus_db, insert_case, rows)
    _db_exec(
        corpus_db,
        "INSERT INTO scraper_staging (source_site, extracted_citation, extracted_title, raw_text) "
        "VALUES (:site, '2099 YLR 905', :title, 'STAGED TEXT')",
        {"site": TRUSTED_SOURCE, "title": f"{MARKER} Staged Party v. State"},
    )
    _db_exec(
        corpus_db,
        "INSERT INTO quarantine_queue (source_site, extracted_citation, extracted_title, reason) "
        "VALUES (:site, '2099 YLR 906', :title, 'review_source')",
        {"site": REVIEW_SOURCE, "title": f"{MARKER} Quarantined Party v. State"},
    )
    insert_statute = (
        "INSERT INTO statutes_master (id, statute_name, short_name, section_number, section_title, "
        "section_text, year_enacted, source_site, embedding) VALUES (:id, :name, :short, :section, "
        ":title, :body, 2099, :site, CAST(CAST(:embedding AS text) AS vector))"
    )
    statutes_published, statutes_unpublished, rows = {}, {}, []
    for short, section, site, bucket in (
        ("F24A", "1", STATUTE_SOURCE, statutes_published),
        ("F24A", "2", STATUTE_SOURCE, statutes_published),
        ("F24A", "3", STATUTE_SOURCE, statutes_published),
        ("F24B", "1", STATUTE_REVIEW_SOURCE, statutes_unpublished),
        ("F24C", "1", BLOCKED_SOURCE, statutes_unpublished),
        ("F24D", "1", None, statutes_unpublished),
    ):
        statute_id = uuid.uuid4()
        bucket[f"{short}/{section}"] = statute_id
        rows.append(dict(id=statute_id, name="F24 Synthetic Act 2099", short=short, section=section,
                         title=f"Section {section} of {short}", body=f"SECTION-TEXT {short}/{section}",
                         site=site, embedding=EMBEDDING))
    _db_exec(corpus_db, insert_statute, rows)
    return {
        "published": published,
        "unpublished": unpublished,
        "statutes_published": statutes_published,
        "statutes_unpublished": statutes_unpublished,
    }


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
def configure(monkeypatch, **values):
    """Set F24 settings for this test. A setting main does not have is skipped: main then runs with
    no bound, which is exactly what the test must catch."""
    from scraper.config import settings

    for name, value in values.items():
        if name in type(settings).model_fields:
            monkeypatch.setattr(settings, name, value)


@pytest.fixture(autouse=True)
def _fresh_rate_limiter():
    """Each test starts with full buckets (no-op on main, which has no limiter)."""
    try:
        from scraper import rate_limit
    except ImportError:
        yield
        return
    rate_limit.public_limiter.reset()
    yield
    rate_limit.public_limiter.reset()


@pytest.fixture
def corpus(corpus_db):
    data = seed(corpus_db)
    with corpus_db.app_engine_as(*corpus_db.runtime_role(corpus_writer="none")):
        yield data


@pytest.fixture
def client(corpus):
    from fastapi.testclient import TestClient

    from scraper.main import app

    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def describe(res):
    """What a response leaked, for the failure message."""
    try:
        body = res.json()
    except ValueError:
        return f"status {res.status_code}, non-JSON body of {len(res.content)} bytes"
    rows = body if isinstance(body, list) else body.get("items") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        return f"status {res.status_code}, body {str(body)[:200]}"
    citations = sorted(str(r.get("citation") or r.get("short_name")) for r in rows if isinstance(r, dict))
    unpublished = [c for c in citations if c in UNPUBLISHED_CASES]
    keys = set().union(*(r.keys() for r in rows if isinstance(r, dict))) if rows else set()
    embedding = next((r.get("embedding") for r in rows if isinstance(r, dict) and r.get("embedding")), None)
    return (
        f"status {res.status_code}: {len(rows)} rows, unpublished rows {unpublished}, "
        f"text fields {sorted(keys & {'full_text', 'full_text_urdu', 'section_text'})}, "
        f"embedding {'of ' + str(len(embedding)) + ' floats' if embedding else 'absent'}"
    )


def page_of(res, keys):
    """The items of a public list response, checked for shape and for every never-public field."""
    assert res.status_code == 200, describe(res)
    body = res.json()
    assert isinstance(body, dict) and set(body) == {"items", "next_cursor"}, (
        f"not a keyset page ({{items, next_cursor}}): {describe(res)}"
    )
    for item in body["items"]:
        assert set(item) == keys, f"fields {sorted(set(item) ^ keys)} differ from the summary DTO"
        assert not (set(item) & NEVER_PUBLIC)
    return body["items"], body["next_cursor"]


def walk(client, path, params, keys):
    """Every page of a list, following next_cursor; returns (items, page sizes)."""
    items, sizes, cursor = [], [], None
    for _ in range(50):
        query = dict(params, **({"cursor": cursor} if cursor else {}))
        batch, cursor = page_of(client.get(path, params=query), keys)
        items.extend(batch)
        sizes.append(len(batch))
        if cursor is None:
            return items, sizes
    raise AssertionError("pagination did not terminate")


# ---------------------------------------------------------------------------------------------
# (a) the audit's synthetic attack
# ---------------------------------------------------------------------------------------------
def test_a_wildcard_with_a_billion_limit_is_refused_and_only_published_summaries_come_back(client, corpus):
    res = client.get("/search", params={"q": "%", "limit": 1_000_000_000})
    assert res.status_code == 422, f"q='%' with limit=1e9 was served: {describe(res)}"

    for params in (
        {"q": "_", "limit": 10},  # wildcard only
        {"q": "%%", "limit": 10},
        {"q": " %_ ", "limit": 10},  # wildcards and whitespace only
        {"q": "\\\\", "limit": 10},  # escape characters only
        {"q": "x", "limit": 10},  # under 2 characters
        {"q": "   x   ", "limit": 10},  # under 2 characters after trimming
        {"q": "y" * 201, "limit": 10},  # over 200 characters
        {"q": f"{MARKER}\x00", "limit": 10},  # control character
        {"q": MARKER, "limit": 0},
        {"q": MARKER, "limit": -1},
        {"q": MARKER, "limit": 101},
        {"q": MARKER, "limit": 1_000_000_000},
    ):
        res = client.get("/search", params=params)
        assert res.status_code == 422, f"{params!r} was served: {describe(res)}"

    items, cursor = page_of(client.get("/search", params={"q": MARKER, "limit": 100}), CASE_SUMMARY_KEYS)
    assert cursor is None
    assert {i["citation"] for i in items} == set(corpus["published"])
    assert len(items) == len(corpus["published"]) == 25


# ---------------------------------------------------------------------------------------------
# (b) normal use: published summaries, paginated, no embedding
# ---------------------------------------------------------------------------------------------
def test_b1_search_pages_published_summaries_by_cursor(client, corpus):
    items, sizes = walk(client, "/search", {"q": MARKER, "limit": 10}, CASE_SUMMARY_KEYS)
    assert sizes == [10, 10, 5]
    citations = [i["citation"] for i in items]
    assert len(citations) == len(set(citations)), "a row appeared on two pages"
    assert set(citations) == set(corpus["published"])
    assert not set(citations) & set(UNPUBLISHED_CASES)
    assert {i["id"] for i in items} == {str(v) for v in corpus["published"].values()}
    # Default limit (10, FINAL_2 :1156) and the staging / quarantine rows are never served.
    first, _ = page_of(client.get("/search", params={"q": MARKER}), CASE_SUMMARY_KEYS)
    assert len(first) == 10
    for q in ("Staged Party", "Quarantined Party", "Unpromoted Party", "Blocked Source", "Unknown Source", "No Source"):
        found, _ = page_of(client.get("/search", params={"q": q}), CASE_SUMMARY_KEYS)
        assert found == [], f"{q!r} matched {[i['citation'] for i in found]}"


def test_b2_like_metacharacters_in_the_query_match_literally(client, corpus):
    found, _ = page_of(client.get("/search", params={"q": "100%"}), CASE_SUMMARY_KEYS)
    assert [i["citation"] for i in found] == ["2099 CLC 301"], "'100%' must not match '1005 Holdings'"
    found, _ = page_of(client.get("/search", params={"q": "A_B Traders"}), CASE_SUMMARY_KEYS)
    assert [i["citation"] for i in found] == ["2099 CLC 303"], "'A_B' must not match 'AxB'"
    found, _ = page_of(client.get("/search", params={"q": "2099 CLC 30_"}), CASE_SUMMARY_KEYS)
    assert found == [], "'_' must not match any one character"


def test_b3_cursor_tamper_is_400_never_500(client, corpus):
    for cursor in ("not-a-cursor!!", "%%%", "x" * 129, "Y2w6bm90LWEtdXVpZA", "été"):
        res = client.get("/search", params={"q": MARKER, "cursor": cursor})
        assert res.status_code == 400, f"cursor {cursor!r}: {describe(res)}"
    # A statutes cursor is not a case-law cursor.
    _, statute_cursor = page_of(client.get("/statutes", params={"limit": 1}), STATUTE_SUMMARY_KEYS)
    assert statute_cursor
    assert client.get("/search", params={"q": MARKER, "cursor": statute_cursor}).status_code == 400


def test_b4_case_detail_serves_published_text_without_embedding(client, corpus):
    citation, case_id = next(iter(corpus["published"].items()))
    res = client.get(f"/cases/{case_id}")
    assert res.status_code == 200, describe(res)
    body = res.json()
    assert set(body) == CASE_DETAIL_KEYS, f"detail fields differ: {sorted(set(body) ^ CASE_DETAIL_KEYS)}"
    assert body["full_text"] == f"FULL-TEXT {citation}"
    assert body["citation"] == citation
    for citation, case_id in corpus["unpublished"].items():
        res = client.get(f"/cases/{case_id}")
        assert res.status_code == 404, f"unpublished {citation}: {describe(res)}"
    assert client.get(f"/cases/{uuid.uuid4()}").status_code == 404
    assert client.get("/cases/not-a-uuid").status_code == 422


def test_b5_statutes_serve_only_trusted_sections(client, corpus):
    items, sizes = walk(client, "/statutes", {"limit": 2}, STATUTE_SUMMARY_KEYS)
    assert sizes == [2, 1]
    assert {i["id"] for i in items} == {str(v) for v in corpus["statutes_published"].values()}
    filtered, _ = page_of(client.get("/statutes", params={"statute_name": "Synthetic Act"}), STATUTE_SUMMARY_KEYS)
    assert {i["id"] for i in filtered} == {str(v) for v in corpus["statutes_published"].values()}
    for params in ({"statute_name": "%"}, {"statute_name": "a"}, {"limit": 101}, {"limit": 0}):
        res = client.get("/statutes", params=params)
        assert res.status_code == 422, f"{params!r}: {describe(res)}"
    key, statute_id = next(iter(corpus["statutes_published"].items()))
    res = client.get(f"/statutes/{statute_id}")
    assert res.status_code == 200, describe(res)
    body = res.json()
    assert set(body) == STATUTE_DETAIL_KEYS, f"detail fields differ: {sorted(set(body) ^ STATUTE_DETAIL_KEYS)}"
    assert body["section_text"] == f"SECTION-TEXT {key}"
    for key, statute_id in corpus["statutes_unpublished"].items():
        res = client.get(f"/statutes/{statute_id}")
        assert res.status_code == 404, f"unpublished statute {key}: {describe(res)}"


# ---------------------------------------------------------------------------------------------
# (c) export: published only, capped, streamed
# ---------------------------------------------------------------------------------------------
def test_c_export_is_published_only_and_capped(client, corpus, monkeypatch):
    from scraper.config import settings

    headers = {"X-API-Key": settings.ADMIN_API_KEY}
    published = set(corpus["published"])

    configure(monkeypatch, EXPORT_MAX_ROWS=5, EXPORT_CHUNK_ROWS=10)
    res = client.get("/export/cases", params={"format": "jsonl"}, headers=headers)
    assert res.status_code == 200
    lines = [json.loads(line) for line in res.text.splitlines() if line.strip()]
    exported = [line["citation"] for line in lines]
    assert not set(exported) & set(UNPUBLISHED_CASES), f"unpublished rows exported: {sorted(set(exported) & set(UNPUBLISHED_CASES))}"
    assert len(exported) == 5, f"{len(exported)} rows exported past a cap of 5"
    assert set(exported) <= published
    assert res.headers.get("x-export-row-cap") == "5"
    assert res.headers.get("x-export-truncated") == "true"

    configure(monkeypatch, EXPORT_MAX_ROWS=1000, EXPORT_CHUNK_ROWS=10)
    res = client.get("/export/cases", params={"format": "jsonl"}, headers=headers)
    lines = [json.loads(line) for line in res.text.splitlines() if line.strip()]
    assert sorted(line["citation"] for line in lines) == sorted(published)
    assert all(set(line) == {"citation", "title"} for line in lines)
    assert res.headers.get("x-export-truncated") == "false"

    res = client.get("/export/cases", params={"format": "csv"}, headers=headers)
    assert res.status_code == 200
    rows = list(csv.reader(io.StringIO(res.text)))
    assert rows[0] == ["citation", "title", "court", "year"]
    assert sorted(r[0] for r in rows[1:]) == sorted(published)

    assert client.get("/export/cases", params={"format": "xml"}, headers=headers).status_code == 422
    assert client.get("/export/cases", params={"format": "csv"}).status_code == 401


# ---------------------------------------------------------------------------------------------
# (d) per-client quota
# ---------------------------------------------------------------------------------------------
def test_d_rate_limit_returns_429_after_the_quota(client, corpus, monkeypatch):
    from fastapi.testclient import TestClient

    from scraper.main import app

    configure(monkeypatch, PUBLIC_RATE_LIMIT_REQUESTS=3, PUBLIC_RATE_LIMIT_WINDOW_SECONDS=3600)
    statuses = [client.get("/search", params={"q": MARKER, "limit": 1}).status_code for _ in range(3)]
    assert statuses == [200, 200, 200]
    res = client.get("/search", params={"q": MARKER, "limit": 1})
    assert res.status_code == 429, f"request 4 of a quota of 3 was served: {describe(res)}"
    assert int(res.headers["retry-after"]) >= 1
    assert MARKER not in res.text
    # Every public route shares the quota; an invalid request spends a token too.
    assert client.get("/statutes").status_code == 429
    assert client.get(f"/cases/{uuid.uuid4()}").status_code == 429
    # Another client address has its own bucket.
    other = TestClient(app, raise_server_exceptions=False, client=("203.0.113.7", 50000))
    assert other.get("/search", params={"q": MARKER, "limit": 1}).status_code == 200


# ---------------------------------------------------------------------------------------------
# (e) per-request statement timeout
# ---------------------------------------------------------------------------------------------
def test_e_statement_timeout_cancels_a_slow_query(client, corpus, corpus_db, monkeypatch):
    """Another session holds ACCESS EXCLUSIVE on case_law_master, so the search's SELECT waits.
    statement_timeout counts that wait: with a 300 ms timeout the request must come back 503
    while the lock is still held, and its statement must no longer be waiting on the lock."""
    import asyncpg
    from sqlalchemy.engine import make_url

    configure(monkeypatch, PUBLIC_QUERY_TIMEOUT_MS=300)
    plain_url = make_url(corpus_db.url).set(drivername="postgresql").render_as_string(hide_password=False)
    locked, checked = threading.Event(), threading.Event()
    seen = {}

    def hold_lock():
        async def go():
            conn = await asyncpg.connect(plain_url)
            try:
                tx = conn.transaction()
                await tx.start()
                await conn.execute("LOCK TABLE case_law_master IN ACCESS EXCLUSIVE MODE")
                locked.set()
                deadline = time.monotonic() + 8.0  # main: the request waits this long, then succeeds
                while not checked.is_set() and time.monotonic() < deadline:
                    await asyncio.sleep(0.05)
                seen["waiting"] = await conn.fetchval(
                    "SELECT count(*) FROM pg_locks WHERE relation = 'case_law_master'::regclass AND NOT granted"
                )
                seen["released_at"] = time.monotonic()
                await tx.rollback()
            finally:
                await conn.close()

        asyncio.run(go())

    holder = threading.Thread(target=hold_lock, daemon=True)
    holder.start()
    assert locked.wait(10), "could not take the table lock"
    started = time.monotonic()
    res = client.get("/search", params={"q": MARKER, "limit": 5})
    finished = time.monotonic()
    checked.set()
    holder.join(15)
    elapsed = finished - started
    assert res.status_code == 503, f"slow query not cancelled: {describe(res)} after {elapsed:.2f}s"
    assert finished < seen["released_at"], "the response only came back after the lock was released"
    assert elapsed < 5, f"the timeout fired after {elapsed:.2f}s"
    assert seen["waiting"] == 0, "the cancelled statement is still waiting on the lock"
    assert res.headers.get("retry-after") == "1"
    assert MARKER not in res.text
    # The timeout is transaction-local: the next request runs normally.
    items, _ = page_of(client.get("/search", params={"q": MARKER, "limit": 5}), CASE_SUMMARY_KEYS)
    assert len(items) == 5
