"""Audit F29: harvester start/stop must govern scheduled Celery harvest and embedding work.

On main the admin API wrote ``harvest.stopped`` but ``run_source_job`` and
``process_embedding_queue`` ignored it; beat-fired work kept running.

Spec: docs/audit/2026-10-13-forensic-audit.md (F29). Uses the same in-process beat
``Task.apply`` harness as test_f28_source_outcomes_e2e.py.
"""

import pytest

from test_f20_trust_policy_db import assert_migrated
from test_f28_source_outcomes_e2e import fire, idle_import_folder, jobs


@pytest.fixture
def harvest_state(tmp_path, monkeypatch):
    """Isolate pause state so tests do not touch the developer's blackletter_state."""
    import scraper.harvest_control as hc

    monkeypatch.setattr(hc, "state_dir", lambda: tmp_path)
    return tmp_path


def test_scheduled_harvest_skips_while_paused_and_runs_after_resume(corpus_db, monkeypatch, tmp_path, harvest_state):
    """Beat entry ``scrape-pakistanlawsite``: paused → skipped job with harvest_paused; resumed → success."""
    assert_migrated(corpus_db.migrate(), corpus_db)
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


def test_scheduled_embeddings_skip_while_paused(corpus_db, harvest_state):
    """Beat entry ``process-embeddings`` must not claim rows when the operator has stopped harvest."""
    assert_migrated(corpus_db.migrate(), corpus_db)

    import scraper.harvest_control as hc

    hc.pause()
    result = fire("process-embeddings")
    assert result.state == "SUCCESS", result.result
    assert result.result.get("reason") == "harvest_paused", result.result


def test_api_stop_and_start_drive_the_same_pause_flag(corpus_db, monkeypatch, tmp_path, harvest_state):
    """POST /api/stop and /api/start use harvest_control; scheduled harvest respects them."""
    from fastapi.testclient import TestClient

    from scraper import harvest_control
    from scraper.config import settings
    from scraper.main import app

    assert_migrated(corpus_db.migrate(), corpus_db)
    idle_import_folder(monkeypatch, tmp_path)
    headers = {"X-API-Key": settings.ADMIN_API_KEY}

    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.get("/api/harvest-control", headers=headers).json() == {"paused": False}
        assert client.post("/api/stop", headers=headers).json() == {"status": "stopped"}
        assert harvest_control.is_paused()
        assert client.get("/api/harvest-control", headers=headers).json() == {"paused": True}

        paused = fire("scrape-pakistanlawsite")
        assert paused.state == "SUCCESS"
        assert jobs("PakistanLawSite")[0].result_summary["reason"] == "harvest_paused"

        assert client.post("/api/start", headers=headers).json() == {"status": "started"}
        assert not harvest_control.is_paused()
        ok = fire("scrape-pakistanlawsite")
        assert ok.state == "SUCCESS"
        assert jobs("PakistanLawSite")[1].status == "completed"
