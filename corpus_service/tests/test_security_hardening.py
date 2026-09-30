import os
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

    def test_explicit_app_env_production_also_enforced(self):
        with self.assertRaises(ValidationError):
            make_settings(APP_ENV="production")

    def test_strong_password_accepted_in_production(self):
        s = make_settings(
            ENVIRONMENT="production",
            DATABASE_URL="postgresql+asyncpg://legal:Zq8-long-random@postgres:5432/legal_scraper",
        )
        self.assertEqual(s.ENVIRONMENT, "production")

    def test_default_password_allowed_in_development(self):
        s = Settings(_env_file=None, ENVIRONMENT="development")
        self.assertIn("legal_scraper_pass", s.DATABASE_URL)


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

    def test_valid_key_reaches_file_endpoints(self):
        headers = {"X-API-Key": settings.ADMIN_API_KEY}
        self.assertEqual(self.client.get("/api/vault", headers=headers).status_code, 200)
        self.assertEqual(self.client.get("/api/live-feed", headers=headers).status_code, 200)


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
