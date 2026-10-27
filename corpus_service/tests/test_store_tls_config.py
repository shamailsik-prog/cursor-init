"""Audit F30: the service refuses, in production/staging, store URLs that are not TLS with server
verification, and its database/Celery wiring actually builds verifying TLS clients from them.

The live behaviour (handshakes against the real stores, wrong CA, wrong hostname, ACLs, roles) is
proven end to end by corpus_service/tests/e2e/store_security_e2e.sh in
.github/workflows/corpus-compose-policy.yml; these tests pin the configuration contract."""

import asyncio
import datetime
import os
import ssl
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ.setdefault("SKIP_DIR_CREATE", "1")

from cryptography import x509  # noqa: E402
from cryptography.fernet import Fernet  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from scraper.config import Settings, asyncpg_engine_args  # noqa: E402

DB_PW = "Zq8-long-random-Pw-2026"
TLS_DB_URL = (
    f"postgresql+asyncpg://corpus_app:{DB_PW}@postgres:5432/legal_scraper"
    "?sslmode=verify-full&sslrootcert=/run/tls-ca/ca.crt"
)
TLS_REDIS_URL = "rediss://corpus_redis:Rk3-long-random-Pw-2026@redis:6379/0"

PROD = {
    "ENVIRONMENT": "production",
    "ENCRYPTION_KEY": Fernet.generate_key().decode(),
    "ADMIN_API_KEY": "a-real-admin-key-32-chars-min!!",
    "CORPUS_ADMIN_CREDENTIALS": (
        '[{"id":"prod-bootstrap","actor":"platform","secret":"a-real-admin-key-32-chars-min!!",'
        '"scopes":["read","trigger","review","export","promote"]}]'
    ),
    "SECRET_KEY": "a-real-secret-key",
    "DATABASE_URL": TLS_DB_URL,
    "REDIS_URL": TLS_REDIS_URL,
}


def prod_settings(**overrides):
    return Settings(_env_file=None, **{**PROD, **overrides})


def write_test_ca(directory: Path) -> Path:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "f30-unit-test-ca")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(key, hashes.SHA256())
    )
    path = directory / "ca.crt"
    path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return path


class ProductionRequiresVerifiedPostgresTLSTests(unittest.TestCase):
    def test_verify_full_accepted_in_production(self):
        s = prod_settings()
        self.assertTrue(s.is_prodish())
        # asyncpg's own spelling is accepted too.
        prod_settings(DATABASE_URL=f"postgresql+asyncpg://corpus_app:{DB_PW}@postgres:5432/legal_scraper?ssl=verify-full")

    def test_url_without_tls_refused_in_production_and_staging(self):
        plain = f"postgresql+asyncpg://corpus_app:{DB_PW}@postgres:5432/legal_scraper"
        for env in ("production", "staging"):
            with self.subTest(env=env), self.assertRaisesRegex(ValidationError, "verify-full"):
                prod_settings(ENVIRONMENT=env, DATABASE_URL=plain)

    def test_unverified_or_optional_tls_modes_refused_in_production(self):
        for mode in ("disable", "allow", "prefer", "require", "verify-ca"):
            for key in ("sslmode", "ssl"):
                url = f"postgresql+asyncpg://corpus_app:{DB_PW}@postgres:5432/legal_scraper?{key}={mode}"
                with self.subTest(key=key, mode=mode), self.assertRaisesRegex(ValidationError, "verify-full"):
                    prod_settings(DATABASE_URL=url)

    def test_conflicting_tls_spellings_refused(self):
        url = f"postgresql+asyncpg://corpus_app:{DB_PW}@postgres:5432/legal_scraper?ssl=disable&sslmode=verify-full"
        with self.assertRaises(ValidationError):
            prod_settings(DATABASE_URL=url)

    def test_unset_environment_is_production_for_tls_too(self):
        clean = {k: v for k, v in os.environ.items() if k not in ("ENVIRONMENT", "APP_ENV")}
        plain = f"postgresql+asyncpg://corpus_app:{DB_PW}@postgres:5432/legal_scraper"
        with mock.patch.dict(os.environ, clean, clear=True):
            fields = {k: v for k, v in PROD.items() if k != "ENVIRONMENT"}
            with self.assertRaisesRegex(ValidationError, "verify-full"):
                Settings(_env_file=None, **{**fields, "DATABASE_URL": plain})

    def test_plaintext_still_allowed_in_explicit_development(self):
        s = Settings(_env_file=None, ENVIRONMENT="development",
                     DATABASE_URL="postgresql+asyncpg://dev:dev@localhost:5432/legal_scraper",
                     REDIS_URL="redis://localhost:6379/0")
        self.assertFalse(s.is_prodish())


