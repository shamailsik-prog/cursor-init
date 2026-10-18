"""Audit F24 re-audit round (FAIL 7/10): unit tests, no database.

Spec: docs/superpowers/specs/2026-10-18-f24-bounded-public-corpus-queries-design.md, section
"Re-audit round (FAIL 7/10)". Each test names the finding it covers (R1a-R1d, L1-L4, strict
limit, the extra routes, M02/M39). Requests that reach the database stage meet a fake session
factory (``FakeSessions``) instead of Postgres, so these tests need no CORPUS_TEST_DATABASE_URL.
"""

import ast
import asyncio
import inspect
import logging
import pathlib
import threading

import uuid

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import Select
from sqlalchemy import exc as sa_exc
from sqlalchemy.dialects.postgresql import asyncpg as pg_asyncpg

from scraper import database
from scraper import public_corpus as pc
from scraper import rate_limit
from scraper.config import settings
from scraper.main import app

SCRAPER = pathlib.Path(__file__).resolve().parents[1] / "scraper"
CORPUS_SERVICE = SCRAPER.parent


@pytest.fixture(autouse=True)
def _fresh_rate_limiter():
    rate_limit.public_limiter.reset()
    yield
    rate_limit.public_limiter.reset()


def client_at(host):
    """A client whose peer address (scope["client"]) is ``host``: what the app sees for a direct
    peer, or for the forwarded address once uvicorn's ProxyHeadersMiddleware has trusted a proxy."""
    return TestClient(app, raise_server_exceptions=False, client=(host, 50000))


def acquire(limiter, key, **kw):
    return limiter.acquire(key, **{"capacity": 1, "window_seconds": 3600, "max_keys": 100, **kw})[0]


class FrozenClock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


class FakeResult:
    def all(self):
        return []


class FakeSessions:
    """Stands in for database.SessionLocal. ``mode``: "empty" answers every statement with no rows;
    "raise" raises ``error`` when the session first touches the database (connection checkout
    happens there); "raise_on_query" raises ``error`` on the route's SELECT only, after the
    transaction setup; "block" holds every session's first touch until ``release`` is set."""

    def __init__(self, mode="empty", error=None):
        self.mode, self.error = mode, error
        self.statements = 0
        self.started = threading.Event()
        self.release = threading.Event()

    def __call__(self):
        return _FakeSession(self)


class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeSession:
    def __init__(self, owner):
        self.owner = owner

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def begin(self):
        return _FakeTransaction()

    async def connection(self):
        await self._touch()

    async def _touch(self):
        owner = self.owner
        owner.statements += 1
        if owner.mode == "raise":
            raise owner.error
        if owner.mode == "block":
            owner.started.set()
            while not owner.release.is_set():
                await asyncio.sleep(0.01)

    async def execute(self, stmt, *args, **kwargs):
        await self._touch()
        if self.owner.mode == "raise_on_query" and isinstance(stmt, Select):
            raise self.owner.error
        return FakeResult()


@pytest.fixture
def fake_sessions(monkeypatch):
    def install(**kw):
        fake = FakeSessions(**kw)
        monkeypatch.setattr(database, "SessionLocal", fake)
        return fake

    return install


# ---------------------------------------------------------------------------------------------
# R1(a): the quota key is the client's /64 (IPv6) or /32 (IPv4)
# ---------------------------------------------------------------------------------------------
def test_r1a_client_key_groups_ipv6_by_64_and_ipv4_by_32():
    key = rate_limit.client_key
    assert key("2001:db8:1:2::1") == key("2001:db8:1:2:ffff:ffff:ffff:ffff") == key("2001:DB8:1:2:0:0:0:abcd")
    assert key("2001:db8:1:2::1") == "2001:db8:1:2::/64"
    assert key("2001:db8:1:2::1") != key("2001:db8:1:3::1")
    assert key("198.51.100.7") == "198.51.100.7/32"
    assert key("198.51.100.7") != key("198.51.100.8")
    # IPv4-mapped IPv6 is the IPv4 client.
    assert key("::ffff:198.51.100.7") == key("198.51.100.7")
    assert key("::ffff:c633:6407") == key("198.51.100.7")
    # A zone index does not make a new client.
    assert key("fe80::1%eth0") == key("fe80::2%eth1") == "fe80::/64"


