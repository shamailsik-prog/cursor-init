"""Audit F44 tests: liveness (/livez) vs bounded readiness (/readyz and /health)."""

import ast
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ.setdefault("SKIP_DIR_CREATE", "1")

try:
    import pytest
except ImportError:  # pragma: no cover
    pytest = None

try:
    from fastapi.testclient import TestClient
    from scraper import database, main
except ImportError:  # pragma: no cover
    TestClient = None
    database = None
    main = None


class _HealthySession:
    def __init__(self, count: int = 12):
        self._count = count

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, _stmt):
        class _Res:
            def __init__(self, val):
                self._val = val

            def scalar(self):
                return self._val

        return _Res(self._count)


if pytest is not None and main is not None:
    @pytest.fixture(autouse=True)
    def _reset_cache():
        main.reset_health_counts_cache()
        yield
        main.reset_health_counts_cache()


def test_livez_never_touches_disk_or_db(monkeypatch):
    if TestClient is None or main is None:
        return

    def _forbidden_db():
        raise AssertionError("SessionLocal must not be called on /livez")

    def _forbidden_walk(*_args, **_kwargs):
        raise AssertionError("os.walk must not be called on /livez")

    monkeypatch.setattr(database, "SessionLocal", _forbidden_db)
    monkeypatch.setattr(os, "walk", _forbidden_walk)

    client = TestClient(main.app)
    res = client.get("/livez")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_readyz_returns_200_when_db_healthy_and_uses_cached_counts(tmp_path, monkeypatch):
    if TestClient is None or main is None:
        return

    live = tmp_path / "live"
    state = tmp_path / "state"
    live.mkdir()
    state.mkdir()
    (live / "a.pdf").write_bytes(b"%PDF-1.4 " + b"x" * 20000)
    (state / "harvest-seen.json").write_text(json.dumps({"seen": ["u1", "u2", "u3"]}))

    monkeypatch.setattr(main, "_live_dir", lambda: live)
    monkeypatch.setattr(main, "_state_dir", lambda: state)
    monkeypatch.setattr(database, "SessionLocal", lambda: _HealthySession(42))

    walk_calls = []
    real_walk = os.walk

    def _counting_walk(top, *args, **kwargs):
        walk_calls.append(str(top))
        return real_walk(top, *args, **kwargs)

    monkeypatch.setattr(os, "walk", _counting_walk)

    client = TestClient(main.app)
    res1 = client.get("/readyz")
    assert res1.status_code == 200
    body1 = res1.json()
    assert body1["status"] == "ok"
    assert body1["db_connected"] is True
    assert body1["total_cases"] == 42
    assert body1["total_pdfs"] == 1
    assert body1["seen"] == 3
    assert isinstance(body1["counts_updated_at"], str)
    assert isinstance(body1["counts_age_seconds"], (int, float))
    assert len(walk_calls) == 1

    # Second call within TTL uses cached counts and does NOT walk the filesystem again.
    res2 = client.get("/readyz")
    assert res2.status_code == 200
    body2 = res2.json()
    assert body2["total_pdfs"] == 1
    assert body2["seen"] == 3
    assert len(walk_calls) == 1


def test_readyz_and_health_return_503_when_db_unreachable_or_times_out(tmp_path, monkeypatch):
    if TestClient is None or main is None:
        return

    live = tmp_path / "live"
    state = tmp_path / "state"
    live.mkdir()
    state.mkdir()
    monkeypatch.setattr(main, "_live_dir", lambda: live)
    monkeypatch.setattr(main, "_state_dir", lambda: state)
    main.record_vault_counts(5, 9)

    def _broken_db():
        raise ConnectionRefusedError("postgres://secret_user:secret_pass@db.internal:5432/corpus refused")

    monkeypatch.setattr(database, "SessionLocal", _broken_db)
    client = TestClient(main.app)

    for endpoint in ("/readyz", "/health"):
        res = client.get(endpoint)
        assert res.status_code == 503
        body = res.json()
        assert body["status"] == "degraded"
        assert body["db_connected"] is False
        assert body["total_pdfs"] == 5
        assert body["seen"] == 9
        assert "counts_updated_at" in body
        assert "counts_age_seconds" in body
        assert "secret_pass" not in res.text
        assert "db.internal" not in res.text

    async def _slow_probe():
        await asyncio.sleep(5.0)
        return 1

    monkeypatch.setattr(main, "READINESS_DB_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(main, "_probe_database", _slow_probe)
    res_timeout = client.get("/readyz")
    assert res_timeout.status_code == 503
    assert res_timeout.json()["status"] == "degraded"
    assert res_timeout.json()["db_connected"] is False


class F44HealthReadinessContractTests(unittest.TestCase):
    """Stdlib-runnable unit tests for F44 liveness/readiness separation."""

    def test_main_defines_livez_readyz_and_503_on_db_failure(self):
        src = (PROJECT_ROOT / "scraper" / "main.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        funcs = {n.name: n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        self.assertIn("livez", funcs)
        self.assertIn("readyz", funcs)
        self.assertIn("health", funcs)
        livez_names = {n.id for n in ast.walk(funcs["livez"]) if isinstance(n, ast.Name)}
        self.assertFalse(livez_names & {"SessionLocal", "_vault_pdfs", "_get_cached_vault_counts", "os"})
        self.assertIn("status_code=503", src)
        self.assertIn("counts_updated_at", src)
        self.assertIn("counts_age_seconds", src)

    def test_functions_health_ts_separates_livez_and_readyz_with_503(self):
        health_ts = (PROJECT_ROOT.parent / "functions" / "src" / "health.ts").read_text(encoding="utf-8")
        self.assertIn("livezHandler", health_ts)
        self.assertIn("readyzHandler", health_ts)
        self.assertIn("res.status(healthy ? 200 : 503)", health_ts)
        self.assertIn("counts_updated_at", health_ts)
        self.assertIn("counts_age_ms", health_ts)


if __name__ == "__main__":
    unittest.main()
