"""Audit F28, re-audit round 2, end to end in process: the sweep that closes abandoned runs (M1, R24),
the refused-run stale control (R25), an interrupted embedding batch (R26), cross_reference on the
pooled engine (L3, R27), a database DNS blip (L4, R28), listing failures (L1, R30) and the nine
behaviours the shipped tests did not pin (L6).

The flow is test_f28_source_outcomes_e2e.py's: a real beat schedule entry, its task run in process
with ``Task.apply`` (eager retries), the real dispatcher, harvesters and fetch boundary, and a fresh
real Postgres 16 + pgvector database migrated by ``python -m scraper.migrate``. The network edge is
that file's seams (a resolver hook, or ``fetch_policy.fetcher_for`` answering canned routes after the
source's real policy has checked each URL). The real prefork worker cases (the time limit itself, and
cross_reference in a worker child) are test_f28_fu_prefork_e2e.py.

Spec: docs/superpowers/specs/2026-10-18-f28-source-failure-outcomes-design.md, section 6. Expected
values are written out from the spec. Synthetic fixtures only.
"""

import asyncio
import contextlib
import logging
import signal
import socket

import httpx
import pytest

from test_f20_trust_policy_db import assert_migrated, execute, fetch, run
from test_f28_source_outcomes_e2e import (
    READABLE_PDF,
    SHC_LISTING,
    SHC_PDF,
    _queue_one_statute,
    _shc_routes,
    boundary_with_resolver,
    canned_network,
    count,
    fire,
    idle_import_folder,
    install_provider,
    jobs,
    no_sleep,
    private_answer,
    queue_state,
    source_row,
    text_layer_for_fixtures,
)

ABANDONED = "abandoned: still running 2 hours after it started, with no outcome recorded; cause unknown"
REAL_SLEEP = asyncio.sleep


def alert_kinds(row):
    return sorted(a.split(":")[0] for a in (row.result_summary or {}).get("alerts", []))


def alert_lines(caplog, source):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith(f"F28 source alert: {source} ")]


def broken_pakistanlawsite(monkeypatch):
    import scraper.tasks.pakistanlawsite as pls

    async def broken(source, db):  # a bug: a failure that is not retried
        raise RuntimeError("synthetic F28 harvester bug")

    monkeypatch.setattr(pls, "scrape_pakistanlawsite", broken)


