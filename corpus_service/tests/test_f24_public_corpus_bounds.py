"""Audit F24 unit tests: no database.

Spec: docs/superpowers/specs/2026-10-18-f24-bounded-public-corpus-queries-design.md (rulings 2-7).
The route-level checks here send only requests that must be refused before any database work, so
they pass without CORPUS_TEST_DATABASE_URL; a regression that opened a session before validating
would surface as a connection error instead of the expected 4xx.
"""

import base64
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects.postgresql import asyncpg as pg_asyncpg

from scraper import public_corpus as pc
from scraper import rate_limit
from scraper.config import settings
from scraper.main import app

CASE_SUMMARY_FIELDS = {
    "id", "citation", "case_title", "court", "year", "reporter", "decision_date", "bench_type",
    "case_type", "is_overruled", "is_landmark",
}
CASE_DETAIL_EXTRA = {"judge_names", "petitioner", "respondent", "overruled_by", "summary", "headnotes", "full_text"}
STATUTE_SUMMARY_FIELDS = {
    "id", "statute_name", "short_name", "section_number", "section_title", "chapter", "year_enacted",
    "is_repealed",
}
STATUTE_DETAIL_EXTRA = {"section_text", "effective_date", "repealed_by"}
TEXT_OR_VECTOR = {"embedding", "full_text", "full_text_urdu", "summary", "headnotes", "facts", "holding",
                  "ratio_decidendi", "section_text", "section_text_urdu", "search_text"}
NEVER_PUBLIC = {"embedding", "search_text", "validation_errors", "confidence_score", "view_count",
                "source_site", "source_url", "source_file_path"}


@pytest.fixture(autouse=True)
def _fresh_rate_limiter():
    rate_limit.public_limiter.reset()
    yield
    rate_limit.public_limiter.reset()


@pytest.fixture
def client():
    return TestClient(app, raise_server_exceptions=False)


def compiled(stmt):
    """The SQL as the production driver (asyncpg) would receive it, with values inlined."""
    return str(stmt.compile(dialect=pg_asyncpg.dialect(), compile_kwargs={"literal_binds": True}))


# ---------------------------------------------------------------------------------------------
# ruling 3: LIKE escaping and query text bounds
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "raw, escaped",
    [
        ("%", "\\%"),
        ("_", "\\_"),
        ("\\", "\\\\"),
        ("100%", "100\\%"),
        ("A_B", "A\\_B"),
        ("a%b_c\\d", "a\\%b\\_c\\\\d"),
        ("\\%", "\\\\\\%"),  # an escape followed by a wildcard: both stay literal
        ("plain text", "plain text"),
    ],
)
def test_escape_like_escapes_every_metacharacter(raw, escaped):
    assert pc.escape_like(raw) == escaped


def test_like_contains_wraps_the_escaped_text():
    assert pc.like_contains("100%") == "%100\\%%"
    assert pc.LIKE_ESCAPE == "\\"


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("ab", "ab"),
        ("  ab  ", "ab"),
        ("a" * 200, "a" * 200),
        ("  " + "a" * 200 + "  ", "a" * 200),
        ("100%", "100%"),
        ("%ab", "%ab"),
        ("قانون", "قانون"),
    ],
)
def test_query_text_within_bounds_is_trimmed(raw, expected):
    assert pc.normalise_query_text(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "", "a", "   ", "  a  ", "a" * 201,
        "%", "%%", "_", "__", "\\\\", " % _ ", "%_\\",
        "ab\x00", "a\tb", "a\nb", "ab\u0085", "\x7fab",
    ],
)
def test_query_text_outside_bounds_is_refused(raw):
    with pytest.raises(pc.QueryTextError):
        pc.normalise_query_text(raw)


# ---------------------------------------------------------------------------------------------
# ruling 2: limit bounds, checked before any database work
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("limit", ["0", "-1", "101", "1000000000", "abc", "1.5"])
def test_search_limit_out_of_range_is_422(client, limit):
    res = client.get("/search", params={"q": "ab", "limit": limit})
    assert res.status_code == 422, res.text


