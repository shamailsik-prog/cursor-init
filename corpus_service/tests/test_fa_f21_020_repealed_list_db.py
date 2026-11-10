"""FA-F21-020 on a disposable Postgres database. No live or staging DSN is read.

``GET /statutes`` used to return repealed published sections in id order, so a page
and a full walk counted them as current law. The default list now omits them. The
repeal predicate is applied with the trust and name filters, before the keyset
limit, so page size and the walked total match the filtered rows.

``include_repealed=true`` puts them back. ``GET /statutes/{id}`` still returns a
repealed published section, and the row stays in ``statutes_master``. Migrations
run only against the fixture database this test creates.

On the unfixed list the default walk includes the repealed ids, the first page of
two is the current row and the repealed row that follows it, and a lax flag is
ignored instead of 422.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import text

STATUTE_SOURCE = "PakistanCode"
REVIEW_SOURCE = "NasirLawSite"
BLOCKED_SOURCE = "F21BlockedSource"
CURRENT_ACT = "F21 Current Act 2099"
OTHER_ACT = "F21 Other Act 2099"
REPEALED_BY = "F21 Fixture Repeal 2099"
SUMMARY_KEYS = {
    "id", "statute_name", "short_name", "section_number", "section_title", "chapter", "year_enacted",
    "is_repealed",
}
DETAIL_KEYS = SUMMARY_KEYS | {"section_text", "effective_date", "repealed_by"}

# Id order is the byte order of these UUIDs. Repealed rows sit between current ones.
C1 = uuid.UUID("00000000-0000-4000-8000-000000000001")
R1 = uuid.UUID("00000000-0000-4000-8000-000000000002")
C2 = uuid.UUID("00000000-0000-4000-8000-000000000003")
R2 = uuid.UUID("00000000-0000-4000-8000-000000000004")
C3 = uuid.UUID("00000000-0000-4000-8000-000000000005")
R3 = uuid.UUID("00000000-0000-4000-8000-000000000006")
C4 = uuid.UUID("00000000-0000-4000-8000-000000000007")
R_OTHER = uuid.UUID("00000000-0000-4000-8000-000000000008")
R_REVIEW = uuid.UUID("00000000-0000-4000-8000-000000000009")
C_BLOCKED = uuid.UUID("00000000-0000-4000-8000-00000000000a")

CURRENT_IDS = (C1, C2, C3, C4)
# Id order, which is the only order the list returns.
PUBLISHED_IDS = (C1, R1, C2, R2, C3, R3, C4, R_OTHER)
SAME_ACT_IDS = (C1, R1, C2, R2, C3, R3, C4)
STORED_IDS = PUBLISHED_IDS + (R_REVIEW, C_BLOCKED)


def _db_exec(corpus_db, sql, rows=None):
    async def go():
        eng = corpus_db.engine_for(corpus_db.url)
        try:
            async with eng.begin() as conn:
                await conn.execute(text(sql), rows if rows is not None else {})
        finally:
            await eng.dispose()

    asyncio.run(go())


def _db_fetch(corpus_db, sql, rows=None):
    async def go():
        eng = corpus_db.engine_for(corpus_db.url)
        try:
            async with eng.connect() as conn:
                result = await conn.execute(text(sql), rows if rows is not None else {})
                return result.fetchall()
        finally:
            await eng.dispose()

    return asyncio.run(go())


def _row(statute_id, name, short, section, site, repealed):
    return {
        "id": statute_id,
        "name": name,
        "short": short,
        "section": section,
        "title": f"Section {section}",
        "body": f"SECTION-TEXT {statute_id}",
        "site": site,
        "repealed": repealed,
        "repealed_by": REPEALED_BY if repealed else None,
    }


def seed(corpus_db):
    proc = corpus_db.migrate()
    assert proc.returncode == 0, f"migrate failed:\n{proc.stdout[-2000:]}\n{proc.stderr[-4000:]}"
    _db_exec(
        corpus_db,
        "INSERT INTO scraper_sources (source_name, source_url, trust_level) "
        "VALUES (:n, 'https://blocked.invalid', 'blocked')",
        {"n": BLOCKED_SOURCE},
    )
    rows = [
        _row(C1, CURRENT_ACT, "F21CUR", "1", STATUTE_SOURCE, False),
        _row(R1, CURRENT_ACT, "F21CUR", "2", STATUTE_SOURCE, True),
        _row(C2, CURRENT_ACT, "F21CUR", "3", STATUTE_SOURCE, False),
        _row(R2, CURRENT_ACT, "F21CUR", "4", STATUTE_SOURCE, True),
        _row(C3, CURRENT_ACT, "F21CUR", "5", STATUTE_SOURCE, False),
        _row(R3, CURRENT_ACT, "F21CUR", "6", STATUTE_SOURCE, True),
        _row(C4, CURRENT_ACT, "F21CUR", "7", STATUTE_SOURCE, False),
        _row(R_OTHER, OTHER_ACT, "F21OLD", "1", STATUTE_SOURCE, True),
        _row(R_REVIEW, CURRENT_ACT, "F21REV", "1", REVIEW_SOURCE, True),
        _row(C_BLOCKED, CURRENT_ACT, "F21BLK", "1", BLOCKED_SOURCE, False),
    ]
    _db_exec(
        corpus_db,
        "INSERT INTO statutes_master (id, statute_name, short_name, section_number, section_title, "
        "section_text, year_enacted, source_site, is_repealed, repealed_by) "
        "VALUES (:id, :name, :short, :section, :title, :body, 2099, :site, :repealed, :repealed_by)",
        rows,
    )


def stored_count(corpus_db) -> int:
    return _db_fetch(corpus_db, "SELECT count(*) FROM statutes_master")[0][0]


def stored_text(corpus_db, statute_id) -> str:
    return _db_fetch(
        corpus_db,
        "SELECT section_text FROM statutes_master WHERE id = :id",
        {"id": statute_id},
    )[0][0]


@pytest.fixture(autouse=True)
def _fresh_rate_limiter():
    from scraper import rate_limit

    rate_limit.public_limiter.reset()
    yield
    rate_limit.public_limiter.reset()


@pytest.fixture
def corpus(corpus_db):
    seed(corpus_db)
    with corpus_db.app_engine_as(*corpus_db.runtime_role(corpus_writer="none")):
        yield corpus_db


@pytest.fixture
def client(corpus):
    from fastapi.testclient import TestClient

    from scraper.main import app

    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def page_of(res):
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body) == {"items", "next_cursor"}, body
    for item in body["items"]:
        assert set(item) == SUMMARY_KEYS, sorted(set(item) ^ SUMMARY_KEYS)
    return body["items"], body["next_cursor"]


def walk(client, params):
    items, sizes, cursor = [], [], None
    for _ in range(20):
        query = dict(params)
        if cursor:
            query["cursor"] = cursor
        batch, cursor = page_of(client.get("/statutes", params=query))
        assert batch or cursor is None
        items.extend(batch)
        sizes.append(len(batch))
        if cursor is None:
            if sizes[-1] == 0:
                sizes.pop()
            return items, sizes
    raise AssertionError("pagination did not terminate")


def assert_full_pages(sizes, limit, total):
    assert sum(sizes) == total, sizes
    assert sizes, sizes
    assert all(size == limit for size in sizes[:-1]), sizes
    assert 1 <= sizes[-1] <= limit, sizes


def test_default_list_pages_only_current_law(client, corpus):
    assert stored_count(corpus) == len(STORED_IDS)
    first, cursor = page_of(client.get("/statutes", params={"limit": "2"}))
    assert [item["id"] for item in first] == [str(C1), str(C2)]
    assert all(item["is_repealed"] is False for item in first)
    assert cursor

    second, cursor = page_of(client.get("/statutes", params={"limit": "2", "cursor": cursor}))
    assert [item["id"] for item in second] == [str(C3), str(C4)]
    assert cursor is None

    explicit, _ = page_of(client.get("/statutes", params={"limit": "2", "include_repealed": "false"}))
    assert [item["id"] for item in explicit] == [str(C1), str(C2)]

    named, sizes = walk(client, {"limit": "2", "statute_name": "Current Act"})
    assert [item["id"] for item in named] == [str(i) for i in CURRENT_IDS]
    assert_full_pages(sizes, 2, len(CURRENT_IDS))
    assert stored_count(corpus) == len(STORED_IDS)


def test_include_repealed_opts_in_and_the_walk_matches_that_filter(client, corpus):
    first, _ = page_of(client.get("/statutes", params={"limit": "2", "include_repealed": "true"}))
    assert [item["id"] for item in first] == [str(C1), str(R1)]
    assert first[0]["is_repealed"] is False
    assert first[1]["is_repealed"] is True

    items, sizes = walk(client, {"limit": "2", "include_repealed": "true"})
    assert [uuid.UUID(item["id"]) for item in items] == list(PUBLISHED_IDS)
    assert_full_pages(sizes, 2, len(PUBLISHED_IDS))
    assert str(R_REVIEW) not in {item["id"] for item in items}
    assert str(C_BLOCKED) not in {item["id"] for item in items}

    named, sizes = walk(client, {"limit": "2", "include_repealed": "true", "statute_name": "Current Act"})
    assert [uuid.UUID(item["id"]) for item in named] == list(SAME_ACT_IDS)
    assert_full_pages(sizes, 2, len(SAME_ACT_IDS))
    assert all(item["statute_name"] == CURRENT_ACT for item in named)

    other, _ = page_of(client.get(
        "/statutes", params={"limit": "10", "include_repealed": "true", "statute_name": "Other Act"},
    ))
    assert [item["id"] for item in other] == [str(R_OTHER)]
    hidden, _ = page_of(client.get("/statutes", params={"limit": "10", "statute_name": "Other Act"}))
    assert hidden == []


def test_repealed_section_stays_readable_by_id_and_is_not_deleted(client, corpus):
    res = client.get(f"/statutes/{R1}")
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body) == DETAIL_KEYS
    assert body["is_repealed"] is True
    assert body["section_text"] == f"SECTION-TEXT {R1}"
    assert body["repealed_by"] == REPEALED_BY
    assert body["statute_name"] == CURRENT_ACT

    current = client.get(f"/statutes/{C1}")
    assert current.status_code == 200, current.text
    assert current.json()["is_repealed"] is False
    assert current.json()["section_text"] == f"SECTION-TEXT {C1}"

    assert client.get(f"/statutes/{R_REVIEW}").status_code == 404
    assert client.get(f"/statutes/{C_BLOCKED}").status_code == 404
    assert client.get(f"/statutes/{uuid.uuid4()}").status_code == 404

    assert stored_count(corpus) == len(STORED_IDS)
    assert stored_text(corpus, R1) == f"SECTION-TEXT {R1}"
    assert stored_text(corpus, R_REVIEW) == f"SECTION-TEXT {R_REVIEW}"


@pytest.mark.parametrize("flag", ["yes", "1", "TRUE", " true", ""])
def test_lax_include_repealed_is_422_and_returns_no_rows(client, corpus, flag):
    res = client.get("/statutes", params={"include_repealed": flag, "limit": "10"})
    assert res.status_code == 422, res.text
    assert "F21" not in res.text
    assert stored_count(corpus) == len(STORED_IDS)
