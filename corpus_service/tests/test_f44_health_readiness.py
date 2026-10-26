"""FA-F44-001..003: corpus readiness/liveness and bounded DB probe."""
from __future__ import annotations

import asyncio
import os
import time
import unittest
from unittest import mock

from fastapi.testclient import TestClient


class _FakeDbSession:
    async def execute(self, _stmt):
        return mock.Mock()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class _SlowDbSession:
    async def execute(self, _stmt):
        await asyncio.sleep(10)
        return mock.Mock()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class CorpusHealthF44Tests(unittest.TestCase):
    def test_liveness_has_no_database_io(self):
        from scraper import main

        with mock.patch("scraper.database.SessionLocal", mock.Mock(side_effect=AssertionError("no DB on liveness"))):
            res = TestClient(main.app).get("/health/live")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"status": "ok", "probe": "liveness"})

    def test_readiness_does_not_walk_vault(self):
        from scraper import database, health_probe, main

        walked = []
        real_scandir = os.scandir

        def _spy(path=".", *args, **kwargs):
            walked.append(os.fspath(path))
            return real_scandir(path, *args, **kwargs)

        health_probe.refresh_vault_telemetry(
            live_dir=main._live_dir,
            vault_pdfs=main._vault_pdfs,
            state_dir=main._state_dir(),
        )

        def session_local():
            return _FakeDbSession()

        with mock.patch.object(database, "SessionLocal", session_local), mock.patch.object(os, "scandir", _spy):
            res = TestClient(main.app).get("/health")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["dependencies"], {"postgres": "ok"})
        self.assertEqual(walked, [])

    def test_readiness_db_timeout_returns_503_quickly(self):
        from scraper import database, health_probe, main

        def session_local():
            return _SlowDbSession()

        with mock.patch.object(database, "SessionLocal", session_local), mock.patch.object(
            health_probe, "READINESS_DB_TIMEOUT_SEC", 0.05
        ):
            start = time.monotonic()
            res = TestClient(main.app).get("/health")
            elapsed = time.monotonic() - start
        self.assertLess(elapsed, 1.0, msg=f"took {elapsed}s")
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json()["status"], "unhealthy")
        self.assertEqual(res.json()["dependencies"], {"postgres": "failed"})


if __name__ == "__main__":
    unittest.main()