def test_r1a_non_ip_peers_share_one_key():
    """A peer value that is not an IP address (a test client name, a unix socket, a malformed
    forwarded value passed through by a proxy) cannot mint fresh buckets: all such values share one."""
    key = rate_limit.client_key
    assert key("testclient") == key("garbage-1") == key("garbage-2") == key("") == key(None)


def test_r1a_rotation_inside_one_64_is_429_through_the_app(monkeypatch):
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_REQUESTS", 3)
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_WINDOW_SECONDS", 3600)
    # limit=0 is refused before any database work, and still spends a token.
    codes = [client_at(f"2001:db8:1:2::{n + 100:x}").get("/search", params={"q": "ab", "limit": 0}).status_code
             for n in range(20)]
    assert codes[:3] == [422, 422, 422] and set(codes[3:]) == {429}, codes
    assert client_at("2001:db8:1:3::1").get("/search", params={"q": "ab", "limit": 0}).status_code == 422
    for host in ("203.0.113.7", "::ffff:203.0.113.7", "203.0.113.7", "::ffff:203.0.113.7"):
        last = client_at(host).get("/search", params={"q": "ab", "limit": 0}).status_code
    assert last == 429, "an IPv4 client and its IPv4-mapped form must share one bucket"


# ---------------------------------------------------------------------------------------------
# R1(b): eviction never hands out a fresh bucket
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("distinct", [101, 1000])
def test_r1b_more_keys_than_the_table_cannot_bypass_the_quota(distinct):
    limiter = rate_limit.TokenBucketLimiter(clock=FrozenClock())
    allowed = sum(acquire(limiter, f"10.{i // 65536}.{i // 256 % 256}.{i % 256}")
                  for _ in range(10) for i in range(distinct))
    # 100 keys hold their own bucket; every other new key shares one overflow bucket (capacity 1).
    assert allowed == 101, f"{allowed} of {10 * distinct} requests allowed"
    assert len(limiter) <= 100


def test_r1b_only_a_refilled_bucket_is_reclaimed():
    clock = FrozenClock()
    limiter = rate_limit.TokenBucketLimiter(clock=clock)
    kw = dict(capacity=2, window_seconds=10, max_keys=1)
    assert limiter.acquire("10.0.0.1", **kw)[0] and limiter.acquire("10.0.0.1", **kw)[0]
    clock.now += 5  # 10.0.0.1 has one token back: its bucket carries state and is not reclaimed
    assert limiter.acquire("10.0.0.2", **kw)[0]  # overflow bucket, token 1
    assert limiter.acquire("10.0.0.3", **kw)[0]  # overflow bucket, token 2
    assert not limiter.acquire("10.0.0.4", **kw)[0]  # overflow bucket empty
    assert limiter.acquire("10.0.0.1", **kw)[0] and not limiter.acquire("10.0.0.1", **kw)[0]
    clock.now += 10  # 10.0.0.1 is full again: reclaiming it gives nothing away
    assert limiter.acquire("10.0.0.5", **kw)[0]
    assert len(limiter) == 1


def test_r1b_rotation_past_the_table_through_the_app(monkeypatch):
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_REQUESTS", 1)
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_WINDOW_SECONDS", 3600)
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_MAX_CLIENTS", 100)
    hosts = [f"198.18.{i // 256}.{i % 256}" for i in range(101)]
    served = sum(client_at(h).get("/search", params={"q": "ab", "limit": 0}).status_code != 429
                 for _ in range(3) for h in hosts)
    assert served == 101, f"{served} of {3 * len(hosts)} requests got past the quota"


