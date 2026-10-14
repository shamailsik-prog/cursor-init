"""Audit F30 end-to-end probes, run by tests/e2e/store_security_e2e.sh inside the corpus image on
the compose data network. Each probe goes through the application's own code: scraper.config
settings from the container environment that docker-compose.yml sets, scraper.database's engine
(asyncpg + the TLS wiring), and scraper.tasks.celery_app (kombu + Redis result backend).

Prints one "PASS <label>" / "FAIL <label>" line per assertion and exits 1 if any failed.

    python tests/e2e/probe.py db-runtime          # as APP_DB_USER (api service environment)
    python tests/e2e/probe.py db-migrate          # as MIGRATE_DB_USER (migrate service environment)
    python tests/e2e/probe.py env-escalation      # inside a running app container (re-audit D1)
    python tests/e2e/probe.py db-must-fail REGEX  # DATABASE_URL overridden to a bad CA / host
    python tests/e2e/probe.py redis-must-fail REGEX
    python tests/e2e/probe.py api-health          # inside the running api container
    python tests/e2e/probe.py celery              # needs a running worker-embed
"""

import asyncio
import json
import os
import re
import sys
import time
import urllib.request
from urllib.parse import urlsplit

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

FAILURES = []

# SQLSTATE 42501 = insufficient_privilege.
INSUFFICIENT_PRIVILEGE = "42501"


def check(label, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail and not ok else ""), flush=True)
    if not ok:
        FAILURES.append(label)


def sqlstate(exc):
    orig = getattr(exc, "orig", None)
    for candidate in (orig, getattr(orig, "__cause__", None), exc.__cause__, exc):
        code = getattr(candidate, "sqlstate", None) or getattr(candidate, "pgcode", None)
        if code:
            return code
    return None


async def _scalar(engine, sql):
    from sqlalchemy import text

    async with engine.connect() as conn:
        return (await conn.execute(text(sql))).scalar()


async def _must_be_denied(engine, label, sql):
    from sqlalchemy import text

    try:
        # Autocommit: CREATE DATABASE / ALTER SYSTEM refuse to run in a transaction block, which
        # would mask the privilege check we want to observe.
        async with engine.connect() as conn:
            conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
            await conn.execute(text(sql))
    except Exception as exc:  # noqa: BLE001 - we classify by SQLSTATE below
        code = sqlstate(exc)
        check(f"{label} is refused (insufficient_privilege)", code == INSUFFICIENT_PRIVILEGE,
              f"sqlstate={code} {type(exc).__name__}: {str(exc).splitlines()[0][:200]}")
        return
    check(f"{label} is refused (insufficient_privilege)", False, "statement succeeded")


async def _role_and_tls(engine, expected_user):
    who = await _scalar(engine, "select current_user")
    check(f"connected as {expected_user} (not the bootstrap superuser)", who == expected_user, f"current_user={who}")
    tls = await _scalar(engine, "select ssl from pg_stat_ssl where pid = pg_backend_pid()")
    check("session is TLS-encrypted (pg_stat_ssl.ssl)", tls is True, f"ssl={tls}")
    attrs = await _scalar(
        engine,
        "select row(rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls)::text "
        "from pg_roles where rolname = current_user",
    )
    check("role is NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS", attrs == "(f,f,f,f,f)", attrs)


PRIVILEGED = [
    ("CREATE ROLE", "CREATE ROLE f30_probe_role"),
    ("ALTER SYSTEM", "ALTER SYSTEM SET log_statement = 'all'"),
    ("CREATE DATABASE", "CREATE DATABASE f30_probe_db"),
    ("reading pg_authid", "SELECT rolpassword FROM pg_authid LIMIT 1"),
    ("CREATE EXTENSION (trusted hstore)", "CREATE EXTENSION hstore"),
    ("CREATE SCHEMA", "CREATE SCHEMA f30_probe_schema"),
    ("COPY ... TO PROGRAM", "COPY (SELECT 1) TO PROGRAM 'true'"),
    ("pg_read_file", "SELECT pg_read_file('/etc/passwd')"),
    ("creating a large object (lo_create)", "SELECT lo_create(0)"),
]

# Errors that mean "this credential cannot do it": no privilege, or no login at all.
REFUSED = {INSUFFICIENT_PRIVILEGE, "28000", "28P01"}


