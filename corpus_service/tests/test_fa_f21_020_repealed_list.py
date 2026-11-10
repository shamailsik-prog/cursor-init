"""FA-F21-020: the public statute list omits repealed sections unless asked.

No database. The default statement must carry ``is_repealed IS false`` in its WHERE
(before ORDER BY and LIMIT). ``include_repealed=true`` must not add that predicate.
``statute_detail`` must not gain it: a repealed published section stays readable by id.

On the unfixed list these assertions fail because the WHERE has no repeal predicate
and ``include_repealed`` is not a parameter. A value other than the exact words
``true`` and ``false`` is 422 before any database work.
"""

from __future__ import annotations

import inspect
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects.postgresql import asyncpg as pg_asyncpg

from scraper import public_corpus as pc
from scraper import rate_limit
from scraper.main import app


def compiled(stmt) -> str:
    return str(stmt.compile(dialect=pg_asyncpg.dialect(), compile_kwargs={"literal_binds": True}))


def where_clause(sql: str) -> str:
    """The WHERE text. SQLAlchemy breaks the statement across lines, so the keyword
    is not always preceded by a space."""
    upper = sql.upper()
    start = upper.index("WHERE")
    end = len(sql)
    for marker in ("ORDER BY", "LIMIT"):
        at = upper.find(marker, start)
        if at != -1:
            end = min(end, at)
    return sql[start:end]


def statutes_stmt(*args, **kwargs):
    try:
        return pc.list_statutes_stmt(*args, **kwargs)
    except TypeError as exc:
        pytest.fail(f"list_statutes_stmt does not accept include_repealed ({exc})")


@pytest.fixture(autouse=True)
def _fresh_rate_limiter():
    rate_limit.public_limiter.reset()
    yield
    rate_limit.public_limiter.reset()


@pytest.fixture
def client():
    return TestClient(app, raise_server_exceptions=False)


def test_default_list_sql_excludes_repealed_before_the_page_limit():
    sql = compiled(pc.list_statutes_stmt(None, None, 10))
    where = where_clause(sql)
    assert "is_repealed IS false" in where, where
    assert "IS NOT false" not in where
    assert "LIMIT 11" in sql
    assert "is_repealed" in sql.split("FROM", 1)[0]


def test_explicit_false_matches_the_default_and_keeps_name_and_cursor():
    after = uuid.UUID("00000000-0000-4000-8000-000000000010")
    sql = compiled(statutes_stmt("ab", after, 10, include_repealed=False))
    where = where_clause(sql)
    assert "is_repealed IS false" in where, where
    assert "ILIKE" in where and "ESCAPE" in where
    assert str(after) in where
    assert "LIMIT 11" in sql
    assert "trust_level IN ('trusted')" in where


def test_include_repealed_true_does_not_filter_history():
    after = uuid.UUID("00000000-0000-4000-8000-000000000010")
    sql = compiled(statutes_stmt("Current Act", after, 2, include_repealed=True))
    where = where_clause(sql)
    assert "is_repealed" not in where, where
    assert "ILIKE" in where
    assert str(after) in where
    assert "LIMIT 3" in sql
    assert "trust_level IN ('trusted')" in where


def test_list_statutes_defaults_include_repealed_to_false():
    params = inspect.signature(pc.list_statutes).parameters
    assert "include_repealed" in params, "list_statutes has no include_repealed parameter"
    param = params["include_repealed"]
    assert param.default is False
    assert param.kind is inspect.Parameter.KEYWORD_ONLY


def test_statute_detail_sql_does_not_hide_repealed_rows():
    sql = compiled(pc.statute_detail_stmt(uuid.uuid4()))
    where = where_clause(sql)
    assert "is_repealed" not in where, where
    assert "section_text" in sql
    assert "trust_level IN ('trusted')" in where


@pytest.mark.parametrize("flag", ["yes", "1", "TRUE", "True", " true", "false ", "on", ""])
def test_include_repealed_rejects_anything_but_exact_true_or_false(client, flag):
    res = client.get("/statutes", params={"include_repealed": flag, "limit": "1"})
    assert res.status_code == 422, res.text
    assert "items" not in res.text