@pytest.mark.parametrize("limit", ["0", "101", "1000000000"])
def test_statutes_limit_out_of_range_is_422(client, limit):
    assert client.get("/statutes", params={"limit": limit}).status_code == 422


@pytest.mark.parametrize("q", ["%", "_", "%%", "a", "a" * 201, "ab\x00"])
def test_invalid_query_text_is_422_without_touching_the_database(client, q):
    res = client.get("/search", params={"q": q})
    assert res.status_code == 422, res.text
    assert q not in res.text or len(q) < 2  # the fixed message does not echo the input


def test_missing_q_is_422(client):
    assert client.get("/search").status_code == 422


def test_invalid_statute_name_is_422(client):
    assert client.get("/statutes", params={"statute_name": "%"}).status_code == 422


def test_malformed_detail_ids_are_422(client):
    assert client.get("/cases/not-a-uuid").status_code == 422
    assert client.get("/statutes/not-a-uuid").status_code == 422


# ---------------------------------------------------------------------------------------------
# ruling 5: cursor codec and tamper
# ---------------------------------------------------------------------------------------------
def test_cursor_round_trip_per_kind():
    value = uuid.uuid4()
    for kind in (pc.CASE_CURSOR, pc.STATUTE_CURSOR):
        token = pc.encode_cursor(kind, value)
        assert len(token) <= pc.MAX_CURSOR_CHARS
        assert "=" not in token
        assert pc.decode_cursor(kind, token) == value


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


@pytest.mark.parametrize(
    "token",
    [
        "",
        "not-a-cursor!!",
        "%%%",
        "x" * 129,
        "été",
        _b64(b"cl:not-a-uuid"),
        _b64(b"st:" + str(uuid.uuid4()).encode()),  # another kind
        _b64(b"cl" + str(uuid.uuid4()).encode()),  # no separator
        _b64(b"cl:" + str(uuid.uuid4()).encode() + b":extra"),
        _b64("cl:é".encode("utf-8")),  # not ASCII after decoding
        _b64(b"\xff\xfe\xfd"),
        "a",  # impossible base64 length
    ],
)
def test_tampered_cursor_is_refused(token):
    with pytest.raises(pc.CursorError):
        pc.decode_cursor(pc.CASE_CURSOR, token)


@pytest.mark.parametrize("token", ["not-a-cursor!!", "x" * 129, _b64(b"cl:not-a-uuid"), "a"])
def test_tampered_cursor_is_400_never_500(client, token):
    res = client.get("/search", params={"q": "ab", "cursor": token})
    assert res.status_code == 400, res.text
    res = client.get("/statutes", params={"cursor": token})
    assert res.status_code == 400, res.text


# ---------------------------------------------------------------------------------------------
# ruling 4: DTOs and the SQL they come from
# ---------------------------------------------------------------------------------------------
def test_dto_field_sets():
    assert set(pc.CaseSummary.model_fields) == CASE_SUMMARY_FIELDS
    assert set(pc.CaseDetail.model_fields) == CASE_SUMMARY_FIELDS | CASE_DETAIL_EXTRA
    assert set(pc.StatuteSummary.model_fields) == STATUTE_SUMMARY_FIELDS
    assert set(pc.StatuteDetail.model_fields) == STATUTE_SUMMARY_FIELDS | STATUTE_DETAIL_EXTRA
    for model in (pc.CaseSummary, pc.StatuteSummary):
        assert not set(model.model_fields) & TEXT_OR_VECTOR, model
    for model in (pc.CaseSummary, pc.CaseDetail, pc.StatuteSummary, pc.StatuteDetail):
        assert not set(model.model_fields) & NEVER_PUBLIC, model
    assert set(pc.CasePage.model_fields) == {"items", "next_cursor"}
    assert set(pc.StatutePage.model_fields) == {"items", "next_cursor"}


