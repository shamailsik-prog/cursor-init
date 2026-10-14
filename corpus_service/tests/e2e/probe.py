"""Audit F30 end-to-end probes, run by tests/e2e/store_security_e2e.sh inside the corpus image on
the compose data network. Each probe goes through the application's own code: scraper.config
settings from the container environment that docker-compose.yml sets, scraper.database's engine
(asyncpg + the TLS wiring), and scraper.tasks.celery_app (kombu + Redis result backend).

Prints one "PASS <label>" / "FAIL <label>" line per assertion and exits 1 if any failed.

Since audit F19 (PR 2b) db-runtime and db-migrate also check the Annex A corpus contract that postgres
init applies: the runtime role reaches it only as corpus_writer (SET ROLE) and publishes through
publish_batch and promotion; neither role owns or holds anything of it directly. db-runtime writes
two synthetic "2099 SCMR <page>" judgments (E2E_ANNEX_A_PAGE and the next page).

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


def _known_secrets():
    """Every secret this container holds: values of credential-named variables and the
    passwords inside its URLs. Nothing the probe prints may contain one."""
    found = set()
    for name, value in os.environ.items():
        if value and re.search(r"PASSWORD|SECRET|TOKEN|_KEY$|_AUTH$", name):
            found.add(value)
        if "://" in value:
            try:
                password = urlsplit(value).password
            except ValueError:
                password = None
            if password:
                found.add(password)
    return found


def redact(text):
    text = str(text)
    for value in sorted(_known_secrets(), key=len, reverse=True):
        text = text.replace(value, "<redacted>")
    return text


def check(label, ok, detail=""):
    print(redact(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail and not ok else "")), flush=True)
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
        await annex_a_runtime(engine, expected)
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
        await annex_a_migrate(engine)
    finally:
        await engine.dispose()


# ---- audit F19, PR 2b: the Annex A corpus contract in the compose stack ---------------------------
# corpus_contract_relations() as 004 defines it (003's 29 relations and the four authority read views of
# audit F05). Neither application role may execute that function (EXECUTE is revoked from PUBLIC), so the
# probe carries the list; store_security_e2e.sh checks the same properties against the function itself, as
# the superuser, and the v_authority_* views by name as well.
ANNEX_A_RELATIONS = (
    "classification_rank", "source_provenance", "court", "judge", "instrument", "statute", "statute_section",
    "statute_section_version", "judgment", "judgment_version", "citation", "treatment", "corpus_metadata",
    "corpus_embeddings", "judgment_classification_declassify_audit", "judgment_declassify_grant",
    "v_judgment", "v_citation", "v_treatment", "v_statute", "v_statute_section", "v_statute_section_version",
    "v_instrument", "v_court", "v_judge", "v_source_provenance",
    "corpus_publication", "corpus_publication_item", "corpus_publication_grant",
    "v_authority_citation", "v_authority_treatment", "v_authority_section_version", "v_authority_pending_adverse",
)
ANY_TABLE_PRIVILEGE = "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER"
ANY_COLUMN_PRIVILEGE = "SELECT,INSERT,UPDATE,REFERENCES"
PROBE_TITLE = "F19 E2E Probe v. Test 2099"  # synthetic: no real authority is written
# 001's reader and the draft gate's reader (004's corpus_authority_reader, audit F05, #51 R1 D-3): neither
# application role is a member of either.
READER_ROLES = ("corpus_reader", "corpus_authority_reader")


def annex_a_page():
    """The synthetic "2099 SCMR <page>" the publication probes write (page, then page + 1). The e2e
    scripts pass E2E_ANNEX_A_PAGE so they can check the reader's view of the same rows."""
    raw = os.environ.get("E2E_ANNEX_A_PAGE", "")
    return int(raw) if raw.isdigit() else 10000 + int.from_bytes(os.urandom(2), "big")


