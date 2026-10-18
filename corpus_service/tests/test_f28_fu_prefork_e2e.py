"""Audit F28, re-audit round 2, M1 and L3 in a real prefork worker child.

A real ``celery worker --pool=prefork -c 1`` subprocess runs the production Celery app
(``scraper.tasks.celery_app``) against a fresh real Postgres 16 + pgvector database migrated by
``python -m scraper.migrate``. Only the broker and result backend (kombu's filesystem transport and
Celery's file backend, so no Redis is needed) and the time limits (soft 3 s, hard 30 s instead of
3300 / 3600 s) are changed. The production engine (pool_size 20) is the one the child uses. Tasks are
sent by name with ``send_task``, as beat sends them, from a separate Celery app in this process. The
network edge is the F20/F28 seam: ``fetch_policy.fetcher_for`` answers PakistanCode's pages, one
statute slowly, so that billiard's soft time limit (SIGUSR1 from the pool parent) lands during that
fetch.

Spec: docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md, section 6 (R21-R25,
R27). Based on the re-audit's probe test_zz_reaudit2_f28_prefork.py. Synthetic fixtures only.
"""

import contextlib
import os
import subprocess
import sys
import textwrap
from pathlib import Path

from test_f20_trust_policy_db import assert_migrated, execute, run
from test_f28_source_outcomes_e2e import count, jobs, source_row

CORPUS = Path(__file__).resolve().parents[1]
RUN_SOURCE = "scraper.tasks.dispatcher.run_source_job"
CROSS_REFERENCE = "scraper.tasks.cross_reference.cross_reference_citations"

# The worker's app module: the production app with a filesystem broker and short time limits, and a
# PakistanCode network edge. F28_SLOW_MODE picks how the slow statute fetch waits: "await" (the event
# loop waits on I/O, the common case) or "block" (the thread is busy inside harvester code). The slow
# statute is read from <root>/slow_slug at each request, so a test can move it between runs
# (on main statutes_master was unique on short name and section, so a second run could not write the same act;
# since audit F21 the act is staged, and the test keeps moving the slow statute between runs).
APP_MODULE = '''
import asyncio, os, time, types
import httpx
from scraper.tasks import celery_app
from scraper.net import fetch_policy

ROOT = os.environ["F28_FS_ROOT"]
SLOW_MODE = os.environ.get("F28_SLOW_MODE", "await")


def slow_slug():
    with open(ROOT + "/slow_slug") as f:
        return f.read().strip()
app = celery_app.app
app.conf.update(
    broker_url="filesystem://", broker_use_ssl=None, redis_backend_use_ssl=None,
    broker_transport_options={"data_folder_in": ROOT + "/q", "data_folder_out": ROOT + "/q",
                              "processed_folder": ROOT + "/done", "store_processed": False,
                              "control_folder": ROOT + "/control"},
    result_backend="file://" + ROOT + "/results",
    task_soft_time_limit=3, task_time_limit=30, worker_hijack_root_logger=False,
)

PAGE = ("<html><body><h1>Synthetic F28 Act 2099</h1>"
        + "".join(f'<div class="section">Section {i}. Synthetic F28 statute text long enough.</div>' for i in range(3))
        + "</body></html>").encode()


class _Fetcher:
    policy = types.SimpleNamespace(name="PakistanCode")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def allows(self, url):
        return True

    async def get(self, url, *, headers=None):
        url = str(url)
        if url.endswith("/" + slow_slug()):  # the soft limit lands while this statute is fetched
            if SLOW_MODE == "await":
                await asyncio.sleep(20)
            else:
                time.sleep(20)
        return fetch_policy.FetchedResponse(url=url, status_code=200,
                                            headers=httpx.Headers({"content-type": "text/html"}), content=PAGE)


fetch_policy.fetcher_for = lambda name, **kw: _Fetcher()
'''