# ---------------------------------------------------------------------------------------------
# R1(c): a process-wide cap on concurrent public database reads
# ---------------------------------------------------------------------------------------------
def test_r1c_the_cap_refuses_the_next_concurrent_read_with_503(fake_sessions, monkeypatch):
    monkeypatch.setattr(settings, "PUBLIC_DB_CONCURRENCY", 2)
    fake = fake_sessions(mode="block")
    stmt = pc.search_cases_stmt("ab", None, 10)

    async def scenario():
        holders = [asyncio.create_task(pc.fetch_rows(stmt, timeout_ms=1000)) for _ in range(2)]
        while fake.statements < 2:
            await asyncio.sleep(0.01)
        with pytest.raises(HTTPException) as refused:
            await asyncio.wait_for(pc.fetch_rows(stmt, timeout_ms=1000), 2)  # main: waits, no cap
        fake.release.set()
        assert await asyncio.gather(*holders) == [[], []]
        assert await pc.fetch_rows(stmt, timeout_ms=1000) == []  # the slots came back
        return refused.value

    refused = asyncio.run(scenario())
    assert refused.status_code == 503
    assert refused.headers.get("Retry-After") == "1"


def test_r1c_a_failed_read_gives_its_slot_back(fake_sessions, monkeypatch):
    monkeypatch.setattr(settings, "PUBLIC_DB_CONCURRENCY", 1)
    stmt = pc.search_cases_stmt("ab", None, 10)
    fake_sessions(mode="raise", error=RuntimeError("boom"))
    for _ in range(3):
        with pytest.raises(RuntimeError):
            asyncio.run(pc.fetch_rows(stmt, timeout_ms=1000))
    fake_sessions(mode="empty")
    assert asyncio.run(pc.fetch_rows(stmt, timeout_ms=1000)) == []


def test_r1c_setting_defaults_well_below_the_pool():
    from pydantic import ValidationError

    from scraper.config import Settings

    assert Settings.model_fields["PUBLIC_DB_CONCURRENCY"].default == 8
    with pytest.raises(ValidationError):
        Settings(_env_file=None, PUBLIC_DB_CONCURRENCY=0)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, PUBLIC_DB_CONCURRENCY=41)  # the pool holds 20 + 30 overflow


# ---------------------------------------------------------------------------------------------
# R1(d): a connection that cannot be had is 503, never 500
# ---------------------------------------------------------------------------------------------
class _RefusedConnect(Exception):
    pass


ACQUIRE_FAILURES = {
    "pool checkout timeout": sa_exc.TimeoutError("QueuePool limit of size 20 overflow 30 reached, connection timed out"),
    "connect refused (DBAPI)": sa_exc.OperationalError("connect", {}, ConnectionRefusedError(111, "refused")),
    "connection invalidated": sa_exc.DBAPIError("SELECT 1", {}, _RefusedConnect("gone"), connection_invalidated=True),
    "connect refused (OS)": ConnectionRefusedError(111, "Connection refused"),
    "connect timeout": asyncio.TimeoutError(),
}


@pytest.mark.parametrize("name", sorted(ACQUIRE_FAILURES))
def test_r1d_connection_acquire_failures_are_503_through_the_app(fake_sessions, name):
    fake_sessions(mode="raise", error=ACQUIRE_FAILURES[name])
    for path, params in (("/search", {"q": "ab"}), ("/statutes", {}), ("/cases/" + "0" * 8 + "-0000-0000-0000-" + "0" * 12, {})):
        res = client_at("192.0.2.10").get(path, params=params)
        assert res.status_code == 503, f"{name} on {path}: {res.status_code} {res.text[:200]}"
        assert res.headers.get("retry-after") == "1"
        assert "QueuePool" not in res.text and "refused" not in res.text.lower()


def test_r1d_other_database_errors_still_propagate(fake_sessions):
    """Only acquisition failures and the statement timeout become 503; a programming error is not
    hidden behind a retryable status."""
    fake_sessions(mode="raise_on_query", error=sa_exc.ProgrammingError("SELECT", {}, _RefusedConnect("syntax")))
    assert client_at("192.0.2.11").get("/search", params={"q": "ab"}).status_code == 500


