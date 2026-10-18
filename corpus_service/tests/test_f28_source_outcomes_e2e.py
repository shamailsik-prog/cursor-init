"""Audit F28 end to end: a corpus job that could not do its work ends as a failure, in Celery and in
its run record; a job that ran and found nothing stays a success with a count.

The flow is the production one. Each test takes a real beat schedule entry from the real Celery app
(``scraper.tasks.celery_app``), looks its task up by the entry's name and runs it in process with
``Task.apply(args=entry["args"])``, which also executes Celery retries eagerly. The task runs the real
dispatcher, the real harvesters, the real fetch boundary (``PolicyFetcher`` with the production source
policies) and writes to a fresh real Postgres 16 + pgvector database migrated by the real
``python -m scraper.migrate`` (the ``corpus_db`` fixture, CORPUS_TEST_DATABASE_URL).

Only the network edge is replaced, through the fetch boundary's own test hooks (explicit constructor
arguments, refused outside ENVIRONMENT=development):
* a resolver that raises (a DNS failure, so the request fails with ``httpx.ConnectError``);
* a resolver that answers a private address (the boundary refuses it, ``blocked_address``);
* a local HTTPS server (a throwaway CA) for the cases that need pages, allowlisted as the only origin.
The OpenAI package is the one stub, an in-process module, because the provider API is the external
edge of the embedding job.

Expected values are written out from the spec (docs/superpowers/specs/
2026-10-18-f28-source-failure-outcomes-design.md, rulings R1-R15), not imported from the code under
test. Synthetic fixtures only; nothing leaves the machine.
"""

import asyncio
import contextlib
import logging
import sys
import types
from datetime import datetime, timedelta, timezone

import pytest

from f25_servers import RecordingServer, client_tls_context, make_test_pki, server_tls_context, serving
from test_f20_trust_policy_db import assert_migrated, execute, fetch, run

PROVIDER_KEY = "sk-f28-synthetic-not-a-key"
CASE_TEXT = "Synthetic F28 fixture judgment {n}. 2099 SCMR {n}01. Not a real judgment."
BACKOFF = [300, 600, 1200]  # spec R7: min(300 * 2**attempt, 3600)


# ---------------------------------------------------------------------------------------------
# the production entry point: a beat entry, its task, run in process
# ---------------------------------------------------------------------------------------------
def fire(entry_name):
    """Run the task a beat schedule entry names, with the entry's arguments, in process. Celery's
    ``apply`` executes a retry at once (no countdown) and returns the last attempt's result."""
    from scraper.tasks import celery_app

    entry = celery_app.app.conf.beat_schedule[entry_name]
    task = celery_app.app.tasks[entry["task"]]
    return task.apply(args=entry.get("args", ()))


def jobs(site, job_type="incremental"):
    return run(fetch(
        "SELECT status, retry_count, max_retries, pages_scraped, records_extracted, records_failed, "
        "error_message, error_traceback, next_retry_at, started_at, finished_at, result_summary, celery_task_id "
        "FROM scraper_jobs WHERE source_site = :s AND job_type = :t ORDER BY started_at, retry_count",
        s=site, t=job_type,
    ))


def source_row(name):
    return run(fetch(
        "SELECT last_scraped_at, last_success_at, consecutive_failures, last_failure_reason, "
        "total_records_extracted, total_pages_scraped FROM scraper_sources WHERE source_name = :n",
        n=name,
    ))[0]


def count(table, where="true", **params):
    return run(fetch(f"SELECT count(*) FROM {table} WHERE {where}", **params))[0][0]


def no_sleep(monkeypatch):
    real_sleep = asyncio.sleep

    async def _no_wait(delay=0, result=None):
        return await real_sleep(0, result)

    monkeypatch.setattr(asyncio, "sleep", _no_wait)


def no_proxy(monkeypatch):
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(var, raising=False)