# ---------------------------------------------------------------------------------------------
# M1 / R24: the sweep counts what it closes and alerts
# ---------------------------------------------------------------------------------------------
def test_r24_abandoned_attempts_count_toward_the_streak_and_raise_the_failing_alert(corpus_db, monkeypatch, caplog):
    """Three attempts in a row were lost (their rows were left running: a hard kill, a restart). The
    next attempt sweeps them, then fails itself. On main the sweep counted nothing: the streak read 1
    and no `failing` alert was raised, and the closed rows claimed 'its worker was lost'."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    run(execute(
        "INSERT INTO scraper_jobs (source_site, job_type, status, started_at, celery_task_id) VALUES "
        "('PakistanLawSite', 'incremental', 'running', now() - interval '30 hours', 'f28-lost-1'), "
        "('PakistanLawSite', 'incremental', 'running', now() - interval '20 hours', 'f28-lost-2'), "
        "('PakistanLawSite', 'incremental', 'running', now() - interval '10 hours', 'f28-lost-3')"
    ))
    broken_pakistanlawsite(monkeypatch)

    with caplog.at_level(logging.ERROR):
        result = fire("scrape-pakistanlawsite")

    assert result.state == "FAILURE" and type(result.result).__name__ == "RuntimeError", repr(result.result)
    rows = jobs("PakistanLawSite")
    assert [(r.celery_task_id or "this", r.status) for r in rows][:3] == [
        ("f28-lost-1", "failed"), ("f28-lost-2", "failed"), ("f28-lost-3", "failed"),
    ], rows
    for swept in rows[:3]:
        assert swept.error_message == ABANDONED, swept.error_message
        assert swept.result_summary["outcome"] == "failed" and swept.result_summary["reason"] == "abandoned"
        assert alert_kinds(swept) == ["failing"], swept.result_summary
    assert (rows[3].status, alert_kinds(rows[3])) == ("failed", ["failing"]), rows[3]
    src = source_row("PakistanLawSite")
    assert src.consecutive_failures == 4, src
    assert src.last_failure_reason == "RuntimeError: synthetic F28 harvester bug", src
    logged = alert_lines(caplog, "PakistanLawSite")
    assert "F28 source alert: PakistanLawSite failing: 3 consecutive failed attempts" in logged, logged
    assert "F28 source alert: PakistanLawSite failing: 4 consecutive failed attempts" in logged, logged


def test_r24_a_row_abandoned_before_the_last_success_is_closed_but_not_counted(corpus_db, monkeypatch):
    """The source last succeeded 150 minutes ago. A row started 4 hours ago (before that success) and
    a row started 140 minutes ago (after it) are both still running: both are closed, only the second
    belongs to the current streak."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    run(execute(
        "UPDATE scraper_sources SET last_success_at = now() - interval '150 minutes', consecutive_failures = 0 "
        "WHERE source_name = 'PakistanLawSite'",
        "INSERT INTO scraper_jobs (source_site, job_type, status, started_at, celery_task_id) VALUES "
        "('PakistanLawSite', 'incremental', 'running', now() - interval '4 hours', 'f28-before-success'), "
        "('PakistanLawSite', 'incremental', 'running', now() - interval '140 minutes', 'f28-after-success')",
    ))
    broken_pakistanlawsite(monkeypatch)

    fire("scrape-pakistanlawsite")

    state = dict(run(fetch(
        "SELECT celery_task_id, status FROM scraper_jobs WHERE celery_task_id LIKE 'f28-%-success'"
    )))
    assert state == {"f28-before-success": "failed", "f28-after-success": "failed"}, state
    src = source_row("PakistanLawSite")
    assert src.consecutive_failures == 2, f"the swept row after the success and the failed run: {src}"


def test_x1_the_sweep_closes_only_incremental_rows_of_the_source(corpus_db, monkeypatch, tmp_path):
    """L6 X1: the sweep is scoped to the source's own `incremental` rows; a `full_scrape` row of the same
    source and an `incremental` row of another source are left alone."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    idle_import_folder(monkeypatch, tmp_path)
    run(execute(
        "INSERT INTO scraper_jobs (source_site, job_type, status, started_at, celery_task_id) VALUES "
        "('PakistanLawSite', 'incremental', 'running', now() - interval '3 hours', 'f28-x1-incremental'), "
        "('PakistanLawSite', 'full_scrape', 'running', now() - interval '3 hours', 'f28-x1-full'), "
        "('NasirLawSite', 'incremental', 'running', now() - interval '3 hours', 'f28-x1-other-source')"
    ))

    result = fire("scrape-pakistanlawsite")

    assert result.state == "SUCCESS", repr(result.result)
    state = dict(run(fetch("SELECT celery_task_id, status FROM scraper_jobs WHERE celery_task_id LIKE 'f28-x1-%'")))
    assert state == {
        "f28-x1-incremental": "failed", "f28-x1-full": "running", "f28-x1-other-source": "running",
    }, state
    assert source_row("NasirLawSite").consecutive_failures == 0


def test_r25_control_two_refused_runs_on_a_stale_source_alert_twice(corpus_db, monkeypatch, caplog):
    """The re-audit's control for M1 (passes on main): PakistanCode last succeeded 30 days ago and two
    scheduled runs, three hours apart, are refused at the index. consecutive_failures 2 and 2 `stale`
    alerts. test_f28_fu_prefork_e2e.py requires exactly these numbers of two time-limited runs."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    run(execute("UPDATE scraper_sources SET last_success_at = now() - interval '30 days' WHERE source_name = 'PakistanCode'"))
    boundary_with_resolver(monkeypatch, private_answer([]))
    no_sleep(monkeypatch)

    with caplog.at_level(logging.ERROR):
        first = fire("scrape-pakistancode")
        run(execute("UPDATE scraper_jobs SET started_at = started_at - interval '3 hours'"))
        second = fire("scrape-pakistancode")

    assert (first.state, second.state) == ("FAILURE", "FAILURE")
    rows = jobs("PakistanCode")
    assert [(r.status, alert_kinds(r)) for r in rows] == [("failed", ["stale"]), ("failed", ["stale"])], rows
    assert source_row("PakistanCode").consecutive_failures == 2
    assert len([m for m in alert_lines(caplog, "PakistanCode") if " stale: " in m]) == 2


