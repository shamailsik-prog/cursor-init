"""Test-process defaults. The service fails closed to production unless told otherwise,
so the suite opts in to development explicitly (as .env.example does for local runs).

Real-Postgres tests (audit F20) use the ``corpus_db`` fixture below. They need
CORPUS_TEST_DATABASE_URL: a ``postgresql+asyncpg://`` URL for a role that may CREATE DATABASE,
CREATE ROLE and create the vector/pg_trgm/uuid-ossp extensions (the CI service container's
superuser; locally, a throwaway pgvector/pgvector:pg16 container). Each test gets a database of its
own, created empty and dropped afterwards, so the tests are isolated and repeatable. Outside CI a
missing URL skips those tests with the reason; under CI (``CI`` set) it stops the run, so the
real-database tests cannot pass by being skipped.

Audit F19 tests also apply the Annex A contract (postgres/ddl 001 + 003) to their database as the
admin (``apply_annex_a``), and use generated login roles that reach ``corpus_writer`` /
``corpus_reader`` the way the compose provisioning grants them (``runtime_role``, ``writer_role``,
``reader_role``). Every role password is generated at runtime and redacted from captured output.
"""

import asyncio
import contextlib
import os
import secrets
import subprocess
import sys
from pathlib import Path
from typing import Iterator, Sequence, Tuple

import pytest

os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("SKIP_DIR_CREATE", "1")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

TEST_DB_ENV = "CORPUS_TEST_DATABASE_URL"

