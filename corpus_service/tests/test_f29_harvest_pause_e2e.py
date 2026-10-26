"""Audit F29: harvester start/stop must govern scheduled Celery harvest and embedding work.

On main the admin API wrote ``harvest.stopped`` but ``run_source_job`` and
``process_embedding_queue`` ignored it; beat-fired work kept running.

Spec: docs/audit/2026-10-13-forensic-audit.md (F29). Uses the same in-process beat
``Task.apply`` harness as test_f28_source_outcomes_e2e.py.
"""

import pytest

from test_f20_trust_policy_db import assert_migrated
from test_f28_source_outcomes_e2e import execute, fetch, fire, idle_import_folder, jobs, run


def _harvest_control_body(paused: bool, *, in_flight: bool = False, source_runs: int = 0, embed_batches: int = 0):
    total = source_runs + embed_batches
    return {
        "paused": paused,
        "in_flight": in_flight,
        "running": {"source_runs": source_runs, "embed_batches": embed_batches, "total": total},
    }


@pytest.fixture
def harvest_resumed(corpus_db):
    """Ensure the singleton pause row exists and harvest is running."""
    import scraper.harvest_control as hc

    assert_migrated(corpus_db.migrate(), corpus_db)
    hc.resume()
    yield


def test_scheduled_harvest_skips_while_paused_and_runs_after_resume(corpus_db, monkeypatch, tmp_path, harvest_resumed):
    """Beat entry ``scrape-pakistanlawsite``: paused → skipped job with harvest_paused; resumed → success."""
    idle_import_folder(monkeypatch, tmp_path)

    import scraper.harvest_control as hc

    hc.pause()
    paused = fire("scrape-pakistanlawsite")
    assert paused.state == "SUCCESS", paused.result
    rows = jobs("PakistanLawSite")
    assert len(rows) == 1, rows
    assert rows[0].status == "cancelled", rows[0].status
    assert rows[0].result_summary["reason"] == "harvest_paused", rows[0].result_summary

    hc.resume()
    running = fire("scrape-pakistanlawsite")
    assert running.state == "SUCCESS", running.result
    rows = jobs("PakistanLawSite")
    assert len(rows) == 2, rows
    assert rows[1].status == "completed", rows[1].status


def test_scheduled_embeddings_skip_while_paused(corpus_db, harvest_resumed):
    """Beat entry ``process-embeddings`` must not claim rows when the operator has stopped harvest."""
    import scraper.harvest_control as hc

    hc.pause()
    result = fire("process-embeddings")
    assert result.state == "SUCCESS", result.result
    assert result.result.get("reason") == "harvest_paused", result.result


def test_api_stop_and_start_drive_the_same_pause_flag(corpus_db, monkeypatch, tmp_path, harvest_resumed):
    """POST /api/stop and /api/start use harvest_control; scheduled harvest respects them."""
    from fastapi.testclient import TestClient

    from scraper import harvest_control
    from scraper.config import settings
    from scraper.main import app

    idle_import_folder(monkeypatch, tmp_path)
    headers = {"X-API-Key": settings.ADMIN_API_KEY}

    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.get("/api/harvest-control", headers=headers).json() == _harvest_control_body(False)
        assert client.post("/api/stop", headers=headers).json() == {"status": "stopped"}
        assert harvest_control.is_paused()
        assert client.get("/api/harvest-control", headers=headers).json() == _harvest_control_body(True)

        paused = fire("scrape-pakistanlawsite")
        assert paused.state == "SUCCESS"
        assert jobs("PakistanLawSite")[0].result_summary["reason"] == "harvest_paused"

        assert client.post("/api/start", headers=headers).json() == {"status": "started"}
        assert not harvest_control.is_paused()
        ok = fire("scrape-pakistanlawsite")
        assert ok.state == "SUCCESS"
        assert jobs("PakistanLawSite")[1].status == "completed"


