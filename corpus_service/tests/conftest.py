"""Test-process defaults. The service fails closed to production unless told otherwise,
so the suite opts in to development explicitly (as .env.example does for local runs).

Real-Postgres tests (audit F20) use the ``corpus_db`` fixture below. They need
CORPUS_TEST_DATABASE_URL: a ``postgresql+asyncpg://`` URL for a role that may CREATE DATABASE,
CREATE ROLE and create the vector/pg_trgm/uuid-ossp extensions (the CI service container's
superuser; locally, a throwaway pgvector/pgvector:pg16 container). Each test gets a database of its
own, created empty and dropped afterwards, so the tests are isolated and repeatable. Outside CI a
missing URL skips those tests with the reason; under CI (``CI`` set) it stops the run, so the
real-database tests cannot pass by being skipped.
"""

import asyncio
import os
import secrets
import subprocess
import sys
from pathlib import Path

import pytest

os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("SKIP_DIR_CREATE", "1")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

TEST_DB_ENV = "CORPUS_TEST_DATABASE_URL"


def _test_db_url() -> str:
    return os.environ.get(TEST_DB_ENV, "").strip()


def pytest_configure(config):
    if os.environ.get("CI") and not _test_db_url():
        pytest.exit(f"{TEST_DB_ENV} required in CI", returncode=1)


class CorpusTestDatabase:
    """One fresh database on the CORPUS_TEST_DATABASE_URL server.

    While the ``corpus_db`` fixture is active, the application's own ``scraper.database.engine``
    and ``SessionLocal`` are bound to it, so promotion, the dispatcher and seeding run unchanged.
    """

    def __init__(self, admin_url: str, name: str):
        from sqlalchemy.engine import make_url

        self._admin = make_url(admin_url)
        self.name = name
        self.password = self._admin.password or ""
        self.url = self._admin.set(database=name).render_as_string(hide_password=False)
        self.roles = []
        self._role_passwords = []

    # -- connections ---------------------------------------------------------------------------
    @staticmethod
    def engine_for(url: str, **kw):
        """A NullPool engine: each test drives its coroutines with asyncio.run, i.e. a new event
        loop each time, and asyncpg connections must not outlive their loop."""
        from sqlalchemy.ext.asyncio import create_async_engine
        from sqlalchemy.pool import NullPool

        from scraper.config import asyncpg_engine_args

        clean_url, connect_args = asyncpg_engine_args(url)
        return create_async_engine(clean_url, poolclass=NullPool, connect_args=connect_args, **kw)

    def url_as(self, user: str, password: str) -> str:
        return self._admin.set(database=self.name, username=user, password=password).render_as_string(
            hide_password=False
        )

    async def _admin_exec(self, statements, database=None):
        from sqlalchemy import text

        url = self._admin.set(database=database or self._admin.database).render_as_string(hide_password=False)
        eng = self.engine_for(url, isolation_level="AUTOCOMMIT")
        try:
            async with eng.connect() as conn:
                for sql in statements:
                    await conn.execute(text(sql))
        finally:
            await eng.dispose()

    def admin(self, *statements: str) -> None:
        """Run statements as the CORPUS_TEST_DATABASE_URL role, autocommit, on this database."""
        asyncio.run(self._admin_exec(statements, database=self.name))

    def create_role(self, prefix: str) -> tuple:
        """A LOGIN role with no attributes (NOSUPERUSER etc.) and a password generated now; dropped
        with the database."""
        name = f"{prefix}_{secrets.token_hex(4)}"
        password = secrets.token_hex(24)
        self.roles.append(name)
        self._role_passwords.append(password)
        asyncio.run(
            self._admin_exec(
                [
                    f'CREATE ROLE "{name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION '
                    f"NOBYPASSRLS PASSWORD '{password}'"
                ]
            )
        )
        return name, password

    # -- the application's own migrate step -----------------------------------------------------
    def migrate(self, database_url: str = None) -> subprocess.CompletedProcess:
        """``python -m scraper.migrate`` exactly as the compose ``migrate`` service runs it (no
        Redis), against this database."""
        env = {**os.environ, "DATABASE_URL": database_url or self.url, "REDIS_URL": ""}
        proc = subprocess.run(
            [sys.executable, "-m", "scraper.migrate"],
            cwd=str(PROJECT_ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        proc.stdout = self.redact(proc.stdout)
        proc.stderr = self.redact(proc.stderr)
        return proc

    def redact(self, text: str) -> str:
        for secret in [self.password, *self._role_passwords]:
            if secret:
                text = text.replace(secret, "<redacted>")
        return text

    # -- lifecycle ------------------------------------------------------------------------------
    def create(self) -> None:
        asyncio.run(self._admin_exec([f'CREATE DATABASE "{self.name}"']))

    def drop(self) -> None:
        statements = [f'DROP DATABASE IF EXISTS "{self.name}" WITH (FORCE)']
        statements += [f'DROP ROLE IF EXISTS "{role}"' for role in self.roles]
        asyncio.run(self._admin_exec(statements))


@pytest.fixture
def corpus_db(request):
    """A fresh, empty database for one test, with the app's engine and sessions bound to it."""
    admin_url = _test_db_url()
    if not admin_url:
        pytest.skip(f"{TEST_DB_ENV} is not set: real-Postgres corpus test skipped (required under CI)")

    from scraper import database

    name = f"corpus_t_{secrets.token_hex(6)}"
    db = CorpusTestDatabase(admin_url, name)
    db.create()
    engine = db.engine_for(db.url)
    saved_engine = database.engine
    database.engine = engine
    database.SessionLocal.configure(bind=engine)
    try:
        yield db
    finally:
        database.SessionLocal.configure(bind=saved_engine)
        database.engine = saved_engine
        asyncio.run(engine.dispose())
        db.drop()