def test_column_lists_match_the_dtos():
    assert [c.key for c in pc.CASE_SUMMARY_COLUMNS] == list(pc.CaseSummary.model_fields)
    assert [c.key for c in pc.CASE_DETAIL_COLUMNS] == list(pc.CaseDetail.model_fields)
    assert [c.key for c in pc.STATUTE_SUMMARY_COLUMNS] == list(pc.StatuteSummary.model_fields)
    assert [c.key for c in pc.STATUTE_DETAIL_COLUMNS] == list(pc.StatuteDetail.model_fields)


def _selected(stmt):
    return {c.key for c in stmt.selected_columns}


def test_list_sql_reads_no_text_or_vector_column():
    after = uuid.uuid4()
    for stmt, fields in (
        (pc.search_cases_stmt("ab", None, 10), CASE_SUMMARY_FIELDS),
        (pc.search_cases_stmt("ab", after, 10), CASE_SUMMARY_FIELDS),
        (pc.list_statutes_stmt(None, None, 10), STATUTE_SUMMARY_FIELDS),
        (pc.list_statutes_stmt("ab", after, 10), STATUTE_SUMMARY_FIELDS),
    ):
        assert _selected(stmt) == fields
        sql = compiled(stmt)
        for column in TEXT_OR_VECTOR:
            assert f".{column}" not in sql and f" {column}," not in sql, (column, sql)
        assert "LIMIT 11" in sql  # limit + 1 decides next_cursor
        assert "ORDER BY" in sql and ".id" in sql.split("ORDER BY", 1)[1]


def test_detail_sql_reads_text_but_never_the_embedding():
    case_sql = compiled(pc.case_detail_stmt(uuid.uuid4()))
    statute_sql = compiled(pc.statute_detail_stmt(uuid.uuid4()))
    assert "full_text" in case_sql and "section_text" in statute_sql
    for sql in (case_sql, statute_sql):
        assert "embedding" not in sql


def test_search_sql_escapes_and_filters_published():
    sql = compiled(pc.search_cases_stmt("100%", None, 10))
    assert sql.count("ILIKE '%100\\%%' ESCAPE '\\'") == 2, sql  # citation and title
    # As sent to asyncpg, the pattern is a bind parameter, never spliced into the SQL text.
    bound = str(pc.search_cases_stmt("100%", None, 10).compile(dialect=pg_asyncpg.dialect()))
    assert "ILIKE $1::VARCHAR ESCAPE '\\'" in bound and "100" not in bound, bound
    assert "is_promoted IS true" in sql
    assert "trust_level IN ('trusted', 'review')" in sql
    statute_sql = compiled(pc.list_statutes_stmt("ab", None, 10))
    assert "trust_level IN ('trusted')" in statute_sql
    assert "'review'" not in statute_sql


def test_published_trust_sets_come_from_the_trust_vocabulary():
    assert pc.CASE_LAW_PUBLISHED_TRUST == ("trusted", "review")
    assert pc.STATUTE_PUBLISHED_TRUST == ("trusted",)


def test_export_sql_is_published_capped_and_summary_only():
    sql = compiled(pc.export_cases_stmt(7))
    assert "is_promoted IS true" in sql and "LIMIT 7" in sql
    assert "full_text" not in sql and "embedding" not in sql
    probe = compiled(pc.export_truncation_probe(7))
    assert "OFFSET 7" in probe and "LIMIT 1" in probe and "is_promoted IS true" in probe


# ---------------------------------------------------------------------------------------------
# ruling 6: statement timeout classification
# ---------------------------------------------------------------------------------------------
class _Driver(Exception):
    def __init__(self, sqlstate):
        super().__init__("driver")
        self.sqlstate = sqlstate


class _Wrapped(Exception):
    def __init__(self, orig):
        super().__init__("wrapped")
        self.orig = orig