def boundary_with_resolver(monkeypatch, resolver):
    """Every source gets the production fetch boundary with its production policy; only name
    resolution is the test's (the boundary's _test_resolver hook)."""
    from scraper.net import fetch_policy

    def _factory(name, **kwargs):
        return fetch_policy.PolicyFetcher(
            fetch_policy.policy_for(name), headers=kwargs.get("headers"), _test_resolver=resolver
        )

    monkeypatch.setattr(fetch_policy, "fetcher_for", _factory)


def dns_down(calls):
    async def _resolve(host, port):
        calls.append(host)
        raise OSError("synthetic F28 DNS failure")

    return _resolve


def private_answer(calls):
    async def _resolve(host, port):
        calls.append(host)
        return ["10.0.0.8"]  # the boundary refuses a non-public address (blocked_address)

    return _resolve


def idle_import_folder(monkeypatch, tmp_path):
    """PakistanLawSite with no licensed API key and an empty import folder: it runs and finds nothing."""
    import scraper.tasks.pakistanlawsite as pls

    folder = tmp_path / "pls-imports"
    folder.mkdir()
    monkeypatch.delenv("PLS_API_KEY", raising=False)
    monkeypatch.setattr(pls, "IMPORT_DIR", folder)


def _page(body, status=200):
    return status, {"Content-Type": "text/html; charset=utf-8"}, body.encode("utf-8")


@contextlib.contextmanager
def nasir_site(monkeypatch, tmp_path, build_routes):
    """A local HTTPS 'Nasir': REPORTER_URLS point at it, and the NasirLawSite boundary allowlists
    exactly its origin (https://localhost:<port>) through the loopback and test-CA hooks."""
    from scraper.net import fetch_policy
    import scraper.tasks.nasirlawsite as nasirlawsite

    no_proxy(monkeypatch)
    pki = make_test_pki(tmp_path / "pki")
    server = RecordingServer(tls=server_tls_context(pki))
    origin = f"https://localhost:{server.port}"
    server.routes.update(build_routes(origin))
    policy = fetch_policy.FetchPolicy(name="NasirLawSite", hosts=frozenset({"localhost"}), ports=frozenset({server.port}))
    tls = client_tls_context(pki)

    def _factory(name, **kwargs):
        assert name == "NasirLawSite", name
        return fetch_policy.PolicyFetcher(
            policy, headers=kwargs.get("headers"), _test_ssl_context=tls,
            _test_loopback_origins={("localhost", server.port)},
        )

    with serving(server):
        monkeypatch.setattr(nasirlawsite, "REPORTER_URLS", [f"{origin}/case/scmr.htm", f"{origin}/case/pld.htm"])
        monkeypatch.setattr(fetch_policy, "fetcher_for", _factory)
        yield server, origin