async def _annex_a_inventory(engine):
    """(missing, privileged, owned): inventory relations that do not exist, that the current role
    holds any table or column privilege on (directly, through PUBLIC or an inherited role), and that
    it owns."""
    from sqlalchemy import text

    async with engine.connect() as conn:
        rows = (await conn.execute(text(
            "SELECT n, r IS NOT NULL, "
            "  coalesce(has_table_privilege(current_user, r, :tp) OR has_any_column_privilege(current_user, r, :cp), false), "
            "  coalesce((SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) "
            "            FROM pg_class c WHERE c.oid = r), false) "
            "FROM (SELECT n, to_regclass('public.' || n) AS r FROM unnest(CAST(:names AS text[])) AS n) s"
        ), {"names": list(ANNEX_A_RELATIONS), "tp": ANY_TABLE_PRIVILEGE, "cp": ANY_COLUMN_PRIVILEGE})).all()
    missing = [n for n, present, _p, _o in rows if not present]
    privileged = [n for n, _e, held, _o in rows if held]
    owned = [n for n, _e, _p, mine in rows if mine]
    return missing, privileged, owned


async def _in_rolled_back_tx(engine, sql, params=None, role=None):
    """Run ``sql`` (after SET LOCAL ROLE ``role``, if given) in a transaction that is always rolled
    back. Returns ("SUCCEEDED", first row or None), (SQLSTATE or exception class, None), or
    ("SET ROLE refused: <state>", None) when the role switch itself failed."""
    from sqlalchemy import text

    async with engine.connect() as conn:
        trans = await conn.begin()
        try:
            if role:
                try:
                    await conn.execute(text(f'SET LOCAL ROLE "{role}"'))
                except Exception as exc:  # noqa: BLE001 - reported by the caller
                    return f"SET ROLE refused: {sqlstate(exc) or type(exc).__name__}", None
            try:
                result = await conn.execute(text(sql), params or {})
                return "SUCCEEDED", (result.first() if result.returns_rows else None)
            except Exception as exc:  # noqa: BLE001 - classified by the caller
                return sqlstate(exc) or type(exc).__name__, None
        finally:
            await trans.rollback()


async def _publish_probe_batch(engine, expected, page):
    """publish_batch() of one synthetic trusted judgment, through the app's own engine (TLS, the
    runtime role, which switches to corpus_writer with SET LOCAL ROLE). Returns the judgment id."""
    import hashlib
    import uuid
    from datetime import datetime, timezone

    from sqlalchemy import text

    from scraper.publication.annex_a import publish_batch
    from scraper.publication.batch import BATCH_FORMAT, parse_batch_json

    body = f"synthetic F19 e2e probe text {page}"
    doc = {
        "format": BATCH_FORMAT, "batch_key": f"e2e/f19-2b/{uuid.uuid4()}", "source_kind": "curated",
        "items": [{
            "kind": "judgment", "item_key": "judgment", "trust": {"level": "trusted", "confidence": 0.9},
            "provenance": {
                "source_name": "f19-e2e-probe", "source_url": f"https://f19.example.invalid/e2e/{page}",
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "content_hash": hashlib.sha256(body.encode()).hexdigest(),
                "extraction_method": "html", "extractor_version": "f19-e2e",
            },
            "citations": [{"text": f"2099 SCMR {page}"}], "case_title": PROBE_TITLE,
            "bench_type": "Division Bench", "full_text": body,
        }],
    }
    label = ("publish_batch through the app's engine (TLS, runtime role -> SET LOCAL ROLE corpus_writer) "
             "promotes a trusted judgment into Annex A")
    try:
        async with engine.begin() as conn:
            result = await publish_batch(conn, parse_batch_json(json.dumps(doc).encode()), "e2e-probe:f19-2b")
            role_inside = (await conn.execute(text("SELECT current_user"))).scalar()
    except Exception as exc:  # noqa: BLE001
        check(label, False, f"{type(exc).__name__} {getattr(exc, 'code', '')} sqlstate={sqlstate(exc)}")
        return None
    primary = result.primary("judgment")
    check(label, primary.decision == "promoted" and primary.review_status == "promoted" and not result.already,
          f"decision={primary.decision} status={primary.review_status} reason={primary.reason}")
    role_after = await _scalar(engine, "SELECT current_user")
    check("the session role is the runtime role again after publish_batch (in its transaction and after COMMIT)",
          role_inside == expected and role_after == expected, f"inside={role_inside} after={role_after}")
    return primary.entity_id