class ProductionRequiresVerifiedRedisTLSTests(unittest.TestCase):
    def test_plaintext_redis_refused_in_production(self):
        with self.assertRaisesRegex(ValidationError, "rediss://"):
            prod_settings(REDIS_URL="redis://corpus_redis:Rk3-long-random-Pw-2026@redis:6379/0")

    def test_default_shipped_redis_url_refused_in_production(self):
        fields = {k: v for k, v in PROD.items() if k != "REDIS_URL"}
        with self.assertRaisesRegex(ValidationError, "rediss://"):
            Settings(_env_file=None, **fields)

    def test_rediss_without_acl_user_or_password_refused(self):
        for url in (
            "rediss://redis:6379/0",
            "rediss://:Rk3-long-random-Pw-2026@redis:6379/0",
            "rediss://default:Rk3-long-random-Pw-2026@redis:6379/0",
            "rediss://corpus_redis@redis:6379/0",
        ):
            with self.subTest(url=url), self.assertRaisesRegex(ValidationError, "ACL user"):
                prod_settings(REDIS_URL=url)

    def test_disabled_certificate_verification_refused(self):
        for reqs in ("none", "CERT_NONE", "optional", "CERT_OPTIONAL"):
            url = f"{TLS_REDIS_URL}?ssl_cert_reqs={reqs}"
            with self.subTest(reqs=reqs), self.assertRaisesRegex(ValidationError, "ssl_cert_reqs"):
                prod_settings(REDIS_URL=url)

    def test_redis_password_must_be_strong_and_non_default(self):
        """Re-audit D3: the Redis ACL password gets the database password rule."""
        for pw in ("x", "changeme", "short-pw-15char", "legal_scraper_pass", "PASSWORD"):
            url = f"rediss://corpus_redis:{pw}@redis:6379/0"
            with self.subTest(pw=pw), self.assertRaisesRegex(ValidationError, "ACL password of at least 16"):
                prod_settings(REDIS_URL=url)

    def test_redis_password_must_differ_from_the_database_password(self):
        url = f"rediss://corpus_redis:{DB_PW}@redis:6379/0"
        with self.assertRaisesRegex(ValidationError, "differ from the DATABASE_URL password"):
            prod_settings(REDIS_URL=url)

    def test_url_query_cannot_weaken_redis_tls(self):
        """Re-audit D4: no ssl_* query override may switch off certificate or hostname checks."""
        for query in (
            "ssl_check_hostname=false", "ssl_check_hostname=0", "ssl_check_hostname=no",
            "ssl_cert_reqs=none", "ssl_cert_reqs=CERT_OPTIONAL", "ssl_ca_certs=/tmp/other-ca.pem",
            "SSL_CHECK_HOSTNAME=False", "ssl_cert_reqs=required&ssl_check_hostname=false",
        ):
            with self.subTest(query=query), self.assertRaisesRegex(ValidationError, "must not override TLS verification"):
                prod_settings(REDIS_URL=f"{TLS_REDIS_URL}?{query}")
        prod_settings(REDIS_URL=f"{TLS_REDIS_URL}?ssl_cert_reqs=required&ssl_check_hostname=true")
        for key in ("CELERY_BROKER_URL", "CELERY_RESULT_BACKEND"):
            with self.subTest(key=key), self.assertRaisesRegex(ValidationError, key):
                prod_settings(**{key: f"{TLS_REDIS_URL}?ssl_check_hostname=false"})

    def test_weak_redis_query_is_still_allowed_in_development(self):
        Settings(_env_file=None, ENVIRONMENT="development", REDIS_URL="rediss://u:p@localhost:6379/0?ssl_check_hostname=false")

    def test_empty_redis_url_means_this_process_uses_no_redis(self):
        """The migrate service holds no Redis credential: REDIS_URL="" is accepted in production,
        yields no TLS options, and the Celery app refuses to load rather than fall back to amqp."""
        import importlib

        from scraper import config

        s = prod_settings(REDIS_URL="")
        self.assertIsNone(s.redis_ssl_options())
        sys.modules.pop("scraper.tasks.celery_app", None)
        try:
            with mock.patch.object(config, "settings", s), self.assertRaisesRegex(RuntimeError, "REDIS_URL is not configured"):
                importlib.import_module("scraper.tasks.celery_app")
        finally:
            sys.modules.pop("scraper.tasks.celery_app", None)

    def test_celery_overrides_held_to_the_same_rule(self):
        for key in ("CELERY_BROKER_URL", "CELERY_RESULT_BACKEND"):
            with self.subTest(key=key), self.assertRaisesRegex(ValidationError, key):
                prod_settings(**{key: "redis://redis:6379/0"})
        prod_settings(CELERY_BROKER_URL=TLS_REDIS_URL, CELERY_RESULT_BACKEND=TLS_REDIS_URL)


class AsyncpgTLSWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.ca = write_test_ca(Path(cls._tmp.name))

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_verify_full_builds_a_verifying_context_from_the_root_cert(self):
        url = f"postgresql+asyncpg://u:p@postgres:5432/legal_scraper?sslmode=verify-full&sslrootcert={self.ca}&application_name=x"
        clean_url, connect_args = asyncpg_engine_args(url)
        ctx = connect_args["ssl"]
        self.assertIsInstance(ctx, ssl.SSLContext)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)
        self.assertGreaterEqual(ctx.minimum_version, ssl.TLSVersion.TLSv1_2)
        subjects = [dict(x[0] for x in c["subject"]).get("commonName") for c in ctx.get_ca_certs()]
        self.assertIn("f30-unit-test-ca", subjects)
        # asyncpg.connect() takes no sslmode/sslrootcert kwargs: they must not reach it.
        query = parse_qs(urlsplit(clean_url).query)
        self.assertNotIn("sslmode", query)
        self.assertNotIn("sslrootcert", query)
        self.assertNotIn("ssl", query)
        self.assertEqual(query["application_name"], ["x"])
        self.assertTrue(clean_url.startswith("postgresql+asyncpg://u:p@postgres:5432/legal_scraper"))

    def test_asyncpg_spelling_is_equivalent(self):
        _, connect_args = asyncpg_engine_args(f"postgresql+asyncpg://u:p@postgres/db?ssl=verify-full&sslrootcert={self.ca}")
        self.assertEqual(connect_args["ssl"].verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(connect_args["ssl"].check_hostname)

    def test_missing_root_cert_file_fails_loudly(self):
        with self.assertRaises((FileNotFoundError, ssl.SSLError, OSError)):
            asyncpg_engine_args("postgresql+asyncpg://u:p@postgres/db?sslmode=verify-full&sslrootcert=/nonexistent/ca.crt")

    def test_verify_ca_checks_chain_but_not_hostname(self):
        _, connect_args = asyncpg_engine_args(f"postgresql+asyncpg://u:p@postgres/db?sslmode=verify-ca&sslrootcert={self.ca}")
        self.assertEqual(connect_args["ssl"].verify_mode, ssl.CERT_REQUIRED)
        self.assertFalse(connect_args["ssl"].check_hostname)

    def test_no_tls_parameters_leave_the_url_untouched(self):
        url = "postgresql+asyncpg://u:p@localhost:5432/legal_scraper"
        self.assertEqual(asyncpg_engine_args(url), (url, {}))

    def test_disable_turns_tls_off_explicitly(self):
        _, connect_args = asyncpg_engine_args("postgresql+asyncpg://u:p@localhost/db?sslmode=disable")
        self.assertIs(connect_args["ssl"], False)

    def test_sync_url_carries_libpq_verify_full_parameters(self):
        for spelling in ("sslmode", "ssl"):
            s = prod_settings(DATABASE_URL=f"postgresql+asyncpg://corpus_app:{DB_PW}@postgres:5432/legal_scraper"
                                           f"?{spelling}=verify-full&sslrootcert=/run/tls-ca/ca.crt")
            parts = urlsplit(s.database_sync_url)
            with self.subTest(spelling=spelling):
                self.assertEqual(parts.scheme, "postgresql+psycopg2")
                self.assertEqual(parse_qs(parts.query), {"sslmode": ["verify-full"], "sslrootcert": ["/run/tls-ca/ca.crt"]})

    def test_engine_hands_asyncpg_a_verifying_context(self):
        """Drive a real SQLAlchemy connect through scraper.database.build_engine and capture what
        reaches asyncpg.connect(): the verifying SSLContext, and no libpq-only keywords."""
        from scraper import database

        url = f"postgresql+asyncpg://corpus_app:{DB_PW}@postgres:5432/legal_scraper?sslmode=verify-full&sslrootcert={self.ca}"
        seen = {}

        async def fake_connect(*args, **kwargs):
            seen.update(kwargs)
            raise ConnectionRefusedError("captured by test")

        async def attempt():
            engine = database.build_engine(url)
            try:
                async with engine.connect():
                    pass
            finally:
                await engine.dispose()

        with mock.patch("asyncpg.connect", fake_connect), self.assertRaises(ConnectionRefusedError):
            asyncio.run(attempt())
        self.assertEqual(seen.get("host"), "postgres")
        self.assertEqual(seen.get("user"), "corpus_app")
        ctx = seen.get("ssl")
        self.assertIsInstance(ctx, ssl.SSLContext)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)
        self.assertNotIn("sslmode", seen)
        self.assertNotIn("sslrootcert", seen)