def test_r21_a_time_limit_while_the_record_is_written_is_reported_as_the_time_limit(corpus_db, monkeypatch, tmp_path, caplog):
    """The run itself finished; the soft limit lands while its record is written. The task reports
    the time limit (not RunRecordFailed, which would claim the record write failed on its own), the
    row stays running and the sweep closes it later (R24)."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    from celery.exceptions import SoftTimeLimitExceeded

    from scraper.tasks import job_record

    idle_import_folder(monkeypatch, tmp_path)

    async def cut_off(*args, **kwargs):
        raise SoftTimeLimitExceeded()

    monkeypatch.setattr(job_record, "finish_completed", cut_off)

    with caplog.at_level(logging.ERROR):
        result = fire("scrape-pakistanlawsite")

    assert result.state == "FAILURE" and type(result.result).__name__ == "SoftTimeLimitExceeded", repr(result.result)
    assert [(r.status, r.retry_count) for r in jobs("PakistanLawSite")] == [("running", 0)]
    assert not any(r.getMessage().startswith("F28 run record failed") for r in caplog.records)


# ---------------------------------------------------------------------------------------------
# M1 / R26: an embedding batch cut off by the time limit
# ---------------------------------------------------------------------------------------------
@contextlib.contextmanager
def soft_limit_on_sigalrm():
    """billiard's soft_timeout_sighandler, installed on SIGALRM (the re-audit probe's emulation; the
    real prefork child is test_f28_fu_prefork_e2e.py). The app is finalised first so the signal
    cannot land in Celery's own lazy set-up."""
    from celery.exceptions import SoftTimeLimitExceeded

    from scraper.tasks import celery_app

    celery_app.app.finalize(auto=True)

    def handler(signum, frame):
        raise SoftTimeLimitExceeded()

    previous = signal.signal(signal.SIGALRM, handler)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def test_r26_an_interrupted_embedding_batch_is_recorded_and_its_item_is_untouched(corpus_db, monkeypatch):
    """The provider call is in flight when the soft limit lands. On main the batch's `except
    Exception` never saw the CancelledError: no `embed` row was written."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    statute_id = _queue_one_statute()
    install_provider(monkeypatch, fail=False)
    import openai  # the in-process provider module installed above

    async def slow_create(self, model, input):
        signal.setitimer(signal.ITIMER_REAL, 0.3)  # the soft limit lands while this call awaits
        await REAL_SLEEP(3)
        raise AssertionError("the time limit should have cut this call off")

    monkeypatch.setattr(type(openai.AsyncOpenAI(api_key="x").embeddings), "create", slow_create)

    with soft_limit_on_sigalrm():
        result = fire("process-embeddings")

    assert result.state == "FAILURE" and type(result.result).__name__ == "SoftTimeLimitExceeded", repr(result.result)
    assert queue_state(statute_id) == [("pending", 0, False)], "the interrupted item is neither done nor charged"
    rows = jobs("embedding_queue", job_type="embed")
    assert [(r.status, r.pages_scraped, r.records_extracted, r.records_failed) for r in rows] == [("failed", 0, 0, 0)], rows
    assert rows[0].error_message == "RunInterrupted: time limit exceeded", rows[0].error_message
    summary = rows[0].result_summary
    assert (summary["outcome"], summary["claimed"], summary["interrupted_by"]) == ("failed", 1, "CancelledError"), summary


# ---------------------------------------------------------------------------------------------
# L3 / R27: cross_reference on the pooled engine, then the next task
# ---------------------------------------------------------------------------------------------
def test_l3_cross_reference_then_a_source_job_on_the_pooled_engine(corpus_db, monkeypatch, tmp_path, caplog):
    """A worker child runs cross_reference and then a source job, each in a new event loop, on the
    application's pooled engine. On main cross_reference left a connection bound to its closed loop
    and the source job's first query failed: not retried, no row, freshness unchanged."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    from scraper import database

    idle_import_folder(monkeypatch, tmp_path)
    fixture_engine = database.engine
    pooled = database.build_engine(corpus_db.url)  # the production engine: pool_size 20
    monkeypatch.setattr(database, "engine", pooled)
    database.SessionLocal.configure(bind=pooled)
    try:
        with caplog.at_level(logging.WARNING):
            cross = fire("cross-ref")
            source = fire("scrape-pakistanlawsite")
    finally:
        with contextlib.suppress(Exception):
            run(pooled.dispose())
        monkeypatch.setattr(database, "engine", fixture_engine)
        database.SessionLocal.configure(bind=fixture_engine)

    assert (cross.state, source.state) == ("SUCCESS", "SUCCESS"), (cross.result, source.result)
    failures = [r.getMessage() for r in caplog.records if r.getMessage().startswith("Job failed for")]
    assert failures == [], failures
    assert [(r.status, r.retry_count) for r in jobs("PakistanLawSite")] == [("completed", 0)]
    assert source_row("PakistanLawSite").last_success_at is not None


