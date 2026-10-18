"""Audit F31 end-to-end: the corpus runtime starts from requirements.txt alone.

Runs INSIDE a clean venv built from corpus_service/requirements.txt only (tests/e2e/runtime_smoke.sh
builds it), with cwd corpus_service/ (the image's WORKDIR /app). Against real PostgreSQL 16 with
pgvector it runs the compose entry points the production image runs:

  1. guard: pytest is not installed (not the test environment); every requirements.txt
     distribution is installed (the venv was built from it); no local .env (the image has none)
  2. the strict import contract (tests/import_contract.py --strict)
  3. python -c "import scraper.models"            (the finding: pgvector.sqlalchemy)
  4. every module under scraper/ imports
  5. python -m scraper.migrate                     (compose `migrate`) on a fresh database
  6. uvicorn scraper.main:app                      (compose `api`), then GET /health: db_connected
  7. celery -A scraper.tasks.celery_app report     (the -A target of worker-embed and celery-beat),
     plus the app's Redis broker transport and result backend and its beat tasks

On main (no pgvector in requirements.txt) steps 2 to 7 fail with ModuleNotFoundError: pgvector.
No Redis server is used: a live broker round trip is the F30 compose e2e; this proves the
dependency set (building the transport and backend loads the redis client library).

    CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://<superuser>@<host>:<port>/<db> python tests/e2e/runtime_smoke.py

Spec: docs/superpowers/specs/2026-10-18-f31-corpus-runtime-dependencies-design.md (R4).
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import importlib.util
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parents[1]
BIN = Path(sys.executable).parent
sys.path.insert(0, str(PROJECT_ROOT / "tests"))

import import_contract as ic  # noqa: E402  (stdlib-only helper shared with the pytest contract test)

FAILURES: list = []
SECRETS: list = []
CHILD_TIMEOUT = 300


def redact(text: str) -> str:
    for secret in SECRETS:
        if secret:
            text = text.replace(secret, "<redacted>")
    return text


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"{'PASS' if ok else 'FAIL'}  {label}", flush=True)
    if not ok:
        FAILURES.append(label)
        if detail:
            for line in redact(detail).strip().splitlines()[-25:]:
                print(f"      {line}", flush=True)
    return ok


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run(argv, env, timeout=CHILD_TIMEOUT) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(argv, cwd=str(PROJECT_ROOT), env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        return subprocess.CompletedProcess(argv, 124, exc.stdout or "", f"timed out after {timeout}s\n{exc.stderr or ''}")


# -- database ------------------------------------------------------------------------------------


def _plain_dsn(url) -> str:
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


async def _admin(admin_url, statements) -> None:
    import asyncpg

    conn = await asyncpg.connect(_plain_dsn(admin_url))
    try:
        for sql in statements:
            await conn.execute(sql)
    finally:
        await conn.close()


async def _fetch(url, sql):
    import asyncpg

    conn = await asyncpg.connect(_plain_dsn(url))
    try:
        return await conn.fetchval(sql)
    finally:
        await conn.close()


# -- steps ---------------------------------------------------------------------------------------


def step_guard() -> None:
    print(f"--    python {sys.version.split()[0]} at {sys.prefix}", flush=True)
    check("runtime venv is not the test environment (pytest is not installed)", importlib.util.find_spec("pytest") is None,
          f"pytest found at {getattr(importlib.util.find_spec('pytest'), 'origin', '?')}")
    declared = ic.parse_requirements((PROJECT_ROOT / "requirements.txt").read_text(encoding="utf-8"))
    installed = {ic.normalize(d.metadata["Name"]): d.version for d in importlib.metadata.distributions()}
    missing = sorted(declared - set(installed))
    check(f"every distribution requirements.txt declares is installed ({len(declared)} declared, "
          f"{len(installed)} installed)", not missing, f"missing: {missing}")
    for name in ("pgvector", "sqlalchemy", "asyncpg", "fastapi", "uvicorn", "celery", "redis"):
        print(f"--    {name} {installed.get(name, 'NOT INSTALLED')}", flush=True)
    check("no corpus_service/.env (the image never carries one: .dockerignore)", not (PROJECT_ROOT / ".env").exists())


def step_contract() -> None:
    problems = ic.check(PROJECT_ROOT, strict=True)
    check("strict import contract: every third-party import is installed here and declared in requirements.txt",
          not problems, "\n".join(problems))


def step_models(env) -> None:
    proc = run([sys.executable, "-c", "import scraper.models"], env)
    check("python -c 'import scraper.models' (pgvector.sqlalchemy)", proc.returncode == 0, proc.stderr)


_IMPORT_ALL = r"""
import importlib, json, sys, traceback
failed = {}
for name in json.loads(sys.argv[1]):
    try:
        importlib.import_module(name)
    except BaseException as exc:  # report every module, not only the first failure
        failed[name] = "".join(traceback.format_exception_only(type(exc), exc)).strip()
