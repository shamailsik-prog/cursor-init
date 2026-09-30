import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ.setdefault("SKIP_DIR_CREATE", "1")

from cryptography.fernet import Fernet  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from scraper import database  # noqa: E402
from scraper.config import Settings, settings  # noqa: E402
from scraper.main import app  # noqa: E402

STRONG_DB_URL = "postgresql+asyncpg://legal:Zq8-long-random-Pw-2026@postgres:5432/legal_scraper"

PROD_SECRETS = {
    "ENCRYPTION_KEY": Fernet.generate_key().decode(),
    "ADMIN_API_KEY": "a-real-admin-key",
    "SECRET_KEY": "a-real-secret-key",
}


def make_settings(**overrides):
    return Settings(_env_file=None, **{**PROD_SECRETS, **overrides})


class DatabasePasswordInProductionTests(unittest.TestCase):
    def test_default_password_refused_in_production(self):
        with self.assertRaises(ValidationError):
            make_settings(ENVIRONMENT="production")

    def test_known_default_and_empty_passwords_refused_in_production(self):
        for url in (
            "postgresql+asyncpg://legal:legal@postgres:5432/legal_scraper",
            "postgresql+asyncpg://legal:legal_scraper_pass@db:5432/x",
            "postgresql+asyncpg://legal@postgres:5432/legal_scraper",
            "postgresql+asyncpg://legal:@postgres:5432/legal_scraper",
        ):
            with self.subTest(url=url), self.assertRaises(ValidationError):
                make_settings(ENVIRONMENT="production", DATABASE_URL=url)

    def test_unset_environment_defaults_to_production(self):
        clean = {k: v for k, v in os.environ.items() if k not in ("ENVIRONMENT", "APP_ENV")}
        with mock.patch.dict(os.environ, clean, clear=True):
            with self.assertRaises(ValidationError):
                Settings(_env_file=None)  # no secrets, default DB password
            with self.assertRaises(ValidationError):
                make_settings()  # secrets present, default DB password
            s = make_settings(DATABASE_URL=STRONG_DB_URL)
            self.assertTrue(s.is_prodish())

    def test_explicit_app_env_development_enables_dev_fallbacks(self):
        clean = {k: v for k, v in os.environ.items() if k not in ("ENVIRONMENT", "APP_ENV")}
        with mock.patch.dict(os.environ, clean, clear=True):
            s = Settings(_env_file=None, APP_ENV="development")
            self.assertFalse(s.is_prodish())

    def test_conflicting_explicit_environment_fails_closed(self):
        with self.assertRaises(ValidationError):
            make_settings(ENVIRONMENT="development", APP_ENV="production")

    def test_short_password_refused_in_production(self):
        with self.assertRaises(ValidationError):
            make_settings(
                ENVIRONMENT="production",
                DATABASE_URL="postgresql+asyncpg://legal:Short-pw-15char@postgres:5432/legal_scraper",
            )

    def test_login_scraping_follows_is_prodish(self):
        clean = {k: v for k, v in os.environ.items() if k not in ("ENVIRONMENT", "APP_ENV")}
        with mock.patch.dict(os.environ, clean, clear=True):
            s = Settings(_env_file=None, APP_ENV="development", ALLOW_LOGIN_SCRAPING=True)
            self.assertFalse(s.is_prodish())
            with self.assertRaises(ValidationError):
                make_settings(DATABASE_URL=STRONG_DB_URL, ALLOW_LOGIN_SCRAPING=True)
            with self.assertRaises(ValidationError):
                make_settings(ENVIRONMENT="staging", DATABASE_URL=STRONG_DB_URL, ALLOW_LOGIN_SCRAPING=True)

    def test_explicit_app_env_production_also_enforced(self):
        with self.assertRaises(ValidationError):
            make_settings(APP_ENV="production")

    def test_strong_password_accepted_in_production(self):
        s = make_settings(
            ENVIRONMENT="production",
            DATABASE_URL=STRONG_DB_URL,
        )
        self.assertEqual(s.ENVIRONMENT, "production")

    def test_default_password_allowed_in_development(self):
        s = Settings(_env_file=None, ENVIRONMENT="development")
        self.assertIn("legal_scraper_pass", s.DATABASE_URL)