# ---------------------------------------------------------------------------------------------
# (a)/(b) a source whose fetch fails is a FAILURE, with the error class recorded, no rows written
# ---------------------------------------------------------------------------------------------
def test_a_b_a_refused_index_request_fails_the_pakistancode_job_once(corpus_db, monkeypatch):
    """The F25 boundary refuses PakistanCode's index request (the name resolves to a private
    address). On main the harvester logged it and the task succeeded. Spec R2, R7 (a refusal is
    never retried), R8, R9."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    answered = []
    boundary_with_resolver(monkeypatch, private_answer(answered))
    no_sleep(monkeypatch)

    result = fire("scrape-pakistancode")

    assert result.state == "FAILURE", f"a refused source job was recorded as {result.state}: {result.result!r}"
    assert type(result.result).__name__ == "FetchRefused", repr(result.result)
    assert answered == ["pakistancode.gov.pk"], f"a refusal must not be retried: {answered}"
    rows = jobs("PakistanCode")
    assert [(r.status, r.retry_count) for r in rows] == [("failed", 0)], rows
    summary = rows[0].result_summary
    assert summary["outcome"] == "failed" and summary["error_class"] == "FetchRefused", summary
    assert summary["retryable"] is False and summary["will_retry"] is False, summary
    assert "blocked_address" in rows[0].error_message, rows[0].error_message
    assert rows[0].finished_at is not None and rows[0].next_retry_at is None
    assert count("statutes_master") == 0, "a failed run wrote statutes"
    src = source_row("PakistanCode")
    assert (src.consecutive_failures, src.last_success_at) == (1, None), src
    assert "FetchRefused" in src.last_failure_reason and src.last_scraped_at is not None, src


def test_b_e_a_network_failure_is_retried_with_backoff_and_stops_at_the_bound(corpus_db, monkeypatch):
    """DNS fails for every attempt: a retryable error. Exactly 1 + 3 attempts with backoff 300, 600,
    1200 s, then the task ends as FAILURE with the original ConnectError. On main the harvester logged
    the error and the task succeeded after one attempt. Spec R2, R7, R8."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    calls = []
    boundary_with_resolver(monkeypatch, dns_down(calls))
    no_sleep(monkeypatch)

    result = fire("scrape-pakistancode")

    assert result.state == "FAILURE", f"an unreachable source was recorded as {result.state}: {result.result!r}"
    assert type(result.result).__name__ == "ConnectError", repr(result.result)
    assert calls == ["pakistancode.gov.pk"] * 4, f"want 4 attempts (1 + max_retries 3), got {len(calls)}: {calls}"
    rows = jobs("PakistanCode")
    got = [
        (r.status, r.retry_count, r.max_retries, r.result_summary["error_class"], r.result_summary["will_retry"],
         r.result_summary["retry_in_seconds"], r.next_retry_at is not None)
        for r in rows
    ]
    assert got == [
        ("failed", 0, 3, "ConnectError", True, BACKOFF[0], True),
        ("failed", 1, 3, "ConnectError", True, BACKOFF[1], True),
        ("failed", 2, 3, "ConnectError", True, BACKOFF[2], True),
        ("failed", 3, 3, "ConnectError", False, None, False),
    ], got
    assert len({r.celery_task_id for r in rows}) == 1, "every attempt belongs to one Celery task"
    for row, wait in zip(rows[:3], BACKOFF):
        assert abs((row.next_retry_at - row.finished_at).total_seconds() - wait) < 5, (row.next_retry_at, row.finished_at)
    assert count("statutes_master") == 0
    assert source_row("PakistanCode").consecutive_failures == 4