print(json.dumps(failed))
"""


def runtime_modules():
    """Dotted names of the modules under scraper/, from the files. A file whose dotted name is
    shadowed by a module of the same name (scraper/auth/*.py next to scraper/auth.py) cannot be
    imported by any name; it is listed, not imported."""
    names, shadowed = [], []
    for path in ic.iter_runtime_files(PROJECT_ROOT, ("scraper",)):
        rel = path.relative_to(PROJECT_ROOT).with_suffix("")
        parts = list(rel.parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        if any((PROJECT_ROOT.joinpath(*parts[:i]).with_suffix(".py")).is_file() for i in range(1, len(parts))):
            shadowed.append(".".join(parts))
            continue
        names.append(".".join(parts))
    return names, shadowed


def step_import_all(env) -> None:
    names, shadowed = runtime_modules()
    for name in shadowed:
        print(f"NOTE  {name} is shadowed by a module of the same dotted prefix and cannot be imported "
              f"(no importers; not a dependency question)", flush=True)
    proc = run([sys.executable, "-c", _IMPORT_ALL, json.dumps(names)], env)
    try:
        failed = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.returncode == 0 else None
    except (ValueError, IndexError):
        failed = None
    if failed is None:
        check(f"every scraper module imports ({len(names)} modules)", False, proc.stderr or proc.stdout)
        return
    check(f"every scraper module imports ({len(names)} modules)", not failed,
          "\n".join(f"{k}: {v.splitlines()[-1]}" for k, v in sorted(failed.items())))


def step_migrate(env, db_url) -> None:
    proc = run([sys.executable, "-m", "scraper.migrate"], {**env, "REDIS_URL": ""})
    if not check("python -m scraper.migrate (compose `migrate`) on a fresh database", proc.returncode == 0, proc.stderr):
        return
    try:
        sources = asyncio.run(_fetch(db_url, "SELECT count(*) FROM scraper_sources"))
        tables = asyncio.run(_fetch(db_url, "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY("
                                            "ARRAY['courts','scraper_sources','case_law_master','statutes_master','scraper_staging',"
                                            "'statutes_staging','scraper_jobs','quarantine_queue','embedding_queue'])"))
    except Exception as exc:  # noqa: BLE001
        check("migrate created the ORM tables and seeded the sources", False, f"{type(exc).__name__}: {exc}")
        return
    check(f"migrate created the ORM tables and seeded the sources ({tables}/9 tables, {sources} sources)",
          tables == 9 and (sources or 0) > 0)


def step_api(env) -> None:
    port = free_port()
    log = tempfile.NamedTemporaryFile(prefix="f31-uvicorn-", suffix=".log", delete=False)
    argv = [str(BIN / "uvicorn"), "scraper.main:app", "--host", "127.0.0.1", "--port", str(port)]
    proc = subprocess.Popen(argv, cwd=str(PROJECT_ROOT), env=env, stdout=log, stderr=subprocess.STDOUT)
    body, error = None, ""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback: never through a proxy
    deadline = time.time() + 180
    try:
        while time.time() < deadline and proc.poll() is None:
            try:
                with opener.open(f"http://127.0.0.1:{port}/health", timeout=10) as res:
                    body = json.loads(res.read().decode())
                    break
            except Exception as exc:  # noqa: BLE001 - still starting
                error = f"{type(exc).__name__}: {exc}"
                time.sleep(1)
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        log.close()
    output = Path(log.name).read_text(encoding="utf-8", errors="replace")
    os.unlink(log.name)
    if not check("uvicorn scraper.main:app (compose `api`) starts and answers GET /health", body is not None,
                 f"exit={proc.returncode} last error={error}\n{output}"):
        return
    check(f"/health reaches PostgreSQL (status ok, db_connected true, total_cases 0): {json.dumps(body)}",
          body.get("status") == "ok" and body.get("db_connected") is True and body.get("total_cases") == 0, output)


_CELERY_PROBE = r"""
import json
from scraper.tasks.celery_app import app
backend = app.backend                         # Celery's Redis result backend (needs the redis library)
transport = app.connection_for_write().transport  # kombu's Redis transport (needs the redis library); no I/O
beat = sorted({entry["task"] for entry in app.conf.beat_schedule.values()})
print(json.dumps({
    "backend": type(backend).__module__ + "." + type(backend).__name__,
    "transport": type(transport).__module__ + "." + type(transport).__name__,
    "unregistered_beat_tasks": [t for t in beat if t not in app.tasks],
    "beat_tasks": beat,
}))
"""


def step_celery(env) -> None:
    proc = run([str(BIN / "celery"), "-A", "scraper.tasks.celery_app", "report"], env)
    # The report names the broker transport and its client library ("redis:<version>" on the
    # software line, empty when the library is missing) and lists the app's beat schedule.
    out = proc.stdout
    check("celery -A scraper.tasks.celery_app report (the worker-embed / celery-beat app) loads the app "
          "with the redis transport and its beat schedule",
          proc.returncode == 0 and "transport:redis" in out and re.search(r"\bredis:\d", out) is not None
          and "scraper.tasks.dispatcher.run_source_job" in out, proc.stderr or out)
    proc = run([sys.executable, "-c", _CELERY_PROBE], env)
    try:
        info = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.returncode == 0 else None
    except (ValueError, IndexError):
        info = None
    if not check("Celery app loads with its Redis broker transport and result backend", info is not None, proc.stderr):
        return
    check(f"Celery uses redis for broker and results ({info['transport']}, {info['backend']})",
          info["transport"] == "kombu.transport.redis.Transport" and info["backend"] == "celery.backends.redis.RedisBackend")
    check(f"every beat-scheduled task is registered ({len(info['beat_tasks'])})", not info["unregistered_beat_tasks"],
          f"unregistered: {info['unregistered_beat_tasks']}")


def main() -> int:
    admin = os.environ.get("CORPUS_TEST_DATABASE_URL", "").strip()
    if not admin:
        print("FAIL  CORPUS_TEST_DATABASE_URL is required (a superuser postgresql+asyncpg:// URL, PostgreSQL 16 + pgvector)")
        return 2
    step_guard()
    step_contract()

    from sqlalchemy.engine import make_url

    admin_url = make_url(admin)
    SECRETS.append(admin_url.password or "")
    name = f"f31_smoke_{secrets.token_hex(6)}"
    db_url = admin_url.set(database=name)
    env = {k: v for k, v in os.environ.items() if k not in {"APP_ENV", "CELERY_BROKER_URL", "CELERY_RESULT_BACKEND"}}
    env.update({
        "ENVIRONMENT": "development",
        "SKIP_DIR_CREATE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "DATABASE_URL": db_url.render_as_string(hide_password=False),
        # Celery needs a broker URL to build its app; nothing listens here and nothing connects.
        "REDIS_URL": f"redis://127.0.0.1:{free_port()}/0",
    })
    env.pop("CORPUS_TEST_DATABASE_URL", None)

    step_models(env)
    step_import_all(env)
    try:
        asyncio.run(_admin(admin_url, [f'CREATE DATABASE "{name}"']))
    except Exception as exc:  # noqa: BLE001
        check(f"create the smoke database {name}", False, f"{type(exc).__name__}: {exc}")
        name = None
    try:
        if name:
            step_migrate(env, db_url)
            step_api(env)
        step_celery(env)
    finally:
        if name:
            try:
                asyncio.run(_admin(admin_url, [f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)']))
            except Exception as exc:  # noqa: BLE001
                print(f"NOTE  could not drop {name}: {redact(str(exc))}")

    print(f"== F31 runtime smoke: {f'FAILED, {len(FAILURES)} check(s) failed' if FAILURES else 'all checks passed'}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
