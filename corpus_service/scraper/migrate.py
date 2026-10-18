"""One-shot schema migration (audit F30, F20, F23).

Run by the `migrate` compose service as MIGRATE_DB_USER, the schema-owner role, before the api and
workers start. The runtime role (APP_DB_USER) has DML rights only, so the API's own startup
init_db() can no longer create tables: with every table already present, its create_all is a
catalog check and its seed step is plain DML.

Order (audit F20, F19): create the schema, then, in one transaction, bring scraper_sources onto the
trust vocabulary (trusted | review | blocked, default review) and add
scraper_staging.extracted_bench_type where it is missing, then seed. On a database created before
F20 the old CHECK refuses 'review', so the upgrade must come before the seed step inserts a review
source. The upgrades are DDL and run only here, never in the API's init_db().

The Annex A corpus contract (postgres/ddl/001 + 003) is never applied here: it needs CREATE ROLE and
CREATE EXTENSION, which this NOCREATEROLE owner role cannot do. A superuser applies it at postgres
init (docker/postgres/apply-annex-a.sh, audit F19 PR 2b).

Numbered migrations (audit F23): after those upgrades, in the same transaction, every module listed
in NUMBERED_MIGRATIONS (corpus_service/migrations/<name>.py) runs its ``upgrade(conn)``, in list
order. The names start with a digit, so each is loaded by file path; a listed file that is missing or
has no ``upgrade`` stops the migration. 001_initial.py is a placeholder (create_all builds the
tables) and is not listed. The list does not need contiguous numbers: a later migration is appended.

Run it only as MIGRATE_DB_USER (the `migrate` service). Deciding whether the trust CHECK is already
current builds a throwaway table in scraper_sources' schema (rolled back), which needs CREATE on
that schema, so running this as the DML-only runtime role exits 1 even on a database that is
already current.

    python -m scraper.migrate
"""

import asyncio
import importlib.util
import logging
from pathlib import Path

from scraper import database

logger = logging.getLogger("scraper.migrate")

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"
# Audit F23: 002 makes quarantine_decisions append-only; 003 (re-audit round 2) adds its
# request_fingerprint. Append later migrations in order.
NUMBERED_MIGRATIONS = ("002_quarantine_decisions", "003_quarantine_decision_fingerprint")


def load_migration(name: str):
    """The module corpus_service/migrations/<name>.py, loaded by path; it must define upgrade(conn)."""
    path = MIGRATIONS_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"corpus_migrations.m{name}", path)
    if spec is None or spec.loader is None or not path.is_file():
        raise RuntimeError(f"migration {name} not found at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "upgrade", None)):
        raise RuntimeError(f"migration {name} has no upgrade(conn)")
    return module


async def run_migrations() -> None:
    await database.create_schema()
    migrations = [load_migration(name) for name in NUMBERED_MIGRATIONS]
    async with database.engine.begin() as conn:
        await database.upgrade_trust_vocabulary(conn)
        await database.upgrade_staging_bench_type(conn)
        for name, module in zip(NUMBERED_MIGRATIONS, migrations):
            logger.info("migration %s", name)
            await module.upgrade(conn)
    await database.seed_data()


async def _run() -> None:
    try:
        await run_migrations()
    finally:
        await database.engine.dispose()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_run())
    logger.info("schema migration complete")


if __name__ == "__main__":
    main()