def test_b_every_listing_request_failing_fails_the_court_job(corpus_db, monkeypatch):
    """SindhHighCourtPublic: the boundary refuses every listing request. On main discovery found no
    PDFs, the harvester logged 'no PDF links discovered' and the task succeeded. Spec R2."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    answered = []
    boundary_with_resolver(monkeypatch, private_answer(answered))
    no_sleep(monkeypatch)

    result = fire("scrape-shc-public")

    assert result.state == "FAILURE", f"a court whose listings all failed was recorded as {result.state}"
    assert type(result.result).__name__ == "SourceRunFailed", repr(result.result)
    assert len(answered) == 4, answered  # the four SHC seed hosts, one attempt (refusals are not retried)
    rows = jobs("SindhHighCourtPublic")
    assert [(r.status, r.retry_count) for r in rows] == [("failed", 0)], rows
    summary = rows[0].result_summary
    assert summary["error_class"] == "SourceRunFailed" and summary["retryable"] is False, summary
    assert summary["reason"] == "every listing request failed", summary
    assert summary["errors"] == {"FetchRefused(blocked_address)": 4}, summary
    assert count("scraper_staging") == 0


# ---------------------------------------------------------------------------------------------
# (c) a run that found nothing stays a success, with a count
# ---------------------------------------------------------------------------------------------
def test_c_an_idle_import_folder_is_an_empty_success_with_a_record(corpus_db, monkeypatch, tmp_path):
    assert_migrated(corpus_db.migrate(), corpus_db)
    idle_import_folder(monkeypatch, tmp_path)

    result = fire("scrape-pakistanlawsite")

    assert result.state == "SUCCESS", repr(result.result)
    rows = jobs("PakistanLawSite")
    assert [(r.status, r.records_extracted, r.records_failed, r.pages_scraped) for r in rows] == [("completed", 0, 0, 0)], rows
    summary = rows[0].result_summary
    assert summary["outcome"] == "empty" and summary["written"] == 0, summary
    assert "no_api_key_or_import_files" in (summary.get("note") or ""), summary
    src = source_row("PakistanLawSite")
    assert src.last_success_at is not None and src.consecutive_failures == 0, src


def test_c_reporter_pages_with_nothing_to_harvest_are_an_empty_success(corpus_db, monkeypatch, tmp_path):
    """Nasir's reporter pages load but link no case page: the run worked and found nothing new."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)
    routes = lambda origin: {  # noqa: E731
        "/case/scmr.htm": _page("<html><title>F28 SCMR</title><body>No new judgments.</body></html>"),
        "/case/pld.htm": _page("<html><title>F28 PLD</title><body>No new judgments.</body></html>"),
    }
    with nasir_site(monkeypatch, tmp_path, routes) as (server, origin):
        result = fire("scrape-nasirlawsite")
    assert result.state == "SUCCESS", repr(result.result)
    rows = jobs("NasirLawSite")
    assert [(r.status, r.records_extracted, r.records_failed) for r in rows] == [("completed", 0, 0)], rows
    assert rows[0].result_summary["outcome"] == "empty", rows[0].result_summary
    assert count("scraper_staging") == 0


# ---------------------------------------------------------------------------------------------
# (d) each run records its own outcome; a partial run counts its failures
# ---------------------------------------------------------------------------------------------
def test_d_a_failed_source_and_a_working_source_each_record_their_own_outcome(corpus_db, monkeypatch, tmp_path):
    """FINAL_2 mandatory rule 10: one source failure never stops another source. The failure is
    the failing source's alone; the working source's run is not touched by it. Spec R8, R9."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    boundary_with_resolver(monkeypatch, private_answer([]))
    idle_import_folder(monkeypatch, tmp_path)
    no_sleep(monkeypatch)

    failed = fire("scrape-pakistancode")
    worked = fire("scrape-pakistanlawsite")

    assert (failed.state, worked.state) == ("FAILURE", "SUCCESS"), (failed.result, worked.result)
    assert [r.status for r in jobs("PakistanCode")] == ["failed"]
    assert [r.status for r in jobs("PakistanLawSite")] == ["completed"]
    assert source_row("PakistanCode").consecutive_failures == 1
    assert source_row("PakistanLawSite").consecutive_failures == 0


def test_d_a_partial_run_succeeds_counts_the_failed_page_and_does_not_stage_it(corpus_db, monkeypatch, tmp_path):
    """One case page answers, the other answers 500. On main the 500 page was staged as a judgment
    and nothing was recorded. Spec R1 (partial), R3."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)

    def routes(origin):
        return {
            "/case/scmr.htm": _page(
                f'<html><title>F28 SCMR</title><body><a href="{origin}/case/2099-scmr-1.htm">case</a>'
                f'<a href="{origin}/case/2099-scmr-2.htm">case</a></body></html>'
            ),
            "/case/pld.htm": _page("<html><title>F28 PLD</title><body>Nothing new.</body></html>"),
            "/case/2099-scmr-1.htm": _page(f"<html><body>{CASE_TEXT.format(n=1)}</body></html>"),
            "/case/2099-scmr-2.htm": _page("<html><body>Internal Server Error</body></html>", status=500),
        }

    with nasir_site(monkeypatch, tmp_path, routes) as (server, origin):
        result = fire("scrape-nasirlawsite")

    assert result.state == "SUCCESS", repr(result.result)
    staged = [u for (u,) in run(fetch("SELECT source_url FROM scraper_staging"))]
    assert staged == [f"{origin}/case/2099-scmr-1.htm"], f"only the page that answered is staged: {staged}"
    rows = jobs("NasirLawSite")
    assert [(r.status, r.pages_scraped, r.records_extracted, r.records_failed) for r in rows] == [("completed", 2, 1, 1)], rows
    summary = rows[0].result_summary
    assert summary["outcome"] == "partial" and summary["errors"] == {"http_500": 1}, summary