# ---------------------------------------------------------------------------------------------
# L4 / R28: a transient DNS failure on the database host is retried to the bound
# ---------------------------------------------------------------------------------------------
def test_l4_a_database_dns_blip_at_job_start_is_retried_to_the_bound(corpus_db, monkeypatch):
    """The database host's lookup fails with EAI_AGAIN ("temporary failure in name resolution") when
    the job opens its first connection (the re-audit probe). On main: 1 attempt, not retried."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    from scraper import database

    host = "corpus-db.f28.invalid"
    fixture_engine = database.engine
    engine = corpus_db.engine_for(corpus_db.url.replace("127.0.0.1", host).replace("localhost", host))
    monkeypatch.setattr(database, "engine", engine)
    database.SessionLocal.configure(bind=engine)
    lookups = []
    real = asyncio.base_events.BaseEventLoop.getaddrinfo

    async def flaky(self, name, *args, **kwargs):
        if name == host:
            lookups.append(name)
            raise socket.gaierror(socket.EAI_AGAIN, "Temporary failure in name resolution")
        return await real(self, name, *args, **kwargs)

    monkeypatch.setattr(asyncio.base_events.BaseEventLoop, "getaddrinfo", flaky)
    try:
        result = fire("scrape-pakistanlawsite")
    finally:
        monkeypatch.setattr(database, "engine", fixture_engine)
        database.SessionLocal.configure(bind=fixture_engine)

    assert result.state == "FAILURE", repr(result.result)
    assert len(lookups) == 4, f"a transient lookup failure is retried to the bound (1 + 3 attempts): {lookups}"
    assert jobs("PakistanLawSite") == [], "no attempt could open the database, so none could be recorded"


# ---------------------------------------------------------------------------------------------
# L1 / R30: listing failures are recorded; Nasir's reporters make the run partial
# ---------------------------------------------------------------------------------------------
NASIR_REPORTERS = [
    "https://www.nasirlawsite.com/case/scmr.htm",
    "https://www.nasirlawsite.com/case/pld.htm",
    "https://www.nasirlawsite.com/case/clc.htm",
    "https://www.nasirlawsite.com/case/ylr.htm",
    "https://www.nasirlawsite.com/case/mld.htm",
]


def test_l1_a_court_run_records_its_failed_listing_pages_without_changing_the_outcome(corpus_db, monkeypatch):
    """SHC: the judgments page loads and links nothing; the other three seeds answer 404. On main the
    run was recorded as an error-free empty run. R17 stands: it stays `empty`, with the listing
    failures recorded."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)
    canned_network(monkeypatch, {SHC_LISTING: (200, b"<html><body>No judgments today.</body></html>")})

    result = fire("scrape-shc-public")

    assert result.state == "SUCCESS", repr(result.result)
    summary = jobs("SindhHighCourtPublic")[0].result_summary
    assert (summary["outcome"], summary["attempted"], summary["discovery_failed"]) == ("empty", 0, 0), summary
    assert summary["discovery_errors"] == {"listing:http_404": 3}, summary