async def _promote_probe_record(page):
    """The harvest path: a trusted staged record promoted by promote_staging_records() as the runtime
    role. Returns its Annex A judgment id."""
    from scraper.database import SessionLocal
    from scraper.models import ScraperSource, ScraperStaging
    from scraper.tasks.promotion import promote_staging_records

    async with SessionLocal() as db:
        src = ScraperSource(source_name=f"f19-e2e-{page}", source_url=f"https://f19.example.invalid/e2e/{page}",
                            trust_level="trusted")
        db.add(src)
        await db.flush()
        st = ScraperStaging(
            source_id=src.id, source_site=src.source_name,
            source_url=f"https://f19.example.invalid/e2e/{page}/judgment", extracted_title="F19 E2E Staged v. Test 2099",
            extracted_year=2099, extracted_citation=f"2099 SCMR {page + 1}",
            raw_text=f"synthetic F19 e2e staged text {page}", raw_html="<p>synthetic F19 e2e staged page</p>",
            extracted_bench_type="Division Bench", confidence_score=0.9, normalised=True,
        )
        db.add(st)
        await db.commit()
        staging_id = st.id
    counts = await promote_staging_records()
    check("promotion (promote_staging_records) as the runtime role publishes a trusted staged record into Annex A",
          counts == {"promoted": 1, "attached": 0, "quarantined": 0, "failed": 0}, json.dumps(counts))
    async with SessionLocal() as db:
        st = await db.get(ScraperStaging, staging_id)
        state = (st.promoted, st.quarantined, st.quarantine_reason, st.promoted_to_id)
    check("the staged record is closed promoted, pointing at its Annex A judgment",
          state[:3] == (True, False, None) and state[3] is not None, repr(state[:3]))
    return state[3]


async def annex_a_runtime(engine, expected):
    """PR 2b, Task B1: the runtime role reaches Annex A only as corpus_writer (SET ROLE, never
    inherited), holds nothing on Annex A directly, cannot touch the grant tables even as
    corpus_writer, and publishes only through an audited publication."""
    membership = await _scalar(
        engine,
        "SELECT coalesce(string_agg(format('inherit=%s set=%s admin=%s', m.inherit_option::text, m.set_option::text, "
        "m.admin_option::text), ';'), 'none') FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid "
        "WHERE g.rolname = 'corpus_writer' AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)")
    check("runtime role is a corpus_writer member WITH INHERIT FALSE, SET TRUE (pg_auth_members, PG16), no admin",
          membership == "inherit=false set=true admin=false", membership)
    missing, privileged, owned = await _annex_a_inventory(engine)
    check(f"Annex A is applied: all {len(ANNEX_A_RELATIONS)} inventory relations exist", not missing,
          "missing: " + ",".join(missing))
    check("runtime role holds no privilege on any Annex A relation (table or column, direct or inherited)",
          not privileged and not missing, "privileged: " + ",".join(privileged))
    check("runtime role owns no Annex A relation", not owned, ",".join(owned))
    for label, sql in (
        ("INSERT into an Annex A table (judgment)", f"INSERT INTO public.judgment (case_title) VALUES ('{PROBE_TITLE}')"),
        ("SELECT from an Annex A table (judgment)", "SELECT count(*) FROM public.judgment"),
        ("calling corpus_publication_begin directly",
         "SELECT * FROM public.corpus_publication_begin('e2e/direct', repeat('0', 64), 'curated', 'probe')"),
    ):
        state, _row = await _in_rolled_back_tx(engine, sql)
        check(f"runtime role, directly: {label} is refused (insufficient_privilege)", state == INSUFFICIENT_PRIVILEGE,
              f"result={state}")

    state, row = await _in_rolled_back_tx(engine, "SELECT current_user", role="corpus_writer")
    check("runtime role can SET ROLE corpus_writer", state == "SUCCEEDED" and row is not None and row[0] == "corpus_writer",
          f"result={state} row={row}")
    await _reader_roles_refused(engine, "runtime role")
    for label, sql, want in (
        ("INSERT into corpus_publication_grant", "INSERT INTO public.corpus_publication_grant DEFAULT VALUES",
         INSUFFICIENT_PRIVILEGE),
        ("INSERT into judgment_declassify_grant", "INSERT INTO public.judgment_declassify_grant DEFAULT VALUES",
         INSUFFICIENT_PRIVILEGE),
        ("UPDATE corpus_publication (the audit)", "UPDATE public.corpus_publication SET actor_id = actor_id WHERE false",
         INSUFFICIENT_PRIVILEGE),
        ("a promoted judgment written outside a publication",
         f"INSERT INTO public.judgment (case_title, review_status) VALUES ('{PROBE_TITLE}', 'promoted')", "SKP02"),
    ):
        state, _row = await _in_rolled_back_tx(engine, sql, role="corpus_writer")
        check(f"as corpus_writer: {label} is refused ({want})", state == want, f"result={state}")

    page = annex_a_page()
    published = await _publish_probe_batch(engine, expected, page)
    promoted = await _promote_probe_record(page)
    for label, jid in (("publish_batch", published), ("promotion", promoted)):
        state, row = await _in_rolled_back_tx(
            engine, "SELECT review_status, publication_id IS NOT NULL FROM public.judgment WHERE id = :id",
            {"id": jid}, role="corpus_writer")
        check(f"the {label} judgment is committed promoted in Annex A and carries its publication",
              jid is not None and state == "SUCCEEDED" and row is not None and tuple(row) == ("promoted", True),
              f"result={state} row={row}")
    check("runtime role is unchanged at the end (no role leaks into the pool)",
          await _scalar(engine, "SELECT current_user") == expected)