@contextlib.contextmanager
def prefork_worker(corpus_db, tmp_path, *, slow_mode="await", env=None):
    """Start the worker; yield ``send(task_name, *args) -> (state, result)`` and the log path."""
    from celery import Celery

    root = tmp_path / "fs"
    for d in ("q", "done", "results", "control"):  # kombu's control folder too: never the working tree
        (root / d).mkdir(parents=True)
    slow(root, "crpc1898")  # the second statute, after the first has written its 3 sections
    (tmp_path / "f28_fu_prefork_app.py").write_text(APP_MODULE)
    log_path = tmp_path / "worker.log"
    worker_env = {
        **os.environ, "F28_FS_ROOT": str(root), "F28_SLOW_MODE": slow_mode, "DATABASE_URL": corpus_db.url,
        "REDIS_URL": "redis://127.0.0.1:1/0", "ENVIRONMENT": "development",
        "PYTHONPATH": os.pathsep.join([str(tmp_path), str(CORPUS)]), **(env or {}),
    }
    sender = Celery("f28-fu-sender", broker="filesystem://", backend=f"file://{root}/results", set_as_current=False)
    sender.conf.update(broker_transport_options={
        "data_folder_in": f"{root}/q", "data_folder_out": f"{root}/q",
        "processed_folder": f"{root}/done", "store_processed": False, "control_folder": f"{root}/control",
    })

    def send(name, *args, slow_slug=None):
        if slow_slug:
            slow(root, slow_slug)
        result = sender.send_task(name, args=args)
        result.get(timeout=120, propagate=False)
        return result.state, result.result

    with open(log_path, "w") as log:
        worker = subprocess.Popen(
            [sys.executable, "-m", "celery", "-A", "f28_fu_prefork_app", "worker", "--pool=prefork", "-c", "1",
             "--loglevel=INFO", "-Q", "celery", "--without-gossip", "--without-mingle", "--without-heartbeat"],
            cwd=str(CORPUS), env=worker_env, stdout=log, stderr=subprocess.STDOUT, text=True,
        )
        try:
            yield send, log_path
        finally:
            worker.terminate()
            try:
                worker.wait(timeout=60)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()


def slow(root, slug):
    (root / "slow_slug").write_text(slug)


def worker_lines(log_path, marker):
    return [line for line in log_path.read_text().splitlines() if marker in line]


def alert_kinds(row):
    return sorted(a.split(":")[0] for a in (row.result_summary or {}).get("alerts", []))