def test_harvest_control_reports_in_flight_source_job(corpus_db, harvest_resumed):
    """FA-F29-003: operator status must show running scraper_jobs, not only the pause flag."""
    from fastapi.testclient import TestClient

    from scraper.config import settings
    from scraper.main import app

    run(
        execute(
            "INSERT INTO scraper_jobs (source_site, job_type, status, started_at, celery_task_id) VALUES "
            "('PakistanLawSite', 'incremental', 'running', now() - interval '2 minutes', 'f29-003-in-flight')"
        )
    )
    headers = {"X-API-Key": settings.ADMIN_API_KEY}
    with TestClient(app, raise_server_exceptions=False) as client:
        body = client.get("/api/harvest-control", headers=headers).json()
    assert body == _harvest_control_body(False, in_flight=True, source_runs=1), body
    state = dict(
        run(fetch("SELECT celery_task_id, status FROM scraper_jobs WHERE celery_task_id = 'f29-003-in-flight'"))
    )
    assert state == {"f29-003-in-flight": "running"}, state


def test_pause_cancels_in_flight_harvest_jobs(corpus_db, harvest_resumed, monkeypatch):
    """FA-F29-005: operator stop closes running incremental/embed scraper_jobs and clears in_flight."""
    import scraper.harvest_control as hc

    monkeypatch.setattr(
        hc,
        "_revoke_celery_tasks",
        lambda task_ids: len([tid for tid in task_ids if tid]),
    )
    run(
        execute(
            "INSERT INTO scraper_jobs (source_site, job_type, status, started_at, celery_task_id) VALUES "
            "('PakistanLawSite', 'incremental', 'running', now() - interval '1 minute', 'f29-005-source'), "
            "('embedding_queue', 'embed', 'running', now() - interval '30 seconds', 'f29-005-embed')"
        )
    )
    cancelled = hc.pause()
    assert cancelled == {"cancelled_jobs": 2, "revoked_tasks": 2}, cancelled
    rows = {
        tid: (status, reason)
        for tid, status, reason in run(
            fetch(
                "SELECT celery_task_id, status, result_summary->>'reason' AS reason "
                "FROM scraper_jobs WHERE celery_task_id LIKE 'f29-005-%' ORDER BY celery_task_id"
            )
        )
    }
    assert rows == {
        "f29-005-embed": ("cancelled", "harvest_stopped_by_operator"),
        "f29-005-source": ("cancelled", "harvest_stopped_by_operator"),
    }, rows
    assert hc.is_paused()
    status = hc.pause()  # idempotent pause
    assert status["cancelled_jobs"] == 0


def test_api_stop_cancels_in_flight_jobs(corpus_db, harvest_resumed):
    """POST /api/stop must cancel running harvest work, not only set paused."""
    from fastapi.testclient import TestClient

    from scraper.config import settings
    from scraper.main import app

    run(
        execute(
            "INSERT INTO scraper_jobs (source_site, job_type, status, started_at, celery_task_id) VALUES "
            "('PakistanLawSite', 'incremental', 'running', now(), 'f29-005-api-stop')"
        )
    )
    headers = {"X-API-Key": settings.ADMIN_API_KEY}
    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.post("/api/stop", headers=headers).json() == {"status": "stopped"}
        body = client.get("/api/harvest-control", headers=headers).json()
    assert body == _harvest_control_body(True, in_flight=False), body
    status = dict(run(fetch("SELECT status, result_summary->>'reason' FROM scraper_jobs WHERE celery_task_id = 'f29-005-api-stop'")))
    assert status == {"cancelled": "harvest_stopped_by_operator"}, status


def test_pause_flag_lives_in_database_not_stop_file(corpus_db, tmp_path, monkeypatch, harvest_resumed):
    """FA-F29-001: operator pause must be the DB singleton row, not a container-local stop file."""
    import scraper.harvest_control as hc

    monkeypatch.setattr(hc, "state_dir", lambda: tmp_path)
    hc.pause()
    assert hc.is_paused()
    assert not (tmp_path / "harvest.stopped").exists()