def test_d_e_every_case_page_failing_fails_the_run_and_a_transient_cause_is_retried(corpus_db, monkeypatch, tmp_path):
    """The reporter page loads but every case page answers 503 (transient): every document failed,
    so the run failed, and it is retried to the bound. On main the 503 pages were staged. Spec R2, R7."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    no_sleep(monkeypatch)

    def routes(origin):
        return {
            "/case/scmr.htm": _page(
                f'<html><title>F28 SCMR</title><body><a href="{origin}/case/2099-scmr-1.htm">case</a>'
                f'<a href="{origin}/case/2099-scmr-2.htm">case</a></body></html>'
            ),
            "/case/pld.htm": _page("<html><title>F28 PLD</title><body>Nothing new.</body></html>"),
            "/case/2099-scmr-1.htm": _page("<html><body>Service Unavailable</body></html>", status=503),
            "/case/2099-scmr-2.htm": _page("<html><body>Service Unavailable</body></html>", status=503),
        }

    with nasir_site(monkeypatch, tmp_path, routes) as (server, origin):
        result = fire("scrape-nasirlawsite")
        reporter_hits = [r["path"] for r in server.requests if r["path"] == "/case/scmr.htm"]

    assert result.state == "FAILURE", f"a run whose every document failed was recorded as {result.state}"
    assert type(result.result).__name__ == "SourceRunFailed", repr(result.result)
    assert len(reporter_hits) == 4, f"want 4 attempts, the reporter page was fetched {len(reporter_hits)} times"
    rows = jobs("NasirLawSite")
    assert [(r.status, r.retry_count, r.records_failed) for r in rows] == [
        ("failed", 0, 2), ("failed", 1, 2), ("failed", 2, 2), ("failed", 3, 2)
    ], rows
    assert rows[0].result_summary["reason"] == "every document request failed", rows[0].result_summary
    assert rows[0].result_summary["errors"] == {"http_503": 2}, rows[0].result_summary
    assert count("scraper_staging") == 0, "error pages were staged as judgments"


# ---------------------------------------------------------------------------------------------
# (f) an embedding batch that fails is a FAILURE and its items are not recorded as done
# ---------------------------------------------------------------------------------------------
def _queue_one_statute():
    run(execute(
        "INSERT INTO statutes_master (statute_name, short_name, section_number, section_text, source_site) "
        "VALUES ('Synthetic F28 Act 2099', 'F28A', '1', 'Short title. Synthetic F28 fixture, not a real statute.', 'F28Fixture')"
    ))
    statute_id = run(fetch("SELECT id FROM statutes_master WHERE source_site = 'F28Fixture'"))[0][0]
    run(execute(
        "INSERT INTO embedding_queue (record_id, table_name) VALUES (:id, 'statutes_master')",
        params={"id": statute_id},
    ))
    return statute_id


def install_provider(monkeypatch, *, fail):
    """The OpenAI package as an in-process module: the provider is the job's external edge."""
    from scraper import config

    calls = []
    module = types.ModuleType("openai")

    class APIConnectionError(Exception):
        pass

    class _Embeddings:
        async def create(self, model, input):
            calls.append(model)
            if fail:
                raise APIConnectionError("synthetic F28 provider outage")
            return types.SimpleNamespace(data=[types.SimpleNamespace(embedding=[0.001] * 1536)])

    class AsyncOpenAI:
        def __init__(self, api_key):
            self.embeddings = _Embeddings()

    module.AsyncOpenAI = AsyncOpenAI
    module.APIConnectionError = APIConnectionError
    monkeypatch.setitem(sys.modules, "openai", module)
    monkeypatch.setattr(config.settings, "OPENAI_API_KEY", PROVIDER_KEY)
    return calls