class AdminKeyFallbackTests(unittest.TestCase):
    def test_missing_admin_key_refused_in_production(self):
        with self.assertRaises(ValidationError):
            make_settings(ENVIRONMENT="production", DATABASE_URL=STRONG_DB_URL, ADMIN_API_KEY="")

    def test_dev_admin_key_is_random_per_process_and_never_logged(self):
        with self.assertLogs("scraper.config", "WARNING") as logs:
            a = Settings(_env_file=None, ENVIRONMENT="development")
            b = Settings(_env_file=None, ENVIRONMENT="development")
        self.assertNotEqual(a.ADMIN_API_KEY, b.ADMIN_API_KEY)
        self.assertGreaterEqual(len(a.ADMIN_API_KEY), 32)
        self.assertNotIn("dev-only", a.ADMIN_API_KEY)
        joined = "\n".join(logs.output)
        self.assertIn("ADMIN_API_KEY", joined)
        self.assertNotIn(a.ADMIN_API_KEY, joined)
        self.assertNotIn(b.ADMIN_API_KEY, joined)

    def test_no_constant_placeholder_credentials_in_source(self):
        source = (PROJECT_ROOT / "scraper" / "config.py").read_text()
        self.assertFalse("dev-only-admin-api-key" in source, "constant admin key placeholder in config.py")


class CorpusEndpointAuthTests(unittest.TestCase):
    PROTECTED = [
        ("get", "/export/cases"),
        ("get", "/jobs"),
        ("get", "/api/vault"),
        ("get", "/api/live-feed"),
    ]

    def setUp(self):
        self.client = TestClient(app)

    def test_endpoints_require_admin_api_key(self):
        for method, path in self.PROTECTED:
            with self.subTest(path=path):
                self.assertEqual(getattr(self.client, method)(path).status_code, 401)
                wrong = getattr(self.client, method)(path, headers={"X-API-Key": "wrong"})
                self.assertEqual(wrong.status_code, 401)

    def test_non_ascii_key_is_rejected_not_500(self):
        res = self.client.get("/api/vault", headers={"X-API-Key": "\u00e9".encode("utf-8")})
        self.assertEqual(res.status_code, 401)

    def test_valid_key_reaches_file_endpoints(self):
        headers = {"X-API-Key": settings.ADMIN_API_KEY}
        self.assertEqual(self.client.get("/api/vault", headers=headers).status_code, 200)
        self.assertEqual(self.client.get("/api/live-feed", headers=headers).status_code, 200)


class DashboardTests(unittest.TestCase):
    def test_dashboard_sends_key_header_and_is_not_cached(self):
        res = TestClient(app).get("/dashboard")
        self.assertEqual(res.status_code, 200)
        self.assertIn("no-store", res.headers.get("cache-control", ""))
        self.assertIn("X-API-Key", res.text)
        self.assertIn("sessionStorage", res.text)
        self.assertNotIn(settings.ADMIN_API_KEY, res.text)


@unittest.skipUnless(shutil.which("node"), "node not installed")
class DashboardPollingTests(unittest.TestCase):
    """N4: a rejected/cancelled key pauses polling (no prompt loop) until re-entered."""

    def run_harness(self, prompts):
        out = subprocess.run(
            ["node", str(PROJECT_ROOT / "tests" / "dashboard_harness.mjs"),
             str(PROJECT_ROOT / "scraper" / "templates" / "dashboard.html"), json.dumps(prompts)],
            capture_output=True, text=True, timeout=30, check=True,
        )
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_wrong_key_prompts_once_then_stops_polling_until_unlock(self):
        result = self.run_harness(["bad", "good"])
        self.assertEqual(result["before"]["prompt"], 1)
        self.assertEqual(result["before"]["feed"], 1)  # one 401, then no more authenticated polling
        self.assertEqual(result["after"]["prompt"], 2)  # unlock() re-prompts once
        self.assertEqual(result["feed"], "line")
        self.assertEqual(result["unhandled"], 0)

    def test_cancelled_prompt_does_not_loop(self):
        result = self.run_harness([None])
        self.assertEqual(result["before"]["prompt"], 1)
        self.assertEqual(result["before"]["feed"], 0)
        self.assertEqual(result["unhandled"], 0)


class HealthDoesNotLeakErrorsTests(unittest.TestCase):
    def test_db_failure_returns_generic_status(self):
        secret_url = "postgresql+asyncpg://legal:hunter2@db.internal:5432/legal_scraper"

        def boom():
            raise RuntimeError(f"could not connect to {secret_url}")

        with mock.patch.object(database, "SessionLocal", boom), self.assertLogs("scraper.main", "WARNING"):
            res = TestClient(app).get("/health")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["status"], "degraded")
        self.assertFalse(body["db_connected"])
        self.assertNotIn("hunter2", res.text)
        self.assertNotIn("db.internal", res.text)


if __name__ == "__main__":
    unittest.main()
