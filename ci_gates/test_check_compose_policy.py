"""Tests for ci_gates/check_compose_policy.py (audit F30).

Every ci_gates/fixtures/compose_*.yml declares, on a "# expect:" line, exactly which policy rules
it must trip; the checker has to report that set and nothing else, so each fixture fails for its
own reason. The shipped corpus_service/docker-compose.yml and the secure baseline must pass, and
every rule the checker knows must be exercised by at least one fixture.

    python3 ci_gates/test_check_compose_policy.py      (or: python3 -m pytest ci_gates/test_check_compose_policy.py)
"""

import contextlib
import io
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import check_compose_policy as policy  # noqa: E402

FIXTURES = HERE / "fixtures"
SHIPPED = HERE.parent / "corpus_service" / "docker-compose.yml"
EXPECT = re.compile(r"^#\s*expect:\s*(.+)$", re.M)


def expected_rules(path):
    m = EXPECT.search(path.read_text())
    if not m:
        raise AssertionError(f"{path.name} has no '# expect:' line")
    return {r.strip() for r in m.group(1).split(",") if r.strip()}


def fired_rules(path):
    return {rule for rule, _service, _msg in policy.check(str(path))}


class ShippedComposePasses(unittest.TestCase):
    def test_shipped_compose_passes(self):
        self.assertEqual(policy.check(str(SHIPPED)), [])

    def test_secure_baseline_passes(self):
        self.assertEqual(policy.check(str(FIXTURES / "baseline_secure.yml")), [])


class InsecureFixturesFailForTheirOwnReason(unittest.TestCase):
    def test_each_fixture_trips_exactly_its_declared_rules(self):
        fixtures = sorted(FIXTURES.glob("compose_*.yml"))
        self.assertGreaterEqual(len(fixtures), 15)
        for path in fixtures:
            with self.subTest(fixture=path.name):
                self.assertEqual(fired_rules(path), expected_rules(path))

    def test_every_rule_is_exercised_by_a_fixture(self):
        covered = set()
        for path in FIXTURES.glob("compose_*.yml"):
            covered |= expected_rules(path)
        self.assertEqual(set(policy.RULES) - covered, set())
        self.assertEqual(covered - set(policy.RULES), set(), "fixture names an unknown rule")

    def test_cli_exit_codes(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(policy.main([str(SHIPPED)]), 0)
            self.assertEqual(policy.main([str(FIXTURES / "compose_pg_no_tls.yml")]), 1)
            self.assertEqual(policy.main([str(SHIPPED), str(FIXTURES / "compose_trust.yml")]), 1)
        self.assertIn("[pg-trust]", out.getvalue())


class ShippedComposeMutations(unittest.TestCase):
    """The same rules hold on the real file: weakening any F30 control in the shipped compose is
    caught (each mutation is applied to the real text and must trip its rule)."""

    def check_text(self, text, tmp_name):
        path = SHIPPED.parent / tmp_name
        path.write_text(text)
        try:
            return {rule for rule, _s, _m in policy.check(str(path))}
        finally:
            path.unlink()

    def test_mutations(self):
        original = SHIPPED.read_text()
        cases = [
            ("      - ssl=on\n", "      - ssl=off\n", "pg-tls"),
            ("      - hba_file=/etc/postgresql/corpus/pg_hba.conf\n", "      - hba_file=/var/lib/postgresql/data/pg_hba.conf\n", "pg-hba"),
            ('      - --port\n      - "0"\n', '      - --port\n      - "6379"\n', "redis-tls"),
            ('      - default\n      - "off"\n', '      - default\n      - "on"\n', "redis-default-user"),
            ('      - "-@dangerous"\n', "", "redis-acl-privilege"),
            ("${APP_DB_USER:?APP_DB_USER_required}:${APP_DB_PASSWORD:?APP_DB_PASSWORD_required}@postgres",
             "${POSTGRES_USER:?x}:${POSTGRES_PASSWORD:?x}@postgres", "app-db-bootstrap-user"),
            ("@redis:6379/0", "@redis:6379/0?ssl_cert_reqs=none", "app-redis-tls"),
            ("      APP_DB_USER: ${APP_DB_USER:?APP_DB_USER_required}\n",
             "      APP_DB_USER: ${POSTGRES_USER:?POSTGRES_USER_required}\n", "app-role"),
            ("    networks: [data]\n    depends_on:\n      certs:", "    ports: [\"5432:5432\"]\n    networks: [data]\n    depends_on:\n      certs:", "store-ports"),
        ]
        for old, new, rule in cases:
            with self.subTest(rule=rule):
                self.assertIn(old, original)
                fired = self.check_text(original.replace(old, new, 1), ".policy-mutation.yml")
                self.assertIn(rule, fired)


if __name__ == "__main__":
    unittest.main()