# ---------------------------------------------------------------------------------------------
# strict limit parsing: plain ASCII digits only
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("limit", ["10.0", " 10", "10 ", "+10", "1_0", "١٠", "１０", "0x10", "1e1", "10\x00", ""])
def test_strict_limit_refuses_anything_but_ascii_digits(fake_sessions, limit):
    fake = fake_sessions(mode="empty")
    for path, params in (("/search", {"q": "ab", "limit": limit}), ("/statutes", {"limit": limit})):
        res = client_at("192.0.2.20").get(path, params=params)
        assert res.status_code == 422, f"{path} limit={limit!r}: {res.status_code}"
    assert fake.statements == 0, "an invalid limit reached the database"


@pytest.mark.parametrize("limit, size", [("1", 1), ("10", 10), ("100", 100), ("007", 7)])
def test_strict_limit_accepts_plain_digits(fake_sessions, limit, size):
    fake_sessions(mode="empty")
    res = client_at("192.0.2.21").get("/search", params={"q": "ab", "limit": limit})
    assert res.status_code == 200, res.text
    assert res.json() == {"items": [], "next_cursor": None}


# ---------------------------------------------------------------------------------------------
# L2 / M39: the limiter keys on the peer address and never reads a forwarding header
# ---------------------------------------------------------------------------------------------
def test_m39_forwarding_headers_never_change_the_key(monkeypatch):
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_REQUESTS", 2)
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_WINDOW_SECONDS", 3600)
    c = client_at("192.0.2.30")
    codes = [c.get("/search", params={"q": "ab", "limit": 0},
                   headers={"X-Forwarded-For": f"198.51.100.{i}", "X-Real-IP": f"198.51.100.{i}",
                            "Forwarded": f"for=198.51.100.{i}"}).status_code for i in range(4)]
    assert codes == [422, 422, 429, 429], codes


def _code_strings(tree):
    """String constants that are not docstrings."""
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                docstrings.add(id(first.value))
    return [n.value for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings]


def test_m39_the_limiter_source_reads_no_header():
    tree = ast.parse(inspect.getsource(rate_limit))
    leaks = [s for s in _code_strings(tree) if "forwarded" in s.lower() or "real-ip" in s.lower()]
    assert leaks == [], leaks
    attrs = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    assert "headers" not in attrs and "scope" not in attrs, "the limiter must key on request.client only"


# ---------------------------------------------------------------------------------------------
# L1: the trusted-proxy setting is explicit, and a missing one is visible in the log
# ---------------------------------------------------------------------------------------------
def test_l1_compose_and_app_env_make_the_proxy_setting_explicit():
    """app.env sets FORWARDED_ALLOW_IPS explicitly; compose hands app.env to the api service, and the
    api command neither overrides the setting nor turns proxy headers off (uvicorn reads the
    variable, and --proxy-headers is its default)."""
    lines = (CORPUS_SERVICE / "app.env").read_text().splitlines()
    values = [line.split("=", 1)[1] for line in lines if line.startswith("FORWARDED_ALLOW_IPS=")]
    assert values == ["127.0.0.1"], "app.env must set FORWARDED_ALLOW_IPS once, to the safe default"
    compose = (CORPUS_SERVICE / "docker-compose.yml").read_text()
    api = compose.split("\n  api:\n", 1)[1].split("\n\n", 1)[0]
    assert "env_file: app.env" in api
    command = next(line for line in api.splitlines() if line.strip().startswith("command:"))
    assert "uvicorn" in command
    assert "--forwarded-allow-ips" not in command and "--no-proxy-headers" not in command, command


@pytest.mark.parametrize(
    "env, warns",
    [
        ({"ENVIRONMENT": "production"}, True),
        ({"ENVIRONMENT": "production", "FORWARDED_ALLOW_IPS": "127.0.0.1"}, True),
        ({"ENVIRONMENT": "production", "FORWARDED_ALLOW_IPS": " 127.0.0.1 , ::1 "}, True),
        ({"ENVIRONMENT": "production", "FORWARDED_ALLOW_IPS": "172.18.0.1"}, False),
        ({"ENVIRONMENT": "production", "FORWARDED_ALLOW_IPS": "10.20.0.0/16"}, False),
        ({"ENVIRONMENT": "production", "FORWARDED_ALLOW_IPS": "*"}, True),  # trusts every peer
        ({"ENVIRONMENT": "development"}, False),
    ],
)
def test_l1_startup_warning_when_the_proxy_looks_unset(env, warns):
    from scraper import client_identity

    message = client_identity.forwarded_trust_warning(env)
    assert bool(message) is warns, message
    if message:
        assert "FORWARDED_ALLOW_IPS" in message


