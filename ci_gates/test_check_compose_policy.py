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
import importlib.util
import io
import random
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import check_compose_policy as policy  # noqa: E402

FIXTURES = HERE / "fixtures"
SHIPPED = HERE.parent / "corpus_service" / "docker-compose.yml"
EXPECT = re.compile(r"^#\s*expect:\s*(.+)$", re.M)
POSITIVE = ("baseline_secure.yml", "baseline_secrets_files.yml")


def load_attacks():
    """fixtures/shipped_attacks.py: the re-audit's attack mutations of the shipped tree (data only)."""
    spec = importlib.util.spec_from_file_location("shipped_attacks", FIXTURES / "shipped_attacks.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CASES


def _pg_command_string(text):
    """The postgres command list of the shipped compose rewritten as one string (attack A07)."""
    start = text.index("    command:\n      - postgres\n")
    end = text.index("    environment:\n      POSTGRES_USER", start)
    toks = re.findall(r"^      - (.+)$", text[start:end], re.M)
    return text[:start] + "    command: " + " ".join(toks) + "\n" + text[end:]


def apply_attack(case, root):
    """Copy corpus_service/ into root/corpus_service, apply the case's one mutation, and return
    the compose file to check (the same steps as the auditor's own harness)."""
    tree = Path(root) / "corpus_service"
    shutil.copytree(SHIPPED.parent, tree, ignore=shutil.ignore_patterns(
        ".env", "live", "blackletter_state", "__pycache__", ".policy-mutation.yml"))
    compose = tree / "docker-compose.yml"
    text = compose.read_text()
    for edit in case["edits"]:
        if edit[0] == "replace":
            _kind, old, new = edit
            assert old in text, (case["id"], old[:60])
            text = text.replace(old, new, 1)
        elif edit[0] == "splice":
            _kind, start, end, new = edit
            i = text.index(start)
            text = text[:i] + new + text[text.index(end, i):]
        elif edit[0] == "replace_after":
            _kind, anchor, old, new = edit
            j = text.index(old, text.index(anchor))
            text = text[:j] + new + text[j + len(old):]
        elif edit[0] == "pg_command_string":
            text = _pg_command_string(text)
        else:
            raise AssertionError(f"unknown edit {edit[0]!r}")
    compose.write_text(text)
    for rel, content in (case.get("files") or {}).items():
        target = tree / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    if "hba" in case:
        hba = tree / "docker" / "postgres" / "pg_hba.conf"
        old, new = case["hba"]
        assert old in hba.read_text(), (case["id"], old)
        hba.write_text(hba.read_text().replace(old, new))
    return compose


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
        for case in load_attacks():
            covered |= set(case["expect"])
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


# The pre-fix patterns, kept as the reference the linear scanners must agree with.
REFERENCE_VAR_REF = re.compile(r"\$\{([A-Za-z0-9_]+)((?:[^A-Za-z0-9_}][^}]*)?)\}")
REFERENCE_REQUIRED_REF = re.compile(r"\$\{([A-Za-z0-9_]+):?\?[^}]*\}")


class ReferenceScanning(unittest.TestCase):
    """${VAR...} references in compose text are found in linear time (re-audit R2-D5: the old
    regexes were quadratic, 8.8 s for VAR_REF on 64 KB of "${a?"), with exactly the matches of
    the old patterns. A linear scan of these 80-100 KB inputs takes milliseconds; the old
    REQUIRED_REF, the cheaper of the two quadratic patterns, needed 0.77 s for the first one."""

    BUDGET_SECONDS = 0.25

    def test_crafted_references_scan_within_budget(self):
        for crafted in ('"${a?" * 20000', '"${a?" * 20000 + "}"', '"${a:-" * 20000', '"${" + "a" * 50000'):
            for call in ("p.VAR_REF.findall", "p._mask_refs", "p.REQUIRED_REF.findall"):
                with self.subTest(call=call, input=crafted):
                    _value, seconds = _timed(f"len({call}({crafted}))")
                    self.assertLess(seconds, self.BUDGET_SECONDS)

    def test_same_matches_as_the_reference_patterns(self):
        rng = random.Random(30)
        alphabet = ["$", "{", "}", "a", "B", "_", "1", ":", "?", "-", " ", "${", "é", "/", "@"]
        for _ in range(20000):
            s = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 24)))
            self.assertEqual(policy.VAR_REF.findall(s), REFERENCE_VAR_REF.findall(s), s)
            self.assertEqual(policy.REQUIRED_REF.findall(s), REFERENCE_REQUIRED_REF.findall(s), s)
            self.assertEqual(policy._mask_refs(s), REFERENCE_VAR_REF.sub("VAR", s), s)


class ShippedStoreSettings(unittest.TestCase):
    """The policy's allowlists are exactly what the shipped store configuration uses."""

    def test_hba_client_group_is_the_one_the_shipped_files_use(self):
        users = set()
        for raw in (SHIPPED.parent / "docker" / "postgres" / "pg_hba.conf").read_text().splitlines():
            fields = raw.split("#", 1)[0].split()
            if fields and fields[0].startswith("host") and fields[-1] != "reject":
                users.add(fields[2])
        self.assertEqual(users, {policy.HBA_CLIENT_GROUP})
        roles = (SHIPPED.parent / "docker" / "postgres" / "provision-roles.sh").read_text()
        self.assertIn(f"CREATE ROLE {policy.HBA_CLIENT_GROUP.lstrip('+')} NOLOGIN", roles)

    def test_pg_option_allowlist_is_exactly_the_shipped_options(self):
        cmd = yaml.safe_load(SHIPPED.read_text())["services"]["postgres"]["command"]
        keys = {cmd[i + 1].split("=", 1)[0] for i, arg in enumerate(cmd) if arg == "-c"}
        self.assertEqual(keys, set(policy.PG_ALLOWED))


class ShippedComposeAttacks(unittest.TestCase):
    """Re-audit round 2: the auditor's own attack mutations of the shipped tree (A01-A32) and
    siblings of them (S01-S27), each applied alone to a copy of corpus_service/, trip exactly the
    rules declared in fixtures/shipped_attacks.py (A07 is a control that must pass). Each is
    checked from inside the copied corpus_service/, the way the README runs the policy."""

    def test_each_attack_trips_exactly_its_declared_rules(self):
        cases = load_attacks()
        self.assertGreaterEqual(len(cases), 50)
        for case in cases:
            with self.subTest(attack=case["id"]):
                with tempfile.TemporaryDirectory() as root:
                    compose = apply_attack(case, root)
                    with contextlib.chdir(compose.parent):
                        fired = {rule for rule, _s, _m in policy.check(str(compose))}
                self.assertEqual(sorted(fired), sorted(case["expect"]), f"{case['id']}: {case['title']}")


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

    def test_readme_tls_override_example_passes(self):
        """The README's own operator example (TLS volumes bound to host directories) stays valid."""
        readme = (SHIPPED.parent / "README.md").read_text()
        m = re.search(r"Example `docker-compose\.override\.yml`.*?```yaml\n(.*?)```", readme, re.S)
        self.assertIsNotNone(m, "README override example not found")
        with tempfile.TemporaryDirectory() as root:
            compose = apply_attack({"id": "readme", "edits": []}, root)
            (compose.parent / "docker-compose.override.yml").write_text(textwrap.dedent(m.group(1)))
            self.assertEqual(policy.check(str(compose)), [])

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