# Audit F19: the Annex A contract the publication writes. In production it is applied by a superuser at
# postgres init (PR 2b), never by `python -m scraper.migrate`; here the fixture applies it as the admin.
REPO_ROOT = PROJECT_ROOT.parent
# Always in this order (audit F05 plan D13: 004 re-defines 003's relation inventory, and 005, audit FA-D5-003,
# re-defines 004's with the research views and narrows corpus_reader, FA-DATA-003).
ANNEX_A_DDL = (
    "001_corpus_contract.sql",
    "003_corpus_publication.sql",
    "004_authority_read_views.sql",
    "005_research_reader.sql",
    "006_research_terms.sql",
)
# The application's own (ORM) tables: the runtime role's DML grant covers exactly these, never Annex A
# (mirrors PR 2b's provisioning, where the migration role's default privileges grant it on every table
# that role creates). quarantine_decisions is audit F23's append-only decision table; embedding_attempts
# is audit F27's receipt table for the embedding queue; corpus_lifecycle_transitions is audit F21's
# lifecycle move log.
ORM_TABLES = (
    "courts", "scraper_sources", "case_law_master", "statutes_master", "scraper_staging",
    "statutes_staging", "scraper_jobs", "quarantine_queue", "embedding_queue", "quarantine_decisions",
    "embedding_attempts", "corpus_lifecycle_transitions",
)


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

    # -- audit F19: Annex A and the publication roles --------------------------------------------
    def apply_annex_a(self, files: Sequence[str] = ANNEX_A_DDL) -> None:
        """Apply the Annex A DDL files to this database as the admin (a superuser), the way the
        postgres init script does: one simple-query execute per file (multi-statement, DO blocks,
        $$ bodies; one implicit transaction per file)."""
        import asyncpg
        from sqlalchemy.engine import make_url

        url = make_url(self.url).set(drivername="postgresql").render_as_string(hide_password=False)

        async def _apply():
            conn = await asyncpg.connect(url)
            try:
                for name in files:
                    await conn.execute((REPO_ROOT / "postgres" / "ddl" / name).read_text(encoding="utf-8"))
            finally:
                await conn.close()

        asyncio.run(_apply())

    def _grant_member(self, role: str, group: str, *, set_only: bool) -> None:
        option = " WITH INHERIT FALSE, SET TRUE" if set_only else ""
        self.admin(f'GRANT {group} TO "{role}"{option}')

    def runtime_role(self, corpus_writer: str = "set") -> Tuple[str, str]:
        """The API/worker runtime role as PR 2b provisions it: DML on the ORM tables only (not
        "ALL TABLES"), and corpus_writer reachable by SET ROLE only (INHERIT FALSE, SET TRUE).

        corpus_writer="none" is the role as shipped before PR 2b (no membership); "no_set" is a
        member that may not SET ROLE to it (INHERIT FALSE, SET FALSE)."""
        name, password = self.create_role("f19_app")
        tables = ", ".join(f'"{t}"' for t in ORM_TABLES)
        self.admin(
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON {tables} TO "{name}"',
            # Sequences owned by an ORM table only (Annex A identity sequences stay out).
            f"""DO $$ DECLARE s record; BEGIN
                  FOR s IN SELECT seq.relname FROM pg_class seq
                           JOIN pg_depend d ON d.objid = seq.oid AND d.deptype IN ('a', 'i')
                           JOIN pg_class t ON t.oid = d.refobjid
                           WHERE seq.relkind = 'S' AND t.relname = ANY(ARRAY[{", ".join(f"'{t}'" for t in ORM_TABLES)}])
                  LOOP EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE %I TO %I', s.relname, '{name}');
                  END LOOP; END $$""",
        )
        if corpus_writer == "set":
            self._grant_member(name, "corpus_writer", set_only=True)
        elif corpus_writer == "no_set":
            self.admin(f'GRANT corpus_writer TO "{name}" WITH INHERIT FALSE, SET FALSE')
        elif corpus_writer != "none":
            raise ValueError(corpus_writer)
        return name, password

    def writer_role(self) -> Tuple[str, str]:
        """A publisher login: a corpus_writer member by SET ROLE only."""
        name, password = self.create_role("f19_pub")
        self._grant_member(name, "corpus_writer", set_only=True)
        return name, password

    def reader_role(self) -> Tuple[str, str]:
        """An application reader login: a corpus_reader member (the promoted-only v_* views)."""
        name, password = self.create_role("f19_rdr")
        self._grant_member(name, "corpus_reader", set_only=False)
        return name, password

    @contextlib.contextmanager
    def app_engine_as(self, user: str, password: str) -> Iterator[None]:
        """Rebind the application's own engine and sessions to this database as ``user``."""
        from scraper import database

        engine = self.engine_for(self.url_as(user, password))
        saved_engine = database.engine
        database.engine = engine
        database.SessionLocal.configure(bind=engine)
        try:
            yield
        finally:
            database.SessionLocal.configure(bind=saved_engine)
            database.engine = saved_engine
            asyncio.run(engine.dispose())

    def run_cli(self, *args: str, user: str, password: str) -> subprocess.CompletedProcess:
        """``python -m scraper.publication.cli <args>`` as the operator runs it, with DATABASE_URL
        for ``user`` on this database (no Redis). Output is redacted of every test password."""
        env = {**os.environ, "DATABASE_URL": self.url_as(user, password), "REDIS_URL": ""}
        proc = subprocess.run(
            [sys.executable, "-m", "scraper.publication.cli", *args],
            cwd=str(PROJECT_ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        proc.stdout = self.redact(proc.stdout)
        proc.stderr = self.redact(proc.stderr)
        return proc

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


@pytest.fixture(autouse=True, scope="session")
def raw_pdf_vault(tmp_path_factory):
    """Audit F26: harvested PDFs are kept in the raw store under PDF_STORAGE_PATH before they are
    parsed. Tests keep theirs in a session temporary directory, never the image's /app/live; a test
    that inspects the store points PDF_STORAGE_PATH at its own directory."""
    from scraper import config

    vault = tmp_path_factory.mktemp("pdf-vault")
    saved = config.settings.PDF_STORAGE_PATH
    config.settings.PDF_STORAGE_PATH = str(vault)
    try:
        yield vault
    finally:
        config.settings.PDF_STORAGE_PATH = saved