async def db_runtime():
    from sqlalchemy import delete, select

    from scraper.config import settings
    from scraper.database import SessionLocal, engine, init_db
    from scraper.models import ScraperJob, ScraperSource

    expected = urlsplit(settings.DATABASE_URL).username
    try:
        await _role_and_tls(engine, expected)
        # The API's own startup path under the runtime role: extension no-ops, create_all catalog
        # check (tables already exist), seed DML.
        try:
            await init_db()
            check("api startup init_db() succeeds as the runtime role", True)
        except Exception as exc:  # noqa: BLE001
            check("api startup init_db() succeeds as the runtime role", False, f"{type(exc).__name__}: {exc}")
        async with SessionLocal() as db:
            sources = (await db.execute(select(ScraperSource))).scalars().all()
            check("SELECT through the ORM returns the seeded sources", len(sources) >= 15, f"n={len(sources)}")
            job = ScraperJob(source_site="f30-e2e", job_type="incremental", status="pending")
            db.add(job)
            await db.commit()
            job.status = "completed"
            await db.commit()
            got = (await db.execute(select(ScraperJob.status).where(ScraperJob.id == job.id))).scalar()
            check("INSERT + UPDATE through the ORM", got == "completed", f"status={got}")
            await db.execute(delete(ScraperJob).where(ScraperJob.id == job.id))
            await db.commit()
            left = (await db.execute(select(ScraperJob).where(ScraperJob.id == job.id))).scalars().first()
            check("DELETE through the ORM", left is None)
        for label, sql in PRIVILEGED + [
            ("CREATE TABLE (DDL) in public", "CREATE TABLE f30_probe_t (id int)"),
            ("DROP TABLE of an application table", "DROP TABLE scraper_jobs"),
            ("ALTER TABLE of an application table", "ALTER TABLE scraper_jobs ADD COLUMN f30_probe int"),
            ("TRUNCATE of an application table", "TRUNCATE scraper_jobs"),
            ("SET ROLE to the bootstrap superuser",
             f"SET ROLE \"{os.environ.get('E2E_BOOTSTRAP_USER', 'postgres')}\""),
        ]:
            await _must_be_denied(engine, label, sql)
    finally:
        await engine.dispose()


async def db_migrate():
    from scraper.config import settings
    from scraper.database import engine

    expected = urlsplit(settings.DATABASE_URL).username
    try:
        await _role_and_tls(engine, expected)
        owned = await _scalar(
            engine, "select count(*) from pg_tables where schemaname = 'public' and tableowner = current_user")
        check("migration role owns the application tables", (owned or 0) >= 9, f"owned={owned}")
        for label, sql in PRIVILEGED:
            await _must_be_denied(engine, label, sql)
    finally:
        await engine.dispose()


async def _attempt(url, sql):
    """Run `sql` in a transaction that is always rolled back; return 'SUCCEEDED' or the SQLSTATE /
    exception that stopped it."""
    from sqlalchemy import text

    from scraper.database import build_engine

    engine = build_engine(url)
    try:
        async with engine.connect() as conn:
            trans = await conn.begin()
            try:
                await conn.execute(text(sql))
                return "SUCCEEDED"
            finally:
                await trans.rollback()
    except Exception as exc:  # noqa: BLE001 - classified by the caller
        return sqlstate(exc) or type(exc).__name__
    finally:
        await engine.dispose()