def test_statement_timeout_is_recognised_by_sqlstate():
    assert pc.is_statement_timeout(_Wrapped(_Driver("57014")))
    assert pc.is_statement_timeout(_Driver("57014"))
    assert not pc.is_statement_timeout(_Wrapped(_Driver("40001")))
    assert not pc.is_statement_timeout(RuntimeError("57014"))


# ---------------------------------------------------------------------------------------------
# ruling 7: token bucket
# ---------------------------------------------------------------------------------------------
class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def test_bucket_allows_capacity_then_refuses_with_retry_after():
    clock = FakeClock()
    limiter = rate_limit.TokenBucketLimiter(clock=clock)
    results = [limiter.acquire("a", capacity=3, window_seconds=60, max_keys=10) for _ in range(4)]
    assert [allowed for allowed, _ in results] == [True, True, True, False]
    assert results[3][1] == 20  # one token every 60 / 3 seconds
    clock.now += 19.0
    allowed, retry_after = limiter.acquire("a", capacity=3, window_seconds=60, max_keys=10)
    assert not allowed and retry_after == 1
    clock.now += 1.0
    assert limiter.acquire("a", capacity=3, window_seconds=60, max_keys=10) == (True, 0)


def test_bucket_refill_is_capped_at_capacity():
    clock = FakeClock()
    limiter = rate_limit.TokenBucketLimiter(clock=clock)
    limiter.acquire("a", capacity=2, window_seconds=10, max_keys=10)
    clock.now += 10_000
    results = [limiter.acquire("a", capacity=2, window_seconds=10, max_keys=10)[0] for _ in range(3)]
    assert results == [True, True, False]


def test_buckets_are_per_key_and_the_table_is_bounded():
    clock = FakeClock()
    limiter = rate_limit.TokenBucketLimiter(clock=clock)
    assert limiter.acquire("a", capacity=1, window_seconds=60, max_keys=2)[0]
    assert not limiter.acquire("a", capacity=1, window_seconds=60, max_keys=2)[0]
    assert limiter.acquire("b", capacity=1, window_seconds=60, max_keys=2)[0]
    assert limiter.acquire("c", capacity=1, window_seconds=60, max_keys=2)[0]
    assert len(limiter) == 2  # "a", the least recently used, was evicted
    limiter.reset()
    assert len(limiter) == 0


def test_public_routes_answer_429_with_retry_after(client, monkeypatch):
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_REQUESTS", 2)
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_WINDOW_SECONDS", 3600)
    # Invalid requests (refused before any database work) spend tokens too.
    assert client.get("/search", params={"q": "ab", "limit": 0}).status_code == 422
    assert client.get("/statutes", params={"limit": 0}).status_code == 422
    res = client.get("/search", params={"q": "ab", "limit": 0})
    assert res.status_code == 429
    assert int(res.headers["retry-after"]) >= 1
    assert client.get("/cases/not-a-uuid").status_code == 429
    other = TestClient(app, raise_server_exceptions=False, client=("198.51.100.9", 50000))
    assert other.get("/search", params={"q": "ab", "limit": 0}).status_code == 422


def test_settings_defaults_and_bounds():
    from pydantic import ValidationError

    from scraper.config import Settings

    fields = Settings.model_fields
    assert fields["PUBLIC_QUERY_TIMEOUT_MS"].default == 3000
    assert fields["PUBLIC_RATE_LIMIT_REQUESTS"].default == 60
    assert fields["PUBLIC_RATE_LIMIT_WINDOW_SECONDS"].default == 60
    assert fields["PUBLIC_RATE_LIMIT_MAX_CLIENTS"].default == 10_000
    assert fields["EXPORT_MAX_ROWS"].default == 50_000
    assert fields["EXPORT_CHUNK_ROWS"].default == 500
    assert fields["EXPORT_QUERY_TIMEOUT_MS"].default == 60_000
    with pytest.raises(ValidationError):
        Settings(_env_file=None, PUBLIC_QUERY_TIMEOUT_MS=0)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, EXPORT_MAX_ROWS=0)