async def annex_a_migrate(engine):
    """PR 2b, Task B1: the migration role (schema owner) owns nothing of Annex A and cannot change it."""
    missing, privileged, owned = await _annex_a_inventory(engine)
    check(f"Annex A is applied: all {len(ANNEX_A_RELATIONS)} inventory relations exist", not missing,
          "missing: " + ",".join(missing))
    check("migration role owns no Annex A relation", not owned and not missing, "owned: " + ",".join(owned))
    check("migration role holds no privilege on any Annex A relation", not privileged, "privileged: " + ",".join(privileged))
    for label, sql in (
        ("ALTER TABLE judgment DISABLE TRIGGER judgment_publication_guard",
         "ALTER TABLE public.judgment DISABLE TRIGGER judgment_publication_guard"),
        ("DROP TRIGGER judgment_publication_guard", "DROP TRIGGER judgment_publication_guard ON public.judgment"),
        ("CREATE OR REPLACE FUNCTION corpus_publication_begin",
         "CREATE OR REPLACE FUNCTION public.corpus_publication_begin(p_batch_key text, p_input_sha256 text, "
         "p_source_kind text, p_actor_id text) RETURNS TABLE (publication_id uuid, already boolean) "
         "LANGUAGE sql AS $$ SELECT NULL::uuid, true $$"),
        ("GRANT corpus_writer to itself", "GRANT corpus_writer TO CURRENT_USER"),
    ):
        state, _row = await _in_rolled_back_tx(engine, sql)
        check(f"migration role: {label} is refused (insufficient_privilege)", state == INSUFFICIENT_PRIVILEGE,
              f"result={state}")
    await _reader_roles_refused(engine, "migration role")


async def _reader_roles_refused(engine, who):
    """Neither reader role can be taken on (SET ROLE needs a membership): a role that does not exist
    would be refused with invalid_parameter_value instead, so the reader roles must exist."""
    for reader in READER_ROLES:
        state, _row = await _in_rolled_back_tx(engine, "SELECT 1", role=reader)
        check(f"{who} cannot SET ROLE {reader} (not a member)", state == f"SET ROLE refused: {INSUFFICIENT_PRIVILEGE}",
              f"result={state}")


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