async def env_escalation():
    """Re-audit D1: from inside a running app container, using only what its own environment
    holds, nobody can destroy or alter the schema. Every database credential found in the env is
    tried over verify-full TLS; the container must hold only its own (runtime) credential."""
    from urllib.parse import quote

    from scraper.config import settings, split_postgres_tls

    env = os.environ
    own_user = urlsplit(settings.DATABASE_URL).username
    rootcert = split_postgres_tls(settings.DATABASE_URL)[1].get("sslrootcert", "/run/tls-ca/ca.crt")
    found = []
    for prefix in ("POSTGRES", "MIGRATE_DB", "APP_DB"):
        user, pw = env.get(f"{prefix}_USER"), env.get(f"{prefix}_PASSWORD")
        if user and pw:
            found.append((f"{prefix}_USER/{prefix}_PASSWORD", user, pw))
    for key, val in env.items():
        if key != "DATABASE_URL" and val.startswith("postgresql"):
            parts = urlsplit(val)
            if parts.username and parts.password:
                found.append((key, parts.username, parts.password))
    check("container env holds no database credential besides its own DATABASE_URL",
          not found, ", ".join(label for label, _u, _p in found))
    candidates = [("own DATABASE_URL", own_user, None)] + found
    for label, user, pw in candidates:
        if pw is None:
            url = settings.DATABASE_URL
        else:
            url = (f"postgresql+asyncpg://{quote(user, safe='')}:{quote(pw, safe='')}@postgres:5432/legal_scraper"
                   f"?sslmode=verify-full&sslrootcert={rootcert}")
        for what, sql in (("DROP TABLE scraper_jobs", "DROP TABLE scraper_jobs CASCADE"),
                          ("ALTER TABLE scraper_sources", "ALTER TABLE scraper_sources ADD COLUMN f30_probe int")):
            result = await _attempt(url, sql)
            check(f"{what} as {label} ({user}) is refused", result in REFUSED, f"result={result}")


async def db_must_fail(pattern):
    from scraper.database import engine

    try:
        await _scalar(engine, "select 1")
    except Exception as exc:  # noqa: BLE001
        msg = f"{type(exc).__name__}: {exc}"
        check(f"app engine refuses the connection ({pattern})", re.search(pattern, msg, re.I) is not None, msg[:300])
        return
    finally:
        await engine.dispose()
    check(f"app engine refuses the connection ({pattern})", False, "connection succeeded")


def redis_must_fail(pattern):
    import redis

    from scraper.config import settings

    client = redis.Redis.from_url(settings.REDIS_URL, socket_timeout=10, **settings.redis_ssl_options())
    try:
        client.ping()
    except Exception as exc:  # noqa: BLE001
        msg = f"{type(exc).__name__}: {exc}"
        check(f"redis-py with the app's TLS options refuses ({pattern})", re.search(pattern, msg, re.I) is not None, msg[:300])
        return
    check(f"redis-py with the app's TLS options refuses ({pattern})", False, "PING succeeded")


def api_health():
    body = None
    deadline = time.time() + 90
    while time.time() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5) as res:
                body = json.loads(res.read().decode())
                break
        except Exception:  # noqa: BLE001 - uvicorn still starting
            time.sleep(2)
    check("api /health answers", body is not None)
    check("api reaches the database over TLS as the runtime role (db_connected)",
          bool(body and body.get("db_connected") is True), json.dumps(body))


def celery_roundtrip():
    import redis

    from scraper.tasks.celery_app import app

    conn = app.connection_for_write()
    try:
        conn.ensure_connection(max_retries=3)
        pool = conn.default_channel.client.connection_pool
        check("Celery broker connection uses redis.SSLConnection",
              issubclass(pool.connection_class, redis.SSLConnection), pool.connection_class.__name__)
    finally:
        conn.release()
    backend_pool = app.backend.client.connection_pool
    check("Celery result backend uses redis.SSLConnection",
          issubclass(backend_pool.connection_class, redis.SSLConnection), backend_pool.connection_class.__name__)
    # A real task: broker (TLS + ACL) -> worker-embed -> DB as the runtime role (TLS) -> result
    # backend (TLS + ACL) -> here.
    result = app.send_task("scraper.tasks.cross_reference.cross_reference_citations")
    try:
        value = result.get(timeout=120)
        check("Celery task round trip through broker, worker, database and result backend",
              isinstance(value, int), repr(value))
    except Exception as exc:  # noqa: BLE001
        check("Celery task round trip through broker, worker, database and result backend", False,
              f"{type(exc).__name__}: {exc}")


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]
    if cmd == "db-runtime":
        asyncio.run(db_runtime())
    elif cmd == "db-migrate":
        asyncio.run(db_migrate())
    elif cmd == "env-escalation":
        asyncio.run(env_escalation())
    elif cmd == "db-must-fail":
        asyncio.run(db_must_fail(args[0]))
    elif cmd == "redis-must-fail":
        redis_must_fail(args[0])
    elif cmd == "api-health":
        api_health()
    elif cmd == "celery":
        celery_roundtrip()
    else:
        print(f"unknown probe {cmd}")
        return 2
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