def queue_state(statute_id):
    return run(fetch(
        "SELECT q.status, q.attempts, s.embedding IS NOT NULL FROM embedding_queue q "
        "JOIN statutes_master s ON s.id = q.record_id WHERE q.record_id = :id",
        id=statute_id,
    ))


def test_f_an_embedding_batch_whose_provider_fails_is_a_failure_and_not_done(corpus_db, monkeypatch):
    """Every item of the batch failed at the provider. On main the task returned 0 and Celery
    recorded SUCCESS. Spec R13."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    statute_id = _queue_one_statute()
    calls = install_provider(monkeypatch, fail=True)
    no_sleep(monkeypatch)

    result = fire("process-embeddings")

    assert result.state == "FAILURE", f"a failed embedding batch was recorded as {result.state}: {result.result!r}"
    assert type(result.result).__name__ == "BatchFailed", repr(result.result)
    assert calls == ["text-embedding-3-small"], calls
    assert queue_state(statute_id) == [("pending", 1, False)], "the item must stay pending with one attempt, no vector"
    rows = jobs("embedding_queue", job_type="embed")
    assert [(r.status, r.records_extracted, r.records_failed) for r in rows] == [("failed", 0, 1)], rows
    assert rows[0].result_summary["errors"] == {"APIConnectionError": 1}, rows[0].result_summary
    assert PROVIDER_KEY not in (rows[0].error_message or "") + (rows[0].error_traceback or "")


def test_f_an_unusable_embedding_table_is_a_failure(corpus_db, monkeypatch):
    """The embedding database becomes unusable (the queue table is gone). On main the outer
    except returned 0 and Celery recorded SUCCESS. Spec R13."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    install_provider(monkeypatch, fail=False)
    run(execute("ALTER TABLE embedding_queue RENAME TO embedding_queue_f28_gone"))

    result = fire("process-embeddings")

    assert result.state == "FAILURE", f"an unusable embedding database was recorded as {result.state}: {result.result!r}"
    rows = jobs("embedding_queue", job_type="embed")
    assert [r.status for r in rows] == ["failed"], rows
    # undefined_table, by class and SQLSTATE only: a driver message can carry row data or the DSN.
    assert "42P01" in rows[0].error_message and "does not exist" not in rows[0].error_message, rows[0].error_message


def test_f_control_a_working_batch_completes_its_item_and_records_it(corpus_db, monkeypatch):
    assert_migrated(corpus_db.migrate(), corpus_db)
    statute_id = _queue_one_statute()
    install_provider(monkeypatch, fail=False)
    no_sleep(monkeypatch)

    result = fire("process-embeddings")

    assert result.state == "SUCCESS", repr(result.result)
    assert queue_state(statute_id) == [("completed", 0, True)]
    rows = jobs("embedding_queue", job_type="embed")
    assert [(r.status, r.records_extracted, r.records_failed) for r in rows] == [("completed", 1, 0)], rows
    assert result.result["outcome"] == "ok" and result.result["completed"] == 1, result.result


