"""Tests for ci_gates/check_compose_policy.py (audit F30).

Every insecure fixture (ci_gates/fixtures/compose_*.yml, and case_*/docker-compose.yml for
deployments made of several files) declares on a "# expect:" line exactly which policy rules it
must trip; the checker has to report that set and nothing else, so each fixture fails for its own
reason. The shipped corpus_service/docker-compose.yml and the secure baselines must pass, every
rule must be exercised by a fixture, and weakening the shipped file trips the matching rule.

The checker resolves each deployment with the docker compose CLI (no daemon needed).

    python3 ci_gates/test_check_compose_policy.py      (or: python3 -m pytest ci_gates/test_check_compose_policy.py)
"""

import ast
import contextlib
import io
import re
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import check_compose_policy as policy  # noqa: E402

FIXTURES = HERE / "fixtures"
SHIPPED = HERE.parent / "corpus_service" / "docker-compose.yml"
EXPECT = re.compile(r"^#\s*expect:\s*(.+)$", re.M)
POSITIVE = ("baseline_secure.yml", "baseline_secrets_files.yml")


def insecure_fixtures():
    return sorted(FIXTURES.glob("compose_*.yml")) + sorted(FIXTURES.glob("case_*/docker-compose.yml"))


def expected_rules(path):
    m = EXPECT.search(path.read_text())
    if not m:
        raise AssertionError(f"{path} has no '# expect:' line")
    return {r.strip() for r in m.group(1).split(",") if r.strip()}


def fired_rules(path):
    return {rule for rule, _service, _msg in policy.check(str(path))}


class SecureComposePasses(unittest.TestCase):
    def test_shipped_compose_passes(self):
        self.assertEqual(policy.check(str(SHIPPED)), [])

    def test_secure_baselines_pass(self):
        for name in POSITIVE:
            with self.subTest(fixture=name):
                self.assertEqual(policy.check(str(FIXTURES / name)), [])