class RedisTLSWiringTests(unittest.TestCase):
    def test_rediss_requires_certificate_and_hostname_verification(self):
        s = prod_settings(REDIS_TLS_CA_FILE="/run/tls-ca/ca.crt")
        opts = s.redis_ssl_options()
        self.assertEqual(opts["ssl_cert_reqs"], ssl.CERT_REQUIRED)
        self.assertIs(opts["ssl_check_hostname"], True)
        self.assertEqual(opts["ssl_ca_certs"], "/run/tls-ca/ca.crt")

    def test_system_trust_store_when_no_ca_file(self):
        opts = prod_settings().redis_ssl_options()
        self.assertEqual(opts["ssl_cert_reqs"], ssl.CERT_REQUIRED)
        self.assertNotIn("ssl_ca_certs", opts)

    def test_plaintext_dev_url_has_no_tls_options(self):
        s = Settings(_env_file=None, ENVIRONMENT="development", REDIS_URL="redis://localhost:6379/0")
        self.assertIsNone(s.redis_ssl_options())

    def test_celery_broker_and_backend_verify_the_redis_certificate(self):
        """Import the real Celery app under production settings and inspect the connection
        parameters kombu (broker) and the Redis result backend will use. No network I/O: the
        live round trip over TLS + ACL runs in the e2e workflow."""
        import importlib

        import redis
        from scraper import config

        s = prod_settings(REDIS_TLS_CA_FILE="/run/tls-ca/ca.crt")
        sys.modules.pop("scraper.tasks.celery_app", None)
        with mock.patch.object(config, "settings", s):
            celery_app = importlib.import_module("scraper.tasks.celery_app")
        try:
            app = celery_app.app
            broker = app.connection_for_write()
            self.assertEqual(broker.transport_cls, "rediss")
            self.assertEqual(broker.userid, "corpus_redis")
            for opts in (broker.ssl, app.conf.redis_backend_use_ssl):
                self.assertEqual(opts["ssl_cert_reqs"], ssl.CERT_REQUIRED)
                self.assertIs(opts["ssl_check_hostname"], True)
                self.assertEqual(opts["ssl_ca_certs"], "/run/tls-ca/ca.crt")
            params = app.backend.connparams
            self.assertTrue(issubclass(params["connection_class"], redis.SSLConnection))
            self.assertEqual(params["ssl_cert_reqs"], ssl.CERT_REQUIRED)
            self.assertIs(params["ssl_check_hostname"], True)
            self.assertEqual(params["ssl_ca_certs"], "/run/tls-ca/ca.crt")
            self.assertEqual(params["username"], "corpus_redis")
            broker.release()
        finally:
            sys.modules.pop("scraper.tasks.celery_app", None)


if __name__ == "__main__":
    unittest.main()