def test_l1_nasir_with_four_of_five_reporters_down_is_partial_not_empty(corpus_db, monkeypatch):
    """Nasir's five reporters are fixed, live listings (R30): four answer 503, one loads and links no
    case. On main: an error-free `empty` run."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)
    routes = {url: (503, b"Service Unavailable") for url in NASIR_REPORTERS[1:]}
    routes[NASIR_REPORTERS[0]] = (200, b"<html><title>F28 SCMR</title><body>Nothing new.</body></html>")
    canned_network(monkeypatch, routes)

    result = fire("scrape-nasirlawsite")

    assert result.state == "SUCCESS", repr(result.result)
    rows = jobs("NasirLawSite")
    assert [(r.status, r.records_extracted) for r in rows] == [("completed", 0)], rows
    summary = rows[0].result_summary
    assert (summary["outcome"], summary["discovery_failed"]) == ("partial", 4), summary
    assert summary["discovery_errors"] == {"listing:http_503": 4}, summary


# ---------------------------------------------------------------------------------------------
# L6: behaviours the shipped tests did not pin (mutants J1, D2, D3, H2, H4, H5, X6, X7; X1 above)
# ---------------------------------------------------------------------------------------------
def test_j1_a_success_resets_the_failure_streak(corpus_db, monkeypatch, tmp_path):
    assert_migrated(corpus_db.migrate(), corpus_db)
    idle_import_folder(monkeypatch, tmp_path)
    run(execute(
        "UPDATE scraper_sources SET consecutive_failures = 5, last_failure_reason = 'RuntimeError: earlier' "
        "WHERE source_name = 'PakistanLawSite'"
    ))

    result = fire("scrape-pakistanlawsite")

    assert result.state == "SUCCESS", repr(result.result)
    src = source_row("PakistanLawSite")
    assert (src.consecutive_failures, src.last_success_at is not None) == (0, True), src


def test_d2_a_source_with_no_row_is_refused_not_skipped(corpus_db):
    assert_migrated(corpus_db.migrate(), corpus_db)
    run(execute("DELETE FROM scraper_sources WHERE source_name = 'NasirLawSite'"))

    result = fire("scrape-nasirlawsite")

    assert result.state == "FAILURE" and type(result.result).__name__ == "SourceRefused", repr(result.result)
    rows = jobs("NasirLawSite")
    assert [(r.status, r.retry_count) for r in rows] == [("failed", 0)], f"refused once, never retried: {rows}"
    summary = rows[0].result_summary
    assert (summary["reason"], summary["error_class"], summary["retryable"]) == ("source_not_found", "SourceRefused", False)


def test_d3_a_source_with_no_route_is_refused_not_skipped(corpus_db):
    assert_migrated(corpus_db.migrate(), corpus_db)
    run(execute(
        "INSERT INTO scraper_sources (source_name, source_url, trust_level, is_active) "
        "VALUES ('F28UnroutedSource', 'https://f28.example.invalid/', 'review', true)"
    ))
    from scraper.tasks import celery_app

    result = celery_app.app.tasks["scraper.tasks.dispatcher.run_source_job"].apply(args=("F28UnroutedSource",))

    assert result.state == "FAILURE" and type(result.result).__name__ == "SourceRefused", repr(result.result)
    rows = jobs("F28UnroutedSource")
    assert [(r.status, r.retry_count, r.result_summary["reason"]) for r in rows] == [("failed", 0, "no_harvester")], rows
    assert source_row("F28UnroutedSource").consecutive_failures == 1


def test_h2_shc_counts_a_pdf_that_is_not_a_200_as_a_failed_document(corpus_db, monkeypatch):
    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)
    text_layer_for_fixtures(monkeypatch)
    routes = _shc_routes({1: READABLE_PDF, 2: READABLE_PDF})
    del routes[SHC_PDF.format(n=2)]  # linked from the listing, answers 404
    canned_network(monkeypatch, routes)

    result = fire("scrape-shc-public")

    assert result.state == "SUCCESS", repr(result.result)
    rows = jobs("SindhHighCourtPublic")
    assert [(r.status, r.records_extracted, r.records_failed) for r in rows] == [("completed", 1, 1)], rows
    summary = rows[0].result_summary
    assert (summary["outcome"], summary["errors"]) == ("partial", {"http_404": 1}), summary
    assert count("scraper_staging") == 1


def test_h4_nasir_counts_reporter_exceptions_and_fails_when_every_reporter_fails(corpus_db, monkeypatch):
    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)
    canned_network(monkeypatch, {url: httpx.ConnectError("synthetic F28 connect failure") for url in NASIR_REPORTERS})

    result = fire("scrape-nasirlawsite")

    assert result.state == "FAILURE" and type(result.result).__name__ == "SourceRunFailed", repr(result.result)
    rows = jobs("NasirLawSite")
    assert [r.status for r in rows] == ["failed"] * 4, f"ConnectError is transient: retried to the bound: {rows}"
    summary = rows[-1].result_summary
    assert (summary["reason"], summary["errors"]) == ("every listing request failed", {"ConnectError": 5}), summary


def test_h5_pakistancode_counts_a_slug_that_is_not_a_200_as_a_failed_document(corpus_db, monkeypatch):
    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)
    canned_network(monkeypatch, {"https://pakistancode.gov.pk/federal": (200, b"<html>index</html>")})

    result = fire("scrape-pakistancode")

    assert result.state == "FAILURE" and type(result.result).__name__ == "SourceRunFailed", repr(result.result)
    rows = jobs("PakistanCode")
    assert [(r.status, r.pages_scraped, r.records_failed) for r in rows] == [("failed", 10, 10)], f"404 is not retried: {rows}"
    summary = rows[0].result_summary
    assert (summary["reason"], summary["errors"]) == ("every document request failed", {"http_404": 10}), summary
    assert count("statutes_master") == 0


def test_x6_a_national_assembly_index_that_is_not_a_200_fails_the_run(corpus_db, monkeypatch):
    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)
    canned_network(monkeypatch, {"https://na.gov.pk/en/legis.php": (204, b"")})

    result = fire("scrape-na")

    assert result.state == "FAILURE" and type(result.result).__name__ == "SourceRunFailed", repr(result.result)
    rows = jobs("NationalAssembly")
    assert [r.status for r in rows] == ["failed"], rows
    summary = rows[0].result_summary
    assert (summary["reason"], summary["errors"]) == ("every listing request failed", {"http_204": 1}), summary


def test_x7_supreme_court_discovery_fails_when_every_listing_fails(corpus_db, monkeypatch):
    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)
    from scraper.tasks import supremecourt

    seeds = list(supremecourt.SUPREMECOURT_LISTING_SEED_URLS)
    canned_network(monkeypatch, {url: httpx.ConnectError("synthetic F28 connect failure") for url in seeds})

    result = fire("scrape-supremecourt-public")

    assert result.state == "FAILURE" and type(result.result).__name__ == "SourceRunFailed", repr(result.result)
    rows = jobs("SupremeCourtPublic")
    assert [r.status for r in rows] == ["failed"] * 4, f"ConnectError is transient: retried to the bound: {rows}"
    summary = rows[-1].result_summary
    assert (summary["reason"], summary["errors"]) == ("every listing request failed", {"ConnectError": len(seeds)}), summary
    assert count("scraper_staging") == 0