class InsecureFixturesFailForTheirOwnReason(unittest.TestCase):
    def test_each_fixture_trips_exactly_its_declared_rules(self):
        fixtures = insecure_fixtures()
        self.assertGreaterEqual(len(fixtures), 39)
        for path in fixtures:
            with self.subTest(fixture=str(path.relative_to(FIXTURES))):
                self.assertEqual(fired_rules(path), expected_rules(path))

    def test_every_rule_is_exercised_by_a_fixture(self):
        covered = set()
        for path in insecure_fixtures():
            covered |= expected_rules(path)
        self.assertEqual(set(policy.RULES) - covered, set())
        self.assertEqual(covered - set(policy.RULES), set(), "fixture names an unknown rule")

    def test_cli_exit_codes(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(policy.main([str(SHIPPED)]), 0)
            self.assertEqual(policy.main([str(FIXTURES / "compose_pg_no_tls.yml")]), 1)
            self.assertEqual(policy.main([str(SHIPPED), str(FIXTURES / "compose_trust.yml")]), 1)
            # -f groups files into one deployment, like `docker compose -f a -f b`.
            self.assertEqual(policy.main(["-f", str(FIXTURES / "case_override" / "docker-compose.yml")]), 1)
        self.assertIn("[pg-trust]", out.getvalue())


def _timed(expr, timeout=10):
    """Evaluate `expr` against the checker in a child process; return (value, seconds). A
    catastrophic regex fails the test via TimeoutExpired instead of hanging the suite."""
    code = (
        "import sys, time; sys.path.insert(0, %r); import check_compose_policy as p; "
        "t = time.monotonic(); v = %s; print(repr((v, time.monotonic() - t)))" % (str(HERE), expr)
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=timeout, check=True)
    return ast.literal_eval(out.stdout.strip())


class UserinfoParsing(unittest.TestCase):
    """_userinfo reads credentials out of URLs taken from compose files (CodeQL py/redos)."""

    def test_crafted_unterminated_references_parse_in_linear_time(self):
        for expr in ('p._userinfo("postgres://" + "${" * 50000)',
                     'p._userinfo("postgres://" + "${a" * 50000)',
                     'p._userinfo("postgres://" + "${:" * 50000 + "@h")',
                     'p._mask_refs("${" + "a" * 50000)'):
            with self.subTest(expr=expr[:40]):
                value, seconds = _timed(expr)
                self.assertLess(seconds, 1.0)
                if "_userinfo" in expr and "@h" not in expr:
                    self.assertEqual(value, ("", ""))

    def test_userinfo_forms(self):
        cases = {
            "postgres://user:${PW:?missing}@db:5432/x": ("user", "${PW:?missing}"),
            "postgresql+asyncpg://${U:?x}:${P:?msg with / and @}@postgres/db": ("${U:?x}", "${P:?msg with / and @}"),
            "rediss://pv-REDIS_APP_USER-vp:pv-REDIS_APP_PASSWORD-vp@redis:6379/0": ("pv-REDIS_APP_USER-vp", "pv-REDIS_APP_PASSWORD-vp"),
            "rediss://u:p@h:6379/0": ("u", "p"),
            "rediss://:p@h": ("", "p"),
            "postgres://db:5432/x": ("", ""),
            "postgres://db/x@y": ("", ""),
            "not a url": ("", ""),
            "": ("", ""),
        }
        for url, expected in cases.items():
            with self.subTest(url=url):
                self.assertEqual(policy._userinfo(url), expected)

    def test_var_refs(self):
        self.assertEqual(policy.VAR_REF.findall("${A:?x} ${B:-d} ${C}"), [("A", ":?x"), ("B", ":-d"), ("C", "")])
        self.assertEqual(policy._mask_refs("a${X:?m}b"), "aVARb")


class ShippedComposeMutations(unittest.TestCase):
    """The same rules hold on the real file: weakening any F30 control in the shipped compose (in
    its own text, or through an override file compose would load) trips its rule."""

    def check_text(self, text):
        path = SHIPPED.parent / ".policy-mutation.yml"
        path.write_text(text)
        try:
            return {rule for rule, _s, _m in policy.check(str(path))}
        finally:
            path.unlink()

    def test_mutations(self):
        original = SHIPPED.read_text()
        cases = [
            ("      - ssl=on\n", "      - ssl=off\n", "pg-tls"),
            ("      - ident_file=/etc/postgresql/corpus/pg_ident.conf\n",
             "      - ident_file=/etc/postgresql/corpus/pg_ident.conf\n      - -cssl=off\n", "pg-weakening-flag"),
            ("      - hba_file=/etc/postgresql/corpus/pg_hba.conf\n", "      - hba_file=/var/lib/postgresql/data/pg_hba.conf\n", "pg-hba"),
            ('      - --port\n      - "0"\n', '      - --port\n      - "6379"\n', "redis-tls"),
            ('      - default\n      - "off"\n', '      - default\n      - "on"\n', "redis-default-user"),
            ('      - "-@dangerous"\n', "", "redis-acl-privilege"),
            ("${APP_DB_USER:?APP_DB_USER_required}:${APP_DB_PASSWORD:?APP_DB_PASSWORD_required}@postgres",
             "${POSTGRES_USER:?x}:${POSTGRES_PASSWORD:?x}@postgres", "app-db-bootstrap-user"),
            ("@redis:6379/0", "@redis:6379/0?ssl_check_hostname=false", "app-redis-tls"),
            ("      APP_DB_USER: ${APP_DB_USER:?APP_DB_USER_required}\n      APP_DB_PASSWORD_FILE",
             "      APP_DB_USER: ${POSTGRES_USER:?POSTGRES_USER_required}\n      APP_DB_PASSWORD_FILE", "app-role"),
            ("    networks: [data]\n    depends_on:\n      secrets-preflight:",
             "    ports: [\"5432:5432\"]\n    networks: [data]\n    depends_on:\n      secrets-preflight:", "store-ports"),
            # Re-audit D1: credentials beyond a container's own URLs.
            ("    env_file: app.env\n", "    env_file: .env\n", "app-env-file"),
            ("  REDIS_TLS_CA_FILE: /run/tls-ca/ca.crt\n",
             "  REDIS_TLS_CA_FILE: /run/tls-ca/ca.crt\n  MIGRATE_DB_PASSWORD: ${MIGRATE_DB_PASSWORD:?x}\n", "app-credential-scope"),
            ("      PLS_SEAT: A\n", "      PLS_SEAT: A\n      PG_SUPER: ${POSTGRES_PASSWORD:?x}\n", "app-credential-scope"),
            # Re-audit D2: an image-only service is not vetted.
            ("  api:\n    build: .\n", "  api:\n    image: corpus:latest\n", "unknown-service"),
        ]
        for old, new, rule in cases:
            with self.subTest(rule=rule, old=old[:40]):
                self.assertIn(old, original)
                self.assertIn(rule, self.check_text(original.replace(old, new, 1)))

    def test_override_file_next_to_the_shipped_compose_is_checked(self):
        override = SHIPPED.parent / "docker-compose.override.yml"
        self.assertFalse(override.exists(), "an override file is present in corpus_service/")
        override.write_text('services:\n  redis:\n    ports: ["6379:6379"]\n')
        try:
            self.assertIn("store-ports", {rule for rule, _s, _m in policy.check(str(SHIPPED))})
        finally:
            override.unlink()


if __name__ == "__main__":
    unittest.main()