def test_l1_startup_logs_the_warning(monkeypatch, caplog):
    from scraper import client_identity

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("FORWARDED_ALLOW_IPS", raising=False)
    with caplog.at_level(logging.WARNING):
        client_identity.log_forwarded_trust_at_startup()
    assert any("FORWARDED_ALLOW_IPS" in r.getMessage() for r in caplog.records)
    assert "client_identity.log_forwarded_trust_at_startup()" in (SCRAPER / "main.py").read_text()


def test_l1_an_ignored_forwarding_header_is_logged_once(caplog):
    from scraper import client_identity

    client_identity.reset_forwarded_warning()
    c = client_at("192.0.2.40")
    with caplog.at_level(logging.WARNING):
        for _ in range(3):
            c.get("/search", params={"q": "ab", "limit": 0}, headers={"X-Forwarded-For": "203.0.113.9, forged-marker"})
    hits = [r for r in caplog.records if "X-Forwarded-For" in r.getMessage()]
    assert len(hits) == 1, [r.getMessage() for r in hits]
    assert "forged-marker" not in hits[0].getMessage() and "203.0.113.9" not in hits[0].getMessage()
    assert "192.0.2.40" in hits[0].getMessage()


# ---------------------------------------------------------------------------------------------
# L4: CSV formula injection is neutralised in the export
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "cell, safe",
    [
        ("=HYPERLINK(\"http://evil.invalid\")", "'=HYPERLINK(\"http://evil.invalid\")"),
        ("+cmd|' /C calc'!A0", "'+cmd|' /C calc'!A0"),
        ("-2+3", "'-2+3"),
        ("@SUM(1+1)", "'@SUM(1+1)"),
        ("\t=1", "'\t=1"),
        ("\r=1", "'\r=1"),
        ("2099 SCMR 101", "2099 SCMR 101"),
        ("A v. B", "A v. B"),
        ("", ""),
        (None, None),
        (2099, 2099),
    ],
)
def test_l4_csv_cells_starting_with_a_formula_character_are_quoted(cell, safe):
    from scraper.routers import export

    assert export.csv_safe_cell(cell) == safe


# ---------------------------------------------------------------------------------------------
# /docs, /openapi.json, /redoc and /dashboard share the per-client quota (/health is F44's)
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("path", ["/openapi.json", "/docs", "/redoc", "/dashboard"])
def test_unauthenticated_pages_are_rate_limited(monkeypatch, path):
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_REQUESTS", 2)
    monkeypatch.setattr(settings, "PUBLIC_RATE_LIMIT_WINDOW_SECONDS", 3600)
    c = client_at("192.0.2.50")
    codes = [c.get(path).status_code for _ in range(3)]
    assert codes[:2] == [200, 200] and codes[2] == 429, codes
    assert int(c.get(path).headers["retry-after"]) >= 1
    assert client_at("192.0.2.51").get(path).status_code == 200


# ---------------------------------------------------------------------------------------------
# M02: the trust test is the exact IN list, with no NULL escape hatch
# ---------------------------------------------------------------------------------------------
def test_m02_published_predicates_have_no_null_escape():
    for stmt in (pc.search_cases_stmt("ab", None, 10), pc.list_statutes_stmt(None, None, 10),
                 pc.case_detail_stmt(uuid.uuid4()), pc.export_cases_stmt(5)):
        sql = str(stmt.compile(dialect=pg_asyncpg.dialect(), compile_kwargs={"literal_binds": True}))
        assert "trust_level IS NULL" not in sql and "IS NOT false" not in sql, sql
        assert sql.count("scraper_sources.trust_level IN (") == 1, sql