def test_m1_a_time_limit_while_awaiting_is_recorded_counted_and_alerts_like_any_failure(corpus_db, tmp_path):
    """PakistanCode last succeeded 30 days ago (stale: 2 x 48 h). Two scheduled runs, three hours
    apart, each cut off by the soft limit while a statute fetch awaits: the first after it wrote its
    first act's 3 sections, the second on its first act. On main each row stayed `running` (the
    second run's sweep then closed the first as 'worker was lost', uncounted), the streak stayed 0
    and no alert fired, where two refused runs give 2 and 2 `stale` alerts
    (test_f28_fu_e2e.py::test_r25_control...). Spec R21, R24, R25."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    run(execute("UPDATE scraper_sources SET last_success_at = now() - interval '30 days' WHERE source_name = 'PakistanCode'"))

    with prefork_worker(corpus_db, tmp_path, slow_mode="await") as (send, log_path):
        first = send(RUN_SOURCE, "PakistanCode", slow_slug="crpc1898")
        run(execute("UPDATE scraper_jobs SET started_at = started_at - interval '3 hours'"))
        second = send(RUN_SOURCE, "PakistanCode", slow_slug="ppc1860")

    assert [(state, type(result).__name__) for state, result in (first, second)] == [
        ("FAILURE", "SoftTimeLimitExceeded"), ("FAILURE", "SoftTimeLimitExceeded"),
    ], (first, second, log_path.read_text()[-3000:])
    rows = jobs("PakistanCode")
    assert [(r.status, r.retry_count, r.pages_scraped, r.records_extracted, r.records_failed) for r in rows] == [
        ("failed", 0, 1, 3, 0), ("failed", 0, 0, 0, 0),
    ], f"each cut-off attempt is a failed row with what it wrote, never retried: {rows}"
    for row, written in zip(rows, (3, 0)):
        assert row.error_message == "RunInterrupted: time limit exceeded", row.error_message
        summary = row.result_summary
        assert (summary["outcome"], summary["reason"], summary["error_class"]) == (
            "failed", "time limit exceeded", "RunInterrupted"), summary
        assert (summary["interrupted_by"], summary["will_retry"], summary["written"]) == (
            "CancelledError", False, written), summary
        assert alert_kinds(row) == ["stale"], summary
    src = source_row("PakistanCode")
    assert src.consecutive_failures == 2, src
    assert src.last_failure_reason == "RunInterrupted: time limit exceeded", src
    assert src.last_scraped_at is not None and src.total_records_extracted == 3, src
    # Audit F21 (spec R12): the sections a run writes before the cut-off are staged, never written to master.
    assert (count("statutes_staging"), count("statutes_master")) == (3, 0)
    assert len(worker_lines(log_path, "F28 source alert: PakistanCode stale")) == 2, log_path.read_text()[-3000:]


def test_m1_a_time_limit_inside_harvester_code_is_not_counted_as_a_failed_statute(corpus_db, tmp_path):
    """The soft limit lands while harvester code runs (a blocking call inside the per-item `try`). On
    main the per-item `except Exception` counted it as one failed statute and the run went on to end
    `partial`, a SUCCESS that reset the streak. Spec R21, R23."""
    assert_migrated(corpus_db.migrate(), corpus_db)

    with prefork_worker(corpus_db, tmp_path, slow_mode="block") as (send, log_path):
        state, result = send(RUN_SOURCE, "PakistanCode")

    assert (state, type(result).__name__) == ("FAILURE", "SoftTimeLimitExceeded"), (state, result, log_path.read_text()[-3000:])
    rows = jobs("PakistanCode")
    assert [(r.status, r.pages_scraped, r.records_extracted, r.records_failed) for r in rows] == [("failed", 1, 3, 0)], rows
    summary = rows[0].result_summary
    assert (summary["reason"], summary["interrupted_by"], summary["errors"]) == (
        "time limit exceeded", "SoftTimeLimitExceeded", {}), summary
    src = source_row("PakistanCode")
    assert (src.consecutive_failures, src.last_failure_reason) == (1, "RunInterrupted: time limit exceeded"), src
    assert (count("statutes_staging"), count("statutes_master")) == (3, 0), "the run stopped at the time limit"


def test_l3_cross_reference_then_a_source_job_in_the_same_worker_child(corpus_db, tmp_path):
    """L3: one prefork child runs cross_reference, then PakistanLawSite (an idle import folder). On
    main cross_reference left a pooled connection bound to its closed event loop and the source job
    failed with InterfaceError: not retried, no row written, freshness unchanged. Spec R27."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    imports = tmp_path / "pls-imports"
    imports.mkdir()

    with prefork_worker(corpus_db, tmp_path, env={"PLS_IMPORT_DIR": str(imports), "PLS_API_KEY": ""}) as (send, log_path):
        cross = send(CROSS_REFERENCE)
        source = send(RUN_SOURCE, "PakistanLawSite")

    assert (cross[0], source[0]) == ("SUCCESS", "SUCCESS"), (cross, source, log_path.read_text()[-3000:])
    assert [(r.status, r.retry_count) for r in jobs("PakistanLawSite")] == [("completed", 0)]
    src = source_row("PakistanLawSite")
    assert (src.consecutive_failures, src.last_success_at is not None) == (0, True), src
    assert worker_lines(log_path, "InterfaceError") == []