# ---------------------------------------------------------------------------------------------
# R10 alerts, R11 abandoned runs, R12 two runs in one worker process
# ---------------------------------------------------------------------------------------------
def test_r10_failure_streak_staleness_and_zero_progress_raise_alerts(corpus_db, monkeypatch, tmp_path, caplog):
    assert_migrated(corpus_db.migrate(), corpus_db)
    boundary_with_resolver(monkeypatch, private_answer([]))
    idle_import_folder(monkeypatch, tmp_path)
    no_sleep(monkeypatch)
    # PakistanCode runs every 48 h; its last success was 5 days ago.
    run(execute(
        "UPDATE scraper_sources SET last_success_at = now() - interval '5 days' WHERE source_name = 'PakistanCode'"
    ))

    with caplog.at_level(logging.ERROR):
        for _ in range(3):
            fire("scrape-pakistancode")
            fire("scrape-pakistanlawsite")

    code = [sorted(a.split(":")[0] for a in r.result_summary["alerts"]) for r in jobs("PakistanCode")]
    assert code == [["stale"], ["stale"], ["failing", "stale"]], code
    pls = [sorted(a.split(":")[0] for a in r.result_summary["alerts"]) for r in jobs("PakistanLawSite")]
    assert pls == [[], [], ["no_progress"]], pls
    alerts = [r.getMessage() for r in caplog.records if r.getMessage().startswith("F28 source alert: ")]
    assert any(m.startswith("F28 source alert: PakistanCode failing") for m in alerts), alerts
    assert any(m.startswith("F28 source alert: PakistanCode stale") for m in alerts), alerts
    assert any(m.startswith("F28 source alert: PakistanLawSite no_progress") for m in alerts), alerts


def test_r11_a_run_abandoned_by_its_worker_is_closed_as_failed(corpus_db, monkeypatch, tmp_path):
    """A row still 'running' 3 hours after it started lost its worker (task_time_limit is 1 hour):
    the next run of the source closes it. A row started 10 minutes ago is left alone. Spec R11."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    idle_import_folder(monkeypatch, tmp_path)
    run(execute(
        "INSERT INTO scraper_jobs (source_site, job_type, status, started_at, celery_task_id) VALUES "
        "('PakistanLawSite', 'incremental', 'running', now() - interval '3 hours', 'f28-abandoned'), "
        "('PakistanLawSite', 'incremental', 'running', now() - interval '10 minutes', 'f28-in-flight')"
    ))

    result = fire("scrape-pakistanlawsite")

    assert result.state == "SUCCESS", repr(result.result)
    state = dict(run(fetch(
        "SELECT celery_task_id, status FROM scraper_jobs WHERE celery_task_id IN ('f28-abandoned', 'f28-in-flight')"
    )))
    assert state == {"f28-abandoned": "failed", "f28-in-flight": "running"}, state
    reason = run(fetch("SELECT result_summary FROM scraper_jobs WHERE celery_task_id = 'f28-abandoned'"))[0][0]
    assert reason["outcome"] == "failed" and reason["reason"] == "abandoned", reason


def test_r12_two_runs_in_one_worker_process_both_succeed_on_the_pooled_engine(corpus_db, monkeypatch, tmp_path, caplog):
    """A prefork worker child runs task after task, each in a new event loop (asyncio.run), on the
    application's pooled engine. On main the second run's first query failed on a connection left
    over from the first loop. Spec R12."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    from scraper import database

    idle_import_folder(monkeypatch, tmp_path)
    pooled = database.build_engine(corpus_db.url)
    monkeypatch.setattr(database, "engine", pooled)
    database.SessionLocal.configure(bind=pooled)
    try:
        with caplog.at_level(logging.WARNING):
            first = fire("scrape-pakistanlawsite")
            second = fire("scrape-pakistanlawsite")
    finally:
        with contextlib.suppress(Exception):
            run(pooled.dispose())

    assert (first.state, second.state) == ("SUCCESS", "SUCCESS"), (first.result, second.result)
    failures = [r.getMessage() for r in caplog.records if r.getMessage().startswith("Job failed for")]
    assert failures == [], failures
    assert [(r.status, r.retry_count) for r in jobs("PakistanLawSite")] == [("completed", 0), ("completed", 0)]
